# NemoDots lead notes (run of 2026-10-17)

These amendments take precedence over BUILD_PROMPT.md and TEST_PROMPT.md where they conflict.

## Checkout and git

- Outer repo worktree: `/Users/charlie/hackathons/crusoe-hackathon-nemodots`, branch `nemodots`.
  The application is the `NemoDots/` subtree, imported from CopilotKit/OpenDots at `ab39f2508f3fd23a949837622456f3d61a108e9a` (squashed `git subtree add`).
- The original checkout `/Users/charlie/hackathons/crusoe-hackathon` is on branch `charlie` and another session is actively building there. **Never read from, write to, or run git in that directory.**
- **Only the designated integrator agent runs git** (`git add <explicit paths>` + `git commit`). Builders, reviewers and verifiers never run `git add/commit/stash/checkout/reset/switch/clean/rebase/push`. Never push. Never `git add -A` from the worktree root.
- Never stage `.env`, `NemoDots/.env`, `.mcp.json`, `.references/`, `artifacts/`, `NemoDots/.local/`, `node_modules/`.
- The user asked for every commit to be pushed continuously: the lead runs an auto-push watcher that pushes `nemodots` to `origin` (github.com/charliegillet/crusoe-hackathon) after each commit. Agents still never run `git push` themselves.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Engineering team (Claude) — user override

History, for honest reporting:

- Phase 0 audit, architecture draft/final and the three architecture devil's advocates ran on **Fable 5.1** (the user's first instruction: Fable for planning/review, Opus for implementation). Wave-1 builders (`w1-contracts-v1`, `w1-local-stack`) ran on **Opus 5.5**.
- From then on the user reinstated the original team plan: **Opus** for the architect role, reviewers, the three devil's advocates (concurrency, integration, demo/novelty), the independent verifier, triage and lead integration; **Sonnet 5.5** for the ledger, runtime, integration, sandbox and frontend engineers, repair/closing engineers, the evaluation engineer, docs, and the dependency auditor. The requested ID `claude-opus-5` maps to the current Opus (`claude-opus-5-5`); Sonnet is `claude-sonnet-5-5`.
- The team runs as Claude Code **workflow subagents** orchestrated by deterministic workflow scripts (`nemodots-build` and, in parallel, `nemodots-acceptance`), not native agent teams; label it that way in reports. Record effective model names as reported by the runtime when available.

## Runtime models (Nemotron on Crusoe) — verified live 2026-10-17 by prior research

- Endpoint: `https://api.inference.crusoecloud.com/v1`.
- Primary model (planner, specialists, verifier reasoning, repair): **`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`** (the build prompt's `nvidia/Nemotron-3-Super-120B-A12B` is wrong). $0.30 in / $2.40 out / $0.15 cached per 1M.
- Other live IDs: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/Nemotron-3.5-Lightning-30B-A3B` (cheap, tool calling works). Optional cheaper profiles only after a matched quality eval. Nemotron Ultra is not available.
- Re-verify with `GET /v1/models` before relying on any ID.
- Quirks observed live (see `../.references/research/crusoe.md`, `nvidia.md`):
  - Reasoning is **ON by default**; small `max_tokens` are consumed entirely by reasoning, giving empty `content` and `finish_reason="length"`. Disable with `reasoning_effort: "none"` or `chat_template_kwargs: {enable_thinking: false}`; or allow `max_tokens >= 1024` and read `message.reasoning`.
  - Keep **≤ 4 in-flight requests per model**; bursts give `429 max_requests_limit (orchestrator)`. Jittered exponential backoff on 429/503.
  - **No `x-ratelimit-*` headers** are returned despite docs; throttle client-side.
  - `usage.prompt_tokens_details.cached_tokens` is reported on Super; null on Lightning/Omni → record as unavailable, not zero.
  - Avoid `tool_choice: "required"` (500 on Lightning; Super loops).
- Secrets: the Crusoe key is `CRUSOE_API_KEY` in the worktree root `.env` (gitignored). Create `NemoDots/.env` (gitignored) mapping `OPENAI_API_KEY` from it with a script that never echoes the value (e.g. `node -e` or `awk` writing the file directly). Never print, log, or commit it.

## Local environment facts

- macOS arm64, 10 CPUs, Node v25.8.0, npm 11.11.0, Python 3.13.
- **No Docker runtime** (CLI only, no daemon, no Docker Desktop/OrbStack). Compose files may be authored for portability, but Docker-based gates are **BLOCKED** here; the working local stack must use native binaries.
- Homebrew **PostgreSQL 16.13** (`/opt/homebrew/bin/{postgres,pg_ctl,initdb,psql}`) and **Redis 8.6.2** (`/opt/homebrew/bin/redis-server`).
- **The user already runs Postgres on 5432 and Redis on 6379. Never connect to, modify, stop or reuse them.** NemoDots runs its own instances with data under `NemoDots/.local/` (gitignored):
  - operational Postgres: port **55432**
  - Redis: port **56379**
  - checkout sandbox API: port **4510**
  - (OpenDots app/vite keep their defaults unless they collide.)
- Test suites needing Postgres create uniquely named databases on the NemoDots instance and drop only those.
- Processes an agent starts must be stopped by that agent (or managed by the stack script). Do not kill processes you did not start.

## External dependencies

- **CopilotKit Intelligence: AVAILABLE (updated 2026-10-17 ~13:40 PDT).** The user supplied a hosted key; it is set as `CPK_INTELLIGENCE_API_KEY` in the gitignored `NemoDots/.env`. Verified live: `CopilotKitIntelligence.createThread` + `getThreadMessages` succeeded (probe `.local/keycheck/probe.ts`; it created one test thread, user `nemodots-keycheck`). This supersedes any earlier note or task-prompt text saying Intelligence is BLOCKED: OpenDots conversations now work, and TEST_PROMPT gate 4.8 (conversation reload) must actually be run, not marked BLOCKED. Still: NemoDots mission control, ledger, coordinator and UI must NOT depend on Intelligence (keep them working and honestly labeled when the key is absent), and Intelligence features beyond conversations (Learning, Slack, voice) stay disabled for the incident scope. Never print or commit the key.
- Composio, voice, Slack, Automatic Learning, web-search browser, computers: disabled for the incident scope.
- No public deployment, no pushing, no messages.

## Interface notes from lead fixes

- Inference streaming (`src/server/nemodots/inference/client.ts`): a retried stream restarts from the beginning. `StreamObserver(delta, attempt)` now receives the 1-based attempt number, and `CompleteContext.onAttemptReset(nextAttempt)` fires before a retry whenever the failed attempt had already delivered deltas. **Any consumer that buffers or forwards deltas (team worker loop, SSE/UI streaming, telemetry) must pass `onAttemptReset` and clear what it buffered, or reset when the attempt number changes**; otherwise retried text is duplicated.

## Product name in the UI

The user-facing product name is **NemoDots** (page title, wordmark, unlock screen, user-facing messages and any new UI copy). Say "OpenDots" only for upstream attribution, upstream doc links (github.com/CopilotKit/OpenDots/...), and the CopilotKit telemetry identity, which stay unchanged.

## Coordination rules for parallel agents

- One writer per file. Stay inside your task's allowed files; if you need a change elsewhere, report it as a dependency instead of editing.
- Shared contracts in `src/server/nemodots/contracts/` are owned by whoever the current wave assigns; others import, never edit.
- `docs/nemodots/IMPLEMENTATION_STATUS.md` is written by the integrator/lead only.

## Session handoff (2026-10-18, second machine)

- Work continues on the outer repo's `nemodots` branch (tracking `origin/nemodots` at `8f4d4cf`). Commit locally only; do not push.
- Engineering models (user decision 2026-10-18): Opus roles use `claude-opus-5-5` instead of `claude-opus-5`; builders stay on `claude-sonnet-5-5`. `.claude/agents/*.md` was updated to match.
- Live Crusoe check 2026-10-18: `/v1/models` lists `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` (the ID in `.env`) and one completion returned that model in 1.8 s. The prompt's `nvidia/Nemotron-3-Super-120B-A12B` is not listed. Nano is `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`.
- Gate baseline after `npm ci` on Node v25.2.1: check-format, lint, typecheck, test and build all FAIL. Causes: `ledger/supersession.ts` left mid-edit (`unionAffected` declared twice, unused `CoarseInvalidationRequiredError`), `tests/nemodots/integration/ledger/fix-round1.test.ts` arity, and verifier-owned lint/format errors under `tests/nemodots/acceptance/g5-live-crusoe` and `g6-blackbox/helpers`. 7 `tests/telemetry.test.ts` failures are a tsx parse failure of the server import chain, probably the same supersession error; recheck once it compiles.
- `IMPLEMENTATION_STATUS.md` still lists W2.1-W2.5 as PLANNED, but `ledger/`, `coordinator/`, `sandbox/`, `inference/` and `context/` already hold in-progress code and tests. Reconcile each package against its acceptance checks before resuming.

## Test-output secret hygiene (2026-10-18)

- A `pg.Pool` without an `'error'` listener that is still alive when `withTestDatabase` force-drops its database emits an idle-client 57P01 error. Vitest's "Unhandled Errors" reporter serializes non-enumerable properties, so the stack role password lands in the run output. `pg` itself hides it from `util.inspect`, `JSON.stringify` and `message`. This happened once with a reviewer's temporary debug pool; production listeners log `error.message` only (concurrency review, 2026-10-18).
- `tests/nemodots/helpers/pg-error-guard.ts` (a `setupFiles` entry in `vitest.integration.config.ts`) gives every pool a default listener that prints only `code: message`. Keep it. Test pools should still attach their own listener and `end()` in teardown.
- The dev-stack role passwords appeared once in an agent's tool output (not in any file). Rotate them at a quiet point.

## Team runtime policies (W4.1)

Single source of truth: `incidentTeamConfig()` (`team/policy.ts`) returns the incident-mission team config. Bootstrap (W5.1), the live suite (`tests/nemodots/live/team/config.ts`), the evals and the demo all call it; none may write a literal `requireVerifier`. The library default (a `TeamConfig` without the flag) stays off so other callers and unit fixtures can isolate one behaviour; `policy.test.ts` pins both and that the live config equals `incidentTeamConfig()`. The flags below are operator settings; `describeTeamPolicy()` (`team/policy.ts`) returns the policies in force for the mission report. Units: tests/nemodots/team/policy.test.ts, budget.test.ts.

| Policy                                                 | Default                                               | Where                                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pre-change verification (`TeamConfig.requireVerifier`) | off in the library; **ON** via `incidentTeamConfig()` | `team/tools.ts` (`propose_action`), `team/planner.ts` | A specialist's proposal is refused with `verification_required` until a verifier child it delegated has succeeded with a usable output. A specialist that may not delegate gets `verification_unavailable`. Plans are corrected once if a specialist task lacks `delegate`. Not in CONTRACTS.md: a team-layer tool error code, not a contract type. Delegation depth 2 in live traces (investigator > specialist > verifier) is induced by this policy; the proposals themselves are the model's own choice. |
| Investigator closing check                             | always                                                | `team/worker-loop.ts`, `team/closing-check.ts`        | Before an investigator that has not delegated finishes, one structured call (`{defectFound, area, reason}`) is made. It is compiled and recorded like every model call. At most once per attempt. If the model reports a defect in cache, database or routing, the loop adds a notice naming that area and tells it to delegate; it never chooses a diagnosis, a child question or a fix.                                                                                                                    |
| Plan validity rules                                    | always                                                | `team/planner.ts`                                     | Every task includes `observe`; every investigator includes `delegate`; (with pre-change verification) every specialist includes `delegate`. One correction turn, then `failed(invalid_output)`.                                                                                                                                                                                                                                                                                                              |
| `expectedCurrentValueDigest`                           | derived                                               | `team/tools.ts`                                       | Models cannot compute it. The tool layer ignores the model's value and derives it from the attempt's own latest reading of the key; `observe_first` if the key was not read. The contract field is unchanged.                                                                                                                                                                                                                                                                                                |
| Token budget                                           | per attempt                                           | `team/budget.ts`                                      | Counts input + output tokens against `task.maxTokens`. Cached tokens are reported separately (`attempt_usage` event); `null` (provider did not say) stays distinct from 0.                                                                                                                                                                                                                                                                                                                                   |
| Iterations                                             | 12                                                    | `team/budget.ts`                                      | The last iteration withdraws the tools and asks for the final answer.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Measured need (live, Super, 2026-10-18): the heaviest attempt used 82 277 and 94 964 input+output tokens in two runs (the second run: 13 attempts, 564 821 prompt, 17 021 completion, 225 792 cached). The `taskDefaults.maxTokens: 20_000` in `bootstrap.ts` predates counting input and aborts every worker attempt with `budget_exhausted`; set it to at least 200 000 (the live harness uses 400 000).

## TP-01 key exposure check (2026-10-18)

- The W5.3 repro of TP-01 (upstream default base URL → api.openai.com) ran behind a `vi.spyOn(globalThis, 'fetch')` scripted provider (`tests/nemodots/adversarial/tool-paths/support.ts` `provider()`), with the sentinel key `adversary-provider-key` from `baseConfig()`. The spy captured the api.openai.com requests; no real request and no real key left the machine. The Crusoe key does not need rotating because of TP-01. The defect itself (a silent default host for every Dot) is real and is being fixed.

## Dot-turn scope (final ruling, 2026-10-18)

- The controlled incident scope is the mission team (coordinator, team worker loop, actions). OpenDots Dot chat turns are outside it.
- Incident-Dot turns: page revisions and `read_space_page` results are registered as authority-free `page_snapshot` receipts against exactly one active mission in the projection Space (`NEMODOTS_PROJECTION_SPACE_ID`); otherwise nothing is registered. Dot-turn model calls and context snapshots are not recorded. Incident Dots have no controlled write path: connection actions are refused, page creates are confined to the projection Space, unknown tools are denied, and approvals bind `[]` and are refused.
- Ordinary Dots keep upstream behaviour, outside the guarantee. There is no default provider host for any Dot (TP-01).
- Process lesson: two of the lead's rulings crossed with builder changes on this point. When a ruling may already be overtaken, ask for the current tree state before ruling.

## Acceptance independence disclosure (2026-10-18)

- The ledger engineer (claude-sonnet-5-5) disclosed that while working on W5.3 interception fixes it ran `tests/nemodots/acceptance/g3-tools` and read parts of two of its files and its output log. It cited case g3-04 (`[TP3.3][R10]`) when raising the connection-tools conflict. The lead ruled from TOOL_COVERAGE R10, not from the acceptance case, and told the builder not to read or run `acceptance/**` again. The independent verifier was informed so it can judge g3's independence (for example by adding cases builders have not seen). Record this in the verification report.
