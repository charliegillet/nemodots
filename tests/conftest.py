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
    # Set to "" rather than deleting: Settings.from_env() calls load_dotenv(), which only fills names
    # that are NOT already in os.environ, so a deleted name would be refilled from the real .env.
    monkeypatch.setenv("YOU_API_KEY", "")
    monkeypatch.setenv("YDC_API_KEY", "")
    for name in ("INTELLIGENCE_API_KEY", "CPK_INTELLIGENCE_API_KEY", "INTELLIGENCE_API_URL",
                 "INTELLIGENCE_GATEWAY_WS_URL"):
        monkeypatch.setenv(name, "")
    for name in ("RATCHET_WORKER_MODEL", "RATCHET_REVIEWER_MODEL", "RATCHET_PLANTER_MODEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RATCHET_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("RATCHET_SANDBOX", os.environ.get("RATCHET_TEST_SANDBOX", "subprocess"))
    # the live-run guard also checks the repo's default runs/ (a real DEMO may be running there)
    import ratchet.cli

    monkeypatch.setattr(ratchet.cli, "DEFAULT_RUNS_DIR", tmp_path / "runs")
    from ratchet import interrupt

    interrupt.clear()
    yield
    interrupt.clear()


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
