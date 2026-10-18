"""Unit tests for ratchet.reviewer (offline, FakeLLM)."""
from __future__ import annotations

import json

import pytest

from ratchet.fakes import FakeLLM, assistant
from ratchet.reviewer import (REVIEWER_SYSTEM, FailureSummary, ReviewerError, apply_edit, leak_check, parse_edit,
                              propose_edit, redact_holdout, render_review_request, summarize_failure, unified_diff)
from ratchet.types import PlaybookEdit, RunResult, Task, ToolStep, Transcript, Usage

PLAYBOOK = """# Coding worker playbook

You are a Python coding worker. Read the task, write the requested functions in `solution.py`, then call `submit`.

## Workflow
1. Read the spec.
2. Write code.

## Style
Keep it simple.
"""


def E(op, anchor, text, rationale="because"):
    return PlaybookEdit(op=op, anchor=anchor, text=text, rationale=rationale)


def holdout_task() -> Task:
    return Task(task_id="t11_add_months", split="holdout", spec="# Add Months\n\nAdd months to a date.",
                starter_code="def add_months(d, n):\n    raise NotImplementedError\n\n\ndef __init__():\n    pass\n",
                hidden_tests="", reference_solution="")


# --------------------------------------------------------------------------- apply_edit


def test_append_section():
    new = apply_edit(PLAYBOOK, E("append_section", "", "## Testing\n- Write a test for every rule.\n- Run them."))
    assert new.endswith("## Testing\n- Write a test for every rule.\n- Run them.\n")
    assert new.startswith(PLAYBOOK.rstrip())
    assert "\n\n\n" not in new


def test_append_section_errors():
    with pytest.raises(ValueError, match="must start with"):
        apply_edit(PLAYBOOK, E("append_section", "", "Testing\nstuff"))
    with pytest.raises(ValueError, match="already exists"):
        apply_edit(PLAYBOOK, E("append_section", "", "## style\nBe terse."))


def test_replace_section_body_and_heading_tolerance():
    new = apply_edit(PLAYBOOK, E("replace_section", "workflow", "1. Read every rule.\n2. Test each rule."))
    assert "## Workflow\n\n1. Read every rule.\n2. Test each rule.\n\n## Style" in new
    assert "Write code." not in new
    # text repeating the heading line is not duplicated; '#'s in the anchor are ignored
    new2 = apply_edit(PLAYBOOK, E("replace_section", "## Style", "## Style\nBe explicit."))
    assert new2.count("## Style") == 1 and new2.endswith("## Style\n\nBe explicit.\n")


def test_replace_section_missing_anchor():
    with pytest.raises(ValueError, match="no heading named"):
        apply_edit(PLAYBOOK, E("replace_section", "Testing", "x"))


def test_replace_text():
    new = apply_edit(PLAYBOOK, E("replace_text", "Keep it simple.", "Keep it simple and test edge cases."))
    assert "Keep it simple and test edge cases." in new
    with pytest.raises(ValueError, match="exactly once"):
        apply_edit(PLAYBOOK, E("replace_text", "nonexistent phrase", "x"))
    with pytest.raises(ValueError, match="exactly once"):
        apply_edit(PLAYBOOK, E("replace_text", "the", "x"))  # occurs more than once


def test_apply_edit_rejects_noop_too_long_and_too_many_lines():
    with pytest.raises(ValueError, match="does not change"):
        apply_edit(PLAYBOOK, E("replace_text", "Keep it simple.", "Keep it simple."))
    with pytest.raises(ValueError, match="char limit"):
        apply_edit(PLAYBOOK, E("append_section", "", "## Long\n" + "x" * 7000))
    many = "## Many\n" + "\n".join(f"- line {i}" for i in range(30))
    with pytest.raises(ValueError, match="line limit"):
        apply_edit(PLAYBOOK, E("append_section", "", many))
    # within custom limits it works
    assert "line 29" in apply_edit(PLAYBOOK, E("append_section", "", many), max_added_lines=40)
    with pytest.raises(ValueError):
        apply_edit(PLAYBOOK, E("delete_everything", "", "x"))


# --------------------------------------------------------------------------- parse_edit


def test_parse_edit_with_fences_and_prose():
    body = {"diagnosis": "never tested", "edit": {"op": "append_section", "anchor": "", "text": "## Testing\nTest."},
            "rationale": "tests catch edge cases"}
    content = "Here is my answer:\n```json\n" + json.dumps(body, indent=2) + "\n```\nThanks!"
    e = parse_edit(content)
    assert e.op == "append_section" and e.text == "## Testing\nTest." and e.diagnosis == "never tested"
    assert e.rationale == "tests catch edge cases"


def test_parse_edit_flat_shape_and_errors():
    e = parse_edit('{"op": "replace_text", "anchor": "a", "text": "b", "rationale": "r"}')
    assert (e.op, e.anchor, e.text, e.rationale) == ("replace_text", "a", "b", "r")
    with pytest.raises(ValueError):
        parse_edit("no json here")
    with pytest.raises(ValueError):
        parse_edit("")
    with pytest.raises(ValueError, match="op"):
        parse_edit('{"edit": {"op": "rewrite", "anchor": "", "text": "x"}}')
    with pytest.raises(ValueError, match="anchor is required"):
        parse_edit('{"edit": {"op": "replace_section", "anchor": "", "text": "x"}}')
    # a stray {} before the real object is skipped
    e2 = parse_edit('use {} braces... {"edit": {"op": "append_section", "anchor": "", "text": "## A\\nb"}}')
    assert e2.op == "append_section"


# --------------------------------------------------------------------------- leak_check / diff


def test_leak_check_catches_holdout_names():
    t = holdout_task()
    assert leak_check("When writing add_months, clamp the day.", [t]) == ["add_months"]
    assert leak_check("see T11_ADD_MONTHS", [t]) == ["t11_add_months"]
    assert leak_check("Like the add months task", [t]) == ["Add Months"]
    assert leak_check("Write tests for every rule; define __init__ carefully; add_monthsX", [t]) == []


def test_unified_diff_header_names():
    d = unified_diff("a\nb\n", "a\nc\n", old_name="v0/playbook.md", new_name="v1/playbook.md")
    assert d.startswith("--- v0/playbook.md\n+++ v1/playbook.md\n")
    assert "-b\n" in d and "+c\n" in d


# --------------------------------------------------------------------------- summaries / prompt


def _failure_fixture():
    task = Task(task_id="t01_slugify", split="train", spec="# Slugify\n\n" + "Rules. " * 200, starter_code="",
                hidden_tests="", reference_solution="")
    steps = [ToolStep(step=1, tool="write_file", arguments={"path": "solution.py", "content": "a\nb\n"},
                      result="wrote solution.py (4 bytes)"),
             ToolStep(step=2, tool="run_tests", arguments={}, result="exit_code: 5\n--- stdout ---\nno tests ran in 0.01s\n"),
             ToolStep(step=3, tool="submit", arguments={"summary": "done"}, result="submitted")]
    tr = Transcript(task_id=task.task_id, worker="local", model="m", version=0, repeat=0, started_at="", finished_at="",
                    messages=[], steps=steps, final_answer="", stop_reason="done", usage=Usage())
    res = RunResult(task_id=task.task_id, version=0, repeat=0, passed=False, exit_code=1,
                    test_output="x" * 3000 + "\nFAILED test_hidden.py::test_unicode - AssertionError", transcript_path="",
                    usage=Usage(), duration_s=1, stop_reason="done", split="train")
    return task, res, tr


def test_summarize_failure_and_render_request():
    task, res, tr = _failure_fixture()
    fs = summarize_failure(task, res, tr)
    assert fs.task_id == "t01_slugify" and fs.stop_reason == "done"
    assert len(fs.spec_excerpt) <= 603
    assert fs.steps[0].startswith("step 1: write_file solution.py (2 lines) -> wrote solution.py")
    assert "exit 5" in fs.steps[1] and "no tests ran" in fs.steps[1]
    assert len(fs.final_test_output) == 1200 and fs.final_test_output.endswith("AssertionError")

    req = render_review_request(PLAYBOOK, [fs], [("--- a\n+++ b\n+bad idea\n", "rejected: no improvement")])
    assert req.startswith("# Current playbook\n```markdown\n# Coding worker playbook")
    assert "# Failed runs (train)\n## 1. t01_slugify" in req
    assert "# Previously rejected edits for this playbook (do not repeat)\n- rejected: no improvement\n```diff" in req
    assert req.rstrip().splitlines()[-1].startswith("# Respond with JSON")
    assert '"Workflow"' in req  # existing headings listed for replace_section anchors
    empty = render_review_request(PLAYBOOK, [], [])
    assert "every train run passed" in empty and "Previously rejected" not in empty


def test_summarize_failure_respects_budget():
    task, res, tr = _failure_fixture()
    tr.steps = [ToolStep(step=i, tool="run_python", arguments={"code": "print(1)\n" * 5}, result="exit_code: 0\n" + "y" * 200)
                for i in range(1, 60)]
    fs = summarize_failure(task, res, tr, max_chars=2500)
    assert any("more steps omitted" in s for s in fs.steps)
    assert fs.steps[0].startswith("step 1:") and fs.steps[-1].startswith("step 59:")


# --------------------------------------------------------------------------- propose_edit


GOOD = json.dumps({"diagnosis": "The worker never ran tests.",
                   "edit": {"op": "append_section", "anchor": "", "text": "## Testing\n- Test every rule before submit."},
                   "rationale": "Testing rules catches edge cases."})


def test_propose_edit_success_first_try(settings):
    llm = FakeLLM([assistant(GOOD, prompt_tokens=1000, completion_tokens=200)])
    usage: list[Usage] = []
    fs = FailureSummary("t01", "spec", ["step 1: submit"], "FAILED", "done")
    edit, new = propose_edit(llm, PLAYBOOK, [fs], settings=settings, holdout_tasks=[holdout_task()], rejected=[],
                             tag="v1:review", usage_out=usage)
    assert edit.op == "append_section" and "## Testing" in new
    assert len(llm.calls) == 1
    call = llm.calls[0]
    assert call["model"] == settings.reviewer_model and call["thinking"] is True and call["tag"] == "v1:review"
    assert call["max_tokens"] == settings.reviewer_max_tokens and call["temperature"] == 0.4
    assert call["messages"][0] == {"role": "system", "content": REVIEWER_SYSTEM}
    assert call["response_format"] is None
    assert usage[0].prompt_tokens == 1000


def test_propose_edit_retries_after_bad_answer(settings):
    leaky = GOOD.replace("Test every rule", "Handle add_months clamping")
    llm = FakeLLM([assistant("I think you should test more."), assistant(leaky), assistant(GOOD)], strict=True)
    usage: list[Usage] = []
    edit, new = propose_edit(llm, PLAYBOOK, [], settings=settings, holdout_tasks=[holdout_task()], rejected=[],
                             tag="v1:review", usage_out=usage)
    assert "Test every rule" in new and len(llm.calls) == 3 and len(usage) == 3
    # the prefix (system + first user message) is identical across attempts; errors are appended
    first, third = llm.calls[0]["messages"], llm.calls[2]["messages"]
    assert third[:2] == first[:2]
    assert "could not be used" in third[3]["content"] and "specific task" in third[5]["content"]
    # the retry message must not tell the reviewer which of its words name sealed holdout tasks
    assert "add_months" not in third[5]["content"]
    # attempt 3 switches thinking off and asks for JSON mode
    assert llm.calls[2]["thinking"] is False and llm.calls[2]["response_format"] == {"type": "json_object"}
    assert llm.calls[1]["thinking"] is True


def test_propose_edit_raises_after_three_failures(settings):
    noop = json.dumps({"diagnosis": "", "edit": {"op": "replace_text", "anchor": "Keep it simple.", "text": "Keep it simple."},
                       "rationale": "noop"})
    llm = FakeLLM([assistant(noop)])
    with pytest.raises(ReviewerError, match="after 3 attempts"):
        propose_edit(llm, PLAYBOOK, [], settings=settings, holdout_tasks=[], rejected=[], tag="v1:review")
    assert len(llm.calls) == 3


def test_propose_edit_survives_llm_exceptions(settings):
    def boom(messages):
        raise RuntimeError("429 rate limited")

    llm = FakeLLM([boom, assistant(GOOD)], strict=True)
    edit, _ = propose_edit(llm, PLAYBOOK, [], settings=settings, holdout_tasks=[], rejected=[], tag="t")
    assert edit.op == "append_section" and len(llm.calls) == 2


def test_parse_edit_unescapes_double_escaped_newlines():
    import json as _json

    from ratchet.reviewer import parse_edit

    text = "You are a worker. For each task:\\n1. Read the spec.\\n2. Write tests."
    raw = _json.dumps({"diagnosis": "d", "rationale": "r",
                       "edit": {"op": "replace_text", "anchor": "x", "text": text}})
    assert parse_edit(raw).text == "You are a worker. For each task:\n1. Read the spec.\n2. Write tests."
    multi = "## Testing\n- Use `print('a\\nb')` to check output."
    raw = _json.dumps({"diagnosis": "d", "rationale": "r",
                       "edit": {"op": "append_section", "anchor": "", "text": multi}})
    assert parse_edit(raw).text == multi


# --------------------------------------------------------------------------- sealed holdout


def test_redact_holdout_removes_ids_names_and_titles():
    text = "rejected: regressed t11_add_months, t18_cron_match (add_months broke; Add Months title)"
    out = redact_holdout(text, [holdout_task()])
    assert "t11_add_months" not in out and "t18_cron_match" not in out
    assert "add_months" not in out.lower() and "add months" not in out.lower()
    assert out.startswith("rejected: regressed a holdout task")


def test_propose_edit_never_shows_holdout_ids_from_rejected_reasons(settings):
    llm = FakeLLM([assistant(GOOD)])
    rejected = [("+## Speed\n", "rejected: regressed t11_add_months (despite +5.0% overall)")]
    propose_edit(llm, PLAYBOOK, [], settings=settings, holdout_tasks=[holdout_task()], rejected=rejected, tag="v2:review")
    prompt = "\n".join(m["content"] for m in llm.calls[0]["messages"])
    assert "t11_add_months" not in prompt and "add_months" not in prompt
    assert "Previously rejected edits" in prompt and "+## Speed" in prompt


def test_reviewer_system_describes_exact_tool_signatures():
    assert "run_python(code)" in REVIEWER_SYSTEM and 'run_tests(path="")' in REVIEWER_SYSTEM
    assert "no tests are ever provided" in REVIEWER_SYSTEM


def test_leak_check_ignores_everyday_word_names_but_redacts_them():
    from ratchet.reviewer import redact_holdout

    t = Task(task_id="t17_flatten_dict", split="holdout", spec="# Flatten a nested dictionary\n",
             starter_code="def flatten(d: dict) -> dict:\n    ...\n", hidden_tests="", reference_solution="")
    assert leak_check("Flatten nested conditions before writing the loop.", [t]) == []
    assert leak_check("For t17_flatten_dict, recurse.", [t]) == ["t17_flatten_dict"]
    assert leak_check("Like the Flatten a nested dictionary task", [t]) == ["Flatten a nested dictionary"]
    assert "flatten" not in redact_holdout("regressed flatten", [t]).lower()
