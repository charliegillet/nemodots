"""Offline tests for the benchmark (owner: I2). Runs every reference and starter against its hidden
tests with the subprocess sandbox (conftest forces RATCHET_SANDBOX=subprocess); no network."""
from __future__ import annotations

import dataclasses
import doctest
import json
import shutil
from pathlib import Path

import pytest

from ratchet import bench
from ratchet.bench import (SPLIT_PATH, TASKS_DIR, get_task, load_split, load_tasks, task_fingerprint,
                           validate_bench, validate_task_dir)

TRAIN_IDS = ["t01_slugify", "t02_parse_duration", "t03_merge_intervals", "t04_roman_numerals",
             "t05_csv_split_line", "t06_semver_compare", "t07_word_wrap", "t08_lru_cache", "t09_query_string",
             "t10_run_length"]
HOLDOUT_IDS = ["t11_add_months", "t12_human_size", "t13_balanced_brackets", "t14_top_k_frequent",
               "t15_spiral_matrix", "t16_camel_snake", "t17_flatten_dict", "t18_cron_match", "t19_money_split",
               "t20_dedent_lines", "t21_insert_position", "t22_json_path_get", "t23_anagram_groups",
               "t24_format_elapsed"]
ALL_IDS = TRAIN_IDS + HOLDOUT_IDS


# --------------------------------------------------------------------------- structure


def test_all_24_tasks_load_with_the_planned_ids():
    tasks = load_tasks()
    assert [t.task_id for t in tasks] == sorted(ALL_IDS)
    assert len(tasks) == 24


def test_split_json_matches_the_plan_and_every_meta():
    split = load_split()
    assert split["train"] == TRAIN_IDS
    assert split["holdout"] == HOLDOUT_IDS
    raw = json.loads(SPLIT_PATH.read_text(encoding="utf-8"))
    assert raw["schema"] == 1
    for tid in ALL_IDS:
        meta = json.loads((TASKS_DIR / tid / "meta.json").read_text(encoding="utf-8"))
        assert meta["split"] == ("train" if tid in TRAIN_IDS else "holdout"), tid


def test_split_filter():
    assert [t.task_id for t in load_tasks("train")] == TRAIN_IDS
    assert [t.task_id for t in load_tasks("holdout")] == HOLDOUT_IDS
    assert all(t.split == "holdout" for t in load_tasks("holdout"))


def test_ids_filter_sorted_and_unknown_id_raises():
    tasks = load_tasks(ids=["t12_human_size", "t01_slugify"])
    assert [t.task_id for t in tasks] == ["t01_slugify", "t12_human_size"]
    assert load_tasks("train", ids=["t12_human_size", "t01_slugify"])[0].task_id == "t01_slugify"
    assert len(load_tasks("train", ids=["t12_human_size", "t01_slugify"])) == 1
    with pytest.raises(KeyError):
        load_tasks(ids=["t99_nope"])
    with pytest.raises(ValueError):
        load_tasks("test")


def test_get_task_fields():
    t = get_task("t08_lru_cache")
    assert t.split == "train"
    assert t.entry_file == "solution.py"
    assert t.timeout_s == 20
    assert "LRUCache" in t.spec and "LRUCache" in t.starter_code
    assert "from solution import" in t.hidden_tests
    assert t.tags and all(isinstance(x, str) for x in t.tags)
    with pytest.raises(KeyError):
        get_task("t99_nope")


def test_every_task_dir_validates():
    for tid in ALL_IDS:
        assert validate_task_dir(TASKS_DIR / tid) == [], tid
    assert validate_bench() == []


def test_hidden_tests_never_appear_in_worker_visible_text():
    for t in load_tasks():
        assert "test_hidden" not in t.spec
        assert "pitfall" not in t.spec.lower()
        for line in t.hidden_tests.splitlines():
            if line.startswith("def test_"):
                assert line[4:line.index("(")] not in t.spec


def test_spec_examples_match_the_reference():
    """Every `>>>` example in spec.md's Examples section is a doctest against reference.py."""
    for t in load_tasks():
        section = t.spec.split("## Examples", 1)[1]
        section = "\n".join(line for line in section.splitlines() if not line.startswith("```"))
        globs: dict = {}
        exec(compile(t.reference_solution, f"{t.task_id}/reference.py", "exec"), globs)
        test = doctest.DocTestParser().get_doctest(section, globs, t.task_id, None, 0)
        assert len(test.examples) >= 3, t.task_id
        runner = doctest.DocTestRunner(optionflags=doctest.ELLIPSIS | doctest.IGNORE_EXCEPTION_DETAIL)
        runner.run(test, out=lambda s: None)
        assert runner.summarize(verbose=False).failed == 0, t.task_id


# --------------------------------------------------------------------------- fingerprint


def test_fingerprint_is_stable_and_changes_with_tests_or_reference():
    t = get_task("t01_slugify")
    fp = task_fingerprint(t)
    assert fp == task_fingerprint(get_task("t01_slugify"))
    assert len(fp) == 64 and int(fp, 16) >= 0
    assert task_fingerprint(dataclasses.replace(t, hidden_tests=t.hidden_tests + "\n# more\n")) != fp
    assert task_fingerprint(dataclasses.replace(t, reference_solution=t.reference_solution + "\n")) != fp
    assert task_fingerprint(dataclasses.replace(t, spec="changed")) == fp


def test_all_fingerprints_distinct():
    fps = [task_fingerprint(t) for t in load_tasks()]
    assert len(set(fps)) == len(fps)


# --------------------------------------------------------------------------- validate_task_dir


@pytest.fixture
def task_copy(tmp_path) -> Path:
    dst = tmp_path / "t03_merge_intervals"
    shutil.copytree(TASKS_DIR / "t03_merge_intervals", dst)
    return dst


def test_validate_detects_missing_file(task_copy):
    (task_copy / "reference.py").unlink()
    assert any("missing reference.py" in p for p in validate_task_dir(task_copy))


def test_validate_detects_split_disagreement(task_copy):
    meta = json.loads((task_copy / "meta.json").read_text())
    meta["split"] = "holdout"
    (task_copy / "meta.json").write_text(json.dumps(meta))
    problems = validate_task_dir(task_copy)
    assert any("disagrees with split.json" in p for p in problems)


def test_validate_detects_bad_meta_and_unlisted_task(task_copy, tmp_path):
    (task_copy / "meta.json").write_text(json.dumps({"schema": 2, "split": "train", "tags": [], "timeout_s": 0,
                                                     "pitfalls": []}))
    problems = validate_task_dir(task_copy, split_map={"train": [], "holdout": []})
    text = "\n".join(problems)
    for needle in ["schema must be 1", "tags", "timeout_s", "pitfalls", "not listed in split.json"]:
        assert needle in text


def test_validate_detects_bad_tests_and_starter(task_copy):
    (task_copy / "test_hidden.py").write_text("from other import merge_intervals\n\ndef test_one():\n    pass\n")
    (task_copy / "starter.py").write_text("def merge_intervals(intervals):\n    return []\n")
    problems = "\n".join(validate_task_dir(task_copy))
    assert "must import from `solution`" in problems
    assert "expected 8-15" in problems
    assert "NotImplementedError" in problems


def test_validate_detects_undefined_imported_name_and_syntax_error(task_copy):
    tests = (task_copy / "test_hidden.py").read_text().replace(
        "from solution import merge_intervals", "from solution import merge_intervals, split_intervals")
    (task_copy / "test_hidden.py").write_text(tests)
    (task_copy / "reference.py").write_text("def merge_intervals(:\n")
    problems = "\n".join(validate_task_dir(task_copy))
    assert "reference.py does not compile" in problems
    assert "starter.py does not define split_intervals" in problems


def test_validate_detects_missing_spec_sections(task_copy):
    (task_copy / "spec.md").write_text("Merge intervals\n\nSome text.\n")
    problems = "\n".join(validate_task_dir(task_copy))
    assert "'# Title'" in problems and "'## Rules'" in problems and "'## Examples'" in problems


# --------------------------------------------------------------------------- reference / starter behaviour


@pytest.fixture(scope="module")
def module_sandbox():
    from ratchet.config import Settings
    from ratchet.sandbox import Sandbox

    s = Settings(sandbox_backend="subprocess")   # no from_env: never read .env in a module-scoped fixture
    return s, Sandbox(s)


@pytest.mark.parametrize("task_id", ALL_IDS)
def test_reference_passes_and_starter_fails(task_id, tmp_path, module_sandbox):
    from ratchet.verify import run_hidden_tests, verify_reference

    settings, sandbox = module_sandbox
    task = get_task(task_id)
    ref = verify_reference(task, settings, tmp_path / "ref", sandbox=sandbox)
    assert ref.passed, ref.output
    assert ref.backend == "subprocess"
    assert ref.duration_s < 5, f"{task_id} hidden tests took {ref.duration_s:.1f}s"
    starter = run_hidden_tests(task, {task.entry_file: task.starter_code}, settings, tmp_path / "starter",
                               sandbox=sandbox)
    assert not starter.passed
    assert "NotImplementedError" in starter.output


def test_bench_module_exports():
    for name in ["TASKS_DIR", "load_tasks", "get_task", "validate_task_dir", "task_fingerprint"]:
        assert hasattr(bench, name)
    assert TASKS_DIR == Path(bench.__file__).parent / "tasks"
