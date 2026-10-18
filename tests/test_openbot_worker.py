"""Offline tests for ratchet/workers/openbot_worker.py (owner I4). No network: the AG-UI endpoint and the
proxy's usage endpoint are a scripted fake `http` object; tools run in the subprocess sandbox."""
from __future__ import annotations

import json
import socket

import pytest

from ratchet.types import Task, ToolCall, Usage
from ratchet.workers import openbot_worker as ow
from ratchet.workers.openbot_worker import (
    BLOCKER,
    OpenBotWorker,
    agui_tools,
    parse_agui_events,
    to_agui_messages,
)


@pytest.fixture(autouse=True)
def _hermetic_openbot_env(monkeypatch, tmp_path):
    """Never read the real integrations/openbot/.env.openbot; start from a known environment."""
    monkeypatch.setattr(ow, "OPENBOT_ENV_FILE", tmp_path / "no.env.openbot")
    for name in ("MANAGED_AGENT_TOKEN", "OPENBOT_AGENT_URL", "OPENBOT_PROXY_URL", "OPENBOT_SERVER_URL",
                 "OPENBOT_BOT_ID"):
        monkeypatch.delenv(name, raising=False)
    # "" rather than delenv: Settings.from_env() -> load_dotenv() would refill deleted names from the real .env
    for name in (*ow.INTELLIGENCE_VARS, *ow.INTELLIGENCE_KEY_ALIASES):
        monkeypatch.setenv(name, "")


# --------------------------------------------------------------------------- SSE fixtures


def sse(*events: dict) -> str:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events)


def run_started(run="r"):
    return {"type": "RUN_STARTED", "threadId": "t", "runId": run}


def run_finished(run="r"):
    return {"type": "RUN_FINISHED", "threadId": "t", "runId": run}


def text_events(text: str, mid="m1"):
    return [{"type": "TEXT_MESSAGE_START", "messageId": mid, "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": mid, "delta": text},
            {"type": "TEXT_MESSAGE_END", "messageId": mid}]


def tool_events(call_id: str, name: str, *arg_chunks: str):
    return [{"type": "TOOL_CALL_START", "toolCallId": call_id, "toolCallName": name, "parentMessageId": "m1"},
            *[{"type": "TOOL_CALL_ARGS", "toolCallId": call_id, "delta": c} for c in arg_chunks],
            {"type": "TOOL_CALL_END", "toolCallId": call_id}]


def tool_turn(call_id, name, args: dict) -> str:
    raw = json.dumps(args)
    half = len(raw) // 2
    return sse(run_started(), *text_events("\n"), *tool_events(call_id, name, raw[:half], raw[half:]), run_finished())


# --------------------------------------------------------------------------- pure helpers


def test_to_agui_messages_maps_every_role():
    msgs = [
        {"role": "system", "content": "playbook"},
        {"role": "user", "content": "task"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": '{"path":"a"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "wrote a (1 bytes)"},
        {"role": "assistant", "content": "done"},
    ]
    out = to_agui_messages(msgs)
    assert out[0] == {"id": "msg-0", "role": "system", "content": "playbook"}
    assert out[1] == {"id": "msg-1", "role": "user", "content": "task"}
    assert out[2] == {"id": "msg-2", "role": "assistant", "toolCalls": [
        {"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": '{"path":"a"}'}}]}
    assert out[3] == {"id": "msg-3", "role": "tool", "content": "wrote a (1 bytes)", "toolCallId": "c1"}
    assert out[4] == {"id": "msg-4", "role": "assistant", "content": "done"}
    # dict arguments are serialized
    out2 = to_agui_messages([{"role": "assistant", "tool_calls": [{"id": "x", "function": {"name": "n", "arguments": {"a": 1}}}]}])
    assert out2[0]["toolCalls"][0]["function"]["arguments"] == '{"a": 1}'
    with pytest.raises(ValueError):
        to_agui_messages([{"role": "function", "content": "?"}])


def test_parse_agui_events_text_only():
    content, calls, err = parse_agui_events(sse(run_started(), *text_events("Hello "),
                                                {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "world"},
                                                run_finished()))
    assert (content, calls, err) == ("Hello world", [], None)


def test_parse_agui_events_tool_call_with_chunked_args():
    text = sse(run_started(), *text_events("\n\n"),
               *tool_events("call_9", "write_file", '{"path": "solu', 'tion.py", "content": "x = 1\\n"}'),
               *tool_events("call_10", "submit", ""),
               run_finished())
    content, calls, err = parse_agui_events(text)
    assert err is None and content == ""
    assert [c.name for c in calls] == ["write_file", "submit"]
    assert calls[0] == ToolCall(id="call_9", name="write_file", arguments={"path": "solution.py", "content": "x = 1\n"},
                                raw_arguments='{"path": "solution.py", "content": "x = 1\\n"}')
    assert calls[1].arguments == {} and calls[1].raw_arguments == "{}"


def test_parse_agui_events_run_error_and_truncated_stream():
    _, _, err = parse_agui_events(sse(run_started(), {"type": "RUN_ERROR", "message": "429 Too Many Requests"}))
    assert err == "429 Too Many Requests"
    _, _, err2 = parse_agui_events(sse(run_started(), *text_events("partial")))
    assert err2 and "RUN_FINISHED" in err2
    # CRLF framing, comments and garbage lines are tolerated; malformed tool args -> {} with raw kept
    text = (": keepalive\r\n\r\ndata: not-json\r\n\r\n" + sse(*tool_events("c", "read_file", "{oops"), run_finished()))
    _, calls, err3 = parse_agui_events(text)
    assert err3 is None and calls[0].arguments == {} and calls[0].raw_arguments == "{oops"


def test_agui_tools_from_tool_schemas():
    from ratchet.tools import TOOL_SCHEMAS

    tools = agui_tools(TOOL_SCHEMAS)
    assert [t["name"] for t in tools] == ["write_file", "read_file", "run_python", "run_tests", "web_search", "submit"]
    assert all(set(t) == {"name", "description", "parameters"} for t in tools)


# --------------------------------------------------------------------------- fake http


class FakeResponse:
    def __init__(self, status: int, text: str = "", payload=None):
        self.status_code = status
        self.text = text if payload is None else json.dumps(payload)
        self._payload = payload

    def json(self):
        if self._payload is None:
            return json.loads(self.text)
        return self._payload


class FakeHttp:
    """Scripted AG-UI turns; the proxy usage endpoint answers for every run id it has seen."""

    def __init__(self, turns, *, usage_per_turn=None, finish="tool_calls", health=None, refuse_conn=False):
        self.turns = list(turns)
        self.posts: list[dict] = []
        self.gets: list[str] = []
        self.run_ids: list[str] = []
        self.usage_per_turn = usage_per_turn or {"requests": 1, "prompt_tokens": 1000, "completion_tokens": 50,
                                                 "cached_tokens": 0, "cached_reported": False, "cost_usd": 0.00006}
        self.finish = finish
        self.health = health or {}
        self.refuse_conn = refuse_conn

    def post(self, url, json=None, headers=None, timeout=None, content=None):
        if self.refuse_conn:
            raise ConnectionError("refused")
        self.posts.append({"url": url, "json": json, "headers": dict(headers or {}), "content": content})
        if content is not None:   # availability token probe
            return FakeResponse(500, "bad json")
        self.run_ids.append(json["runId"])
        item = self.turns.pop(0) if len(self.turns) > 1 else self.turns[0]
        if isinstance(item, FakeResponse):
            return item
        return FakeResponse(200, item)

    def get(self, url, timeout=None, headers=None):
        if self.refuse_conn:
            raise ConnectionError("refused")
        self.gets.append(url)
        if "/usage/" in url:
            rid = url.rsplit("/", 1)[1]
            if rid in self.run_ids:
                finish = self.finish(rid) if callable(self.finish) else self.finish
                return FakeResponse(200, payload={"run_id": rid, "model": "nvidia/Nemotron-3.5-Lightning-30B-A3B",
                                                  "usage": self.usage_per_turn, "finish_reason": finish,
                                                  "latency_ms": 10, "attempts": 1, "calls": 1, "tag": "x"})
            return FakeResponse(404, payload={"error": "unknown run id"})
        for key, value in self.health.items():
            if url.endswith(key):
                return value
        raise ConnectionError("nothing listening")


class RecordingLedger:
    def __init__(self):
        self.rows = []

    def record(self, **kw):
        self.rows.append(kw)


TASK = Task(task_id="t99_toy", split="train", spec="# Toy\nWrite add(a, b).",
            starter_code="def add(a, b):\n    raise NotImplementedError\n",
            hidden_tests="from solution import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
            reference_solution="def add(a, b):\n    return a + b\n")
SOLUTION = "def add(a, b):\n    return a + b\n"


def make_worker(settings, http, **kw):
    kw.setdefault("token", "tok-123")
    return OpenBotWorker(settings, http=http, sleep=lambda s: None, **kw)


# --------------------------------------------------------------------------- run_task


def test_run_task_write_then_submit(settings, tmp_path):
    http = FakeHttp([tool_turn("call_1", "write_file", {"path": "solution.py", "content": SOLUTION}),
                     tool_turn("call_2", "submit", {"summary": "implemented add"})])
    ledger = RecordingLedger()
    worker = make_worker(settings, http, ledger=ledger)
    tr = worker.run_task(TASK, "# Playbook\nBe careful.", version=3, repeat=1, run_dir=tmp_path / "run", tag="v3:train:t99_toy:r1")

    assert tr.worker == "openbot" and tr.model == settings.worker_model
    assert tr.stop_reason == "done" and tr.error is None
    assert [s.tool for s in tr.steps] == ["write_file", "submit"] and len(tr.steps) == 2
    assert tr.workspace_files["solution.py"] == SOLUTION
    assert tr.final_answer == "implemented add"
    assert tr.usage.requests == 2 and tr.usage.prompt_tokens == 2000
    assert tr.usage_by_model["nvidia/Nemotron-3.5-Lightning-30B-A3B"].completion_tokens == 100
    assert tr.messages[0]["role"] == "system" and tr.messages[0]["content"].startswith("# Playbook")
    assert "Write add(a, b)." in tr.messages[1]["content"]
    assert tr.messages[3] == {"role": "tool", "tool_call_id": "call_1", "content": tr.steps[0].result}

    first, second = http.posts
    assert first["url"] == "http://127.0.0.1:4200/ag-ui"
    assert first["headers"]["x-openbot-agent-token"] == "tok-123"
    assert first["headers"]["X-Ratchet-Tag"] == "v3:train:t99_toy:r1"
    body = first["json"]
    assert body["threadId"] == "ratchet-v3-t99_toy-r1" and body["state"] == {} and body["forwardedProps"] == {}
    assert [t["name"] for t in body["tools"]][0] == "write_file"
    meta = json.loads(body["context"][0]["value"])
    assert body["context"][0]["description"] == ow.META_DESCRIPTION
    assert meta == {"tag": "v3:train:t99_toy:r1", "run": body["runId"], "seed": ow.seed_for("t99_toy", 1), "ledger": "caller",
                    "host_guidance": "strip"}
    # the second run carries the tool result paired with its call
    roles = [m["role"] for m in second["json"]["messages"]]
    assert roles == ["system", "user", "assistant", "tool"]
    assert second["json"]["messages"][3]["toolCallId"] == "call_1"
    # usage went to the caller's ledger with the run's tag
    assert [r["tag"] for r in ledger.rows] == ["v3:train:t99_toy:r1"] * 2
    assert isinstance(ledger.rows[0]["usage"], Usage)
    # the AG-UI audit trail was written
    rows = [json.loads(line) for line in (tmp_path / "run" / "openbot_events.jsonl").read_text().splitlines()]
    assert len(rows) == 2 and rows[0]["events"][0]["type"] == "RUN_STARTED"


def test_run_task_without_ledger_lets_the_proxy_record(settings, tmp_path):
    http = FakeHttp([tool_turn("c", "submit", {"summary": "s"})])
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="v0:holdout:t99_toy:r0")
    assert json.loads(http.posts[0]["json"]["context"][0]["value"])["ledger"] == "proxy"
    assert tr.stop_reason == "done" and tr.workspace_files["solution.py"] == TASK.starter_code


def test_run_task_retries_run_error_then_succeeds(settings, tmp_path):
    http = FakeHttp([sse(run_started(), {"type": "RUN_ERROR", "message": "Connection error."}),
                     FakeResponse(502, "bad gateway"),
                     tool_turn("c", "submit", {"summary": "ok"})])
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.stop_reason == "done" and len(http.posts) == 3
    assert tr.usage.requests == 3          # failed attempts that reached the model still count


def test_run_task_persistent_error_returns_transcript(settings, tmp_path):
    http = FakeHttp([sse(run_started(), {"type": "RUN_ERROR", "message": "model exploded"})])
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.stop_reason == "error" and "model exploded" in tr.error
    assert len(http.posts) == ow.TURN_RETRIES + 1
    assert tr.workspace_files["solution.py"] == TASK.starter_code


def test_run_task_empty_content_from_proxy_is_an_error_without_retry(settings, tmp_path):
    """Host parity: the proxy's double-empty cut-off answer (502, /usage error=empty_content) ends the run
    with stop_reason="error", like LocalWorker's EmptyContentError, instead of nudging the model."""

    class EmptyHttp(FakeHttp):
        def get(self, url, timeout=None, headers=None):
            r = super().get(url, timeout=timeout, headers=headers)
            if "/usage/" in url and r.status_code == 200:
                r = FakeResponse(200, payload={**r.json(), "finish_reason": "length", "status": 502,
                                               "error": "empty_content"})
            return r

    http = EmptyHttp([sse(run_started(), {"type": "RUN_ERROR", "message": "502 Bad Gateway"})])
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.stop_reason == "error" and "EmptyContentError" in tr.error
    assert len(http.posts) == 1  # not retried (usage of the failed turn is in the ledger, as with LocalWorker)


def test_run_task_unauthorized_is_not_retried(settings, tmp_path):
    http = FakeHttp([FakeResponse(401, '{"error":"Unauthorized."}')])
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.stop_reason == "error" and "MANAGED_AGENT_TOKEN" in tr.error and len(http.posts) == 1


def test_run_task_text_reply_ends_run_and_cut_off_is_nudged_once(settings, tmp_path):
    finishes = iter(["length", "stop"])
    http = FakeHttp([sse(run_started(), *text_events("I will"), run_finished()),
                     sse(run_started(), *text_events("All done."), run_finished())],
                    finish=lambda rid: next(finishes))
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.stop_reason == "done" and tr.final_answer == "All done."
    assert [m["role"] for m in tr.messages] == ["system", "user", "assistant", "user", "assistant"]
    assert tr.messages[3]["content"] == ow.CUT_OFF_NUDGE


def test_run_task_circuit_breaker_and_step_cap(settings, tmp_path):
    same = tool_turn("c", "read_file", {"path": "solution.py"})
    tr = make_worker(settings, FakeHttp([same])).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path / "a", tag="t")
    assert tr.stop_reason == "circuit_breaker" and len(tr.steps) == 3

    settings.worker_max_steps = 2
    varied = [tool_turn(f"c{i}", "run_python", {"code": f"print({i})"}) for i in range(5)]
    tr2 = make_worker(settings, FakeHttp(varied)).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path / "b", tag="t")
    assert tr2.stop_reason == "step_cap" and len(tr2.steps) == 2


def test_run_task_malformed_arguments_are_not_executed(settings, tmp_path):
    bad = sse(run_started(), *tool_events("c1", "write_file", '{"path": "solution.py", "content": '), run_finished())
    http = FakeHttp([bad, tool_turn("c2", "submit", {"summary": "s"})])
    tr = make_worker(settings, http).run_task(TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.steps[0].result.startswith("error: arguments for write_file were not valid JSON")
    assert tr.workspace_files["solution.py"] == TASK.starter_code


def test_run_task_wipes_a_previous_workspace(settings, tmp_path):
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace" / "stale.py").write_text("old")
    tr = make_worker(settings, FakeHttp([tool_turn("c", "submit", {"summary": "s"})])).run_task(
        TASK, "pb", version=0, repeat=0, run_dir=tmp_path, tag="t")
    assert "stale.py" not in tr.workspace_files


def test_stack_mode_publishes_playbook_and_uses_runtime_endpoint(settings, tmp_path):
    class StackHttp(FakeHttp):
        def post(self, url, json=None, headers=None, timeout=None, content=None):
            if url.endswith("/api/threads/mint"):
                self.posts.append({"url": url, "json": json, "headers": headers})
                return FakeResponse(200, payload={"threadId": "00000000-0000-8000-0000-000000000000"})
            if url.endswith("/api/plugins/skills"):
                self.posts.append({"url": url, "json": json, "headers": headers})
                return FakeResponse(200, payload={"skills": []})
            return super().post(url, json=json, headers=headers, timeout=timeout, content=content)

    http = StackHttp([tool_turn("c", "submit", {"summary": "s"})])
    worker = make_worker(settings, http, mode="stack")
    tr = worker.run_task(TASK, "# PB v4", version=4, repeat=0, run_dir=tmp_path, tag="t")
    assert tr.stop_reason == "done"
    urls = [p["url"] for p in http.posts]
    assert urls[0] == "http://127.0.0.1:3001/api/plugins/skills"
    assert http.posts[0]["json"]["slug"] == "ratchet-playbook" and http.posts[0]["json"]["instructions"] == "# PB v4"
    assert http.posts[0]["json"]["global"] is True
    assert urls[1].endswith("/api/threads/mint")
    assert urls[2] == "http://127.0.0.1:3001/api/copilotkit/agent/ratchet-coworker/run"
    assert http.posts[2]["json"]["threadId"] == "00000000-0000-8000-0000-000000000000"
    worker.run_task(TASK, "# PB v4", version=4, repeat=1, run_dir=tmp_path / "2", tag="t")
    assert [p["url"] for p in http.posts].count("http://127.0.0.1:3001/api/plugins/skills") == 1   # published once


def test_unknown_mode_rejected(settings):
    with pytest.raises(ValueError):
        OpenBotWorker(settings, mode="cloud", http=FakeHttp([""]))


# --------------------------------------------------------------------------- availability


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_availability_reports_closed_ports(settings, monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "tok")
    port = _closed_port()
    ok, reason = OpenBotWorker.availability(settings, proxy_url=f"http://127.0.0.1:{port}",
                                            agent_url=f"http://127.0.0.1:{_closed_port()}/ag-ui")
    assert ok is False
    assert f"127.0.0.1:{port}" in reason and "setup.sh" in reason


def test_availability_needs_token(settings):
    ok, reason = OpenBotWorker.availability(settings, http=FakeHttp([""]))
    assert ok is False and "MANAGED_AGENT_TOKEN" in reason and "setup.sh" in reason


def test_availability_stack_reports_blocker(settings, monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "tok")
    ok, reason = OpenBotWorker.availability(settings, mode="stack", http=FakeHttp([""]))
    assert ok is False and reason.startswith(BLOCKER)
    assert OpenBotWorker.availability(settings, mode="nope")[0] is False


def _healthy(model):
    return {
        ":8787/health": FakeResponse(200, payload={"status": "ok", "key_loaded": True}),
        ":4200/health": FakeResponse(200, payload={"status": "ok", "model": model}),
    }


def test_availability_ok_and_model_mismatch(settings, monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "tok")
    http = FakeHttp([""], health=_healthy(settings.worker_model))
    ok, reason = OpenBotWorker.availability(settings, http=http)
    assert ok is True and "agent-bot" in reason
    assert http.posts[0]["headers"]["x-openbot-agent-token"] == "tok"     # token probe, no model call
    ok2, reason2 = OpenBotWorker.availability(settings, http=FakeHttp([""], health=_healthy("gpt-5.5")))
    assert ok2 is False and "gpt-5.5" in reason2


def test_availability_detects_rejected_token(settings, monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "tok")

    class Rejecting(FakeHttp):
        def post(self, url, json=None, headers=None, timeout=None, content=None):
            return FakeResponse(401, '{"error":"Unauthorized."}')

    ok, reason = OpenBotWorker.availability(settings, http=Rejecting([""], health=_healthy(settings.worker_model)))
    assert ok is False and "rejected MANAGED_AGENT_TOKEN" in reason


def test_availability_without_crusoe_key(settings, monkeypatch):
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "tok")
    settings.crusoe_api_key = ""
    ok, reason = OpenBotWorker.availability(settings, http=FakeHttp([""]))
    assert ok is False and "CRUSOE_API_KEY" in reason


def test_reset_is_a_noop_in_agui_mode(settings):
    http = FakeHttp([""])
    make_worker(settings, http).reset()
    assert http.posts == []


def test_intelligence_urls_default_and_key_alias():
    from ratchet.workers.openbot_worker import intelligence_config, missing_intelligence

    assert missing_intelligence({}) == ["INTELLIGENCE_API_KEY"]          # URLs have OpenBot's public defaults
    cfg = intelligence_config({"CPK_INTELLIGENCE_API_KEY": "k"})
    assert cfg["INTELLIGENCE_API_KEY"] == "k"
    assert cfg["INTELLIGENCE_API_URL"] == "https://api.intelligence.copilotkit.ai"
    assert cfg["INTELLIGENCE_GATEWAY_WS_URL"] == "wss://realtime.intelligence.copilotkit.ai"
    assert missing_intelligence({"CPK_INTELLIGENCE_API_KEY": "k"}) == []
    assert intelligence_config({"INTELLIGENCE_API_KEY": "a", "CPK_INTELLIGENCE_API_KEY": "b",
                                "INTELLIGENCE_API_URL": "https://x"})["INTELLIGENCE_API_KEY"] == "a"
