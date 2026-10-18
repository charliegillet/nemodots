"""Offline tests for ratchet.llm (owner: I1). A fake client_factory stands in for openai.OpenAI."""
from __future__ import annotations

import json
import threading
import time

import httpx
import openai
import pytest
from openai.types.chat import ChatCompletion

from ratchet import llm as llm_mod
from ratchet.llm import (CrusoeClient, EmptyContentError, RateLimitedError, UsageLedger, compute_cost,
                         parse_model_prices, price_for)
from ratchet.types import LLM, Usage

WORKER = "nvidia/Nemotron-3.5-Lightning-30B-A3B"
REVIEWER = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"


def completion(content="OK", *, finish="stop", tool_calls=None, prompt=10, completion_tokens=2, cached=None,
               details=True, reasoning=None, model=WORKER) -> ChatCompletion:
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    if reasoning is not None:
        msg["reasoning"] = reasoning
    usage = {"prompt_tokens": prompt, "completion_tokens": completion_tokens,
             "total_tokens": prompt + completion_tokens}
    if details:
        usage["prompt_tokens_details"] = None if cached is None else {"cached_tokens": cached}
    return ChatCompletion.model_validate({
        "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": model,
        "choices": [{"index": 0, "finish_reason": finish, "message": msg}],
        "usage": usage,
    })


def status_error(code: int, headers: dict | None = None) -> Exception:
    req = httpx.Request("POST", "http://127.0.0.1:9/v1/chat/completions")
    resp = httpx.Response(code, request=req, headers=headers or {}, json={"error": "x"})
    cls = {429: openai.RateLimitError, 400: openai.BadRequestError}.get(code, openai.InternalServerError)
    return cls(f"status {code}", response=resp, body=None)


class FakeCompletions:
    def __init__(self, script):
        self.script = list(script)
        self.calls: list[dict] = []
        self.lock = threading.Lock()

    def create(self, **kwargs):
        with self.lock:
            self.calls.append(kwargs)
            item = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if callable(item) and not isinstance(item, ChatCompletion):
            item = item(kwargs)
        if isinstance(item, BaseException):
            raise item
        return item


class FakeOpenAI:
    def __init__(self, script):
        self.completions = FakeCompletions(script)
        self.chat = type("Chat", (), {"completions": self.completions})()


@pytest.fixture(autouse=True)
def _fresh_throttles():
    llm_mod.reset_throttles()
    yield
    llm_mod.reset_throttles()


@pytest.fixture
def fast_settings(settings):
    settings.rpm_per_model = 0          # no pacing in unit tests
    settings.max_retries = 3
    return settings


def make_client(settings, script, ledger=None):
    fake = FakeOpenAI(script)
    client = CrusoeClient(settings, ledger=ledger, client_factory=lambda: fake)
    client._sleep = lambda s: None
    client._uniform = lambda a, b: 1.0
    return client, fake.completions


def test_is_llm_protocol(fast_settings):
    client, _ = make_client(fast_settings, [completion()])
    assert isinstance(client, LLM)
    assert "test-key-not-real" not in repr(client)


def test_thinking_off_by_default_with_force_nonempty(fast_settings):
    client, calls = make_client(fast_settings, [completion("OK")])
    res = client.chat(model=WORKER, messages=[{"role": "user", "content": "hi"}], tag="t")
    kw = calls.calls[0]
    assert kw["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False, "force_nonempty_content": True}}
    assert "tool_choice" not in kw and "tools" not in kw and "seed" not in kw and "response_format" not in kw
    assert res.content == "OK" and res.finish_reason == "stop" and res.attempts == 1
    assert res.message == {"role": "assistant", "content": "OK"}


def test_thinking_on_and_optional_params(fast_settings):
    client, calls = make_client(fast_settings, [completion("x", reasoning="I think", model=REVIEWER)])
    tools = [{"type": "function", "function": {"name": "f", "parameters": {"type": "object", "properties": {}}}}]
    res = client.chat(model=REVIEWER, messages=[{"role": "user", "content": "hi"}], tools=tools, thinking=True,
                      seed=7, response_format={"type": "json_object"}, max_tokens=99, temperature=0.4)
    kw = calls.calls[0]
    assert kw["extra_body"] == {"chat_template_kwargs": {"enable_thinking": True}}
    assert kw["tools"] == tools and kw["seed"] == 7 and kw["response_format"] == {"type": "json_object"}
    assert kw["max_tokens"] == 99 and kw["temperature"] == 0.4 and "tool_choice" not in kw
    assert res.reasoning == "I think"
    assert "reasoning" not in res.message


def test_empty_tools_list_not_sent(fast_settings):
    client, calls = make_client(fast_settings, [completion()])
    client.chat(model=WORKER, messages=[], tools=[])
    assert "tools" not in calls.calls[0]


def test_tool_calls_parsed_and_malformed_kept(fast_settings):
    tcs = [
        {"id": "call_1", "type": "function", "function": {"name": "write_file", "arguments": '{"path": "a.py", "content": "x"}'}},
        {"id": "call_2", "type": "function", "function": {"name": "run_tests", "arguments": '{"path": '}},
    ]
    client, _ = make_client(fast_settings, [completion("\n\n", finish="tool_calls", tool_calls=tcs)])
    res = client.chat(model=WORKER, messages=[])
    assert [t.name for t in res.tool_calls] == ["write_file", "run_tests"]
    assert res.tool_calls[0].arguments == {"path": "a.py", "content": "x"}
    assert res.tool_calls[1].arguments == {} and res.tool_calls[1].raw_arguments == '{"path": '
    assert res.message["tool_calls"][1] == {"id": "call_2", "type": "function",
                                             "function": {"name": "run_tests", "arguments": '{"path": '}}
    assert res.finish_reason == "tool_calls"


def test_429_then_success_retries(fast_settings):
    slept = []
    client, calls = make_client(fast_settings, [status_error(429), completion("OK")])
    client._sleep = slept.append
    res = client.chat(model=WORKER, messages=[])
    assert res.attempts == 2 and len(calls.calls) == 2 and res.content == "OK"
    assert slept == [fast_settings.backoff_base_s * 1.0]


def test_retry_after_honoured(fast_settings):
    slept = []
    client, _ = make_client(fast_settings, [status_error(503, {"Retry-After": "7"}), completion()])
    client._sleep = slept.append
    client.chat(model=WORKER, messages=[])
    assert slept == [7.0]


def test_backoff_grows_and_caps(fast_settings):
    fast_settings.backoff_base_s, fast_settings.backoff_cap_s = 1.0, 5.0
    client, _ = make_client(fast_settings, [completion()])
    assert [client.backoff_delay(a) for a in range(5)] == [1.0, 2.0, 4.0, 5.0, 5.0]


def test_retries_exhausted_raise(fast_settings):
    fast_settings.max_retries = 2
    client, calls = make_client(fast_settings, [status_error(429)])
    with pytest.raises(RateLimitedError) as ei:
        client.chat(model=WORKER, messages=[])
    assert len(calls.calls) == 3 and ei.value.attempts == 3 and ei.value.last_status == 429
    assert WORKER in str(ei.value)


def test_connection_error_retried(fast_settings):
    req = httpx.Request("POST", "http://127.0.0.1:9/v1/chat/completions")
    client, calls = make_client(fast_settings, [openai.APIConnectionError(request=req), completion()])
    assert client.chat(model=WORKER, messages=[]).attempts == 2


def test_non_retryable_raises_immediately(fast_settings):
    client, calls = make_client(fast_settings, [status_error(400)])
    with pytest.raises(openai.BadRequestError):
        client.chat(model=WORKER, messages=[])
    assert len(calls.calls) == 1


def test_empty_length_retries_with_double_tokens(fast_settings):
    ledger = UsageLedger()
    client, calls = make_client(fast_settings, [completion(None, finish="length", completion_tokens=100),
                                                completion("done")], ledger=ledger)
    res = client.chat(model=WORKER, messages=[], max_tokens=100)
    assert [c["max_tokens"] for c in calls.calls] == [100, 200]
    assert res.content == "done" and res.attempts == 2
    assert res.usage.requests == 2 and res.usage.completion_tokens == 102
    assert len(ledger.entries()) == 2


def test_empty_length_cap_at_16384(fast_settings):
    client, calls = make_client(fast_settings, [completion(None, finish="length"), completion("x")])
    client.chat(model=WORKER, messages=[], max_tokens=12000)
    assert calls.calls[1]["max_tokens"] == 16384


def test_empty_after_retry_raises(fast_settings):
    client, calls = make_client(fast_settings, [completion(None, finish="length")])
    with pytest.raises(EmptyContentError):
        client.chat(model=WORKER, messages=[], max_tokens=50)
    assert len(calls.calls) == 2


def test_empty_length_with_thinking_not_retried(fast_settings):
    client, calls = make_client(fast_settings, [completion(None, finish="length", reasoning="hmm")])
    res = client.chat(model=REVIEWER, messages=[], thinking=True)
    assert len(calls.calls) == 1 and res.content == "" and res.reasoning == "hmm"


def test_cached_tokens_present(fast_settings):
    client, _ = make_client(fast_settings, [completion(prompt=2330, completion_tokens=10, cached=2304, model=REVIEWER)])
    res = client.chat(model=REVIEWER, messages=[])
    assert res.cached_reported is True and res.usage.cached_tokens == 2304 and res.usage.cached_reported
    assert res.usage.cost_usd == pytest.approx(compute_cost(REVIEWER, 2330, 10, 2304))


@pytest.mark.parametrize("details", [True, False])
def test_cached_tokens_absent(fast_settings, details):
    client, _ = make_client(fast_settings, [completion(details=details)])
    res = client.chat(model=WORKER, messages=[])
    assert res.cached_reported is False and res.usage.cached_tokens == 0


def test_compute_cost_arithmetic():
    # Super: 0.30 in / 2.40 out / 0.15 cached per 1M
    cost = compute_cost(REVIEWER, 1_000_000, 1_000_000, 400_000)
    assert cost == pytest.approx(0.6 * 0.30 + 0.4 * 0.15 + 2.40)
    assert compute_cost(WORKER, 1000, 100, 0) == pytest.approx(1000 * 0.05 / 1e6 + 100 * 0.20 / 1e6)
    assert compute_cost(WORKER, 10, 0, 50) == pytest.approx(10 * 0.03 / 1e6)  # cached clamped to prompt
    assert compute_cost("unknown/model", 1000, 1000, 0) == 0.0
    assert price_for(WORKER, {WORKER: (1.0, 2.0, 0.5)}) == (1.0, 2.0, 0.5)


def test_parse_model_prices():
    models = [
        {"id": WORKER, "pricing": {"prompt": "0.05", "completion": "0.2", "input_cache_reads": "0.03"}},
        {"id": "per-token/model", "pricing": {"prompt": "0.00000005", "completion": "0.0000002"}},
        {"id": "no-pricing"},
        {"id": "bad", "pricing": {"prompt": "x", "completion": "1"}},
    ]
    out = parse_model_prices(models)
    assert out[WORKER] == (0.05, 0.2, 0.03)
    assert out["per-token/model"] == pytest.approx((0.05, 0.2, 0.05))
    assert "no-pricing" not in out and "bad" not in out


def test_refresh_prices_keeps_table_on_failure(fast_settings, monkeypatch):
    client, _ = make_client(fast_settings, [completion()])
    monkeypatch.setattr(client, "list_models", lambda: (_ for _ in ()).throw(httpx.ConnectError("no")))
    prices = client.refresh_prices()
    assert prices[WORKER] == (0.05, 0.20, 0.03)


def test_refresh_prices_merges_live(fast_settings, monkeypatch):
    client, _ = make_client(fast_settings, [completion()])
    monkeypatch.setattr(client, "list_models",
                        lambda: [{"id": WORKER, "pricing": {"prompt": "0.06", "completion": "0.25",
                                                             "input_cache_reads": "0.04"}}])
    client.refresh_prices()
    assert client.prices[WORKER] == (0.06, 0.25, 0.04)
    assert REVIEWER in client.prices


def test_ledger_totals_by_model_by_tag(fast_settings):
    ledger = UsageLedger()
    client, _ = make_client(fast_settings, [completion(prompt=100, completion_tokens=10)], ledger=ledger)
    client.chat(model=WORKER, messages=[], tag="v1:holdout:t11:r0")
    client.chat(model=WORKER, messages=[], tag="v1:train:t01:r0")
    client.chat(model=REVIEWER, messages=[], tag="v2:review")
    assert ledger.total().requests == 3
    assert ledger.total("v1:").prompt_tokens == 200
    assert ledger.total("v1:holdout:").requests == 1
    assert set(ledger.by_model()) == {WORKER, REVIEWER}
    assert ledger.by_model("v2:")[REVIEWER].requests == 1
    assert set(ledger.by_tag("v1:")) == {"v1:holdout:t11:r0", "v1:train:t01:r0"}
    ledger.reset()
    assert ledger.total() == Usage()


def test_ledger_jsonl_has_no_messages(fast_settings, tmp_path):
    path = tmp_path / "runs" / "llm_calls.jsonl"
    ledger = UsageLedger(path)
    client, _ = make_client(fast_settings, [completion(cached=5, prompt=20)], ledger=ledger)
    client.chat(model=WORKER, messages=[{"role": "user", "content": "SECRET-PROMPT"}], tag="ping")
    lines = path.read_text().splitlines()
    assert len(lines) == 1
    d = json.loads(lines[0])
    assert set(d) == {"ts", "tag", "model", "prompt_tokens", "completion_tokens", "cached_tokens",
                      "cached_reported", "cost_usd", "latency_ms", "finish_reason", "attempts", "thinking"}
    assert "messages" not in d and "SECRET-PROMPT" not in lines[0] and "test-key-not-real" not in lines[0]
    assert d["tag"] == "ping" and d["cached_tokens"] == 5 and d["cached_reported"] is True
    back = UsageLedger.from_jsonl(path, prefix="ping")
    assert back.total().prompt_tokens == 20 and back.total().requests == 1


def test_semaphore_caps_concurrency(fast_settings):
    fast_settings.max_inflight_per_model = 2
    state = {"now": 0, "max": 0}
    lock = threading.Lock()

    def slow(kwargs):
        with lock:
            state["now"] += 1
            state["max"] = max(state["max"], state["now"])
        time.sleep(0.05)
        with lock:
            state["now"] -= 1
        return completion()

    client, _ = make_client(fast_settings, [slow])
    threads = [threading.Thread(target=client.chat, kwargs={"model": WORKER, "messages": []}) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert state["max"] == 2


def test_pacer_spaces_request_starts(fast_settings):
    fast_settings.rpm_per_model = 1200   # 0.05 s between starts
    starts = []
    client, _ = make_client(fast_settings, [lambda kw: (starts.append(time.monotonic()), completion())[1]])
    client._sleep = time.sleep
    t_before = time.monotonic()
    for _ in range(4):
        client.chat(model=WORKER, messages=[])
    # The 4th start is reserved 3 intervals after the 1st reservation, which is >= t_before.
    assert starts[-1] - t_before >= 3 * 0.05 - 1e-3


def test_throttles_are_per_model(fast_settings):
    client, _ = make_client(fast_settings, [completion()])
    assert client._throttle(WORKER) is client._throttle(WORKER)
    assert client._throttle(WORKER) is not client._throttle(REVIEWER)


# --------------------------------------------------------------------------- text-format tool calls (orchestrator)

TEXT_CALL = ("All good.\n\n<function=write_file>\n<parameter=path>\nsolution.py\n</parameter>\n"
             "<parameter=content>\ndef f():\n    return 1\n</parameter>\n</function>\n</tool_call>\n")


def test_parse_text_tool_calls_recovers_complete_blocks_only():
    from ratchet.llm import parse_text_tool_calls
    from ratchet.tools import TOOL_SCHEMAS

    text, calls = parse_text_tool_calls(TEXT_CALL, TOOL_SCHEMAS)
    assert text == "All good."
    assert calls == [("write_file", {"path": "solution.py", "content": "def f():\n    return 1"})]
    # integer parameters are JSON-decoded; unknown tools and unterminated blocks are ignored
    _, calls = parse_text_tool_calls("<function=web_search><parameter=query>x</parameter>"
                                     "<parameter=count>3</parameter></function>", TOOL_SCHEMAS)
    assert calls == [("web_search", {"query": "x", "count": 3})]
    assert parse_text_tool_calls("<function=rm_rf><parameter=p>/</parameter></function>", TOOL_SCHEMAS)[1] == []
    cut = "<function=write_file>\n<parameter=path>\nsolution.py\n</parameter>\n<parameter=content>\nx = ("
    assert parse_text_tool_calls(cut, TOOL_SCHEMAS) == (cut, [])
    assert parse_text_tool_calls(TEXT_CALL, None) == (TEXT_CALL, [])


def test_chat_turns_text_tool_calls_into_structured_calls(fast_settings):
    from ratchet.tools import TOOL_SCHEMAS

    client, _ = make_client(fast_settings, [completion(TEXT_CALL, finish="stop")])
    res = client.chat(model=WORKER, messages=[{"role": "user", "content": "x"}], tools=TOOL_SCHEMAS)
    assert [(c.name, c.arguments["path"]) for c in res.tool_calls] == [("write_file", "solution.py")]
    assert res.finish_reason == "tool_calls" and res.content == "All good."
    assert res.message["tool_calls"][0]["function"]["name"] == "write_file"
    assert json.loads(res.message["tool_calls"][0]["function"]["arguments"])["content"].startswith("def f()")
    # without tools the text is left alone
    client, _ = make_client(fast_settings, [completion(TEXT_CALL, finish="stop")])
    res = client.chat(model=WORKER, messages=[{"role": "user", "content": "x"}])
    assert res.tool_calls == [] and "<function=write_file>" in res.content


def test_stop_request_blocks_new_calls(fast_settings):
    from ratchet import interrupt

    client, calls = make_client(fast_settings, [completion("OK")])
    interrupt.request_stop()
    with pytest.raises(interrupt.RunInterrupted):
        client.chat(model=WORKER, messages=[{"role": "user", "content": "hi"}], tag="t")
    assert calls.calls == []


def test_interruptible_sleep_wakes_on_stop():
    import threading
    import time

    from ratchet import interrupt

    threading.Timer(0.1, interrupt.request_stop).start()
    t0 = time.monotonic()
    with pytest.raises(interrupt.RunInterrupted):
        interrupt.sleep(5)
    assert time.monotonic() - t0 < 2
