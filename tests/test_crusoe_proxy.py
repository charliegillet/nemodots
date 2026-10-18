"""Offline tests for integrations/openbot/crusoe_proxy.py (owner I4).

Pure functions are tested directly. One test runs the proxy's HTTP server on an ephemeral loopback port
with a fake upstream client injected, so nothing leaves the machine and no real key is involved."""
from __future__ import annotations

import importlib.util
import json
import threading

import httpx
import pytest

from ratchet.config import ROOT
from ratchet.types import Usage

_PATH = ROOT / "integrations" / "openbot" / "crusoe_proxy.py"
_spec = importlib.util.spec_from_file_location("ratchet_crusoe_proxy", _PATH)
proxy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(proxy)


def _meta_msg(**meta) -> dict:
    return {"role": "system", "content": proxy.META_DESCRIPTION + "\n" + json.dumps(meta)}


# --------------------------------------------------------------------------- body rewriting


def test_rewrite_injects_thinking_off_and_raises_max_tokens():
    body = {"model": "m", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 20}
    out = proxy.rewrite_body(body)
    assert out["chat_template_kwargs"] == {"enable_thinking": False, "force_nonempty_content": True}
    assert out["max_tokens"] == 4096
    assert body["max_tokens"] == 20 and "chat_template_kwargs" not in body   # input not mutated


def test_rewrite_sets_max_tokens_when_absent_and_keeps_larger():
    assert proxy.rewrite_body({"messages": []})["max_tokens"] == 4096
    assert proxy.rewrite_body({"messages": [], "max_tokens": 9000})["max_tokens"] == 9000
    out = proxy.rewrite_body({"messages": [], "max_completion_tokens": 10})
    assert out["max_completion_tokens"] == 4096 and "max_tokens" not in out


def test_rewrite_preserves_existing_chat_template_kwargs():
    body = {"messages": [], "chat_template_kwargs": {"enable_thinking": True}}
    out = proxy.rewrite_body(body)
    assert out["chat_template_kwargs"] == {"enable_thinking": True}


def test_rewrite_thinking_on_has_no_force_nonempty():
    out = proxy.rewrite_body({"messages": []}, thinking=True)
    assert out["chat_template_kwargs"] == {"enable_thinking": True}


def test_rewrite_stream_usage_temperature_seed_and_tool_choice():
    body = {"messages": [], "stream": True, "stream_options": {"x": 1}, "tools": [{"type": "function"}],
            "tool_choice": "required"}
    out = proxy.rewrite_body(body, temperature=0.2, seed=42)
    assert out["stream_options"] == {"x": 1, "include_usage": True}
    assert out["temperature"] == 0.2 and out["seed"] == 42
    assert "tool_choice" not in out
    kept = proxy.rewrite_body({"messages": [], "temperature": 0.9, "seed": 1}, temperature=0.2, seed=42)
    assert kept["temperature"] == 0.9 and kept["seed"] == 1
    assert "tools" not in proxy.rewrite_body({"messages": [], "tools": [], "tool_choice": "auto"})


def test_extract_run_meta_strips_marker_and_ignores_garbage():
    msgs = [{"role": "system", "content": "guidance"},
            _meta_msg(tag="v1:holdout:t01:r0", run="r-1", seed=7),
            {"role": "system", "content": proxy.META_DESCRIPTION + "\nnot json"},
            {"role": "user", "content": proxy.META_DESCRIPTION + "\n{}"}]
    kept, meta = proxy.extract_run_meta(msgs)
    assert meta == {"tag": "v1:holdout:t01:r0", "run": "r-1", "seed": 7}
    assert kept == [{"role": "system", "content": "guidance"}, msgs[3]]   # user messages are never touched


def test_prepare_request_applies_settings_and_seed(settings):
    body = {"model": settings.worker_model, "stream": True,
            "messages": [_meta_msg(tag="t", run="r", seed=99), {"role": "user", "content": "x"}]}
    out, meta = proxy.prepare_request(body, settings)
    assert meta["tag"] == "t"
    assert out["seed"] == 99 and out["temperature"] == settings.worker_temperature
    assert all(proxy.META_DESCRIPTION not in str(m.get("content")) for m in out["messages"])
    assert out["stream_options"]["include_usage"] is True


def test_upstream_headers_are_built_from_scratch():
    h = proxy.upstream_headers("real-key", stream=True)
    assert h == {"Authorization": "Bearer real-key", "Content-Type": "application/json",
                 "Accept": "text/event-stream"}


# --------------------------------------------------------------------------- usage


def test_usage_from_payload_with_and_without_cache(settings):
    u = proxy.usage_from_payload({"prompt_tokens": 1000, "completion_tokens": 100,
                                  "prompt_tokens_details": {"cached_tokens": 400}}, settings.reviewer_model)
    assert (u.requests, u.prompt_tokens, u.completion_tokens, u.cached_tokens, u.cached_reported) == (1, 1000, 100, 400, True)
    assert u.cost_usd == pytest.approx(600 * 0.30 / 1e6 + 400 * 0.15 / 1e6 + 100 * 2.40 / 1e6)
    u2 = proxy.usage_from_payload({"prompt_tokens": 313, "completion_tokens": 36, "prompt_tokens_details": None},
                                  settings.worker_model)
    assert (u2.cached_tokens, u2.cached_reported) == (0, False)
    assert u2.cost_usd == pytest.approx(313 * 0.05 / 1e6 + 36 * 0.20 / 1e6)


SAMPLE_STREAM = [
    'data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant"}}]}', "",
    'data: {"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file"}}]}}]}', "",
    'data: {"id":"c","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a\\"}"}}]}}]}', "",
    'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}', "",
    'data: {"id":"c","choices":[],"usage":{"prompt_tokens":313,"total_tokens":349,"completion_tokens":36,"prompt_tokens_details":null}}', "",
    "data: [DONE]", "",
]


def test_stream_tracker_reads_usage_and_finish_reason():
    t = proxy.StreamTracker("m")
    for line in SAMPLE_STREAM:
        t.feed(line)
    assert t.done and t.finish_reason == "tool_calls" and t.tool_calls == 1
    assert t.usage["prompt_tokens"] == 313


def test_backoff_delay_policy():
    assert proxy.backoff_delay(0, base=1.0, cap=30.0, rand=lambda a, b: 1.0) == 1.0
    assert proxy.backoff_delay(3, base=1.0, cap=30.0, rand=lambda a, b: 1.0) == 8.0
    assert proxy.backoff_delay(10, base=1.0, cap=30.0, rand=lambda a, b: 1.5) == 45.0
    assert proxy.backoff_delay(0, base=1.0, cap=30.0, retry_after="7", rand=lambda a, b: 1.0) == 7.0
    assert proxy.backoff_delay(0, base=1.0, cap=30.0, retry_after="soon", rand=lambda a, b: 1.0) == 1.0


def test_usage_book_aggregates_and_is_bounded():
    book = proxy.UsageBook(capacity=2)
    book.add("r1", tag="t", model="m", usage=Usage(requests=1, prompt_tokens=10), finish_reason="tool_calls",
             latency_ms=5, attempts=1, status=200)
    book.add("r1", tag="t", model="m", usage=Usage(requests=1, prompt_tokens=5), finish_reason="stop",
             latency_ms=5, attempts=2, status=200)
    rec = book.get("r1")
    assert rec["calls"] == 2 and rec["usage"]["prompt_tokens"] == 15 and rec["attempts"] == 3
    assert rec["finish_reason"] == "stop"
    book.add("r2", tag="t", model="m", usage=Usage(), finish_reason="", latency_ms=0, attempts=1, status=200)
    book.add("r3", tag="t", model="m", usage=Usage(), finish_reason="", latency_ms=0, attempts=1, status=200)
    assert book.get("r1") is None and book.get("r3") is not None


def test_ledger_sink_writes_the_documented_line(tmp_path):
    path = tmp_path / "llm_calls.jsonl"
    sink = proxy.LedgerSink(path)
    sink.record(tag="v1:holdout:t01:r0", model="m", usage=Usage(requests=1, prompt_tokens=3, completion_tokens=2),
                latency_ms=12, finish_reason="stop", attempts=1, thinking=False)
    line = json.loads(path.read_text().splitlines()[0])
    assert set(line) == {"ts", "tag", "model", "prompt_tokens", "completion_tokens", "cached_tokens",
                         "cached_reported", "cost_usd", "latency_ms", "finish_reason", "attempts", "thinking"}
    assert line["tag"] == "v1:holdout:t01:r0" and "messages" not in line


# --------------------------------------------------------------------------- server, fake upstream


class _FakeUpstreamResponse:
    def __init__(self, status: int, lines: list[str] | None = None, body: bytes = b"", headers=None):
        self.status_code = status
        self._lines = lines or []
        self._body = body
        self.headers = headers or {}

    def iter_lines(self):
        yield from self._lines

    def read(self):
        return self._body

    def close(self):
        pass


class _FakeUpstream:
    """Stands in for httpx.Client: records requests, returns scripted responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def build_request(self, method, url, content=None, headers=None):
        return {"method": method, "url": url, "body": json.loads(content), "headers": dict(headers or {})}

    def send(self, req, stream=False):
        self.requests.append(req)
        return self.responses.pop(0)


@pytest.fixture
def running_proxy(settings, tmp_path):
    def start(responses, *, buffered=True):
        upstream = _FakeUpstream(responses)
        state = proxy.ProxyState(settings, client=upstream, ledger=proxy.LedgerSink(tmp_path / "llm_calls.jsonl"),
                                 sleep=lambda s: None, buffer_streams=buffered)
        state.pacer.spacing = 0.0
        server = proxy.make_server(settings, "127.0.0.1", 0, state=state)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        started.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}", upstream, state

    started: list = []
    yield start
    for s in started:
        s.shutdown()
        s.server_close()


def test_proxy_passthrough_stream_records_usage_and_never_forwards_inbound_auth(running_proxy, settings, tmp_path):
    url, upstream, state = running_proxy([
        _FakeUpstreamResponse(429, headers={"retry-after": "0"}),
        _FakeUpstreamResponse(200, lines=SAMPLE_STREAM),
    ], buffered=False)
    body = {"model": settings.worker_model, "stream": True, "tools": [],
            "messages": [{"role": "system", "content": "g"}, _meta_msg(tag="v2:holdout:t11:r1", run="run-xyz", seed=5, ledger="proxy"),
                         {"role": "user", "content": "go"}]}
    r = httpx.post(url + "/v1/chat/completions", json=body, headers={"Authorization": "Bearer inbound-secret"}, timeout=10)
    assert r.status_code == 200
    assert "data: [DONE]" in r.text and '"write_file"' in r.text
    assert len(upstream.requests) == 2                                  # 429 retried
    sent = upstream.requests[-1]
    assert sent["headers"]["Authorization"] == f"Bearer {settings.crusoe_api_key}"
    assert "inbound-secret" not in json.dumps(sent)
    assert sent["body"]["seed"] == 5 and sent["body"]["chat_template_kwargs"]["enable_thinking"] is False
    assert all(proxy.META_DESCRIPTION not in str(m["content"]) for m in sent["body"]["messages"])
    assert "tools" not in sent["body"]

    usage = httpx.get(url + "/usage/run-xyz", timeout=5).json()
    assert usage["usage"]["prompt_tokens"] == 313 and usage["finish_reason"] == "tool_calls"
    assert usage["tag"] == "v2:holdout:t11:r1" and usage["attempts"] == 2
    lines = (tmp_path / "llm_calls.jsonl").read_text().splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["tag"] == "v2:holdout:t11:r1"
    assert httpx.get(url + "/usage/nope", timeout=5).status_code == 404

    health = httpx.get(url + "/health", timeout=5).json()
    assert health["status"] == "ok" and health["key_loaded"] is True
    assert settings.crusoe_api_key not in json.dumps(health)


def test_proxy_skips_jsonl_when_caller_records_usage(running_proxy, settings, tmp_path):
    url, upstream, _ = running_proxy([_FakeUpstreamResponse(200, lines=SAMPLE_STREAM)], buffered=False)
    body = {"model": settings.worker_model, "stream": True,
            "messages": [_meta_msg(tag="t", run="run-c", seed=1, ledger="caller"), {"role": "user", "content": "go"}]}
    assert httpx.post(url + "/v1/chat/completions", json=body, timeout=10).status_code == 200
    assert httpx.get(url + "/usage/run-c", timeout=5).json()["usage"]["completion_tokens"] == 36
    assert not (tmp_path / "llm_calls.jsonl").exists()


def test_proxy_relays_non_stream_and_upstream_errors(running_proxy, settings):
    ok_body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "hi"}}],
                          "usage": {"prompt_tokens": 5, "completion_tokens": 1}}).encode()
    url, upstream, _ = running_proxy([
        _FakeUpstreamResponse(200, body=ok_body, headers={"content-type": "application/json"}),
        _FakeUpstreamResponse(400, body=b'{"error":"bad"}', headers={"content-type": "application/json"}),
    ])
    r = httpx.post(url + "/v1/chat/completions", json={"model": "m", "messages": [_meta_msg(run="nr")]}, timeout=10)
    assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "hi"
    assert httpx.get(url + "/usage/nr", timeout=5).json()["usage"]["prompt_tokens"] == 5
    r2 = httpx.post(url + "/v1/chat/completions", json={"model": "m", "messages": []}, timeout=10)
    assert r2.status_code == 400 and r2.json() == {"error": "bad"}
    assert httpx.post(url + "/v1/chat/completions", content=b"not json", timeout=10).status_code == 400


# --------------------------------------------------------------------------- buffered mode (default)


TOOL_COMPLETION = {
    "id": "chatcmpl-1", "created": 1, "model": "nvidia/Nemotron-3.5-Lightning-30B-A3B",
    "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": "\n",
        "tool_calls": [{"id": "call_a", "type": "function", "function": {"name": "write_file", "arguments": '{"path":"solution.py","content":"x"}'}},
                       {"id": "call_b", "type": "function", "function": {"name": "submit", "arguments": '{"summary":"s"}'}}]}}],
    "usage": {"prompt_tokens": 2000, "completion_tokens": 80, "prompt_tokens_details": None},
}


def _reassemble(lines: list[str]) -> tuple[str, list[dict], str, dict | None]:
    """What agent-bot does with the chunks: concatenate content, buffer tool calls by index."""
    content, calls, finish, usage = "", {}, "", None
    for line in lines:
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        ch = json.loads(line[6:])
        usage = ch.get("usage") or usage
        for c in ch["choices"]:
            d = c["delta"]
            content += d.get("content") or ""
            finish = c.get("finish_reason") or finish
            for tc in d.get("tool_calls") or []:
                cur = calls.setdefault(tc["index"], {"id": "", "name": "", "args": ""})
                cur["id"] = tc.get("id") or cur["id"]
                cur["name"] = tc["function"].get("name") or cur["name"]
                cur["args"] += tc["function"].get("arguments") or ""
    return content, [calls[i] for i in sorted(calls)], finish, usage


def test_synthesize_sse_lines_round_trips_through_agent_bot_reassembly():
    lines = proxy.synthesize_sse_lines(TOOL_COMPLETION)
    assert lines[-2:] == ["data: [DONE]", ""]
    content, calls, finish, usage = _reassemble(lines)
    assert content == "\n" and finish == "tool_calls" and usage["prompt_tokens"] == 2000
    assert calls == [{"id": "call_a", "name": "write_file", "args": '{"path":"solution.py","content":"x"}'},
                     {"id": "call_b", "name": "submit", "args": '{"summary":"s"}'}]
    text_only = {"choices": [{"finish_reason": "stop", "message": {"content": "hello"}}]}
    assert _reassemble(proxy.synthesize_sse_lines(text_only))[:3] == ("hello", [], "stop")
    t = proxy.StreamTracker("m")
    for line in lines:
        t.feed(line)
    assert t.done and t.tool_calls == 2


def test_completion_helpers():
    assert proxy.completion_finish_reason(TOOL_COMPLETION) == "tool_calls"
    assert not proxy.completion_is_empty(TOOL_COMPLETION)
    assert proxy.completion_is_empty({"choices": [{"finish_reason": "length", "message": {"content": None}}]})
    assert proxy.completion_finish_reason({}) == ""


def test_buffered_mode_replays_one_completion_as_sse(running_proxy, settings, tmp_path):
    url, upstream, _ = running_proxy([
        _FakeUpstreamResponse(503),
        _FakeUpstreamResponse(200, body=json.dumps(TOOL_COMPLETION).encode()),
    ])
    body = {"model": settings.worker_model, "stream": True,
            "messages": [_meta_msg(tag="v1:train:t01:r0", run="run-b", seed=3), {"role": "user", "content": "go"}]}
    r = httpx.post(url + "/v1/chat/completions", json=body, timeout=10)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    content, calls, finish, _ = _reassemble(r.text.split("\n"))
    assert [c["name"] for c in calls] == ["write_file", "submit"] and finish == "tool_calls"
    sent = upstream.requests[-1]["body"]
    assert sent["stream"] is False and "stream_options" not in sent and sent["seed"] == 3
    assert upstream.requests[-1]["headers"]["Accept"] == "application/json"
    rec = httpx.get(url + "/usage/run-b", timeout=5).json()
    assert rec["usage"]["prompt_tokens"] == 2000 and rec["finish_reason"] == "tool_calls" and rec["attempts"] == 2
    assert json.loads((tmp_path / "llm_calls.jsonl").read_text())["tag"] == "v1:train:t01:r0"


def test_buffered_mode_retries_an_empty_cut_off_answer_with_more_tokens(running_proxy, settings):
    empty = {"choices": [{"finish_reason": "length", "message": {"content": None}}],
             "usage": {"prompt_tokens": 100, "completion_tokens": 2048}}
    good = {"choices": [{"finish_reason": "stop", "message": {"content": "done"}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10}}
    url, upstream, _ = running_proxy([_FakeUpstreamResponse(200, body=json.dumps(empty).encode()),
                                      _FakeUpstreamResponse(200, body=json.dumps(good).encode())])
    r = httpx.post(url + "/v1/chat/completions", timeout=10, json={
        "model": "m", "stream": True, "messages": [_meta_msg(run="run-l"), {"role": "user", "content": "x"}]})
    assert _reassemble(r.text.split("\n"))[0] == "done"
    assert [q["body"]["max_tokens"] for q in upstream.requests] == [4096, 8192]
    rec = httpx.get(url + "/usage/run-l", timeout=5).json()
    assert rec["usage"]["completion_tokens"] == 2058 and rec["usage"]["requests"] == 2


def test_buffered_mode_double_empty_answer_is_a_502(running_proxy, settings):
    """Parity with CrusoeClient's EmptyContentError: still empty after the doubled budget -> HTTP 502
    empty_content (not an empty completion), with both calls' usage recorded and the error in /usage."""
    empty = {"choices": [{"finish_reason": "length", "message": {"content": None}}],
             "usage": {"prompt_tokens": 100, "completion_tokens": 2048}}
    url, upstream, _ = running_proxy([_FakeUpstreamResponse(200, body=json.dumps(empty).encode()),
                                      _FakeUpstreamResponse(200, body=json.dumps(empty).encode())])
    r = httpx.post(url + "/v1/chat/completions", timeout=10, json={
        "model": "m", "stream": True, "messages": [_meta_msg(run="run-e"), {"role": "user", "content": "x"}]})
    assert r.status_code == 502
    err = r.json()["error"]
    assert err["code"] == "empty_content" and "max_tokens=8192" in err["message"]
    assert [q["body"]["max_tokens"] for q in upstream.requests] == [4096, 8192]
    rec = httpx.get(url + "/usage/run-e", timeout=5).json()
    assert rec["error"] == "empty_content" and rec["status"] == 502 and rec["finish_reason"] == "length"
    assert rec["usage"]["completion_tokens"] == 4096 and rec["usage"]["requests"] == 2


def test_recover_text_tool_calls_in_buffered_completion():
    from ratchet.tools import TOOL_SCHEMAS

    obj = {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content":
           "ok\n<function=submit>\n<parameter=summary>\ndone\n</parameter>\n</function>"}}]}
    assert proxy.recover_text_tool_calls(obj, TOOL_SCHEMAS) == 1
    msg = obj["choices"][0]["message"]
    assert msg["content"] == "ok" and obj["choices"][0]["finish_reason"] == "tool_calls"
    assert msg["tool_calls"][0]["function"]["name"] == "submit"
    assert json.loads(msg["tool_calls"][0]["function"]["arguments"]) == {"summary": "done"}
    plain = {"choices": [{"finish_reason": "stop", "message": {"content": "hi"}}]}
    assert proxy.recover_text_tool_calls(plain, TOOL_SCHEMAS) == 0 and plain["choices"][0]["message"]["content"] == "hi"


def test_proxy_client_key_required_when_configured(running_proxy, settings):
    ok_body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "hi"}}],
                          "usage": {"prompt_tokens": 5, "completion_tokens": 1}}).encode()
    url, upstream, state = running_proxy([_FakeUpstreamResponse(200, body=ok_body, headers={"content-type": "application/json"})])
    state.client_key = "local-token"
    body = {"model": "m", "messages": [_meta_msg(run="auth")]}
    assert httpx.post(url + "/v1/chat/completions", json=body, timeout=10).status_code == 401
    assert httpx.post(url + "/v1/chat/completions", json=body, headers={"Authorization": "Bearer wrong"},
                      timeout=10).status_code == 401
    assert httpx.get(url + "/v1/models", timeout=5).status_code == 401
    assert upstream.requests == []                                     # nothing reached Crusoe
    r = httpx.post(url + "/v1/chat/completions", json=body, headers={"Authorization": "Bearer local-token"}, timeout=10)
    assert r.status_code == 200 and len(upstream.requests) == 1
    assert "local-token" not in json.dumps(upstream.requests[0])      # the client key is never forwarded
    health = httpx.get(url + "/health", timeout=5).json()               # health stays open, says auth is on
    assert health["client_auth"] is True and "local-token" not in json.dumps(health)


# --------------------------------------------------------------------------- host guidance / retry window


GUIDANCE = "You are a Bot with your own computer, a real web browser the person can watch you use.\nWhen ..."


def test_prepare_request_strips_host_guidance_only_when_asked(settings):
    msgs = [{"role": "system", "content": GUIDANCE}, None, {"role": "system", "content": "PLAYBOOK"},
            {"role": "user", "content": "task"}]
    msgs[1] = _meta_msg(tag="t", run="r", seed=1, ledger="caller", host_guidance="strip")
    out, meta = proxy.prepare_request({"model": "m", "messages": msgs}, settings)
    assert [m["content"] for m in out["messages"]] == ["PLAYBOOK", "task"]
    assert meta["host_guidance"] == "strip"
    msgs[1] = _meta_msg(tag="t", run="r", seed=1, ledger="caller")
    out, _ = proxy.prepare_request({"model": "m", "messages": msgs}, settings)
    assert out["messages"][0]["content"] == GUIDANCE              # an older caller keeps OpenBot's prompt


def test_host_guidance_prefix_matches_vendored_openbot():
    src = ROOT / "vendor" / "openbot" / "shared" / "bot-prompt.ts"
    if not src.exists():
        pytest.skip("vendor/openbot not checked out")
    assert proxy.HOST_GUIDANCE_PREFIX in src.read_text(encoding="utf-8")


def test_retry_window_fits_inside_the_worker_turn_timeout(settings, monkeypatch):
    monkeypatch.delenv("RATCHET_PROXY_RETRY_WINDOW_S", raising=False)
    window = proxy.retry_window_s(settings)
    turn_timeout = max(settings.request_timeout_s, 60.0) + 180.0
    assert window + settings.request_timeout_s < turn_timeout
    assert proxy.retry_window_s(settings, {"RATCHET_PROXY_RETRY_WINDOW_S": "12"}) == 12.0


def test_proxy_stops_retrying_when_the_window_is_spent(running_proxy, settings):
    settings.max_retries = 8
    url, upstream, state = running_proxy([_FakeUpstreamResponse(429, body=b'{"error":"slow down"}',
                                                                headers={"retry-after": "30"})] * 9)
    state.retry_window_s = 1.0               # a 30 s Retry-After never fits: relay the 429 at once
    r = httpx.post(url + "/v1/chat/completions", json={"model": "m", "messages": [_meta_msg(run="rw")]}, timeout=10)
    assert r.status_code == 429 and len(upstream.requests) == 1
    assert httpx.get(url + "/usage/rw", timeout=5).status_code == 404     # nothing was completed or billed
