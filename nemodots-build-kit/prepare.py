#!/usr/bin/env python3
"""Prepare pinned source checkouts and Claude build assets; never run application code."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


KIT = Path(__file__).resolve().parent
SOURCES = {
    "opendots": {
        "url": "https://github.com/CopilotKit/OpenDots.git",
        "revision": "ab39f2508f3fd23a949837622456f3d61a108e9a",
        "destination": "NemoDots",
    },
    "openbot_reference": {
        "url": "https://github.com/CopilotKit/OpenBot.git",
        "revision": "12c3a69406b2ca32bcb117c0329c9c6d9359565d",
        "destination": ".references/OpenBot",
    },
}
SERVICE_PIN = "b6932d31a8d6e7896c15139dfc27a6c6911deb27"


def run(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ensure_clone(workspace: Path, spec: dict[str, str], application: bool) -> Path:
    destination = workspace / spec["destination"]
    new = not destination.exists()
    if new:
        destination.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "clone", "--filter=blob:none", spec["url"], str(destination)],
            check=True,
        )
        # Pin only a newly created checkout. Never reset an existing checkout.
        if application:
            run("git", "switch", "-c", "codex/nemodots", spec["revision"], cwd=destination)
            run("git", "remote", "rename", "origin", "upstream", cwd=destination)
        else:
            run("git", "checkout", "--detach", spec["revision"], cwd=destination)
    actual_root = Path(run("git", "rev-parse", "--show-toplevel", cwd=destination)).resolve()
    if actual_root != destination.resolve():
        raise RuntimeError(f"Refusing non-checkout path: {destination}")
    # Permit later implementation commits; require the inspected source in ancestry.
    run("git", "merge-base", "--is-ancestor", spec["revision"], "HEAD", cwd=destination)
    remotes = run("git", "remote", "-v", cwd=destination)
    if spec["url"] not in remotes:
        raise RuntimeError(f"Expected upstream URL is absent at {destination}; inspect manually.")
    return destination


def assets() -> dict[str, Path]:
    output = {
        f"docs/nemodots/{name}": KIT / name
        for name in ("BUILD_PROMPT.md", "TEST_PROMPT.md", "SANDBOX_SPEC.md", "SOURCES.md")
    }
    output["CLAUDE.md"] = KIT / "claude/CLAUDE.md"
    output[".claude/settings.json"] = KIT / "claude/settings.json"
    for source in sorted((KIT / "claude/agents").glob("*.md")):
        output[f".claude/agents/{source.name}"] = source
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=KIT.parent)
    args = parser.parse_args()
    workspace = args.workspace.expanduser().resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    app = ensure_clone(workspace, SOURCES["opendots"], application=True)
    reference = ensure_clone(workspace, SOURCES["openbot_reference"], application=False)
    run("git", "cat-file", "-e", f"{SERVICE_PIN}^{{commit}}", cwd=reference)

    old_manifest_path = app / "docs/nemodots/SOURCE_MANIFEST.json"
    old = json.loads(old_manifest_path.read_text()) if old_manifest_path.exists() else {}
    previous = old.get("installed_assets", {})
    copies = assets()
    # Check every destination before changing any asset. Preserve user-edited files.
    for relative, source in copies.items():
        destination = app / relative
        if not source.is_file():
            raise RuntimeError(f"Missing build asset: {source}")
        if destination.exists() and digest(destination) not in {
            digest(source), previous.get(relative)
        }:
            raise RuntimeError(f"Refusing to overwrite user-edited/unrecognized asset: {destination}")
    for relative, source in copies.items():
        destination = app / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists() or digest(destination) != digest(source):
            shutil.copyfile(source, destination)
    status = app / "docs/nemodots/IMPLEMENTATION_STATUS.md"
    if not status.exists():
        shutil.copyfile(KIT / "IMPLEMENTATION_STATUS.md", status)

    manifest = {
        "project": "NemoDots",
        "prepared_on": "2026-10-18",
        "scope": "Pinned source clones and Claude implementation/verification assets only",
        "application_implemented_by_preparation": False,
        "sources": SOURCES,
        "openbot_computer_service_pin": SERVICE_PIN,
        "engineering_models": {
            "lead_and_review": "claude-opus-5",
            "implementation_and_dependency_audit": "claude-sonnet-5-5",
        },
        "product_inference": {
            "provider": "Crusoe Managed Inference",
            "base_url": "https://api.inference.crusoecloud.com/v1",
            "default_model": "nvidia/Nemotron-3-Super-120B-A12B",
            "live_verified_by_preparation": False,
        },
        "installed_assets": {relative: digest(source) for relative, source in copies.items()},
    }
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    old_manifest_path.write_text(manifest_text)
    (KIT / "SOURCE_MANIFEST.json").write_text(manifest_text)
    print(f"Prepared application: {app}")
    print(f"Source reference: {reference}")
    print(f"Installed {len(copies)} prompt/config assets; application features remain unimplemented.")
    print("No dependency installation, account login, inference request, deployment or Git push performed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
