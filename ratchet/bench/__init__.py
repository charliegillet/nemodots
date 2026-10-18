"""Ratchet benchmark: 24 small Python tasks, each with a spec, a starter, a reference solution and
hidden pytest tests (owner: I2, see docs/PLAN.md section 5.2).

Layout (one folder per task under ``ratchet/bench/tasks/<task_id>/``):

- ``spec.md``        what the worker sees (title, context, ``## Function(s)``, ``## Rules``, ``## Examples``)
- ``starter.py``     initial ``solution.py`` (signatures + ``raise NotImplementedError``); fails the hidden tests
- ``reference.py``   a correct ``solution.py``; passes the hidden tests
- ``test_hidden.py`` pytest file importing ``from solution import ...``; never shown to any model
- ``meta.json``      ``{"schema": 1, "split", "tags", "timeout_s", "pitfalls"}`` (pitfalls are notes for humans)

``split.json`` next to this file lists the train / holdout ids and must agree with every ``meta.json``.

Choices where the plan is silent (documented here as required by PLAN.md):

- ``task_fingerprint`` hashes ``reference_solution + "\\0" + hidden_tests`` (a NUL separator so moving
  text between the two files changes the hash).
- ``load_tasks`` reads the files on every call (no cache) so edits made while strengthening a weak
  suite are picked up immediately; reading 120 small files takes a few milliseconds.
- ``load_tasks`` raises ``ValueError`` for an unknown split name and ``KeyError`` for an unknown id.
- ``validate_task_dir`` also checks that every name the hidden tests import from ``solution`` is
  defined at the top level of both ``reference.py`` and ``starter.py``, that the test count is 8-15,
  that the spec has the four required sections and that every file compiles.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable

from ratchet.types import Task

TASKS_DIR: Path = Path(__file__).parent / "tasks"
SPLIT_PATH: Path = Path(__file__).parent / "split.json"

SPLITS: tuple[str, ...] = ("train", "holdout")
REQUIRED_FILES: tuple[str, ...] = ("spec.md", "starter.py", "reference.py", "test_hidden.py", "meta.json")
MIN_TESTS, MAX_TESTS = 8, 15

_TASK_ID_RE = re.compile(r"^t\d{2}_[a-z0-9_]+$")
_SOLUTION_IMPORT_RE = re.compile(r"^\s*(from\s+solution\s+import\s|import\s+solution\b)", re.MULTILINE)


# --------------------------------------------------------------------------- split / meta


def load_split(path: Path | None = None) -> dict[str, list[str]]:
    """Return ``{"train": [...], "holdout": [...]}`` from split.json."""
    data = json.loads((path or SPLIT_PATH).read_text(encoding="utf-8"))
    return {s: list(data.get(s, [])) for s in SPLITS}


def _split_of(task_id: str, split_map: dict[str, list[str]]) -> str | None:
    for s in SPLITS:
        if task_id in split_map.get(s, []):
            return s
    return None


def _read_meta(path: Path) -> dict[str, Any]:
    return json.loads((path / "meta.json").read_text(encoding="utf-8"))


def _read_task(path: Path) -> Task:
    meta = _read_meta(path)

    def read(name: str) -> str:
        return (path / name).read_text(encoding="utf-8")

    return Task(
        task_id=path.name,
        split=str(meta["split"]),
        spec=read("spec.md"),
        starter_code=read("starter.py"),
        hidden_tests=read("test_hidden.py"),
        reference_solution=read("reference.py"),
        timeout_s=int(meta.get("timeout_s", 20)),
        tags=tuple(meta.get("tags", ())),
    )


def all_task_ids() -> list[str]:
    """Sorted ids of every task folder (a folder counts when it contains meta.json)."""
    if not TASKS_DIR.is_dir():
        return []
    return sorted(p.name for p in TASKS_DIR.iterdir() if p.is_dir() and (p / "meta.json").is_file())


# --------------------------------------------------------------------------- public API


def load_tasks(split: str | None = None, ids: Iterable[str] | None = None) -> list[Task]:
    """Load tasks sorted by task_id.

    split: "train" | "holdout" | None (all). ids: optional filter; an id that does not exist raises
    KeyError (an id that exists but belongs to another split is simply filtered out by ``split``).
    """
    if split is not None and split not in SPLITS:
        raise ValueError(f"unknown split {split!r}; expected one of {SPLITS} or None")
    known = all_task_ids()
    if ids is not None:
        wanted = list(dict.fromkeys(ids))
        missing = [i for i in wanted if i not in known]
        if missing:
            raise KeyError(f"unknown task id(s): {', '.join(missing)}")
        selected = sorted(wanted)
    else:
        selected = known
    tasks = [_read_task(TASKS_DIR / tid) for tid in selected]
    if split is not None:
        tasks = [t for t in tasks if t.split == split]
    return tasks


def get_task(task_id: str) -> Task:
    """Load one task by id; KeyError if it does not exist."""
    path = TASKS_DIR / task_id
    if not (path / "meta.json").is_file():
        raise KeyError(f"unknown task id: {task_id}")
    return _read_task(path)


def task_fingerprint(task: Task) -> str:
    """sha256 (hex) of the reference solution and the hidden tests. Changes whenever either changes,
    which invalidates cached bench-check results for the task."""
    h = hashlib.sha256()
    h.update(task.reference_solution.encode("utf-8"))
    h.update(b"\0")
    h.update(task.hidden_tests.encode("utf-8"))
    return h.hexdigest()


def _top_level_names(source: str) -> set[str]:
    names: set[str] = set()
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return names


def _imported_from_solution(source: str) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom) and node.module == "solution":
            names.update(a.name for a in node.names if a.name != "*")
    return names


def validate_task_dir(path: Path, split_map: dict[str, list[str]] | None = None) -> list[str]:
    """Human-readable problems with one task folder; [] when valid.

    Checks: required files present and non-empty; meta.json schema (schema == 1, split, tags,
    timeout_s, pitfalls); split agrees with split.json; Python files compile; the hidden tests import
    from ``solution`` and every imported name exists in reference.py and starter.py; 8-15 test
    functions; the starter raises NotImplementedError; the spec has the required sections.
    """
    path = Path(path)
    tid = path.name
    problems: list[str] = []
    if not path.is_dir():
        return [f"{tid}: not a directory"]
    if not _TASK_ID_RE.match(tid):
        problems.append(f"{tid}: folder name must look like t01_snake_case")
    for name in REQUIRED_FILES:
        f = path / name
        if not f.is_file():
            problems.append(f"{tid}: missing {name}")
        elif not f.read_text(encoding="utf-8").strip():
            problems.append(f"{tid}: {name} is empty")
    if problems:
        return problems

    # meta.json
    try:
        meta = _read_meta(path)
    except (OSError, json.JSONDecodeError) as exc:
        return [f"{tid}: meta.json is not valid JSON ({exc})"]
    if not isinstance(meta, dict):
        return [f"{tid}: meta.json must be an object"]
    if meta.get("schema") != 1:
        problems.append(f"{tid}: meta.json schema must be 1")
    split = meta.get("split")
    if split not in SPLITS:
        problems.append(f"{tid}: meta.json split must be one of {SPLITS}, got {split!r}")
    tags = meta.get("tags")
    if not isinstance(tags, list) or not tags or not all(isinstance(t, str) and t for t in tags):
        problems.append(f"{tid}: meta.json tags must be a non-empty list of non-empty strings")
    timeout = meta.get("timeout_s")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
        problems.append(f"{tid}: meta.json timeout_s must be a positive integer")
    pitfalls = meta.get("pitfalls")
    if not isinstance(pitfalls, list) or not pitfalls or not all(isinstance(p, str) and p for p in pitfalls):
        problems.append(f"{tid}: meta.json pitfalls must be a non-empty list of strings")

    # split.json agreement
    try:
        smap = split_map if split_map is not None else load_split()
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"{tid}: cannot read split.json ({exc})")
        smap = None
    if smap is not None:
        listed = _split_of(tid, smap)
        if listed is None:
            problems.append(f"{tid}: not listed in split.json")
        elif split in SPLITS and listed != split:
            problems.append(f"{tid}: meta.json split {split!r} disagrees with split.json ({listed!r})")

    # python sources compile
    sources: dict[str, str] = {}
    for name in ("starter.py", "reference.py", "test_hidden.py"):
        src = (path / name).read_text(encoding="utf-8")
        try:
            compile(src, f"{tid}/{name}", "exec")
            sources[name] = src
        except SyntaxError as exc:
            problems.append(f"{tid}: {name} does not compile ({exc.msg} at line {exc.lineno})")

    tests = sources.get("test_hidden.py")
    if tests is not None:
        if not _SOLUTION_IMPORT_RE.search(tests):
            problems.append(f"{tid}: test_hidden.py must import from `solution`")
        imported = _imported_from_solution(tests)
        for name in ("reference.py", "starter.py"):
            if name in sources:
                missing = sorted(imported - _top_level_names(sources[name]))
                if missing:
                    problems.append(f"{tid}: {name} does not define {', '.join(missing)}")
        n_tests = sum(
            1 for node in ast.parse(tests).body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
        )
        if not MIN_TESTS <= n_tests <= MAX_TESTS:
            problems.append(f"{tid}: test_hidden.py has {n_tests} tests; expected {MIN_TESTS}-{MAX_TESTS}")
        for banned in ("import requests", "import socket", "import urllib.request", "import hypothesis"):
            if banned in tests:
                problems.append(f"{tid}: test_hidden.py must not use `{banned}`")

    starter = sources.get("starter.py")
    if starter is not None and "NotImplementedError" not in starter:
        problems.append(f"{tid}: starter.py bodies must raise NotImplementedError")

    spec = (path / "spec.md").read_text(encoding="utf-8")
    if not spec.lstrip().startswith("# "):
        problems.append(f"{tid}: spec.md must start with a '# Title' heading")
    for heading in ("## Function", "## Rules", "## Examples"):
        if not re.search(rf"^{re.escape(heading)}", spec, re.MULTILINE):
            problems.append(f"{tid}: spec.md is missing a '{heading}' section")
    return problems


def validate_bench() -> list[str]:
    """Validate every task folder plus split.json coverage. [] when the whole benchmark is valid."""
    problems: list[str] = []
    smap = load_split()
    ids = all_task_ids()
    for tid in ids:
        problems.extend(validate_task_dir(TASKS_DIR / tid, smap))
    listed = smap["train"] + smap["holdout"]
    for tid in listed:
        if tid not in ids:
            problems.append(f"split.json lists {tid} but there is no task folder")
    dupes = sorted({t for t in listed if listed.count(t) > 1})
    if dupes:
        problems.append(f"split.json lists these ids more than once: {', '.join(dupes)}")
    return problems


__all__ = [
    "TASKS_DIR",
    "SPLIT_PATH",
    "SPLITS",
    "load_split",
    "load_tasks",
    "get_task",
    "all_task_ids",
    "task_fingerprint",
    "validate_task_dir",
    "validate_bench",
]
