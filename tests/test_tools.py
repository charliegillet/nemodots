"""Offline tests for ratchet.tools (owner: I1). web_search is monkeypatched; nothing touches the network."""
from __future__ import annotations

import os

import httpx
import pytest

from ratchet import tools as tools_mod
from ratchet.sandbox import Sandbox
from ratchet.tools import TOOL_SCHEMAS, ToolBox, resolve_in, safe_relpath, you_search


@pytest.fixture(autouse=True)
def _no_real_search_key(settings):
    # conftest deletes YOU_API_KEY but Settings.from_env() reloads it from .env; never use it in unit tests.
    settings.you_api_key = None


@pytest.fixture
def box(settings, tmp_path):
    ws = tmp_path / "workspace"
    return ToolBox(ws, Sandbox(settings), settings, tag="v0:train:t:r0")


def test_schema_names_and_order(box):
    names = [t["function"]["name"] for t in TOOL_SCHEMAS]
    assert names == ["write_file", "read_file", "run_python", "run_tests", "web_search", "submit"]
    assert box.schemas() is TOOL_SCHEMAS
    by = {t["function"]["name"]: t["function"]["parameters"] for t in TOOL_SCHEMAS}
    assert by["write_file"]["required"] == ["path", "content"]
    assert by["run_tests"]["required"] == [] and "path" in by["run_tests"]["properties"]
    assert by["web_search"]["properties"]["count"]["maximum"] == 10
    assert by["submit"]["required"] == ["summary"]
    assert all(t["type"] == "function" for t in TOOL_SCHEMAS)


@pytest.mark.parametrize("bad", ["../x.py", "/etc/passwd", "a/../../x", "~/x", "", "C:/x", "a\x00b", ".", "./.."])
def test_path_traversal_rejected(box, bad):
    out = box.call("write_file", {"path": bad, "content": "x"})
    assert out.text == "error: path outside workspace" or out.text.startswith("error:")
    assert out.error
    out = box.call("read_file", {"path": bad})
    assert out.error


def test_symlink_escape_rejected(box, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    os.symlink(outside, box.workspace / "link")
    out = box.call("read_file", {"path": "link/secret.txt"})
    assert out.text == "error: path outside workspace"


def test_safe_relpath_normalizes():
    assert safe_relpath("./a//b/c.py") == "a/b/c.py"
    assert safe_relpath("sub\\x.py") == "sub/x.py"
    with pytest.raises(ValueError):
        safe_relpath("a/../../b")


def test_write_read_round_trip(box):
    out = box.call("write_file", {"path": "pkg/mod.py", "content": "x = 'é'\n"})
    assert out.text == "wrote pkg/mod.py (9 bytes)" and out.error is None
    assert box.call("read_file", {"path": "pkg/mod.py"}).text == "x = 'é'\n"
    assert box.call("read_file", {"path": "nope.py"}).text == "error: file not found: nope.py"


def test_bad_arguments(box):
    assert box.call("write_file", {"path": "a.py"}).text == "error: missing argument 'content'"
    assert box.call("write_file", {"path": "a.py", "content": 3}).text == "error: argument 'content' must be a string"
    assert box.call("write_file", ["x"]).error


def test_unknown_tool(box):
    out = box.call("rm_rf", {})
    assert out.text == "error: unknown tool rm_rf" and out.error


def test_run_python_captures_stdout_and_exit(box):
    box.call("write_file", {"path": "solution.py", "content": "def f():\n    return 5\n"})
    out = box.call("run_python", {"code": "from solution import f\nprint(f())\nraise SystemExit(2)"})
    assert out.text.startswith("exit_code: 2\n--- stdout ---\n5\n")
    assert "--- stderr ---" in out.text and out.error is None
    assert (box.workspace / "_ratchet_snippet.py").exists()


def test_run_python_timeout(box, settings):
    settings.sandbox_timeout_s = 1
    out = box.call("run_python", {"code": "import time; time.sleep(20)"})
    assert out.text.startswith("exit_code: 124") and "timed out" in out.text


def test_run_python_output_truncated(box, settings):
    out = box.call("run_python", {"code": "print('y' * 50000)"})
    assert len(out.text) <= settings.tool_output_max_chars + 60 and "truncated" in out.text


def test_run_tests_no_tests_hint(box):
    out = box.call("run_tests", {})
    assert out.text.startswith("exit_code: 5") and out.text.endswith("no tests collected: write test_*.py files first")


def test_run_tests_pass_fail_and_path(box):
    box.call("write_file", {"path": "solution.py", "content": "def f():\n    return 1\n"})
    box.call("write_file", {"path": "test_ok.py", "content": "from solution import f\ndef test_f():\n    assert f() == 1\n"})
    assert box.call("run_tests", {}).text.startswith("exit_code: 0")
    box.call("write_file", {"path": "test_bad.py", "content": "def test_bad():\n    assert 1 == 2\n"})
    out = box.call("run_tests", {"path": ""})
    assert out.text.startswith("exit_code: 1") and "1 failed" in out.text
    assert box.call("run_tests", {"path": "test_ok.py::test_f"}).text.startswith("exit_code: 0")
    assert box.call("run_tests", {"path": "../x.py"}).text == "error: path outside workspace"


def test_search_disabled(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(tools_mod, "you_search", lambda *a, **k: pytest.fail("must not search"))
    b = ToolBox(tmp_path / "ws", Sandbox(settings), settings, search_enabled=False)
    assert b.call("web_search", {"query": "x"}).text == "web search is disabled"


def test_search_budget_and_format(box, settings, monkeypatch):
    calls = []

    def fake(query, count=5, *, api_key, timeout=20.0):
        calls.append((query, count, api_key))
        return [{"title": f"T {query}", "url": "https://example.org", "text": "passage"}]

    monkeypatch.setattr(tools_mod, "you_search", fake)
    settings.search_per_task_cap = 2
    out = box.call("web_search", {"query": "a", "count": 50})
    assert out.text == "1. T a\n   https://example.org\n   passage"
    assert calls[0][:2] == ("a", 10) and calls[0][2] is None
    box.call("web_search", {"query": "a", "count": 50})          # cache hit, no budget used
    box.call("web_search", {"query": "b"})
    assert box.searches_used == 2 and len(calls) == 2
    assert box.call("web_search", {"query": "c"}).text == "search budget exhausted for this task"
    assert len(calls) == 2


def test_submit(box):
    out = box.call("submit", {"summary": "done"})
    assert out.text == "submitted" and out.is_submit


def test_snapshot_excludes_ratchet_and_caches(box):
    ws = box.workspace
    (ws / "solution.py").write_text("x = 1\n")
    (ws / "sub").mkdir()
    (ws / "sub" / "helper.py").write_text("y = 2\n")
    (ws / "_ratchet_snippet.py").write_text("print(1)\n")
    (ws / "__pycache__").mkdir()
    (ws / "__pycache__" / "solution.cpython-313.pyc").write_bytes(b"\x00\x01")
    (ws / ".pytest_cache").mkdir()
    (ws / ".pytest_cache" / "README.md").write_text("cache")
    (ws / "big.txt").write_text("z" * (64 * 1024 + 1))
    (ws / "bin.dat").write_bytes(b"\xff\xfe\x00")
    snap = box.snapshot_files()
    assert snap == {"solution.py": "x = 1\n", "sub/helper.py": "y = 2\n"}


def test_you_search_never_raises(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx, "post", boom)
    rows = you_search("q", 3, api_key="k")
    assert rows == [{"title": "search unavailable", "url": "", "text": "You.com search failed: ConnectError"}]
    rows = you_search("q", 3, api_key=None)
    assert rows[0]["title"] == "search unavailable"


def test_you_search_keyed_parsing(monkeypatch):
    seen = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen.update(url=url, body=json, headers=headers)
        req = httpx.Request("POST", url)
        return httpx.Response(200, request=req, json={"results": {"web": [
            {"title": "A", "url": "https://a", "contents": {"highlights": ["h1", "h2"]}},
            {"title": "B", "url": "https://b", "snippets": ["s1"]},
            {"title": "C", "url": "https://c", "description": "d"},
        ]}})

    monkeypatch.setattr(httpx, "post", fake_post)
    rows = you_search("python groupby", 2, api_key="KEY")
    assert rows == [{"title": "A", "url": "https://a", "text": "h1 h2"}, {"title": "B", "url": "https://b", "text": "s1"}]
    assert seen["url"] == "https://ydc-index.io/v1/search" and seen["headers"] == {"X-API-Key": "KEY"}
    assert seen["body"]["extraction"] == {"extraction_mode": "highlights"} and seen["body"]["count"] == 2


def test_you_search_keyless_sse(monkeypatch):
    import json as _json

    payload = {"results": {"web": [{"title": "Z", "url": "https://z", "description": "zz"}]}}
    sse = "event: message\ndata: " + _json.dumps(
        {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": _json.dumps(payload)}]}}) + "\n\n"

    def fake_post(url, json=None, headers=None, timeout=None):
        assert "profile=free" in url and json["params"]["name"] == "you-search"
        return httpx.Response(200, request=httpx.Request("POST", url), text=sse,
                              headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert you_search("q", 5, api_key=None) == [{"title": "Z", "url": "https://z", "text": "zz"}]


def test_resolve_in_inside(tmp_path):
    assert resolve_in(tmp_path, "a/b.py") == (tmp_path / "a" / "b.py").resolve()
