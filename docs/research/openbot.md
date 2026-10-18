# OpenBot (CopilotKit) as the Ratchet worker host — research notes

Source: `vendor/openbot` (shallow clone of github.com/CopilotKit/OpenBot, main, 2026-10-17; `vendor/` is gitignored).
Files read: README.md, docs/{architecture,configuration,coworkers,automatic-learning,routines,development,deployment}.md,
.env.example, docker-compose.yml, scripts/start.sh, server/src/config.ts, server/src/app.ts, agent-bot/src/index.ts,
agent-langgraph/src/index.ts, server/src/plugins/route-groups/skills.ts, server/src/agents/lifecycle-routes.ts.

## Verdict: NO-GO for today. Build Ratchet's worker loop as a plain Python harness on Crusoe.

The blocker is hard, not a time estimate: **OpenBot refuses to start without a CopilotKit Intelligence project
key**, and obtaining one requires `npx copilotkit@latest login` (CopilotKit account sign-in). Our rules forbid
creating accounts/signing up, and we have no key in `.env`. Even if a key appeared, the stack is a multi-GB
Docker build (server + Playwright/Chromium computer image + supervisor + bot) that would eat 30-60 minutes of a
4.5-hour window, and the chat API is the CopilotKit runtime protocol rather than a simple REST "run task, get
transcript" call.

Fallback (recommended): keep the OpenBot *concepts* in the pitch (coworkers with a standing role, a per-run
skill/playbook injected as a system message, an append-only audit trail, a resettable sandbox) and implement
them directly: a Python orchestrator calling Crusoe's OpenAI-compatible endpoint, playbook.md as the "skill",
subprocess/Docker sandbox per task, JSONL transcripts as the audit log. Mention OpenBot as the intended
production host whose contract (AG-UI agent endpoint + skills API) Ratchet's playbook format maps onto.

## Answers to the seven questions

### 1. Can it run WITHOUT a CopilotKit Intelligence key?

**No.** Three sources agree:

- `server/src/config.ts` `runtimeCapabilities()`: if any of `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`,
  `INTELLIGENCE_API_KEY` is missing it throws `CopilotKit Intelligence is required and is not configured`.
  The only runtime mode is `mode: "intelligence"`.
- `.env.example`: "Required: the server refuses to start without the URL, the gateway URL and the key below,
  because Intelligence owns durable threads and memory ... **There is no degraded mode.**"
- docs/configuration.md: "All five above stop server startup if missing."

Threads/transcripts live in Intelligence, not in OpenBot's Postgres (only group chats keep a local
`group_messages` table). The "local" alternative (https://docs.copilotkit.ai/intelligence/self-hosting-local)
is still CopilotKit's free Developer plan: it needs the CLI login and writes a `cpk-...` key. `COPILOTKIT_LICENSE_TOKEN`
is optional; the project key is not. The *Automatic Learning* container is the only Intelligence piece that is
optional ("OpenBot still starts and chats without one").

### 2. Env vars to point built-in bots at Crusoe + Nemotron

All read by the API server and both shipped Bots (`agent-bot` on 4200, `agent-langgraph` on 4201):

```dotenv
OPENAI_BASE_URL=https://api.inference.crusoecloud.com/v1   # any /v1/chat/completions endpoint
OPENAI_API_KEY=<CRUSOE_API_KEY>                            # read from env, never commit
BOT_PROVIDER=openai
BOT_MODEL=nvidia/Nemotron-3.5-Lightning-30B-A3B            # sent verbatim; namespaced names are fine
AGENT_BOT_MODEL=nvidia/Nemotron-3.5-Lightning-30B-A3B      # separate knob for the hand-written agent-bot
# OPENAI_CONTAINER_BASE_URL=...  # only if containers reach the endpoint by a different route (not needed for a public URL)
```

Per-Bot defaults otherwise come from `shared/model-providers.json` (`bots.<name>.model`, default `gpt-5.5`) and the
tenant package's `default_model`. Caveats:

- `agent-bot` speaks `/v1/chat/completions` by hand and only refuses models matching `requiresResponsesApi()`
  (the `gpt-5.6-*` family), so a Nemotron id passes. With `OPENAI_BASE_URL` set, a missing key is tolerated
  (keyless Ollama/vLLM case) but we have a key anyway.
- `agent-langgraph` uses chat completions unless `BOT_RESPONSES_API=true` or the model requires Responses.
  `BOT_REASONING_EFFORT` is OpenAI+Responses-only and makes it refuse to start on other providers; leave unset.
- Neither Bot knows about Nemotron's default reasoning. The Lightning gotcha (reasoning consumes `max_tokens`,
  `content` null) would hit agent-bot's tool loop and look like a silent empty turn. We would have to patch the
  Bot or rely on a Crusoe-side way to disable reasoning. Another reason the plain-Python harness is safer.

### 3. HTTP API to start a run and read the transcript from Python?

Not in a convenient form.

- **Chat turns** go through the CopilotKit runtime mounted at `POST /api/copilotkit` (GraphQL/AG-UI streaming
  protocol used by the React app), not a REST "send message" endpoint. Driving it from Python means
  reimplementing the CopilotKit client protocol.
- **Channels**: `POST /api/channels` (create; binds a coworker and mints an Intelligence thread),
  `GET /api/channels`, `GET /api/channels/:channelId`, `POST /api/channels/:channelId/activity`,
  `PUT /api/channels/:channelId/read`, `DELETE /api/channels/:channelId`. These manage the conversation
  container; the message history itself is read back from Intelligence (thread id in `intelligence_channel_mappings`).
- **Inbound delivery** (Slack/webhook style): `POST /api/delivery/.../conversations/:id/messages` exists but is
  the connector path with its own secrets.
- **Routines**: `POST /internal/routines/run` (worker-only, bearer `MANAGED_AGENT_TOKEN`), 15-minute floor.
- **Tool calls from a Bot**: `POST /api/agent-tools/call` (signed run assertion, not for us).
- **Auth with `OPENBOT_SINGLE_USER=true`**: `server/src/auth/dev-actor.ts` admits *every* request as one fixed
  administrator, so plain `curl http://localhost:3001/api/...` works with no cookie or header. Refused if any
  public origin is configured; loopback is fine. Setting writes also require same-origin JSON (send
  `Origin: http://localhost:3010` + `Content-Type: application/json` if a POST is rejected).

Conclusion: a Python driver would spend hours on the runtime protocol. Not viable today.

### 4. How skills/playbooks are stored; live edits?

Two sources, both become rows in Postgres (deployment skills):

- **Tenant package file** `TENANT_PACKAGE_DIR/skills.yaml` (`slug`, `title`, `summary`, `instructions`, `tools`).
  Seeded **on boot**; docs/configuration.md "Change workflow" says restart the API server after editing YAML.
  A slug a person already owns wins over the package.
- **Skills API** (live, no restart): `POST /api/plugins/skills` body
  `{slug, title, summary, instructions, global?, tools?}` (admin for `global`), `DELETE /api/plugins/skills/:slug`.
  There is no PATCH; an update is delete + post. The in-chat `/skill-creator` flow uses the same endpoint.
- Which Bot *carries* a skill is granted in Admin (agents.yaml `skills:` list for package Bots). A Bot with more
  than twelve tools is offered only the tools of skills matching the message, so skills also gate tool exposure.
- Automatic Learning (Intelligence-side) proposes skills from completed threads but requires an Intelligence
  Learning container and human review/publish in the Intelligence UI, so it cannot be the Ratchet gate.

Mapping to Ratchet: our `playbook.md` is one skill's `instructions`; a version bump is DELETE+POST of the slug.

### 5. Audit log access

`GET /api/admin/audit-events` (paged JSON; filters `from`, `to`, actor, agent, outcome, `initiator_kind`) and
`GET /api/admin/audit-events?format=csv` (newest 5,000 rows, `X-Audit-Export-Truncated` header when capped;
export itself is recorded as `audit.exported`). Rows record every tool/computer decision with the signed
`initiator_kind` (`person`, `routine`, `handoff`, `responsibility`, `memory`, `deployment`). Append-only;
only `AUDIT_RETENTION_DAYS` shrinks it. Admin role needed, which single-user mode grants.

### 6. Resetting a Bot's computer/workspace

- `POST /api/bots/:botId/computers/reset` (also `/computers/stop`, `/computers/update`, `GET /computers`),
  via the supervisor (ensure/stop/reset/list only; Docker socket bound to 127.0.0.1:4500).
- `POST /api/bots/:agentId/reset` (lifecycle reset; `GET .../reset` previews what it would clear).
- `POST /api/bots/computers/terminate-inactive`, `POST /api/bots/people/:userId/terminate-computers`.
- Shell: `docker ps -aq --filter label=openbot.namespace=openbot | xargs docker rm -f`; the supervisor recreates
  the container with the same named volumes (`agent-workspace`, `agent-profiles`) on next request, so a true wipe
  also removes those volumes. `scripts/stop.sh` tears computers down (`--keep-computers` to keep logins).
- Each computer exposes `/workspace`, a browser profile, screenshots and file tools on 4100 behind
  `COMPUTER_TOKEN`; egress is filtered by the Bot's network policy (`EGRESS_POLICY_REQUIRED=0` to run one standalone).

### 7. Minimum services and realistic setup time on a Mac

Minimum (`bash scripts/start.sh`): Postgres (`pgvector/pgvector:pg17`), `migrate`, `server` (Hono, bun, 3001),
`app` (Vite, 3010), routine worker, `agent-computer` (Playwright Chromium + Xvfb image, 4100), `supervisor`
(4500, holds Docker socket), and at least one Bot (`agent-bot` 4200 or `agent-langgraph` 4201). SPIRE services
are optional and not started. Single-container alternative: `ghcr.io/copilotkit/openbot:latest` with
`EMBEDDED_POSTGRES=on` (pre-built, no clone) still needs the three Intelligence values and a model key.

Prereqs we have: Docker, bun 1.3, node/npx, openssl, lsof, curl. Realistic timeline if the key existed:
image pulls/builds 20-45 min (Chromium image is large; compose builds server/supervisor/bot locally),
`bun install` 2-5 min, start.sh + health checks 5 min, Nemotron wiring/debugging the reasoning-null issue
30+ min, then still no Python-callable run API. Total 1.5-3 h of a 4.5 h window, with a hard dependency we
cannot satisfy. Hence NO-GO.

## What to reuse in the Ratchet pitch

- Vocabulary: "coworker" (Bot + standing role), "skill" (our playbook), "audit trail" (our run logs), "computer"
  (our sandbox), "gate" (their Automatic Learning requires human publish; ours is a holdout-set score).
- Shape: one playbook text injected first in the system prompt (good for Crusoe's prefix cache), then the task.
- Future integration path (one sentence in the README): Ratchet's accepted playbook can be pushed to an OpenBot
  deployment with `POST /api/plugins/skills` and its runs read back from `GET /api/admin/audit-events`.

## Blockers to report

- CopilotKit Intelligence project key: required by OpenBot, requires account sign-in, we have none and may not create one.
- (Unrelated to OpenBot but relevant to any host) Nemotron Lightning reasoning-by-default: budget `max_tokens`
  generously or find Crusoe's documented switch to disable reasoning.
