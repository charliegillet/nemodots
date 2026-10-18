"""Holdout gate: run a playbook on a task set, score it, and decide accept/reject (owner: I3).

Choices made where the plan is silent:

* ``ratchet.verify.run_hidden_tests`` is imported lazily (module attribute ``run_hidden_tests`` below is
  a thin wrapper) so this module imports without the runtime package; unit tests monkeypatch
  ``ratchet.gate.run_hidden_tests``.
* ``evaluate`` takes two optional keyword-only extras: ``skip_existing`` (reuse a saved ``result.json``
  for a (task, repeat) instead of re-running it; used to resume a crashed gate) and ``sandbox`` (passed
  through to verification).
* ``RunResult.usage`` is the transcript's usage; if the worker reported zero requests (e.g. a host that
  does not count tokens) the ledger total for the run's tag is used instead.
* A (task, repeat) that is (re)run starts from an empty run_dir (leftovers of an interrupted attempt are
  removed first).
* A worker or verifier exception becomes a failed ``RunResult`` (stop_reason ``"error"``) and a minimal
  Transcript carrying the error is saved, so the reviewer and report can still see what happened.
* Ctrl-C / SIGTERM while runs are in flight: the queue is dropped, ``ratchet.interrupt.STOP`` is set and
  the gate waits for the in-flight runs, which stop before their next model call. A run that stopped this
  way (or that had not been verified when the stop came) is discarded, not saved as a scored failure, and
  its run_dir is removed; the next ``ratchet run`` re-runs it. Only then does the interrupt propagate, so
  the caller's cleanup (live flag, report) happens after the last worker thread is done and no thread can
  write into runs/ after the process has said it stopped.
"""
from __future__ import annotations

import contextlib
import logging
import shutil
import signal
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterator

from ratchet import interrupt
from ratchet.config import Settings
from ratchet.sandbox import SandboxUnavailable
from ratchet.types import GateDecision, RunResult, Task, Transcript, Usage, VerifyResult, utcnow

if TYPE_CHECKING:  # pragma: no cover
    from ratchet.store import Store
    from ratchet.types import Worker

log = logging.getLogger("ratchet.gate")

EPS = 1e-9


def seed_for(task_id: str, repeat: int) -> int:
    return (zlib.crc32(task_id.encode()) + repeat) % 2**31


def run_hidden_tests(task: Task, workspace_files: dict[str, str], settings: Settings, run_dir: Path,
                     sandbox: Any = None) -> VerifyResult:
    """Indirection to ratchet.verify.run_hidden_tests (lazy import; patchable in tests)."""
    from ratchet.verify import run_hidden_tests as _impl

    return _impl(task, workspace_files, settings, run_dir, sandbox=sandbox)


def _ledger_total(ledger: Any, prefix: str) -> Usage:
    if ledger is None:
        return Usage()
    try:
        u = ledger.total(prefix)
        return u if isinstance(u, Usage) else Usage()
    except Exception:  # noqa: BLE001 - the ledger is best-effort accounting
        return Usage()


def _error_transcript(task: Task, worker_name: str, settings: Settings, version: int, repeat: int,
                      started: str, error: str) -> Transcript:
    return Transcript(
        task_id=task.task_id, worker=worker_name, model=settings.worker_model, version=version, repeat=repeat,
        started_at=started, finished_at=utcnow(), messages=[], steps=[], final_answer="", stop_reason="error",
        usage=Usage(), error=error[:500],
    )


def evaluate(tasks: list[Task], playbook: str, *, version: int, split: str, repeats: int, worker: "Worker",
             settings: Settings, store: "Store", ledger: Any,
             progress: Callable[[RunResult], None] | None = None,
             skip_existing: bool = False, sandbox: Any = None) -> list[RunResult]:
    """Run every (task, repeat) with `playbook`, verify with hidden tests, save, and return results
    sorted by (task_id, repeat)."""
    pairs = [(t, r) for t in sorted(tasks, key=lambda t: t.task_id) for r in range(repeats)]
    results: list[RunResult] = []
    progress_lock = threading.Lock()
    worker_name = getattr(worker, "name", "local")

    def report(res: RunResult) -> None:
        if progress is None:
            return
        with progress_lock:
            try:
                progress(res)
            except Exception:  # noqa: BLE001 - a broken progress printer must not kill the gate
                log.exception("progress callback failed")

    def one(task: Task, repeat: int) -> RunResult:
        run_dir = store.run_dir(version, split, task.task_id, repeat)
        tag = f"v{version}:{split}:{task.task_id}:r{repeat}"
        t0 = time.monotonic()
        started = utcnow()
        if run_dir.exists():  # leftovers of an interrupted attempt must not leak into this run's workspace
            shutil.rmtree(run_dir, ignore_errors=True)
        run_dir.mkdir(parents=True, exist_ok=True)
        try:
            interrupt.check()
            transcript = worker.run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag)
        except interrupt.RunInterrupted:
            transcript = None
        except Exception as exc:  # noqa: BLE001
            log.warning("%s: worker raised %s: %s", tag, type(exc).__name__, exc)
            transcript = _error_transcript(task, worker_name, settings, version, repeat, started,
                                           f"worker exception: {type(exc).__name__}: {exc}")
        if transcript is None or transcript.stop_reason == "interrupted" or interrupt.stop_requested():
            # Stopped by Ctrl-C / SIGTERM: not a scored failure. Leave nothing a resume could pick up.
            shutil.rmtree(run_dir, ignore_errors=True)
            raise interrupt.RunInterrupted(tag)
        try:
            vr = run_hidden_tests(task, transcript.workspace_files, settings, run_dir, sandbox=sandbox)
        except SandboxUnavailable:
            raise  # strict docker mode: fail closed, never score a run without the sandbox
        except Exception as exc:  # noqa: BLE001
            log.warning("%s: verification raised %s: %s", tag, type(exc).__name__, exc)
            vr = VerifyResult(passed=False, exit_code=-1, output=f"verification error: {type(exc).__name__}: {exc}",
                              duration_s=0.0)
        usage = transcript.usage if transcript.usage.requests else _ledger_total(ledger, tag)
        result = RunResult(
            task_id=task.task_id, version=version, repeat=repeat, passed=bool(vr.passed), exit_code=vr.exit_code,
            test_output=(vr.output or "")[:4000], transcript_path=store.rel(run_dir / "transcript.json"),
            usage=usage, duration_s=round(time.monotonic() - t0, 3), stop_reason=transcript.stop_reason,
            worker=transcript.worker or worker_name, split=split, sandbox=_sandbox_label(vr),
        )
        store.save_run(result, transcript)
        return result

    todo: list[tuple[Task, int]] = []
    for task, repeat in pairs:
        prev = store.load_result(version, split, task.task_id, repeat) if skip_existing else None
        if prev is not None:
            results.append(prev)
            report(prev)
        else:
            todo.append((task, repeat))

    if todo:
        interrupt.clear()  # a stop belongs to the gate that was interrupted, never to a later one
        max_workers = max(1, int(settings.max_inflight_per_model))
        pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix=f"ratchet-v{version}-{split}")
        futs: dict[Any, tuple[Task, int]] = {}
        try:
            for t, r in todo:
                futs[pool.submit(one, t, r)] = (t, r)
            for fut in as_completed(futs):
                t, r = futs[fut]
                try:
                    res = fut.result()
                except SandboxUnavailable:
                    raise
                except interrupt.RunInterrupted:  # only after a stop request; nothing to score
                    continue
                except Exception as exc:  # noqa: BLE001 - e.g. the store failed to write
                    log.exception("v%s %s %s r%s: run failed outside the worker", version, split, t.task_id, r)
                    res = RunResult(
                        task_id=t.task_id, version=version, repeat=r, passed=False, exit_code=-1,
                        test_output=f"internal error: {type(exc).__name__}: {exc}"[:4000],
                        transcript_path=store.rel(store.run_dir(version, split, t.task_id, r) / "transcript.json"),
                        usage=Usage(), duration_s=0.0, stop_reason="error", worker=worker_name, split=split,
                    )
                results.append(res)
                report(res)
        except BaseException:
            # Ctrl-C / SIGTERM (or a fail-closed SandboxUnavailable): drop queued runs, ask the in-flight
            # ones to stop before their next model call, and wait for them, so the caller's cleanup (live
            # flag, report) runs after the last worker thread and nothing writes into runs/ afterwards.
            interrupt.request_stop()
            for f in futs:
                f.cancel()
            running = sum(1 for f in futs if not f.done())
            if running:
                log.warning("stopping: waiting for %d in-flight run(s) to finish their current model call; "
                            "they are discarded and re-run on resume (interrupt again to quit at once)", running)
            with _second_interrupt_quits():
                pool.shutdown(wait=True, cancel_futures=True)
            raise
        pool.shutdown(wait=True)
    return sorted(results, key=lambda r: (r.task_id, r.repeat))


@contextlib.contextmanager
def _second_interrupt_quits() -> Iterator[None]:
    """While draining after an interrupt, make a second Ctrl-C / SIGTERM end the process at once (the
    default signal action) instead of raising into the wait. Main thread only; restored afterwards."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    saved: dict[int, Any] = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            saved[sig] = signal.signal(sig, signal.SIG_DFL)
        except (ValueError, OSError):
            pass
    try:
        yield
    finally:
        for sig, handler in saved.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError, TypeError):
                pass


def _sandbox_label(vr: VerifyResult) -> str:
    iso = getattr(vr, "isolation", "") or ""
    if iso == "container" or vr.backend == "docker":
        return "docker"
    if iso == "seatbelt":
        return "seatbelt"
    if iso == "none":
        return "unsandboxed"
    return ""


def per_task_rates(results: list[RunResult]) -> dict[str, float]:
    runs: dict[str, int] = {}
    passed: dict[str, int] = {}
    for r in results:
        runs[r.task_id] = runs.get(r.task_id, 0) + 1
        passed[r.task_id] = passed.get(r.task_id, 0) + (1 if r.passed else 0)
    return {t: passed[t] / runs[t] for t in sorted(runs)}


def score(rates: dict[str, float]) -> float:
    if not rates:
        return 0.0
    return sum(rates.values()) / len(rates)


def default_min_delta(n_tasks: int, repeats: int) -> float:
    if n_tasks <= 0 or repeats <= 0:
        return 0.0
    return 1.0 / (n_tasks * repeats)


def _pct(x: float) -> str:
    return f"{x * 100:+.1f}%"


def decide(incumbent: dict[str, float], candidate: dict[str, float], *, min_delta: float) -> GateDecision:
    tasks = sorted(incumbent)
    inc = {t: float(incumbent[t]) for t in tasks}
    cand = {t: float(candidate.get(t, 0.0)) for t in tasks}
    regressions = [t for t in tasks if cand[t] < inc[t] - EPS]
    improvements = [t for t in tasks if cand[t] > inc[t] + EPS]
    s_inc, s_cand = score(inc), score(cand)
    delta = s_cand - s_inc
    accepted = (not regressions) and delta > EPS and delta >= min_delta - EPS
    if regressions:
        reason = "rejected: regressed " + ", ".join(regressions)
        if delta > EPS:
            reason += f" (despite {_pct(delta)} overall)"
    elif delta <= EPS:
        reason = f"rejected: no improvement ({s_inc:.3f} -> {s_cand:.3f})"
    elif not accepted:
        reason = f"rejected: {_pct(delta)} below margin {min_delta * 100:.1f}%"
    else:
        reason = (f"accepted: {_pct(delta)} ({s_inc:.3f} -> {s_cand:.3f}), "
                  f"{len(improvements)} improved, {len(regressions)} regressed")
    return GateDecision(
        accepted=accepted, reason=reason, incumbent_score=s_inc, candidate_score=s_cand, delta=delta,
        min_delta=min_delta, regressions=regressions, improvements=improvements,
    )
