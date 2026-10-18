"""Reviewer: diagnose failed train runs and propose ONE targeted playbook edit (owner: I3).

Prompt layout (Crusoe MemoryAlloy prefix cache): ``REVIEWER_SYSTEM`` is fixed and always first; the
user message starts with the current playbook (identical for every round that shares an incumbent) and
ends with the variable parts (failed runs, rejected edits, response format). Retries append to the same
conversation so the prefix stays byte-identical.

Choices made where the plan is silent:

* ``apply_edit`` takes keyword-only ``max_chars`` / ``max_added_lines`` (defaults = ``Settings``
  defaults 6000 / 25); ``propose_edit`` passes the values from ``settings``.
* ``replace_section`` matches a heading of any level whose text equals the anchor (case-insensitive,
  ``#`` stripped) and replaces its body up to the next heading of the same or a higher level (for a
  ``## `` heading that is the next ``## `` or ``# `` line, as specified). If ``edit.text`` repeats the
  section's own heading line, that line is dropped instead of being duplicated.
* ``parse_edit`` accepts the specified nested shape ``{"diagnosis", "edit": {...}, "rationale"}`` and
  also a flat ``{"op", "anchor", "text", "rationale", "diagnosis"}`` object.
* ``leak_check`` ignores dunder names (``__init__``), very generic identifiers (shorter than 4
  characters) and starter names that are everyday words (``COMMON_WORDS``: flatten, dedent, allocate, wrap,
  ...) to avoid false positives; it also checks ``class`` names from holdout starters. ``redact_holdout``
  still redacts the everyday-word names.
* ``propose_edit`` takes an optional keyword-only ``usage_out`` list: every ChatResult's ``Usage`` is
  appended to it so the loop can account for the review cost without depending on a ledger.
* ``parse_edit`` turns literal backslash-n sequences into real newlines when the edit text has no real
  newline (Super occasionally double-escapes them inside the JSON string).
* When there are no failures (only possible when ``stop_when_train_clean`` is false), the request says
  so and asks for a general robustness improvement.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from difflib import unified_diff as _difflib_unified_diff
from typing import Any

from ratchet.config import Settings
from ratchet.types import LLM, PlaybookEdit, RunResult, Task, Transcript, Usage
from ratchet.worker import WORKER_PROTOCOL

log = logging.getLogger("ratchet.reviewer")

OPS = ("replace_section", "append_section", "replace_text")

REVIEWER_SYSTEM = """\
You are the reviewer in Ratchet, a system that improves a PLAYBOOK: a short, general markdown guide that \
is given (as the system prompt) to Python coding workers. A worker gets one small Python task at a time: \
a written spec and a starter `solution.py`. It works in a sandbox with tools (write_file, read_file, \
run_python, run_tests on its own test_*.py files, web_search, submit) and is scored by hidden pytest \
tests it never sees. A run passes only if every hidden test passes.

You are shown runs that FAILED on the TRAIN split, with the steps the worker took and the hidden test \
output. Your job:
1. Diagnose the general working habit that caused these failures (for example: skimming the rules, never \
running the code, not writing its own tests for each stated rule and example, submitting before checking \
edge cases, ignoring error types the spec asks for, misusing tools). Look for the pattern shared by \
several runs, not the details of one task.
2. Propose exactly ONE targeted edit to the playbook that would change that habit: add one section, \
replace one section, or replace one sentence.

Hard rules for the edit:
- It must be a general working practice that helps on ANY small Python task. Never mention a specific \
task, task id, function name, test name, file other than solution.py and test files, or concrete \
example values from the failed runs. The edited playbook will be tested on a sealed set of DIFFERENT \
tasks; edits that only fit the train tasks will be rejected.
- Keep it short and actionable (imperative bullet points or numbered steps). Do not add more than 25 \
lines. Do not restate what the playbook already says.
- Keep the playbook's existing headings unless you replace that exact section.
- If previously rejected edits are listed, propose something materially different.
- Every instruction must be executable with the worker's tools exactly as described in the protocol below: `run_python` takes a code STRING (not a file name; to run a file, pass code such as `import runpy; runpy.run_path("test_solution.py")`), `run_tests(path="")` runs pytest on the test_*.py files the worker wrote itself, and no tests are ever provided to the worker. Do not mention tools, files or commands the worker does not have.

Edit operations:
- "append_section": add a new section at the end. "anchor" is "" and "text" is the whole new section \
starting with a "## " heading line.
- "replace_section": replace the body of an existing section. "anchor" is the exact heading text \
(without the # characters) and "text" is the new body (without the heading line).
- "replace_text": replace one exact substring. "anchor" is a substring that occurs exactly once in the \
playbook and "text" is its replacement.

Output ONLY one JSON object, no prose and no code fences:
{"diagnosis": "<2-4 sentences: the general habit that caused the failures>", \
"edit": {"op": "append_section|replace_section|replace_text", "anchor": "<string>", "text": "<string>"}, \
"rationale": "<1-3 sentences: why this edit should raise the pass rate on unseen tasks>"}

The worker's system prompt is the playbook followed by this fixed protocol, which you cannot change (quoted verbatim between the markers):
<<<WORKER_PROTOCOL
""" + WORKER_PROTOCOL.rstrip() + """
WORKER_PROTOCOL>>>
"""

RESPONSE_FORMAT_HINT = (
    '# Respond with JSON: {"diagnosis": str, "edit": {"op": "replace_section"|"append_section"|"replace_text", '
    '"anchor": str, "text": str}, "rationale": str}'
)


class ReviewerError(RuntimeError):
    """The reviewer could not produce a valid, applicable, leak-free edit within max_attempts."""


# --------------------------------------------------------------------------- failure summaries


@dataclass
class FailureSummary:
    task_id: str
    spec_excerpt: str
    steps: list[str]
    final_test_output: str
    stop_reason: str


def _one_line(s: Any, limit: int = 100) -> str:
    text = " ".join(str(s).split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _short_args(tool: str, args: dict[str, Any]) -> str:
    if not isinstance(args, dict):
        return _one_line(args, 80)
    if tool == "write_file":
        content = str(args.get("content", ""))
        n = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
        return f"{args.get('path', '?')} ({n} lines)"
    if tool == "read_file":
        return str(args.get("path", "?"))
    if tool == "run_python":
        code = str(args.get("code", ""))
        first = next((ln for ln in code.splitlines() if ln.strip()), "")
        return f"[{len(code.splitlines())} lines] {_one_line(first, 70)}"
    if tool == "run_tests":
        return str(args.get("path", "") or "(all)")
    if tool == "web_search":
        return repr(_one_line(args.get("query", ""), 70))
    if tool == "submit":
        return repr(_one_line(args.get("summary", ""), 70))
    return _one_line(json.dumps(args, sort_keys=True, default=str), 80)


def _first_line(text: str) -> str:
    for ln in (text or "").splitlines():
        if ln.strip():
            return _one_line(ln, 110)
    return "(no output)"


def _result_gist(tool: str, result: str) -> str:
    """First meaningful line; for run_tests/run_python prefer the exit code + pytest summary line."""
    text = result or ""
    if tool in ("run_tests", "run_python"):
        m = re.search(r"exit_code:\s*(-?\d+)", text)
        summary = ""
        for ln in reversed(text.splitlines()):
            if re.search(r"\b(passed|failed|error|errors|no tests ran)\b", ln):
                summary = ln.strip(" =")
                break
        if not summary:
            err = [ln for ln in text.splitlines() if re.match(r"\s*\w*(Error|Exception)\b", ln)]
            summary = err[-1].strip() if err else ""
        parts = [f"exit {m.group(1)}" if m else "", _one_line(summary, 90)]
        gist = "; ".join(p for p in parts if p)
        return gist or _first_line(text)
    return _first_line(text)


def summarize_failure(task: Task, result: RunResult, transcript: Transcript, *, max_chars: int = 3500) -> FailureSummary:
    spec = task.spec.strip()
    spec_excerpt = spec[:600] + ("..." if len(spec) > 600 else "")
    steps = [
        f"step {s.step}: {s.tool} {_short_args(s.tool, s.arguments)} -> "
        f"{('ERROR ' + _one_line(s.error, 60) + ' | ') if s.error else ''}{_result_gist(s.tool, s.result)}"
        for s in transcript.steps
    ]
    if not steps:
        steps = ["(the worker made no tool calls)"]
    if transcript.error:
        steps.append(f"worker error: {_one_line(transcript.error, 200)}")
    tail = (result.test_output or "").strip()
    final_test_output = tail[-1200:]
    # Respect the overall budget: keep the first and last steps, drop the middle.
    budget = max_chars - len(spec_excerpt) - len(final_test_output) - 100
    if budget < 200:
        budget = 200
    if sum(len(s) + 1 for s in steps) > budget and len(steps) > 4:
        head, tail_steps = steps[:2], steps[-2:]
        middle = steps[2:-2]
        kept_mid: list[str] = []
        used = sum(len(s) + 1 for s in head + tail_steps) + 40
        for s in middle:
            if used + len(s) + 1 > budget:
                break
            kept_mid.append(s)
            used += len(s) + 1
        dropped = len(middle) - len(kept_mid)
        steps = head + kept_mid + ([f"... ({dropped} more steps omitted) ..."] if dropped else []) + tail_steps
    steps = [s[:300] for s in steps]
    return FailureSummary(task_id=task.task_id, spec_excerpt=spec_excerpt, steps=steps,
                          final_test_output=final_test_output, stop_reason=transcript.stop_reason or result.stop_reason)


def render_review_request(playbook: str, failures: list[FailureSummary], rejected: list[tuple[str, str]]) -> str:
    parts = ["# Current playbook", "```markdown", playbook.rstrip(), "```", ""]
    heads = _headings(playbook)
    if heads:
        parts.append("Existing section headings: " + "; ".join(f'"{h}"' for _, h, _ in heads))
        parts.append("")
    parts.append("# Failed runs (train)")
    if not failures:
        parts.append("(none: every train run passed. Propose one edit that makes the playbook more robust "
                     "on harder, unseen tasks.)")
    for i, f in enumerate(failures, 1):
        parts.append(f"## {i}. {f.task_id} (stop reason: {f.stop_reason})")
        parts.append("Spec (excerpt):")
        parts.append("```markdown")
        parts.append(f.spec_excerpt)
        parts.append("```")
        parts.append("Worker steps:")
        parts.extend(f"- {s}" for s in f.steps)
        parts.append("Hidden test output (tail):")
        parts.append("```text")
        parts.append(f.final_test_output or "(no output)")
        parts.append("```")
        parts.append("")
    if rejected:
        parts.append("# Previously rejected edits for this playbook (do not repeat)")
        for diff, reason in rejected:
            parts.append(f"- {reason}")
            parts.append("```diff")
            parts.append(diff.rstrip() or "(diff unavailable)")
            parts.append("```")
        parts.append("")
    parts.append(RESPONSE_FORMAT_HINT)
    return "\n".join(parts) + "\n"


# --------------------------------------------------------------------------- parsing


def _strip_fences(text: str) -> str:
    return re.sub(r"```[a-zA-Z0-9_-]*", "", text)


def _json_objects(text: str):
    dec = json.JSONDecoder()
    i = 0
    while True:
        i = text.find("{", i)
        if i < 0:
            return
        try:
            obj, end = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict):
            yield obj
        i = end


def _unescape_newlines(text: str) -> str:
    """Super sometimes double-escapes newlines inside the JSON string, so the edit arrives as one line with
    literal backslash-n sequences. Turn those back into real newlines, but only when the text has no real
    newline at all (a multi-line edit that mentions a backslash-n escape in code is left alone)."""
    if "\n" not in text.strip() and "\\n" in text:
        return text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "    ")
    return text


def parse_edit(content: str) -> PlaybookEdit:
    if not content or not content.strip():
        raise ValueError("empty response (expected one JSON object)")
    candidates = list(_json_objects(content)) or list(_json_objects(_strip_fences(content)))
    if not candidates:
        raise ValueError("no JSON object found in the response")
    errors = []
    for obj in candidates:
        edit = obj.get("edit") if isinstance(obj.get("edit"), dict) else obj
        op = edit.get("op")
        anchor = edit.get("anchor", "")
        text = edit.get("text")
        if op not in OPS:
            errors.append(f"edit.op must be one of {', '.join(OPS)} (got {op!r})")
            continue
        if anchor is None:
            anchor = ""
        if not isinstance(anchor, str):
            errors.append("edit.anchor must be a string")
            continue
        if not isinstance(text, str) or not text.strip():
            errors.append("edit.text must be a non-empty string")
            continue
        if op in ("replace_section", "replace_text") and not anchor.strip():
            errors.append(f"edit.anchor is required for {op}")
            continue
        rationale = obj.get("rationale", edit.get("rationale", ""))
        diagnosis = obj.get("diagnosis", edit.get("diagnosis", ""))
        text = _unescape_newlines(text)
        return PlaybookEdit(op=op, anchor=anchor, text=text, rationale=str(rationale or "").strip(),
                            diagnosis=str(diagnosis or "").strip())
    raise ValueError("; ".join(dict.fromkeys(errors)) or "invalid edit JSON")


# --------------------------------------------------------------------------- applying edits

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")


def _norm_heading(s: str) -> str:
    return " ".join(s.strip().strip("#").strip().split()).casefold()


def _headings(text: str) -> list[tuple[int, str, int]]:
    """[(level, heading text, line index)] outside fenced code blocks."""
    out = []
    in_fence = False
    for i, line in enumerate(text.splitlines()):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING.match(line)
        if m:
            out.append((len(m.group(1)), m.group(2).strip(), i))
    return out


def _normalize(text: str) -> str:
    return text.rstrip() + "\n"


def _added_lines(old: str, new: str) -> int:
    n = 0
    for ln in _difflib_unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=0):
        if ln.startswith("+") and not ln.startswith("+++"):
            n += 1
    return n


def apply_edit(playbook: str, edit: PlaybookEdit, *, max_chars: int = 6000, max_added_lines: int = 25) -> str:
    old = _normalize(playbook)
    text = edit.text.replace("\r\n", "\n")
    if edit.op == "replace_section":
        target = _norm_heading(edit.anchor)
        heads = _headings(old)
        match = next((h for h in heads if _norm_heading(h[1]) == target), None)
        if match is None:
            raise ValueError(f"replace_section: no heading named {edit.anchor.strip()!r} "
                             f"(existing: {', '.join(repr(h[1]) for h in heads) or 'none'})")
        level, _, idx = match
        lines = old.splitlines()
        end = len(lines)
        for lvl, _, j in heads:
            if j > idx and lvl <= level:
                end = j
                break
        body_lines = text.strip("\n").splitlines()
        if body_lines and _HEADING.match(body_lines[0]) and _norm_heading(body_lines[0]) == target:
            body_lines = body_lines[1:]
        body = "\n".join(body_lines).strip("\n")
        new_lines = lines[: idx + 1] + ([""] + body.splitlines() if body else []) + ([""] if end < len(lines) else []) + lines[end:]
        new = "\n".join(new_lines)
    elif edit.op == "append_section":
        section = text.strip("\n")
        first = section.lstrip().splitlines()[0] if section.strip() else ""
        if not first.startswith("## "):
            raise ValueError('append_section: text must start with a "## " heading line')
        new_head = _norm_heading(first)
        if any(_norm_heading(h[1]) == new_head for h in _headings(old)):
            raise ValueError(f"append_section: a section named {first[3:].strip()!r} already exists "
                             "(use replace_section)")
        new = old.rstrip() + "\n\n" + section.strip() + "\n"
    elif edit.op == "replace_text":
        if not edit.anchor:
            raise ValueError("replace_text: anchor must be a non-empty substring")
        count = old.count(edit.anchor)
        if count != 1:
            raise ValueError(f"replace_text: anchor must occur exactly once in the playbook (found {count})")
        new = old.replace(edit.anchor, text, 1)
    else:
        raise ValueError(f"unknown edit op {edit.op!r}")
    new = _normalize(re.sub(r"\n{3,}", "\n\n", new))
    if new == old:
        raise ValueError("the edit does not change the playbook")
    if len(new) > max_chars:
        raise ValueError(f"the edited playbook is {len(new)} chars, over the {max_chars} char limit")
    added = _added_lines(old, new)
    if added > max_added_lines:
        raise ValueError(f"the edit adds {added} lines, over the {max_added_lines} line limit")
    return new


def unified_diff(old: str, new: str, *, old_name: str, new_name: str) -> str:
    return "".join(_difflib_unified_diff(_normalize(old).splitlines(keepends=True),
                                         _normalize(new).splitlines(keepends=True),
                                         fromfile=old_name, tofile=new_name, n=2))


# --------------------------------------------------------------------------- leak check

_DEF = re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(", re.MULTILINE)
_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*)\s*[(:]", re.MULTILINE)
_TITLE = re.compile(r"^\s*#\s+(.+?)\s*$", re.MULTILINE)


# Starter function names that are also everyday English (programming) words. A general playbook edit such as
# "flatten nested conditions" or "wrap long lines" must not be rejected as naming a holdout task, so these
# are "soft" tokens: still redacted from anything holdout-derived the reviewer reads, but not grounds for
# rejecting an edit. Task ids, compound identifiers (to_camel, LRUCache, slugify) and spec titles stay hard.
COMMON_WORDS = frozenset({
    "add", "allocate", "append", "apply", "build", "check", "clean", "compare", "convert", "count", "decode",
    "dedent", "delete", "encode", "filter", "find", "flatten", "format", "get", "group", "indent", "insert",
    "keys", "load", "match", "matches", "merge", "normalize", "parse", "put", "read", "reduce", "remove",
    "render", "run", "search", "sort", "split", "strip", "update", "validate", "values", "wrap", "write",
})


def _leak_tokens(task: Task) -> list[tuple[str, str]]:
    """[(token, kind)] where kind is 'word' (match on identifier boundaries), 'soft' (an everyday word: redacted
    but not a leak on its own) or 'phrase' (substring)."""
    toks: list[tuple[str, str]] = [(task.task_id, "word")]
    for name in _DEF.findall(task.starter_code) + _CLASS.findall(task.starter_code):
        if name.startswith("__") or len(name) < 4:
            continue
        toks.append((name, "soft" if name.casefold() in COMMON_WORDS else "word"))
    m = _TITLE.search(task.spec or "")
    if m and len(m.group(1).strip()) >= 4:
        toks.append((m.group(1).strip(), "phrase"))
    return toks


def leak_check(text: str, holdout_tasks: list[Task]) -> list[str]:
    found: list[str] = []
    low = text.casefold()
    for task in holdout_tasks:
        for tok, kind in _leak_tokens(task):
            if tok in found or kind == "soft":
                continue
            if kind == "word":
                hit = re.search(r"(?<![A-Za-z0-9_])" + re.escape(tok) + r"(?![A-Za-z0-9_])", text, re.IGNORECASE)
            else:
                hit = tok.casefold() in low
            if hit:
                found.append(tok)
    return found


# --------------------------------------------------------------------------- proposing


def redact_holdout(text: str, holdout_tasks: list[Task]) -> str:
    """Replace every holdout task id / leak token in ``text`` with a neutral placeholder.

    Defence in depth for the sealed holdout: anything the reviewer reads that was derived from holdout
    results (gate reasons of rejected candidates) goes through this before it reaches the prompt."""
    out = text
    for task in holdout_tasks:
        for tok, kind in _leak_tokens(task):
            if kind in ("word", "soft"):
                out = re.sub(r"(?<![A-Za-z0-9_])" + re.escape(tok) + r"(?![A-Za-z0-9_])", "a holdout task", out,
                             flags=re.IGNORECASE)
            else:
                out = re.sub(re.escape(tok), "a holdout task", out, flags=re.IGNORECASE)
    # anything that still looks like a task id (tNN_name) is redacted too
    return re.sub(r"(?<![A-Za-z0-9_])t\d{2,}_[A-Za-z0-9_]+", "a holdout task", out)


def propose_edit(llm: LLM, playbook: str, failures: list[FailureSummary], *, settings: Settings,
                 holdout_tasks: list[Task], rejected: list[tuple[str, str]], tag: str,
                 max_attempts: int = 3, usage_out: list[Usage] | None = None) -> tuple[PlaybookEdit, str]:
    rejected = [(diff, redact_holdout(reason, holdout_tasks)) for diff, reason in rejected]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": REVIEWER_SYSTEM},
        {"role": "user", "content": render_review_request(playbook, failures, rejected)},
    ]
    errors: list[str] = []
    for attempt in range(1, max_attempts + 1):
        last = attempt >= 3
        thinking = False if last else settings.reviewer_thinking
        response_format = {"type": "json_object"} if last else None
        try:
            res = llm.chat(model=settings.reviewer_model, messages=messages, thinking=thinking,
                           max_tokens=settings.reviewer_max_tokens, temperature=0.4,
                           response_format=response_format, tag=tag)
        except Exception as exc:  # noqa: BLE001 - count as a failed attempt, try again
            err = f"attempt {attempt}: model call failed: {type(exc).__name__}: {str(exc)[:200]}"
            log.warning("reviewer %s", err)
            errors.append(err)
            continue
        if usage_out is not None:
            usage_out.append(res.usage)
        log.info("reviewer attempt %d: model=%s finish=%s prompt=%d completion=%d cached=%s", attempt, res.model,
                 res.finish_reason, res.usage.prompt_tokens, res.usage.completion_tokens,
                 res.usage.cached_tokens if res.usage.cached_reported else "n/a")
        try:
            edit = parse_edit(res.content)
            new_playbook = apply_edit(playbook, edit, max_chars=settings.playbook_max_chars,
                                      max_added_lines=settings.edit_max_lines)
            leaks = leak_check(edit.text, holdout_tasks)
            if leaks:
                # do not echo the matched tokens back: that would tell the reviewer which words name
                # sealed holdout tasks. The tokens are logged locally only.
                log.info("reviewer edit hit the leak check: %s", ", ".join(leaks))
                raise ValueError("the edit mentions a specific task, function or spec title; playbook edits "
                                 "must be general practices with no task-specific names")
            if not edit.rationale:
                edit.rationale = "(no rationale given)"
            return edit, new_playbook
        except ValueError as exc:
            err = f"attempt {attempt}: {exc}"
            log.info("reviewer answer rejected: %s", err)
            errors.append(err)
            messages.append({"role": "assistant", "content": res.content or "(empty response)"})
            messages.append({"role": "user", "content": (
                f"Your answer could not be used: {exc}. Respond again with ONLY the JSON object "
                '{"diagnosis": ..., "edit": {"op": ..., "anchor": ..., "text": ...}, "rationale": ...} '
                "following every rule above.")})
    raise ReviewerError("reviewer failed after %d attempts: %s" % (max_attempts, " | ".join(errors)))
