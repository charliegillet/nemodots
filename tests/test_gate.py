"""Unit tests for ratchet.gate (offline; a stub Worker, fake or subprocess verification)."""
from __future__ import annotations

import importlib.util
import zlib
from pathlib import Path

import pytest

import ratchet.gate as gate
from ratchet.config import SMOKE
from ratchet.gate import decide, default_min_delta, evaluate, per_task_rates, score, seed_for
from ratchet.store import Store
from ratchet.types import RunResult, Task, Transcript, Usage, VerifyResult


def make_task(task_id: str, split: str = "holdout") -> Task:
    return Task(task_id=task_id, split=split, spec=f"# {task_id}\nReturn 1.", starter_code="def f():\n    raise NotImplementedError\n",
                hidden_tests="from solution import f\n\n\ndef test_f():\n    assert f() == 1\n",
                reference_solution="def f():\n    return 1\n")


class EvenRepeatWorker:
    """Writes a correct solution for even repeats, a wrong one for odd repeats."""

    name = "local"

    def __init__(self):
        self.calls: list[tuple[str, int, str]] = []

    def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
        self.calls.append((task.task_id, repeat, tag))
        body = "def f():\n    return 1\n" if repeat % 2 == 0 else "def f():\n    return 2\n"
        (Path(run_dir) / "workspace").mkdir(parents=True, exist_ok=True)
        return Transcript(task_id=task.task_id, worker=self.name, model="m", version=version, repeat=repeat,
                          started_at="s", finished_at="f", messages=[], steps=[], final_answer="", stop_reason="done",
                          usage=Usage(requests=3, prompt_tokens=300, completion_tokens=30, cost_usd=0.001),
                          workspace_files={"solution.py": body})

    def reset(self):
        pass


class RaisingWorker(EvenRepeatWorker):
    def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
        if task.task_id == "boom":
            raise RuntimeError("worker exploded")
        return super().run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag)


def fake_verify(task, files, settings, run_dir, sandbox=None):
    ok = "return 1" in files.get("solution.py", "")
    return VerifyResult(passed=ok, exit_code=0 if ok else 1, output="1 passed" if ok else "1 failed", duration_s=0.01,
                        backend="fake")


# --------------------------------------------------------------------------- decide


def test_decide_accepts_improvement_without_regressions():
    d = decide({"a": 0.5, "b": 1.0}, {"a": 1.0, "b": 1.0}, min_delta=0.05)
    assert d.accepted and d.improvements == ["a"] and d.regressions == []
    assert d.delta == pytest.approx(0.25)
    assert d.reason.startswith("accepted: +25.0% (0.750 -> 1.000), 1 improved, 0 regressed")


def test_decide_rejects_any_regression_even_with_higher_score():
    d = decide({"a": 0.0, "b": 1.0, "c": 0.0}, {"a": 1.0, "b": 0.5, "c": 1.0}, min_delta=0.01)
    assert not d.accepted and d.regressions == ["b"] and d.delta > 0
    assert d.reason.startswith("rejected: regressed b")


def test_decide_rejects_equal_scores():
    d = decide({"a": 0.5}, {"a": 0.5}, min_delta=0.0)
    assert not d.accepted and d.reason.startswith("rejected: no improvement")


def test_decide_rejects_below_margin():
    inc = {f"t{i}": 0.0 for i in range(24)}
    cand = dict(inc, t0=1.0)  # +1/24 = 4.2%
    d = decide(inc, cand, min_delta=0.05)
    assert not d.accepted and d.reason == "rejected: +4.2% below margin 5.0%"


def test_decide_missing_candidate_task_is_zero():
    d = decide({"a": 1.0, "b": 0.0}, {"b": 1.0}, min_delta=0.0)
    assert d.regressions == ["a"] and not d.accepted
    assert d.candidate_score == pytest.approx(0.5)


def test_decide_tiny_margin_accepts_one_run():
    d = decide({"a": 0.5, "b": 0.0}, {"a": 1.0, "b": 0.0}, min_delta=default_min_delta(2, 2))
    assert d.accepted


def test_default_min_delta_and_score_helpers():
    assert default_min_delta(12, 2) == pytest.approx(1 / 24)
    assert default_min_delta(0, 2) == 0.0
    assert score({}) == 0.0
    assert score({"a": 1.0, "b": 0.5}) == pytest.approx(0.75)
    results = [RunResult(task_id=t, version=0, repeat=r, passed=p, exit_code=0, test_output="", transcript_path="",
                         usage=Usage(), duration_s=0, stop_reason="done")
               for t, r, p in (("a", 0, True), ("a", 1, False), ("b", 0, True))]
    assert per_task_rates(results) == {"a": 0.5, "b": 1.0}
    assert seed_for("t01", 1) == (zlib.crc32(b"t01") + 1) % 2**31


# --------------------------------------------------------------------------- evaluate


def test_evaluate_runs_every_pair_and_saves(settings, monkeypatch):
    monkeypatch.setattr(gate, "run_hidden_tests", fake_verify)
    store = Store(settings.runs_dir)
    store.init("# P\n", config=SMOKE, worker="local", holdout_ids=["h2", "h1"], train_ids=[])
    worker = EvenRepeatWorker()
    seen: list[RunResult] = []
    results = evaluate([make_task("h2"), make_task("h1")], "# P\n", version=0, split="holdout", repeats=2,
                       worker=worker, settings=settings, store=store, ledger=None, progress=seen.append)
    assert [(r.task_id, r.repeat, r.passed) for r in results] == [
        ("h1", 0, True), ("h1", 1, False), ("h2", 0, True), ("h2", 1, False)]
    assert len(seen) == 4
    assert {c[2] for c in worker.calls} == {"v0:holdout:h1:r0", "v0:holdout:h1:r1", "v0:holdout:h2:r0", "v0:holdout:h2:r1"}
    for r in results:
        rd = store.run_dir(0, "holdout", r.task_id, r.repeat)
        assert (rd / "transcript.json").exists() and (rd / "result.json").exists()
        assert r.transcript_path == f"runs/versions/v0/holdout/{r.task_id}/r{r.repeat}/transcript.json"
        assert r.split == "holdout" and r.usage.requests == 3
    assert per_task_rates(results) == {"h1": 0.5, "h2": 0.5}
    assert len(store.load_runs(0, "holdout")) == 4

    # skip_existing reuses saved results without calling the worker again
    worker2 = EvenRepeatWorker()
    again = evaluate([make_task("h1"), make_task("h2")], "# P\n", version=0, split="holdout", repeats=2,
                     worker=worker2, settings=settings, store=store, ledger=None, skip_existing=True)
    assert worker2.calls == [] and [r.passed for r in again] == [r.passed for r in results]


def test_evaluate_worker_exception_becomes_failed_result(settings, monkeypatch):
    monkeypatch.setattr(gate, "run_hidden_tests", fake_verify)
    store = Store(settings.runs_dir)
    results = evaluate([make_task("boom"), make_task("ok")], "# P\n", version=3, split="train", repeats=1,
                       worker=RaisingWorker(), settings=settings, store=store, ledger=None)
    by = {r.task_id: r for r in results}
    assert not by["boom"].passed and by["boom"].stop_reason == "error"
    assert by["ok"].passed
    tr = store.load_transcript(by["boom"])
    assert "worker exploded" in (tr.error or "")


def test_evaluate_verify_exception_and_ledger_fallback(settings, monkeypatch):
    def broken_verify(*a, **k):
        raise OSError("sandbox down")

    class Ledger:
        def total(self, prefix=""):
            return Usage(requests=7) if prefix == "v0:holdout:h1:r0" else Usage()

    class ZeroUsageWorker(EvenRepeatWorker):
        def run_task(self, *a, **k):
            t = super().run_task(*a, **k)
            t.usage = Usage()
            return t

    monkeypatch.setattr(gate, "run_hidden_tests", broken_verify)
    store = Store(settings.runs_dir)
    [r] = evaluate([make_task("h1")], "# P\n", version=0, split="holdout", repeats=1, worker=ZeroUsageWorker(),
                   settings=settings, store=store, ledger=Ledger())
    assert not r.passed and "sandbox down" in r.test_output
    assert r.usage.requests == 7


@pytest.mark.skipif(importlib.util.find_spec("ratchet.verify") is None, reason="ratchet.verify (I1) not present")
def test_evaluate_with_real_subprocess_verification(settings):
    store = Store(settings.runs_dir)
    results = evaluate([make_task("h1")], "# P\n", version=0, split="holdout", repeats=2, worker=EvenRepeatWorker(),
                       settings=settings, store=store, ledger=None)
    assert [r.passed for r in results] == [True, False]
    assert results[1].exit_code != 0


def test_interrupt_cancels_queued_runs_and_returns_promptly(settings, monkeypatch):
    """Ctrl-C / SIGTERM (KeyboardInterrupt in the main thread) must not wait for every queued run."""
    import threading
    import time

    monkeypatch.setattr(gate, "run_hidden_tests", fake_verify)
    started: list[str] = []
    lock = threading.Lock()

    class SlowWorker(EvenRepeatWorker):
        def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
            with lock:
                started.append(task.task_id)
            time.sleep(0.3)
            return super().run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag)

    settings.max_inflight_per_model = 2
    tasks = [make_task(f"t{i:02d}") for i in range(12)]

    def interrupt(_res):
        raise KeyboardInterrupt

    t0 = time.monotonic()
    with pytest.raises(KeyboardInterrupt):
        evaluate(tasks, "pb", version=0, split="holdout", repeats=1, worker=SlowWorker(), settings=settings,
                 store=Store(settings.runs_dir), ledger=None, progress=interrupt)
    assert time.monotonic() - t0 < 2.0
    time.sleep(0.5)                       # in-flight runs finish; queued ones were cancelled
    assert len(started) <= 4


@pytest.mark.parametrize("backend,isolation,label", [("docker", "container", "docker"), ("subprocess", "seatbelt", "seatbelt"),
                                                     ("subprocess", "none", "unsandboxed"), ("fake", "", "")])
def test_run_result_records_sandbox(settings, monkeypatch, backend, isolation, label):
    def verify(task, files, settings, run_dir, sandbox=None):
        return VerifyResult(passed=True, exit_code=0, output="1 passed", duration_s=0.0, backend=backend, isolation=isolation)

    monkeypatch.setattr(gate, "run_hidden_tests", verify)
    store = Store(settings.runs_dir)
    res = evaluate([make_task("t01")], "pb", version=0, split="holdout", repeats=1, worker=EvenRepeatWorker(),
                   settings=settings, store=store, ledger=None)
    assert res[0].sandbox == label and store.load_runs(0, "holdout")[0].sandbox == label


def test_interrupt_waits_for_in_flight_runs_and_discards_them(settings, monkeypatch):
    """After Ctrl-C / SIGTERM the gate returns only once in-flight runs have stopped, and a run that stopped
    because of the interrupt is neither scored nor left on disk (a resume re-runs it)."""
    import threading
    import time

    from ratchet import interrupt

    monkeypatch.setattr(gate, "run_hidden_tests", fake_verify)
    finished: list[str] = []
    lock = threading.Lock()

    class CooperativeWorker(EvenRepeatWorker):
        def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
            if task.task_id == "t00":   # completes before the interrupt
                return super().run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag)
            (Path(run_dir) / "workspace").mkdir(parents=True, exist_ok=True)
            deadline = time.monotonic() + 5
            while not interrupt.stop_requested() and time.monotonic() < deadline:   # "the next model call"
                time.sleep(0.01)
            time.sleep(0.2)
            with lock:
                finished.append(task.task_id)
            tr = super().run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag)
            tr.stop_reason = "interrupted"
            return tr

    settings.max_inflight_per_model = 3
    tasks = [make_task(f"t{i:02d}") for i in range(6)]
    store = Store(settings.runs_dir)
    seen: list[str] = []

    def progress(res):
        seen.append(res.task_id)
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        evaluate(tasks, "pb", version=0, split="holdout", repeats=1, worker=CooperativeWorker(), settings=settings,
                 store=store, ledger=None, progress=progress)
    # every in-flight run had finished by the time the interrupt propagated
    assert sorted(finished) == ["t01", "t02"]
    assert seen == ["t00"]
    assert store.load_result(0, "holdout", "t00", 0) is not None
    for tid in ("t01", "t02", "t03"):
        assert store.load_result(0, "holdout", tid, 0) is None
        assert not store.run_dir(0, "holdout", tid, 0).exists()
    # the next gate starts clean and reuses the saved run
    res = evaluate(tasks, "pb", version=0, split="holdout", repeats=1, worker=EvenRepeatWorker(), settings=settings,
                   store=store, ledger=None, skip_existing=True)
    assert [r.task_id for r in res] == [t.task_id for t in tasks] and all(r.passed for r in res)
