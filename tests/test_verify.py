"""Offline tests for ratchet.verify (owner: I1), subprocess sandbox."""
from __future__ import annotations

import pytest

from ratchet.sandbox import Sandbox
from ratchet.types import Task
from ratchet.verify import HIDDEN_TEST_FILE, run_hidden_tests, verify_reference

HIDDEN = """\
from solution import clamp


def test_inside():
    assert clamp(5, 0, 10) == 5


def test_below():
    assert clamp(-3, 0, 10) == 0


def test_above():
    assert clamp(99, 0, 10) == 10
"""
REFERENCE = "def clamp(x, lo, hi):\n    return max(lo, min(hi, x))\n"
STARTER = "def clamp(x, lo, hi):\n    raise NotImplementedError\n"


def make_task(**kw) -> Task:
    d = dict(task_id="t98_clamp", split="holdout", spec="# Clamp", starter_code=STARTER, hidden_tests=HIDDEN,
             reference_solution=REFERENCE, timeout_s=20)
    d.update(kw)
    return Task(**d)


@pytest.fixture
def sb(settings):
    return Sandbox(settings)


def test_reference_passes_starter_fails(settings, tmp_path, sb):
    task = make_task()
    ok = verify_reference(task, settings, tmp_path / "ref", sandbox=sb)
    assert ok.passed and ok.exit_code == 0 and not ok.timed_out and ok.backend == "subprocess"
    assert "3 passed" in ok.output
    bad = run_hidden_tests(task, {"solution.py": STARTER}, settings, tmp_path / "start", sandbox=sb)
    assert not bad.passed and bad.exit_code == 1 and "NotImplementedError" in bad.output
    assert (tmp_path / "start" / "verify" / HIDDEN_TEST_FILE).read_text() == HIDDEN


def test_missing_entry_file_fails_not_raises(settings, tmp_path, sb):
    res = run_hidden_tests(make_task(), {"notes.md": "hi"}, settings, tmp_path, sandbox=sb)
    assert not res.passed and res.exit_code != 0
    assert "ImportError" in res.output or "cannot import name" in res.output
    assert (tmp_path / "verify" / "solution.py").read_text() == ""


def test_timeout_task(settings, tmp_path, sb):
    task = make_task(timeout_s=2)
    looping = "def clamp(x, lo, hi):\n    while True:\n        pass\n"
    res = run_hidden_tests(task, {"solution.py": looping}, settings, tmp_path, sandbox=sb)
    assert res.timed_out and not res.passed and res.exit_code == 124


def test_worker_cannot_override_hidden_tests_or_config(settings, tmp_path, sb):
    files = {
        "solution.py": STARTER,
        "test_hidden.py": "def test_ok():\n    pass\n",
        "conftest.py": "import pytest\n@pytest.hookimpl(tryfirst=True)\ndef pytest_runtest_call(item):\n    pass\n",
        "sub/conftest.py": "x = 1\n",
        "pytest.ini": "[pytest]\naddopts = --collect-only\n",
        "pytest.py": "import sys\nsys.exit(0)\n",
        "../escape.py": "x",
    }
    res = run_hidden_tests(make_task(), files, settings, tmp_path / "r", sandbox=sb)
    assert not res.passed
    vd = tmp_path / "r" / "verify"
    assert not (vd / "conftest.py").exists() and not (vd / "pytest.ini").exists() and not (vd / "pytest.py").exists()
    assert not (vd / "sub" / "conftest.py").exists() and not (tmp_path / "r" / "escape.py").exists()


def test_exit_zero_without_summary_is_failure(settings, tmp_path, sb):
    hack = "import os\nos._exit(0)\n"
    res = run_hidden_tests(make_task(), {"solution.py": hack}, settings, tmp_path, sandbox=sb)
    assert res.exit_code == 0 and not res.passed and "without a passing summary" in res.output


def test_extra_workspace_files_available(settings, tmp_path, sb):
    files = {"solution.py": "from helpers.impl import clamp\n",
             "helpers/__init__.py": "", "helpers/impl.py": REFERENCE}
    res = run_hidden_tests(make_task(), files, settings, tmp_path, sandbox=sb)
    assert res.passed, res.output


def test_verify_dir_wiped(settings, tmp_path, sb):
    (tmp_path / "verify").mkdir()
    (tmp_path / "verify" / "stale.py").write_text("x")
    run_hidden_tests(make_task(), {"solution.py": REFERENCE}, settings, tmp_path, sandbox=sb)
    assert not (tmp_path / "verify" / "stale.py").exists()


def test_output_capped(settings, tmp_path, sb):
    noisy = REFERENCE + "\nprint('n' * 50000)\n"
    hidden = HIDDEN.replace("def test_inside():", "def test_inside():\n    print('m' * 50000)\n    assert False")
    res = run_hidden_tests(make_task(hidden_tests=hidden), {"solution.py": noisy}, settings, tmp_path, sandbox=sb)
    assert len(res.output) <= 8000 + 60 and not res.passed
