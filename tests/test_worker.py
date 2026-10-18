"""Offline tests for ratchet.worker.LocalWorker (owner: I1) with ratchet.fakes.FakeLLM."""
from __future__ import annotations

import json

import pytest

from ratchet.fakes import FakeLLM, assistant, tool_call
from ratchet.llm import RateLimitedError
from ratchet.sandbox import Sandbox
from ratchet.tools import TOOL_SCHEMAS
from ratchet.types import Task, Transcript, Usage
from ratchet.worker import (WORKER_PROTOCOL, LocalWorker, build_system_prompt, build_task_message, seed_for)

PLAYBOOK = "# Coding worker playbook\n\nYou are a Python coding worker.\n"
SOLUTION = "def add(a, b):\n    return a + b\n"
TEST_FILE = "from solution import add\n\ndef test_add():\n    assert add(1, 2) == 3\n"


@pytest.fixture(autouse=True)
def _no_real_search_key(settings):
    settings.you_api_key = None


@pytest.fixture
def task() -> Task:
    return Task(task_id="t99_add", split="train", spec="# Add\n\nImplement `add(a, b)` returning the sum.",
                starter_code="def add(a, b):\n    raise NotImplementedError\n",
                hidden_tests=TEST_FILE, reference_solution=SOLUTION)


def run(worker, task, tmp_path, **kw):
    return worker.run_task(task, PLAYBOOK, version=kw.get("version", 0), repeat=kw.get("repeat", 0),
                           run_dir=tmp_path / "run", tag=kw.get("tag", "v0:train:t99_add:r0"))


def test_prompts(task):
    sp = build_system_prompt(PLAYBOOK + "\n\n\n")
    assert sp == PLAYBOOK.rstrip() + "\n\n" + WORKER_PROTOCOL
    for word in ("solution.py", "submit", "write_file", "run_tests", "web_search", "from solution import"):
        assert word in WORKER_PROTOCOL
    assert "t99" not in WORKER_PROTOCOL
    msg = build_task_message(task)
    assert msg.startswith("## Task\n# Add") and "## Starter file (solution.py)\n```python\ndef add" in msg


def test_seed_for_matches_plan():
    import zlib

    assert seed_for("t11_add_months", 1) == (zlib.crc32(b"t11_add_months") + 1) % 2**31


def test_happy_path(settings, task, tmp_path):
    llm = FakeLLM([
        tool_call("write_file", {"path": "solution.py", "content": SOLUTION}),
        tool_call("write_file", {"path": "test_mine.py", "content": TEST_FILE}),
        tool_call("run_tests", {}),
        tool_call("submit", {"summary": "ok"}),
    ], strict=True)
    worker = LocalWorker(llm, settings, Sandbox(settings))
    assert worker.name == "local" and callable(worker.run_task) and callable(worker.reset)
    tr = run(worker, task, tmp_path)
    assert isinstance(tr, Transcript)
    assert tr.stop_reason == "done" and tr.error is None
    assert [s.tool for s in tr.steps] == ["write_file", "write_file", "run_tests", "submit"]
    assert [s.step for s in tr.steps] == [1, 2, 3, 4]
    assert tr.steps[2].result.startswith("exit_code: 0")
    assert tr.workspace_files["solution.py"] == SOLUTION and "test_mine.py" in tr.workspace_files
    assert tr.messages[0]["role"] == "system" and tr.messages[0]["content"].startswith(PLAYBOOK.rstrip())
    assert tr.messages[1]["role"] == "user" and task.spec in tr.messages[1]["content"]
    assert tr.messages[-1] == {"role": "tool", "tool_call_id": tr.messages[-2]["tool_calls"][0]["id"],
                               "content": "submitted"}
    assert tr.worker == "local" and tr.model == settings.worker_model and tr.final_answer == "ok"
    assert tr.usage.requests == 4 and tr.usage.prompt_tokens == 400
    assert tr.usage_by_model[settings.worker_model].requests == 4
    call = llm.calls[0]
    assert call["tools"] == TOOL_SCHEMAS and call["thinking"] is False and call["tag"] == "v0:train:t99_add:r0"
    assert call["seed"] == seed_for("t99_add", 0) and call["max_tokens"] == settings.worker_max_tokens
    assert call["model"] == settings.worker_model
    # Byte-identical prefix on every call (prefix cache).
    assert len({json.dumps(c["messages"][:2]) for c in llm.calls}) == 1
    json.dumps(tr.to_dict())  # serializable
    assert Transcript.from_dict(json.loads(json.dumps(tr.to_dict()))).steps[0].tool == "write_file"


def test_three_step_spec_example(settings, task, tmp_path):
    llm = FakeLLM([tool_call("write_file", {"path": "solution.py", "content": SOLUTION}),
                   tool_call("run_tests", {}), tool_call("submit", {"summary": "ok"})])
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    assert len(tr.steps) == 3 and tr.stop_reason == "done"
    assert tr.workspace_files["solution.py"] == SOLUTION
    assert "no tests collected" in tr.steps[1].result


def test_text_reply_stops_done(settings, task, tmp_path):
    tr = run(LocalWorker(FakeLLM([assistant("I am done.")]), settings), task, tmp_path)
    assert tr.stop_reason == "done" and tr.final_answer == "I am done." and tr.steps == []
    assert tr.workspace_files["solution.py"] == task.starter_code


def test_cut_off_nudged_once(settings, task, tmp_path):
    llm = FakeLLM([assistant("partial", finish_reason="length"), tool_call("submit", {"summary": "s"})], strict=True)
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    assert tr.stop_reason == "done"
    assert {"role": "user", "content": "Your previous message was cut off. Continue by calling a tool, or call submit."} \
        in tr.messages


def test_step_cap(settings, task, tmp_path):
    settings.worker_max_steps = 4
    script = [tool_call("read_file", {"path": f"f{i}.py"}) for i in range(10)]
    tr = run(LocalWorker(FakeLLM(script), settings), task, tmp_path)
    assert tr.stop_reason == "step_cap" and len(tr.steps) == 4


def test_circuit_breaker_same_call(settings, task, tmp_path):
    llm = FakeLLM([tool_call("read_file", {"path": "solution.py"})])   # cycles the same call
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    assert tr.stop_reason == "circuit_breaker" and len(tr.steps) == 3 and len(llm.calls) == 3


def test_circuit_breaker_identical_test_output(settings, task, tmp_path):
    bad = "def add(a, b):\n    return a - b\n"
    script = [tool_call("write_file", {"path": "test_mine.py", "content": TEST_FILE})]
    for i in range(3):
        script += [tool_call("write_file", {"path": "solution.py", "content": bad + f"# try {i}\n"}),
                   tool_call("run_tests", {})]
    script.append(tool_call("submit", {"summary": "never reached"}))
    tr = run(LocalWorker(FakeLLM(script, strict=True), settings), task, tmp_path)
    assert tr.stop_reason == "circuit_breaker"
    assert [s.tool for s in tr.steps].count("run_tests") == 3


def test_llm_error_still_returns_transcript(settings, task, tmp_path):
    def boom(messages):
        raise RateLimitedError("nvidia/x: gave up after 9 attempts")

    llm = FakeLLM([tool_call("write_file", {"path": "solution.py", "content": SOLUTION}), boom])
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    assert tr.stop_reason == "error" and "gave up" in tr.error
    assert tr.workspace_files["solution.py"] == SOLUTION and len(tr.steps) == 1
    assert tr.usage.requests == 1


def test_malformed_arguments_not_executed(settings, task, tmp_path):
    res = tool_call("write_file", {})
    res.tool_calls[0].raw_arguments = '{"path": "solution.py", "content": "x'
    llm = FakeLLM([res, tool_call("submit", {"summary": "s"})], strict=True)
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    assert tr.steps[0].result.startswith("error: arguments for write_file were not valid JSON")
    assert tr.workspace_files["solution.py"] == task.starter_code


def test_multiple_calls_in_one_turn(settings, task, tmp_path):
    two = tool_call("write_file", {"path": "solution.py", "content": SOLUTION})
    second = tool_call("submit", {"summary": "both"})
    two.message["tool_calls"].append(second.message["tool_calls"][0])
    two.tool_calls.append(second.tool_calls[0])
    tr = run(LocalWorker(FakeLLM([two], strict=True), settings), task, tmp_path)
    assert [s.tool for s in tr.steps] == ["write_file", "submit"] and tr.stop_reason == "done"
    assert tr.workspace_files["solution.py"] == SOLUTION


def test_wallclock(settings, task, tmp_path):
    settings.task_wallclock_s = 0
    tr = run(LocalWorker(FakeLLM([tool_call("read_file", {"path": "a"})]), settings), task, tmp_path)
    assert tr.stop_reason == "wallclock" and tr.steps == []


def test_workspace_reset_between_runs(settings, task, tmp_path):
    w = LocalWorker(FakeLLM([tool_call("write_file", {"path": "extra.py", "content": "x"}),
                             tool_call("submit", {"summary": "s"})], strict=True), settings)
    run(w, task, tmp_path)
    w.llm = FakeLLM([tool_call("submit", {"summary": "s"})])
    tr = run(w, task, tmp_path)
    assert set(tr.workspace_files) == {"solution.py"}


def test_usage_summed(settings, task, tmp_path):
    script = [tool_call("read_file", {"path": "solution.py"}), assistant("done", prompt_tokens=7, completion_tokens=3)]
    tr = run(LocalWorker(FakeLLM(script, strict=True), settings), task, tmp_path)
    assert tr.usage == Usage(requests=2, prompt_tokens=107, completion_tokens=33)
    w = LocalWorker(FakeLLM([]), settings)
    w.reset()


def test_cut_off_tool_call_gets_specific_nudge_and_two_nudges_max(settings, task, tmp_path):
    from ratchet.worker import NUDGE_CUT_OFF, NUDGE_CUT_OFF_TOOL

    half = "<function=write_file>\n<parameter=path>\nsolution.py\n</parameter>\n<parameter=content>\nx = ("
    llm = FakeLLM([assistant(half, finish_reason="length"), assistant("more", finish_reason="length"),
                   assistant("still", finish_reason="length")], strict=True)
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    nudges = [m["content"] for m in tr.messages if m["role"] == "user"][1:]
    assert nudges == [NUDGE_CUT_OFF_TOOL, NUDGE_CUT_OFF]
    assert tr.stop_reason == "done" and len(llm.calls) == 3


def test_stop_request_ends_run_as_interrupted_without_a_model_call(settings, task, tmp_path):
    from ratchet import interrupt

    llm = FakeLLM([assistant("never used")])
    interrupt.request_stop()
    tr = run(LocalWorker(llm, settings), task, tmp_path)
    assert tr.stop_reason == "interrupted" and tr.error is None and tr.usage.requests == 0
