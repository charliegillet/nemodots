"""Unit tests for ratchet.loop (offline: FakeLLM reviewer, stub Worker, fake verification)."""
from __future__ import annotations

import dataclasses
import json

import pytest

import ratchet.gate as gate
from ratchet.config import SMOKE
from ratchet.fakes import FakeLLM, assistant
from ratchet.loop import _min_delta, bootstrap, resume_pending, reviewer_safe_reason, run_loop
from ratchet.reviewer import unified_diff
from ratchet.store import Store
from ratchet.types import PlaybookEdit, Task, ToolStep, Transcript, Usage, VerifyResult

SEED = "# Coding worker playbook\n\nWrite solution.py, then call submit.\n"


def make_task(task_id: str, split: str) -> Task:
    return Task(task_id=task_id, split=split, spec=f"# {task_id.title()}\n\nDo it.", starter_code=f"def {task_id}_fn():\n    pass\n",
                hidden_tests="", reference_solution="")


HOLDOUT = [make_task("h1", "holdout"), make_task("h2", "holdout")]
TRAIN = [make_task("tr1", "train"), make_task("tr2", "train")]


class PlaybookWorker:
    """Passes a task iff the playbook mentions 'tests' (tasks named *hard* never pass; 'WORSE' breaks h2)."""

    name = "local"

    def __init__(self):
        self.runs: list[str] = []
        self.resets = 0

    def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
        self.runs.append(tag)
        ok = "tests" in playbook and "hard" not in task.task_id and not ("WORSE" in playbook and task.task_id == "h2")
        steps = [ToolStep(step=i, tool="run_python", arguments={"code": "print(1)"}, result="exit_code: 0") for i in range(1, 3)]
        return Transcript(task_id=task.task_id, worker=self.name, model="m", version=version, repeat=repeat,
                          started_at="s", finished_at="f", messages=[], steps=steps, final_answer="",
                          stop_reason="done", usage=Usage(requests=2, prompt_tokens=100, completion_tokens=10, cost_usd=0.0001),
                          workspace_files={"solution.py": "PASS" if ok else "FAIL"})

    def reset(self):
        self.resets += 1


def fake_verify(task, files, settings, run_dir, sandbox=None):
    ok = files.get("solution.py") == "PASS"
    return VerifyResult(passed=ok, exit_code=0 if ok else 1, output="ok" if ok else "FAILED test_x - AssertionError",
                        duration_s=0.0)


def review_json(text: str, op: str = "append_section", anchor: str = "") -> str:
    return json.dumps({"diagnosis": "The worker never tested.", "edit": {"op": op, "anchor": anchor, "text": text},
                       "rationale": "Testing catches edge cases."})


@pytest.fixture
def env(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(gate, "run_hidden_tests", fake_verify)
    pb = tmp_path / "v0.md"
    pb.write_text(SEED)
    cfg = dataclasses.replace(SMOKE, rounds=3, repeats=2, holdout_size=None, train_size=None, min_delta=None,
                              max_failures_to_reviewer=2, stop_when_train_clean=True)
    return {"settings": settings, "store": Store(settings.runs_dir), "pb": pb, "cfg": cfg}


def _kw(env, worker, llm):
    return dict(store=env["store"], settings=env["settings"], config=env["cfg"], worker=worker, llm=llm, ledger=None,
                holdout=HOLDOUT, train=TRAIN + [make_task("tr_hard", "train")])


def test_bootstrap_evaluates_v0_once(env):
    worker = PlaybookWorker()
    rec = bootstrap(env["store"], env["settings"], env["cfg"], worker, None, None, playbook_path=env["pb"],
                    holdout=HOLDOUT, train=TRAIN)
    assert rec.version == 0 and rec.status == "incumbent" and rec.holdout_score == 0.0
    assert rec.per_task == {"h1": 0.0, "h2": 0.0} and rec.repeats == 2
    assert "holdout" in rec.usage_by_phase and rec.usage.requests == 8
    assert rec.usage_by_model[env["settings"].worker_model].requests == 8
    assert len(worker.runs) == 4
    again = bootstrap(env["store"], env["settings"], env["cfg"], worker, None, None, playbook_path=env["pb"],
                      holdout=HOLDOUT, train=TRAIN)
    assert again.version == 0 and len(worker.runs) == 4  # not re-evaluated
    with pytest.raises(ValueError, match="holdout set differs"):
        bootstrap(env["store"], env["settings"], env["cfg"], worker, None, None, playbook_path=env["pb"],
                  holdout=HOLDOUT[:1], train=TRAIN)
    assert (env["store"].runs_dir / "report.html").exists()


def test_round_accepts_then_reviewer_failure_stops(env):
    worker = PlaybookWorker()
    noop = review_json("Write solution.py, then call submit.", op="replace_text", anchor="Write solution.py, then call submit.")
    llm = FakeLLM([assistant(review_json("## Testing\n- Write tests for every rule and run them.")),
                   assistant(noop)])
    outcomes = run_loop(rounds=3, playbook_path=env["pb"], **_kw(env, worker, llm))
    assert [o.stopped for o in outcomes] == [None, "reviewer_failed"]
    first = outcomes[0]
    assert first.decision.accepted and first.candidate.version == 1 and first.candidate.status == "incumbent"
    assert first.decision.improvements == ["h1", "h2"] and first.decision.reason.startswith("accepted: +100.0%")
    store = env["store"]
    statuses = {r.version: r.status for r in store.versions()}
    assert statuses == {0: "superseded", 1: "incumbent"}
    doc = store.load_history()
    assert doc["incumbent"] == 1 and doc["rounds_completed"] == 1
    v0, v1 = store.get(0), store.get(1)
    assert set(v0.usage_by_phase) == {"holdout", "train"}
    assert set(v1.usage_by_phase) == {"review", "holdout", "train"}  # v1 ran train in round 2
    assert v1.usage_by_phase["review"].requests == 1
    assert v1.usage_by_model[env["settings"].reviewer_model].prompt_tokens == 100
    assert v1.holdout_score == 1.0 and v1.incumbent_score == 0.0 and v1.delta == pytest.approx(1.0)
    assert v1.rationale == "Testing catches edge cases." and v1.diagnosis == "The worker never tested."
    assert "## Testing" in store.playbook(1) and "+## Testing" in store.diff_text(1)
    # the reviewer saw train failures only, with the failing tasks named
    req = llm.calls[0]["messages"][1]["content"]
    assert "tr1" in req and "h1" not in req.split("# Failed runs (train)")[1]
    # round 2: only tr_hard fails; reviewer called 3 times with no-op edits
    assert len(llm.calls) == 4
    assert worker.resets == 1
    assert (store.runs_dir / "report.html").exists()


def test_rejected_candidate_and_rejected_edits_shown_next_round(env):
    worker = PlaybookWorker()
    llm = FakeLLM([assistant(review_json("## Speed\n- Be quick. WORSE")),
                   assistant(review_json("## Brevity\n- Short answers.")),
                   assistant(review_json("## Testing\n- Write tests for every rule."))], strict=True)
    outcomes = run_loop(rounds=3, playbook_path=env["pb"], **_kw(env, worker, llm))
    assert [o.decision.accepted for o in outcomes] == [False, False, True]
    assert outcomes[0].decision.reason.startswith("rejected: no improvement")
    store = env["store"]
    assert {r.version: r.status for r in store.versions()} == {0: "superseded", 1: "rejected", 2: "rejected", 3: "incumbent"}
    # train runs of v0 were reused across rounds (2 train tasks + hard, 1 repeat, run once)
    assert sum(1 for t in worker.runs if t.startswith("v0:train:")) == 3
    req3 = llm.calls[2]["messages"][1]["content"]
    assert "Previously rejected edits" in req3 and "+## Speed" in req3 and "+## Brevity" in req3
    assert store.get(1).parent == 0 and store.get(2).parent == 0 and store.get(3).parent == 0
    assert store.load_history()["rounds_completed"] == 3


def test_regression_rejected(env):
    worker = PlaybookWorker()
    llm = FakeLLM([assistant(review_json("## Testing\n- Write tests for every rule.")),
                   assistant(review_json("## Extra\n- WORSE habits."))], strict=True)
    outcomes = run_loop(rounds=2, playbook_path=env["pb"], **_kw(env, worker, llm))
    assert outcomes[0].decision.accepted
    assert not outcomes[1].decision.accepted and outcomes[1].decision.regressions == ["h2"]
    assert env["store"].get(2).status == "rejected" and env["store"].incumbent().version == 1


def test_train_clean_stops(env):
    worker = PlaybookWorker()
    env["pb"].write_text(SEED + "\nAlways write tests.\n")
    llm = FakeLLM([assistant(review_json("## X\n- y"))])
    kw = _kw(env, worker, llm)
    kw["train"] = TRAIN
    outcomes = run_loop(rounds=2, playbook_path=env["pb"], **kw)
    assert [o.stopped for o in outcomes] == ["train_clean"] and llm.calls == []
    # clean on r0 -> one fresh pass (r1) before stopping
    train_runs = sorted(t for t in worker.runs if t.startswith("v0:train:"))
    assert train_runs == ["v0:train:tr1:r0", "v0:train:tr1:r1", "v0:train:tr2:r0", "v0:train:tr2:r1"]
    # a resume does not freeze on the cached clean results: it reuses r0/r1 and draws r2
    outcomes = run_loop(rounds=1, playbook_path=env["pb"], **kw)
    assert [o.stopped for o in outcomes] == ["train_clean"]
    assert sorted([t for t in worker.runs if t.startswith("v0:train:")][-2:]) == ["v0:train:tr1:r2", "v0:train:tr2:r2"]
    assert sum(1 for t in worker.runs if t.startswith("v0:train:")) == 6
    assert env["store"].get(0).usage_by_phase["train"].requests == 12


class FlakyOnSecondPass(PlaybookWorker):
    """Like PlaybookWorker, but tr1 fails on repeat 1 (a flake the first clean pass did not show)."""

    def run_task(self, task, playbook, *, version, repeat, run_dir, tag):
        tr = super().run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag)
        if task.task_id == "tr1" and repeat == 1:
            tr.workspace_files = {"solution.py": "FAIL"}
        return tr


def test_fresh_train_pass_failure_feeds_reviewer(env):
    worker = FlakyOnSecondPass()
    env["pb"].write_text(SEED + "\nAlways write tests.\n")
    llm = FakeLLM([assistant(review_json("## X\n- Read the spec twice."))])
    kw = _kw(env, worker, llm)
    kw["train"] = TRAIN
    outcomes = run_loop(rounds=1, playbook_path=env["pb"], **kw)
    assert outcomes[0].stopped is None and outcomes[0].candidate is not None
    req = llm.calls[0]["messages"][1]["content"]
    assert "tr1" in req and "every train run passed" not in req


def test_no_failures_still_reviews_when_not_stopping(env):
    worker = PlaybookWorker()
    env["pb"].write_text(SEED + "\nAlways write tests.\n")
    env["cfg"] = dataclasses.replace(env["cfg"], stop_when_train_clean=False)
    llm = FakeLLM([assistant(review_json("## X\n- Read the spec twice."))])
    kw = _kw(env, worker, llm)
    kw["train"] = TRAIN
    outcomes = run_loop(rounds=1, playbook_path=env["pb"], **kw)
    assert outcomes[0].candidate is not None and not outcomes[0].decision.accepted
    assert "every train run passed" in llm.calls[0]["messages"][1]["content"]


def test_resume_pending_candidate(env):
    worker = PlaybookWorker()
    store = env["store"]
    bootstrap(store, env["settings"], env["cfg"], worker, None, None, playbook_path=env["pb"], holdout=HOLDOUT, train=TRAIN)
    new = SEED + "\n## Testing\nRun tests.\n"
    edit = PlaybookEdit(op="append_section", anchor="", text="## Testing\nRun tests.", rationale="r")
    store.create_version(parent=0, playbook=new, diff=unified_diff(SEED, new, old_name="a", new_name="b"), edit=edit,
                         round=1, worker="local")
    stale = store.create_version(parent=0, playbook=new + "x\n", diff="", edit=edit, round=1, worker="local")
    outs = resume_pending(store=store, settings=env["settings"], config=env["cfg"], worker=worker, ledger=None,
                          holdout=HOLDOUT)
    assert len(outs) == 1 and outs[0].decision.accepted and outs[0].candidate.version == 1
    assert store.get(stale.version).status == "failed"
    assert store.incumbent().version == 1


def test_reviewer_never_sees_regressed_holdout_ids(env):
    """After a regression-rejected candidate, the next review request names no holdout task."""
    import re

    worker = PlaybookWorker()
    llm = FakeLLM([assistant(review_json("## Testing\n- Write tests for every rule.")),
                   assistant(review_json("## Extra\n- WORSE habits.")),
                   assistant(review_json("## Checks\n- Re-read the spec before submit."))], strict=True)
    outcomes = run_loop(rounds=3, playbook_path=env["pb"], **_kw(env, worker, llm))
    assert outcomes[1].decision.regressions == ["h2"]
    store = env["store"]
    assert "h2" in store.get(2).gate_reason            # full reason kept in history / report
    req = "\n".join(m["content"] for m in llm.calls[2]["messages"])
    assert "Previously rejected edits" in req and "+## Extra" in req
    assert "regressed 1 sealed holdout task" in req
    for t in HOLDOUT:
        assert not re.search(r"(?<![A-Za-z0-9_])" + t.task_id + r"(?![A-Za-z0-9_])", req), t.task_id


def test_reviewer_safe_reason_variants():
    from ratchet.types import VersionRecord

    def rec(delta, regs, imps):
        return VersionRecord(version=2, parent=1, status="rejected", round=2, created_at="", playbook_path="",
                             diff_path=None, rationale="", diagnosis="", holdout_score=0.5, per_task={}, repeats=2,
                             incumbent_version=1, incumbent_score=0.5, delta=delta, regressions=regs,
                             improvements=imps, gate_reason="rejected: regressed t11_x", usage=Usage())
    assert reviewer_safe_reason(rec(0.1, ["t11_x", "t12_y"], ["t13_z"])) == \
        "rejected: regressed 2 sealed holdout tasks (+10.0% overall, 1 improved)"
    assert "no improvement" in reviewer_safe_reason(rec(0.0, [], []))
    assert "below the acceptance margin" in reviewer_safe_reason(rec(0.02, [], ["t13_z"]))
    assert "t1" not in reviewer_safe_reason(rec(None, [], []))


def test_explicit_zero_min_delta_is_respected():
    assert _min_delta(dataclasses.replace(SMOKE, min_delta=0.0), 10) == 0.0
    assert _min_delta(dataclasses.replace(SMOKE, min_delta=None, repeats=2), 10) == pytest.approx(0.05)
