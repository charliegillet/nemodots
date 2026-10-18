"""Unit tests for ratchet.report (offline)."""
from __future__ import annotations

import json

from ratchet.config import SMOKE
from ratchet.report import render_report, write_report
from ratchet.store import Store
from ratchet.types import PlaybookEdit, Usage, VersionRecord


def rec(version, status, score, parent=None, cached=False, inc_score=None, reason="") -> dict:
    u = Usage(requests=10, prompt_tokens=5000, completion_tokens=500, cached_tokens=1200 if cached else 0,
              cached_reported=cached, cost_usd=0.0123)
    return VersionRecord(
        version=version, parent=parent, status=status, round=version, created_at="2026-10-17T00:00:00.000Z",
        playbook_path=f"runs/versions/v{version}/playbook.md",
        diff_path=None if version == 0 else f"runs/versions/v{version}/diff.patch",
        rationale=f"rationale {version} <b>", diagnosis="diag", holdout_score=score,
        per_task={"t11_add_months": score, "t12_human_size": 1.0} if score >= 0 else {}, repeats=2,
        incumbent_version=parent, incumbent_score=inc_score, delta=None if inc_score is None else score - inc_score,
        regressions=[], improvements=[], gate_reason=reason, usage=u,
        usage_by_phase={"holdout": u}, usage_by_model={"m": u},
    ).to_dict()


def history(versions, incumbent=None, live=False) -> dict:
    return {"schema": 1, "updated_at": "now", "config": {"name": "demo", "repeats": 2, "min_delta": 0.05},
            "worker": "local", "holdout_task_ids": ["t11_add_months", "t12_human_size"], "train_task_ids": [],
            "incumbent": incumbent, "rounds_completed": len(versions) - 1, "live": live, "versions": versions}


def assert_self_contained(html: str) -> None:
    assert "<script src" not in html and "<link" not in html and "https://" not in html
    assert html.startswith("<!doctype html>")


def test_render_empty_history():
    html = render_report({})
    assert_self_contained(html)
    assert "<svg" in html and "No versions yet" in html
    html2 = render_report(history([]))
    assert_self_contained(html2)


def test_render_v0_only():
    html = render_report(history([rec(0, "incumbent", 0.5)], incumbent=0))
    assert_self_contained(html)
    assert "Ratchet — playbook v0" in html and "v0" in html and "50.0%" in html
    assert "n/a" in html  # cache not reported
    assert "rejected candidate" in html  # rejected legend always shown
    assert "http-equiv" not in html


def test_render_mixed_history_with_artifacts_and_calls():
    vs = [rec(0, "superseded", 0.25), rec(1, "rejected", 0.25, parent=0, inc_score=0.25, reason="rejected: no improvement"),
          rec(2, "incumbent", 0.75, parent=0, cached=True, inc_score=0.25, reason="accepted: +50.0%"),
          rec(3, "candidate", -1.0, parent=2)]
    arts = {2: {"diff": "--- v0/playbook.md\n+++ v2/playbook.md\n@@ -1 +1,2 @@\n ctx\n+## Testing\n-old\n",
                "playbook": "# Playbook\n## Testing\n", "diff_href": "versions/v2/diff.patch"}}
    calls = [{"model": "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B", "prompt_tokens": 2330, "completion_tokens": 10,
              "cached_tokens": 2304, "cached_reported": True, "cost_usd": 0.001, "latency_ms": 900, "tag": "v2:review"},
             {"model": "nvidia/Nemotron-3.5-Lightning-30B-A3B", "prompt_tokens": 100, "completion_tokens": 5,
              "cached_tokens": 0, "cached_reported": False, "cost_usd": 0.00001, "latency_ms": 300, "tag": "ping"}]
    html = render_report(history(vs, incumbent=2, live=True), llm_calls=calls, artifacts=arts, now="NOW")
    assert_self_contained(html)
    for v in ("v0", "v1", "v2", "v3"):
        assert v in html
    assert '<meta http-equiv="refresh" content="20">' in html and "LIVE" in html
    assert 'class="add">+## Testing' in html and 'class="del">-old' in html
    assert 'href="versions/v2/diff.patch"' in html
    assert "rationale 1 &lt;b&gt;" in html and "<b>\"" not in html  # escaped
    assert "1,200" in html and "n/a" in html  # cached reported for v2, not for others
    assert "Crusoe usage by model" in html and "2,304 (99%)" in html
    assert "evaluating" in html and "+50.0%" in html
    assert "1/2" in html or "2/2" in html  # per-task grid cells
    assert "generated NOW" in html


def test_render_rejected_only_history():
    vs = [rec(0, "incumbent", 0.5), rec(1, "rejected", 0.25, parent=0, inc_score=0.5, reason="rejected: regressed t11_add_months")]
    html = render_report(history(vs, incumbent=0), artifacts={1: {"diff": "+x\n"}, 0: {"playbook": "# P\n"}})
    assert_self_contained(html)
    assert "No edit has been accepted yet" in html and "Most recent rejected diff (v1)" in html
    assert "stroke-dasharray" in html


def test_write_report_from_store(settings):
    store = Store(settings.runs_dir)
    out = write_report(store)
    assert out == store.runs_dir / "report.html" and out.exists()
    store.init("# P\n", config=SMOKE, worker="local", holdout_ids=["h1"], train_ids=[])
    store.set_incumbent(0)
    store.create_version(parent=0, playbook="# P\n## T\nx\n", diff="--- a\n+++ b\n+## T\n",
                         edit=PlaybookEdit(op="append_section", anchor="", text="## T\nx", rationale="r"), round=1,
                         worker="local")
    (store.runs_dir / "llm_calls.jsonl").write_text(json.dumps({"model": "m", "cost_usd": 0.5}) + "\nnot json\n")
    out = write_report(store)
    html = out.read_text()
    assert_self_contained(html)
    assert 'href="versions/v1/diff.patch"' in html and "$0.5000" in html
    custom = write_report(store, settings.runs_dir / "sub" / "r.html")
    assert 'href="../versions/v1/diff.patch"' in custom.read_text()


def test_cost_tile_counts_only_this_history():
    v0 = rec(0, "incumbent", 0.5)
    v0["created_at"] = "2026-10-17T10:00:00.000Z"
    calls = [
        {"model": "m", "cost_usd": 1.0, "tag": "v0:holdout:t1:r0", "ts": "2026-10-17T09:00:00.000Z"},   # aborted run
        {"model": "m", "cost_usd": 0.5, "tag": "bench-check:t1", "ts": "2026-10-17T08:00:00.000Z"},
        {"model": "m", "cost_usd": 0.25, "tag": "v0:holdout:t1:r0", "ts": "2026-10-17T10:00:01.000Z"},
    ]
    html = render_report(history([v0], incumbent=0), llm_calls=calls)
    assert "Cost (all Crusoe calls, this history)" in html
    assert "$0.2500" in html and "1 calls since v0" in html
    assert "test-the-tests $0.5000" in html and "ledger total $1.7500" in html


def test_sandbox_note_in_header():
    html = render_report(history([rec(0, "incumbent", 0.5)], incumbent=0),
                         sandbox_counts={"docker": 4, "unsandboxed": 1})
    assert "hidden tests ran in: docker, network off 4, UNSANDBOXED 1" in html


def test_cached_tokens_are_shown_per_model():
    from ratchet.report import _cached_cell, cached_summary

    lightning, super_ = "nvidia/Nemotron-3.5-Lightning-30B-A3B", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"
    by_model = {lightning: Usage(requests=500, prompt_tokens=1_900_000, completion_tokens=50_000),
                super_: Usage(requests=1, prompt_tokens=2880, completion_tokens=500, cached_tokens=2304,
                              cached_reported=True)}
    total = by_model[lightning] + by_model[super_]
    assert total.cached_reported                     # the summed total alone would read "0% cached"
    v = {"version": 1, "usage": total.to_dict() if hasattr(total, "to_dict") else vars(total),
         "usage_by_model": {k: (u.to_dict() if hasattr(u, "to_dict") else vars(u)) for k, u in by_model.items()}}
    cached, html = _cached_cell(v, total)
    assert cached == 2304
    assert "2,304 of 2,880 (80%)" in html and "NVIDIA-Nemotron-3-Super-120B-A12B" in html
    assert "n/a: Nemotron-3.5-Lightning-30B-A3B" in html
    text = cached_summary(by_model)
    assert "2,304 of 2,880 cached on NVIDIA-Nemotron-3-Super-120B-A12B" in text
    assert "not reported by Nemotron-3.5-Lightning-30B-A3B" in text
