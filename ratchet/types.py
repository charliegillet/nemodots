"""Shared contracts for Ratchet.

OWNED BY docs/PLAN.md, not by any implementer. Every module imports from here and nobody
edits this file without first changing the matching block in docs/PLAN.md. Pure stdlib,
no network, no I/O. All timestamps are ISO-8601 UTC strings ending in "Z".
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _from_dict(cls, d: dict[str, Any]):
    """Build a flat dataclass from a dict, ignoring unknown keys and using defaults for missing ones."""
    names = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in d.items() if k in names})


# --------------------------------------------------------------------------- usage / cost


@dataclass
class Usage:
    """Token and cost accounting. Summable. Attached to every LLM call, run, and version."""

    requests: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0          # prompt tokens served from Crusoe's prefix cache, when reported
    cached_reported: bool = False   # True if any response carried usage.prompt_tokens_details.cached_tokens
    cost_usd: float = 0.0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            requests=self.requests + other.requests,
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            cached_tokens=self.cached_tokens + other.cached_tokens,
            cached_reported=self.cached_reported or other.cached_reported,
            cost_usd=round(self.cost_usd + other.cost_usd, 8),
        )

    __radd__ = __add__  # so sum(usages, Usage()) works

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Usage":
        return _from_dict(cls, d)


def sum_usage(items: list[Usage]) -> Usage:
    total = Usage()
    for u in items:
        total = total + u
    return total


# --------------------------------------------------------------------------- benchmark


@dataclass(frozen=True)
class Task:
    """One benchmark task. The worker sees spec + starter_code only; hidden_tests and
    reference_solution never enter a worker prompt."""

    task_id: str                     # e.g. "t03_parse_duration"; folder name under ratchet/bench/tasks/
    split: str                       # "train" | "holdout"
    spec: str                        # markdown shown to the worker (spec.md)
    starter_code: str                # initial contents of solution.py (starter.py)
    hidden_tests: str                # pytest file contents (test_hidden.py); imports `from solution import ...`
    reference_solution: str          # a correct solution.py (reference.py)
    entry_file: str = "solution.py"  # file the worker must produce in the workspace
    timeout_s: int = 20              # hidden test wall clock cap inside the sandbox
    tags: tuple[str, ...] = ()       # e.g. ("parsing", "edge-cases")

    def to_dict(self) -> dict[str, Any]:
        d = dataclasses.asdict(self)
        d["tags"] = list(self.tags)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Task":
        d = dict(d)
        d["tags"] = tuple(d.get("tags", ()))
        return _from_dict(cls, d)


# --------------------------------------------------------------------------- llm


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]        # parsed JSON; {} if the model sent malformed JSON
    raw_arguments: str = ""          # the exact string the model sent


@dataclass
class ChatResult:
    """One chat completion, normalized. `message` is the OpenAI-format assistant message dict
    (role/content/tool_calls) ready to be appended to `messages`; reasoning is stripped from it."""

    model: str
    message: dict[str, Any]
    content: str                     # "" when the model returned null content
    reasoning: str                   # message.reasoning when present, else ""
    tool_calls: list[ToolCall]
    finish_reason: str               # "stop" | "tool_calls" | "length" | "error" | ...
    usage: Usage                     # this call only (cost already applied)
    latency_ms: int = 0
    attempts: int = 1                # 1 + number of retries
    cached_reported: bool = False


@runtime_checkable
class LLM(Protocol):
    """Implemented by ratchet.llm.CrusoeClient (real) and ratchet.fakes.FakeLLM (tests)."""

    def chat(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        thinking: bool = False,
        max_tokens: int = 2048,
        temperature: float = 0.2,
        seed: int | None = None,
        response_format: dict[str, Any] | None = None,
        tag: str = "",
    ) -> ChatResult: ...


# --------------------------------------------------------------------------- worker


@dataclass
class ToolStep:
    step: int                        # 1-based
    tool: str
    arguments: dict[str, Any]
    result: str                      # tool output as returned to the model (already truncated)
    duration_ms: int = 0
    error: str | None = None         # tool-level error message, if any


@dataclass
class Transcript:
    """Everything a worker did on one (task, version, repeat). Saved as JSON by the caller."""

    task_id: str
    worker: str                      # "local" | "openbot"
    model: str
    version: int                     # playbook version used
    repeat: int                      # 0-based
    started_at: str
    finished_at: str
    messages: list[dict[str, Any]]   # full OpenAI-format conversation incl. system + tool messages
    steps: list[ToolStep]
    final_answer: str                # last assistant text content ("" if none)
    stop_reason: str                 # "done" | "step_cap" | "circuit_breaker" | "wallclock" | "error"
    usage: Usage
    usage_by_model: dict[str, Usage] = field(default_factory=dict)
    workspace_files: dict[str, str] = field(default_factory=dict)  # relative path -> contents, at the end
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d = dataclasses.asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Transcript":
        d = dict(d)
        d["steps"] = [_from_dict(ToolStep, s) for s in d.get("steps", [])]
        d["usage"] = Usage.from_dict(d.get("usage", {}))
        d["usage_by_model"] = {k: Usage.from_dict(v) for k, v in d.get("usage_by_model", {}).items()}
        return _from_dict(cls, d)


class Worker(Protocol):
    """One implementation per host. LocalWorker (ratchet/worker.py) and OpenBotWorker
    (ratchet/workers/openbot_worker.py). The worker owns `run_dir / "workspace"`; it must
    return the final workspace file contents in Transcript.workspace_files so verification
    can run in Ratchet's own sandbox regardless of host."""

    name: str

    def run_task(
        self,
        task: Task,
        playbook: str,
        *,
        version: int,
        repeat: int,
        run_dir: Path,
        tag: str,
    ) -> Transcript: ...

    def reset(self) -> None:
        """Release / wipe any host-side state (computers, containers). Idempotent."""
        ...


# --------------------------------------------------------------------------- verification


@dataclass
class VerifyResult:
    passed: bool                     # exit_code == 0 and not timed_out
    exit_code: int
    output: str                      # combined stdout+stderr, truncated to 8000 chars
    duration_s: float
    timed_out: bool = False
    backend: str = ""                # "docker" | "subprocess"
    isolation: str = ""              # "container" | "seatbelt" | "none" (unsandboxed)


@dataclass
class RunResult:
    """One (task, version, repeat) outcome. transcript_path points at the JSON Transcript."""

    task_id: str
    version: int
    repeat: int
    passed: bool
    exit_code: int
    test_output: str                 # VerifyResult.output, truncated to 4000 chars
    transcript_path: str             # relative to repo root
    usage: Usage
    duration_s: float
    stop_reason: str
    worker: str = "local"
    split: str = ""                  # "train" | "holdout"
    sandbox: str = ""                # hidden-test isolation: "docker" | "seatbelt" | "unsandboxed" ("" = unknown)

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RunResult":
        d = dict(d)
        d["usage"] = Usage.from_dict(d.get("usage", {}))
        return _from_dict(cls, d)


# --------------------------------------------------------------------------- loop


@dataclass
class PlaybookEdit:
    """One targeted edit proposed by the reviewer. Applied by ratchet.reviewer.apply_edit."""

    op: str                          # "replace_section" | "append_section" | "replace_text"
    anchor: str                      # section heading (without '#') for *_section ops; exact substring for replace_text
    text: str                        # new section body / new section (heading + body) / replacement text
    rationale: str                   # 1-3 sentences shown in the report
    diagnosis: str = ""              # what the reviewer concluded from the failed transcripts


@dataclass
class GateDecision:
    accepted: bool
    reason: str                      # human-readable, one line
    incumbent_score: float
    candidate_score: float
    delta: float
    min_delta: float
    regressions: list[str]           # task_ids where candidate pass rate < incumbent pass rate
    improvements: list[str]          # task_ids where candidate pass rate > incumbent pass rate


@dataclass
class VersionRecord:
    """One row in runs/history.json. v0 is the seed playbook; it is evaluated on the holdout and
    becomes the first incumbent. Every later version is a candidate that was accepted or rejected."""

    version: int
    parent: int | None
    status: str                      # "incumbent" | "accepted" | "rejected" | "candidate" | "superseded" | "failed"
    round: int                       # loop round that produced it (0 for v0)
    created_at: str
    playbook_path: str               # runs/versions/vN/playbook.md
    diff_path: str | None            # runs/versions/vN/diff.patch (None for v0)
    rationale: str
    diagnosis: str
    holdout_score: float             # mean over tasks of per-task pass rate (0..1); -1.0 if not evaluated
    per_task: dict[str, float]       # task_id -> pass rate over repeats
    repeats: int
    incumbent_version: int | None    # the incumbent this candidate was compared against
    incumbent_score: float | None
    delta: float | None
    regressions: list[str]
    improvements: list[str]
    gate_reason: str
    usage: Usage                     # total: train runs that fed the reviewer + reviewer call + holdout runs
    usage_by_phase: dict[str, Usage] = field(default_factory=dict)   # "train" | "review" | "holdout"
    usage_by_model: dict[str, Usage] = field(default_factory=dict)
    worker: str = "local"
    duration_s: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "VersionRecord":
        d = dict(d)
        d["usage"] = Usage.from_dict(d.get("usage", {}))
        d["usage_by_phase"] = {k: Usage.from_dict(v) for k, v in d.get("usage_by_phase", {}).items()}
        d["usage_by_model"] = {k: Usage.from_dict(v) for k, v in d.get("usage_by_model", {}).items()}
        return _from_dict(cls, d)
