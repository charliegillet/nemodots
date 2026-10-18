# OpenBot as Ratchet's worker host

**Pitch paragraph.** Ratchet's coworkers can run on OpenBot. The coworker's brain is OpenBot's shipped
`agent-bot` (CopilotKit, MIT), unmodified, running Nemotron 3.5 Lightning on Crusoe Managed Inference.
Ratchet acts as the AG-UI surface and the coworker's computer: it hands the Bot its tools, runs each tool
call in a sandbox, and grades the result with hidden tests. The playbook reaches the Bot the way OpenBot
delivers a skill, as system content at the start of every run. On a full OpenBot deployment, each playbook
that wins on the sealed holdout set is pushed as the `ratchet-playbook` skill.

## Quick start (agui mode: works today, no CopilotKit account)

```bash
bash integrations/openbot/setup.sh                                    # proxy on :8787 + agent-bot on :4200
.venv/bin/python -m ratchet run --config smoke --worker openbot       # the Ratchet loop with OpenBot coworkers
bash integrations/openbot/setup.sh --status                           # health of both
bash integrations/openbot/stop.sh                                     # stop both
```

`setup.sh` is idempotent. It does the following:

1. Checks for bun, curl, openssl and `.venv`.
2. Clones `https://github.com/CopilotKit/OpenBot` into `vendor/openbot` (gitignored) if it is not there,
   then runs `bun install --frozen-lockfile` in `vendor/openbot/agent-bot`.
3. Generates `MANAGED_AGENT_TOKEN` (`openssl rand -hex 32`) into `integrations/openbot/.env.openbot`
   (mode 600, gitignored).
4. Starts `crusoe_proxy.py` and then `agent-bot` in the background. Their pid files and logs go under
   `runs/openbot/`.
5. Waits for both health checks.

- If agent-bot is already running but on a different model than `RATCHET_WORKER_MODEL`, setup restarts it.
- `--restart` stops whatever setup started, then starts it again.
- Nothing setup prints contains a secret.

## What runs where

```
 ratchet (python -m ratchet run --worker openbot)
   OpenBotWorker  ── POST /ag-ui (RunAgentInput, SSE back) ──►  agent-bot (OpenBot, bun)   127.0.0.1:4200
   │  executes tool calls with ToolBox/Sandbox                     │ POST /v1/chat/completions (stream)
   │  in runs/versions/vN/<split>/<task>/rK/workspace              ▼
   └── GET /usage/<runId> ─────────────────────────────────►  crusoe_proxy.py              127.0.0.1:8787
                                                                   │ real key, thinking off, seed, retries
                                                                   ▼
                                                     Crusoe Managed Inference (Nemotron 3.5 Lightning)
```

| Process | Port | Has the Crusoe key? | Started by |
|---|---|---|---|
| `integrations/openbot/crusoe_proxy.py` | 127.0.0.1:8787 | yes (reads the repo `.env`) | `setup.sh` |
| `vendor/openbot/agent-bot` (`bun agent-bot/src/index.ts`) | 127.0.0.1:4200 | no (`OPENAI_API_KEY=$MANAGED_AGENT_TOKEN`, the proxy's client key; clean `env -i`) | `setup.sh` |

## How a run works (agui mode)

OpenBot's agent-bot "publishes no tools of its own": every tool arrives in the run input, and the loop runs
on the client. When the model calls a tool, the Bot ends the run. The surface executes the tool, appends the
result, and starts a new run with the longer conversation. `OpenBotWorker.run_task` is that surface:

1. It sets up `run_dir/workspace` with the starter `solution.py`, the same way `LocalWorker` does, and builds
   a `ToolBox` (write_file, read_file, run_python, run_tests, web_search via You.com, submit).
2. The conversation starts as `[system: playbook + WORKER_PROTOCOL, user: task]`. These are the same bytes
   LocalWorker sends, built by the same functions.
3. Each turn is one AG-UI run, `POST http://127.0.0.1:4200/ag-ui`:
   - Header `x-openbot-agent-token: $MANAGED_AGENT_TOKEN`. This is the header
     `shared/agent-authorisation.ts` checks; it is not `Authorization`.
   - Body:
     `{threadId: "ratchet-v{N}-{task}-r{K}", runId, messages (AG-UI shape), tools (TOOL_SCHEMAS), context, state: {}, forwardedProps: {}}`.
   - The SSE events (`TEXT_MESSAGE_*`, `TOOL_CALL_START/ARGS/END`, `RUN_FINISHED`, `RUN_ERROR`) become one
     assistant message plus tool calls.
4. The tool calls run in Ratchet's sandbox and their results are appended. The step cap, circuit breaker,
   wall clock, "cut off" nudge, handling of malformed arguments and stop reasons all match `LocalWorker`, so
   the two hosts are directly comparable.
5. The Transcript has `worker="openbot"` and carries the final workspace files. Verification runs in
   Ratchet's own sandbox for both hosts.

**Tag and usage plumbing.** agent-bot does not forward request headers to the model endpoint, so an
`X-Ratchet-Tag` header cannot reach the proxy. Instead, every run carries one AG-UI context item,
`{"description": "[ratchet-run-meta]", "value": {"tag", "run", "seed", "ledger", "host_guidance"}}`.
agent-bot turns it into a system message, and the proxy removes it before Crusoe sees it. With
`"host_guidance": "strip"` (what `OpenBotWorker` sends) the proxy also removes agent-bot's fixed
`COMPUTER_GUIDANCE` system message (`vendor/openbot/shared/bot-prompt.ts`), which tells the model about
`computer_navigate`, `computer_snapshot`, `computer_write_file` and other browser tools a Ratchet coworker
does not have. After both removals the model receives the same messages a LocalWorker run sends. The proxy
then:

- sets the paired seed (`crc32(task_id) + repeat`, the same seed LocalWorker uses);
- totals the tokens for that `runId`;
- serves the totals at `GET /usage/<runId>`.

The worker reads that endpoint after each turn. When the CLI passes its `UsageLedger` (`ratchet/cli.py`
does), the worker records each turn under the run's tag, so per-version cost in `history.json` and the
report includes OpenBot runs. Without a ledger, the proxy appends the line to `runs/llm_calls.jsonl` itself.

**Prefix cache.** Every call starts with the same prefix: the playbook, then the protocol (agent-bot's
`COMPUTER_GUIDANCE` is stripped, see above). The tool schemas are also fixed. Only the task and the
conversation vary.

**Comparability.** With the guidance stripped, an OpenBot-hosted run and a LocalWorker run of the same
playbook send the model the same prompt, tools, seed and sampling settings. Scores from the two hosts are
still separate measurements: the gate only ever compares versions measured by the same worker, and a
single 3-task smoke (one repeat each) is too small to say one host scores higher. Smoke runs recorded before
the proxy stripped the guidance (runs/openbot-smoke from the first integration pass) are not comparable
with local runs.

## The Crusoe proxy (`crusoe_proxy.py`)

For every `POST /v1/chat/completions` from agent-bot, the proxy does the following:

- It turns Nemotron reasoning off with
  `chat_template_kwargs = {"enable_thinking": false, "force_nonempty_content": true}`, unless the request
  already sets `chat_template_kwargs`.
- It raises `max_tokens` to at least `Settings.worker_max_tokens` (4096). It sets temperature 0.2 and the
  paired seed when the request has none. It drops `tool_choice: "required"`, which breaks Nemotron.
- It builds the upstream headers from scratch, using the real key. No inbound header is forwarded, the
  inbound `Authorization` included.
- When started by `setup.sh` it requires a client key on `POST /v1/chat/completions` and `GET /v1/models`
  (`Authorization: Bearer $MANAGED_AGENT_TOKEN`, passed to the proxy as `RATCHET_PROXY_CLIENT_KEY`), so other
  local processes cannot spend the Crusoe key; `/health` reports `client_auth: true`. `/health` and
  `/usage/<run>` stay open (read-only, no secrets).
- Its pacing (4 in flight, 24 RPM per model) is separate from `CrusoeClient`'s, so do not run an OpenBot
  smoke while a local DEMO is running; stop the proxy (`bash integrations/openbot/stop.sh`) during the demo.
- It paces requests per model with the same budget as `CrusoeClient` (4 in flight, 24 RPM). It retries 429
  and 5xx errors and connection errors with jittered exponential backoff that honours `Retry-After`.
- **Buffered streams (default).** agent-bot always streams, but the proxy asks Crusoe for one non-streamed
  completion and replays it to the Bot as SSE chunks.
  - The reason is a live measurement on 2026-10-17. Over four identical requests with `stream: true`,
    Crusoe's tool-call parser left Lightning's call in `content` as `<function=write_file><parameter=...>`
    text twice. The same request non-streamed returned a proper `tool_calls` entry all four times.
  - In one small sample of 6 holdout tasks, the pass rate went from 4/6 (passthrough) to 5/6 (buffered).
  - Buffering also gives the Bot exactly the request shape `CrusoeClient` sends for LocalWorker. It lets the
    proxy apply the same retry for an empty, cut-off answer: double `max_tokens` once, up to 16384.
  - `--stream-passthrough` (or `RATCHET_PROXY_STREAM=passthrough`) relays Crusoe's stream instead, with
    `stream_options.include_usage`.
- The log records model, tag, token counts, finish reason, attempts and latency. Message bodies and keys
  are never logged.

Endpoints:

- `GET /health`: status, `key_loaded` (a bool), worker model, stream mode, call count.
- `GET /usage/<runId>`.
- `GET /v1/models` (forwarded to Crusoe).

## Transcripts, audit trail, reset

- `runs/versions/vN/<split>/<task>/rK/transcript.json` holds the full OpenAI-format conversation, the tool
  steps, usage and the final files. It is written by Ratchet's store, the same as for LocalWorker.
- `.../rK/openbot_events.jsonl` has one line per AG-UI run: the raw events the Bot streamed, the run id,
  the attempt number, and any error. This is Ratchet's equivalent of OpenBot's audit trail.
- `runs/openbot/proxy.log` and `runs/openbot/agent-bot.log` hold the service logs.
- Reset: agent-bot keeps no state and every run gets a fresh workspace directory, so `reset()` does
  nothing in agui mode.
- agent-bot logs `SyntaxError: Failed to parse JSON` once per availability check. That entry is expected:
  `OpenBotWorker.availability` sends an unparseable body to check the token without starting a model call.
  A wrong token returns 401; the right token reaches the JSON parser and fails there.

## Full OpenBot stack (mode `stack`)

OpenBot's server will not start without CopilotKit Intelligence (see `vendor/openbot/server/src/config.ts`,
`runtimeCapabilities()`). It needs three settings:

- `INTELLIGENCE_API_URL`: defaults to OpenBot's public endpoint `https://api.intelligence.copilotkit.ai`.
- `INTELLIGENCE_GATEWAY_WS_URL`: defaults to `wss://realtime.intelligence.copilotkit.ai`.
- `INTELLIGENCE_API_KEY`: the project key. `CPK_INTELLIGENCE_API_KEY` (the name OpenBot's own
  `npx copilotkit@latest project select` writes) is accepted as an alias. Ratchet never creates the account.

Both `setup.sh --stack` and `OpenBotWorker.availability(mode="stack")` read these from the environment, the
repo's `.env`, `integrations/openbot/.env.openbot` and `vendor/openbot/.env`, and fill the two URLs with the
defaults above. Intelligence holds OpenBot's durable threads and memory; "there is no degraded mode".

**Status on this machine: unverified.** `.env` holds a value under the Intelligence key names, so
`missing_intelligence()` reports nothing missing. Nobody has checked that it is a valid CopilotKit project key
(Ratchet never creates accounts; whoever added it should confirm it), and an invalid key passes this
configuration check and only fails later, inside OpenBot's server. `availability(mode="stack")` fails at the
next step, `OpenBot server not reachable on 127.0.0.1:3001 — run: bash integrations/openbot/setup.sh --stack`.
The stack itself (Docker Compose build of OpenBot's services) has not been brought up yet: it was deferred
while the local DEMO was running, because the image build competes with the docker sandbox the DEMO's
hidden tests run in. Without a key, `setup.sh --stack` prints
`BLOCKER: CopilotKit Intelligence key (INTELLIGENCE_API_KEY) is required by OpenBot and is not set` and exits
2, and `python -m ratchet run --worker openbot --openbot-mode stack` exits 3 with that reason (with
`--fallback-local` it uses the local worker instead).

`bash integrations/openbot/setup.sh --stack`:

1. Renders `integrations/openbot/tenant/*.yaml` into `vendor/openbot/examples/ratchet`. The
   `ratchet-playbook` skill is filled with the incumbent playbook from `runs/history.json`, or
   `playbooks/v0.md`.
2. Points `vendor/openbot/.env` at that tenant package, at single-user mode, and at the Crusoe proxy
   (`OPENAI_BASE_URL`, or `OPENAI_CONTAINER_BASE_URL=http://host.docker.internal:8787/v1` for containers,
   with `OPENAI_API_KEY` set to the proxy's client key). It sets the model to `RATCHET_WORKER_MODEL` and
   copies in the token and the three Intelligence values.
3. Runs OpenBot's own `scripts/start.sh` (Docker Compose).

What changes in stack mode. Each endpoint below was checked against `vendor/openbot/server/src` and
`@copilotkit/runtime@1.77.0`:

| Concern | agui mode (today) | stack mode |
|---|---|---|
| Run a turn | `POST :4200/ag-ui` + `x-openbot-agent-token` | `POST :3001/api/copilotkit/agent/ratchet-coworker/run` (same RunAgentInput/SSE); the server adds the coworker's standing role |
| Thread | `ratchet-v{N}-{task}-r{K}` | `POST /api/threads/mint` (deployment-prefixed UUID) |
| Playbook | system message (OpenBot skill injection, done by the surface) | `POST /api/plugins/skills {slug: "ratchet-playbook", title, summary, instructions, global: true}`. This is an upsert, so no DELETE is needed. The playbook is also still sent as the system message |
| Audit | `openbot_events.jsonl` | also `GET /api/admin/audit-events` (admin; single-user mode is admin) |
| Reset | no-op | `POST /api/computers/ratchet-coworker/computers/reset`. PLAN.md said `/api/bots/:id/computers/reset`; the computer routes are mounted at `/api/computers` |
| Tools | Ratchet's ToolBox (the same as LocalWorker) | still Ratchet's, sent as client tools in the run input |

Stack mode is implemented and unit-tested against a fake server, but it has not yet run against a real
OpenBot server. Three things are unverified:

- that a `remote-ag-ui` Bot's `skills:` grant applies to the run;
- that the runtime accepts the full message history on a minted thread;
- the `host.docker.internal` route to a proxy bound to loopback. It works on Docker Desktop; colima maps it
  to the host gateway.

## Files

| File | Purpose |
|---|---|
| `crusoe_proxy.py` | the proxy (stdlib `http.server` + httpx) |
| `setup.sh`, `stop.sh` | bring up / tear down; `--status`, `--restart`, `--stack` |
| `.env.openbot.example` | documents `MANAGED_AGENT_TOKEN`, `OPENBOT_*` overrides, `INTELLIGENCE_*` |
| `tenant/agents.yaml` | the "Ratchet Coworker" Bot (`remote-ag-ui` → agent-bot, skill `ratchet-playbook`) |
| `tenant/skills.yaml` | the `ratchet-playbook` skill template (`{{PLAYBOOK}}` filled by setup) |
| `tenant/brand.yaml`, `model.yaml`, `channels.yaml`, `knowledge.yaml` | required by OpenBot's tenant package loader |
| `ratchet/workers/openbot_worker.py` | `OpenBotWorker` (modes `agui`, `stack`), `availability()`, AG-UI helpers |

Environment overrides, all optional: `OPENBOT_AGENT_URL`, `OPENBOT_PROXY_URL`, `OPENBOT_SERVER_URL`,
`OPENBOT_APP_ORIGIN`, `OPENBOT_BOT_ID`, `OPENBOT_AGENT_PORT`, `OPENBOT_PROXY_PORT`,
`RATCHET_PROXY_STREAM=passthrough`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `openbot worker unavailable: Crusoe proxy not reachable on 127.0.0.1:8787` | `bash integrations/openbot/setup.sh` |
| `agent-bot ... runs model 'X' but the worker model is 'Y'` | `bash integrations/openbot/setup.sh --restart` |
| `rejected MANAGED_AGENT_TOKEN` | another agent-bot owns the port, or the token changed: `setup.sh --restart` |
| runs end with `stop_reason="error"` and `RUN_ERROR` in `openbot_events.jsonl` | check `runs/openbot/proxy.log` for upstream status codes (429s are retried 8 times) |
| want the Bot to see Crusoe's raw stream | restart the proxy with `RATCHET_PROXY_STREAM=passthrough` |
