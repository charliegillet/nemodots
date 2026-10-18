"""Worker tools for Ratchet (owner: I1): write_file, read_file, run_python, run_tests, web_search, submit.

:data:`TOOL_SCHEMAS` is a module constant in a fixed order so the ``tools`` parameter is
byte-identical on every worker call (Crusoe MemoryAlloy prefix cache). :class:`ToolBox` executes
one tool call against a workspace directory and never raises: problems come back as
``ToolOutcome(text="error: ...", error=...)`` so the model can react.

Path rules (shared with ``ratchet.verify`` through :func:`safe_relpath` / :func:`resolve_in`):
relative, normalized, no ``..``, not absolute, no NUL, must resolve inside the workspace (symlinks
included).

Choices where PLAN.md is silent:
* ``write_file`` rejects content over 256 KB; ``read_file`` output is truncated like every tool
  output (``settings.tool_output_max_chars``, head 3/4 + tail 1/4).
* ``run_tests`` accepts a pytest node id (``test_x.py::test_a``); only the file part is path-checked.
  Timing text (``in 0.03s``) is left in the output; the worker's circuit breaker normalizes it.
* ``web_search`` caches results by ``(query, count)`` for the task; a cache hit does not use budget.
* ``snapshot_files`` skips symlinks, files over 64 KB, non-UTF-8 files and ``*.pyc``, and returns
  at most 200 files.
* Arguments of the wrong type are reported as tool errors, not coerced (except ``count``).
"""
from __future__ import annotations

import json
import logging
import posixpath
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ratchet.config import Settings
from ratchet.sandbox import Sandbox, SandboxResult, run_pytest, run_python_file, truncate_middle

log = logging.getLogger("ratchet.tools")

SNIPPET_FILE = "_ratchet_snippet.py"
MAX_WRITE_BYTES = 256 * 1024
SNAPSHOT_MAX_BYTES = 64 * 1024
SNAPSHOT_MAX_FILES = 200
SNAPSHOT_SKIP_DIRS = {"__pycache__", ".pytest_cache"}
NO_TESTS_HINT = "no tests collected: write test_*.py files first"

YOU_SEARCH_URL = "https://ydc-index.io/v1/search"
YOU_MCP_FREE_URL = "https://api.you.com/mcp?profile=free"


def _fn(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


TOOL_SCHEMAS: list[dict[str, Any]] = [
    _fn("write_file",
        "Create or overwrite a text file in the workspace. Use it to write solution.py and your own test_*.py files.",
        {"path": {"type": "string", "description": "Relative path inside the workspace, e.g. solution.py"},
         "content": {"type": "string", "description": "The complete new file contents"}},
        ["path", "content"]),
    _fn("read_file",
        "Read a text file from the workspace.",
        {"path": {"type": "string", "description": "Relative path inside the workspace"}},
        ["path"]),
    _fn("run_python",
        "Run a Python snippet in the workspace (no network) and return its exit code, stdout and stderr. "
        "The workspace is the current directory, so `from solution import ...` works.",
        {"code": {"type": "string", "description": "Python source code to execute"}},
        ["code"]),
    _fn("run_tests",
        "Run pytest on your own test_*.py files in the workspace (stops at the first failure) and return the output.",
        {"path": {"type": "string", "description": "Optional test file or node id; empty runs every test_*.py file",
                  "default": ""}},
        []),
    _fn("web_search",
        "Search the web (You.com) for documentation, error messages or library usage. Returns titles, URLs "
        "and relevant passages. Searches per task are limited.",
        {"query": {"type": "string", "description": "One question or keyword query, max 400 characters"},
         "count": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5,
                   "description": "Number of results (1-10)"}},
        ["query"]),
    _fn("submit",
        "Finish the task. Call this once solution.py is complete and your checks pass.",
        {"summary": {"type": "string", "description": "One or two sentences on what you implemented and verified"}},
        ["summary"]),
]
TOOL_NAMES: tuple[str, ...] = tuple(t["function"]["name"] for t in TOOL_SCHEMAS)


@dataclass
class ToolOutcome:
    text: str                 # what goes back to the model (already truncated)
    error: str | None = None  # tool-level error (bad path, unknown tool, ...)
    is_submit: bool = False


# --------------------------------------------------------------------------- path rules


def safe_relpath(path: Any) -> str:
    """Validate and normalize a workspace-relative path. Raises ValueError("path outside workspace")."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("path must be a non-empty string")
    p = path.strip().replace("\\", "/")
    if "\x00" in p:
        raise ValueError("path outside workspace")
    if p.startswith("/") or p.startswith("~") or (len(p) > 1 and p[1] == ":"):
        raise ValueError("path outside workspace")
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if not parts or any(seg == ".." for seg in parts):
        raise ValueError("path outside workspace")
    norm = posixpath.normpath("/".join(parts))
    if norm in (".", "") or norm.startswith(".."):
        raise ValueError("path outside workspace")
    return norm


def resolve_in(root: Path, path: Any) -> Path:
    """Absolute path for ``path`` inside ``root``; ValueError when it would escape (symlinks too)."""
    rel = safe_relpath(path)
    root_r = Path(root).resolve()
    target = (root_r / rel).resolve()
    if target == root_r or not target.is_relative_to(root_r):
        raise ValueError("path outside workspace")
    return target


# --------------------------------------------------------------------------- You.com search


def _flatten_search(payload: dict, limit: int) -> list[dict]:
    rows: list[dict] = []
    results = payload.get("results") or {}
    for section in ("web", "news"):
        for hit in results.get(section) or []:
            contents = hit.get("contents") or {}
            passages = contents.get("highlights") or hit.get("snippets") or [hit.get("description") or ""]
            if isinstance(passages, str):
                passages = [passages]
            rows.append({"title": str(hit.get("title") or ""), "url": str(hit.get("url") or ""),
                         "text": " ".join(str(x) for x in passages)[:1500]})
    return rows[:limit]


def you_search(query: str, count: int = 5, *, api_key: str | None, timeout: float = 20.0) -> list[dict]:
    """You.com web search -> ``[{"title","url","text"}]``. Never raises.

    Keyed: ``POST https://ydc-index.io/v1/search`` (``X-API-Key``) with highlights extraction.
    Keyless: the hosted MCP free profile (JSON-RPC ``tools/call you-search``, SSE-framed reply).
    On any failure returns a one-item "search unavailable" list (no key material in it)."""
    try:
        import httpx

        count = max(1, min(10, int(count)))
        query = str(query)[:400]
        if api_key:
            body = {"query": query, "count": count, "extraction": {"extraction_mode": "highlights"}}
            r = httpx.post(YOU_SEARCH_URL, json=body, headers={"X-API-Key": api_key}, timeout=timeout)
            r.raise_for_status()
            return _flatten_search(r.json(), count)
        args = {"query": query, "count": count, "extraction": "highlights"}
        rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "you-search", "arguments": args}}
        r = httpx.post(YOU_MCP_FREE_URL, json=rpc, headers={"Accept": "application/json, text/event-stream"},
                       timeout=timeout)
        r.raise_for_status()
        if r.headers.get("content-type", "").startswith("application/json"):
            msgs = [r.json()]
        else:
            msgs = [json.loads(line[5:].strip()) for line in r.text.splitlines() if line.startswith("data:")]
        for msg in msgs:
            if isinstance(msg, dict) and "result" in msg:
                text = msg["result"]["content"][0]["text"]
                return _flatten_search(json.loads(text), count)
        return []
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never raise into the worker loop
        status = getattr(getattr(exc, "response", None), "status_code", None)
        detail = type(exc).__name__ + (f" (HTTP {status})" if status else "")
        return [{"title": "search unavailable", "url": "", "text": f"You.com search failed: {detail}"}]


def format_search_results(rows: list[dict]) -> str:
    if not rows:
        return "no results"
    lines = []
    for i, row in enumerate(rows, 1):
        lines.append(f"{i}. {row.get('title', '')}\n   {row.get('url', '')}\n   {row.get('text', '')}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- ToolBox


def format_process_output(res: SandboxResult) -> str:
    text = f"exit_code: {res.exit_code}\n--- stdout ---\n{res.stdout}\n--- stderr ---\n{res.stderr}"
    if res.timed_out:
        text += "\n(timed out)"
    return text


class ToolBox:
    """Executes worker tool calls inside ``workspace`` using ``sandbox``."""

    def __init__(self, workspace: Path, sandbox: Sandbox, settings: Settings, *, search_enabled: bool = True,
                 tag: str = ""):
        self.workspace = Path(workspace)
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.sandbox = sandbox
        self.settings = settings
        self.search_enabled = search_enabled
        self.tag = tag
        self.searches_used = 0
        self._search_cache: dict[tuple[str, int], str] = {}

    def schemas(self) -> list[dict]:
        return TOOL_SCHEMAS

    def _cap(self, text: str) -> str:
        return truncate_middle(text, self.settings.tool_output_max_chars)

    def _err(self, msg: str) -> ToolOutcome:
        return ToolOutcome(text=self._cap(f"error: {msg}"), error=msg)

    def call(self, name: str, arguments: dict) -> ToolOutcome:
        if not isinstance(arguments, dict):
            return self._err("arguments must be a JSON object")
        handler = {
            "write_file": self._write_file,
            "read_file": self._read_file,
            "run_python": self._run_python,
            "run_tests": self._run_tests,
            "web_search": self._web_search,
            "submit": self._submit,
        }.get(name)
        if handler is None:
            return self._err(f"unknown tool {name}")
        t0 = time.monotonic()
        try:
            out = handler(arguments)
        except Exception as exc:  # noqa: BLE001 - tools never raise into the loop
            log.warning("tool %s raised %s", name, type(exc).__name__)
            out = self._err(f"{name} failed: {type(exc).__name__}: {exc}")
        log.debug("tool %s tag=%s %.0fms error=%s", name, self.tag, (time.monotonic() - t0) * 1000, out.error)
        return out

    @staticmethod
    def _str_arg(arguments: dict, key: str, *, required: bool = True, default: str = "") -> str:
        if key not in arguments or arguments[key] is None:
            if required:
                raise KeyError(key)
            return default
        val = arguments[key]
        if not isinstance(val, str):
            raise TypeError(key)
        return val

    def _args(self, arguments: dict, spec: list[tuple[str, bool]]) -> tuple[list[str], ToolOutcome | None]:
        vals = []
        for key, required in spec:
            try:
                vals.append(self._str_arg(arguments, key, required=required))
            except KeyError:
                return [], self._err(f"missing argument '{key}'")
            except TypeError:
                return [], self._err(f"argument '{key}' must be a string")
        return vals, None

    # -- tools
    def _write_file(self, arguments: dict) -> ToolOutcome:
        vals, bad = self._args(arguments, [("path", True), ("content", True)])
        if bad:
            return bad
        path, content = vals
        try:
            rel = safe_relpath(path)
            target = resolve_in(self.workspace, rel)
        except ValueError:
            return self._err("path outside workspace")
        data = content.encode("utf-8")
        if len(data) > MAX_WRITE_BYTES:
            return self._err(f"content too large ({len(data)} bytes; limit {MAX_WRITE_BYTES})")
        if target.is_dir():
            return self._err(f"{rel} is a directory")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return ToolOutcome(text=f"wrote {rel} ({len(data)} bytes)")

    def _read_file(self, arguments: dict) -> ToolOutcome:
        vals, bad = self._args(arguments, [("path", True)])
        if bad:
            return bad
        try:
            rel = safe_relpath(vals[0])
            target = resolve_in(self.workspace, rel)
        except ValueError:
            return self._err("path outside workspace")
        if not target.exists():
            return self._err(f"file not found: {rel}")
        if not target.is_file():
            return self._err(f"{rel} is not a file")
        return ToolOutcome(text=self._cap(target.read_bytes().decode("utf-8", errors="replace")))

    def _run_python(self, arguments: dict) -> ToolOutcome:
        vals, bad = self._args(arguments, [("code", True)])
        if bad:
            return bad
        (self.workspace / SNIPPET_FILE).write_text(vals[0], encoding="utf-8")
        res = run_python_file(self.sandbox, self.workspace, SNIPPET_FILE, self.settings.sandbox_timeout_s)
        return ToolOutcome(text=self._cap(format_process_output(res)))

    def _run_tests(self, arguments: dict) -> ToolOutcome:
        vals, bad = self._args(arguments, [("path", False)])
        if bad:
            return bad
        target = vals[0].strip()
        targets: list[str] = []
        if target:
            file_part, sep, node = target.partition("::")
            try:
                rel = safe_relpath(file_part)
                resolve_in(self.workspace, rel)
            except ValueError:
                return self._err("path outside workspace")
            targets = [rel + (sep + node if sep else "")]
        res = run_pytest(self.sandbox, self.workspace, targets, self.settings.sandbox_timeout_s)
        text = format_process_output(res)
        if res.exit_code == 5:
            text += "\n" + NO_TESTS_HINT   # at the end, so head+tail truncation keeps it
        return ToolOutcome(text=self._cap(text))

    def _web_search(self, arguments: dict) -> ToolOutcome:
        if not self.search_enabled:
            return ToolOutcome(text="web search is disabled")
        vals, bad = self._args(arguments, [("query", True)])
        if bad:
            return bad
        query = vals[0].strip()
        if not query:
            return self._err("query must not be empty")
        try:
            count = int(arguments.get("count", 5) if arguments.get("count") is not None else 5)
        except (TypeError, ValueError):
            count = 5
        count = max(1, min(10, count))
        key = (query, count)
        if key in self._search_cache:
            return ToolOutcome(text=self._search_cache[key])
        if self.searches_used >= self.settings.search_per_task_cap:
            return ToolOutcome(text="search budget exhausted for this task")
        self.searches_used += 1
        rows = you_search(query, count, api_key=self.settings.you_api_key)
        text = self._cap(format_search_results(rows))
        if not (len(rows) == 1 and rows[0].get("title") == "search unavailable"):
            self._search_cache[key] = text
        return ToolOutcome(text=text)

    def _submit(self, arguments: dict) -> ToolOutcome:
        summary = arguments.get("summary")
        if summary is not None and not isinstance(summary, str):
            summary = str(summary)
        return ToolOutcome(text="submitted", is_submit=True)

    # -- snapshot
    def snapshot_files(self) -> dict[str, str]:
        """Every regular file under the workspace (<= 64 KB, UTF-8), excluding caches and ``_ratchet_*``."""
        return snapshot_dir(self.workspace)


def snapshot_dir(root: Path) -> dict[str, str]:
    root = Path(root)
    out: dict[str, str] = {}
    if not root.is_dir():
        return out
    for p in sorted(root.rglob("*")):
        rel_parts = p.relative_to(root).parts
        if any(part in SNAPSHOT_SKIP_DIRS for part in rel_parts[:-1]):
            continue
        if p.is_symlink() or not p.is_file():
            continue
        name = p.name
        if name.startswith("_ratchet_") or name.endswith(".pyc") or name in SNAPSHOT_SKIP_DIRS:
            continue
        try:
            if p.stat().st_size > SNAPSHOT_MAX_BYTES:
                log.warning("snapshot: skipping %s (> %d bytes)", "/".join(rel_parts), SNAPSHOT_MAX_BYTES)
                continue
            out["/".join(rel_parts)] = p.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if len(out) >= SNAPSHOT_MAX_FILES:
            break
    return out
