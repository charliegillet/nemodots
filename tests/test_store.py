"""Unit tests for ratchet.store (offline)."""
from __future__ import annotations

import json

import pytest

from ratchet.config import SMOKE
from ratchet.store import Store
from ratchet.types import PlaybookEdit, RunResult, ToolStep, Transcript, Usage


def _store(settings) -> Store:
    return Store(settings.runs_dir)


def _init(store: Store):
    return store.init("# Playbook\n\nDo the task.\n", config=SMOKE, worker="local",
                      holdout_ids=["h1", "h2"], train_ids=["t1"])


def _transcript(task_id="h1", version=0, repeat=0) -> Transcript:
    return Transcript(task_id=task_id, worker="local", model="m", version=version, repeat=repeat,
                      started_at="2026-10-17T00:00:00.000Z", finished_at="2026-10-17T00:00:01.000Z",
                      messages=[{"role": "system", "content": "x"}],
                      steps=[ToolStep(step=1, tool="submit", arguments={"summary": "ok"}, result="submitted")],
                      final_answer="", stop_reason="done", usage=Usage(requests=1, prompt_tokens=10),
                      workspace_files={"solution.py": "x = 1\n"})


def test_init_creates_v0_and_history(settings):
    store = _store(settings)
    assert not store.exists()
    rec = _init(store)
    assert store.exists()
    assert rec.version == 0 and rec.status == "candidate" and rec.holdout_score == -1.0
    doc = store.load_history()
    assert doc["schema"] == 1
    assert doc["holdout_task_ids"] == ["h1", "h2"] and doc["train_task_ids"] == ["t1"]
    assert doc["config"]["name"] == "smoke"
    assert doc["incumbent"] is None and doc["rounds_completed"] == 0
    assert len(doc["versions"]) == 1
    assert store.playbook(0).startswith("# Playbook")
    assert rec.playbook_path == "runs/versions/v0/playbook.md"
    assert (store.version_dir(0) / "record.json").exists()
    with pytest.raises(FileExistsError):
        _init(store)
    with pytest.raises(LookupError):
        store.incumbent()


def test_create_version_writes_files_and_set_incumbent_flips(settings):
    store = _store(settings)
    _init(store)
    store.set_incumbent(0)
    assert store.incumbent().version == 0
    assert store.next_version() == 1
    edit = PlaybookEdit(op="append_section", anchor="", text="## Testing\nWrite tests.", rationale="r", diagnosis="d")
    rec = store.create_version(parent=0, playbook="# Playbook\n\n## Testing\nWrite tests.\n", diff="--- a\n+++ b\n",
                               edit=edit, round=1, worker="local")
    assert rec.version == 1 and rec.status == "candidate" and rec.parent == 0
    vdir = store.version_dir(1)
    for name in ("playbook.md", "diff.patch", "review.json", "record.json"):
        assert (vdir / name).exists(), name
    review = json.loads((vdir / "review.json").read_text())
    assert review["op"] == "append_section" and review["schema"] == 1
    assert rec.diff_path == "runs/versions/v1/diff.patch"
    assert store.diff_text(1).startswith("--- a")
    assert rec.rationale == "r" and rec.diagnosis == "d" and rec.incumbent_version == 0

    store.set_incumbent(1)
    statuses = {r.version: r.status for r in store.versions()}
    assert statuses == {0: "superseded", 1: "incumbent"}
    assert store.load_history()["incumbent"] == 1
    assert json.loads((store.version_dir(0) / "record.json").read_text())["status"] == "superseded"

    rec2 = store.create_version(parent=1, playbook="# P2\n", diff="", edit=edit, round=2, worker="local")
    rec2.status = "rejected"
    rec2.gate_reason = "rejected: no improvement"
    store.update(rec2)
    assert store.get(2).status == "rejected"
    assert store.incumbent().version == 1
    assert [r.version for r in store.versions()] == [0, 1, 2]


def test_save_run_load_runs_round_trip(settings):
    store = _store(settings)
    _init(store)
    for task_id, repeat in (("h2", 0), ("h1", 1), ("h1", 0)):
        rd = store.run_dir(0, "holdout", task_id, repeat)
        res = RunResult(task_id=task_id, version=0, repeat=repeat, passed=repeat == 0, exit_code=0 if repeat == 0 else 1,
                        test_output="ok", transcript_path=store.rel(rd / "transcript.json"),
                        usage=Usage(requests=2, prompt_tokens=5), duration_s=1.5, stop_reason="done", split="holdout")
        store.save_run(res, _transcript(task_id, 0, repeat))
    runs = store.load_runs(0, "holdout")
    assert [(r.task_id, r.repeat) for r in runs] == [("h1", 0), ("h1", 1), ("h2", 0)]
    assert runs[0].usage.prompt_tokens == 5 and runs[0].passed
    assert runs[0].transcript_path == "runs/versions/v0/holdout/h1/r0/transcript.json"
    tr = store.load_transcript(runs[0])
    assert tr.steps[0].tool == "submit" and tr.workspace_files["solution.py"] == "x = 1\n"
    assert store.load_runs(0, "train") == []
    assert store.load_result(0, "holdout", "h1", 1).repeat == 1
    assert store.load_result(0, "holdout", "nope", 0) is None
    # no temp files left behind by atomic writes
    assert not list(store.runs_dir.rglob("*.tmp"))


def test_reset_keeps_bench_cache_and_ledger(settings):
    store = _store(settings)
    _init(store)
    (store.runs_dir / "bench_check.json").write_text("{}")
    (store.runs_dir / "llm_calls.jsonl").write_text("")
    (store.runs_dir / "report.html").write_text("x")
    store.reset()
    assert not store.exists() and not store.versions_dir.exists()
    assert not (store.runs_dir / "report.html").exists()
    assert (store.runs_dir / "bench_check.json").exists() and (store.runs_dir / "llm_calls.jsonl").exists()


def test_live_and_rounds_flags(settings):
    store = _store(settings)
    store.set_live(True)  # no history: no-op, no crash
    _init(store)
    store.set_live(True)
    store.set_rounds_completed(3)
    doc = store.load_history()
    assert doc["live"] is True and doc["rounds_completed"] == 3
