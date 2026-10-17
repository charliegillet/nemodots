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

## Coordination rules for parallel agents

- One writer per file. Stay inside your task's allowed files; if you need a change elsewhere, report it as a dependency instead of editing.
- Shared contracts in `src/server/nemodots/contracts/` are owned by whoever the current wave assigns; others import, never edit.
- `docs/nemodots/IMPLEMENTATION_STATUS.md` is written by the integrator/lead only.
