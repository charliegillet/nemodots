"""LocalWorker: Ratchet's own tool-calling loop on Crusoe + sandbox (owner: I1).

Prompt layout (fixed parts first for Crusoe's prefix cache): the system message is
``playbook.rstrip() + "\\n\\n" + WORKER_PROTOCOL`` and the tool schemas are the module constant
``ratchet.tools.TOOL_SCHEMAS``, so both are byte-identical across every call of a playbook version;
only the user message (the task) and the growing conversation vary.

``WORKER_PROTOCOL`` describes the environment and tools only. It deliberately gives no advice on
*how* to work (reading rules carefully, writing tests, edge cases): that is the playbook's job and
what the reviewer is supposed to discover.

Choices where PLAN.md is silent:
* ``ToolStep.step`` is the 1-based index of the tool execution within the run (an assistant turn
  with two tool calls produces two steps).
* A tool call whose arguments are not valid JSON is not executed; the model gets
  ``error: arguments for <tool> were not valid JSON ...`` instead.
* The ``run_tests`` circuit breaker compares outputs with pytest timings (``in 0.03s``) normalized,
  otherwise identical failures would never compare equal.
* ``final_answer`` is the last non-empty assistant text; if there is none, the ``submit`` summary.
* Any existing ``run_dir/workspace`` is wiped first so a re-run starts from the starter file.
* ``LocalWorker(..., search_enabled=True)`` is an extra keyword to turn the web_search tool off.
* A reply cut off at the length limit without a tool call gets up to ``MAX_NUDGES`` (2) nudges; when the
  cut-off text contains a half-written text-format tool call (``<function=...``) the nudge says so.
  Complete text-format tool calls are recovered into structured calls by ``CrusoeClient``.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import time
import zlib
from pathlib import Path
from typing import Any

from ratchet import interrupt
from ratchet.config import Settings
from ratchet.sandbox import Sandbox
from ratchet.tools import ToolBox
from ratchet.types import LLM, Task, ToolStep, Transcript, Usage, utcnow

log = logging.getLogger("ratchet.worker")

WORKER_PROTOCOL = """\
## Working environment (fixed protocol)

- You work alone in a sandbox workspace directory. Nobody will answer questions, so never ask for \
clarification: make reasonable decisions yourself and keep going.
- The deliverable is the starter file named in the task (normally `solution.py`) in the workspace root. \
Only files in the workspace count; code that appears only in a chat message is ignored.
- After you submit, hidden tests are run against the workspace. They import your code with \
`from solution import ...`, so keep the required names and signatures exactly as specified. \
You cannot see or run the hidden tests.
- You act only through tool calls:
  - `write_file(path, content)`: create or overwrite a whole file in the workspace.
  - `read_file(path)`: read a file from the workspace.
  - `run_python(code)`: run a Python snippet with the workspace as the current directory; returns the exit \
code, stdout and stderr. There is no network access inside the sandbox.
  - `run_tests(path="")`: run pytest on test_*.py files that you wrote in the workspace.
  - `web_search(query, count)`: search the web; only a few searches are allowed per task.
  - `submit(summary)`: finish the task. Call it exactly once, when you are done.
- You have a limited number of tool-calling turns. Repeating the same tool call with the same arguments \
several times in a row ends the task early.
"""

_TIMING_RE = re.compile(r"\bin \d+(?:\.\d+)?s\b")
NUDGE_CUT_OFF = "Your previous message was cut off. Continue by calling a tool, or call submit."
NUDGE_CUT_OFF_TOOL = ("Your previous message hit the output length limit in the middle of a tool call, so the call "
                      "was lost and nothing was written. Keep each message short: no long reasoning inside code or "
                      "comments. Make the tool call again, concisely, or call submit.")
MAX_NUDGES = 2


def seed_for(task_id: str, repeat: int) -> int:
    """Same formula as ratchet.gate.seed_for (PLAN.md 4.6); duplicated to keep the import graph acyclic."""
    return (zlib.crc32(task_id.encode()) + repeat) % 2**31


def build_system_prompt(playbook: str) -> str:
    return playbook.rstrip() + "\n\n" + WORKER_PROTOCOL


def build_task_message(task: Task) -> str:
    return (f"## Task\n{task.spec}\n\n## Starter file ({task.entry_file})\n"
            f"```python\n{task.starter_code}\n```")


def _normalize_test_output(text: str) -> str:
    return _TIMING_RE.sub("in Ns", text)


def _arguments_malformed(raw: str) -> bool:
    raw = (raw or "").strip()
    if not raw:
        return False
    try:
        return not isinstance(json.loads(raw), dict)
    except (ValueError, TypeError):
        return True


class LocalWorker:
    """Implements :class:`ratchet.types.Worker` with a Crusoe tool loop and :class:`Sandbox`."""

    name = "local"

    def __init__(self, llm: LLM, settings: Settings, sandbox: Sandbox | None = None, *,
                 search_enabled: bool = True):
        self.llm = llm
        self.settings = settings
        self.sandbox = sandbox if sandbox is not None else Sandbox(settings)
        self.search_enabled = search_enabled

    def reset(self) -> None:
        """Nothing host-side to release for the local worker."""
        return None

    def run_task(self, task: Task, playbook: str, *, version: int, repeat: int, run_dir: Path,
                 tag: str) -> Transcript:
        s = self.settings
        started_at = utcnow()
        t0 = time.monotonic()
        run_dir = Path(run_dir)
        workspace = run_dir / "workspace"
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": build_system_prompt(playbook)},
            {"role": "user", "content": build_task_message(task)},
        ]
        steps: list[ToolStep] = []
        usage = Usage()
        usage_by_model: dict[str, Usage] = {}
        stop_reason = "step_cap"
        error: str | None = None
        submit_summary = ""
        toolbox: ToolBox | None = None

        try:
            if workspace.exists():
                shutil.rmtree(workspace)
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / task.entry_file).parent.mkdir(parents=True, exist_ok=True)
            (workspace / task.entry_file).write_text(task.starter_code, encoding="utf-8")
            toolbox = ToolBox(workspace, self.sandbox, s, search_enabled=self.search_enabled, tag=tag)
            schemas = toolbox.schemas()
            seed = seed_for(task.task_id, repeat)
            signatures: list[tuple[str, str]] = []
            test_outputs: list[str] = []
            nudges = 0
            finished = False

            for _turn in range(1, s.worker_max_steps + 1):
                if interrupt.stop_requested():
                    stop_reason = "interrupted"
                    finished = True
                    break
                if time.monotonic() - t0 > s.task_wallclock_s:
                    stop_reason = "wallclock"
                    finished = True
                    break
                res = self.llm.chat(model=s.worker_model, messages=messages, tools=schemas,
                                    thinking=s.worker_thinking, max_tokens=s.worker_max_tokens,
                                    temperature=s.worker_temperature, seed=seed, tag=tag)
                messages.append(res.message)
                usage = usage + res.usage
                usage_by_model[res.model] = usage_by_model.get(res.model, Usage()) + res.usage

                if not res.tool_calls:
                    if res.finish_reason == "length" and nudges < MAX_NUDGES:
                        nudges += 1
                        lost_call = "<function=" in (res.content or "") or "<tool_call>" in (res.content or "")
                        messages.append({"role": "user", "content": NUDGE_CUT_OFF_TOOL if lost_call else NUDGE_CUT_OFF})
                        continue
                    stop_reason = "done"
                    finished = True
                    break

                for tc in res.tool_calls:
                    t_tool = time.monotonic()
                    if _arguments_malformed(tc.raw_arguments):
                        msg = f"arguments for {tc.name} were not valid JSON; send a JSON object"
                        text, err, is_submit = f"error: {msg}", msg, False
                    else:
                        outcome = toolbox.call(tc.name, tc.arguments)
                        text, err, is_submit = outcome.text, outcome.error, outcome.is_submit
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": text})
                    steps.append(ToolStep(step=len(steps) + 1, tool=tc.name, arguments=tc.arguments, result=text,
                                          duration_ms=int((time.monotonic() - t_tool) * 1000), error=err))
                    if is_submit:
                        summary = tc.arguments.get("summary")
                        submit_summary = summary if isinstance(summary, str) else ""
                        stop_reason = "done"
                        finished = True
                        break
                    signatures.append((tc.name, json.dumps(tc.arguments, sort_keys=True)))
                    if tc.name == "run_tests":
                        test_outputs.append(_normalize_test_output(text))
                    if (len(signatures) >= 3 and len(set(signatures[-3:])) == 1) or \
                            (len(test_outputs) >= 3 and len(set(test_outputs[-3:])) == 1):
                        stop_reason = "circuit_breaker"
                        finished = True
                        break
                if finished:
                    break
            if not finished:
                stop_reason = "wallclock" if time.monotonic() - t0 > s.task_wallclock_s else "step_cap"
        except interrupt.RunInterrupted:
            stop_reason = "interrupted"  # the gate discards this run instead of scoring it
        except Exception as exc:  # noqa: BLE001 - a run never raises; the workspace may still pass
            stop_reason = "error"
            error = f"{type(exc).__name__}: {exc}"[:500]
            log.warning("worker %s %s: %s", tag, task.task_id, error)

        try:
            workspace_files = toolbox.snapshot_files() if toolbox is not None else {}
        except Exception as exc:  # noqa: BLE001
            workspace_files = {}
            error = error or f"snapshot failed: {type(exc).__name__}: {exc}"[:500]

        final_answer = ""
        for m in reversed(messages):
            if m.get("role") == "assistant" and isinstance(m.get("content"), str) and m["content"].strip():
                final_answer = m["content"]
                break
        if not final_answer:
            final_answer = submit_summary

        log.debug("worker %s done stop=%s steps=%d tokens=%d", tag, stop_reason, len(steps),
                  usage.prompt_tokens + usage.completion_tokens)
        return Transcript(
            task_id=task.task_id, worker=self.name, model=s.worker_model, version=version, repeat=repeat,
            started_at=started_at, finished_at=utcnow(), messages=messages, steps=steps,
            final_answer=final_answer, stop_reason=stop_reason, usage=usage, usage_by_model=usage_by_model,
            workspace_files=workspace_files, error=error,
        )
