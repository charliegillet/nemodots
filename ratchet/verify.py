"""Prove step: run a task's hidden tests against a workspace snapshot (owner: I1).

Verification always happens in Ratchet's own sandbox from ``Transcript.workspace_files``, so it is
independent of the worker host. A run passes only when pytest exits 0 (and did not time out).

Hardening beyond PLAN.md (documented choices; all only make a pass harder to fake):
* Besides ``test_hidden.py`` and ``conftest.py`` (anywhere in the tree), files that could change how
  pytest runs are not copied: pytest/tox/setup config files, ``sitecustomize.py`` /
  ``usercustomize.py``, and top-level modules or packages shadowing ``pytest``, ``_pytest``,
  ``pluggy``, ``py``, ``iniconfig`` or ``packaging``. pytest also runs with ``-c /dev/null``
  (see ``ratchet.sandbox.run_pytest``).
* Exit code 0 also requires pytest's summary line (``N passed``) in the output; otherwise the
  result is a failure with an explanatory note. This blocks a solution that calls ``os._exit(0)``
  at import time. ``VerifyResult.exit_code`` still reports the real exit code.
"""
from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from ratchet.config import Settings
from ratchet.sandbox import Sandbox, run_pytest, truncate_middle
from ratchet.tools import resolve_in, safe_relpath
from ratchet.types import Task, VerifyResult

log = logging.getLogger("ratchet.verify")

HIDDEN_TEST_FILE = "test_hidden.py"
OUTPUT_MAX_CHARS = 8000

_SKIP_ANYWHERE = {HIDDEN_TEST_FILE, "conftest.py"}
_SKIP_TOP_FILES = {"pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg", "sitecustomize.py",
                   "usercustomize.py", "pytest.py", "py.py", "pluggy.py", "iniconfig.py", "packaging.py",
                   "_pytest.py"}
_SKIP_TOP_DIRS = {"pytest", "_pytest", "pluggy", "py", "iniconfig", "packaging"}
_PASSED_RE = re.compile(r"\b\d+ passed\b")
_BAD_SUMMARY_RE = re.compile(r"\b\d+ (failed|errors?)\b")


def _skip(rel: str) -> bool:
    parts = rel.split("/")
    if parts[-1] in _SKIP_ANYWHERE:
        return True
    if len(parts) == 1 and parts[0] in _SKIP_TOP_FILES:
        return True
    return len(parts) > 1 and parts[0] in _SKIP_TOP_DIRS


def _materialize(verify_dir: Path, workspace_files: dict[str, str]) -> list[str]:
    """Write the snapshot into verify_dir; returns the relative paths that were skipped."""
    skipped: list[str] = []
    for path, content in sorted((workspace_files or {}).items()):
        try:
            rel = safe_relpath(path)
            target = resolve_in(verify_dir, rel)
        except ValueError:
            skipped.append(str(path))
            continue
        if _skip(rel) or not isinstance(content, str):
            skipped.append(rel)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return skipped


def run_hidden_tests(task: Task, workspace_files: dict[str, str], settings: Settings, run_dir: Path,
                     sandbox: Sandbox | None = None) -> VerifyResult:
    sandbox = sandbox if sandbox is not None else Sandbox(settings)
    verify_dir = Path(run_dir) / "verify"
    if verify_dir.exists():
        shutil.rmtree(verify_dir)
    verify_dir.mkdir(parents=True, exist_ok=True)

    skipped = _materialize(verify_dir, workspace_files)
    if skipped:
        log.debug("verify %s: skipped %s", task.task_id, skipped)
    entry = verify_dir / task.entry_file
    if not entry.exists():
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("", encoding="utf-8")
    (verify_dir / HIDDEN_TEST_FILE).write_text(task.hidden_tests, encoding="utf-8")

    res = run_pytest(sandbox, verify_dir, [HIDDEN_TEST_FILE], timeout_s=task.timeout_s)
    output = (res.stdout or "") + "\n" + (res.stderr or "")
    passed = res.exit_code == 0 and not res.timed_out
    if passed:
        stdout_lines = (res.stdout or "").strip().splitlines()
        summary = stdout_lines[-1] if stdout_lines else ""   # with -q pytest's summary is the last line
        if not _PASSED_RE.search(summary) or _BAD_SUMMARY_RE.search(summary):
            passed = False
            output += "\n[ratchet] pytest exited 0 without a passing summary line; treated as a failure"
    if res.timed_out:
        output += f"\n[ratchet] hidden tests timed out after {task.timeout_s}s"
    return VerifyResult(passed=passed, exit_code=res.exit_code,
                        output=truncate_middle(output, OUTPUT_MAX_CHARS),
                        duration_s=res.duration_s, timed_out=res.timed_out, backend=res.backend,
                        isolation=getattr(res, "isolation", ""))


def verify_reference(task: Task, settings: Settings, run_dir: Path, sandbox: Sandbox | None = None) -> VerifyResult:
    return run_hidden_tests(task, {task.entry_file: task.reference_solution}, settings, run_dir, sandbox=sandbox)
