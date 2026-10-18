"""On-disk version history for Ratchet (owner: I3).

Layout (see docs/PLAN.md section 5.3)::

    runs/
      history.json                      the whole version history (source of truth for the report)
      versions/vN/playbook.md           playbook text of version N
      versions/vN/diff.patch            unified diff against the parent (absent for v0)
      versions/vN/review.json           the reviewer's PlaybookEdit (absent for v0)
      versions/vN/record.json           the VersionRecord (mirror of the row in history.json)
      versions/vN/<split>/<task_id>/r<k>/{workspace/,verify/,transcript.json,result.json}

Choices made where the plan is silent (documented here as the plan asks):

* Paths stored in JSON are relative to ``self.root`` with forward slashes. ``root`` is the repo root
  (``ratchet.config.ROOT``) when ``runs_dir`` lives inside it, otherwise ``runs_dir.parent`` (unit tests
  use a temp dir). Either way stored paths look like ``runs/versions/v3/...`` as long as the runs dir
  is called ``runs``.
* ``init`` refuses to overwrite an existing history (``FileExistsError``); ``reset()`` (used by
  ``run --fresh``) removes ``versions/``, ``history.json`` and ``report.html`` but keeps
  ``bench_check.json``, ``llm_calls.jsonl`` and ``loop.log``.
* History mutations are serialized with a lock; ``save_run`` only touches per-run files, so the
  evaluation thread pool can call it concurrently.
* ``set_live(flag)`` stores ``history["live"]`` (read by the report for auto-refresh).
"""
from __future__ import annotations

import dataclasses
import json
import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Any

from ratchet.config import ROOT, LoopConfig
from ratchet.types import PlaybookEdit, RunResult, Transcript, Usage, VersionRecord, utcnow

log = logging.getLogger("ratchet.store")

SCHEMA = 1


def dump_json(obj: Any) -> str:
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False, default=_json_default)


def _json_default(o: Any) -> Any:
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return dataclasses.asdict(o)
    if isinstance(o, Path):
        return o.as_posix()
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_json_atomic(path: Path, obj: Any) -> None:
    write_text_atomic(path, dump_json(obj) + "\n")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


class Store:
    def __init__(self, runs_dir: Path):
        self.runs_dir = Path(runs_dir).resolve()
        self.versions_dir = self.runs_dir / "versions"
        self.history_path = self.runs_dir / "history.json"
        root = ROOT.resolve()
        self.root = root if self.runs_dir.is_relative_to(root) else self.runs_dir.parent
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ paths

    def rel(self, path: Path) -> str:
        """Path relative to the store root, forward slashes (for JSON)."""
        p = Path(path).resolve()
        try:
            return p.relative_to(self.root).as_posix()
        except ValueError:
            return p.as_posix()

    def abspath(self, stored: str | None) -> Path | None:
        if not stored:
            return None
        p = Path(stored)
        return p if p.is_absolute() else self.root / p

    def version_dir(self, version: int) -> Path:
        return self.versions_dir / f"v{version}"

    def run_dir(self, version: int, split: str, task_id: str, repeat: int) -> Path:
        return self.version_dir(version) / split / task_id / f"r{repeat}"

    # ------------------------------------------------------------------ history

    def exists(self) -> bool:
        return self.history_path.exists()

    def load_history(self) -> dict:
        with self._lock:
            return read_json(self.history_path)

    def save_history(self, doc: dict) -> None:
        with self._lock:
            doc = dict(doc)
            doc["schema"] = SCHEMA
            doc["updated_at"] = utcnow()
            write_json_atomic(self.history_path, doc)

    def init(self, playbook: str, *, config: LoopConfig, worker: str, holdout_ids: list[str],
             train_ids: list[str]) -> VersionRecord:
        with self._lock:
            if self.exists():
                raise FileExistsError(f"{self.history_path} already exists (use reset() / --fresh)")
            self.runs_dir.mkdir(parents=True, exist_ok=True)
            vdir = self.version_dir(0)
            vdir.mkdir(parents=True, exist_ok=True)
            playbook = playbook.rstrip() + "\n"
            write_text_atomic(vdir / "playbook.md", playbook)
            rec = VersionRecord(
                version=0, parent=None, status="candidate", round=0, created_at=utcnow(),
                playbook_path=self.rel(vdir / "playbook.md"), diff_path=None,
                rationale="Seed playbook (deliberately minimal).", diagnosis="",
                holdout_score=-1.0, per_task={}, repeats=config.repeats, incumbent_version=None,
                incumbent_score=None, delta=None, regressions=[], improvements=[], gate_reason="seed",
                usage=Usage(), worker=worker,
            )
            write_json_atomic(vdir / "record.json", {"schema": SCHEMA, **rec.to_dict()})
            doc = {
                "schema": SCHEMA,
                "updated_at": utcnow(),
                "config": dataclasses.asdict(config),
                "worker": worker,
                "holdout_task_ids": list(holdout_ids),
                "train_task_ids": list(train_ids),
                "incumbent": None,
                "rounds_completed": 0,
                "live": False,
                "versions": [rec.to_dict()],
            }
            self.save_history(doc)
            return rec

    def reset(self) -> None:
        """Wipe versions/, history.json and report.html (keeps bench_check.json, llm_calls.jsonl, loop.log)."""
        with self._lock:
            if self.versions_dir.exists():
                shutil.rmtree(self.versions_dir)
            for name in ("history.json", "report.html"):
                p = self.runs_dir / name
                if p.exists():
                    p.unlink()

    def versions(self) -> list[VersionRecord]:
        doc = self.load_history()
        recs = [VersionRecord.from_dict(v) for v in doc.get("versions", [])]
        return sorted(recs, key=lambda r: r.version)

    def get(self, version: int) -> VersionRecord:
        for r in self.versions():
            if r.version == version:
                return r
        raise KeyError(f"version {version} not found in {self.history_path}")

    def incumbent(self) -> VersionRecord:
        recs = [r for r in self.versions() if r.status == "incumbent"]
        if not recs:
            raise LookupError("no incumbent version yet (bootstrap has not finished)")
        return recs[-1]

    def next_version(self) -> int:
        recs = self.versions()
        return (max(r.version for r in recs) + 1) if recs else 0

    def playbook(self, version: int) -> str:
        return (self.version_dir(version) / "playbook.md").read_text(encoding="utf-8")

    def diff_text(self, version: int) -> str:
        p = self.version_dir(version) / "diff.patch"
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def create_version(self, *, parent: int, playbook: str, diff: str, edit: PlaybookEdit, round: int,
                       worker: str) -> VersionRecord:
        with self._lock:
            doc = self.load_history()
            version = self.next_version()
            parent_rec = self.get(parent)
            vdir = self.version_dir(version)
            vdir.mkdir(parents=True, exist_ok=True)
            write_text_atomic(vdir / "playbook.md", playbook.rstrip() + "\n")
            write_text_atomic(vdir / "diff.patch", diff)
            write_json_atomic(vdir / "review.json", {"schema": SCHEMA, **dataclasses.asdict(edit)})
            repeats = int(doc.get("config", {}).get("repeats", parent_rec.repeats) or parent_rec.repeats)
            rec = VersionRecord(
                version=version, parent=parent, status="candidate", round=round, created_at=utcnow(),
                playbook_path=self.rel(vdir / "playbook.md"), diff_path=self.rel(vdir / "diff.patch"),
                rationale=edit.rationale, diagnosis=edit.diagnosis, holdout_score=-1.0, per_task={},
                repeats=repeats, incumbent_version=parent, incumbent_score=parent_rec.holdout_score,
                delta=None, regressions=[], improvements=[], gate_reason="", usage=Usage(), worker=worker,
            )
            self.update(rec)
            return rec

    def update(self, record: VersionRecord) -> None:
        with self._lock:
            vdir = self.version_dir(record.version)
            write_json_atomic(vdir / "record.json", {"schema": SCHEMA, **record.to_dict()})
            doc = self.load_history()
            rows = [v for v in doc.get("versions", []) if v.get("version") != record.version]
            rows.append(record.to_dict())
            doc["versions"] = sorted(rows, key=lambda v: v["version"])
            if record.status == "incumbent":
                doc["incumbent"] = record.version
            self.save_history(doc)

    def set_incumbent(self, version: int) -> None:
        with self._lock:
            new = self.get(version)
            for r in self.versions():
                if r.status == "incumbent" and r.version != version:
                    r.status = "superseded"
                    self.update(r)
            new.status = "incumbent"
            self.update(new)

    def set_rounds_completed(self, n: int) -> None:
        with self._lock:
            doc = self.load_history()
            doc["rounds_completed"] = int(n)
            self.save_history(doc)

    def set_live(self, live: bool, *, pid: int | None = None) -> None:
        with self._lock:
            if not self.exists():
                return
            doc = self.load_history()
            doc["live"] = bool(live)
            if live and pid:
                doc["live_pid"] = int(pid)
            elif not live:
                doc.pop("live_pid", None)
            self.save_history(doc)

    # ------------------------------------------------------------------ runs

    def save_run(self, result: RunResult, transcript: Transcript) -> None:
        rdir = self.run_dir(result.version, result.split, result.task_id, result.repeat)
        rdir.mkdir(parents=True, exist_ok=True)
        write_json_atomic(rdir / "transcript.json", {"schema": SCHEMA, **transcript.to_dict()})
        write_json_atomic(rdir / "result.json", {"schema": SCHEMA, **result.to_dict()})

    def load_result(self, version: int, split: str, task_id: str, repeat: int) -> RunResult | None:
        p = self.run_dir(version, split, task_id, repeat) / "result.json"
        if not p.exists():
            return None
        try:
            return RunResult.from_dict(read_json(p))
        except (OSError, ValueError, TypeError) as exc:  # half-written or corrupt: treat as missing
            log.warning("ignoring unreadable %s: %s", self.rel(p), exc)
            return None

    def load_runs(self, version: int, split: str) -> list[RunResult]:
        base = self.version_dir(version) / split
        if not base.exists():
            return []
        out: list[RunResult] = []
        for p in base.glob("*/r*/result.json"):
            try:
                out.append(RunResult.from_dict(read_json(p)))
            except (OSError, ValueError, TypeError) as exc:
                log.warning("ignoring unreadable %s: %s", self.rel(p), exc)
        return sorted(out, key=lambda r: (r.task_id, r.repeat))

    def load_transcript(self, result: RunResult) -> Transcript:
        p = self.abspath(result.transcript_path)
        if p is None or not p.exists():
            p = self.run_dir(result.version, result.split, result.task_id, result.repeat) / "transcript.json"
        return Transcript.from_dict(read_json(p))
