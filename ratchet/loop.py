"""The Ratchet loop: train -> review -> candidate -> holdout gate (owner: I3).

One round (``run_round``):

1. Run the incumbent playbook on the train tasks (results are reused if they already exist).
2. Pick failed train runs (first repeat per task, most steps first, up to ``max_failures_to_reviewer``).
3. Ask the reviewer for ONE playbook edit (previously rejected edits of this incumbent are shown).
4. Store the candidate version (playbook + diff + review) and run it on the sealed holdout.
5. ``gate.decide`` against the incumbent's stored per-task pass rates; accept -> new incumbent,
   otherwise rejected (rolled back: the incumbent simply stays).

Choices made where the plan is silent:

* Usage accounting: a record's ``usage_by_phase`` holds ``"holdout"`` (its own gate runs), ``"review"``
  (the reviewer call(s) that created it) and ``"train"`` (train runs of that playbook, which feed the
  reviewer for the next version). ``usage`` is their sum; ``usage_by_model`` attributes train/holdout to
  ``settings.worker_model`` and review to ``settings.reviewer_model``. Usage comes from RunResults and
  from ``propose_edit(usage_out=...)``, so it is correct with any LLM/worker, with or without a ledger.
* ``run_loop(rounds=N)`` runs N more rounds on top of ``history["rounds_completed"]`` (resume adds rounds).
* Resume: ``evaluate`` is called with ``skip_existing=True`` everywhere, so a crashed gate continues
  where it stopped. A leftover ``"candidate"`` whose parent is still the incumbent is gated first; one
  whose parent was superseded is marked ``"failed"``.
* With no failed train runs and ``stop_when_train_clean=False`` the reviewer is still called (with an
  empty failure list) so SMOKE always produces a v1.
* With ``stop_when_train_clean=True`` a clean train set first gets one fresh pass (the next repeat index,
  r1, r2, ...); only if that is clean too does the round stop with ``stopped="train_clean"``. A later
  resume reuses every stored pass and draws another fresh one, so the loop never freezes on cached
  clean results.
* A reviewer failure stops the loop with ``stopped="reviewer_failed"`` and creates no version.
* ``worker.reset()`` is called once when ``run_loop`` ends (also on error).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ratchet.config import LoopConfig, Settings
from ratchet.gate import decide, default_min_delta, evaluate, per_task_rates, score
from ratchet.report import write_report
from ratchet.reviewer import ReviewerError, propose_edit, summarize_failure, unified_diff
from ratchet.store import Store
from ratchet.types import GateDecision, RunResult, Task, Transcript, Usage, VersionRecord, sum_usage

log = logging.getLogger("ratchet.loop")


@dataclass
class RoundOutcome:
    round: int
    candidate: VersionRecord | None
    decision: GateDecision | None
    stopped: str | None          # None | "train_clean" | "reviewer_failed"


def _refresh_usage(rec: VersionRecord, settings: Settings) -> None:
    rec.usage = sum_usage(list(rec.usage_by_phase.values()))
    by_model: dict[str, Usage] = {}
    for phase, u in rec.usage_by_phase.items():
        model = settings.reviewer_model if phase == "review" else settings.worker_model
        by_model[model] = by_model.get(model, Usage()) + u
    rec.usage_by_model = by_model


def _safe_report(store: Store) -> None:
    try:
        write_report(store)
    except Exception:  # noqa: BLE001 - the report must never break the loop
        log.exception("writing the report failed")


def _min_delta(config: LoopConfig, n_holdout: int) -> float:
    return config.min_delta if config.min_delta is not None else default_min_delta(n_holdout, config.repeats)


def reviewer_safe_reason(rec: VersionRecord) -> str:
    """A rejected version's gate reason with no holdout task ids (built from counts and scores)."""
    d = float(rec.delta or 0.0)
    delta = f"{d * 100:+.1f}%"
    if rec.regressions:
        n = len(rec.regressions)
        return (f"rejected: regressed {n} sealed holdout task{'s' if n != 1 else ''} "
                f"({delta} overall, {len(rec.improvements)} improved)")
    if d <= 1e-9:
        return f"rejected: no improvement on the sealed holdout ({delta} overall)"
    return f"rejected: {delta} on the sealed holdout, below the acceptance margin"


def bootstrap(store: Store, settings: Settings, config: LoopConfig, worker: Any, llm: Any, ledger: Any, *,
              playbook_path: Path, holdout: list[Task], train: list[Task],
              progress: Callable[[RunResult], None] | None = None) -> VersionRecord:
    """Create v0 if needed, evaluate it on the holdout once, make it the incumbent; return the incumbent."""
    holdout_ids = sorted(t.task_id for t in holdout)
    if not store.exists():
        store.init(Path(playbook_path).read_text(encoding="utf-8"), config=config, worker=getattr(worker, "name", "local"),
                   holdout_ids=holdout_ids, train_ids=sorted(t.task_id for t in train))
        log.info("initialized %s with v0 from %s", store.history_path, playbook_path)
    else:
        stored = sorted(store.load_history().get("holdout_task_ids", []))
        if stored != holdout_ids:
            raise ValueError("the holdout set differs from the one in history.json "
                             f"({len(stored)} stored vs {len(holdout_ids)} given); resume with the same tasks or use --fresh")
    rec = store.get(0)
    if rec.holdout_score < 0:
        t0 = time.monotonic()
        log.info("bootstrap: evaluating v0 on %d holdout tasks x %d repeats", len(holdout), config.repeats)
        results = evaluate(holdout, store.playbook(0), version=0, split="holdout", repeats=config.repeats,
                           worker=worker, settings=settings, store=store, ledger=ledger, progress=progress,
                           skip_existing=True)
        rates = per_task_rates(results)
        rec.per_task = rates
        rec.holdout_score = score(rates)
        rec.repeats = config.repeats
        rec.usage_by_phase["holdout"] = sum_usage([r.usage for r in results])
        _refresh_usage(rec, settings)
        rec.gate_reason = f"seed: holdout score {rec.holdout_score:.3f}"
        rec.duration_s = round(rec.duration_s + time.monotonic() - t0, 3)
        rec.status = "incumbent"
        store.update(rec)
        store.set_incumbent(0)
        _safe_report(store)
    else:
        try:
            store.incumbent()
        except LookupError:
            store.set_incumbent(0)
    return store.incumbent()


def _gate(cand: VersionRecord, inc: VersionRecord, *, store: Store, settings: Settings, config: LoopConfig,
          worker: Any, ledger: Any, holdout: list[Task], progress: Callable[[RunResult], None] | None,
          t_start: float) -> GateDecision:
    results = evaluate(holdout, store.playbook(cand.version), version=cand.version, split="holdout",
                       repeats=config.repeats, worker=worker, settings=settings, store=store, ledger=ledger,
                       progress=progress, skip_existing=True)
    rates = per_task_rates(results)
    decision = decide(inc.per_task, rates, min_delta=_min_delta(config, len(holdout)))
    cand.per_task = rates
    cand.holdout_score = score(rates)
    cand.repeats = config.repeats
    cand.incumbent_version = inc.version
    cand.incumbent_score = inc.holdout_score
    cand.delta = decision.delta
    cand.regressions = decision.regressions
    cand.improvements = decision.improvements
    cand.gate_reason = decision.reason
    cand.usage_by_phase["holdout"] = sum_usage([r.usage for r in results])
    _refresh_usage(cand, settings)
    cand.duration_s = round(cand.duration_s + time.monotonic() - t_start, 3)
    if decision.accepted:
        cand.status = "accepted"
        store.update(cand)
        store.set_incumbent(cand.version)
        cand.status = "incumbent"
    else:
        cand.status = "rejected"
        store.update(cand)
    log.info("gate v%d vs v%d: %s", cand.version, inc.version, decision.reason)
    return decision


def _pick_failures(store: Store, results: list[RunResult], limit: int) -> list[tuple[RunResult, Transcript]]:
    first: dict[str, RunResult] = {}
    for r in sorted(results, key=lambda r: (r.task_id, r.repeat)):
        if not r.passed and r.task_id not in first:
            first[r.task_id] = r
    picked: list[tuple[RunResult, Transcript]] = []
    for r in first.values():
        try:
            tr = store.load_transcript(r)
        except Exception as exc:  # noqa: BLE001
            log.warning("could not load transcript for %s r%d: %s", r.task_id, r.repeat, exc)
            tr = Transcript(task_id=r.task_id, worker=r.worker, model="", version=r.version, repeat=r.repeat,
                            started_at="", finished_at="", messages=[], steps=[], final_answer="",
                            stop_reason=r.stop_reason, usage=r.usage)
        picked.append((r, tr))
    picked.sort(key=lambda p: (-len(p[1].steps), p[0].task_id))
    return picked[: max(0, limit)]


def run_round(round_no: int, *, store: Store, settings: Settings, config: LoopConfig, worker: Any, llm: Any,
              ledger: Any, holdout: list[Task], train: list[Task],
              progress: Callable[[RunResult], None] | None = None) -> RoundOutcome:
    inc = store.incumbent()
    inc_playbook = store.playbook(inc.version)

    # 1. train runs of the incumbent (reused when present, including fresh passes added by earlier rounds)
    train_tasks = sorted(train, key=lambda t: t.task_id)
    if config.train_size:
        train_tasks = train_tasks[: config.train_size]
    train_ids = {t.task_id for t in train_tasks}
    existing = [r for r in store.load_runs(inc.version, "train") if r.task_id in train_ids]
    have = len(existing)
    repeats = max(max(1, config.train_repeats), 1 + max((r.repeat for r in existing), default=-1))
    t0 = time.monotonic()

    def run_train(n: int) -> list[RunResult]:
        return evaluate(train_tasks, inc_playbook, version=inc.version, split="train", repeats=n, worker=worker,
                        settings=settings, store=store, ledger=ledger, progress=progress, skip_existing=True)

    train_results = run_train(repeats)
    picked = _pick_failures(store, train_results, config.max_failures_to_reviewer)
    if not picked and config.stop_when_train_clean and train_tasks:
        # Clean on the stored passes: draw one fresh pass (new repeat index) before giving up, so a resumed
        # loop never stops forever on the same cached clean results.
        log.info("round %d: incumbent v%d passed all %d stored train runs; running a fresh train pass (r%d)",
                 round_no, inc.version, len(train_results), repeats)
        repeats += 1
        train_results = run_train(repeats)
        picked = _pick_failures(store, train_results, config.max_failures_to_reviewer)
    inc.usage_by_phase["train"] = sum_usage([r.usage for r in train_results])
    _refresh_usage(inc, settings)
    if len(train_results) > have:
        inc.duration_s = round(inc.duration_s + time.monotonic() - t0, 3)
    store.update(inc)

    # 2. failures
    passed = sum(1 for r in train_results if r.passed)
    log.info("round %d: incumbent v%d train %d/%d passed", round_no, inc.version, passed, len(train_results))
    if not picked and config.stop_when_train_clean:
        log.info("round %d: incumbent passes every train run (%d pass%s); stopping", round_no, repeats,
                 "" if repeats == 1 else "es")
        return RoundOutcome(round=round_no, candidate=None, decision=None, stopped="train_clean")
    by_id = {t.task_id: t for t in train}
    failures = [summarize_failure(by_id[r.task_id], r, tr) for r, tr in picked if r.task_id in by_id]

    # 3. previously rejected edits of this incumbent
    #    The reviewer never sees the sealed holdout, so it gets a redacted reason (counts and scores only);
    #    the full reason with the regressed task ids stays in history.json and the report.
    rejected = [(store.diff_text(v.version), reviewer_safe_reason(v)) for v in store.versions()
                if v.parent == inc.version and v.status == "rejected"]

    # 4. reviewer
    version = store.next_version()
    t_review = time.monotonic()
    usage_out: list[Usage] = []
    try:
        edit, new_playbook = propose_edit(llm, inc_playbook, failures, settings=settings, holdout_tasks=holdout,
                                          rejected=rejected, tag=f"v{version}:review", usage_out=usage_out)
    except ReviewerError as exc:
        log.warning("round %d: %s", round_no, exc)
        return RoundOutcome(round=round_no, candidate=None, decision=None, stopped="reviewer_failed")

    # 5. candidate version
    diff = unified_diff(inc_playbook, new_playbook, old_name=f"v{inc.version}/playbook.md",
                        new_name=f"v{version}/playbook.md")
    cand = store.create_version(parent=inc.version, playbook=new_playbook, diff=diff, edit=edit, round=round_no,
                                worker=getattr(worker, "name", "local"))
    cand.usage_by_phase["review"] = sum_usage(usage_out)
    _refresh_usage(cand, settings)
    store.update(cand)
    _safe_report(store)
    log.info("round %d: candidate v%d (%s %r): %s", round_no, cand.version, edit.op, edit.anchor, edit.rationale)

    # 6-9. gate
    decision = _gate(cand, inc, store=store, settings=settings, config=config, worker=worker, ledger=ledger,
                     holdout=holdout, progress=progress, t_start=t_review)
    doc = store.load_history()
    store.set_rounds_completed(max(int(doc.get("rounds_completed", 0)), round_no))
    _safe_report(store)
    return RoundOutcome(round=round_no, candidate=store.get(cand.version), decision=decision, stopped=None)


def resume_pending(*, store: Store, settings: Settings, config: LoopConfig, worker: Any, ledger: Any,
                   holdout: list[Task], progress: Callable[[RunResult], None] | None = None) -> list[RoundOutcome]:
    """Finish gates interrupted by a crash (status still "candidate")."""
    outcomes: list[RoundOutcome] = []
    for rec in store.versions():
        if rec.version == 0 or rec.status != "candidate":
            continue
        inc = store.incumbent()
        if rec.parent != inc.version:
            rec.status = "failed"
            rec.gate_reason = f"abandoned: parent v{rec.parent} is no longer the incumbent (v{inc.version})"
            store.update(rec)
            continue
        log.info("resuming the interrupted gate of v%d", rec.version)
        decision = _gate(rec, inc, store=store, settings=settings, config=config, worker=worker, ledger=ledger,
                         holdout=holdout, progress=progress, t_start=time.monotonic())
        outcomes.append(RoundOutcome(round=rec.round, candidate=store.get(rec.version), decision=decision, stopped=None))
        doc = store.load_history()
        store.set_rounds_completed(max(int(doc.get("rounds_completed", 0)), rec.round))
        _safe_report(store)
    return outcomes


def run_loop(*, rounds: int, store: Store, settings: Settings, config: LoopConfig, worker: Any, llm: Any,
             ledger: Any, playbook_path: Path, holdout: list[Task], train: list[Task],
             progress: Callable[[RunResult], None] | None = None,
             on_round: Callable[[RoundOutcome], None] | None = None) -> list[RoundOutcome]:
    """bootstrap + `rounds` more rounds; stops early when a round reports `stopped`."""
    outcomes: list[RoundOutcome] = []
    try:
        bootstrap(store, settings, config, worker, llm, ledger, playbook_path=playbook_path, holdout=holdout,
                  train=train, progress=progress)
        for out in resume_pending(store=store, settings=settings, config=config, worker=worker, ledger=ledger,
                                  holdout=holdout, progress=progress):
            outcomes.append(out)
            if on_round:
                on_round(out)
        start = int(store.load_history().get("rounds_completed", 0))
        for i in range(1, max(0, rounds) + 1):
            out = run_round(start + i, store=store, settings=settings, config=config, worker=worker, llm=llm,
                            ledger=ledger, holdout=holdout, train=train, progress=progress)
            outcomes.append(out)
            if on_round:
                on_round(out)
            if out.stopped:
                break
    finally:
        try:
            worker.reset()
        except Exception:  # noqa: BLE001
            log.exception("worker.reset() failed")
    return outcomes


__all__ = ["RoundOutcome", "bootstrap", "run_round", "run_loop", "resume_pending", "reviewer_safe_reason"]
