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
    worker_max_tokens: int = 4096             # 2048 truncated long write_file calls mid-argument
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
    sandbox_backend: str = "auto"             # "auto" | "docker" (strict: never falls back) | "subprocess"
    sandbox_seatbelt: bool = True             # subprocess backend on macOS: sandbox-exec (no network, no $HOME)
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
        s.sandbox_seatbelt = os.environ.get("RATCHET_SEATBELT", "1").strip().lower() not in ("0", "false", "no", "off")
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
