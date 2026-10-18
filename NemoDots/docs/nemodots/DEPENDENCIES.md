# NemoDots dependencies (revision 2)

Three kinds, kept apart: **package** dependencies (what `npm` installs), **task** dependencies (what must be finished before a package can start or be verified), **evidence** dependencies (what must be observed live before a gate moves off BLOCKED/NOT_RUN). Status values: PASS, FAIL, BLOCKED, NOT_RUN, PLANNED. Sources: `audit/DEPENDENCIES_PRE.md`, `audit/BASELINE.md`, `audit/CRUSOE_SMOKE_PRE.md`, `LEAD_NOTES.md` (incl. the 13:40 PDT Intelligence update), verified 2026-10-17.

---

## 1. Package dependencies

### 1.1 Upstream baseline (unchanged)

| Item                                                                                                         | Status                                           | Evidence                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Node v25.8.0 / npm 11.11.0 (engines `>=24`)                                                                  | PASS                                             | `audit/DEPENDENCIES_PRE.md` section 1                                                        |
| `npm ci` (1030 packages, lockfile v3)                                                                        | PASS                                             | warm cache 8 s; one transient cold-cache failure — retry once; never two concurrent installs |
| `npm run typecheck`, `lint`, `test` (54/344), `build`                                                        | PASS                                             | `audit/baseline-*.log`, `.local/baseline/*.log`                                              |
| `npm run check-format`                                                                                       | FAIL (NemoDots docs only)                        | fixed by wave-1 local-stack: `prettier --write docs/nemodots`                                |
| Licenses: OpenDots MIT, OpenBot MIT, prod deps MIT/ISC/Apache/BSD/MPL, no GPL; `khroma` has no license field | PASS (1 open)                                    | `audit/license-scan-prod.txt`; `THIRD_PARTY_NOTICES.md` generated in W5 docs package         |
| OpenBot computer-service pin `b6932d31a8d6e7896c15139dfc27a6c6911deb27`                                      | unchanged, not locally auditable (shallow clone) | keep the pin; computers out of scope                                                         |

### 1.2 Additions (installed once by the integrator in wave 1; nobody else runs `npm install`/`npm ci`)

| Package     | Version (exact) | Kind | Why                                                            | Status  |
| ----------- | --------------- | ---- | -------------------------------------------------------------- | ------- |
| `pg`        | 8.23.1          | prod | PostgreSQL driver (`Pool` per role, `LISTEN/NOTIFY`)           | PLANNED |
| `@types/pg` | 8.23.1          | dev  | types                                                          | PLANNED |
| `redis`     | 5.12.1          | prod | node-redis v5 (Lua `EVAL` for fenced effects, `SCAN`/`UNLINK`) | PLANNED |

Not added, on purpose: a third `openai` copy (adapter uses global `fetch`), `ioredis`/`redis@6` (days-old majors), any ORM/migration library, `@playwright/test` (drive `playwright` 1.63.0 from Vitest with `channel: 'chrome'`), `dotenv`, `uuid`. After the install the integrator re-records `audit/lockfile.sha256`.

### 1.3 Already available and relied upon

`zod 4.6.5`, `hono 4.13.11` + `@hono/node-server 2.1.3` (routes, `streamSSE`, checkout API), `playwright 1.63.0`, `vitest 4.1.11`, `tsx 4.23.15`, `react 19.3` + `react-test-renderer`, `node:crypto`, `node:async_hooks` (`AsyncLocalStorage` for the provenance scope), `node:sqlite` (upstream only).

---

## 2. External services

| Service                                                             | Status                         | Detail                                                                                                                                                                                                                                                                                                                                                            | Needed by                                                       |
| ------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Crusoe Managed Inference `https://api.inference.crusoecloud.com/v1` | PASS (live 2026-10-17)         | 13 models; `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` listed; tool calls, strict json_schema, streaming, cancel verified; no rate-limit headers; `cached_tokens` on Super. **Stub-verified / NOT_RUN live**: 429/503 backoff path; Lightning/Omni `cached_tokens` null (prior research). These stay labelled so in every report unless the opt-in burst test runs | inference adapter, team, evals, Gate 5                          |
| CopilotKit Intelligence                                             | **PASS (available 13:40 PDT)** | `CPK_INTELLIGENCE_API_KEY` set by name in `NemoDots/.env`; `createThread`/`getThreadMessages` verified live by the lead. Dot turns run; gate 4.8 must be run (W6.4). NemoDots mission control never depends on it; Learning/Slack/voice remain disabled for the incident scope                                                                                    | Dot-turn interception live verification (W3.3), gate 4.8 (W6.4) |
| Docker daemon                                                       | BLOCKED                        | CLI only                                                                                                                                                                                                                                                                                                                                                          | compose stack, OpenBot computers                                |
| Homebrew PostgreSQL 16.13                                           | PASS (probe)                   | 55432 only with `LC_ALL=C`; `stack.mjs` sets it                                                                                                                                                                                                                                                                                                                   | everything in PostgreSQL                                        |
| Homebrew Redis 8.6.2                                                | PASS (probe)                   | 56379 with `--dir .local/<instance>/redis`                                                                                                                                                                                                                                                                                                                        | checkout cache, fences, effect markers                          |
| Google Chrome (`/Applications/Google Chrome.app`)                   | PASS (present)                 | `chromium.launch({ channel: 'chrome' })`; Playwright's chromium-1243 not cached                                                                                                                                                                                                                                                                                   | Gate 7 E2E                                                      |
| Parallel / Composio / Slack / voice / OpenBot                       | disabled                       | env unset; `WEB_SEARCH_PROVIDER=disabled`                                                                                                                                                                                                                                                                                                                         | nothing in incident scope                                       |
| User's Postgres 5432 / Redis 6379                                   | never contacted                | every DB helper asserts the NemoDots port or an explicit `NEMODOTS_*` URL; refuses `5432`/`6379`                                                                                                                                                                                                                                                                  | —                                                               |

---

## 3. Task dependencies (ordering between packages)

```text
W1  contracts-v1 ───────────────┬─────────────────────────────────────────────────────────────────┐
W1  local-stack (pg/redis pkgs, stack.mjs, migrate runner, 0001, vitest configs, env, test helpers with per-role URLs)
     │                          │
W2   ├─ ledger (0002: receipts, confirmations, closure, support)   ─ coordinator (0003; ports to ledger)   ─ sandbox-checkout (0004; LISTEN nemodots_action_proposed)
     ├─ inference-adapter (requires OPENAI_BASE_URL)                ─ context-compiler
W3   ├─ actions (0005; admit + commit transactions, dispatch marker, needs ledger + coordinator + sandbox advanceConfig)
     ├─ source-watcher (ledger + readers + coordinator RecoveryPort; history walk)   ├─ opendots-interception (contracts, ledger store; live with Intelligence)
     ├─ telemetry (0006)                                                              └─ ui-foundation (contracts EventPayload union)
W4   ├─ nemotron-team (coordinator, context, inference, ledger, actions port)
     ├─ routes-sse (coordinator, ledger, actions, sandbox, telemetry, watcher manual)   └─ mission-page (ui-foundation; App.tsx edits)
W5   ├─ system-bootstrap (composition root; app.ts/index.ts; worker-main; live mission proofs)
     ├─ concurrency-adversary   ├─ integration-adversary   └─ docs-operator
W6   ├─ evals-harness   ├─ e2e-browser   ├─ demo-adversary   └─ release-report (integrator: gates, gate 4.8, manifests, commit)
```

Hard ordering rules:

1. `local-stack` runs `npm install` exactly once; later packages never touch `node_modules`, `package.json` or the lockfile (W5.1 edits `package.json` scripts only, in a later wave).
2. Migrations are numbered by owning package (`0001` stack, `0002` ledger, `0003` coordinator, `0004` checkout, `0005` actions, `0006` telemetry); the runner discovers files dynamically. A later migration may reference earlier schemas, never the reverse. `0004` creates `checkout.config_versions` with `before_digest`/`after_digest`/`caused_by_*` because the watcher's history walk (W3.2) reads it.
3. Cross-package calls inside a wave go through `contracts/ports.ts`; implementations are wired only in `system-bootstrap` (W5). Unit tests use labelled in-memory port stubs.
4. `NemoDots/.env` exists (Crusoe auditor; mode 0600). `local-stack`'s `write-env.mjs` appends only non-secret `NEMODOTS_*` names/values; role URLs stay in `.local/<instance>/stack/roles.env`.
5. Shared upstream files have one owner per wave: `package.json`/lockfile/`tsconfig.json`/`.gitignore`/`.env.example`/`vitest*.config.ts` → local-stack (W1); `dot-agent.ts`/`pages.ts`/`connections.ts`/`connection-tools.ts`/`connection-routes.ts`/`connection-store.ts`/`computer-service.ts` → opendots-interception (W3); `App.tsx`/`main.tsx` → mission-page (W4); `app.ts`/`index.ts`/`shutdown.ts`/`package.json (scripts)` → system-bootstrap (W5).
6. `docs/nemodots/IMPLEMENTATION_STATUS.md` is edited by the lead/integrator only.
7. Verifier-reserved paths (`tests/nemodots/acceptance/**`, `evals/nemodots/frozen/**`, `docs/nemodots/VERIFICATION_REPORT.md`) are in no package's allowed files. The verifier freezes the acceptance contract and oracle after W1 and before W4.
8. Processes and roles (honest statement, finding I3): the checkout child receives exactly one role URL (`NEMODOTS_PG_URL_CHECKOUT`) plus Redis URL/prefix, its port and the probe secret, via an explicit env object from `stack.mjs`. The OpenDots server process holds the app, injector and verifier URLs (and admin in development for the boot-time migration check). Separation of `control.*` from model context inside that process is code discipline verified by payload scans, not a grant.

---

## 4. Evidence dependencies (what moves a gate off BLOCKED / NOT_RUN)

| Gate / claim                                              | Evidence required                                                                                                                                                                                                                      | Status now                       | Owner                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------- |
| Stack healthy (Gate 0.4)                                  | `nemodots:stack status` → Postgres 55432 accepting, Redis 56379 PONG, checkout 4510 `/health ok`; migrations from empty and upgrade path                                                                                               | NOT_RUN                          | local-stack (W1), sandbox (W2)           |
| Real faults change observable behaviour (Phase 1 exit)    | injector step → symptom of ARCHITECTURE 9.2 via HTTP; B1 leaves every receipt current; metrics expose expected/found schema                                                                                                            | NOT_RUN                          | sandbox-checkout (W2)                    |
| Provider path through the app's adapter (Gate 5)          | `test:nemodots:live -- inference` PASS: text, tool call + continuation, strict json_schema, streaming TTFT, cancel with `usage=null`, 404 envelope; requested == returned; request host == `OPENAI_BASE_URL` host                      | NOT_RUN (standalone script PASS) | inference-adapter (W2)                   |
| 429/503 backoff                                           | stub test (labelled); live row NOT_RUN unless the opt-in `NEMODOTS_LIVE_BURST=1` test on the cheap model hits a 429                                                                                                                    | NOT_RUN                          | inference-adapter (W2)                   |
| Stale commit rejected, current commit safe (Phase 2 exit) | `test:nemodots:db -- actions` PASS incl. duplicate-admit single Authorization, admitted-then-changed commit refusal, expired dispatcher, idempotency replay conflict, citation scope, cross-resource vector, per-resource independence | NOT_RUN                          | actions (W3), concurrency-adversary (W5) |
| Fencing                                                   | `test:nemodots:db -- coordinator` PASS: expired author cannot publish/delegate/propose; orphaned telemetry still stored                                                                                                                | NOT_RUN                          | coordinator (W2), telemetry (W3)         |
| Self-write classification                                 | commit → watcher history walk → intent `verified`, head receipt `selfWrite: verified`, postcondition task, no repair storm; stopped-watcher + injector overwrite → `superseded`/`failed` settled; forged marker rejected               | NOT_RUN                          | source-watcher (W3)                      |
| One healthy live mission end to end (Phase 3 exit)        | `test:nemodots:live -- mission healthy` PASS with Crusoe request receipts for planner + ≥2 workers + ≥1 delegated child (capability-forced)                                                                                            | NOT_RUN                          | system-bootstrap (W5)                    |
| Changed-evidence mission with selective recovery          | `test:nemodots:live -- mission changed-evidence` PASS: honest disjunction recorded (blocked at admission/commit, or committed + second invalidation + repair); structural preserved set with zero new model calls or `NOT_MET`         | NOT_RUN                          | system-bootstrap (W5)                    |
| Kill/restart worker proves fencing                        | live test SIGKILLs the separate `worker-main.ts` process mid-attempt; takeover; late publish rejected                                                                                                                                  | NOT_RUN                          | system-bootstrap (W5)                    |
| Dot-turn instrumentation live                             | `tests/nemodots/live/interception/dot-turn.test.ts` PASS with the Intelligence key                                                                                                                                                     | NOT_RUN (key available)          | opendots-interception (W3)               |
| Conversation persistence (Gate 4.8)                       | TEST_PROMPT 4.8 run live against the upstream chat with the Intelligence key; result recorded in FINAL_REPORT                                                                                                                          | NOT_RUN (key available)          | release-report / integrator (W6)         |
| Mission UI usable in setup state (Phase 4 exit)           | `test:nemodots:e2e` PASS in blocked mode and live mode                                                                                                                                                                                 | NOT_RUN                          | e2e-browser (W6)                         |
| Evaluation comparison                                     | `nemodots:evals -- --suite matched` writes raw trials under `artifacts/`; `EVALUATION.md` with cohort size, uncertainty, `diverging_edges` scenario                                                                                    | NOT_RUN                          | evals-harness (W6)                       |
| Docker-based gates                                        | Docker daemon                                                                                                                                                                                                                          | BLOCKED                          | external                                 |

---

## 5. Environment names (no values)

Upstream: `HOST`, `PORT`, `DATABASE_PATH`, `OWNER_ID`, `OWNER_TOKEN`, `APP_ORIGIN`, `OPENAI_BASE_URL` (**required for live**), `OPENAI_MODEL`, `OPENAI_API_KEY`, `CPK_INTELLIGENCE_API_KEY` (present), `WEB_SEARCH_PROVIDER=disabled`, `DO_NOT_TRACK=1`; voice/Slack/Composio/computer/browser names left empty.

NemoDots (section 12 of ARCHITECTURE.md): `NEMODOTS_INSTANCE`, `NEMODOTS_PG_HOST`, `NEMODOTS_PG_PORT`, `NEMODOTS_PG_DATABASE`, `NEMODOTS_PG_URL_{ADMIN,APP,CHECKOUT,INJECTOR,VERIFIER}` (roles.env only), `NEMODOTS_REDIS_URL`, `NEMODOTS_REDIS_PREFIX`, `NEMODOTS_CHECKOUT_PORT`, `NEMODOTS_CHECKOUT_URL`, `NEMODOTS_PROBE_SECRET` (roles.env only), `NEMODOTS_INFERENCE_MODE`, `NEMODOTS_FIXTURE_PATH`, `NEMODOTS_INFERENCE_MAX_IN_FLIGHT`, `NEMODOTS_PLANNER_MODEL`, `NEMODOTS_WORKER_MODEL`, `NEMODOTS_PROBE_WINDOW_MS`, `NEMODOTS_LEASE_MS`, `NEMODOTS_DISPATCH_LEASE_MS`, `NEMODOTS_MAX_TASKS`, `NEMODOTS_MAX_DEPTH`, `NEMODOTS_WATCH_INTERVAL_MS`, `NEMODOTS_WORKERS`, `NEMODOTS_INCIDENT_DOT_IDS`, `NEMODOTS_TEST_HOOKS` (never in live runs), `NEMODOTS_LIVE_BURST` (opt-in 429 test).
