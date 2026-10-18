"""Test the tests: plant bugs in each reference solution and check that the hidden tests catch them
(owner: I2, see docs/PLAN.md section 5.2).

For every task a bug planter model (Nemotron Nano Omni Reasoning on Crusoe, thinking off) receives
the spec and the correct reference solution and returns ONE subtle, realistic bug plus a *witness*:
a Python expression whose value differs between the reference and the mutant. A mutant only counts
when it is valid:

1. it compiles;
2. it differs from the reference (ignoring trailing whitespace and blank lines);
3. it still defines every top-level name the reference defines and imports cleanly;
4. its behaviour provably differs from the reference: either the hidden tests fail on it (they pass
   on the reference, so the failing test is itself a witness), or the planter's witness, evaluated
   in the sandbox against the reference and against the mutant, gives different results
   (``repr(value)`` or ``EXC:<ExceptionType>``). This rejects *equivalent mutants*, which would
   otherwise make a good suite look weak.

A valid mutant is *killed* when the hidden tests fail on it. Verdicts: ``broken`` (the reference itself
fails), ``weak`` (some valid mutant survived), ``strong`` (>= 2 valid mutants, all killed),
``inconclusive`` (fewer than 2 valid mutants). Results are cached in ``runs/bench_check.json`` keyed
by :func:`ratchet.bench.task_fingerprint`.

Choices where PLAN.md is silent (documented as required):

- Answer format (deviation from "JSON output" in PLAN.md, after live testing): asking Nemotron Nano
  Omni for the whole mutated file inside a JSON string failed most of the time (invalid escapes such
  as ``\\v``, wrong backslash escaping in backslash-heavy code, stray characters after the object,
  and "mutants" copied unchanged from the reference). The planter therefore answers with a small
  tagged format: ``ANALYSIS:`` (a few sentences of visible reasoning, which made thinking-off answers
  markedly better), one FIND/REPLACE pair of fenced code blocks, ``WITNESS:`` and ``DESCRIPTION:``;
  code needs no escaping. We apply the edit to the reference ourselves (exact match first, then a
  whitespace-tolerant line match), so the rest of the file stays byte-identical and a no-op edit is
  caught immediately. JSON answers (``mutated_code`` or ``find``/``replace`` keys) are still parsed as
  a fallback, with fences/prose stripped and invalid backslash escapes repaired.
- Validity order (deviation from PLAN.md 5.2 step 3, which requires the witness to differ for every
  valid mutant): the hidden tests run first, and a mutant they kill is valid even when the planter's
  witness is wrong or shows no difference, because tests that pass on the reference and fail on
  the mutant already prove the two behave differently. The witness is only decisive for mutants
  that survive the tests, which is exactly where equivalent mutants would cause a false "weak".
  Live runs showed the planter often plants a real bug but picks a witness input that does not reach
  it; requiring the witness for killed mutants threw those away. The witness still runs first on
  the mutant as an import check (a mutant that cannot be imported is invalid, not "killed").
- Prompt layout for the prefix cache: ``PLANTER_SYSTEM`` (fixed for every task), then the task's
  spec + reference (fixed for every attempt on a task), then the variable part (previous attempts
  with rejection reasons, a suggested rule from the spec's ``## Rules`` section rotating per attempt,
  attempt number) last.
- Witness namespace: the module's public names plus ``solution``, ``date``, ``datetime``, ``time``,
  ``timedelta``, ``timezone`` and ``Decimal`` (the module's own names win); imports are allowed since
  the witness runs in the sandbox.
- Seeds: ``(zlib.crc32(task_id) + attempt) % 2**31`` so a forced re-check is reproducible.
- ``plant_bug`` takes an optional ``model`` override and its result dict carries two extra keys,
  ``usage`` (:class:`Usage`) and ``model``. Unparseable output raises :class:`PlanterOutputError`
  (a ``ValueError`` subclass that also carries the usage, so failed attempts are still costed).
- Planter fallback: if a call to ``settings.planter_model`` raises (rate limit after retries, HTTP
  error, empty content), the remaining attempts for that task use ``PLANTER_FALLBACK_MODEL``.
- ``MutantResult`` gained ``witness_reference``, ``witness_mutant`` and ``killed_by`` (debugging aid
  for strengthening weak suites); ``BenchCheckResult`` gained ``error`` (set when the planter could
  not be reached at all). Both have defaults, so older cache files still load.
- ``check_bench`` re-checks a cached result that carries ``error`` even when its fingerprint
  matches (a planter outage should not be cached forever).
- ``check_bench`` defaults to ``max_attempts=8`` (``check_task`` keeps the planned 5): attempts stop
  as soon as ``n_mutants`` valid mutants exist, so only tasks where the planter keeps producing
  equivalent or unparseable mutants use the extra calls.
- ``check_bench(max_workers=None)`` checks tasks concurrently with ``settings.max_inflight_per_model``
  threads when ``llm`` is the thread-safe :class:`ratchet.llm.CrusoeClient`, and sequentially for
  anything else (e.g. ``FakeLLM`` in tests). The cache file is rewritten atomically after every task,
  so an interrupted run resumes where it stopped.
- Scratch directories used to run witnesses and hidden tests (``runs/bench_check/<task>/runs/``) are
  deleted after each task; ``mutant_<n>.py`` and ``attempt_<n>.json`` (planter output, no secrets)
  are kept for inspection.
"""
from __future__ import annotations

import ast
import dataclasses
import json
import logging
import os
import re
import shutil
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ratchet.bench import task_fingerprint
from ratchet.config import PLANTER_FALLBACK_MODEL, ROOT, Settings
from ratchet.types import LLM, Task, Usage, sum_usage, utcnow

log = logging.getLogger("ratchet.mutate")

SCHEMA = 1
VERDICTS = ("strong", "weak", "broken", "inconclusive")
USABLE_VERDICTS = ("strong", "inconclusive")
WITNESS_FILE = "_ratchet_witness.py"
WITNESS_MARKER = "__RATCHET_WITNESS__ "
PLANTER_TEMPERATURE = 0.7
WITNESS_TIMEOUT_S = 10
MIN_VALID_FOR_STRONG = 2

PLANTER_SYSTEM = """You are a mutation-testing engineer. You check whether a hidden test suite is strong \
enough by planting realistic bugs in a correct Python module and seeing whether the tests notice.

You receive the specification of a small Python module (`solution.py`) and a correct reference \
implementation. Plant exactly ONE bug by replacing a few lines of the reference.

What a good bug looks like:
- subtle and realistic: the kind of mistake a competent but hurried developer makes, such as an \
off-by-one error, `<` instead of `<=`, a wrong boundary, a missed edge case listed in the Rules, a \
wrong default, a wrong rounding mode, a wrong tie-break or ordering, or a skipped validation that \
should raise an exception;
- it must change the behaviour for at least one input that the specification explicitly covers;
- the replacement must really differ from the original lines.

Never do any of these:
- add special cases for magic inputs that the specification does not mention;
- rename or remove functions, classes or methods, or change their signatures;
- import modules, add printing, randomness, sleeps, file or network access;
- write code that does not compile or that loops forever;
- repeat a bug that was already planted (you will be told which ones).

The witness is ONE line of Python that shows the bug: a call of the module's public function(s) \
on a concrete input from the specification whose return value (or the type of exception it raises) \
differs between the reference and your mutant, e.g. `parse_duration("1h")`. The module's public \
names are available directly and as `solution.<name>`; `date`, `datetime`, `timedelta` and `Decimal` \
are predefined unless the module defines those names itself. Use literals, no print() and no \
internal variables of the function. For stateful classes you may write several statements \
separated by `;` as long as the last one is an expression, e.g. \
`c = LRUCache(1); c.put("a", 1); c.get("a")`.

Before answering, check that REPLACE really differs from FIND and trace the witness input through \
both versions: it must reach the changed lines and produce a different result.

Answer in exactly this format and nothing else:

ANALYSIS: <2 to 5 sentences of reasoning: which rule of the specification you will break, which \
concrete input exposes it, what the reference returns for that input and what your buggy version \
will return instead>
FIND:
```python
<1 to 6 consecutive lines copied exactly from the reference, with their indentation>
```
REPLACE:
```python
<the buggy version of those lines, with the same indentation>
```
WITNESS: <one line of Python: the input from your analysis, e.g. parse_duration("1h")>
DESCRIPTION: <one sentence: what you changed and which rule of the specification it breaks>"""

_WITNESS_SCRIPT = '''import ast, hashlib, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
MARKER = {marker!r}
SOURCE = {source!r}


def emit(text):
    text = re.sub(r" at 0x[0-9a-fA-F]+", " at 0x?", text)
    if len(text) > 2000:
        text = text[:1500] + "...sha256=" + hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
    sys.stdout.write("\\n" + MARKER + text + "\\n")
    sys.stdout.flush()


try:
    import solution
except BaseException as exc:
    emit("IMPORT_ERROR:" + type(exc).__name__)
    raise SystemExit(0)

import datetime as _dt, decimal as _decimal
namespace = {{"date": _dt.date, "datetime": _dt.datetime, "time": _dt.time, "timedelta": _dt.timedelta,
             "timezone": _dt.timezone, "Decimal": _decimal.Decimal}}
namespace["solution"] = solution
namespace.update({{k: v for k, v in vars(solution).items() if not k.startswith("_")}})
try:
    tree = ast.parse(SOURCE, mode="exec")
    last = tree.body.pop()
    exec(compile(tree, "<witness>", "exec"), namespace)
    value = eval(compile(ast.Expression(last.value), "<witness>", "eval"), namespace)
    result = repr(value)
except BaseException as exc:
    result = "EXC:" + type(exc).__name__
emit(result)
'''


# --------------------------------------------------------------------------- results


@dataclass
class MutantResult:
    attempt: int
    description: str                  # planter's description of the bug
    witness: str                      # python expression where reference and mutant differ
    valid: bool                       # compiled, differs from reference, witness outputs differ
    killed: bool | None               # hidden tests fail on the mutant (None if not valid)
    reason: str                       # why invalid / summary
    mutated_code_path: str            # runs/bench_check/<task_id>/mutant_<attempt>.py ("" if none)
    witness_reference: str = ""       # witness result on the reference
    witness_mutant: str = ""          # witness result on the mutant
    killed_by: str = ""               # first failing hidden test, when killed

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MutantResult":
        names = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


@dataclass
class BenchCheckResult:
    task_id: str
    fingerprint: str
    planter_model: str
    reference_passes: bool
    mutants: list[MutantResult]
    verdict: str                      # "strong" | "weak" | "broken" | "inconclusive"
    checked_at: str
    usage: Usage
    error: str | None = None          # planter unreachable for every attempt (result is re-checked)

    @property
    def valid_count(self) -> int:
        return sum(1 for m in self.mutants if m.valid)

    @property
    def killed_count(self) -> int:
        return sum(1 for m in self.mutants if m.valid and m.killed)

    @property
    def survivors(self) -> list[MutantResult]:
        return [m for m in self.mutants if m.valid and m.killed is False]

    def to_dict(self) -> dict[str, Any]:
        d = dataclasses.asdict(self)
        d["usage"] = self.usage.to_dict()
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "BenchCheckResult":
        d = dict(d)
        d["mutants"] = [MutantResult.from_dict(m) for m in d.get("mutants", [])]
        d["usage"] = Usage.from_dict(d.get("usage", {}))
        d.setdefault("planter_model", "")
        d.setdefault("checked_at", "")
        names = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


class PlanterOutputError(ValueError):
    """The planter answered, but not with a usable JSON mutant. Carries the call's usage."""

    def __init__(self, message: str, *, usage: Usage | None = None, model: str = "", raw: str = ""):
        super().__init__(message)
        self.usage = usage or Usage()
        self.model = model
        self.raw = raw


# --------------------------------------------------------------------------- helpers


def seed_for(task_id: str, attempt: int) -> int:
    return (zlib.crc32(task_id.encode("utf-8")) + attempt) % 2 ** 31


def _rel(path: Path) -> str:
    """Repo-relative forward-slash path when possible (PLAN.md 4.6), else absolute."""
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return Path(path).as_posix()


def _write_json_atomic(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def normalize_code(code: str) -> str:
    """Strip trailing whitespace per line and drop blank lines (used for the 'differs' check)."""
    return "\n".join(line.rstrip() for line in code.splitlines() if line.strip())


def top_level_names(code: str) -> set[str]:
    names: set[str] = set()
    for node in ast.parse(code).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
    return names


_FENCE_RE = re.compile(r"```[A-Za-z0-9_+-]*[ \t]*\n(.*?)\n?[ \t]*```", re.DOTALL)
_TAGGED_RE = re.compile(
    r"FIND\s*:?\s*\n\s*```[A-Za-z0-9_+-]*[ \t]*\n(?P<find>.*?)\n?[ \t]*```\s*"
    r"REPLACE\s*:?\s*\n\s*```[A-Za-z0-9_+-]*[ \t]*\n(?P<replace>.*?)\n?[ \t]*```",
    re.DOTALL | re.IGNORECASE)
_LINE_FIELD_RE = r"^[ \t>*#_-]*{name}[ \t*_]*:[ \t]*(.*)$"
_ESCAPE_PAIR_RE = re.compile(r"\\(.)", re.DOTALL)


def strip_fences(text: str) -> str:
    """Return the body of the first ``` fenced block if the text is (or contains only) a fenced block."""
    s = text.strip()
    if s.startswith("```"):
        m = _FENCE_RE.search(s)
        if m:
            return m.group(1)
        return s.split("\n", 1)[1] if "\n" in s else ""
    return text


def _balanced_objects(text: str):
    """Yield every top-level {...} block in `text`, string-aware (handles braces inside JSON strings)."""
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"' and depth > 0:
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0:
                yield text[start:i + 1]


_CODE_KEYS = ("mutated_code", "mutant_code", "mutated_solution", "code", "mutant", "solution")
_FIND_KEYS = ("find", "search", "original")
_REPLACE_KEYS = ("replace", "replacement", "mutated")
_DESC_KEYS = ("description", "bug", "bug_description", "explanation")
_WITNESS_KEYS = ("witness", "witness_expression", "expression")


def _first_str(obj: dict, keys: tuple[str, ...], *, allow_empty: bool = False) -> str | None:
    for k in keys:
        v = obj.get(k)
        if isinstance(v, str) and (allow_empty or v.strip()):
            return v
    return None


def _loads_lenient(text: str) -> Any:
    try:
        return json.loads(text, strict=False)
    except (json.JSONDecodeError, ValueError):
        repaired = _ESCAPE_PAIR_RE.sub(
            lambda m: m.group(0) if m.group(1) in '"\\/bfnrtu' else "\\\\" + m.group(1), text)
        return json.loads(repaired, strict=False)


def _line_field(content: str, name: str) -> str:
    m = re.search(_LINE_FIELD_RE.format(name=name), content, re.MULTILINE | re.IGNORECASE)
    if not m:
        return ""
    value = m.group(1).strip()
    if value.startswith(("**", "__")):   # "**WITNESS:** value" (markdown bold around the label)
        value = value[2:].strip()
    return value


def _fenced_field(content: str, name: str) -> str:
    """Value of a label whose content is a fenced block on the following lines (e.g. WITNESS:\n```...```)."""
    m = re.search(rf"^[ \t>*#_-]*{name}[ \t*_]*:?[ \t*_]*\n\s*```[A-Za-z0-9_+-]*[ \t]*\n(.*?)\n?[ \t]*```",
                  content, re.MULTILINE | re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else ""


def _clean_witness(witness: str) -> str:
    w = witness.strip()
    if w.startswith("```"):
        w = strip_fences(w).strip()
    if len(w) >= 2 and w[0] == "`" and w[-1] == "`":
        w = w.strip("`").strip()
    if w.startswith(">>>"):
        w = w[3:].strip()
    m = re.fullmatch(r"print\((.*)\)\s*;?", w, re.DOTALL)   # print(x) would give None on both sides
    if m:
        try:
            ast.parse(m.group(1), mode="eval")
            w = m.group(1).strip()
        except SyntaxError:
            pass
    return w


def _indent_of(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def apply_edit(reference: str, find: str, replace: str) -> str:
    """Replace the single occurrence of `find` in `reference` with `replace`.

    Exact substring match first. Otherwise match whole lines ignoring trailing whitespace and a
    uniform indentation offset, then re-indent `replace` by the same offset. Raises ValueError when
    the snippet is missing, ambiguous, or the edit changes nothing."""
    find = find.strip("\n")
    replace = replace.strip("\n")
    if not find.strip():
        raise ValueError("FIND block is empty")
    if normalize_code(find) == normalize_code(replace):
        raise ValueError("REPLACE is identical to FIND (the edit changes nothing)")
    count = reference.count(find)
    if count == 1:
        return reference.replace(find, replace, 1)
    if count > 1:
        raise ValueError(f"FIND text occurs {count} times in the reference; include more lines")
    ref_lines = reference.split("\n")
    find_lines = [ln for ln in find.split("\n")]
    while find_lines and not find_lines[-1].strip():
        find_lines.pop()
    want = [ln.strip() for ln in find_lines]
    hits = []
    for i in range(len(ref_lines) - len(want) + 1):
        if [ln.strip() for ln in ref_lines[i:i + len(want)]] == want:
            hits.append(i)
    if not hits:
        raise ValueError("FIND text not found in the reference")
    if len(hits) > 1:
        raise ValueError(f"FIND text occurs {len(hits)} times in the reference; include more lines")
    i = hits[0]
    actual_indent = _indent_of(ref_lines[i])
    given_indent = _indent_of(find_lines[0])
    new_lines = []
    for ln in replace.split("\n"):
        if ln.startswith(given_indent):
            ln = ln[len(given_indent):]
        new_lines.append(actual_indent + ln if ln.strip() else "")
    return "\n".join(ref_lines[:i] + new_lines + ref_lines[i + len(want):])


def parse_planter_output(content: str, reference: str | None = None) -> dict[str, str]:
    """Parse the planter's answer into {"mutated_code", "description", "witness"} (plus "find" and
    "replace" when the answer was an edit).

    Accepted forms: the tagged DESCRIPTION/WITNESS/FIND/REPLACE format of PLANTER_SYSTEM (needs
    `reference` to apply the edit), or a JSON object with ``mutated_code`` or ``find``/``replace``,
    optionally fenced or surrounded by prose, with raw newlines or invalid backslash escapes inside
    strings. Raises ValueError when no usable mutant can be extracted."""
    if not content or not content.strip():
        raise ValueError("empty planter output")
    out: dict[str, str] = {}
    tagged = _TAGGED_RE.search(content)
    blocks = [m.group(1) for m in _FENCE_RE.finditer(content)]
    fenced_witness = _fenced_field(content, "WITNESS")
    code_blocks = [b for b in blocks if not b.lstrip().startswith("{") and b.strip() != fenced_witness]
    has_witness_line = bool(_line_field(content, "WITNESS") or _fenced_field(content, "WITNESS"))
    if tagged or (reference is not None and has_witness_line and len(code_blocks) == 2):
        # tagged format; also accepted with the FIND:/REPLACE: labels missing (two bare code blocks)
        if reference is None:
            raise ValueError("FIND/REPLACE answer but no reference to apply it to")
        find, replace = (tagged.group("find"), tagged.group("replace")) if tagged else code_blocks
        out = {"mutated_code": apply_edit(reference, find, replace), "find": find, "replace": replace,
               "witness": _line_field(content, "WITNESS") or _fenced_field(content, "WITNESS"),
               "description": _line_field(content, "DESCRIPTION")}
    else:
        obj = None
        for cand in [strip_fences(content).strip(), *_balanced_objects(content)]:
            try:
                parsed = _loads_lenient(cand)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(parsed, dict):
                obj = parsed
                break
        if obj is None:
            raise ValueError("answer has neither FIND/REPLACE blocks nor a JSON object")
        code = _first_str(obj, _CODE_KEYS)
        find = _first_str(obj, _FIND_KEYS)
        replace = _first_str(obj, _REPLACE_KEYS, allow_empty=True)
        if code:
            out["mutated_code"] = strip_fences(code)
        elif find is not None and replace is not None and reference is not None:
            out.update(mutated_code=apply_edit(reference, strip_fences(find), strip_fences(replace)),
                       find=find, replace=replace)
        else:
            if not code_blocks:
                raise ValueError("answer has no mutated code")
            out["mutated_code"] = code_blocks[0]
        out["witness"] = _first_str(obj, _WITNESS_KEYS) or ""
        out["description"] = _first_str(obj, _DESC_KEYS) or ""
    out["witness"] = _clean_witness(out["witness"])
    if not out["witness"]:
        raise ValueError("answer has no witness")
    out["description"] = " ".join(out["description"].split())[:500] or "(no description)"
    out["mutated_code"] = out["mutated_code"].rstrip() + "\n"
    return out


def spec_rules(spec: str) -> list[str]:
    """Top-level bullets of the spec's `## Rules` section (continuation lines joined)."""
    m = re.search(r"^## Rules[^\n]*\n(.*?)(?=^## |\Z)", spec, re.MULTILINE | re.DOTALL)
    if not m:
        return []
    rules: list[str] = []
    for line in m.group(1).splitlines():
        if line.startswith(("- ", "* ")):
            rules.append(line[2:].strip())
        elif rules and line.strip() and line[:1] in (" ", "\t"):
            rules[-1] += " " + line.strip()
    return [r for r in rules if r]


def build_planter_messages(task: Task, previous: list[MutantResult], attempt: int) -> list[dict[str, str]]:
    """System prompt (fixed) + user message (task-fixed spec/reference first, variable part last).
    Each attempt suggests a different rule of the spec (round robin) to steer the planter towards
    distinct, spec-covered behaviour; it may pick another rule if that one does not suit a bug."""
    fixed = (
        f"## Specification\n\n{task.spec.strip()}\n\n"
        f"## Reference solution ({task.entry_file})\n\n```python\n{task.reference_solution.rstrip()}\n```\n"
    )
    lines = []
    if previous:
        lines.append("## Bugs already planted (do not repeat these)\n")
        for m in previous:
            note = ""
            if not m.valid:
                note = f" [rejected: {m.reason[:160]}]"
            lines.append(f"- {m.description}{note}")
        lines.append("")
    rules = spec_rules(task.spec)
    if rules:
        rule = rules[(attempt - 1) % len(rules)]
        lines.append("Suggested target (break the behaviour this rule describes; if no realistic bug fits it, "
                     f"choose another rule):\n> {rule}\n")
    lines.append(f"Plant bug #{attempt}: one new, different, realistic bug. "
                 "Answer in the ANALYSIS / FIND / REPLACE / WITNESS / DESCRIPTION format only.")
    return [
        {"role": "system", "content": PLANTER_SYSTEM},
        {"role": "user", "content": fixed + "\n" + "\n".join(lines)},
    ]


# --------------------------------------------------------------------------- planter call


def plant_bug(llm: LLM, task: Task, settings: Settings, *, attempt: int, previous: list[MutantResult],
              tag: str, model: str | None = None) -> dict:
    """One planter call. Returns {"mutated_code", "description", "witness", "usage", "model"}.
    Raises PlanterOutputError (a ValueError) when the answer cannot be parsed; exceptions from the
    LLM client itself propagate."""
    model = model or settings.planter_model
    res = llm.chat(
        model=model,
        messages=build_planter_messages(task, previous, attempt),
        thinking=settings.planter_thinking,
        max_tokens=settings.planter_max_tokens,
        temperature=PLANTER_TEMPERATURE,
        seed=seed_for(task.task_id, attempt),
        tag=tag,
    )
    content = res.content or ""
    try:
        parsed = parse_planter_output(content, task.reference_solution)
    except ValueError as first:
        try:   # thinking models sometimes leave the answer in the reasoning channel
            parsed = parse_planter_output(res.reasoning or "", task.reference_solution)
        except ValueError:
            raise PlanterOutputError(str(first), usage=res.usage, model=model, raw=content[:4000]) from None
    parsed["usage"] = res.usage
    parsed["model"] = model
    return parsed


# --------------------------------------------------------------------------- validation


def witness_syntax_error(witness: str) -> str | None:
    """None if the witness is statements-then-expression Python, else a short reason."""
    try:
        tree = ast.parse(witness, mode="exec")
    except SyntaxError as exc:
        return f"witness is not valid Python ({exc.msg})"
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        return "witness must end with an expression"
    return None


def run_witness(code: str, witness: str, *, entry_file: str, sandbox, work_dir: Path,
                timeout_s: int = WITNESS_TIMEOUT_S) -> str:
    """Evaluate `witness` against `code` in the sandbox. Returns repr(value), 'EXC:<Type>',
    'IMPORT_ERROR:<Type>', 'TIMEOUT' or 'NO_OUTPUT:<exit code>'."""
    from ratchet.sandbox import run_python_file

    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)
    (work_dir / entry_file).write_text(code, encoding="utf-8")
    (work_dir / WITNESS_FILE).write_text(
        _WITNESS_SCRIPT.format(marker=WITNESS_MARKER, source=witness), encoding="utf-8")
    res = run_python_file(sandbox, work_dir, WITNESS_FILE, timeout_s)
    if res.timed_out:
        return "TIMEOUT"
    for line in reversed((res.stdout or "").splitlines()):
        if line.startswith(WITNESS_MARKER):
            return line[len(WITNESS_MARKER):]
    return f"NO_OUTPUT:{res.exit_code}"


def _killed_by(output: str) -> str:
    m = re.search(r"(?:FAILED|ERROR) (\S+::\S+)", output or "")
    if m:
        return m.group(1).split("::", 1)[1]
    if "timed out" in (output or ""):
        return "timeout"
    if "error" in (output or "").lower():
        return "collection error"
    return "failed"


def evaluate_mutant(task: Task, attempt: int, planted: dict, settings: Settings, *, sandbox,
                    work_dir: Path) -> MutantResult:
    """Validity checks + hidden tests for one planted mutant (see module docstring)."""
    from ratchet.verify import run_hidden_tests

    code = planted["mutated_code"]
    witness = planted["witness"]
    mutant_path = work_dir / f"mutant_{attempt}.py"
    mutant_path.write_text(code, encoding="utf-8")
    result = MutantResult(attempt=attempt, description=planted["description"], witness=witness, valid=False,
                          killed=None, reason="", mutated_code_path=_rel(mutant_path))

    try:
        compile(code, task.entry_file, "exec")
    except (SyntaxError, ValueError) as exc:
        result.reason = f"does not compile: {getattr(exc, 'msg', str(exc))}"
        return result
    if normalize_code(code) == normalize_code(task.reference_solution):
        result.reason = "identical to the reference"
        return result
    missing = sorted(top_level_names(task.reference_solution) - top_level_names(code))
    if missing:
        result.reason = f"drops top-level names: {', '.join(missing)}"
        return result
    bad_witness = witness_syntax_error(witness)

    # Sandbox runs: the witness on both versions (doubles as an import check of the mutant; a
    # syntactically unusable witness is replaced by the probe "None"), then the hidden tests.
    scratch = work_dir / "runs"
    probe = witness if bad_witness is None else "None"
    mut_out = run_witness(code, probe, entry_file=task.entry_file, sandbox=sandbox,
                          work_dir=scratch / f"witness_{attempt}_mutant")
    if mut_out.startswith(("IMPORT_ERROR", "NO_OUTPUT")) or (bad_witness and mut_out == "TIMEOUT"):
        result.reason = f"mutant cannot be imported/run ({mut_out})"
        return result
    witness_note = bad_witness or ""
    witness_differs = False
    if bad_witness is None:
        ref_out = run_witness(task.reference_solution, witness, entry_file=task.entry_file, sandbox=sandbox,
                              work_dir=scratch / f"witness_{attempt}_reference")
        result.witness_reference, result.witness_mutant = ref_out, mut_out
        if ref_out == "TIMEOUT" or ref_out.startswith(("IMPORT_ERROR", "NO_OUTPUT")):
            witness_note = f"witness cannot run on the reference ({ref_out})"
        elif ref_out == mut_out:
            witness_note = f"witness gives the same result on reference and mutant ({ref_out[:120]})"
        else:
            witness_differs = True

    verdict = run_hidden_tests(task, {task.entry_file: code}, settings, scratch / f"mutant_{attempt}",
                               sandbox=sandbox)
    if not verdict.passed:
        # The hidden tests pass on the reference and fail here, so the mutant is not equivalent:
        # the failing test is itself a witness, whatever the planter's witness showed.
        result.valid, result.killed = True, True
        result.killed_by = _killed_by(verdict.output)
        result.reason = f"killed by {result.killed_by}"
        if not witness_differs:
            result.reason += f" (planter witness unusable: {witness_note[:100]}; the failing test is the witness)"
    elif witness_differs:
        result.valid, result.killed = True, False
        result.reason = (f"SURVIVED: hidden tests pass on the mutant; witness {witness!r} gives "
                         f"{result.witness_mutant[:120]} instead of {result.witness_reference[:120]}")
    else:
        result.reason = f"{witness_note}; hidden tests pass, so the mutant may be equivalent"
    return result


def decide_verdict(reference_passes: bool, mutants: list[MutantResult]) -> str:
    """PLAN.md 5.2 step 5."""
    if not reference_passes:
        return "broken"
    valid = [m for m in mutants if m.valid]
    if any(m.killed is False for m in valid):
        return "weak"
    if len(valid) >= MIN_VALID_FOR_STRONG and all(m.killed for m in valid):
        return "strong"
    return "inconclusive"


# --------------------------------------------------------------------------- one task


def check_task(task: Task, llm: LLM, settings: Settings, *, n_mutants: int = 3, max_attempts: int = 5,
               sandbox=None, work_dir: Path | None = None) -> BenchCheckResult:
    """Test one task's hidden tests with planted bugs (PLAN.md 5.2 check_task algorithm)."""
    from ratchet.sandbox import Sandbox
    from ratchet.verify import verify_reference

    sandbox = sandbox if sandbox is not None else Sandbox(settings)
    work_dir = Path(work_dir) if work_dir is not None else settings.runs_dir / "bench_check" / task.task_id
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)
    scratch = work_dir / "runs"
    fingerprint = task_fingerprint(task)
    tag = f"bench-check:{task.task_id}"

    ref = verify_reference(task, settings, scratch / "reference", sandbox=sandbox)
    if not ref.passed:
        log.warning("bench-check %s: reference fails its own hidden tests (exit %s)", task.task_id, ref.exit_code)
        (work_dir / "reference_failure.txt").write_text(ref.output, encoding="utf-8")
        shutil.rmtree(scratch, ignore_errors=True)
        return BenchCheckResult(task_id=task.task_id, fingerprint=fingerprint, planter_model=settings.planter_model,
                                reference_passes=False, mutants=[], verdict="broken", checked_at=utcnow(),
                                usage=Usage())

    model = settings.planter_model
    usages: list[Usage] = []
    mutants: list[MutantResult] = []
    call_errors: list[str] = []
    answered = 0
    for attempt in range(1, max_attempts + 1):
        if sum(1 for m in mutants if m.valid) >= n_mutants:
            break
        record: dict[str, Any] = {"schema": SCHEMA, "attempt": attempt, "model": model}
        try:
            planted = plant_bug(llm, task, settings, attempt=attempt, previous=mutants, tag=tag, model=model)
        except PlanterOutputError as exc:
            answered += 1
            usages.append(exc.usage)
            record.update(error=str(exc), raw=exc.raw)
            _write_json_atomic(work_dir / f"attempt_{attempt}.json", record)
            mutants.append(MutantResult(attempt=attempt, description="(unparseable planter output)", witness="",
                                        valid=False, killed=None, reason=f"unparseable planter output: {exc}",
                                        mutated_code_path=""))
            continue
        except Exception as exc:  # LLM client failure after its own retries
            msg = f"{type(exc).__name__}: {str(exc)[:300]}"
            call_errors.append(msg)
            log.warning("bench-check %s: planter call failed on %s (%s)", task.task_id, model, msg)
            mutants.append(MutantResult(attempt=attempt, description="(planter call failed)", witness="",
                                        valid=False, killed=None, reason=f"planter call failed: {msg}",
                                        mutated_code_path=""))
            if model != PLANTER_FALLBACK_MODEL:
                log.warning("bench-check %s: switching planter to fallback %s", task.task_id, PLANTER_FALLBACK_MODEL)
                model = PLANTER_FALLBACK_MODEL
            continue
        answered += 1
        usages.append(planted["usage"])
        record.update(description=planted["description"], witness=planted["witness"],
                      find=planted.get("find"), replace=planted.get("replace"),
                      mutated_code=planted["mutated_code"])
        _write_json_atomic(work_dir / f"attempt_{attempt}.json", record)
        mutant = evaluate_mutant(task, attempt, planted, settings, sandbox=sandbox, work_dir=work_dir)
        log.info("bench-check %s attempt %d: valid=%s killed=%s (%s)", task.task_id, attempt, mutant.valid,
                 mutant.killed, mutant.reason[:120])
        mutants.append(mutant)

    shutil.rmtree(scratch, ignore_errors=True)
    error = None
    if answered == 0 and call_errors:
        error = "planter unavailable: " + call_errors[-1]
    return BenchCheckResult(
        task_id=task.task_id,
        fingerprint=fingerprint,
        planter_model=model,
        reference_passes=True,
        mutants=mutants,
        verdict=decide_verdict(True, mutants),
        checked_at=utcnow(),
        usage=sum_usage(usages),
        error=error,
    )


# --------------------------------------------------------------------------- whole bench + cache


def _read_cache_doc(cache_path: Path) -> dict[str, Any]:
    if not cache_path.exists():
        return {}
    try:
        doc = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("bench-check cache %s unreadable (%s); ignoring it", cache_path, exc)
        return {}
    tasks = doc.get("tasks") if isinstance(doc, dict) else None
    return tasks if isinstance(tasks, dict) else {}


def load_bench_check(cache_path: Path) -> dict[str, BenchCheckResult]:
    """task_id -> cached result; {} when the file is missing or unreadable (never raises)."""
    out: dict[str, BenchCheckResult] = {}
    for tid, raw in _read_cache_doc(Path(cache_path)).items():
        try:
            out[tid] = BenchCheckResult.from_dict(raw)
        except (TypeError, KeyError, ValueError) as exc:
            log.warning("bench-check cache entry %s unreadable (%s); ignoring it", tid, exc)
    return out


def save_bench_check(cache_path: Path, results: dict[str, BenchCheckResult]) -> None:
    """Merge `results` into the cache file (other tasks' entries are kept), atomically."""
    cache_path = Path(cache_path)
    raw = _read_cache_doc(cache_path)
    for tid, r in results.items():
        raw[tid] = r.to_dict()
    _write_json_atomic(cache_path, {"schema": SCHEMA, "updated_at": utcnow(), "tasks": raw})


def _default_workers(llm: Any, settings: Settings) -> int:
    if getattr(type(llm), "__module__", "") == "ratchet.llm":
        return max(1, int(settings.max_inflight_per_model))
    return 1


def check_bench(tasks: list[Task], llm: LLM, settings: Settings, *, cache_path: Path | None = None,
                force: bool = False, progress: Callable[[BenchCheckResult], None] | None = None,
                max_workers: int | None = None, n_mutants: int = 3, max_attempts: int = 8,
                sandbox=None) -> list[BenchCheckResult]:
    """Check every task (reusing cached results whose fingerprint matches unless `force`).
    Returns results in the order of `tasks`; `progress` is called once per task (cached ones too)."""
    from ratchet.sandbox import Sandbox

    cache_path = Path(cache_path) if cache_path is not None else settings.bench_check_path
    cached = {} if force else load_bench_check(cache_path)
    results: dict[str, BenchCheckResult] = {}
    todo: list[Task] = []
    for task in tasks:
        hit = cached.get(task.task_id)
        if hit is not None and hit.fingerprint == task_fingerprint(task) and not hit.error:
            results[task.task_id] = hit
            if progress:
                progress(hit)
        else:
            todo.append(task)

    if todo:
        sandbox = sandbox if sandbox is not None else Sandbox(settings)
        _ = sandbox.backend   # resolve docker/subprocess once, before any threads start
        lock = threading.Lock()

        def work(task: Task) -> BenchCheckResult:
            r = check_task(task, llm, settings, n_mutants=n_mutants, max_attempts=max_attempts, sandbox=sandbox)
            with lock:
                save_bench_check(cache_path, {task.task_id: r})
            return r

        workers = max_workers if max_workers is not None else _default_workers(llm, settings)
        if workers <= 1 or len(todo) == 1:
            for task in todo:
                r = work(task)
                results[task.task_id] = r
                if progress:
                    progress(r)
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="bench-check") as pool:
                futures = {pool.submit(work, t): t for t in todo}
                for fut in as_completed(futures):
                    r = fut.result()
                    results[r.task_id] = r
                    if progress:
                        progress(r)
    return [results[t.task_id] for t in tasks]


def usable_task_ids(cache_path: Path, tasks: list[Task]) -> list[str]:
    """Tasks whose cached verdict is "strong" or "inconclusive" and whose fingerprint still matches; sorted."""
    cached = load_bench_check(Path(cache_path))
    ok = []
    for task in tasks:
        r = cached.get(task.task_id)
        if r is not None and r.verdict in USABLE_VERDICTS and r.fingerprint == task_fingerprint(task):
            ok.append(task.task_id)
    return sorted(ok)


def summarize(results: list[BenchCheckResult]) -> dict[str, Any]:
    """Counts per verdict plus total planter usage (for scripts and the CLI)."""
    counts = {v: 0 for v in VERDICTS}
    for r in results:
        counts[r.verdict] = counts.get(r.verdict, 0) + 1
    return {"counts": counts, "usage": sum_usage([r.usage for r in results])}


__all__ = [
    "PLANTER_SYSTEM",
    "MutantResult",
    "BenchCheckResult",
    "PlanterOutputError",
    "plant_bug",
    "parse_planter_output",
    "apply_edit",
    "build_planter_messages",
    "evaluate_mutant",
    "decide_verdict",
    "check_task",
    "check_bench",
    "load_bench_check",
    "save_bench_check",
    "usable_task_ids",
    "summarize",
]
