"""Unit tests for ratchet.cli (offline: every model/worker/bench dependency is stubbed)."""
from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass, field

import pytest

import ratchet.cli as cli
import ratchet.gate as gate
from ratchet.fakes import FakeLLM, assistant
from ratchet.types import Task, Transcript, Usage, VerifyResult


def make_task(task_id: str, split: str) -> Task:
    return Task(task_id=task_id, split=split, spec=f"# {task_id}\n", starter_code="", hidden_tests="", reference_solution="")


class StubWorker:
    name = "local"

    def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
        ok = "tests" in playbook
        return Transcript(task_id=task.task_id, worker=self.name, model="m", version=version, repeat=repeat, started_at="",
                          finished_at="", messages=[], steps=[], final_answer="", stop_reason="done",
                          usage=Usage(requests=1, prompt_tokens=10), workspace_files={"solution.py": "PASS" if ok else ""})

    def reset(self):
        pass


def fake_verify(task, files, settings, run_dir, sandbox=None):
    ok = files.get("solution.py") == "PASS"
    return VerifyResult(passed=ok, exit_code=0 if ok else 1, output="", duration_s=0.0)


REVIEW = json.dumps({"diagnosis": "no tests", "edit": {"op": "append_section", "anchor": "",
                                                       "text": "## Testing\n- Write tests for each rule."},
                     "rationale": "tests help"})


@pytest.fixture
def stubs(monkeypatch):
    """Stub the LLM, ledger, local worker and task selection; returns the FakeLLM."""
    llm = FakeLLM([assistant(REVIEW)])
    monkeypatch.setattr(cli, "_build_ledger", lambda settings: None)
    monkeypatch.setattr(cli, "_build_llm", lambda settings, ledger: llm)
    monkeypatch.setattr(cli, "_build_local_worker", lambda settings, llm: StubWorker())
    monkeypatch.setattr(cli, "_select_tasks", lambda settings, config, store, llm, resume:
                        ([make_task("h1", "holdout"), make_task("h2", "holdout")], [make_task("t1", "train")]))
    monkeypatch.setattr(gate, "run_hidden_tests", fake_verify)
    return llm


def fake_openbot_module(monkeypatch, ok: bool):
    mod = types.ModuleType("ratchet.workers.openbot_worker")

    class OpenBotWorker(StubWorker):
        name = "openbot"

        def __init__(self, settings, **kw):
            self.kw = kw

        @classmethod
        def availability(cls, settings, *, mode="agui"):
            return (True, "") if ok else (False, "agent-bot not reachable on 127.0.0.1:4200 — run integrations/openbot/setup.sh")

    mod.OpenBotWorker = OpenBotWorker
    monkeypatch.setitem(sys.modules, "ratchet.workers.openbot_worker", mod)


def test_report_on_empty_runs_dir(settings, capsys):
    assert cli.main(["report"]) == 0
    assert (settings.runs_dir / "report.html").exists()
    assert "report:" in capsys.readouterr().out


def test_run_without_key_exits_2(monkeypatch, capsys):
    monkeypatch.setenv("CRUSOE_API_KEY", "")
    assert cli.main(["run", "--config", "smoke"]) == 2
    assert "CRUSOE_API_KEY is not set in .env" in capsys.readouterr().err
    assert cli.main(["ping"]) == 2
    assert cli.main(["bench-check"]) == 2


def test_bad_usage_exits_2():
    assert cli.main(["run", "--config", "nope"]) == 2
    assert cli.main([]) == 2


def test_openbot_unavailable_exits_3(monkeypatch, stubs, capsys, settings):
    fake_openbot_module(monkeypatch, ok=False)
    called = []
    monkeypatch.setattr(cli, "run_loop", lambda **kw: called.append(kw) or [])
    assert cli.main(["run", "--config", "smoke", "--worker", "openbot"]) == 3
    assert "openbot worker unavailable: agent-bot not reachable" in capsys.readouterr().err
    assert called == []


def test_openbot_fallback_local_proceeds(monkeypatch, stubs, capsys):
    fake_openbot_module(monkeypatch, ok=False)
    called = []
    monkeypatch.setattr(cli, "run_loop", lambda **kw: called.append(kw) or [])
    assert cli.main(["run", "--config", "smoke", "--worker", "openbot", "--fallback-local"]) == 0
    assert len(called) == 1 and isinstance(called[0]["worker"], StubWorker)
    assert called[0]["config"].name == "smoke"
    assert "--fallback-local" in capsys.readouterr().err


def test_openbot_available_is_used(monkeypatch, stubs):
    fake_openbot_module(monkeypatch, ok=True)
    called = []
    monkeypatch.setattr(cli, "run_loop", lambda **kw: called.append(kw) or [])
    assert cli.main(["run", "--worker", "openbot", "--rounds", "2", "--repeats", "3", "--min-delta", "0.1"]) == 0
    w = called[0]["worker"]
    assert w.name == "openbot" and w.kw.get("mode") == "agui"
    cfg = called[0]["config"]
    assert (cfg.rounds, cfg.repeats, cfg.min_delta) == (2, 3, 0.1) and called[0]["rounds"] == 2


def test_full_smoke_run_with_stubs(stubs, settings, capsys):
    assert cli.main(["run", "--config", "smoke", "--live"]) == 0
    out = capsys.readouterr().out
    assert "round 1: candidate v1 (parent v0) ACCEPTED" in out and "PASS" in out
    doc = json.loads((settings.runs_dir / "history.json").read_text())
    assert [v["status"] for v in doc["versions"]] == ["superseded", "incumbent"]
    assert doc["live"] is False
    assert (settings.runs_dir / "report.html").exists() and (settings.runs_dir / "loop.log").exists()
    # resume: one more round; the reviewer proposes the same section again -> invalid 3x -> stops
    assert cli.main(["run", "--config", "smoke", "--rounds", "1"]) == 0
    assert "(resuming)" in capsys.readouterr().out
    # show
    assert cli.main(["show"]) == 0
    shown = capsys.readouterr().out
    assert '"version": 1' in shown and "## Testing" in shown
    assert cli.main(["show", "--version", "0"]) == 0
    # --fresh wipes and starts again
    assert cli.main(["run", "--config", "smoke", "--fresh", "--rounds", "0"]) == 0
    doc = json.loads((settings.runs_dir / "history.json").read_text())
    assert [v["version"] for v in doc["versions"]] == [0]


def test_show_without_history_exits_2():
    assert cli.main(["show"]) == 2


def test_unexpected_error_exits_1(monkeypatch, stubs, capsys, settings):
    def boom(**kw):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(cli, "run_loop", boom)
    assert cli.main(["run"]) == 1
    err = capsys.readouterr().err
    assert "kaboom" in err and "Traceback" not in err
    assert "Traceback" in (settings.runs_dir / "loop.log").read_text()


# --------------------------------------------------------------------------- bench-check / task selection


@dataclass
class FakeMutant:
    valid: bool
    killed: bool | None


@dataclass
class FakeCheck:
    task_id: str
    verdict: str
    fingerprint: str = "fp"
    mutants: list = field(default_factory=lambda: [FakeMutant(True, True), FakeMutant(True, True)])
    usage: Usage = field(default_factory=lambda: Usage(requests=2, cost_usd=0.002))


def fake_bench(monkeypatch, tasks, verdicts):
    import ratchet.bench as bench

    monkeypatch.setattr(bench, "load_tasks", lambda split=None, ids=None: [t for t in tasks if split in (None, t.split)])
    monkeypatch.setattr(bench, "task_fingerprint", lambda t: "fp")
    mod = types.ModuleType("ratchet.mutate")
    state = {"checked": 0, "cache": {}}

    def check_bench(ts, llm, settings, *, cache_path=None, force=False, progress=None):
        state["checked"] += 1
        out = [FakeCheck(t.task_id, verdicts.get(t.task_id, "strong")) for t in ts]
        for r in out:
            state["cache"][r.task_id] = r
            if progress:
                progress(r)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text("{}")
        return out

    mod.check_bench = check_bench
    mod.load_bench_check = lambda path: dict(state["cache"])
    mod.usable_task_ids = lambda path, ts: sorted(t.task_id for t in ts
                                                 if state["cache"].get(t.task_id) and
                                                 state["cache"][t.task_id].verdict in ("strong", "inconclusive"))
    monkeypatch.setitem(sys.modules, "ratchet.mutate", mod)
    monkeypatch.setattr(sys.modules["ratchet"], "mutate", mod, raising=False)
    return state


def test_bench_check_exit_codes(monkeypatch, capsys):
    monkeypatch.setattr(cli, "_build_ledger", lambda settings: None)
    monkeypatch.setattr(cli, "_build_llm", lambda settings, ledger: FakeLLM([assistant("x")]))
    tasks = [make_task("t01", "train"), make_task("t11", "holdout")]
    fake_bench(monkeypatch, tasks, {"t11": "weak"})
    assert cli.main(["bench-check"]) == 4
    out = capsys.readouterr().out
    assert "weak or broken: t11" in out and "planter usage this run: 2 task(s) checked" in out and "$0.0040" in out
    fake_bench(monkeypatch, tasks, {})
    assert cli.main(["bench-check", "--split", "train"]) == 0


def test_select_tasks_runs_bench_check_when_stale_and_caps(monkeypatch, settings):
    from ratchet.config import SMOKE
    from ratchet.store import Store

    tasks = [make_task(f"h{i}", "holdout") for i in range(5)] + [make_task(f"t{i}", "train") for i in range(5)]
    state = fake_bench(monkeypatch, tasks, {"h0": "weak", "t1": "broken"})
    holdout, train = cli._select_tasks(settings, SMOKE, Store(settings.runs_dir), None, resume=False)
    assert state["checked"] == 1
    assert [t.task_id for t in holdout] == ["h1", "h2", "h3"] and [t.task_id for t in train] == ["t0", "t2", "t3"]
    cli._select_tasks(settings, SMOKE, Store(settings.runs_dir), None, resume=False)
    assert state["checked"] == 1  # cache fresh: no second bench-check


# --------------------------------------------------------------------------- SIGTERM / live flag / resume checks


@pytest.fixture
def restore_sigterm():
    import signal

    old = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, old)


def test_sigterm_clears_live_flag_and_writes_report(monkeypatch, stubs, settings, capsys, restore_sigterm):
    import os
    import signal

    def killed(**kw):
        os.kill(os.getpid(), signal.SIGTERM)
        raise AssertionError("SIGTERM did not interrupt")

    monkeypatch.setattr(cli, "run_loop", killed)
    assert cli.main(["run", "--config", "smoke", "--live"]) == 143
    doc = json.loads((settings.runs_dir / "history.json").read_text())
    assert doc["live"] is False and "live_pid" not in doc
    html = (settings.runs_dir / "report.html").read_text()
    assert "http-equiv" not in html and ">LIVE<" not in html
    assert "SIGTERM" in capsys.readouterr().err


def test_report_clears_stale_live_flag(stubs, settings, capsys):
    from ratchet.store import Store

    assert cli.main(["run", "--config", "smoke", "--rounds", "0"]) == 0
    store = Store(settings.runs_dir)
    store.set_live(True, pid=2**22 + 12345)          # a pid that is not running
    assert cli.main(["report"]) == 0
    assert "stale LIVE" in capsys.readouterr().out
    assert store.load_history()["live"] is False
    # a live flag owned by a running process is left alone
    import os

    store.set_live(True, pid=os.getpid())
    assert cli.main(["report"]) == 0
    assert store.load_history()["live"] is True


def test_resume_with_different_config_is_refused(stubs, settings, capsys):
    assert cli.main(["run", "--config", "smoke", "--rounds", "0"]) == 0
    capsys.readouterr()
    assert cli.main(["run", "--config", "demo", "--rounds", "0"]) == 2
    err = capsys.readouterr().err
    assert "different config" in err and "--fresh" in err
    assert cli.main(["run", "--config", "smoke", "--holdout", "5", "--rounds", "0"]) == 2
    # no --config on resume -> the stored config is used
    assert cli.main(["run", "--rounds", "0"]) == 0
    assert "config=smoke" in capsys.readouterr().out
    # --fresh may change the config
    assert cli.main(["run", "--config", "demo", "--fresh", "--rounds", "0"]) == 0


def test_explicit_zero_min_delta_is_printed(stubs, capsys):
    assert cli.main(["run", "--config", "smoke", "--rounds", "0", "--min-delta", "0"]) == 0
    assert "margin=0.0%" in capsys.readouterr().out


def test_resume_refuses_a_different_min_delta_and_reports_rounds(stubs, settings, capsys):
    assert cli.main(["run", "--config", "smoke", "--rounds", "0"]) == 0
    capsys.readouterr()
    assert cli.main(["run", "--config", "smoke", "--rounds", "0", "--min-delta", "0.01"]) == 2
    assert "min_delta" in capsys.readouterr().err
    # the stored value, given explicitly, is accepted; the resume says what it will run
    assert cli.main(["run", "--config", "smoke", "--rounds", "2", "--min-delta", "1e-9"]) == 0
    out = capsys.readouterr().out
    assert "resuming: rounds_completed=" in out and "more" in out


@pytest.fixture
def other_live_pid():
    """A live process whose command line mentions ratchet (stands in for a running DEMO)."""
    import subprocess

    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "ratchet-demo-stand-in"])
    yield proc.pid
    proc.kill()
    proc.wait()


def _write_live_history(runs_dir, pid):
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / "history.json").write_text(json.dumps({"schema": 1, "versions": [], "live": True, "live_pid": pid}))


def test_run_refused_while_other_live_run(stubs, settings, tmp_path, monkeypatch, capsys, other_live_pid):
    demo_runs = tmp_path / "demo-runs"
    _write_live_history(demo_runs, other_live_pid)
    monkeypatch.setattr(cli, "DEFAULT_RUNS_DIR", demo_runs)
    for argv in (["run", "--config", "smoke"], ["eval", "--version", "0"], ["bench-check"]):
        assert cli.main(argv) == 2, argv
        assert f"pid {other_live_pid}" in capsys.readouterr().err
    assert not (settings.runs_dir / "history.json").exists()
    # --allow-concurrent lets a run in a different runs dir go ahead
    assert cli.main(["run", "--config", "smoke", "--allow-concurrent"]) == 0
    capsys.readouterr()


def test_second_run_in_same_runs_dir_never_allowed(stubs, settings, capsys, other_live_pid):
    _write_live_history(settings.runs_dir, other_live_pid)
    assert cli.main(["run", "--allow-concurrent"]) == 2
    assert "already writing" in capsys.readouterr().err


def test_dead_or_own_live_pid_does_not_block(stubs, settings, capsys):
    import os

    _write_live_history(settings.runs_dir, 999999)
    assert cli._live_runs(settings) == []
    _write_live_history(settings.runs_dir, os.getpid())
    assert cli._live_runs(settings) == []
