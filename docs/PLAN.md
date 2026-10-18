# Ratchet — build plan (v1, 2026-10-17)

Hackathon: Crusoe x Cerebral Valley "Recursive Agents" (theme: Version n+1).
Repo: `/Users/charlie/hackathons/crusoe-hackathon`, branch `charlie`.
Python package: `ratchet/`, run as `/Users/charlie/hackathons/crusoe-hackathon/.venv/bin/python -m ratchet ...`.

Four implementers (I1 runtime, I2 benchmark, I3 loop, I4 openbot) build in parallel **without talking to
each other**. Everything two owners must agree on is written down here: file paths, function signatures,
dataclasses, JSON formats, directory layouts, CLI flags, prompts' fixed/variable split, exit codes.
If this plan is silent on something, pick the simplest option that keeps the interfaces below intact and
document the choice in your module docstring. **Never edit a file you do not own** (section 2).

There is no deadline. Prefer correctness, robustness and a polished demo over speed. Ignore any
deadline-driven go/no-go advice in `docs/research/*.md`.

---

## 0. Hard rules (apply to every owner)

1. Never print, log, echo, commit or write to any file the API key or the contents of `.env`.
   `Settings.__repr__` masks keys; log `Settings` objects only through `repr`. Transcripts, ledgers and
   reports must not contain env values. If you need to prove the key is loaded, print `bool(key)`.
2. Never create accounts or sign up for any service. Any key we lack (CopilotKit Intelligence, Crusoe
   cloud access keys) is read from env; code degrades gracefully and the CLI reports it as a blocker.
3. Do not run `git commit` / `git push`. Leave the working tree for the orchestrator.
4. Install software only from official sources (PyPI, npm, Homebrew core/official taps, vendor GitHub orgs).
5. `.env` already has `CRUSOE_API_KEY`, `CRUSOE_BASE_URL`, `YOU_API_KEY`. Do not add blank or duplicate
   lines for names already present. New optional variables go in `.env.example` with empty values.
6. Unit tests (`tests/`) never touch the network and never require docker. `tests/conftest.py` (shared)
   replaces `CRUSOE_API_KEY` with a dummy, points `CRUSOE_BASE_URL` at an unroutable address, redirects
   `runs/` to a temp dir and forces the subprocess sandbox. Network/docker tests are opt-in via markers.
7. Fixed prompt parts first, variable parts last (Crusoe MemoryAlloy prefix cache). Playbook text +
   fixed protocol text + tool schemas are byte-identical across every worker call of a version.
8. Every Nemotron call goes through `ratchet.llm.CrusoeClient`, which handles the reasoning-by-default
   gotcha (`chat_template_kwargs.enable_thinking=false` unless `thinking=True`), 429/503 backoff,
   per-model concurrency and the usage/cost ledger. Nobody else constructs an `openai.OpenAI` client.

---

## 1. What we are building (so every module serves the demo)

Pitch: agent coworkers that rewrite their own playbook after failures, and keep the new version ONLY if
it scores better on a sealed holdout test set they never see.

Loop (`python -m ratchet run`):

1. **Work** — worker agents (Nemotron 3.5 Lightning on Crusoe) solve small Python tasks in a sandbox
   using tools (write/read file, run python, run tests, web search).
2. **Prove** — each task is scored by running hidden pytest tests; pass only on exit code 0.
3. **Test the tests** — a bug planter (Nemotron Nano Omni Reasoning) mutates the reference solution;
   if the hidden tests still pass, that suite is weak and the task is excluded (`bench-check`).
4. **Diagnose** — the reviewer (Nemotron 3 Super 120B) reads failed *train* transcripts.
5. **Change** — the reviewer proposes ONE targeted edit to the playbook; we store it as a unified diff.
6. **Gate** — the candidate playbook runs the sealed holdout (12 tasks x 2 repeats in DEMO). It is kept
   only if it beats the incumbent by a margin AND regresses no task the incumbent passes; else rolled back.

Demo centerpiece: `runs/report.html` — a scoreboard chart of holdout score per version (accepted versions
form a monotone "ratchet" line, rejected versions shown as hollow markers), tokens / cached tokens / cost
per version, and the latest accepted diff. Version history lives in `runs/history.json`.

Two worker hosts behind one `Worker` interface:

- `LocalWorker` (I1, `ratchet/worker.py`): our own tool-calling loop on Crusoe + sandbox. Used for unit
  tests, smoke runs, and as the fallback. Must be fully working on its own.
- `OpenBotWorker` (I4, `ratchet/workers/openbot_worker.py`): OpenBot coworkers (CopilotKit OpenBot,
  `vendor/openbot`, gitignored) doing the tasks. Default mode drives OpenBot's shipped `agent-bot` over its
  AG-UI endpoint with Ratchet acting as the surface (works today, no CopilotKit account). Full-stack mode
  (coworker on its own computer, skills API, audit log) needs a CopilotKit Intelligence key we do not have:
  implement what is possible, gate it behind an availability check, and report the blocker.

Sponsors in the story: Crusoe Managed Inference runs every model call (prefix cache + cost ledger shown
per version); NVIDIA Nemotron models fill all three roles; You.com search is a worker tool; OpenBot is the
coworker host.

---

## 2. Repository layout and ownership

```
crusoe-hackathon/
  .env, .env.example                 (exists; I1 may add commented optional vars to .env.example only)
  pyproject.toml                     SHARED (exists, from this plan; do not edit)
  docs/PLAN.md                       this file
  docs/research/*.md                 research notes (read-only)
  playbooks/v0.md                    I3  seed playbook (deliberately minimal)
  docker/sandbox/Dockerfile          I1  sandbox image (python:3.12-slim + pytest)
  ratchet/
    __init__.py                      SHARED (exists)
    types.py                         SHARED (exists) — all dataclasses + Worker/LLM protocols
    config.py                        SHARED (exists) — Settings, model ids, prices, SMOKE/DEMO
    fakes.py                         SHARED (exists) — FakeLLM, assistant(), tool_call()
    llm.py                           I1  CrusoeClient, UsageLedger, pricing, backoff
    sandbox.py                       I1  docker --network none with subprocess fallback
    tools.py                         I1  ToolBox: write_file/read_file/run_python/run_tests/web_search/submit
    worker.py                        I1  LocalWorker (tool loop, step cap, circuit breaker), WORKER_PROTOCOL
    verify.py                        I1  run hidden tests -> VerifyResult
    bench/__init__.py                I2  load_tasks(), TASKS_DIR, validate_task_dir()
    bench/split.json                 I2  {"train": [...ids], "holdout": [...ids]}
    bench/tasks/<task_id>/           I2  spec.md, starter.py, reference.py, test_hidden.py, meta.json
    mutate.py                        I2  bug planter + test-the-tests + cache (runs/bench_check.json)
    reviewer.py                      I3  diagnose failures -> PlaybookEdit; apply_edit; unified_diff; leak_check
    gate.py                          I3  evaluate(), score(), decide(), run_gate()
    store.py                         I3  runs/versions/vN/*, runs/history.json
    loop.py                          I3  one round = train -> review -> candidate -> gate (called by cli)
    report.py                        I3  self-contained HTML scoreboard
    cli.py, __main__.py              I3  commands: bench-check, run, report, ping, show, eval
    workers/__init__.py              I4  (docstring only)
    workers/openbot_worker.py        I4  OpenBotWorker (modes: "agui", "stack")
  integrations/openbot/              I4  setup.sh, stop.sh, crusoe_proxy.py, tenant/agents.yaml,
                                         tenant/skills.yaml, README.md, .env.openbot.example
  tests/
    conftest.py                      SHARED (exists)
    test_llm.py test_sandbox.py test_tools.py test_worker.py test_verify.py        I1
    test_bench.py test_mutate.py                                                   I2
    test_reviewer.py test_gate.py test_store.py test_loop.py test_report.py test_cli.py   I3
    test_openbot_worker.py test_crusoe_proxy.py                                    I4
  runs/                              generated, gitignored (versions/, history.json, report.html, ...)
  vendor/openbot                     gitignored clone (I4 works here; nothing from it is committed)
```

Ownership is by file. The only cross-owner edits allowed: none. If you believe a SHARED file is wrong,
work around it locally and write the problem into your final report; the orchestrator fixes shared files.

Import graph (who may import whom; arrows point at the dependency):

```
cli/loop/gate/report/store (I3) -> llm, worker, verify (I1) -> sandbox, tools (I1) -> types, config
cli (I3) -> bench, mutate (I2) ; mutate (I2) -> llm, sandbox, verify (I1)
cli (I3) -> workers.openbot_worker (I4, lazy import inside the "openbot" branch only)
workers.openbot_worker (I4) -> tools, sandbox, llm.UsageLedger (I1)
```

I2/I3/I4 code against the signatures in section 5 and test with `ratchet.fakes.FakeLLM`; nobody waits for
I1 to finish.

---

## 3. Environment setup (same for every owner)

```bash
cd /Users/charlie/hackathons/crusoe-hackathon
uv venv .venv --python 3.13                       # .venv already exists on this machine; skip
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/python -m pytest                        # offline unit tests
.venv/bin/python -m ratchet ping                   # one tiny call per role model (I3 implements; needs network)
docker build -t ratchet-sandbox:py312 docker/sandbox   # I1 provides; sandbox.py also builds on demand
```

Env variables read (all via `ratchet.config`): `CRUSOE_API_KEY`, `CRUSOE_BASE_URL`, `YOU_API_KEY`
(fallback `YDC_API_KEY`), optional `RATCHET_WORKER_MODEL`, `RATCHET_REVIEWER_MODEL`, `RATCHET_PLANTER_MODEL`,
`RATCHET_SANDBOX` (`auto|docker|subprocess`), `RATCHET_RUNS_DIR`. I4 adds `OPENBOT_*` / `INTELLIGENCE_*` /
`MANAGED_AGENT_TOKEN` (documented in `.env.example` as commented lines, values empty).

Model facts you must honour (verified live, see `docs/research/crusoe.md`, `nvidia.md`):

| Role | Model id (exact) | $/1M in / out / cached | Notes |
|---|---|---|---|
| worker | `nvidia/Nemotron-3.5-Lightning-30B-A3B` | 0.05 / 0.20 / 0.03 | thinking OFF, max_tokens 2048, T 0.2 |
| reviewer | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | 0.30 / 2.40 / 0.15 | thinking ON, max_tokens 8192; the only model that reports `cached_tokens` |
| planter | `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | 0.30 / 1.83 / 0.30 | thinking OFF, JSON output; fallback `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` |

- Reasoning is ON by default; a small `max_tokens` is burned in `message.reasoning` and `content` is null.
  Turn it off with `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` (also accepted:
  `reasoning_effort="none"`). Reasoning text arrives in `message.reasoning` (read via `model_dump()`).
- Tool calling works with the OpenAI `tools` parameter. **Never** send `tool_choice="required"` (500 /
  duplicate-call loop). `response_format={"type":"json_object"}` works on Super; strict `json_schema` on
  Lightning; treat JSON output from Omni as best-effort and parse defensively.
- Rate limits: 30 RPM / 500k TPM per model per project; observed 429 `max_requests_limit (orchestrator)`
  on bursts and ~4-5 effective in-flight. No `x-ratelimit-*` headers: self-throttle.
- Only Super returns `usage.prompt_tokens_details.cached_tokens`; Lightning/Omni return null -> record
  `cached_reported=False`, show "n/a" rather than 0 in the report.

---

## 4. Shared contracts (already in the repo; reproduced here verbatim)

### 4.1 `ratchet/types.py`

```python
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
```

### 4.2 `ratchet/config.py`

```python
"""Settings, model constants and loop presets for Ratchet.

OWNED BY docs/PLAN.md. Pure stdlib. Reads .env itself (no python-dotenv dependency) and never
prints secrets: Settings.__repr__ masks every *_api_key field.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # repo root (contains .env, runs/, playbooks/)

# Live Crusoe model IDs (case-sensitive; verified via GET /v1/models on 2026-10-17).
WORKER_MODEL = "nvidia/Nemotron-3.5-Lightning-30B-A3B"
REVIEWER_MODEL = "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"
PLANTER_MODEL = "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B"
PLANTER_FALLBACK_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"

# USD per 1M tokens: (prompt, completion, cached_prompt). Source of truth at runtime is
# GET /v1/models pricing; these are the fallback values when that call fails.
PRICES_PER_M: dict[str, tuple[float, float, float]] = {
    WORKER_MODEL: (0.05, 0.20, 0.03),
    REVIEWER_MODEL: (0.30, 2.40, 0.15),
    PLANTER_MODEL: (0.30, 1.83, 0.30),
    PLANTER_FALLBACK_MODEL: (0.05, 0.20, 0.03),
    "nvidia/NVIDIA-Nemotron-3.5-Super-VL": (0.10, 0.40, 0.08),
}


def load_dotenv(path: Path | None = None) -> None:
    """Load KEY=VALUE lines from .env into os.environ without overriding existing variables.
    Handles optional quotes and `export` prefixes. Never logs values."""
    path = path or ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass
class Settings:
    # credentials (never printed)
    crusoe_api_key: str = ""
    crusoe_base_url: str = "https://api.inference.crusoecloud.com/v1"
    you_api_key: str | None = None            # YOU_API_KEY or YDC_API_KEY; None -> keyless MCP fallback

    # models
    worker_model: str = WORKER_MODEL
    reviewer_model: str = REVIEWER_MODEL
    planter_model: str = PLANTER_MODEL

    # rate limiting (per model; Crusoe default tier is 30 RPM / 500k TPM per model)
    max_inflight_per_model: int = 4           # observed effective concurrency cap is ~4-5
    rpm_per_model: int = 24                   # self-imposed budget below the 30 RPM limit
    max_retries: int = 8                      # on 429/503/5xx/connection errors
    backoff_base_s: float = 1.0
    backoff_cap_s: float = 30.0
    request_timeout_s: float = 120.0

    # worker loop
    worker_max_steps: int = 12
    worker_max_tokens: int = 2048
    worker_temperature: float = 0.2
    worker_thinking: bool = False
    task_wallclock_s: int = 300
    tool_output_max_chars: int = 4000
    search_per_task_cap: int = 3

    # reviewer / planter
    reviewer_max_tokens: int = 8192
    reviewer_thinking: bool = True
    planter_max_tokens: int = 4096
    planter_thinking: bool = False
    playbook_max_chars: int = 6000
    edit_max_lines: int = 25

    # sandbox
    sandbox_backend: str = "auto"             # "auto" | "docker" | "subprocess"
    sandbox_image: str = "ratchet-sandbox:py312"
    sandbox_timeout_s: int = 30
    sandbox_memory: str = "512m"
    sandbox_cpus: str = "1"

    # paths (relative to ROOT unless absolute)
    runs_dir: Path = field(default_factory=lambda: ROOT / "runs")
    playbooks_dir: Path = field(default_factory=lambda: ROOT / "playbooks")
    bench_check_path: Path = field(default_factory=lambda: ROOT / "runs" / "bench_check.json")

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        s = cls()
        s.crusoe_api_key = os.environ.get("CRUSOE_API_KEY", "")
        s.crusoe_base_url = os.environ.get("CRUSOE_BASE_URL", s.crusoe_base_url).rstrip("/")
        s.you_api_key = os.environ.get("YOU_API_KEY") or os.environ.get("YDC_API_KEY") or None
        s.worker_model = os.environ.get("RATCHET_WORKER_MODEL", s.worker_model)
        s.reviewer_model = os.environ.get("RATCHET_REVIEWER_MODEL", s.reviewer_model)
        s.planter_model = os.environ.get("RATCHET_PLANTER_MODEL", s.planter_model)
        s.sandbox_backend = os.environ.get("RATCHET_SANDBOX", s.sandbox_backend)
        if os.environ.get("RATCHET_RUNS_DIR"):
            s.runs_dir = Path(os.environ["RATCHET_RUNS_DIR"])
            s.bench_check_path = s.runs_dir / "bench_check.json"
        return s

    def __repr__(self) -> str:  # never leak keys
        parts = []
        for f in fields(self):
            v = getattr(self, f.name)
            if f.name.endswith("_api_key"):
                v = "<set>" if v else "<unset>"
            parts.append(f"{f.name}={v!r}")
        return "Settings(" + ", ".join(parts) + ")"


@dataclass
class LoopConfig:
    """What one `ratchet run` does. Task lists are ids; None means 'all tasks in that split
    that passed bench-check'. Sizes cap the list (deterministic: sorted task_id order)."""

    name: str
    rounds: int                         # number of propose->gate iterations
    repeats: int                        # runs per holdout task per version (K)
    holdout_size: int | None            # cap on holdout tasks (None = all strong holdout tasks)
    train_size: int | None              # cap on train tasks run per round to collect failures
    train_repeats: int = 1
    min_delta: float | None = None      # None -> 1 / (n_holdout_tasks * repeats): one net run gained
    max_failures_to_reviewer: int = 4   # failed train transcripts shown to the reviewer
    stop_when_train_clean: bool = True  # stop early if the incumbent passes every train task


SMOKE = LoopConfig(
    name="smoke", rounds=1, repeats=1, holdout_size=3, train_size=3, min_delta=1e-9,
    max_failures_to_reviewer=2, stop_when_train_clean=False,
)

DEMO = LoopConfig(
    name="demo", rounds=6, repeats=2, holdout_size=12, train_size=10, min_delta=0.05,
    max_failures_to_reviewer=4, stop_when_train_clean=True,
)

CONFIGS: dict[str, LoopConfig] = {"smoke": SMOKE, "demo": DEMO}
```

### 4.3 `ratchet/fakes.py`

```python
"""Test doubles shared by every owner's unit tests. OWNED BY docs/PLAN.md. No network.

FakeLLM returns scripted ChatResults in order (cycling the last one when the script runs out
unless strict=True) and records every call so tests can assert on prompts.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from ratchet.types import ChatResult, ToolCall, Usage


def assistant(content: str, *, model: str = "fake", finish_reason: str = "stop",
              prompt_tokens: int = 100, completion_tokens: int = 20) -> ChatResult:
    """A plain assistant text reply."""
    return ChatResult(
        model=model,
        message={"role": "assistant", "content": content},
        content=content,
        reasoning="",
        tool_calls=[],
        finish_reason=finish_reason,
        usage=Usage(requests=1, prompt_tokens=prompt_tokens, completion_tokens=completion_tokens),
    )


def tool_call(name: str, arguments: dict[str, Any], *, content: str = "", model: str = "fake",
              call_id: str | None = None) -> ChatResult:
    """An assistant reply that calls exactly one tool."""
    cid = call_id or f"call_{uuid.uuid4().hex[:8]}"
    raw = json.dumps(arguments)
    return ChatResult(
        model=model,
        message={
            "role": "assistant",
            "content": content or None,
            "tool_calls": [{"id": cid, "type": "function", "function": {"name": name, "arguments": raw}}],
        },
        content=content,
        reasoning="",
        tool_calls=[ToolCall(id=cid, name=name, arguments=arguments, raw_arguments=raw)],
        finish_reason="tool_calls",
        usage=Usage(requests=1, prompt_tokens=100, completion_tokens=30),
    )


class FakeLLM:
    """Scripted LLM. `script` items are ChatResults or callables (messages -> ChatResult)."""

    def __init__(self, script: list[Any], *, strict: bool = False):
        self.script = list(script)
        self.strict = strict
        self.calls: list[dict[str, Any]] = []
        self._i = 0

    def chat(self, *, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
             thinking: bool = False, max_tokens: int = 2048, temperature: float = 0.2,
             seed: int | None = None, response_format: dict[str, Any] | None = None,
             tag: str = "") -> ChatResult:
        self.calls.append({
            "model": model, "messages": [dict(m) for m in messages], "tools": tools, "thinking": thinking,
            "max_tokens": max_tokens, "temperature": temperature, "seed": seed,
            "response_format": response_format, "tag": tag,
        })
        if self._i >= len(self.script):
            if self.strict or not self.script:
                raise AssertionError(f"FakeLLM script exhausted after {self._i} calls")
            item = self.script[-1]
        else:
            item = self.script[self._i]
            self._i += 1
        result = item(messages) if callable(item) else item
        result.model = model
        return result
```

### 4.4 `tests/conftest.py`

```python
"""Shared pytest fixtures. OWNED BY docs/PLAN.md. Unit tests never touch the network:
CRUSOE_API_KEY is replaced by a dummy and runs/ is redirected to a temp dir."""
from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch, tmp_path):
    monkeypatch.setenv("CRUSOE_API_KEY", "test-key-not-real")
    monkeypatch.setenv("CRUSOE_BASE_URL", "http://127.0.0.1:9/v1")   # unroutable on purpose
    monkeypatch.delenv("YOU_API_KEY", raising=False)
    monkeypatch.delenv("YDC_API_KEY", raising=False)
    monkeypatch.setenv("RATCHET_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("RATCHET_SANDBOX", os.environ.get("RATCHET_TEST_SANDBOX", "subprocess"))
    yield


@pytest.fixture
def settings():
    from ratchet.config import Settings
    return Settings.from_env()


@pytest.fixture
def runs_dir(settings) -> Path:
    settings.runs_dir.mkdir(parents=True, exist_ok=True)
    return settings.runs_dir


def pytest_collection_modifyitems(config, items):
    skip_net = pytest.mark.skip(reason="network tests disabled (set RATCHET_NETWORK_TESTS=1)")
    skip_docker = pytest.mark.skip(reason="docker tests disabled (set RATCHET_DOCKER_TESTS=1)")
    for item in items:
        if "network" in item.keywords and not os.environ.get("RATCHET_NETWORK_TESTS"):
            item.add_marker(skip_net)
        if "docker" in item.keywords and not os.environ.get("RATCHET_DOCKER_TESTS"):
            item.add_marker(skip_docker)
```

### 4.5 `pyproject.toml`

```toml
[project]
name = "ratchet"
version = "0.1.0"
description = "Self-improving agent playbooks gated by a sealed holdout set (Crusoe Recursive Agents hackathon)"
requires-python = ">=3.12"
dependencies = [
  "openai>=1.50,<3",
  "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-timeout>=2.3"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["ratchet*"]

[tool.setuptools.package-data]
"ratchet.bench" = ["tasks/*/*", "split.json"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
addopts = "-q -p no:cacheprovider"
timeout = 120
markers = [
  "network: needs Crusoe/You.com network access (never run in CI; opt in with RATCHET_NETWORK_TESTS=1)",
  "docker: needs a running docker daemon (opt in with RATCHET_DOCKER_TESTS=1)",
]
```

### 4.6 Conventions

- JSON on disk: `json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False)`, written atomically
  (write `path.with_suffix(path.suffix + ".tmp")`, then `os.replace`). Every top-level JSON document has
  `"schema": 1`.
- Paths stored in JSON are relative to repo root with forward slashes (`runs/versions/v3/...`).
- Timestamps: `ratchet.types.utcnow()` -> `2026-10-17T20:15:03.123Z`.
- Logging: `logging.getLogger("ratchet.<module>")`; the CLI configures the root logger (INFO to stderr,
  DEBUG to `runs/loop.log`). Log model ids, token counts, durations; never message bodies at INFO.
- Determinism: seed for an LLM call in a run = `(zlib.crc32(task_id.encode()) + repeat) % 2**31`. The
  same (task, repeat) uses the same seed in every version so incumbent/candidate comparisons are paired.
- Tags for the usage ledger: `f"v{version}:{split}:{task_id}:r{repeat}"` for worker calls,
  `f"v{version}:review"` for the reviewer call that created version N, `f"bench-check:{task_id}"` for the
  planter, `"ping"` for the CLI ping. The ledger aggregates by tag prefix (`"v3:"`, `"v3:holdout:"`).
- Truncation: tool outputs to `settings.tool_output_max_chars` (4000) keeping head 3000 + tail 1000 with
  a `\n...[truncated N chars]...\n` marker; `RunResult.test_output` to 4000; `VerifyResult.output` to 8000.

---

## 5. Module specifications

### 5.1 I1 — runtime (`llm.py`, `sandbox.py`, `tools.py`, `worker.py`, `verify.py`, `docker/sandbox/Dockerfile`)

#### `ratchet/llm.py`

```python
class RateLimitedError(RuntimeError): ...        # raised after max_retries exhausted
class EmptyContentError(RuntimeError): ...       # content null and no tool_calls after retry

class UsageLedger:
    """Thread-safe. Records every call; optionally appends one JSON line per call to a .jsonl file."""
    def __init__(self, jsonl_path: Path | None = None): ...
    def record(self, *, tag: str, model: str, usage: Usage, latency_ms: int, finish_reason: str,
               attempts: int, thinking: bool) -> None: ...
    def total(self, prefix: str = "") -> Usage: ...
    def by_model(self, prefix: str = "") -> dict[str, Usage]: ...
    def by_tag(self, prefix: str = "") -> dict[str, Usage]: ...
    def reset(self) -> None: ...

def price_for(model: str, prices: dict[str, tuple[float, float, float]] | None = None) -> tuple[float, float, float]
def compute_cost(model: str, prompt_tokens: int, completion_tokens: int, cached_tokens: int,
                 prices=None) -> float
    # cost = (prompt - cached) * p_in/1e6 + cached * p_cached/1e6 + completion * p_out/1e6

class CrusoeClient:                              # implements ratchet.types.LLM
    def __init__(self, settings: Settings, ledger: UsageLedger | None = None,
                 client_factory: Callable[[], Any] | None = None): ...
        # client_factory returns an object with .chat.completions.create(**kwargs) -> response;
        # default builds openai.OpenAI(api_key=settings.crusoe_api_key, base_url=settings.crusoe_base_url,
        # timeout=settings.request_timeout_s, max_retries=0). Tests inject a fake factory.
    def chat(self, *, model, messages, tools=None, thinking=False, max_tokens=2048, temperature=0.2,
             seed=None, response_format=None, tag="") -> ChatResult: ...
    def refresh_prices(self) -> dict[str, tuple[float, float, float]]: ...
        # GET {base_url}/models; parse pricing {prompt, completion, input_cache_reads} (USD per 1M, strings);
        # on any failure keep config.PRICES_PER_M. Called once lazily by cli ping/run, never in unit tests.
    def list_models(self) -> list[dict]: ...
```

Behaviour of `chat()`:

1. Acquire the per-model `threading.Semaphore(settings.max_inflight_per_model)` and the per-model pacer
   (token bucket: minimum spacing `60 / settings.rpm_per_model` seconds between request starts per model,
   implemented with a lock + monotonic clock; no busy wait).
2. Build kwargs: `model, messages, max_tokens, temperature`; `tools` only if non-empty; `seed` if given;
   `response_format` if given; `extra_body={"chat_template_kwargs": {"enable_thinking": thinking}}`.
   When `thinking=False` also pass `"force_nonempty_content": True` inside `chat_template_kwargs`.
   Never pass `tool_choice`.
3. Retry on: HTTP 429, 500, 502, 503, 504, connection errors, timeouts. Backoff
   `min(cap, base * 2**attempt) * uniform(0.5, 1.5)`; honour `Retry-After` if present; up to
   `settings.max_retries` attempts, then raise `RateLimitedError` (message includes model and attempts).
4. Normalize: `content = msg.content or ""`; `reasoning = dumped.get("reasoning") or dumped.get("reasoning_content") or ""`;
   `tool_calls` parsed with `json.loads` per call (malformed -> `arguments={}` and the raw string kept);
   `message` = `{"role": "assistant", "content": content or None, "tool_calls": [...]}` with the reasoning
   removed and `tool_calls` omitted when empty.
5. If `finish_reason == "length"` and `content == ""` and no tool calls and `thinking=False`: retry once
   with `max_tokens * 2` (cap 16384). If still empty raise `EmptyContentError`.
6. Usage: `prompt_tokens`, `completion_tokens` from `response.usage`; `cached_tokens` from
   `usage.prompt_tokens_details.cached_tokens` when the details object exists and the field is not None
   (`cached_reported=True`), else 0 / False. Cost via `compute_cost`. Record to the ledger with the tag.
7. Return `ChatResult(model, message, content, reasoning, tool_calls, finish_reason, usage, latency_ms, attempts, cached_reported)`.

Ledger JSONL line (`runs/llm_calls.jsonl`, one per call; no message content, no key):
`{"ts","tag","model","prompt_tokens","completion_tokens","cached_tokens","cached_reported","cost_usd","latency_ms","finish_reason","attempts","thinking"}`.

#### `ratchet/sandbox.py`

```python
@dataclass
class SandboxResult:
    exit_code: int; stdout: str; stderr: str; timed_out: bool; backend: str; duration_s: float

class Sandbox:
    def __init__(self, settings: Settings): ...
    @property
    def backend(self) -> str: ...                    # resolved "docker" | "subprocess"
    def run(self, argv: list[str], workdir: Path, timeout_s: int | None = None,
            env: dict[str, str] | None = None) -> SandboxResult: ...
    def ensure_image(self) -> bool: ...              # docker build if missing; False on failure
    @staticmethod
    def docker_available() -> bool: ...              # `docker info` exit 0 within 5 s; result cached per process

def run_python_file(sandbox: Sandbox, workdir: Path, relpath: str, timeout_s: int) -> SandboxResult
def run_pytest(sandbox: Sandbox, workdir: Path, targets: list[str], timeout_s: int) -> SandboxResult
    # argv = ["python", "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", *targets]
```

- `argv[0] == "python"` is a logical name. Docker backend runs it inside the image; subprocess backend
  substitutes `sys.executable` (the venv python, which has pytest) and adds `-I` for `python <file>`
  invocations (not for `-m pytest`).
- Docker command: `docker run --rm --name ratchet-<uuid8> --network none --cpus {cpus} --memory {mem}
  --pids-limit 256 --user <uid>:<gid> -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONHASHSEED=0 -v {abs workdir}:/work
  -w /work {image} {argv}`. Enforce `timeout_s` with `subprocess.run(timeout=timeout_s + 5)`; on
  `TimeoutExpired` run `docker kill ratchet-<uuid8>` and return `timed_out=True, exit_code=124`.
- Backend resolution (`auto`): docker if `docker_available()` and `ensure_image()`; otherwise subprocess,
  logged once at WARNING ("sandbox: docker unavailable (<reason>), falling back to subprocess").
  If a docker run fails with a docker-level error (exit 125/126/127 and stderr mentions docker/daemon),
  switch the instance to subprocess for the rest of the process and re-run that command once.
- Subprocess backend: `cwd=workdir`, minimal env (`PATH`, `HOME=workdir`, `PYTHONDONTWRITEBYTECODE=1`,
  `PYTHONHASHSEED=0`, plus `env`), `timeout_s` -> `exit_code=124, timed_out=True`, process group killed.
- Output capture capped at 20000 chars each for stdout/stderr (head+tail).
- `docker/sandbox/Dockerfile`: `FROM python:3.12-slim`, `RUN pip install --no-cache-dir pytest==8.3.3`,
  `WORKDIR /work`. Build context `docker/sandbox`.

#### `ratchet/tools.py`

```python
@dataclass
class ToolOutcome:
    text: str                 # what goes back to the model (already truncated)
    error: str | None = None  # tool-level error (bad path, unknown tool, ...)
    is_submit: bool = False

class ToolBox:
    def __init__(self, workspace: Path, sandbox: Sandbox, settings: Settings, *, search_enabled: bool = True,
                 tag: str = ""): ...
    def schemas(self) -> list[dict]: ...                       # TOOL_SCHEMAS in fixed order (below)
    def call(self, name: str, arguments: dict) -> ToolOutcome: ...
    def snapshot_files(self) -> dict[str, str]: ...            # workspace files (see rules)
    searches_used: int

def you_search(query: str, count: int = 5, *, api_key: str | None, timeout: float = 20.0) -> list[dict]
    # keyed: POST https://ydc-index.io/v1/search (X-API-Key) with extraction highlights;
    # keyless: POST https://api.you.com/mcp?profile=free JSON-RPC tools/call you-search (SSE-framed);
    # returns [{"title","url","text"}]; never raises (returns a one-item "search unavailable" list).
    # Copy the verified snippet from docs/research/youcom.md.
TOOL_SCHEMAS: list[dict]   # module constant, order fixed: write_file, read_file, run_python, run_tests, web_search, submit
```

Tool schemas (OpenAI function format; names and parameters exact):

| name | parameters | returns (text) |
|---|---|---|
| `write_file` | `path: string (relative)`, `content: string` | `"wrote <path> (<n> bytes)"` |
| `read_file` | `path: string` | file contents, or error |
| `run_python` | `code: string` | `exit_code: N\n--- stdout ---\n...\n--- stderr ---\n...` (code saved as `_ratchet_snippet.py` in the workspace, run with `python _ratchet_snippet.py`) |
| `run_tests` | `path: string (optional, default "")` | same format; runs `python -m pytest -q -x -p no:cacheprovider [path]` on the worker's own `test_*.py`; if exit 5 (no tests) append the hint `"no tests collected: write test_*.py files first"` |
| `web_search` | `query: string`, `count: integer 1-10 (default 5)` | numbered list `1. <title>\n   <url>\n   <text>`; after `settings.search_per_task_cap` searches returns `"search budget exhausted for this task"`; when `search_enabled=False` returns `"web search is disabled"` |
| `submit` | `summary: string` | `"submitted"`, `is_submit=True` |

Path rules: relative, normalized, no `..`, no absolute, must resolve inside the workspace; otherwise
`ToolOutcome(text="error: path outside workspace", error=...)`. `snapshot_files()` returns every regular
file under the workspace up to 64 KB each, excluding `__pycache__/`, `.pytest_cache/`, and names starting
with `_ratchet_`. Unknown tool name -> `ToolOutcome(text="error: unknown tool <name>", error=...)`.
Sandbox timeouts for `run_python`/`run_tests`: `settings.sandbox_timeout_s`.

#### `ratchet/worker.py`

```python
WORKER_PROTOCOL: str   # fixed text appended after the playbook in the system prompt (see below)

def build_system_prompt(playbook: str) -> str      # playbook.rstrip() + "\n\n" + WORKER_PROTOCOL
def build_task_message(task: Task) -> str          # "## Task\n{spec}\n\n## Starter file ({entry_file})\n```python\n{starter}\n```"

class LocalWorker:                                  # implements ratchet.types.Worker
    name = "local"
    def __init__(self, llm: LLM, settings: Settings, sandbox: Sandbox | None = None): ...
    def run_task(self, task, playbook, *, version, repeat, run_dir, tag) -> Transcript: ...
    def reset(self) -> None: ...                    # no-op for local
```

`WORKER_PROTOCOL` content (fixed; wording is I1's but must include): you are working in a sandbox
workspace; the deliverable is the file `solution.py` (use `task.entry_file`); tools available and what
they do; you cannot ask questions; call `submit` when finished; the hidden tests import from `solution`.
Do not include anything task-specific.

`run_task` algorithm:

1. `workspace = run_dir / "workspace"`; create; write `task.entry_file` = `task.starter_code`.
2. `messages = [{"role":"system","content": build_system_prompt(playbook)}, {"role":"user","content": build_task_message(task)}]`.
3. Loop for `step in 1..settings.worker_max_steps`, also stopping when wall clock > `settings.task_wallclock_s`:
   - `res = llm.chat(model=settings.worker_model, messages=messages, tools=toolbox.schemas(),
      thinking=settings.worker_thinking, max_tokens=settings.worker_max_tokens,
      temperature=settings.worker_temperature, seed=seed_for(task.task_id, repeat), tag=tag)`
   - append `res.message` to messages; accumulate usage (total + by model).
   - If no tool calls: if `res.finish_reason == "length"` and this is the first time, append user message
     `"Your previous message was cut off. Continue by calling a tool, or call submit."` and continue;
     otherwise `stop_reason="done"`, break.
   - For each tool call (in order): `outcome = toolbox.call(name, args)`; append
     `{"role":"tool","tool_call_id": id, "content": outcome.text}`; record `ToolStep`.
     If any `outcome.is_submit`: `stop_reason="done"`, break out of both loops.
   - Circuit breaker: signature = `(name, json.dumps(args, sort_keys=True))`. If the last 3 signatures
     are identical, or the last 3 `run_tests` outputs are identical, `stop_reason="circuit_breaker"`, break.
4. If the loop ends by exhausting steps: `stop_reason="step_cap"`; by wall clock: `"wallclock"`.
   Any exception from the LLM (`RateLimitedError`, `EmptyContentError`, other) -> `stop_reason="error"`,
   `error=str(exc)[:500]`, still return a Transcript (the workspace may still pass verification).
5. `workspace_files = toolbox.snapshot_files()`; `final_answer` = last assistant text content.
6. Return the Transcript. The caller saves it; the worker does not write JSON itself.

#### `ratchet/verify.py`

```python
HIDDEN_TEST_FILE = "test_hidden.py"

def run_hidden_tests(task: Task, workspace_files: dict[str, str], settings: Settings, run_dir: Path,
                     sandbox: Sandbox | None = None) -> VerifyResult
    # 1. verify_dir = run_dir / "verify"; wipe + recreate.
    # 2. write workspace_files (same path rules as ToolBox; skip anything named test_hidden.py or conftest.py);
    #    if task.entry_file is missing, write it as "" so the failure is "import error", not a crash.
    # 3. write task.hidden_tests to verify_dir / HIDDEN_TEST_FILE.
    # 4. res = run_pytest(sandbox, verify_dir, [HIDDEN_TEST_FILE], timeout_s=task.timeout_s)
    # 5. VerifyResult(passed=res.exit_code == 0 and not res.timed_out, exit_code=..., output=stdout+"\n"+stderr (8000 cap),
    #                 duration_s, timed_out, backend)

def verify_reference(task: Task, settings: Settings, run_dir: Path, sandbox=None) -> VerifyResult
    # run_hidden_tests with {task.entry_file: task.reference_solution}; used by bench tests and mutate.py
```

#### I1 unit tests (offline)

- `test_llm.py`: fake `client_factory` returning scripted responses; asserts `enable_thinking` false by
  default and true when asked; `force_nonempty_content` present when thinking off; 429 then 200 -> 2
  attempts with backoff patched to zero; `max_retries` exhaustion raises `RateLimitedError`; null content
  + length -> retry with doubled max_tokens; `cached_tokens` parsed from `prompt_tokens_details`
  (present) and absent -> `cached_reported=False`; `compute_cost` arithmetic; ledger totals/by_model/by_tag
  prefix; JSONL line contains no `messages` key; semaphore caps concurrency (threads + counter).
- `test_sandbox.py`: subprocess backend echo, non-zero exit, timeout -> 124/timed_out, output cap, env
  isolation (an env var set in the parent is absent); docker test marked `@pytest.mark.docker`.
- `test_tools.py`: path traversal rejected; write/read round trip; run_python captures stdout and exit code;
  run_tests exit 5 hint; search disabled text; search budget exhaustion with a monkeypatched `you_search`;
  `snapshot_files` excludes `_ratchet_*` and caches; `TOOL_SCHEMAS` names/order.
- `test_worker.py`: with `FakeLLM([tool_call("write_file", ...), tool_call("run_tests", {}), tool_call("submit", {"summary": "ok"})])`
  the transcript has 3 steps, `stop_reason=="done"`, `workspace_files["solution.py"]` matches, system
  prompt starts with the playbook, user message contains the spec; step cap -> `"step_cap"`; same call 3x ->
  `"circuit_breaker"`; LLM raising -> `"error"` with a Transcript still returned; usage summed.
- `test_verify.py`: a task whose reference passes and whose starter fails; missing entry file -> failed,
  not raised; timeout task (`while True`) -> `timed_out`.

Done criteria (I1): `pytest tests/test_llm.py tests/test_sandbox.py tests/test_tools.py tests/test_worker.py tests/test_verify.py`
green offline; with network, `python -c` smoke: one `CrusoeClient.chat` per role model returns non-empty
content with thinking off and `attempts==1`; a `LocalWorker` run on a hand-written toy Task completes
with docker backend and with `RATCHET_SANDBOX=subprocess`.

---

### 5.2 I2 — benchmark (`ratchet/bench/`, `ratchet/mutate.py`)

#### Task folder format (`ratchet/bench/tasks/<task_id>/`)

- `spec.md` — what the worker sees. Structure: `# <Title>`, one paragraph of context, `## Function(s)`
  with exact signatures, `## Rules` (bullet list stating every edge case the hidden tests check, in plain
  language), `## Examples` (3-5 `>>>`-style examples). Specs are complete and fair: nothing is tested that
  the spec does not state. The difficulty is that a naive agent skims the rules and never tests them.
- `starter.py` — the initial `solution.py`: signatures with docstring one-liners and bodies
  `raise NotImplementedError`. Must fail the hidden tests.
- `reference.py` — a correct, idiomatic `solution.py`. Must pass the hidden tests.
- `test_hidden.py` — pytest, `from solution import ...`, 8-15 focused test functions, each edge case its
  own test with a descriptive name (reviewer-readable failure output), no network, no filesystem outside
  cwd, runs < 5 s. No hypothesis/extra deps (only pytest + stdlib).
- `meta.json` — `{"schema": 1, "split": "train"|"holdout", "tags": ["parsing", ...], "timeout_s": 20, "pitfalls": ["...", "..."]}`
  (`pitfalls` is documentation for us, never shown to models).

`ratchet/bench/split.json`: `{"schema": 1, "train": ["t01_...", ...], "holdout": ["t11_...", ...]}`; must
agree with every `meta.json`.

#### Task list (24 tasks; ids fixed so I3's tests can reference them)

Train (10): `t01_slugify`, `t02_parse_duration`, `t03_merge_intervals`, `t04_roman_numerals`,
`t05_csv_split_line`, `t06_semver_compare`, `t07_word_wrap`, `t08_lru_cache`, `t09_query_string`,
`t10_run_length`.

Holdout (14): `t11_add_months`, `t12_human_size`, `t13_balanced_brackets`, `t14_top_k_frequent`,
`t15_spiral_matrix`, `t16_camel_snake`, `t17_flatten_dict`, `t18_cron_match`, `t19_money_split`,
`t20_dedent_lines`, `t21_insert_position`, `t22_json_path_get`, `t23_anagram_groups`, `t24_format_elapsed`.

Pitfalls to encode (one or two per task; pick the ones that make a careless agent fail):
unicode normalization and max-length cut at word boundary (t01); units in any order, whitespace,
zero, invalid -> `ValueError`, negatives rejected (t02); touching intervals merge, unsorted input, floats (t03);
range 1..3999, reject `IIII`/`VX`, lowercase accepted on parse (t04); quoted commas, doubled quotes,
trailing empty field (t05); prerelease precedence, numeric vs alphanumeric identifiers, build metadata
ignored (t06); words longer than width are broken, blank lines preserved (t07); capacity 0, `put` of an
existing key refreshes recency, eviction order (t08); repeated keys -> list, `+` -> space, percent-decoding,
key without `=` (t09); digits inside the input, escaping, round trip, empty (t10); end-of-month clamp,
leap day, negative months (t11); `GiB` 1024 vs `GB` 1000, case-insensitivity, bare bytes, bad input (t12);
brackets inside string literals and escaped quotes ignored (t13); tie-break by first occurrence, `k > n`,
`k == 0` (t14); non-square, single row/column, empty (t15); acronyms `HTTPServer -> http_server`, digits
`v2Beta -> v2_beta`, already-snake input unchanged (t16); separator, empty nested dict kept, lists untouched
(t17); ranges/steps/lists, `*/15`, DOW 0 and 7 both Sunday (t18); remainder cents to the first parties,
negative totals, `n == 0 -> ValueError` (t19); blank lines ignored for the common prefix, tabs not converted
(t20); left/right variants with duplicates, empty list (t21); `a.b[0].c`, negative indexes, missing ->
default, non-container on the path -> default (t22); case/space-insensitive key, original strings kept,
group order by first appearance (t23); rounding to whole seconds, `0s`, days, omitting zero units except
the last (t24).

#### `ratchet/bench/__init__.py`

```python
TASKS_DIR: Path                                   # Path(__file__).parent / "tasks"
def load_tasks(split: str | None = None, ids: Iterable[str] | None = None) -> list[Task]
    # sorted by task_id; split in {"train","holdout",None}; ids filters; unknown id -> KeyError
def get_task(task_id: str) -> Task
def validate_task_dir(path: Path) -> list[str]    # human-readable problems; [] when valid (files present,
                                                  # meta schema, split agrees with split.json, tests import `solution`)
def task_fingerprint(task: Task) -> str           # sha256 of reference_solution + hidden_tests, hex
```

#### `ratchet/mutate.py` (test the tests)

```python
PLANTER_SYSTEM: str                               # fixed system prompt for the bug planter (first, cacheable)

@dataclass
class MutantResult:
    attempt: int
    description: str                              # planter's description of the bug
    witness: str                                  # python expression where reference and mutant differ
    valid: bool                                   # compiled, differs from reference, witness outputs differ
    killed: bool | None                           # hidden tests fail on the mutant (None if not valid)
    reason: str                                   # why invalid / summary
    mutated_code_path: str                        # runs/bench_check/<task_id>/mutant_<attempt>.py

@dataclass
class BenchCheckResult:
    task_id: str
    fingerprint: str
    planter_model: str
    reference_passes: bool
    mutants: list[MutantResult]
    verdict: str                                  # "strong" | "weak" | "broken" | "inconclusive"
    checked_at: str
    usage: Usage
    def to_dict(self) / from_dict(cls, d)

def plant_bug(llm: LLM, task: Task, settings: Settings, *, attempt: int, previous: list[MutantResult], tag: str) -> dict
    # one planter call; returns {"mutated_code": str, "description": str, "witness": str}; parses JSON from
    # content robustly (strip ``` fences, first {...} block); raises ValueError on unparseable output
def check_task(task: Task, llm: LLM, settings: Settings, *, n_mutants: int = 3, max_attempts: int = 5,
               sandbox: Sandbox | None = None, work_dir: Path | None = None) -> BenchCheckResult
def check_bench(tasks: list[Task], llm: LLM, settings: Settings, *, cache_path: Path | None = None,
                force: bool = False, progress: Callable[[BenchCheckResult], None] | None = None) -> list[BenchCheckResult]
    # cache_path default settings.bench_check_path; reuse cached result when fingerprint matches and not force
def load_bench_check(cache_path: Path) -> dict[str, BenchCheckResult]
def usable_task_ids(cache_path: Path, tasks: list[Task]) -> list[str]
    # tasks whose cached verdict is "strong" or "inconclusive" and whose fingerprint still matches; sorted
```

`check_task` algorithm:

1. `reference_passes = verify_reference(task, ...)`. If False -> verdict `"broken"`, no planter calls.
2. Up to `max_attempts` planter calls (thinking OFF, `max_tokens=settings.planter_max_tokens`, T 0.7,
   `tag=f"bench-check:{task.task_id}"`), until `n_mutants` valid mutants. The prompt gives the spec and the
   reference solution and asks for ONE subtle, realistic bug (off-by-one, wrong boundary, missed edge case,
   wrong default) that changes behaviour on at least one input, plus a `witness` expression (e.g.
   `solution.parse_duration("1h")`) whose value or exception type differs. Previous mutants' descriptions
   are listed with "do not repeat these".
3. Validity: `compile(mutated_code, ...)` succeeds; normalized text (strip trailing whitespace per line,
   drop blank lines) differs from the reference; witness check: write `_ratchet_witness.py` that imports
   `solution`, evaluates the witness and prints `repr(value)` or `"EXC:" + type(exc).__name__`; run it in
   the sandbox once with the reference as `solution.py` and once with the mutant; outputs must differ.
   If anything fails the mutant is `valid=False` with a `reason` and does not count.
4. For each valid mutant: `killed = not run_hidden_tests(task, {entry_file: mutant}, ...).passed`.
5. Verdict: `"weak"` if any valid mutant survived; `"strong"` if `>= 2` valid mutants and all killed;
   `"inconclusive"` if fewer than 2 valid mutants were obtained (included in evals, flagged in the CLI table).

`runs/bench_check.json` format:

```json
{"schema": 1, "updated_at": "...", "tasks": {"t01_slugify": {<BenchCheckResult>}, ...}}
```

Fix weak suites: when `bench-check` says `weak`, strengthen `test_hidden.py` (add a test for the surviving
mutant's witness) and re-run. Deliverable: all 24 tasks `strong` with the real planter.

#### I2 unit tests (offline)

- `test_bench.py`: 24 task dirs load; `validate_task_dir` returns `[]` for all; split.json agrees with meta;
  ids match the list above; for every task the reference passes and the starter fails the hidden tests via
  `verify_reference` / `run_hidden_tests` with the subprocess sandbox (executes locally, no network; keep
  each task's hidden tests under 5 s so the whole-bench test stays under 2 minutes); `task_fingerprint`
  changes when tests change.
- `test_mutate.py`: with `FakeLLM` returning a scripted mutant JSON (one with a real bug, one equivalent
  mutant, one that does not compile): validity classification, killed computation against a tiny inline
  task, verdict rules (`strong`/`weak`/`broken`/`inconclusive`), cache reuse by fingerprint, `force`
  bypass, `usable_task_ids` excludes weak/broken and stale fingerprints, JSON parsing tolerates fences.

Done criteria (I2): tests green; `python -m ratchet bench-check` (I3's CLI; until it exists use
`python -c "from ratchet.mutate import ..."`) reports 24 `strong` tasks with the real planter model, total
planter cost printed; `docs/bench.md` is NOT required (keep notes in `meta.json.pitfalls`).

---

### 5.3 I3 — loop (`reviewer.py`, `gate.py`, `store.py`, `loop.py`, `report.py`, `cli.py`, `__main__.py`, `playbooks/v0.md`)

#### `playbooks/v0.md` (seed; deliberately minimal so improvement is possible)

```markdown
# Coding worker playbook

You are a Python coding worker. Read the task, write the requested functions in `solution.py`, then call `submit`.
```

(Exactly this spirit: no instruction to read the rules carefully, write tests, run them, or handle edge
cases. Those are what the reviewer should discover. Keep it under 6 lines.)

#### `ratchet/store.py`

```python
class Store:
    def __init__(self, runs_dir: Path): ...
    runs_dir: Path; versions_dir: Path (runs/versions); history_path: Path (runs/history.json)
    def exists(self) -> bool
    def init(self, playbook: str, *, config: LoopConfig, worker: str, holdout_ids: list[str], train_ids: list[str]) -> VersionRecord
        # creates runs/, writes v0 (status "candidate", holdout_score -1.0) and history.json
    def load_history(self) -> dict          # the full document (see format)
    def save_history(self, doc: dict) -> None
    def versions(self) -> list[VersionRecord]
    def get(self, version: int) -> VersionRecord
    def incumbent(self) -> VersionRecord     # the record whose status == "incumbent"
    def next_version(self) -> int
    def version_dir(self, version: int) -> Path          # runs/versions/vN
    def run_dir(self, version: int, split: str, task_id: str, repeat: int) -> Path   # runs/versions/vN/<split>/<task_id>/r<k>
    def playbook(self, version: int) -> str
    def create_version(self, *, parent: int, playbook: str, diff: str, edit: PlaybookEdit, round: int, worker: str) -> VersionRecord
        # writes playbook.md, diff.patch, review.json (edit as dict) and record.json; status "candidate"
    def update(self, record: VersionRecord) -> None       # rewrites record.json and the row in history.json
    def set_incumbent(self, version: int) -> None         # old incumbent -> "superseded", new -> "incumbent"
    def save_run(self, result: RunResult, transcript: Transcript) -> None
        # run_dir/transcript.json and run_dir/result.json (atomic)
    def load_runs(self, version: int, split: str) -> list[RunResult]
    def load_transcript(self, result: RunResult) -> Transcript
```

`runs/history.json`:

```json
{
  "schema": 1,
  "updated_at": "2026-10-17T20:15:03.123Z",
  "config": {"name": "demo", "rounds": 6, "repeats": 2, "holdout_size": 12, "train_size": 10, "train_repeats": 1,
             "min_delta": 0.05, "max_failures_to_reviewer": 4, "stop_when_train_clean": true},
  "worker": "local",
  "holdout_task_ids": ["t11_add_months", "..."],
  "train_task_ids": ["t01_slugify", "..."],
  "incumbent": 2,
  "rounds_completed": 3,
  "versions": [ {<VersionRecord>}, ... ]
}
```

Directory layout:

```
runs/
  history.json
  llm_calls.jsonl
  bench_check.json
  loop.log
  report.html
  bench_check/<task_id>/mutant_<n>.py, witness_*.txt
  versions/
    v0/ playbook.md  record.json  holdout/<task_id>/r0/{workspace/,verify/,transcript.json,result.json}
                                   train/<task_id>/r0/...
    v1/ playbook.md  diff.patch  review.json  record.json  holdout/...  train/...
```

#### `ratchet/gate.py`

```python
def seed_for(task_id: str, repeat: int) -> int     # (zlib.crc32(task_id.encode()) + repeat) % 2**31

def evaluate(tasks: list[Task], playbook: str, *, version: int, split: str, repeats: int, worker: Worker,
             settings: Settings, store: Store, ledger: UsageLedger,
             progress: Callable[[RunResult], None] | None = None) -> list[RunResult]
    # ThreadPoolExecutor(max_workers=settings.max_inflight_per_model) over all (task, repeat) pairs;
    # for each: run_dir = store.run_dir(...); tag = f"v{version}:{split}:{task.task_id}:r{repeat}";
    # transcript = worker.run_task(task, playbook, version=version, repeat=repeat, run_dir=run_dir, tag=tag);
    # vr = run_hidden_tests(task, transcript.workspace_files, settings, run_dir);
    # result = RunResult(...passed=vr.passed, exit_code=vr.exit_code, test_output=vr.output[:4000],
    #                    transcript_path=rel(run_dir/"transcript.json"), usage=transcript.usage, ...);
    # store.save_run(result, transcript); progress(result). A worker exception becomes a failed RunResult
    # with stop_reason "error" (never aborts the whole evaluation). Returns results sorted by (task_id, repeat).

def per_task_rates(results: list[RunResult]) -> dict[str, float]      # task_id -> passed / runs
def score(rates: dict[str, float]) -> float                           # mean over tasks; 0.0 if empty

def decide(incumbent: dict[str, float], candidate: dict[str, float], *, min_delta: float) -> GateDecision
    # tasks = sorted(incumbent) (candidate must contain the same keys; missing -> treated as 0.0)
    # regressions = [t for t in tasks if candidate[t] < incumbent[t] - 1e-9]
    # improvements = [t for t in tasks if candidate[t] > incumbent[t] + 1e-9]
    # delta = score(candidate) - score(incumbent)
    # accepted = (not regressions) and delta > 0 and delta >= min_delta - 1e-9
    # reason examples: "accepted: +8.3% (0.583 -> 0.667), 2 improved, 0 regressed"
    #                  "rejected: regressed t13_balanced_brackets, t19_money_split"
    #                  "rejected: +4.2% below margin 5.0%" / "rejected: no improvement"

def default_min_delta(n_tasks: int, repeats: int) -> float          # 1.0 / (n_tasks * repeats)
```

#### `ratchet/reviewer.py`

```python
REVIEWER_SYSTEM: str      # fixed; first in the prompt (cacheable on Super). Must say: you edit a general
                          # playbook for coding workers; you see only failed runs from the TRAIN split; propose
                          # exactly ONE targeted edit (add/replace one section or sentence); edits must be general
                          # practices, never mention a specific task, function name or test; output JSON only.

@dataclass
class FailureSummary:
    task_id: str; spec_excerpt: str; steps: list[str]; final_test_output: str; stop_reason: str

def summarize_failure(task: Task, result: RunResult, transcript: Transcript, *, max_chars: int = 3500) -> FailureSummary
    # spec_excerpt: first 600 chars of the spec; steps: "step N: <tool> <short args> -> <first line of result>";
    # final_test_output: last 1200 chars of result.test_output
def render_review_request(playbook: str, failures: list[FailureSummary], rejected: list[tuple[str, str]]) -> str
    # user message: "# Current playbook\n```markdown\n...\n```\n# Failed runs (train)\n## 1. <task_id> ...\n
    # # Previously rejected edits for this playbook (do not repeat)\n- <gate_reason>\n```diff\n...\n```\n
    # # Respond with JSON: {"diagnosis": str, "edit": {"op": "replace_section"|"append_section"|"replace_text",
    #   "anchor": str, "text": str}, "rationale": str}"
def parse_edit(content: str) -> PlaybookEdit                       # tolerant JSON extraction; ValueError if invalid
def apply_edit(playbook: str, edit: PlaybookEdit) -> str
    # replace_section: find line "## <anchor>" (case-insensitive, '#'s stripped); replace body up to the next "## "
    #   (or "# " heading / EOF) with edit.text; anchor missing -> ValueError
    # append_section: append "\n\n" + edit.text (text must start with "## "); duplicate heading -> ValueError
    # replace_text: anchor must occur exactly once; replaced by edit.text
    # result is normalized: single trailing newline; ValueError if identical to input, if > settings.playbook_max_chars,
    # or if the edit adds more than settings.edit_max_lines lines
def unified_diff(old: str, new: str, *, old_name: str, new_name: str) -> str   # difflib.unified_diff, n=2
def leak_check(text: str, holdout_tasks: list[Task]) -> list[str]
    # returns offending tokens: any holdout task_id, any `def name(` function name from holdout starters,
    # any holdout spec title (first heading) found case-insensitively in text
def propose_edit(llm: LLM, playbook: str, failures: list[FailureSummary], *, settings: Settings,
                 holdout_tasks: list[Task], rejected: list[tuple[str, str]], tag: str,
                 max_attempts: int = 3) -> tuple[PlaybookEdit, str]
    # returns (edit, new_playbook). Each attempt: llm.chat(model=settings.reviewer_model, thinking=settings.reviewer_thinking,
    # max_tokens=settings.reviewer_max_tokens, temperature=0.4, tag=tag); on parse/apply/leak failure append the
    # error as a user message and retry; attempt 3 uses thinking=False and response_format json_object.
    # Raises ReviewerError after max_attempts.
class ReviewerError(RuntimeError): ...
```

#### `ratchet/loop.py`

```python
@dataclass
class RoundOutcome:
    round: int; candidate: VersionRecord | None; decision: GateDecision | None; stopped: str | None
    # stopped: None | "train_clean" | "reviewer_failed"

def bootstrap(store, settings, config, worker, llm, ledger, *, playbook_path: Path, holdout: list[Task], train: list[Task]) -> VersionRecord
    # creates v0 if store does not exist; evaluates v0 on the holdout (repeats=config.repeats) if holdout_score < 0;
    # fills per_task/holdout_score/usage_by_phase["holdout"]; status -> "incumbent"; returns the record
def run_round(round_no: int, *, store, settings, config, worker, llm, ledger, holdout: list[Task], train: list[Task]) -> RoundOutcome
    # 1. inc = store.incumbent(); train results for inc: reuse store.load_runs(inc.version, "train") if present
    #    else evaluate(train[:config.train_size], repeats=config.train_repeats) and add usage to inc.usage_by_phase["train"]
    # 2. failures = failed runs (first per task, up to config.max_failures_to_reviewer, most steps first);
    #    if none and config.stop_when_train_clean -> RoundOutcome(stopped="train_clean")
    # 3. rejected = [(diff, gate_reason) for v in versions if v.parent == inc.version and v.status == "rejected"]
    # 4. edit, new_playbook = propose_edit(..., tag=f"v{store.next_version()}:review")  (ReviewerError -> stopped="reviewer_failed")
    # 5. cand = store.create_version(parent=inc.version, playbook=new_playbook, diff=unified_diff(...), edit=edit, round=round_no, worker=worker.name)
    # 6. results = evaluate(holdout, new_playbook, version=cand.version, split="holdout", repeats=config.repeats, ...)
    # 7. decision = decide(inc.per_task, per_task_rates(results), min_delta=config.min_delta or default_min_delta(len(holdout), config.repeats))
    # 8. fill cand (scores, delta, regressions, improvements, gate_reason, usage from ledger prefix f"v{cand.version}:" + review);
    #    accepted -> store.set_incumbent(cand.version), status "accepted" then "incumbent"; else status "rejected"
    # 9. store.update(cand); write_report(store); return RoundOutcome
def run_loop(*, rounds: int, ...) -> list[RoundOutcome]      # bootstrap + rounds; stops early on stopped != None
```

Status semantics: `v0` becomes `"incumbent"` after bootstrap. An accepted candidate becomes
`"incumbent"`; the previous incumbent becomes `"superseded"`. Rejected candidates stay `"rejected"`. The
chart shows superseded+incumbent as the accepted line and rejected as hollow markers.

#### `ratchet/report.py`

```python
def render_report(history: dict, *, llm_calls: list[dict] | None = None, now: str | None = None) -> str   # HTML string
def write_report(store: Store, out: Path | None = None) -> Path                                            # runs/report.html
```

Single self-contained HTML file, no external requests (inline CSS, inline SVG; no CDN). Sections, top to
bottom: (1) header "Ratchet — playbook v{incumbent}" with incumbent score, versions tried/accepted/rejected,
total cost; (2) **Scoreboard** SVG: x = version, y = holdout score (0-100%), accepted/incumbent/superseded
points filled and connected by a step line, rejected points hollow with a dashed vertical to their parent's
score, `<title>` tooltips with gate reason; (3) **Cost per version** bars: prompt / completion / cached
tokens (cached shown as "n/a" when `cached_reported` is false) and `$` with 4 decimals; (4) **Versions
table**: version, status, round, score, delta, regressions, improvements, rationale, link to diff; (5)
**Latest accepted diff** rendered from `diff.patch` with `+`/`-` line colouring and the full current
playbook; (6) **Per-task grid**: rows holdout tasks, columns versions, cell colour by pass rate, hover
shows `passed/runs`. Add `<meta http-equiv="refresh" content="20">` when `history["live"]` is truthy
(set by `run --live`). Must render with zero versions, with only v0, and with rejected-only histories.

#### `ratchet/cli.py` + `ratchet/__main__.py`

`__main__.py`: `from ratchet.cli import main; raise SystemExit(main())`. `main(argv=None) -> int`, argparse.

```
python -m ratchet bench-check [--force] [--tasks ID ...] [--split train|holdout|all]
    runs mutate.check_bench on the selected tasks, prints a table (task, split, verdict, mutants killed/valid,
    planter cost) and totals. Exit 0 if all usable, 4 if any task is weak/broken.
python -m ratchet run --config smoke|demo [--rounds N] [--repeats K] [--holdout N] [--train N] [--min-delta X]
                      [--worker local|openbot] [--fallback-local] [--fresh] [--live] [--playbook playbooks/v0.md]
    - loads Settings; refuses with exit 2 if CRUSOE_API_KEY is empty ("CRUSOE_API_KEY is not set in .env")
    - task lists: load_tasks per split, filter by mutate.usable_task_ids (runs bench-check first if the cache
      is missing or stale), cap by holdout_size/train_size (sorted ids)
    - worker: "local" -> LocalWorker(CrusoeClient, settings); "openbot" -> lazy
      `from ratchet.workers.openbot_worker import OpenBotWorker`; `ok, reason = OpenBotWorker.availability(settings)`;
      if not ok: print "openbot worker unavailable: <reason>"; exit 3 unless --fallback-local (then warn + local)
    - --fresh wipes runs/versions and history.json (keeps bench_check.json and llm_calls.jsonl); default resumes
    - prints one line per run (task, repeat, pass/fail, steps, tokens) and one block per round (gate decision)
    - writes report after bootstrap and after every round
python -m ratchet report [--out runs/report.html] [--open]
python -m ratchet ping          one 20-token call per role model (thinking off); prints model, latency, tokens,
                                cached_reported, cost; exit 1 if any fails
python -m ratchet show [--version N]    prints the record and playbook (default incumbent)
python -m ratchet eval --version N --split holdout|train [--repeats K]   re-evaluates one version (optional)
```

Exit codes: 0 ok; 1 unexpected error (traceback to `runs/loop.log`, one-line message to stderr); 2 usage /
configuration; 3 worker unavailable; 4 bench-check found weak or broken tasks.

#### I3 unit tests (offline, all with `FakeLLM` and a stub `Worker`)

- `test_gate.py`: `decide` table — no regression + above margin accepted; one regression rejected even with
  higher score; equal scores rejected ("no improvement"); below margin rejected; missing candidate task
  treated as 0.0; `default_min_delta`; `evaluate` with a stub worker that passes for even repeats: results
  count = tasks x repeats, files written under the right run_dir, a raising worker yields a failed result.
- `test_store.py`: init -> v0 + history; create_version writes playbook/diff/review/record; set_incumbent
  flips statuses; save_run/load_runs round trip; atomic write leaves no `.tmp` files; relative paths.
- `test_reviewer.py`: `apply_edit` for all three ops incl. errors (missing anchor, duplicate heading,
  identical result, too many lines, too long); `parse_edit` with fences/prose around JSON; `leak_check`
  catches a holdout task id / function name; `propose_edit` retries after a bad first answer and raises
  after 3; `unified_diff` header names.
- `test_loop.py`: a 2-task holdout, 2-task train with a stub worker whose pass/fail depends on whether the
  playbook contains the word "tests": round 1 accepts (FakeLLM reviewer appends a "## Testing" section),
  round 2 with a reviewer that proposes a no-op -> stopped="reviewer_failed"; rejected path with a worse
  playbook; history.json statuses correct; usage_by_phase keys present.
- `test_report.py`: renders with empty, v0-only, and mixed accepted/rejected histories; output contains
  `<svg`, every version number, "n/a" for unreported cache; self-contained (assert `"<script src" not in html`,
  `"<link" not in html` and `"https://" not in html`).
- `test_cli.py`: `main(["report"])` on an empty runs dir writes a report; `main(["run", "--config", "smoke"])`
  with `CRUSOE_API_KEY=""` returns 2; `--worker openbot` with a monkeypatched unavailable worker returns 3 and
  with `--fallback-local` proceeds (patch `run_loop` to a no-op).

Done criteria (I3): tests green; with I1+I2 present and network: `python -m ratchet run --config smoke`
completes in < 10 minutes, produces `runs/history.json` with v0 (incumbent or superseded) and v1
(accepted or rejected), and `runs/report.html` opens with a chart.

---

### 5.4 I4 — openbot (`ratchet/workers/openbot_worker.py`, `ratchet/workers/__init__.py`, `integrations/openbot/`)

Facts established today (see `docs/research/openbot.md`; verify each in `vendor/openbot` before coding):

- The OpenBot server refuses to start without `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`,
  `INTELLIGENCE_API_KEY` (CopilotKit Intelligence; needs `npx copilotkit login`, i.e. an account we may not
  create). **This is a hard blocker for the full stack. Do not sign up.**
- The shipped Bot `agent-bot` (`vendor/openbot/agent-bot/src/index.ts`) is an AG-UI HTTP service on
  `127.0.0.1:4200`, `POST /ag-ui` with a `RunAgentInput` body. It publishes no tools of its own: every tool
  arrives in `input.tools`, and "the loop runs on the client": when it emits a tool call it ends the run; the
  surface executes the tool, appends the result, and starts a new run. It requires `MANAGED_AGENT_TOKEN` in
  its env (and checks requests with `shared/agent-authorisation.ts`'s `hasManagedAgentToken`). It calls
  `OPENAI_BASE_URL` `/chat/completions` via the `openai` npm package with `BOT_MODEL`/`AGENT_BOT_MODEL`.
- Nothing in OpenBot disables Nemotron reasoning, so with a small max_tokens the Bot's turns come back empty.

Design: `OpenBotWorker` has two modes.

**Mode `agui` (default; must work today).** OpenBot's real `agent-bot` process is the coworker's brain;
Ratchet is the surface and the computer:

1. `integrations/openbot/crusoe_proxy.py` — a tiny stdlib `http.server` (ThreadingHTTPServer) on
   `127.0.0.1:8787` that accepts `POST /v1/chat/completions`, injects
   `chat_template_kwargs: {enable_thinking: false, force_nonempty_content: true}` (unless the body already
   has `chat_template_kwargs`), raises `max_tokens` to at least 2048, forwards to
   `CRUSOE_BASE_URL` with the real key from `Settings.from_env()` (the key never leaves the proxy process;
   incoming `Authorization` is ignored), relays the response (streaming or not — check which the Bot uses
   and support it), and appends a usage line to `runs/llm_calls.jsonl` via `UsageLedger` with tag taken from
   the request header `X-Ratchet-Tag` (fallback `"openbot"`). Also retries 429/503 with the same backoff
   policy as `CrusoeClient` (reuse `ratchet.llm` helpers if importable, else reimplement).
2. `integrations/openbot/setup.sh` — idempotent: checks `bun`, `vendor/openbot` present (clone if missing
   with `git clone --depth 1 https://github.com/CopilotKit/OpenBot vendor/openbot`), runs `bun install` in
   the needed workspace, generates `MANAGED_AGENT_TOKEN` into `integrations/openbot/.env.openbot` (already ignored by the
   `.env.*` rule in `.gitignore`; do not edit `.gitignore`), starts `crusoe_proxy.py` and `agent-bot` (`PORT=4200`, `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`,
   `OPENAI_API_KEY=ratchet-proxy`, `BOT_MODEL`/`AGENT_BOT_MODEL=$RATCHET_WORKER_MODEL` default Lightning) in the
   background with pid files under `runs/openbot/`, waits for both health checks, prints status.
   `setup.sh --stack` attempts the full compose stack and exits 2 with the exact blocker text
   `BLOCKER: CopilotKit Intelligence key (INTELLIGENCE_API_KEY) is required by OpenBot and is not set` when
   the three `INTELLIGENCE_*` variables are missing. `stop.sh` stops what `setup.sh` started.
3. `OpenBotWorker.run_task` (agui): workspace + `ToolBox` exactly like `LocalWorker` (import
   `ratchet.tools.ToolBox`, `ratchet.sandbox.Sandbox`, `ratchet.worker.build_system_prompt`,
   `build_task_message`); conversation starts `[system: playbook + WORKER_PROTOCOL, user: task]`; each turn
   POSTs `RunAgentInput` `{"threadId": f"ratchet-v{version}-{task_id}-r{repeat}", "runId": uuid, "messages": [...AG-UI message shape...], "tools": [{"name","description","parameters"} from TOOL_SCHEMAS], "context": [], "state": {}, "forwardedProps": {}}`
   to `agent_url` with header `Authorization: Bearer <MANAGED_AGENT_TOKEN>` (confirm the header name in
   `shared/agent-authorisation.ts`) and `X-Ratchet-Tag: <tag>`; parses the SSE AG-UI event stream
   (`TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END`, `RUN_FINISHED`, `RUN_ERROR`) into an
   assistant message + tool calls; executes tool calls with `ToolBox.call`; appends tool results; same step
   cap, circuit breaker, wall clock and stop reasons as `LocalWorker`; usage for the Transcript is read back
   from the ledger by tag (`UsageLedger` reading `runs/llm_calls.jsonl` lines with that tag) so cost per
   version works for OpenBot runs too. `Transcript.worker = "openbot"`, `model = settings.worker_model`.
4. `OpenBotWorker.availability(settings) -> tuple[bool, str]` (classmethod): agui mode -> proxy and agent-bot
   health checks (`GET http://127.0.0.1:8787/health`, `GET http://127.0.0.1:4200/health` or whatever
   agent-bot answers; verify) within 2 s, reason strings like `"agent-bot not reachable on 127.0.0.1:4200 — run integrations/openbot/setup.sh"`.
   stack mode -> additionally requires `INTELLIGENCE_API_KEY`; reason is the BLOCKER text above.

**Mode `stack` (full OpenBot; implement to the extent possible, cannot be exercised without the key).**
`integrations/openbot/tenant/agents.yaml` defines the "Ratchet coworker" Bot (agent-bot, model from env,
skills: `ratchet-playbook`), `tenant/skills.yaml` seeds the skill `ratchet-playbook` whose `instructions` is
the playbook text (setup renders it from the incumbent `runs/versions/vN/playbook.md` or `playbooks/v0.md`).
`OpenBotWorker` stack mode: deliver a new playbook version via `DELETE /api/plugins/skills/ratchet-playbook`
+ `POST /api/plugins/skills {slug,title,summary,instructions,global:true}`; start a run by creating a channel
(`POST /api/channels`) and sending the task through the CopilotKit runtime (`POST /api/copilotkit`,
document the protocol you find; if it is infeasible, say so in the README and keep agui as the demo path);
read the transcript back from `GET /api/admin/audit-events` + the thread; fetch `solution.py` from the
coworker's computer (`/workspace` via the computer API on 4100 with `COMPUTER_TOKEN`, or `docker cp` from the
container labelled `openbot.namespace=openbot`); `reset()` -> `POST /api/bots/:botId/computers/reset`.
Every endpoint path must be checked against `vendor/openbot/server/src` and corrected if different.

```python
class OpenBotWorker:                                   # implements ratchet.types.Worker
    name = "openbot"
    def __init__(self, settings: Settings, *, mode: str = "agui", agent_url: str = "http://127.0.0.1:4200/ag-ui",
                 proxy_url: str = "http://127.0.0.1:8787", server_url: str = "http://127.0.0.1:3001",
                 token: str | None = None, sandbox: Sandbox | None = None, http: Any | None = None): ...
                 # token default os.environ["MANAGED_AGENT_TOKEN"] (loaded from integrations/openbot/.env.openbot by setup)
    @classmethod
    def availability(cls, settings: Settings, *, mode: str = "agui") -> tuple[bool, str]: ...
    def run_task(self, task, playbook, *, version, repeat, run_dir, tag) -> Transcript: ...
    def reset(self) -> None: ...
    # helpers (unit-tested): to_agui_messages(messages) -> list[dict]; parse_agui_events(sse_text) -> tuple[str, list[ToolCall], str|None]
```

`integrations/openbot/README.md`: how to start (`bash integrations/openbot/setup.sh`), what runs where (ports
8787/4200), how the playbook is delivered (system message in agui mode = OpenBot's skill injection; skills
API in stack mode), how runs start, how transcripts are read, how workspaces are reset, the blocker and
what would change with an Intelligence key, and the one-paragraph pitch text ("the coworker brain is
OpenBot's shipped agent-bot; the accepted playbook is pushed as the `ratchet-playbook` skill").

#### I4 unit tests (offline)

- `test_openbot_worker.py`: `to_agui_messages` maps system/user/assistant(tool_calls)/tool messages to the
  AG-UI shape; `parse_agui_events` on fixture SSE text (text only; one tool call with chunked args; RUN_ERROR)
  returns content/tool calls/error; `run_task` with an injected fake `http` object scripted to return
  (write_file call, submit call) produces a Transcript with 2 steps, `worker == "openbot"`, workspace file
  present; `availability` returns `(False, reason)` when nothing listens on the ports (use a closed port).
- `test_crusoe_proxy.py`: body rewriting injects `chat_template_kwargs` and raises `max_tokens`; existing
  `chat_template_kwargs` preserved; the forwarded request never contains the inbound `Authorization` value;
  usage line parsing from a sample upstream response (no network: unit-test the pure functions).

Done criteria (I4): tests green; `bash integrations/openbot/setup.sh` brings up proxy + agent-bot on this Mac;
`python -m ratchet run --config smoke --worker openbot` (I3's CLI) completes with the real agent-bot; or, if
agent-bot cannot run standalone for a reason you document, `OpenBotWorker.availability` explains it and
`--fallback-local` works. `setup.sh --stack` prints the BLOCKER line and exits 2. Report blockers in your
final message.

---

## 6. Concurrency, rate limits, cost and time budgets

Assume 30 RPM / 500k TPM per model. Defaults in `Settings`: `max_inflight_per_model=4`,
`rpm_per_model=24`, jittered exponential backoff on 429/503. Roles use three different models, so worker,
reviewer and planter never compete for the same budget.

Per worker run (one task, one repeat): ~5-7 Lightning calls, ~3k prompt tokens each (playbook + protocol
+ tool schemas ~1.5k fixed, cached by MemoryAlloy when the prefix is byte-identical), ~150 completion.

| Config | holdout x repeats | train/round | calls per gate | wall time per round (24 RPM) | rounds | total |
|---|---|---|---|---|---|---|
| SMOKE | 3 x 1 | 3 x 1 | ~20 + 20 | ~2-3 min (+ ~1.5 min v0) | 1 | < 10 min |
| DEMO | 12 x 2 | 10 x 1 | ~145 + 60 | ~9 min (+ ~6 min v0) | 6 | ~60 min |

Cost (list prices): a DEMO gate is ~24 runs x 20k tokens = 0.5M Lightning tokens = $0.03; a reviewer call
~12k in / 3k out on Super = $0.011; bench-check 24 tasks x ~4 Omni calls x 3k = $0.10. A full DEMO run is
well under $1. Track it anyway: the per-version cost is a chart in the demo.

Live-demo plan: run DEMO ahead of time (`--live` so the report auto-refreshes), keep `runs/` from that run,
and during the pitch open `runs/report.html`; optionally start a SMOKE round live.

---

## 7. End-to-end acceptance check (orchestrator runs this after merging the four deliveries)

```bash
cd /Users/charlie/hackathons/crusoe-hackathon
.venv/bin/python -m pytest                                    # 1. all unit tests green, offline, < 3 min
.venv/bin/python -m ratchet ping                              # 2. three role models answer, thinking off, attempts==1
docker build -t ratchet-sandbox:py312 docker/sandbox           # 3. image builds (optional; auto-fallback otherwise)
.venv/bin/python -m ratchet bench-check                       # 4. 24 tasks, all "strong" (exit 0), cost printed
.venv/bin/python -m ratchet run --config smoke --fresh        # 5. finishes < 10 min; history.json has v0 + v1
.venv/bin/python -m ratchet report --open                     # 6. chart renders; v1 shown accepted or rejected
RATCHET_SANDBOX=subprocess .venv/bin/python -m ratchet run --config smoke --fresh   # 7. fallback sandbox path works
.venv/bin/python -m ratchet run --config smoke --worker openbot                     # 8. exit 3 with a clear reason,
                                                                                    #    or completes after setup.sh
.venv/bin/python -m ratchet run --config smoke --worker openbot --fallback-local    # 9. proceeds with local
.venv/bin/python -m ratchet run --config demo --fresh --live  # 10. >= 1 accepted version with holdout score > v0,
                                                              #     rejected versions visible in the chart,
                                                              #     cost and tokens populated per version,
                                                              #     Super shows cached_tokens > 0 on review calls
.venv/bin/python - <<'EOF'                                     # 11. key never written anywhere (prints only a verdict)
import os, pathlib
from ratchet.config import load_dotenv; load_dotenv(); key = os.environ["CRUSOE_API_KEY"]
hits = [str(f) for d in ("runs", "docs", "ratchet", "integrations", "tests", "playbooks") for f in pathlib.Path(d).rglob("*")
        if f.is_file() and f.stat().st_size < 50_000_000 and key in f.read_bytes().decode("utf-8", "ignore")]
print("key leak:", "none" if not hits else "FOUND in " + ", ".join(hits))
EOF
```

Pass criteria for the demo: step 10 yields a monotone accepted line with at least one step up and at least
one rejected marker (if no rejection happens naturally, that is acceptable; the chart must still show the
rejected-marker legend). The orchestrator records the final `runs/` as the demo artefact.

---

## 8. Integration order for the orchestrator

1. Merge I1 (runtime) first; run its tests and the network smoke.
2. Merge I2; run `bench-check` for real; fix any weak suite with I2's instructions.
3. Merge I3; run SMOKE; then DEMO.
4. Merge I4; run `setup.sh`; run SMOKE with `--worker openbot`.
5. Write `README.md` (pitch, architecture diagram, how to run, sponsor tie-ins, blockers) — orchestrator.

---

## 9. Risk register and blockers

| Risk / blocker | Mitigation / owner |
|---|---|
| CopilotKit Intelligence key missing: OpenBot full stack cannot start; no account creation allowed | I4 agui mode (agent-bot standalone) is the demo path; `setup.sh --stack` reports the BLOCKER; CLI exit 3 / `--fallback-local` |
| Nemotron reasoning eats max_tokens -> empty content | I1 `CrusoeClient` forces `enable_thinking=false` unless asked; I4 proxy does the same for OpenBot |
| 429 bursts at low RPM (`max_requests_limit (orchestrator)`) | per-model semaphore 4 + 24 RPM pacer + jittered backoff; three roles on three models |
| Lightning/Omni never report cached tokens | report shows "n/a"; Super's review calls demonstrate the cache; keep prefixes byte-identical anyway |
| Reviewer overfits train or leaks holdout | reviewer sees train only; `leak_check`; the holdout gate is the final arbiter |
| Reviewer proposes the same rejected edit again | previously rejected diffs + reasons are included in the prompt |
| Planter produces equivalent mutants -> false "weak" | witness check requires reference and mutant to differ on a concrete input before a mutant counts |
| Docker bind-mount permissions on macOS (colima) | `--user uid:gid`; automatic subprocess fallback; `RATCHET_SANDBOX=subprocess` override |
| `tool_choice="required"` breaks Nemotron | never sent |
| You.com keyless path limited to 100/day; keyed path untested | `YOU_API_KEY` is present now: keyed REST is primary; `search_per_task_cap=3`; failures return text, never raise |
| Crusoe cloud access keys absent (CLI, MCP, PromQL metrics) | not needed; cost tracked from `usage` |

---

## 10. Stretch (only after section 7 passes; do not start before)

- **NeMo Evaluator**: `ratchet/nemo_eval.py` (I3) exporting each version's holdout results as a `nel`
  bundle (`results.jsonl` with `problem_idx, repeat, reward`) and shelling out to
  `nel compare runs/versions/vN/nel runs/versions/vM/nel --strict --max-drop 0.0 --show-flips --format json`
  to attach a McNemar/flip report to the version record (`record.json["nemo_compare"]`). Install:
  `uv pip install --python .venv/bin/python "nemo-evaluator[stats]"`. Pure add-on; the gate decision stays ours.
- **NeMo Switchyard** routing (Nano vs Lightning vs Super per task) — pitch material only unless trivial.
- **Thinking A/B**: `RATCHET_WORKER_THINKING=1` to compare worker thinking on/off as two version lines.
