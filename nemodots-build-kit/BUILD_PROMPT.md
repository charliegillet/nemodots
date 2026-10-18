# NemoDots — master implementation prompt

Paste this entire file into a Claude Code session opened in the NemoDots application checkout. The prepared launcher passes the short instruction to read this file instead. This is an implementation assignment: build, run, inspect, repair, and verify the application. Do not stop after producing a plan.

<mission>
Build **NemoDots**, a persistent team of NVIDIA Nemotron agents that restores a malfunctioning application while keeping its shared evidence current.

Tagline: **When evidence changes, the team adapts.**

Problem statement: Autonomous specialists often keep acting on observations that another specialist has already disproved or superseded. Existing conversation history and shared memory can preserve the obsolete premise, so teams repeat investigations, execute stale plans, and restart useful work. NemoDots records which observations each model call and decision received, prevents supported controlled actions from committing against invalid evidence, and repairs affected work while preserving independent valid branches.

The product starts from **CopilotKit OpenDots**. Its workspace, Spaces, pages, specialist conversations, AG-UI streaming, permissions, and computer-service integration are real reusable foundations. Add the missing operational controller; do not replace the application with a generic chatbot or a from-scratch dashboard.

The finished product's reasoning runs on **NVIDIA Nemotron through Crusoe Managed Inference**. Claude is the engineering team building the product. Keep these two model systems separate in configuration, code, telemetry, documentation, and demonstrations.
</mission>

<execution_contract>
- Implement the complete working vertical slice, then harden it against the acceptance tests below. Keep going through integration and regression fixes. A design document, scaffold, pretty animation, prerecorded conversation, or mocked provider response is insufficient completion.
- Preserve user changes and upstream attribution. Read applicable AGENTS.md and CLAUDE.md instructions before editing. Inspect the actual checkout instead of assuming APIs from this prompt still match.
- Make routine reversible engineering choices yourself. Ask only for genuinely missing credentials, an external account interaction, an unavailable requested model, or a decision that cannot be resolved from the existing requirements. Continue independent implementation while those dependencies are unavailable.
- Treat missing dependencies as explicit incomplete gates. Never substitute fake successful results, disable a check, change an assertion to match a failure, or relabel fixtures as live integration.
- Do not set an arbitrary overall engineering time limit. Use bounded runtime retries, recursion, and concurrency because they are part of a correct application. Stop a task that cannot make progress with an inspectable reason instead of spinning forever.
- Keep secrets on the server. Do not print .env values, commit credentials, expose database administrator credentials to model tools, or place API keys in screenshots, browser bundles, fixtures, or reports.
- Do not deploy publicly, publish a repository, push to CopilotKit upstream, or send email/Slack messages as part of this build assignment. Produce a locally reviewable application and reproducible evidence.
- Use explicit outcomes: PASS, FAIL, BLOCKED, or NOT_RUN. A skipped credential-dependent test is not PASS.
</execution_contract>

<models_and_team>
Use these exact engineering models requested by the user:

| Engineering role | Model |
| --- | --- |
| Lead, systems architect, independent verifier, adversarial reviewers | `claude-opus-5` |
| Ledger, runtime, integration, sandbox, frontend implementation; dependency audit | `claude-sonnet-5-5` |

Verify availability in the authenticated environment before dispatch. Use exact IDs rather than the moving `opus` or `sonnet` aliases. Verify the lead's effective model through `/status` and each spawned role through `/tasks` or actual runtime metadata; record requested and effective IDs plus CLI version. Organization allowlists, environment overrides and fallback settings can cause substitution. Do not silently unset the user's settings, guess an effective model, or keep a mismatched role running. If a requested model is unavailable, report that specific dependency and continue any work that can use the available requested model; obtain the user's choice before substituting another one. Do not invent an API option for effort or thinking: use the installed CLI's supported settings. Prefer high effort for the lead and hard correctness review.

Use native Claude Code **agent teams** when the installed release and account actually expose them. Request the experimental agent-team feature through the documented environment setting, verify the available tools, and create one lead with teammates. The repository includes `.claude/agents/*.md` role definitions with full model IDs. When supported, spawn a teammate using the corresponding agent type so its model and tool restrictions apply. Explicitly send the task contract, required references, and acceptance conditions to each teammate: teammates do not automatically inherit the lead's whole conversation or any separately enabled skills.

If native teams are unavailable, use persistent Claude Code subagents with the same roles and exact models. The lead relays findings and maintains the dependency board. Label this fallback accurately. Do not fabricate teammate tools, background sessions, peer messaging, or agent-team execution. A subagent cannot be assumed to create its own nested team. The finished NemoDots runtime must still support its own real bounded recursive delegation.

The experimental `--teammate-mode` flag may be absent from CLI help; absence alone does not prove teams are unavailable. The prepared launcher relies on the documented default in-process mode and omits that flag. Do not assume `isolation: worktree` in a subagent file automatically isolates native teammates. Use explicit file ownership in the shared checkout or actually create isolated worktrees when needed. Keep one writer per file at a time. After session resume, inspect actual teammate availability and respawn/rebrief when needed; do not assume in-process teammates were restored or can create nested teams.

Create these responsibilities, in waves of at most four active teammates unless a concrete independent workload justifies more:

1. **Systems architect / Opus 5** — read the real execution paths, specify invariants and module contracts, identify a narrow enforceable guarantee, resolve integration decisions. Produces architecture and tool-path coverage maps before broad edits.
2. **Ledger engineer / Sonnet 5.5** — PostgreSQL schema/migrations, observation receipts, source revisions, model-call read sets, dependency graph, invalidation, action authorization primitives.
3. **Runtime engineer / Sonnet 5.5** — durable mission/task state machine, bounded dynamic delegation, leases, outbox delivery, abort/recovery, clean context generation, replay and resume.
4. **Integration engineer / Sonnet 5.5** — Crusoe model adapter, OpenDots domain service/tool interception, telemetry, provider smoke test, optional computer-service wiring.
5. **Sandbox engineer / Sonnet 5.5** — real checkout API, PostgreSQL data, Redis cache, controlled action adapter, separate fault injector, independently observable health.
6. **Frontend engineer / Sonnet 5.5** — integrated mission control inside OpenDots, evidence views, branch state, receipts, real streaming events, usable setup and failure states.
7. **Dependency auditor / Sonnet 5.5** — runtime/package/API compatibility, lockfiles, licenses, external service configuration, model availability, migration and clean-install checks. Distinguish package dependencies, task dependencies, and evidence dependencies.
8. **Concurrency devil's advocate / Opus 5** — attempt stale commits, lease overlap, ABA revisions, cross-resource races, duplicate effects, invalidation/commit ordering, incomplete provenance. Require executable reproductions.
9. **Integration devil's advocate / Opus 5** — find bypasses through MCP, Composio, approval callbacks, client tools, learned skills, page edits, shell, direct domain services, or alternate providers. Challenge unsupported Crusoe/cache claims.
10. **Demo and novelty devil's advocate / Opus 5** — challenge whether the team is actually autonomous, whether the fault diagnosis is leaked, whether preserved work is valid, and whether the baseline is strong enough. Do not turn the task into an endless ideation exercise.
11. **Independent verifier / Opus 5** — owns acceptance criteria and integration/race/E2E tests. Reads implementation as needed but verifies external state independently. Runs the separate TEST_PROMPT.md after builders finish.

The lead coordinates contracts, dependencies, integration, and concrete blockers. Teammates report evidence and disagreement directly to the lead. Reviewers must be independent from the author of the component they approve. Separate agents do not create mathematical independence or automatically eliminate correlated model mistakes: executable checks remain authoritative.

Before each implementation wave, the lead records an explicit reviewed task contract in `docs/nemodots/IMPLEMENTATION_STATUS.md`: owner, allowed files, prerequisites, interface version, deliverables, and commands/observable acceptance checks. Native plan-mode approval behavior is not a substitute for this review. Do not rely on a platform's automatically approved teammate plan as proof a lead reviewed it.

Use this handoff shape, as concise text or JSON:

```json
{
  "task": "ledger-invalidation",
  "owner": "ledger-engineer",
  "status": "PASS|FAIL|BLOCKED|NOT_RUN",
  "changedFiles": [],
  "contractVersion": "v1",
  "checks": [{"command": "...", "exitCode": 0, "artifact": "..."}],
  "findings": [],
  "dependencies": [],
  "remainingRisks": []
}
```

Review loop: builder provides a working increment → independent reviewer reproduces or clears specific findings → builder fixes → verifier reruns affected checks. Two adversarial reviewers must inspect the action/commit boundary before live acceptance. Close critical/high findings with evidence; medium findings require a concrete limit or fix. Avoid approval-by-vote and generic 'looks good' messages.

Before production implementation or evaluation tuning, the independent verifier must create and freeze the acceptance contract, deterministic oracle, fixture hashes, thresholds and held-out scenario manifest. Builders cannot weaken them. A legitimate change requires a separate review with before/after rationale. Compute expected dependency closures and effects independently from production invalidation/repair code. Give reviewers concise decision rationale and reproducible evidence; do not require private chain-of-thought transcripts.
</models_and_team>

<sources_and_repository>
Start in the prepared `NemoDots/` clone. The outer `crusoe-hackathon` repository contains research and the canonical build kit; the application is its own Git checkout.

- OpenDots starting revision: `ab39f2508f3fd23a949837622456f3d61a108e9a`.
- OpenBot reference checkout: `../.references/OpenBot`, reference HEAD `12c3a69406b2ca32bcb117c0329c9c6d9359565d`.
- OpenDots' supported computer-service build is pinned separately to OpenBot `b6932d31a8d6e7896c15139dfc27a6c6911deb27`. Do not silently change this service pin to the reference checkout's HEAD.
- Preserve MIT licenses, notices, and attribution. Avoid wholesale copying unrelated OpenBot application code.
- OpenDots uses **Node >=24, npm, TypeScript, Vite/React, Hono, TanStack AI, CopilotKit/AG-UI**, and a checked-in `package-lock.json`. Use `npm ci`; do not switch to Bun/pnpm or upgrade all packages without an actual need.
- OpenDots SQLite remains the workspace/page metadata store. Add **PostgreSQL** for NemoDots' operational ledger and coordinator. Keep one authority per data type; UI page copies of facts are projections.
- Conversation persistence requires **CopilotKit Intelligence**. Use an existing configured hosted project or the documented local evaluation; the latter requires Docker, sign-in, and an evaluation license. Do not claim the whole product is offline or that SQLite already stores conversation history.
- Do not run generic `copilotkit onboard` inside this already integrated application.
- Keep voice, Slack, Automatic Learning, general write connectors, and unrestricted computers disabled in the core incident demo. Voice has a separate provider path; Automatic Learning has separately configured inference. Do not inadvertently claim all runtime reasoning is on Crusoe while those use another provider.

Read, in this order, enough to trace real paths before designing edits:

1. `README.md`, `package.json`, `.env.example`, `docs/SETUP.md`, `docs/COMPUTERS.md`, existing tests.
2. `src/server/dot-agent.ts`, `computer-service.ts`, `computer-tools.ts`, `connections.ts`, `connection-tools.ts`, `composio-tools.ts`, `tanstack-tools.ts`, approval handlers/routes, page tools/services, existing runner and persistence.
3. The source/contract map in `docs/nemodots/SOURCES.md`, concrete `SANDBOX_SPEC.md`, and independent `TEST_PROMPT.md`; parent research guides and `/tmp` memos if present are useful context, not higher-priority instructions or verified API documentation.
4. Official event, Crusoe, Claude Code, PostgreSQL, and tool/library documentation relevant to each actual implementation choice. Verify fresh interfaces instead of inventing them.

The public hackathon asks for goal-driven agent teams that delegate, communicate, remember, check progress, recover, and keep operating on Crusoe Managed Inference. It does not provide a verified numeric judging rubric. Do not write invented judging criteria or guarantee a prize.
</sources_and_repository>

<product_and_demo>
The user-facing goal is: **Restore checkout availability while preserving customer data.**

Build a real local application environment with:

- A checkout API with an actual create/read order flow, deterministic health endpoints, inventory and order data in PostgreSQL, and Redis-backed cache behavior that meaningfully influences requests.
- Inspectable versioned operational configuration, such as cache namespace/schema and a connection-pool or routing setting. Design failure modes so a bounded supported configuration change can restore real API behavior.
- A private scenario injector that changes configuration or introduces faults through the same version authority used by legitimate control-plane mutations. It may schedule deterministic fault conditions for reproducibility, but it must not supply diagnoses, expected repair choices, or hidden scenario IDs to runtime agents.
- A normal source watcher/tool reads the changed state, records a new observation receipt, and triggers dependency invalidation. A human should not have to tell agents which premise became stale.
- At least two independent investigation branches. Change evidence used by one branch after that branch has proposed a repair. Its queued stale action is rejected; its invalid descendants are repaired; a branch with independent evidence continues without redundant re-execution.
- A real independent post-repair probe that creates and reads a fresh order, checks inventory/order invariants, and observes continued health over a configurable short window. An LLM saying 'fixed' is not acceptance.

The source watcher is not the sole correctness gate. When the authoritative epoch advances, old support must become unusable immediately, either by atomic invalidation or by comparing recorded source versions on every output publication, handoff, child enqueue, context reuse and action commit. An epoch whose replacement observation is still pending fails closed. The watcher can subsequently supply the richer receipt, explanation and repair trigger.

Do not hardcode the inference team's plan, tool arguments, causal explanation, or final response for a scenario. It is acceptable to supply domain runbooks, typed tools, roles, budgets, constraints, and deterministic fixture infrastructure. The Nemotron planner must choose a plan, create tasks, delegate dynamically, use actual tool results, and replan from changed evidence.

Show a meaningful example of bounded recursive delegation: a worker can request a narrowly scoped child task that itself creates a justified child investigation, within depth/capability limits. Track parentage and actual model requests. Fixed backend scripts that merely animate a preassigned team do not satisfy this requirement.

A scripted adapter-policy test is appropriate for deterministic race proofs. Label it as such and keep it separate from live autonomous incident trials; the two demonstrate different properties.
</product_and_demo>

<architecture>
Retain OpenDots' existing frontend/server organization. Add clear operational modules with equivalent responsibilities to this structure; adjust paths to match the real codebase rather than forcing a monorepo migration:

```text
src/server/nemodots/
  contracts/           # shared schemas, identities, action policies, events
  db/                  # migrations, transactions, repositories
  ledger/              # observations, readsets, claims, conflicts, invalidation
  coordinator/         # missions, DAG tasks, leases, outbox, recovery
  context/             # scoped fresh contexts and provenance compilation
  inference/           # Crusoe Nemotron adapter, validation, client telemetry
  actions/             # admission, commit, adapters, idempotency/reconciliation
  routes/              # authenticated missions, evidence, events, controls
  telemetry/           # request spans, run export, aggregate metrics bridge
src/.../nemodots/      # existing frontend conventions, no duplicate React app
sandbox/              # real API and independently controlled fault injector
migrations/nemodots/  # if not colocated under db/
tests/nemodots/       # unit, integration, adversarial, UI tests
evals/nemodots/       # seeded scenarios, baseline runners, scoring/export
docs/nemodots/        # contracts, setup, review findings, results and limitations
```

Keep runtime data separate from documentation. Expose a small server API for mission creation/start/pause/resume/cancel, task/evidence/action views, and authenticated event streaming. Use existing owner authentication and origin checks. Avoid tenant or Space IDs supplied by the model granting access; derive authority from the authenticated server scope.

OpenDots' existing runner is not a concurrent incident engine. Build the new coordinator explicitly and reuse appropriate primitives. Do not describe current schedule support as already implementing the required DAG.
</architecture>

<contracts_and_invariants>
Write and review typed Zod/TypeScript contracts before parallel implementation. At minimum:

**ObservationReceipt**

- Immutable ID; mission/owner/Space/environment/resource scope; source ID and source type.
- Observation time, source revision/epoch, content digest, normalized typed value or bounded raw-result reference.
- Status: observed/supported, contested, superseded, retracted, or expired, with explicit transition events. Choose precise enums in the contract.
- Parent/supersedes links, trust classification, and tool/model-call provenance where applicable.
- A model assertion is a hypothesis/claim until an appropriate source supports it. Calling it 'confirmed' must not imply an oracle established semantic truth.

**ModelCallRecord / ContextSnapshot**

- Request ID, mission/task/attempt/agent/model, context schema version, complete IDs/revisions/digests of every injected observation and inherited model-produced artifact.
- Tool schema hash, prefix digest/length, scoped context digest, token usage and timing metadata when available.
- Include facts from tool results, summaries, pages, memories, and replayed history. Lineage is not limited to citations the LLM voluntarily writes.
- Record collection/range revisions for query or negative evidence such as 'no active restrictions exist'. Inserting a relevant restriction must invalidate the absence observation even though no returned row changed.
- Propagate the union of actual injected dependencies into outputs and handoffs conservatively. A specialist can declare additional dependencies but cannot remove required recorded ones.
- Do not inject every fact into every agent and then claim precise selective invalidation. Use scoped retrieval, and measure false invalidation honestly.

**TaskAttempt / DependencyEdge**

- Stable task ID and attempt ID; parent/child relation; prerequisites; causal data dependencies distinct from scheduling edges; role/capability scope; status and allowed transition version.
- Worker lease owner, lease expiry, monotonically increasing fencing token, retry count and bounded budget.
- The output can be usable only if its supporting read set remains valid. A finished but invalid output is not silently reused.
- Detect graph cycles and cap breadth/depth/total tasks. Dynamic delegation must not evade permission scope or budgets.

**ActionIntent / Authorization / ResultReceipt**

- Exact tool/adapter/action name; normalized payload and payload hash; target resource/environment; actor capability; source dependency vector; expected target version; policy version; idempotency key; expiry; attempt fencing token.
- Required predicates derive from a server-owned adapter policy. Workers cannot omit a relevant prerequisite, choose arbitrary policy names, or replace an expected version with a current one without re-authorizing the changed intent.
- Approval binds the exact payload and dependency snapshot. Evidence change between approval and execution requires revalidation. User approval never bypasses existing permission checks or evidence checks.
- Explicit statuses such as proposed, admitted, blocked, committed, dispatched, verified, failed, or outcome_unknown. Distinguish a committed control-plane desired state from a completed external side effect.
- Bind idempotency keys to the canonical payload hash. Reusing a key with a different payload must fail. Duplicate delivery must recover the original result or reconcile an unknown result, not repeat a write blindly.

Separate authoring and dispatch lease lifecycles. Validate the author's fence when it publishes a proposal/decision. A completed author's decision may remain usable with valid support; its old authoring lease need not stay active forever. The current action dispatcher has its own active lease/fence and checks proposal generation, evidence and payload binding at execution. Do not accidentally reject every deferred action because its author finished, or permit a zombie dispatcher because the author was once valid.

**Invalidation / RecoveryEvent**

- Source change and old/new receipt IDs; reason; graph snapshot/version; affected attempts/outputs/actions; preserved branches; scheduled repairs; idempotent event ID.
- Immediate eligibility checks against current authority are transactional. Materializing the descendant closure, notifying workers and scheduling repair may happen asynchronously, provided every publication, reuse, delegation and commit independently rejects obsolete base support before that traversal completes. Independent trusted support must be represented explicitly if an artifact can survive loss of another support path.
- Default conservatively when support sufficiency is unknown. Document a simple dependency model rather than implying sophisticated truth-maintenance semantics that are not implemented.

Maintain these invariants:

1. Operational authority is the typed ledger, not editable page text.
2. No untracked model-visible observation or writable tool path exists inside the claimed controlled scope.
3. An invalid attempt cannot authorize an action, publish a usable decision, or enqueue child work after losing its lease/generation.
4. Invalidating evidence and admitting/committing a controlled dependent action have an explicit serialization order enforced by the same authority.
5. Recovery affects descendants with invalid support; unrelated supported work remains usable.
6. Output claims include evidence references but cannot mint authoritative observation receipts.
7. A mission is successful only after independent live acceptance passes.
8. Cancellation, retries, crashes, and duplicate events produce inspectable states rather than fabricated success.
</contracts_and_invariants>

<atomicity_and_action_boundary>
This is the hardest correctness requirement. Resolve it before presenting a safety claim.

For the **controlled sandbox configuration mutations**, put the source/version authority and supported configuration targets under the same PostgreSQL transactional control boundary. All relevant controlled writers, including the fault injector, must update the authoritative versions consistently.

During a short transaction, acquire locks in a stable order or use a reviewed equivalent isolation strategy; verify the complete required source-version vector, current receipt support, actor permissions, target version, task fencing token, and idempotency binding; apply the supported control-plane mutation; record the result/outbox event. A revision read followed by a later unprotected write is insufficient. PostgreSQL row versioning must be explicit, not based on timestamp ordering alone. Handle serialization/deadlock failures with bounded safe retries.

Use **per-resource/source versions** for relevant dependencies. Do not make every branch depend on one mission-global evidence epoch: that would destroy the selective-recovery behavior. Use a separate run generation only for genuinely global lifecycle cancellation or restart.

Do not hold a database transaction open while calling an LLM, Docker, Redis, or another network API. Do not claim an outbox makes external side effects atomic. For Redis reconciliation, service restarts, browser operations, or other remote actions, implement dispatch checks, resource-specific fencing where supported, idempotency, actual readback, and an explicit unknown-outcome/reconcile state. If the target cannot reject an obsolete token at its own effect boundary, narrow the guarantee and state the residual race.

The strong guarantee is limited to supported controlled commits against **registered** evidence under the common authority. It does not prevent action based on an unobserved real-world change, a dishonest source, or arbitrary shell side effects. If an adapter has only freshness-at-dispatch, label it that way in the UI and exported report.

Compensation is optional and only for explicitly reversible supported operations. Check the current target version before compensation, so rollback cannot overwrite a newer valid repair. Do not roll back an order, external message, or irreversible effect merely because a task was invalidated.

Build a tool-coverage matrix by actual execution path:

- Controlled sandbox action service and direct HTTP routes.
- `ComputerService.action` and any owner/manual action routes.
- MCP `ConnectionService.call`, read tools, mutating calls, approval creation and callback.
- Composio execution, if enabled.
- Converted client tools and learned skill executors, if enabled.
- Page editing and page-context ingestion: edits create document revisions; operational assertions still need observation promotion/validation.
- Background/headless/channel invocation, if enabled.

Instrument every enabled path. Preserve OpenDots' original permissions and approval rules. Default-disable unknown/unclassified tool capabilities for incident agents. An arbitrary shell command cannot be declared semantically safe by a prompt; omit it from the controlled incident toolset or classify it as outside the guarantee. Merely wrapping `tanstackTools(serverTools)` leaves other tool paths uncovered.
</atomicity_and_action_boundary>

<persistent_runtime>
PostgreSQL is the source of truth for missions, tasks, attempts, leases, read sets, events, and outbox records. Redis may deliver wakeups or cache data; losing Redis must not lose authoritative work or authorize duplicate commits.

Implement a documented mission lifecycle and task state machine with compare-and-set transitions. Suggested task states: pending, runnable, leased, running, waiting, succeeded, invalidated, repairing, failed, cancelled. Name/merge states if simpler, but specify allowed transitions and failure recovery.

Workers acquire and renew durable leases with fencing tokens. Every publish/commit path checks the active fencing token. A second worker recovering an expired lease must not allow the first worker to publish later. Implement crash recovery for outbox delivery and unknown action outcomes. Write failure-injection tests at the boundaries, not just happy-path queue tests.

The Nemotron planner emits validated structured plans/tasks. Workers can call bounded `delegate_task`, `observe_source`, `propose_action`, `get_task_status`, and other typed domain tools. Tools derive identity and permissions server-side. Validate malformed model JSON/tool calls; request bounded correction or fail visibly. A model call completing without an acceptable result is not task success.

When evidence changes:

1. Persist the change and invalidation event under the reviewed serialization rules.
2. Mark affected attempts/outputs/actions unusable; prevent new admission against invalid support immediately.
3. Abort affected inference/tool work best-effort, while preserving committed effects and recording unknown outcomes.
4. Invalidate dependent child/handoff work, including work not yet running.
5. Create fresh recovery attempts with scoped current source reads. Do not blindly replay old conversations, stale summaries, or approved old payloads.
6. Preserve independent valid branches and their actual model/tool outputs.
7. Let Nemotron replan affected work from current evidence. Verify recovered outputs and eventual mission acceptance.

Successful controlled writes also advance source revisions. Record server-authored `causedByActionId`, the expected before/after transition and committed post-state revision/digest. A matching self-write moves its action into postcondition verification using fresh post-write evidence; it must not replay the committed mutation or trigger a repair storm because its precondition r1 became the expected r2. Old precondition-based outputs remain historical rather than becoming current support. Unexpected interleaving or a mismatched post-state still triggers recovery. The model cannot spoof an expected-transition marker. Verify this distinction in the coordinator and UI.

Cancellation/pause semantics must specify what happens to active requests, leases, queued intents, and already committed effects. A pause toggle is not proof an in-flight browser action stopped. Persist and show the distinction.
</persistent_runtime>

<crusoe_and_nemotron>
Use the existing OpenAI-compatible adapter where it works, extended behind a small provider interface if needed. Default live settings:

```dotenv
OPENAI_BASE_URL=https://api.inference.crusoecloud.com/v1
OPENAI_MODEL=nvidia/Nemotron-3-Super-120B-A12B
OPENAI_API_KEY=<server-side Crusoe Intelligence Foundry key>
```

These variable names come from OpenDots; the provider is Crusoe. Add well-named NemoDots config aliases only if necessary, with documented precedence and conflict validation. Use distinct least-privilege database credentials. Operational source/version rows and supported configuration targets MUST share one PostgreSQL database/transaction boundary; checkout order/inventory data may use a separate schema/database. Document each connection's authority and validate new config using the server schema. Do not copy the deprecated Llama model from an older quickstart example.

Start with Nemotron Super for planner, specialists, verification reasoning, and repair. Optional later profile: `nvidia/Nemotron-3-Nano-30B-A3B` for simple extraction/routing, only after a matched quality evaluation. No assumed access to Nemotron Ultra. Do not silently fall back to OpenAI, Anthropic, or a local model in live mode.

Before relying on tool use or streaming features, perform a small live smoke test with the configured account/model:

1. Text completion with request timing and actual model identity.
2. A simple typed read-only tool call and tool-result continuation through the real adapter.
3. Structured output validation; use supported tool/schema mechanisms rather than assuming every OpenAI feature is accepted.
4. Streaming event translation and cancellation behavior.
5. Timeout/rate-limit/provider-error handling with bounded exponential backoff and jitter. Distinguish a safe inference retry from retrying an externally mutating tool.

Report BLOCKED if credentials or access are missing. Offline fixtures still run, clearly labeled. Live mode must fail clearly if Crusoe is unreachable; it cannot fall through to fixture mode.

Build a context compiler with deterministic serialization and a stable, authorized reusable prefix:

```text
Common instructions + compatible ordered tool schemas
Stable authorized project/runbook context
Specialist instructions
Current scoped versioned evidence + task + volatile time
```

The existing prompt begins with the specialist role and mixes changing content early. Refactor rather than appending another instruction string. Keep stable schemas/tool ordering identical only where permissions and capabilities truly match. Never share unauthorized context to improve caching. Do not pad prompts or include superseded evidence to manufacture cache hits.

Prefix reuse is only meaningful for compatible model/configuration/token prefixes. Do not claim Super and Nano share a KV cache. MemoryAlloy is Crusoe's inference caching/routing infrastructure; the NemoDots ledger supplies operational memory and validity. Do not reimplement MemoryAlloy or imply it stores our typed facts.

Instrument every real model request: mission/task/attempt, requested and returned model when available, provider hostname, timing, first nonempty streamed token timing, input/output/cached token counts when returned, retries, status, context/prefix hashes, correlation IDs when exposed. Missing cached token usage is null/unavailable, not zero or estimated measured data. Do not log full sensitive prompts by default; retain bounded redacted evidence when required for evaluation.

Crusoe aggregate metrics can corroborate input/output/cached tokens, TTFT, TPOT, requests and errors. Their documented update cadence is one minute with project/model labels; they are not native per-mission traces. An optional metrics bridge uses a separate monitoring token and project ID. Never equate that credential with the inference key. Attribute costs only with a documented current pricing table and actual usage; distinguish estimates from provider billing.

Crusoe must power the whole real team, not one cosmetic summarizer while scripted code supplies the diagnosis. Prove this with request traces across initial planning, concurrent specialist work, and evidence-triggered replanning. A network/provider outage should visibly stop reasoning and show retries/blocking, not continue with a precomputed plan.
</crusoe_and_nemotron>

<frontend>
Extend OpenDots into a focused incident workspace with consistent typography, spacing, keyboard navigation, accessible status labels, and useful loading/error/empty states. Use a restrained charcoal/slate and electric-green accent palette if it fits the existing design. Do not imply official NVIDIA ownership or use trademarks/logos as an endorsement claim.

Required views, preferably in one coherent mission page rather than many disconnected screens:

1. Goal and lifecycle controls; configured provider/model; clear Live / Fixture / Blocked mode badge.
2. Agent/team activity with actual delegated task tree, parentage, capabilities, attempts and current work.
3. Typed evidence ledger showing source, scope, value, revision, observed time, status, supersession and consuming branches. Pages remain editable narrative projections with links to typed records.
4. Dependency graph or accessible task list with the affected region highlighted after source change; distinguish scheduling from evidence dependency.
5. Action inspector with exact proposed payload, required evidence, expected versions, admission result, blocked reason, commit/dispatch/unknown outcome, and verification receipt.
6. Recovery timeline showing why a branch stopped, what was re-read, what was preserved, and the new attempts. No simulated progress or invented 'tokens saved'.
7. Real checkout health, data-integrity acceptance and order probe results.
8. Provider telemetry and comparison report, with unavailable fields shown honestly.

Use server events with durable IDs, reconnect/replay, deduplication and scope checks. A refresh/reconnect must reconstruct state from authoritative storage. Sanitize untrusted page/log content and do not let a source log's instructions become system instructions. Do not expose the private fault manifest or acceptance oracle in agent-readable UI/context.

The public demonstration should make this causal sequence understandable: mission starts → team investigates → source changes → stale action blocked → affected branch repaired while independent work continues → real application passes verification. A manual source-edit control can exist for inspection, but also provide an automatic injector run to demonstrate agents discovering changes themselves.
</frontend>

<phases_and_exit_gates>
Execute in dependency order. Maintain concise status, review findings and unresolved blockers. Do not wait until the end to integrate major pieces.

**Phase 0 — dependency and source audit**

- Verify clones/refs, applicable instructions, Node/npm/Docker, license notices, package/lock consistency and exact requested models.
- Inventory upstream tests and run the existing relevant baseline checks after installation. Save pre-existing failures distinctly; do not attribute them to new code or hide them.
- Inspect Intelligence configuration and document hosted/local requirements without dumping secrets.
- Produce `ARCHITECTURE.md`, `TOOL_COVERAGE.md`, `DEPENDENCIES.md`, `IMPLEMENTATION_STATUS.md` and the initial reviewed contracts.
- Exit: actual paths and external dependencies are known; action correctness boundary accepted by the architect and concurrency reviewer.

**Phase 1 — real sandbox and provider smoke**

- Build Compose profiles/services for operational PostgreSQL, checkout application/storage, Redis, migrations and healthchecks. Use pinned compatible image versions; verify them rather than inventing digests.
- Separate private injector and acceptance credentials from runtime-agent credentials. Do not expose Docker socket or DB admin to agents.
- Seed data deterministically and verify healthy create/read order flow and fault effects externally.
- Implement and run the small Crusoe Nemotron smoke suite if credentials are available.
- Exit: real faults change observable behavior; provider tool-call path works or is explicitly BLOCKED while offline implementation proceeds.

**Phase 2 — ledger, dependency closure and controlled commits**

- Implement migrations, repositories, schema validation, immutable receipts, complete readset capture and dependency edges.
- Implement admission/commit transaction and idempotency; deterministic version conflicts and invalidation tests.
- Concurrency reviewer writes executable stale-before-commit and stale-after-local-check tests before clearing the boundary.
- Exit: real controlled target mutation is rejected on stale/contested/unauthorized evidence and safe on current evidence; direct-route bypass tests pass.

**Phase 3 — persistent autonomous team**

- Implement leased coordinator and outbox recovery; Nemotron planning and scoped worker contexts; bounded dynamic recursive delegation.
- Drive one healthy mission end to end without faults, then a changed-evidence run with affected recovery and preserved independent work.
- Kill/restart a worker during a run and prove persisted recovery and fencing.
- Exit: no prerecorded reasoning; actual team uses tools; independent acceptance decides success.

**Phase 4 — OpenDots integration and mission UI**

- Wire ledger provenance at central model/context construction and all enabled execution/approval paths.
- Integrate mission views, evidence pages, streamed events, source links, controls and real health/provenance telemetry.
- Test setup without credentials, disconnected services, refresh/reconnect, and owner/Space isolation.
- Exit: a user can start and inspect a real mission through the application without database consoles.

**Phase 5 — adversarial hardening and fair evaluation**

- Run TEST_PROMPT.md with independent verifier and both technical devil's advocates.
- Repair discovered failures and run meaningful targeted regressions; rerun broader suite after integrated changes.
- Implement the baseline/evaluation protocol below, export raw results, disclose limitations.
- Exit: all required deterministic gates pass; live provider/Intelligence/E2E gates either pass with evidence or remain explicitly incomplete.

**Phase 6 — reproducibility and final delivery**

- Complete setup, environment template, migration/seed/reset procedures, clean-start commands, demo guide, architecture explanation and limitations.
- Preserve upstream LICENSE and add THIRD_PARTY_NOTICES.md for copied services/assets.
- Save run manifests, review findings, exact commands/exit codes, redacted provider traces, screenshots or video if actually captured, and machine-readable reports under an ignored artifacts directory with a small checked-in summary.
- Bind every gate to application commit plus dirty-diff/untracked source digests, lockfile and oracle/fixture hashes, and redacted configuration. Relevant code/test/config changes invalidate prior PASS results until the appropriate checks are rerun.
- Report implemented behavior, acceptance results, remaining blockers, known limits and how to launch. Do not say 'production-ready', 'never stale', 'guaranteed winner', or 'all tests pass' without the scope/evidence those statements require.
</phases_and_exit_gates>

<testing_and_evaluation>
The independent verifier owns the detailed TEST_PROMPT.md. Builders must still write meaningful component checks and run them. Add test commands/scripts only when their implementation exists. Keep existing upstream checks intact.

Minimum commands to preserve from upstream: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Add separate deterministic database/adapter integration, Playwright UI, live Crusoe smoke, live incident evaluation, and report-generation commands with explicit modes. Do not require network credentials for the unit suite or make live smoke part of every small edit.

Required deterministic checks include source scoping, supersession/conflicts, transitive invalidation, independent support/preservation, inherited and replayed-context provenance, approval-then-change, racing commits, lease fencing, duplicate/unknown outcomes, unauthorized direct service paths, model output validation, prompt injection as data, UI event ordering and reconnect.

Independent live acceptance checks the checkout API and stored application data rather than merely reading the planner's final message or the same cached health object used by the repair agent. Acceptance credentials and private scenario information are not model-visible.

Evaluation must separate operational correctness from efficiency. Implement:

1. **Strong temporal-memory + broad-restart baseline** with identical observation tools, policies, action checks, model and budget. It receives the same source-change notifications but reruns broad affected mission work.
2. **Simple dependent-task restart baseline** with a conventional task dependency graph and the same admission checks. It must be strong enough that a complex ledger does not get credit merely for having any dependencies.
3. **NemoDots selective repair**, using the implemented readset/receipt lineage and independent branch preservation.

If comparing directly to Graphiti/MemTX/CoAgent, use the actual library/system or a faithfully documented bounded implementation. Do not label a homemade vector store 'Graphiti' or claim those prior systems lack features their papers implement. The working literature identifies close prior art: semantic novelty is not automatic.

For Crusoe/context efficiency, use a matched 2×2 comparison: broad restart vs selective repair, each with ordinary vs cache-aware context layout. Keep source information, tool schemas/capabilities, action policies, model IDs, completion budgets and fault schedules comparable. Stable versus volatile placement can vary; do not change task information to create a favorable baseline. Do not imply a prompt-layout experiment isolates the proprietary inference engine's causal contribution. Do not assume a provider cache-disable switch exists.

Use seeded fixtures, multiple changed-evidence fault types and benign/no-fault controls. Freeze held-out scenario seeds before tuning; the verifier controls their manifest. Start with a declared small live cohort and expand only as needed for useful uncertainty estimates and available rate limits. Do not fabricate statistical significance, guaranteed recovery rates, latency wins, cache savings, or financial savings. Publish failures and false blocks.

Per trial report: scenario/seed/commit/config; observed source changes; verified resolution; stale controlled commits; unsafe/untracked external actions; false blocks; missed affected descendants; invalidation/preservation counts; retries/unknown outcomes; actual model calls/tokens; cached token availability; time to recovery and end-to-end completion. Distinguish setup, inference and tool latency. Include repeated-work counts, correctness-conditioned efficiency, and uncertainty where justified. Negative or modest results are valid results.

Required qualitative demonstration: show at least one real trace where an action derived from receipt r1 is rejected after r2 is registered, its worker re-reads/replans, an independent branch is not rerun, and an independent order/inventory probe verifies the eventual repair. Reproduce the stale-commit boundary deterministically even if no live model happens to choose that exact action in every trial.
</testing_and_evaluation>

<final_acceptance>
Do not stop at a plan. The task is complete only when the locally runnable application, integration, hardening, documentation and available live verification have been carried through. If external credentials or access remain missing, state exactly which live gates are BLOCKED and finish all independent code/testing work first; never assert the complete live outcome was achieved.

Before final delivery, have the independent verifier run TEST_PROMPT.md from current files, the dependency auditor review install/start instructions and tool coverage, and the technical devil's advocates review any fixes touching their findings. Preserve a clean reproduction path without wiping user data.

Provide a concise final report with:

- What NemoDots now does and the actual architecture.
- Exact local startup and test commands.
- Test result table with PASS/FAIL/BLOCKED/NOT_RUN and evidence paths.
- Proof Crusoe/Nemotron powered planning, delegation and recovery when live access was available.
- Controlled commit guarantee and external-effect limitations.
- Measured comparison results or honest NOT_RUN status.
- Open findings and required external setup.

Begin now with the repository/dependency audit and dispatch the first independent reviewers while tracing actual source paths. Then implement.
</final_acceptance>
