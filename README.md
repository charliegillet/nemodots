# Ratchet

**Agent coworkers that rewrite their own playbook after failures, and keep the new version only if it scores better on a sealed holdout set they never see.**

Built for the Crusoe x Cerebral Valley "Recursive Agents" hackathon (theme: Version n+1). Every model call runs on
Crusoe Managed Inference with NVIDIA Nemotron models.

## How it works

Each round of `python -m ratchet run` does six things:

1. **Work.** Worker agents (Nemotron 3.5 Lightning) solve small Python tasks in a sandbox. They follow the current
   playbook and use six tools: `write_file`, `read_file`, `run_python`, `run_tests`, `web_search` (You.com) and `submit`.
2. **Prove.** Each run is scored by the task's hidden pytest suite. It passes only if pytest exits 0 and reports passed tests.
3. **Test the tests** (`bench-check`). A bug planter (Nemotron Nano Omni) plants a subtle bug in each task's correct
   reference solution. A suite that still passes is too weak to trust, and its task is excluded. All 24 tasks are rated "strong".
4. **Diagnose.** A reviewer (Nemotron 3 Super 120B, thinking on) reads the failed *train* transcripts: tool steps,
   stop reasons and test output.
5. **Change.** The reviewer proposes exactly one targeted playbook edit, stored as a unified diff. A leak check
   rejects any edit that names a holdout task, function or title, except everyday words such as `flatten`,
   `dedent` or `allocate` (a habit like "use textwrap.dedent" may land in a playbook; these words are still
   redacted from everything the reviewer reads, and task ids, compound names and spec titles always count as leaks).
6. **Gate.** The candidate playbook runs the sealed holdout set (DEMO: 12 tasks x 2 repeats, with seeds paired
   to the incumbent's runs). It is kept only if it beats the incumbent by the margin **and** no holdout task
   scores lower than it did under the incumbent. Otherwise it is rolled back, and the reviewer sees the
   rejection the next time.

The demo centrepiece is `runs/report.html`. It shows a scoreboard of holdout score per version, where accepted
versions form a line that only goes up and rejected candidates appear as hollow markers. It also shows tokens,
cached tokens and cost per version, a per-task pass grid, the latest accepted diff and the current playbook.

## Architecture

```
                         python -m ratchet run  (ratchet/cli.py -> loop.py)
                                        │
        ┌───────────────────────────────┼─────────────────────────────────────┐
        ▼                               ▼                                     ▼
  bench-check (mutate.py)        train + holdout runs (gate.py)          reviewer.py
  Nemotron Nano Omni plants      Worker.run_task per (task, repeat)      Nemotron 3 Super
  bugs in reference.py ->        ├─ LocalWorker (worker.py)              reads failed train runs ->
  weak suites excluded           │    tool loop on Crusoe                one PlaybookEdit (diff)
                                 └─ OpenBotWorker (workers/)                   │
                                      OpenBot agent-bot via AG-UI              ▼
                                 tools.py + sandbox.py                   store.py: runs/versions/vN/
                                 (docker --network none; or             history.json, report.py
                                  subprocess + macOS seatbelt)           -> runs/report.html
                                 verify.py: hidden tests -> pass/fail
                                        │
                     every model call: llm.CrusoeClient (thinking off by default, 429/503 backoff,
                     per-model pacing, usage + cost ledger -> runs/llm_calls.jsonl)
```

| Module | Role |
|---|---|
| `ratchet/config.py`, `types.py` | Settings (reads `.env` and never prints keys), model ids, prices, SMOKE/DEMO presets, shared dataclasses |
| `ratchet/llm.py` | `CrusoeClient`: OpenAI-compatible client for Crusoe, reasoning control, retries, per-model throttle, `UsageLedger` |
| `ratchet/sandbox.py`, `tools.py`, `worker.py`, `verify.py` | Sandbox (docker `--network none`, or subprocess under a macOS seatbelt profile), worker tools, `LocalWorker` tool loop, hidden-test verification |
| `ratchet/bench/` | 24 tasks (10 train, 14 holdout): `spec.md`, `starter.py`, `reference.py`, `test_hidden.py`, `meta.json` |
| `ratchet/mutate.py` | Test-the-tests bug planter and the `runs/bench_check.json` cache |
| `ratchet/reviewer.py`, `gate.py`, `loop.py`, `store.py`, `report.py`, `cli.py` | Diagnosis and edit, holdout gate, loop, version store, HTML scoreboard, CLI |
| `ratchet/workers/openbot_worker.py`, `integrations/openbot/` | OpenBot as the coworker host (AG-UI mode) plus a Crusoe proxy for agent-bot |
| `playbooks/v0.md` | The deliberately minimal seed playbook |

Every model call goes through `CrusoeClient`, so tokens, cached tokens and cost are tracked per call, per
version and per phase (train, review, holdout).

## Setup

Requirements: macOS or Linux, Python 3.12+ with [uv](https://docs.astral.sh/uv/), and optionally Docker for the
sandbox. On macOS, colima works; the repo must be under `$HOME` so colima can mount run directories. Bun is
needed only for the OpenBot worker.

```bash
cd crusoe-hackathon
uv venv .venv --python 3.13
uv pip install --python .venv/bin/python -e ".[dev]"
cp .env.example .env            # then fill in the values below
docker build -t ratchet-sandbox:py312 docker/sandbox   # optional; built on demand (see RATCHET_SANDBOX below)
```

`.env` variables:

| Variable | Required | Purpose |
|---|---|---|
| `CRUSOE_API_KEY` | yes | Crusoe Managed Inference key (one key for every model) |
| `CRUSOE_BASE_URL` | yes | `https://api.inference.crusoecloud.com/v1` |
| `YOU_API_KEY` (or `YDC_API_KEY`) | no | You.com Search API for the workers' `web_search` tool; without it the keyless You.com MCP endpoint is used |
| `RATCHET_WORKER_MODEL` / `RATCHET_REVIEWER_MODEL` / `RATCHET_PLANTER_MODEL` | no | Override the role models |
| `RATCHET_SANDBOX` | no | `auto` (default: docker if available, else subprocess), `docker` (strict: fails closed, never runs model code outside the container) or `subprocess` |
| `RATCHET_SEATBELT` | no | `1` (default). On macOS the subprocess backend runs under `sandbox-exec`: no network, no reads of `$HOME` or the repo outside the run's workspace and the venv. `0` turns it off (runs are then marked `unsandboxed`) |
| `RATCHET_RUNS_DIR` | no | Where runs, history and the report go (default `runs/`) |

Keys are never printed or logged. `Settings.__repr__` masks them, and the ledger and transcripts hold no
message content that contains secrets. Every run records where its hidden tests ran (`sandbox` in
`result.json`: `docker`, `seatbelt` or `unsandboxed`), `ratchet run` prints the sandbox it resolved, and the
report header counts runs per sandbox. For a judged run use `RATCHET_SANDBOX=docker`.

## Demo commands

```bash
.venv/bin/python -m pytest                                   # offline unit tests (332 pass, 2 docker tests skipped; RATCHET_DOCKER_TESTS=1 runs them)
.venv/bin/python -m ratchet ping                             # one tiny call per role model
.venv/bin/python -m ratchet bench-check                      # test the tests: 24/24 strong (cached; --force re-checks, ~$0.10)
.venv/bin/python -m ratchet run --config smoke --fresh       # 3 holdout + 3 train tasks, 1 round, ~4-5 min, ~$0.03
.venv/bin/python -m ratchet report --open                    # write and open runs/report.html
.venv/bin/python -m ratchet show                             # incumbent record + playbook (--version N for others)
.venv/bin/python -m ratchet run --config demo --fresh --live # 12x2 holdout, 10 train, 6 rounds; report auto-refreshes
.venv/bin/python -m ratchet run --config demo --rounds 2     # resume: 2 MORE rounds on top of rounds_completed
.venv/bin/python -m ratchet eval --version 3 --split holdout # re-measure one version (writes to runs/evals/)
```

Latest DEMO (docker sandbox, 6 rounds, 5,049 s, $0.64): all six candidates were rejected. v1 did not improve
on v0, and v2 to v6 each regressed at least one holdout task the incumbent passed (v4 scored 66.7% overall,
+4.2 points, but still lost a task). So v0 is still the incumbent at 62.5%, and the scoreboard shows a flat
accepted line with hollow rejected markers. A rising line needs a candidate that clears both the margin and
the no-regression rule.

Useful flags on `run`: `--rounds`, `--repeats`, `--holdout N`, `--train N`, `--min-delta X`, `--worker local|openbot`,
`--fallback-local`, `--playbook PATH`. Exit codes: 0 ok, 1 error (traceback in `runs/loop.log`), 2 configuration,
3 worker unavailable, 4 weak or broken test suites, 130 interrupted.

### Running a long DEMO in the background

```bash
nohup .venv/bin/python -m ratchet run --config demo --fresh --live > runs/demo.log 2>&1 &
echo $! > runs/demo.pid
tail -f runs/demo.log                      # one line per run, one block per round (gate decision)
open runs/report.html                      # auto-refreshes every 20 s while --live is running
.venv/bin/python -m ratchet show           # current incumbent and its playbook
kill $(cat runs/demo.pid)                  # stop (SIGTERM): waits for in-flight runs to end their current
                                           # model call (discarded, re-run on resume), then clears LIVE,
                                           # writes the report, exits 143. A second kill quits at once.
while kill -0 $(cat runs/demo.pid) 2>/dev/null; do sleep 2; done   # wait for it before resuming
.venv/bin/python -m ratchet run --config demo --live --rounds 3    # resume: --rounds = rounds to ADD
```

Do not start any other `ratchet run|eval|bench-check` until a live DEMO finishes: each process paces
Nemotron Lightning on its own (24 RPM), so two together exceed the 30 RPM per-model limit and cause 429s,
slower runs and possible `wallclock` failures that lower the DEMO's scores. While a `--live` run is alive
(its `live_pid` in `runs/history.json`), those commands refuse with exit 2, even with another
`RATCHET_RUNS_DIR`; `--allow-concurrent` overrides this (a second `run` in the same runs dir is never allowed).
Likewise do not run an OpenBot smoke (`--worker openbot`) while a local DEMO is running: the proxy and the local
client pace Nemotron Lightning independently, so together they exceed the per-model rate limit. Stop the
proxy with `bash integrations/openbot/stop.sh` during the live demo. A resume refuses a different
`--config`/`--holdout`/`--train`/`--repeats`/`--min-delta` than the stored history (use `--fresh` or a separate
`RATCHET_RUNS_DIR`); without `--config` it reuses the stored one. It prints `rounds_completed` and which
rounds it will run, because `--rounds N` (default: the config's 6 for demo) always means N more rounds. If a run was killed with SIGKILL,
`ratchet report` clears the stale LIVE flag. When the incumbent passes every train run, the round draws one
fresh train pass (next repeat index) before it stops with `train_clean`; a later resume reuses the stored
passes and draws another fresh one, so a resume never stalls on cached clean results.

`--fresh` deletes `runs/versions/` and `runs/history.json`. It keeps `bench_check.json` and `llm_calls.jsonl`.
To keep an earlier run, copy those files first, or give each run its own `RATCHET_RUNS_DIR`. If you use a
new runs directory, copy `runs/bench_check.json` into it so bench-check is not repeated.

### OpenBot as the coworker host

```bash
bash integrations/openbot/setup.sh                                  # Crusoe proxy :8787 + OpenBot agent-bot :4200
.venv/bin/python -m ratchet run --config smoke --worker openbot     # same loop, OpenBot coworkers
bash integrations/openbot/stop.sh
```

In this mode the coworker's brain is OpenBot's shipped `agent-bot`, unmodified, running Nemotron 3.5 Lightning
through `integrations/openbot/crusoe_proxy.py`. The proxy holds the Crusoe key, turns thinking off, pairs
seeds and records usage. Ratchet acts as the AG-UI surface and the coworker's computer. Full-stack OpenBot
(`setup.sh --stack`, `--openbot-mode stack`) needs a CopilotKit Intelligence key (`INTELLIGENCE_API_KEY`, or
`CPK_INTELLIGENCE_API_KEY`); the two Intelligence URLs default to OpenBot's public endpoints. Stack mode is
unverified: the Docker Compose stack has never been brought up end to end, so a configured key only means the
configuration check passes, not that the key is valid. Without a key both commands report the blocker. See `integrations/openbot/README.md`.

## Sponsor usage

- **Crusoe Managed Inference.** It runs all model calls through one OpenAI-compatible endpoint and one key.
  - The client throttles itself under the per-project, per-model limits (4 requests in flight, 24 RPM per model)
    and backs off with jitter on 429/503.
  - The worker and reviewer prompts put fixed parts first: playbook, protocol and tool schemas, then the
    variable task. This lets MemoryAlloy's prefix cache hit. Super reports `cached_tokens` (for example, 1,152
    of 1,319 prompt tokens on a repeated review call).
  - Tokens, cached tokens and dollar cost are tracked per call (`runs/llm_calls.jsonl`), per version and per
    phase, and drawn in the report. Prices are refreshed from `GET /v1/models`.
- **NVIDIA Nemotron.** Each role uses a different Nemotron model:
  - worker: `nvidia/Nemotron-3.5-Lightning-30B-A3B`, thinking off;
  - reviewer: `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`, thinking on;
  - bug planter: `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B`, with `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` as fallback.

  Reasoning is on by default and can use the whole `max_tokens` budget, so `CrusoeClient` sends
  `chat_template_kwargs.enable_thinking=false` unless thinking is requested. It also retries an empty, cut-off
  reply once with a doubled budget. Lightning sometimes writes a tool call into the message text in its
  chat-template syntax (`<function=write_file><parameter=path>...`) instead of returning a structured
  `tool_calls` entry. `CrusoeClient` and the OpenBot proxy turn complete calls of that kind back into real
  tool calls. When one is cut off at the length limit, the worker is told so and asked to make the call again.
- **You.com Search API.** It backs the workers' `web_search` tool (`ydc-index.io/v1/search`, at most 3 searches
  per task) and falls back to the keyless You.com MCP endpoint.
- **OpenBot (CopilotKit).** It is an optional coworker host; see above.

## Repository layout

```
ratchet/            the package (python -m ratchet)
ratchet/bench/      24 benchmark tasks + split.json
playbooks/v0.md     seed playbook
docker/sandbox/     sandbox image (python:3.12-slim + pytest)
integrations/openbot/  OpenBot setup, Crusoe proxy, tenant config
tests/              offline unit tests (no network, no docker unless opted in)
docs/PLAN.md        the build plan and interface contracts
docs/research/      synthesized research notes (Crusoe, Nemotron, OpenBot, You.com); raw dumps in docs/research/raw/ are gitignored
runs/               generated and gitignored: history.json, versions/, report.html, llm_calls.jsonl, bench_check.json
```
