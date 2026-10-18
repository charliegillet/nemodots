"""Offline tests for ratchet.mutate (owner: I2). The planter is a scripted FakeLLM; witnesses and
hidden tests run in the subprocess sandbox (conftest forces RATCHET_SANDBOX=subprocess)."""
from __future__ import annotations

import dataclasses
import json

import pytest

from ratchet import mutate
from ratchet.bench import task_fingerprint
from ratchet.config import PLANTER_FALLBACK_MODEL, PLANTER_MODEL
from ratchet.fakes import FakeLLM, assistant
from ratchet.mutate import (PLANTER_SYSTEM, BenchCheckResult, MutantResult, check_bench, check_task,
                            decide_verdict, evaluate_mutant, load_bench_check, parse_planter_output, plant_bug,
                            usable_task_ids)
from ratchet.sandbox import Sandbox
from ratchet.types import Task, Usage

SPEC = """# Clamp

Clamp a number into a range.

## Function

```python
def clamp(x, lo, hi)
```

## Rules

- Return `lo` if `x < lo`, `hi` if `x > hi`, otherwise `x`.
- `lo > hi` raises `ValueError`.

## Examples

```python
>>> clamp(10, 0, 5)
5
```
"""

REFERENCE = '''def clamp(x, lo, hi):
    """Clamp x into [lo, hi]."""
    if lo > hi:
        raise ValueError("lo must be <= hi")
    return max(lo, min(x, hi))
'''

STARTER = '''def clamp(x, lo, hi):
    """Clamp x into [lo, hi]."""
    raise NotImplementedError
'''

STRONG_TESTS = '''import pytest

from solution import clamp


def test_inside():
    assert clamp(3, 0, 5) == 3


def test_above_upper_bound():
    assert clamp(10, 0, 5) == 5


def test_below_lower_bound():
    assert clamp(-4, 0, 5) == 0


def test_bounds_are_inclusive():
    assert clamp(5, 0, 5) == 5
    assert clamp(0, 0, 5) == 0


def test_reversed_bounds_raise():
    with pytest.raises(ValueError):
        clamp(1, 5, 0)
'''

WEAK_TESTS = '''from solution import clamp


def test_inside():
    assert clamp(3, 0, 5) == 3
'''

# A real bug (upper bound off by one), killed by STRONG_TESTS, survives WEAK_TESTS.
BUG_UPPER = REFERENCE.replace("min(x, hi)", "min(x, hi - 1)")
# A second real bug (missing validation).
BUG_NO_CHECK = REFERENCE.replace('    if lo > hi:\n        raise ValueError("lo must be <= hi")\n', "")
# Behaviourally identical to the reference: an equivalent mutant.
EQUIVALENT = REFERENCE.replace("return max(lo, min(x, hi))", "return min(hi, max(x, lo))")


def make_task(tests: str = STRONG_TESTS, reference: str = REFERENCE, task_id: str = "t99_clamp") -> Task:
    return Task(task_id=task_id, split="train", spec=SPEC, starter_code=STARTER, hidden_tests=tests,
                reference_solution=reference, timeout_s=20, tags=("test",))


# FIND/REPLACE edits producing the mutants above.
EDIT_UPPER = ("    return max(lo, min(x, hi))", "    return max(lo, min(x, hi - 1))")
EDIT_NO_CHECK = ('    if lo > hi:\n        raise ValueError("lo must be <= hi")', "    if lo > hi:\n        pass")
EDIT_EQUIV = ("    return max(lo, min(x, hi))", "    return min(hi, max(x, lo))")


def planted(code: str, witness: str, description: str = "bug") -> dict:
    return {"mutated_code": code, "witness": witness, "description": description}


def tagged_text(edit: tuple[str, str], witness: str, description: str = "bug") -> str:
    find, replace = edit
    return (f"DESCRIPTION: {description}\nWITNESS: {witness}\nFIND:\n```python\n{find}\n```\n"
            f"REPLACE:\n```python\n{replace}\n```\n")


def reply(edit: tuple[str, str], witness: str, description: str = "bug", **usage):
    """A planter answer in the tagged FIND/REPLACE format PLANTER_SYSTEM asks for."""
    return assistant(tagged_text(edit, witness, description), **usage)


def json_reply(code: str, witness: str, description: str = "bug", fenced: bool = False, **usage):
    text = json.dumps({"description": description, "witness": witness, "mutated_code": code})
    if fenced:
        text = "Here is the mutant:\n```json\n" + text + "\n```\nDone."
    return assistant(text, **usage)


@pytest.fixture
def sandbox(settings):
    return Sandbox(settings)


# --------------------------------------------------------------------------- parsing


def test_parse_plain_json():
    out = parse_planter_output(json.dumps({"description": "d", "witness": "clamp(1, 0, 5)",
                                           "mutated_code": BUG_UPPER}))
    assert out["mutated_code"] == BUG_UPPER
    assert out["witness"] == "clamp(1, 0, 5)"
    assert out["description"] == "d"


def test_parse_tagged_find_replace_format():
    out = parse_planter_output(tagged_text(EDIT_UPPER, "clamp(10, 0, 5)", "upper bound off by one"), REFERENCE)
    assert out["mutated_code"] == BUG_UPPER
    assert out["witness"] == "clamp(10, 0, 5)"
    assert out["description"] == "upper bound off by one"
    assert out["find"].strip() == EDIT_UPPER[0].strip()


def test_parse_tagged_tolerates_markdown_decoration_and_backslashes():
    ref = 'def f(ch):\n    if ch == "\\\\":\n        return 1\n    return 0\n'
    text = ("Sure!\n**DESCRIPTION:** backslash no longer special\n**WITNESS:** `f('\\\\')`\n\nFIND:\n```python\n"
            '    if ch == "\\\\":\n```\nREPLACE:\n```python\n    if ch == "/":\n```')
    out = parse_planter_output(text, ref)
    assert out["mutated_code"] == ref.replace('"\\\\"', '"/"')
    assert out["witness"] == "f('\\\\')"
    assert out["description"] == "backslash no longer special"


def test_parse_witness_in_a_fenced_block_under_its_label():
    text = ("ANALYSIS: x\nFIND:\n```python\n" + EDIT_UPPER[0] + "\n```\nREPLACE:\n```python\n" + EDIT_UPPER[1]
            + "\n```\nWITNESS:\n```python\nclamp(10, 0, 5)\n```\nDESCRIPTION: d")
    out = parse_planter_output(text, REFERENCE)
    assert out["witness"] == "clamp(10, 0, 5)" and out["mutated_code"] == BUG_UPPER
    unlabeled = ("WITNESS:\n```python\nclamp(10, 0, 5)\n```\n```python\n" + EDIT_UPPER[0] + "\n```\n```python\n"
                 + EDIT_UPPER[1] + "\n```")
    assert parse_planter_output(unlabeled, REFERENCE)["mutated_code"] == BUG_UPPER


def test_spec_rules_and_round_robin_target():
    rules = mutate.spec_rules(SPEC)
    assert rules == ["Return `lo` if `x < lo`, `hi` if `x > hi`, otherwise `x`.", "`lo > hi` raises `ValueError`."]
    task = make_task()
    assert rules[0] in mutate.build_planter_messages(task, [], 1)[1]["content"]
    assert rules[1] in mutate.build_planter_messages(task, [], 2)[1]["content"]
    assert rules[0] in mutate.build_planter_messages(task, [], 3)[1]["content"]
    from ratchet.bench import get_task
    assert len(mutate.spec_rules(get_task("t02_parse_duration").spec)) == 7


def test_witness_namespace_has_date_helpers_and_allows_imports(settings, sandbox, tmp_path):
    code = "import datetime\n\ndef f(d):\n    return d.year\n"
    assert mutate.run_witness(code, "f(date(2024, 1, 2))", entry_file="solution.py", sandbox=sandbox,
                              work_dir=tmp_path / "a") == "2024"
    assert mutate.run_witness(code, "f(datetime.date(2023, 1, 2))", entry_file="solution.py", sandbox=sandbox,
                              work_dir=tmp_path / "b") == "2023"
    assert mutate.run_witness(code, "from decimal import Decimal as D; D('1.5') * 2", entry_file="solution.py",
                              sandbox=sandbox, work_dir=tmp_path / "c") == "Decimal('3.0')"


def test_apply_edit_exact_fuzzy_and_errors():
    assert mutate.apply_edit(REFERENCE, *EDIT_UPPER) == BUG_UPPER
    # wrong indentation and trailing spaces in FIND still match one place; REPLACE is re-indented
    assert mutate.apply_edit(REFERENCE, "return max(lo, min(x, hi))   ", "return max(lo, min(x, hi - 1))") == BUG_UPPER
    with pytest.raises(ValueError, match="not found"):
        mutate.apply_edit(REFERENCE, "return x", "return y")
    with pytest.raises(ValueError, match="changes nothing"):
        mutate.apply_edit(REFERENCE, EDIT_UPPER[0], EDIT_UPPER[0] + "  ")
    with pytest.raises(ValueError, match="occurs 2 times"):
        mutate.apply_edit("a = 1\na = 1\n", "a = 1", "a = 2")
    with pytest.raises(ValueError, match="empty"):
        mutate.apply_edit(REFERENCE, "\n", "x")


def test_parse_tolerates_fences_and_prose():
    text = json_reply(BUG_UPPER, "clamp(10, 0, 5)", fenced=True).content
    out = parse_planter_output(text)
    assert out["mutated_code"] == BUG_UPPER
    text2 = 'Sure! {"description": "x", "witness": "f()", "mutated_code": "def f():\\n    return {1: 2}\\n"} hope it helps'
    assert parse_planter_output(text2)["mutated_code"] == "def f():\n    return {1: 2}\n"


def test_parse_tolerates_raw_newlines_and_alternative_keys():
    text = '{"bug": "off by one", "expression": "`clamp(10, 0, 5)`", "code": "def clamp(x, lo, hi):\n    return x\n"}'
    out = parse_planter_output(text)
    assert out["mutated_code"] == "def clamp(x, lo, hi):\n    return x\n"
    assert out["witness"] == "clamp(10, 0, 5)"
    assert out["description"] == "off by one"


def test_parse_code_inside_fences_within_json_and_separate_code_block():
    inner = json.dumps({"description": "d", "witness": ">>> clamp(1, 0, 5)",
                        "mutated_code": "```python\n" + BUG_UPPER + "```"})
    out = parse_planter_output(inner)
    assert out["mutated_code"] == BUG_UPPER
    assert out["witness"] == "clamp(1, 0, 5)"
    separate = ('{"description": "d", "witness": "clamp(10, 0, 5)"}\n\n```python\n' + BUG_UPPER + "```\n")
    assert parse_planter_output(separate)["mutated_code"] == BUG_UPPER


def test_parse_json_repairs_invalid_escapes_and_trailing_junk():
    raw = '{"description": "d", "witness": "f()", "mutated_code": "import re\\nR = re.compile(r\\"[ \\t\\v]\\")\\n"}]'
    out = parse_planter_output(raw)
    assert out["mutated_code"] == 'import re\nR = re.compile(r"[ \t\\v]")\n'


def test_parse_json_find_replace_keys():
    raw = json.dumps({"description": "d", "witness": "clamp(10, 0, 5)", "find": EDIT_UPPER[0],
                      "replace": EDIT_UPPER[1]})
    assert parse_planter_output(raw, REFERENCE)["mutated_code"] == BUG_UPPER


@pytest.mark.parametrize("text", ["", "no json here", '{"description": "d", "witness": "x"}',
                                  '{"description": "d", "mutated_code": "x = 1"}', "[1, 2, 3]",
                                  "DESCRIPTION: d\nWITNESS: clamp(1, 0, 5)\nFIND:\n```python\nnot in reference\n```\n"
                                  "REPLACE:\n```python\nx = 1\n```",
                                  "DESCRIPTION: d\nFIND:\n```python\n    return max(lo, min(x, hi))\n```\n"
                                  "REPLACE:\n```python\n    return lo\n```"])
def test_parse_rejects_unusable_output(text):
    with pytest.raises(ValueError):
        parse_planter_output(text, REFERENCE)


# --------------------------------------------------------------------------- planter call / prompt


def test_plant_bug_prompt_and_parameters(settings):
    llm = FakeLLM([reply(EDIT_UPPER, "clamp(10, 0, 5)", prompt_tokens=500, completion_tokens=80)], strict=True)
    task = make_task()
    prev = [MutantResult(attempt=1, description="dropped the validation", witness="clamp(1, 5, 0)", valid=True,
                         killed=True, reason="killed", mutated_code_path=""),
            MutantResult(attempt=2, description="no-op change", witness="clamp(1, 0, 5)", valid=False,
                         killed=None, reason="witness gives the same result", mutated_code_path="")]
    out = plant_bug(llm, task, settings, attempt=3, previous=prev, tag="bench-check:t99_clamp")
    assert out["mutated_code"] == BUG_UPPER and out["model"] == settings.planter_model
    assert "FIND" in PLANTER_SYSTEM and "REPLACE" in PLANTER_SYSTEM
    assert out["usage"].prompt_tokens == 500
    call = llm.calls[0]
    assert call["model"] == PLANTER_MODEL
    assert call["thinking"] is False
    assert call["max_tokens"] == settings.planter_max_tokens
    assert call["temperature"] == mutate.PLANTER_TEMPERATURE
    assert call["tag"] == "bench-check:t99_clamp"
    assert call["seed"] == mutate.seed_for("t99_clamp", 3)
    assert call["tools"] is None
    system, user = call["messages"]
    assert system == {"role": "system", "content": PLANTER_SYSTEM}
    assert SPEC.strip() in user["content"] and REFERENCE.strip() in user["content"]
    assert "test_above_upper_bound" not in user["content"]          # hidden tests never shown
    assert "dropped the validation" in user["content"]
    assert "no-op change" in user["content"] and "rejected" in user["content"]
    assert user["content"].index("## Specification") < user["content"].index("Bugs already planted")


def test_prompt_prefix_is_identical_across_attempts():
    task = make_task()
    first = mutate.build_planter_messages(task, [], 1)[1]["content"]
    later = mutate.build_planter_messages(task, [MutantResult(1, "d", "w", True, True, "r", "")], 2)[1]["content"]
    fixed = first.split("Suggested target")[0]
    assert REFERENCE.strip() in fixed
    assert later.startswith(fixed.rstrip("\n"))


def test_plant_bug_unparseable_raises_with_usage(settings):
    llm = FakeLLM([assistant("I cannot do that.", prompt_tokens=321)])
    with pytest.raises(mutate.PlanterOutputError) as info:
        plant_bug(llm, make_task(), settings, attempt=1, previous=[], tag="t")
    assert isinstance(info.value, ValueError)
    assert info.value.usage.prompt_tokens == 321


# --------------------------------------------------------------------------- validity / killed


def test_real_bug_is_valid_and_killed(settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(), 1, planted(BUG_UPPER, "clamp(10, 0, 5)"), settings, sandbox=sandbox,
                        work_dir=tmp_path)
    assert m.valid and m.killed is True
    assert m.witness_reference == "5" and m.witness_mutant == "4"
    assert m.killed_by == "test_above_upper_bound"
    assert (tmp_path / "mutant_1.py").read_text() == BUG_UPPER


def test_real_bug_survives_weak_suite(settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(WEAK_TESTS), 1, planted(BUG_UPPER, "clamp(10, 0, 5)"), settings,
                        sandbox=sandbox, work_dir=tmp_path)
    assert m.valid and m.killed is False
    assert m.reason.startswith("SURVIVED")


def test_exception_type_counts_as_witness_difference(settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(), 1, planted(BUG_NO_CHECK, "clamp(1, 5, 0)"), settings, sandbox=sandbox,
                        work_dir=tmp_path)
    assert m.witness_reference == "EXC:ValueError"
    assert m.valid and m.killed is True


def test_statement_witness_and_bare_names(settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(), 1, planted(BUG_UPPER, "lo = 0; solution.clamp(10, lo, 5)"), settings,
                        sandbox=sandbox, work_dir=tmp_path)
    assert m.valid, m.reason


def test_equivalent_mutant_is_invalid(settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(), 1, planted(EQUIVALENT, "clamp(3, 0, 5)"), settings, sandbox=sandbox,
                        work_dir=tmp_path)
    assert not m.valid and m.killed is None
    assert "same result" in m.reason


@pytest.mark.parametrize("code, witness, reason", [
    ("def clamp(x lo, hi):\n    return x\n", "clamp(1, 0, 5)", "does not compile"),
    (REFERENCE + "\n\n", "clamp(1, 0, 5)", "identical to the reference"),
    ("def clip(x, lo, hi):\n    return x\n", "clip(1, 0, 5)", "drops top-level names: clamp"),
    # with the weak suite BUG_UPPER survives, so only a usable witness could make it valid
    (BUG_UPPER, "x = clamp(10, 0, 5)", "must end with an expression"),
    (BUG_UPPER, "clamp(10, 0,", "not valid Python"),
    (BUG_UPPER, "clamp(3, 0, 5)", "same result"),
    ("raise RuntimeError('boom')\n" + BUG_UPPER, "clamp(10, 0, 5)", "cannot be imported"),
    ("raise RuntimeError('boom')\n" + BUG_UPPER, "clamp(10, 0,", "cannot be imported"),
])
def test_invalid_mutants(code, witness, reason, settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(WEAK_TESTS), 1, planted(code, witness), settings, sandbox=sandbox,
                        work_dir=tmp_path)
    assert not m.valid and m.killed is None
    assert reason in m.reason


@pytest.mark.parametrize("witness", ["clamp(3, 0, 5)", "clamp(10, 0,", "print(1"])
def test_killed_mutant_is_valid_even_if_the_witness_fails(witness, settings, sandbox, tmp_path):
    m = evaluate_mutant(make_task(), 1, planted(BUG_UPPER, witness), settings, sandbox=sandbox, work_dir=tmp_path)
    assert m.valid and m.killed is True
    assert m.killed_by == "test_above_upper_bound"
    assert "the failing test is the witness" in m.reason


def test_witness_that_hangs_on_mutant_is_a_difference(settings, sandbox, tmp_path, monkeypatch):
    monkeypatch.setattr(mutate, "WITNESS_TIMEOUT_S", 2)
    hang = REFERENCE.replace("    return max(lo, min(x, hi))",
                             "    while x > hi:\n        pass\n    return max(lo, min(x, hi))")
    out = mutate.run_witness(hang, "clamp(10, 0, 5)", entry_file="solution.py", sandbox=sandbox,
                             work_dir=tmp_path / "w", timeout_s=2)
    assert out == "TIMEOUT"


# --------------------------------------------------------------------------- verdicts


def test_decide_verdict_table():
    def mk(valid, killed):
        return MutantResult(1, "d", "w", valid, killed, "r", "")
    assert decide_verdict(False, [mk(True, True)] * 3) == "broken"
    assert decide_verdict(True, [mk(True, True), mk(True, True)]) == "strong"
    assert decide_verdict(True, [mk(True, True), mk(True, False)]) == "weak"
    assert decide_verdict(True, [mk(True, False)]) == "weak"
    assert decide_verdict(True, [mk(True, True), mk(False, None), mk(False, None)]) == "inconclusive"
    assert decide_verdict(True, []) == "inconclusive"


def test_check_task_strong_stops_after_n_valid_mutants(settings, sandbox):
    llm = FakeLLM([reply(EDIT_UPPER, "clamp(10, 0, 5)", "upper bound off by one"),
                   reply(EDIT_NO_CHECK, "clamp(1, 5, 0)", "validation dropped")], strict=True)
    r = check_task(make_task(), llm, settings, n_mutants=2, max_attempts=5, sandbox=sandbox)
    assert r.verdict == "strong"
    assert r.reference_passes and len(llm.calls) == 2
    assert [m.killed for m in r.mutants] == [True, True]
    assert r.usage.requests == 2 and r.usage.prompt_tokens == 200
    assert r.fingerprint == task_fingerprint(make_task())
    assert r.planter_model == settings.planter_model and r.error is None
    assert "upper bound off by one" in llm.calls[1]["messages"][1]["content"]
    assert r.mutants[0].mutated_code_path.endswith("bench_check/t99_clamp/mutant_1.py")
    assert not (settings.runs_dir / "bench_check" / "t99_clamp" / "runs").exists()   # scratch cleaned


def test_check_task_weak(settings, sandbox):
    llm = FakeLLM([reply(EDIT_UPPER, "clamp(10, 0, 5)"), reply(EDIT_NO_CHECK, "clamp(1, 5, 0)"),
                   reply(EDIT_EQUIV, "clamp(3, 0, 5)")])
    r = check_task(make_task(WEAK_TESTS), llm, settings, n_mutants=3, max_attempts=3, sandbox=sandbox)
    assert r.verdict == "weak"
    assert [m.valid for m in r.mutants] == [True, True, False]
    assert [m.killed for m in r.mutants] == [False, False, None]


def test_check_task_broken_makes_no_planter_calls(settings, sandbox):
    llm = FakeLLM([], strict=True)
    r = check_task(make_task(reference=BUG_UPPER), llm, settings, sandbox=sandbox)
    assert r.verdict == "broken" and not r.reference_passes
    assert llm.calls == [] and r.mutants == []


def test_check_task_inconclusive_when_mutants_are_equivalent_or_unparseable(settings, sandbox):
    llm = FakeLLM([reply(EDIT_EQUIV, "clamp(3, 0, 5)"), assistant("no idea", prompt_tokens=50),
                   reply(EDIT_UPPER, "clamp(10, 0, 5)")], strict=True)
    r = check_task(make_task(), llm, settings, n_mutants=2, max_attempts=3, sandbox=sandbox)
    assert r.verdict == "inconclusive"
    assert len(llm.calls) == 3
    assert [m.valid for m in r.mutants] == [False, False, True]
    assert "unparseable" in r.mutants[1].reason
    assert r.usage.requests == 3 and r.usage.prompt_tokens == 250   # failed parses are still costed


class FlakyLLM(FakeLLM):
    """Raises for the primary planter model; answers for the fallback."""

    def chat(self, **kw):
        if kw["model"] == PLANTER_MODEL:
            self.calls.append({"model": kw["model"], "raised": True})
            raise RuntimeError("max_requests_limit (orchestrator)")
        return super().chat(**kw)


def test_check_task_switches_to_fallback_model(settings, sandbox):
    llm = FlakyLLM([reply(EDIT_UPPER, "clamp(10, 0, 5)"), reply(EDIT_NO_CHECK, "clamp(1, 5, 0)")], strict=True)
    r = check_task(make_task(), llm, settings, n_mutants=2, max_attempts=4, sandbox=sandbox)
    assert [c["model"] for c in llm.calls] == [PLANTER_MODEL, PLANTER_FALLBACK_MODEL, PLANTER_FALLBACK_MODEL]
    assert r.verdict == "strong"
    assert r.planter_model == PLANTER_FALLBACK_MODEL
    assert "planter call failed" in r.mutants[0].reason
    assert r.error is None


class DeadLLM:
    def __init__(self):
        self.calls = 0

    def chat(self, **kw):
        self.calls += 1
        raise RuntimeError("connection refused")


def test_check_task_records_error_when_planter_unreachable(settings, sandbox):
    llm = DeadLLM()
    r = check_task(make_task(), llm, settings, max_attempts=3, sandbox=sandbox)
    assert llm.calls == 3
    assert r.verdict == "inconclusive"
    assert r.error and "connection refused" in r.error


# --------------------------------------------------------------------------- cache / bench


def strong_script():
    return [reply(EDIT_UPPER, "clamp(10, 0, 5)"), reply(EDIT_NO_CHECK, "clamp(1, 5, 0)")]


def test_check_bench_writes_cache_and_reuses_it(settings, sandbox):
    task = make_task()
    cache = settings.bench_check_path
    seen = []
    llm = FakeLLM(strong_script(), strict=True)
    [r] = check_bench([task], llm, settings, n_mutants=2, progress=seen.append, sandbox=sandbox)
    assert r.verdict == "strong" and seen == [r]
    doc = json.loads(cache.read_text())
    assert doc["schema"] == 1 and "updated_at" in doc and set(doc["tasks"]) == {"t99_clamp"}
    assert not list(cache.parent.glob("*.tmp"))

    again = FakeLLM([], strict=True)     # would raise if called
    seen2 = []
    [r2] = check_bench([task], again, settings, n_mutants=2, progress=seen2.append, sandbox=sandbox)
    assert again.calls == [] and r2.verdict == "strong" and seen2 == [r2]
    assert r2.to_dict() == r.to_dict()


def test_check_bench_force_bypasses_cache(settings, sandbox):
    task = make_task()
    check_bench([task], FakeLLM(strong_script(), strict=True), settings, n_mutants=2, sandbox=sandbox)
    llm = FakeLLM(strong_script(), strict=True)
    check_bench([task], llm, settings, n_mutants=2, force=True, sandbox=sandbox)
    assert len(llm.calls) == 2


def test_check_bench_rechecks_on_fingerprint_change(settings, sandbox):
    task = make_task()
    check_bench([task], FakeLLM(strong_script(), strict=True), settings, n_mutants=2, sandbox=sandbox)
    changed = dataclasses.replace(task, hidden_tests=STRONG_TESTS + "\n\ndef test_extra():\n    assert True\n")
    llm = FakeLLM(strong_script(), strict=True)
    [r] = check_bench([changed], llm, settings, n_mutants=2, sandbox=sandbox)
    assert len(llm.calls) == 2 and r.fingerprint == task_fingerprint(changed)


def test_check_bench_rechecks_entries_with_planter_errors(settings, sandbox):
    task = make_task()
    check_bench([task], DeadLLM(), settings, max_attempts=2, sandbox=sandbox)
    assert load_bench_check(settings.bench_check_path)["t99_clamp"].error
    llm = FakeLLM(strong_script(), strict=True)
    [r] = check_bench([task], llm, settings, n_mutants=2, sandbox=sandbox)
    assert len(llm.calls) == 2 and r.error is None


def test_check_bench_keeps_other_entries_and_order(settings, sandbox):
    a = make_task(task_id="t98_a")
    b = make_task(WEAK_TESTS, task_id="t97_b")
    llm = FakeLLM(strong_script() + [reply(EDIT_UPPER, "clamp(10, 0, 5)"), reply(EDIT_NO_CHECK, "clamp(1, 5, 0)")],
                  strict=True)
    results = check_bench([a, b], llm, settings, n_mutants=2, max_workers=1, sandbox=sandbox)
    assert [r.task_id for r in results] == ["t98_a", "t97_b"]
    assert [r.verdict for r in results] == ["strong", "weak"]
    check_bench([a], FakeLLM([], strict=True), settings, sandbox=sandbox)
    assert set(load_bench_check(settings.bench_check_path)) == {"t98_a", "t97_b"}


def test_load_bench_check_missing_or_corrupt(tmp_path):
    assert load_bench_check(tmp_path / "nope.json") == {}
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert load_bench_check(bad) == {}


def fake_result(task: Task, verdict: str, fingerprint: str | None = None) -> BenchCheckResult:
    return BenchCheckResult(task_id=task.task_id, fingerprint=fingerprint or task_fingerprint(task),
                            planter_model="m", reference_passes=verdict != "broken", mutants=[], verdict=verdict,
                            checked_at="2026-10-17T00:00:00.000Z", usage=Usage(requests=1, cost_usd=0.001))


def test_usable_task_ids_excludes_weak_broken_and_stale(tmp_path):
    tasks = [make_task(task_id=f"t9{i}_x") for i in range(6)]
    cache = tmp_path / "bench_check.json"
    mutate.save_bench_check(cache, {
        "t90_x": fake_result(tasks[0], "strong"),
        "t91_x": fake_result(tasks[1], "inconclusive"),
        "t92_x": fake_result(tasks[2], "weak"),
        "t93_x": fake_result(tasks[3], "broken"),
        "t94_x": fake_result(tasks[4], "strong", fingerprint="stale"),
    })
    assert usable_task_ids(cache, list(reversed(tasks))) == ["t90_x", "t91_x"]


def test_result_round_trip_and_forward_compatible_loading():
    m = MutantResult(2, "desc", "f(1)", True, False, "SURVIVED", "runs/x.py", "1", "2", "")
    r = BenchCheckResult("t99_clamp", "fp", "model", True, [m], "weak", "2026-10-17T00:00:00.000Z",
                         Usage(requests=2, prompt_tokens=10, cost_usd=0.5))
    d = json.loads(json.dumps(r.to_dict()))
    assert BenchCheckResult.from_dict(d) == r
    d["unknown_future_field"] = 1
    del d["error"]
    d["mutants"][0].pop("killed_by")
    back = BenchCheckResult.from_dict(d)
    assert back.mutants[0].killed_by == "" and back.error is None
    assert back.valid_count == 1 and back.killed_count == 0 and back.survivors == [back.mutants[0]]


def test_seed_is_deterministic():
    assert mutate.seed_for("t01_slugify", 1) == mutate.seed_for("t01_slugify", 1)
    assert mutate.seed_for("t01_slugify", 1) != mutate.seed_for("t01_slugify", 2)
    assert 0 <= mutate.seed_for("t01_slugify", 1) < 2 ** 31
