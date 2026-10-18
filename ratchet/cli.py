"""Command line interface: ``python -m ratchet <command>`` (owner: I3).

Commands: bench-check, run, report, ping, show, eval (see docs/PLAN.md section 5.3).
Exit codes: 0 ok; 1 unexpected error (traceback in runs/loop.log); 2 usage/configuration;
3 worker unavailable; 4 bench-check found weak or broken tasks; 130 interrupted.

Choices made where the plan is silent:

* Modules owned by other implementers (llm, worker, bench, mutate, workers.openbot_worker) are imported
  lazily inside the commands, so ``report``/``show`` work without them and tests can stub the
  ``_build_*``/``_select_tasks`` helpers.
* ``run`` resumes by default: with an existing history the holdout/train task ids stored in
  history.json are reused (the holdout must not change between versions); ``--fresh`` re-selects them.
  ``--rounds N`` means N more rounds in this invocation.
* ``--live`` marks history.json live (report auto-refreshes every 20 s, ``live_pid`` records the process)
  and clears the flag on exit. SIGTERM (``kill <pid>``) is turned into an interrupt so that cleanup runs
  (exit 143): the gate first waits for in-flight runs to stop at their next model call (they are
  discarded, not scored; a second SIGTERM / Ctrl-C quits at once), then the live flag is cleared and the
  report written. ``report`` clears a live flag whose process is gone.
* Resuming refuses (exit 2) when ``--config`` / ``--holdout`` / ``--train`` / ``--repeats`` /
  ``--min-delta`` disagree with the stored history; without ``--config`` a resume uses the stored config
  name. A resume prints how many rounds are already done and which rounds this invocation will run.
* ``run``, ``eval`` and ``bench-check`` refuse (exit 2) while another live Ratchet run is alive (the
  ``live_pid`` in ``history.json`` of the target runs dir or of the default ``runs/``): each process paces
  the worker model at ``rpm_per_model`` on its own, so two together exceed Crusoe's 30 RPM per-model limit.
  ``--allow-concurrent`` overrides this, except for a second ``run`` on the same runs dir (never allowed).
* ``--openbot-mode agui|stack`` selects OpenBotWorker's mode (default agui).
* ``eval`` writes its runs to ``runs/evals/v<N>-<split>-<timestamp>/`` so it never overwrites the gate
  evidence of a version, and prints recorded vs re-measured per-task pass rates.
* Logging: INFO to stderr, DEBUG to runs/loop.log; the openai/httpx/httpcore loggers are capped at
  WARNING (their DEBUG output contains request bodies).
"""
from __future__ import annotations

import argparse
import dataclasses
import importlib
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any

from ratchet.config import CONFIGS, ROOT, LoopConfig, Settings
from ratchet.gate import evaluate, per_task_rates, score
from ratchet.loop import RoundOutcome, run_loop
from ratchet.report import cached_summary, write_report
from ratchet.store import Store, dump_json
from ratchet.types import RunResult, Task, Usage, sum_usage, utcnow

log = logging.getLogger("ratchet.cli")

EXIT_OK, EXIT_ERROR, EXIT_USAGE, EXIT_WORKER, EXIT_WEAK = 0, 1, 2, 3, 4
DEFAULT_RUNS_DIR = ROOT / "runs"   # checked for a live run even when RATCHET_RUNS_DIR points elsewhere
USABLE_VERDICTS = ("strong", "inconclusive")


class UsageError(Exception):
    """Configuration problem -> exit 2 with a one-line message."""


class Terminated(KeyboardInterrupt):
    """Raised in the main thread by the SIGTERM handler so ``finally`` blocks (live flag, report) run."""


def _on_sigterm(signum: int, frame: Any) -> None:  # noqa: ARG001
    raise Terminated()


def _install_sigterm_handler() -> None:
    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):  # not the main thread (e.g. embedded use): keep the default action
        pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _clear_stale_live(store: Store) -> bool:
    """Clear history["live"] when the process that set it is gone. Returns True if it was cleared."""
    if not store.exists():
        return False
    doc = store.load_history()
    if not doc.get("live"):
        return False
    pid = doc.get("live_pid")
    if not pid:
        pid_file = store.runs_dir / "demo.pid"
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return False  # nothing to check against: leave the flag alone
    if _pid_alive(int(pid)):
        return False
    store.set_live(False)
    return True


def _live_runs(settings: Settings) -> list[tuple[int, Path]]:
    """(pid, runs_dir) of other live Ratchet runs: history.json "live" set and its live_pid alive."""
    found: list[tuple[int, Path]] = []
    seen: set[str] = set()
    for d in (Path(settings.runs_dir), Path(DEFAULT_RUNS_DIR)):
        key = os.path.realpath(str(d))
        if key in seen:
            continue
        seen.add(key)
        try:
            doc = json.loads((d / "history.json").read_text(encoding="utf-8"))
            pid = int(doc.get("live_pid") or 0) if doc.get("live") else 0
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        if pid and pid != os.getpid() and _pid_alive(pid) and _is_ratchet_process(pid):
            found.append((pid, d))
    return found


def _is_ratchet_process(pid: int) -> bool:
    """Best effort: the pid's command line mentions ratchet (guards against a reused pid). True if unknown."""
    try:
        import subprocess

        r = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=5)
    except (OSError, ValueError, subprocess.SubprocessError):
        return True
    if r.returncode != 0:
        return True
    return "ratchet" in r.stdout.lower() or not r.stdout.strip()


def _guard_concurrent(args: argparse.Namespace, settings: Settings, command: str) -> None:
    """Refuse to start model calls while another live run is using the per-model rate limits."""
    same = os.path.realpath(str(settings.runs_dir))
    for pid, d in _live_runs(settings):
        if command == "run" and os.path.realpath(str(d)) == same:
            raise UsageError(f"a live ratchet run (pid {pid}) is already writing {d}; wait for it to finish "
                             f"(or stop it with `kill {pid}`) before running again in the same runs dir")
        if not getattr(args, "allow_concurrent", False):
            raise UsageError(f"a live ratchet run (pid {pid}, {d}) is using the Crusoe per-model rate limits; "
                             f"a second `ratchet {command}` would push both past 30 RPM (429s, slower runs, "
                             f"possible wallclock failures). Wait for it to finish, or pass --allow-concurrent")


# --------------------------------------------------------------------------- helpers (patchable in tests)


def _setup_logging(settings: Settings) -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_ratchet", False):
            root.removeHandler(h)
            h.close()
    root.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    err = logging.StreamHandler(sys.stderr)
    err.setLevel(logging.INFO)
    err.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    err._ratchet = True  # type: ignore[attr-defined]
    root.addHandler(err)
    try:
        settings.runs_dir.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(settings.runs_dir / "loop.log", encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        fh._ratchet = True  # type: ignore[attr-defined]
        root.addHandler(fh)
    except OSError as exc:  # read-only location: keep stderr logging only
        root.warning("cannot write %s/loop.log: %s", settings.runs_dir, exc)
    for name in ("openai", "httpx", "httpx2", "httpcore", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _require_key(settings: Settings) -> None:
    if not settings.crusoe_api_key:
        raise UsageError("CRUSOE_API_KEY is not set in .env")


def _build_ledger(settings: Settings) -> Any:
    from ratchet.llm import UsageLedger

    settings.runs_dir.mkdir(parents=True, exist_ok=True)
    return UsageLedger(settings.runs_dir / "llm_calls.jsonl")


def _build_llm(settings: Settings, ledger: Any) -> Any:
    from ratchet.llm import CrusoeClient

    return CrusoeClient(settings, ledger)


def _refresh_prices(llm: Any) -> None:
    """Live /v1/models pricing (keeps the built-in table on failure). One GET, before real work starts."""
    refresh = getattr(llm, "refresh_prices", None)
    if callable(refresh):
        try:
            refresh()
        except Exception as exc:  # noqa: BLE001
            log.warning("price refresh failed: %s", exc)


def _build_local_worker(settings: Settings, llm: Any) -> Any:
    from ratchet.worker import LocalWorker

    return LocalWorker(llm, settings)


def _build_openbot_worker(settings: Settings, ledger: Any, mode: str) -> tuple[Any | None, str]:
    """(worker, reason); worker is None when unavailable."""
    try:
        mod = importlib.import_module("ratchet.workers.openbot_worker")
        cls = mod.OpenBotWorker
    except Exception as exc:  # noqa: BLE001
        return None, f"openbot worker module not importable ({type(exc).__name__}: {exc})"
    try:
        ok, reason = cls.availability(settings, mode=mode)
    except TypeError:
        ok, reason = cls.availability(settings)
    if not ok:
        return None, reason
    try:
        return cls(settings, mode=mode, ledger=ledger), ""
    except TypeError:
        return cls(settings, mode=mode), ""


def _check_sandbox(settings: Settings) -> str:
    """Resolve the sandbox backend before any model code runs (strict docker mode fails closed here)."""
    from ratchet.sandbox import Sandbox, SandboxUnavailable

    try:
        sb = Sandbox(settings)
        backend = sb.backend
    except SandboxUnavailable as exc:
        raise UsageError(str(exc)) from exc
    if backend == "docker":
        return "docker (network off)"
    return "subprocess + macOS seatbelt (no network, no $HOME)" if sb.seatbelt_available() else "subprocess (UNSANDBOXED)"


def _resolve_worker(args: argparse.Namespace, settings: Settings, llm: Any, ledger: Any) -> Any:
    if getattr(args, "worker", "local") == "openbot":
        worker, reason = _build_openbot_worker(settings, ledger, getattr(args, "openbot_mode", "agui"))
        if worker is not None:
            return worker
        print(f"openbot worker unavailable: {reason}", file=sys.stderr)
        if not getattr(args, "fallback_local", False):
            return None
        print("warning: --fallback-local given: using the local worker instead", file=sys.stderr)
    return _build_local_worker(settings, llm)


def _print_bench_row(r: Any, split: str = "") -> None:
    valid = sum(1 for m in r.mutants if m.valid)
    killed = sum(1 for m in r.mutants if m.valid and m.killed)
    print(f"  {r.task_id:<24} {split:<8} {r.verdict:<13} {killed}/{valid:<6} ${r.usage.cost_usd:.4f}", flush=True)


def _select_tasks(settings: Settings, config: LoopConfig, store: Store, llm: Any,
                  *, resume: bool) -> tuple[list[Task], list[Task]]:
    """Return (holdout, train). Resume -> the ids in history.json; otherwise tasks that passed bench-check
    (running it first when the cache is missing or stale), capped by holdout_size/train_size."""
    from ratchet import bench

    if resume and store.exists():
        doc = store.load_history()
        holdout = [bench.get_task(t) for t in doc.get("holdout_task_ids", [])]
        train = [bench.get_task(t) for t in doc.get("train_task_ids", [])]
        return holdout, train

    from ratchet import mutate

    all_tasks = bench.load_tasks()
    cache = settings.bench_check_path
    cached = mutate.load_bench_check(cache) if cache.exists() else {}
    stale = [t for t in all_tasks
             if t.task_id not in cached or cached[t.task_id].fingerprint != bench.task_fingerprint(t)]
    if stale:
        print(f"bench-check: {len(stale)} task(s) missing from or stale in {cache.name}; checking the test suites "
              f"with {settings.planter_model}", flush=True)
        split_of = {t.task_id: t.split for t in all_tasks}
        mutate.check_bench(all_tasks, llm, settings, cache_path=cache,
                           progress=lambda r: _print_bench_row(r, split_of.get(r.task_id, "")))
    usable = set(mutate.usable_task_ids(cache, all_tasks))
    excluded = sorted(t.task_id for t in all_tasks if t.task_id not in usable)
    if excluded:
        print(f"excluded by bench-check (weak/broken tests): {', '.join(excluded)}", flush=True)
    holdout = sorted([t for t in all_tasks if t.split == "holdout" and t.task_id in usable], key=lambda t: t.task_id)
    train = sorted([t for t in all_tasks if t.split == "train" and t.task_id in usable], key=lambda t: t.task_id)
    if config.holdout_size:
        holdout = holdout[: config.holdout_size]
    if config.train_size:
        train = train[: config.train_size]
    return holdout, train


def _resolve_path(p: str) -> Path:
    path = Path(p)
    if path.is_absolute() or path.exists():
        return path
    return ROOT / path


# --------------------------------------------------------------------------- printing


class _Printer:
    def __init__(self, store: Store):
        self.store = store

    def run(self, r: RunResult) -> None:
        steps = "?"
        try:
            steps = str(len(self.store.load_transcript(r).steps))
        except Exception:  # noqa: BLE001
            pass
        tok = r.usage.prompt_tokens + r.usage.completion_tokens
        print(f"  v{r.version:<3} {r.split:<7} {r.task_id:<24} r{r.repeat}  {'PASS' if r.passed else 'fail'}  "
              f"steps={steps:<3} tokens={tok:<7,} {r.stop_reason:<15} {r.duration_s:5.0f}s", flush=True)

    def round(self, out: RoundOutcome) -> None:
        if out.stopped:
            why = {"train_clean": "the incumbent passed every train run, including a fresh re-run; run again "
                                  "(without --fresh) to draw another fresh train pass, or start over with --fresh "
                                  "and a larger --train",
                   "reviewer_failed": "the reviewer could not produce a usable edit"}.get(out.stopped, out.stopped)
            print(f"== round {out.round}: stopped ({out.stopped}): {why}", flush=True)
            return
        c, d = out.candidate, out.decision
        if c is None or d is None:
            return
        verdict = "ACCEPTED" if d.accepted else "REJECTED"
        print(f"== round {out.round}: candidate v{c.version} (parent v{c.parent}) {verdict}", flush=True)
        if c.rationale:
            print(f"   rationale: {c.rationale}", flush=True)
        print(f"   holdout {d.incumbent_score * 100:.1f}% -> {d.candidate_score * 100:.1f}% "
              f"({d.delta * 100:+.1f}%, margin {d.min_delta * 100:.1f}%)", flush=True)
        print(f"   gate: {d.reason}", flush=True)
        u = c.usage
        print(f"   usage: {u.requests} calls, {u.prompt_tokens:,} prompt, {u.completion_tokens:,} completion, "
              f"${u.cost_usd:.4f} ({cached_summary(c.usage_by_model)})", flush=True)


# --------------------------------------------------------------------------- commands


def cmd_bench_check(args: argparse.Namespace, settings: Settings) -> int:
    _require_key(settings)
    _guard_concurrent(args, settings, "bench-check")
    from ratchet import bench, mutate

    split = None if args.split in (None, "all") else args.split
    tasks = bench.load_tasks(split, ids=args.tasks or None)
    if not tasks:
        raise UsageError("no tasks selected")
    ledger = _build_ledger(settings)
    llm = _build_llm(settings, ledger)
    _refresh_prices(llm)
    split_of = {t.task_id: t.split for t in tasks}
    before = {} if args.force else mutate.load_bench_check(settings.bench_check_path)
    print(f"bench-check: {len(tasks)} task(s), planter {settings.planter_model}"
          f"{' (forced)' if args.force else ''}", flush=True)
    print(f"  {'task':<24} {'split':<8} {'verdict':<13} {'killed/valid':<8} planter cost", flush=True)
    results = mutate.check_bench(tasks, llm, settings, cache_path=settings.bench_check_path, force=args.force,
                                 progress=lambda r: _print_bench_row(r, split_of.get(r.task_id, "")))
    counts: dict[str, int] = {}
    for r in results:
        counts[r.verdict] = counts.get(r.verdict, 0) + 1
    reused = [r for r in results
              if r.task_id in before and before[r.task_id].checked_at == r.checked_at
              and before[r.task_id].fingerprint == r.fingerprint]
    reused_ids = {r.task_id for r in reused}
    fresh = [r for r in results if r.task_id not in reused_ids]
    now = sum_usage([r.usage for r in fresh])
    stored = sum_usage([r.usage for r in reused])
    print("verdicts: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())), flush=True)
    print(f"planter usage this run: {len(fresh)} task(s) checked, {now.requests} calls, {now.prompt_tokens:,} prompt, "
          f"{now.completion_tokens:,} completion tokens, ${now.cost_usd:.4f}", flush=True)
    if reused:
        print(f"reused {len(reused)} cached verdict(s) (fingerprints unchanged; their original check cost "
              f"${stored.cost_usd:.4f}; use --force to re-check)", flush=True)
    bad = [r.task_id for r in results if r.verdict not in USABLE_VERDICTS]
    if bad:
        print(f"weak or broken: {', '.join(sorted(bad))}", flush=True)
        return EXIT_WEAK
    return EXIT_OK


def _apply_overrides(config: LoopConfig, args: argparse.Namespace) -> LoopConfig:
    changes: dict[str, Any] = {}
    if args.rounds is not None:
        changes["rounds"] = args.rounds
    if args.repeats is not None:
        changes["repeats"] = args.repeats
    if args.holdout is not None:
        changes["holdout_size"] = args.holdout
    if args.train is not None:
        changes["train_size"] = args.train
    if args.min_delta is not None:
        changes["min_delta"] = args.min_delta
    for k, v in changes.items():
        if isinstance(v, (int, float)) and v < 0:
            raise UsageError(f"--{k.replace('_size', '').replace('_', '-')} must be >= 0")
    return dataclasses.replace(config, **changes) if changes else config


def _same_margin(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    try:
        return abs(float(a) - float(b)) <= 1e-12
    except (TypeError, ValueError):
        return False


def _check_resume_config(doc: dict[str, Any], config: LoopConfig, args: argparse.Namespace) -> None:
    """Refuse to resume a history with a config that would change what the gate measures."""
    old = doc.get("config", {}) or {}
    problems = []
    if args.config is not None and old.get("name") not in (None, config.name):
        problems.append(f"config {old.get('name')!r} vs requested {config.name!r}")
    for key in ("holdout_size", "train_size", "repeats"):
        if old.get(key) is not None and old.get(key) != getattr(config, key):
            problems.append(f"{key}={old.get(key)} vs requested {getattr(config, key)}")
    # The acceptance margin is part of what the gate measures (and what the report states), so a resume may
    # not change it either; passing the stored value explicitly is fine.
    if "min_delta" in old and not _same_margin(old.get("min_delta"), config.min_delta):
        problems.append(f"min_delta={old.get('min_delta')} vs requested {config.min_delta}")
    if problems:
        raise UsageError("the existing history in runs/ was made with a different config ("
                         + "; ".join(problems) + "); use --fresh, a matching --config, or a separate "
                         "RATCHET_RUNS_DIR")


def cmd_run(args: argparse.Namespace, settings: Settings) -> int:
    _require_key(settings)
    _guard_concurrent(args, settings, "run")
    store = Store(settings.runs_dir)
    config_name = args.config
    if config_name is None:
        stored = store.load_history().get("config", {}).get("name") if store.exists() and not args.fresh else None
        config_name = stored if stored in CONFIGS else "smoke"
    config = _apply_overrides(CONFIGS[config_name], args)
    playbook_path = _resolve_path(args.playbook)
    if not playbook_path.is_file():
        raise UsageError(f"playbook not found: {args.playbook}")
    if store.exists() and not args.fresh:
        _check_resume_config(store.load_history(), config, args)
    ledger = _build_ledger(settings)
    llm = _build_llm(settings, ledger)
    worker = _resolve_worker(args, settings, llm, ledger)
    if worker is None:
        return EXIT_WORKER
    sandbox_desc = _check_sandbox(settings)
    _refresh_prices(llm)
    if args.fresh:
        store.reset()
        print(f"--fresh: cleared {store.versions_dir} and history.json", flush=True)
    resume = store.exists()
    holdout, train = _select_tasks(settings, config, store, llm, resume=resume)
    if not holdout:
        raise UsageError("no usable holdout tasks (run `python -m ratchet bench-check` and fix weak suites)")
    from ratchet.gate import default_min_delta

    md = config.min_delta if config.min_delta is not None else default_min_delta(len(holdout), config.repeats)
    print(f"ratchet run: config={config.name} worker={getattr(worker, 'name', '?')} rounds={config.rounds} "
          f"holdout={len(holdout)}x{config.repeats} train={len(train)}x{config.train_repeats} "
          f"margin={md * 100:.1f}% {'(resuming)' if resume else '(new history)'}", flush=True)
    if resume:
        done = int(store.load_history().get("rounds_completed", 0) or 0)
        span = f" (rounds {done + 1}-{done + config.rounds})" if config.rounds > 0 else ""
        print(f"  resuming: rounds_completed={done}, running {config.rounds} more{span}; --rounds counts "
              f"additional rounds", flush=True)
    print(f"  worker {settings.worker_model} | reviewer {settings.reviewer_model} | runs {store.runs_dir}", flush=True)
    print(f"  sandbox: {sandbox_desc}", flush=True)
    if args.live:
        if not store.exists():
            store.init(playbook_path.read_text(encoding="utf-8"), config=config, worker=getattr(worker, "name", "local"),
                       holdout_ids=sorted(t.task_id for t in holdout), train_ids=sorted(t.task_id for t in train))
        store.set_live(True, pid=os.getpid())
        write_report(store)
        print(f"live report: {store.runs_dir / 'report.html'} (auto-refreshes every 20 s)", flush=True)
    printer = _Printer(store)
    t0 = time.monotonic()
    try:
        outcomes = run_loop(rounds=config.rounds, store=store, settings=settings, config=config, worker=worker,
                            llm=llm, ledger=ledger, playbook_path=playbook_path, holdout=holdout, train=train,
                            progress=printer.run, on_round=printer.round)
    finally:
        if args.live:
            store.set_live(False)
        if store.exists():
            try:
                write_report(store)
            except Exception:  # noqa: BLE001
                log.exception("final report failed")
    if store.exists():
        inc = store.incumbent()
        v0 = store.get(0)
        total = sum_usage([v.usage for v in store.versions()])
        print(f"done in {time.monotonic() - t0:.0f}s: {len(outcomes)} round(s); incumbent v{inc.version} "
              f"holdout {inc.holdout_score * 100:.1f}% (v0 {v0.holdout_score * 100:.1f}%); "
              f"total ${total.cost_usd:.4f}", flush=True)
        print(f"report: {store.runs_dir / 'report.html'}", flush=True)
    return EXIT_OK


def cmd_report(args: argparse.Namespace, settings: Settings) -> int:
    store = Store(settings.runs_dir)
    if _clear_stale_live(store):
        print("cleared a stale LIVE flag (the run that set it is no longer running)", flush=True)
    out = write_report(store, Path(args.out) if args.out else None)
    print(f"report: {out}")
    if args.open:
        import webbrowser

        webbrowser.open(out.resolve().as_uri())
    return EXIT_OK


def cmd_ping(args: argparse.Namespace, settings: Settings) -> int:
    _require_key(settings)
    ledger = _build_ledger(settings)
    llm = _build_llm(settings, ledger)
    _refresh_prices(llm)
    failed = 0
    for role, model in (("worker", settings.worker_model), ("reviewer", settings.reviewer_model),
                        ("planter", settings.planter_model)):
        try:
            res = llm.chat(model=model, messages=[{"role": "user", "content": "Reply with the single word OK."}],
                           thinking=False, max_tokens=20, temperature=0.0, tag="ping")
            ok = bool(res.content.strip())
            failed += 0 if ok else 1
            print(f"{'ok ' if ok else 'BAD'} {role:<8} {model:<48} {res.latency_ms:>6} ms  "
                  f"prompt={res.usage.prompt_tokens} completion={res.usage.completion_tokens} "
                  f"cached_reported={res.cached_reported} attempts={res.attempts} "
                  f"cost=${res.usage.cost_usd:.6f}  content={res.content.strip()[:20]!r}", flush=True)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"BAD {role:<8} {model:<48} {type(exc).__name__}: {str(exc)[:200]}", flush=True)
    return EXIT_ERROR if failed else EXIT_OK


def cmd_show(args: argparse.Namespace, settings: Settings) -> int:
    store = Store(settings.runs_dir)
    if not store.exists():
        raise UsageError(f"no history yet ({store.history_path}); run `python -m ratchet run` first")
    rec = store.get(args.version) if args.version is not None else store.incumbent()
    print(dump_json(rec.to_dict()))
    print(f"\n----- runs/versions/v{rec.version}/playbook.md -----")
    print(store.playbook(rec.version).rstrip())
    diff = store.diff_text(rec.version)
    if diff:
        print(f"\n----- runs/versions/v{rec.version}/diff.patch -----")
        print(diff.rstrip())
    return EXIT_OK


def cmd_eval(args: argparse.Namespace, settings: Settings) -> int:
    _require_key(settings)
    _guard_concurrent(args, settings, "eval")
    store = Store(settings.runs_dir)
    if not store.exists():
        raise UsageError(f"no history yet ({store.history_path})")
    rec = store.get(args.version)
    doc = store.load_history()
    from ratchet import bench

    ids = doc.get("holdout_task_ids" if args.split == "holdout" else "train_task_ids", [])
    if not ids:
        raise UsageError(f"history.json has no {args.split} task ids")
    tasks = [bench.get_task(t) for t in ids]
    cfg = doc.get("config", {})
    repeats = args.repeats or (cfg.get("repeats") if args.split == "holdout" else cfg.get("train_repeats")) or 1
    ledger = _build_ledger(settings)
    llm = _build_llm(settings, ledger)
    worker = _resolve_worker(args, settings, llm, ledger)
    if worker is None:
        return EXIT_WORKER
    print(f"sandbox: {_check_sandbox(settings)}", flush=True)
    _refresh_prices(llm)
    stamp = utcnow().replace(":", "").replace("-", "").replace(".", "")
    scratch = Store(settings.runs_dir / "evals" / f"v{rec.version}-{args.split}-{stamp}")
    print(f"eval: v{rec.version} on {len(tasks)} {args.split} task(s) x {repeats} -> {scratch.runs_dir}", flush=True)
    try:
        results = evaluate(tasks, store.playbook(rec.version), version=rec.version, split=args.split, repeats=repeats,
                           worker=worker, settings=settings, store=scratch, ledger=ledger, progress=_Printer(scratch).run)
    finally:
        try:
            worker.reset()
        except Exception:  # noqa: BLE001
            log.exception("worker.reset() failed")
    rates = per_task_rates(results)
    recorded = rec.per_task if args.split == "holdout" else {}
    print(f"  {'task':<24} {'now':>6} {'recorded':>9}")
    for t, r in rates.items():
        old = recorded.get(t)
        print(f"  {t:<24} {r * 100:5.0f}% {(f'{old * 100:8.0f}%' if old is not None else '        —')}")
    u: Usage = sum_usage([r.usage for r in results])
    rec_score = f"{rec.holdout_score * 100:.1f}%" if args.split == "holdout" and rec.holdout_score >= 0 else "—"
    print(f"score now {score(rates) * 100:.1f}% (recorded {rec_score}); cost ${u.cost_usd:.4f}", flush=True)
    return EXIT_OK


# --------------------------------------------------------------------------- parser / main


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m ratchet",
                                description="Ratchet: self-improving agent playbooks gated by a sealed holdout set.")
    sub = p.add_subparsers(dest="command", required=True)

    b = sub.add_parser("bench-check", help="test the hidden tests with planted bugs (bug planter on Crusoe)")
    b.add_argument("--force", action="store_true", help="ignore cached verdicts")
    b.add_argument("--tasks", nargs="+", metavar="ID", help="only these task ids")
    b.add_argument("--split", choices=["train", "holdout", "all"], default="all")
    b.add_argument("--allow-concurrent", action="store_true",
                   help="run even while another live ratchet run is using the rate limits")
    b.set_defaults(func=cmd_bench_check)

    def add_worker_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--worker", choices=["local", "openbot"], default="local")
        sp.add_argument("--openbot-mode", choices=["agui", "stack"], default="agui")
        sp.add_argument("--fallback-local", action="store_true",
                        help="use the local worker when the openbot worker is unavailable")
        sp.add_argument("--allow-concurrent", action="store_true",
                        help="run even while another live ratchet run (other runs dir) is using the rate limits")

    r = sub.add_parser("run", help="bootstrap v0 and run propose -> gate rounds")
    r.add_argument("--config", choices=sorted(CONFIGS), default=None,
                   help="smoke (default for a new history) or demo; a resume defaults to the stored config")
    r.add_argument("--rounds", type=int)
    r.add_argument("--repeats", type=int)
    r.add_argument("--holdout", type=int, help="cap on holdout tasks")
    r.add_argument("--train", type=int, help="cap on train tasks per round")
    r.add_argument("--min-delta", type=float, help="acceptance margin on the holdout score (0..1)")
    add_worker_args(r)
    r.add_argument("--fresh", action="store_true", help="wipe runs/versions and history.json first")
    r.add_argument("--live", action="store_true", help="report auto-refreshes while running")
    r.add_argument("--playbook", default="playbooks/v0.md", help="seed playbook for v0")
    r.set_defaults(func=cmd_run)

    rep = sub.add_parser("report", help="write runs/report.html")
    rep.add_argument("--out")
    rep.add_argument("--open", action="store_true")
    rep.set_defaults(func=cmd_report)

    pg = sub.add_parser("ping", help="one tiny call per role model")
    pg.set_defaults(func=cmd_ping)

    s = sub.add_parser("show", help="print a version record and its playbook")
    s.add_argument("--version", type=int)
    s.set_defaults(func=cmd_show)

    e = sub.add_parser("eval", help="re-evaluate one version (writes to runs/evals/)")
    e.add_argument("--version", type=int, required=True)
    e.add_argument("--split", choices=["holdout", "train"], default="holdout")
    e.add_argument("--repeats", type=int)
    add_worker_args(e)
    e.set_defaults(func=cmd_eval)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse: --help -> 0, bad usage -> 2
        return int(exc.code or 0)
    settings = Settings.from_env()
    _setup_logging(settings)
    _install_sigterm_handler()
    log.debug("command=%s settings=%r", args.command, settings)
    try:
        return int(args.func(args, settings))
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except Terminated:
        print("terminated (SIGTERM): in-flight runs stopped (unfinished ones discarded), live flag cleared and "
              "report written; rerun without --fresh to resume", file=sys.stderr)
        return 143
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001
        log.debug("unexpected error", exc_info=True)  # traceback to loop.log only (stderr handler is INFO)
        print(f"error: {type(exc).__name__}: {exc} (traceback in {settings.runs_dir / 'loop.log'})", file=sys.stderr)
        return EXIT_ERROR
