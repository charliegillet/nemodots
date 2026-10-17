# NemoDots — master implementation prompt

> Lead amendments for this run live in `docs/nemodots/LEAD_NOTES.md` and take precedence where they conflict with this file (model IDs, engineering-team models, environment facts).

This is an implementation assignment: build, run, inspect, repair, and verify the application. Do not stop after producing a plan.

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
(Engineering-team model assignments are overridden by LEAD_NOTES.md: Fable for planning/review/verification, Opus for implementation.)

Responsibilities:

1. **Systems architect** — read the real execution paths, specify invariants and module contracts, identify a narrow enforceable guarantee, resolve integration decisions. Produces architecture and tool-path coverage maps before broad edits.
2. **Ledger engineer** — PostgreSQL schema/migrations, observation receipts, source revisions, model-call read sets, dependency graph, invalidation, action authorization primitives.
3. **Runtime engineer** — durable mission/task state machine, bounded dynamic delegation, leases, outbox delivery, abort/recovery, clean context generation, replay and resume.
4. **Integration engineer** — Crusoe model adapter, OpenDots domain service/tool interception, telemetry, provider smoke test, optional computer-service wiring.
5. **Sandbox engineer** — real checkout API, PostgreSQL data, Redis cache, controlled action adapter, separate fault injector, independently observable health.
6. **Frontend engineer** — integrated mission control inside OpenDots, evidence views, branch state, receipts, real streaming events, usable setup and failure states.
7. **Dependency auditor** — runtime/package/API compatibility, lockfiles, licenses, external service configuration, model availability, migration and clean-install checks. Distinguish package dependencies, task dependencies, and evidence dependencies.
8. **Concurrency devil's advocate** — attempt stale commits, lease overlap, ABA revisions, cross-resource races, duplicate effects, invalidation/commit ordering, incomplete provenance. Require executable reproductions.
9. **Integration devil's advocate** — find bypasses through MCP, Composio, approval callbacks, client tools, learned skills, page edits, shell, direct domain services, or alternate providers. Challenge unsupported Crusoe/cache claims.
10. **Demo and novelty devil's advocate** — challenge whether the team is actually autonomous, whether the fault diagnosis is leaked, whether preserved work is valid, and whether the baseline is strong enough. Do not turn the task into an endless ideation exercise.
11. **Independent verifier** — owns acceptance criteria and integration/race/E2E tests. Reads implementation as needed but verifies external state independently. Runs the separate TEST_PROMPT.md after builders finish.

Reviewers must be independent from the author of the component they approve. Separate agents do not create mathematical independence or automatically eliminate correlated model mistakes: executable checks remain authoritative.

Before each implementation wave, the lead records an explicit reviewed task contract in `docs/nemodots/IMPLEMENTATION_STATUS.md`: owner, allowed files, prerequisites, interface version, deliverables, and commands/observable acceptance checks.

Handoff shape:

```json
{
  "task": "ledger-invalidation",
  "owner": "ledger-engineer",
  "status": "PASS|FAIL|BLOCKED|NOT_RUN",
  "changedFiles": [],
  "contractVersion": "v1",
  "checks": [{ "command": "...", "exitCode": 0, "artifact": "..." }],
  "findings": [],
  "dependencies": [],
  "remainingRisks": []
}
```

Review loop: builder provides a working increment → independent reviewer reproduces or clears specific findings → builder fixes → verifier reruns affected checks. Two adversarial reviewers must inspect the action/commit boundary before live acceptance. Close critical/high findings with evidence; medium findings require a concrete limit or fix. Avoid approval-by-vote and generic 'looks good' messages.

Before production implementation or evaluation tuning, the independent verifier must create and freeze the acceptance contract, deterministic oracle, fixture hashes, thresholds and held-out scenario manifest. Builders cannot weaken them. A legitimate change requires a separate review with before/after rationale. Compute expected dependency closures and effects independently from production invalidation/repair code.
</models_and_team>

<sources_and_repository>

- OpenDots starting revision: `ab39f2508f3fd23a949837622456f3d61a108e9a` (imported as the `NemoDots/` subtree).
- OpenBot reference checkout: `../.references/OpenBot` (relative to NemoDots/), reference HEAD `12c3a69406b2ca32bcb117c0329c9c6d9359565d`.
- OpenDots' supported computer-service build is pinned separately to OpenBot `b6932d31a8d6e7896c15139dfc27a6c6911deb27`. Do not silently change this service pin.
- Preserve MIT licenses, notices, and attribution. Avoid wholesale copying unrelated OpenBot application code.
- OpenDots uses **Node >=24, npm, TypeScript, Vite/React, Hono, TanStack AI, CopilotKit/AG-UI**, and a checked-in `package-lock.json`. Use `npm ci`; do not switch to Bun/pnpm or upgrade all packages without an actual need.
- OpenDots SQLite remains the workspace/page metadata store. Add **PostgreSQL** for NemoDots' operational ledger and coordinator. Keep one authority per data type; UI page copies of facts are projections.
- Conversation persistence requires **CopilotKit Intelligence**. Do not claim the whole product is offline or that SQLite already stores conversation history.
- Do not run generic `copilotkit onboard` inside this already integrated application.
- Keep voice, Slack, Automatic Learning, general write connectors, and unrestricted computers disabled in the core incident demo.

Read, in this order, enough to trace real paths before designing edits:

1. `README.md`, `package.json`, `.env.example`, `docs/SETUP.md`, `docs/COMPUTERS.md`, existing tests.
2. `src/server/dot-agent.ts`, `computer-service.ts`, `computer-tools.ts`, `connections.ts`, `connection-tools.ts`, `composio-tools.ts`, `tanstack-tools.ts`, approval handlers/routes, page tools/services, existing runner and persistence.
3. `docs/nemodots/TEST_PROMPT.md`, `LEAD_NOTES.md`; parent research in `../.references/research/` is useful context, not verified API documentation.
4. Official event, Crusoe, PostgreSQL, and tool/library documentation relevant to each actual implementation choice.

The public hackathon asks for goal-driven agent teams that delegate, communicate, remember, check progress, recover, and keep operating on Crusoe Managed Inference. It does not provide a verified numeric judging rubric.
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

The source watcher is not the sole correctness gate. When the authoritative epoch advances, old support must become unusable immediately, either by atomic invalidation or by comparing recorded source versions on every output publication, handoff, child enqueue, context reuse and action commit. An epoch whose replacement observation is still pending fails closed.

Do not hardcode the inference team's plan, tool arguments, causal explanation, or final response for a scenario. It is acceptable to supply domain runbooks, typed tools, roles, budgets, constraints, and deterministic fixture infrastructure. The Nemotron planner must choose a plan, create tasks, delegate dynamically, use actual tool results, and replan from changed evidence.

Show a meaningful example of bounded recursive delegation: a worker can request a narrowly scoped child task that itself creates a justified child investigation, within depth/capability limits. Track parentage and actual model requests.

A scripted adapter-policy test is appropriate for deterministic race proofs. Label it as such and keep it separate from live autonomous incident trials.
</product_and_demo>

<architecture>
Retain OpenDots' existing frontend/server organization. Add clear operational modules with equivalent responsibilities; adjust paths to match the real codebase:

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

Expose a small server API for mission creation/start/pause/resume/cancel, task/evidence/action views, and authenticated event streaming. Use existing owner authentication and origin checks. Derive authority from the authenticated server scope, never from model-supplied IDs.

OpenDots' existing runner is not a concurrent incident engine. Build the new coordinator explicitly and reuse appropriate primitives.
</architecture>

<contracts_and_invariants>
Write and review typed Zod/TypeScript contracts before parallel implementation. At minimum:

**ObservationReceipt**: immutable ID; mission/owner/Space/environment/resource scope; source ID and source type; observation time, source revision/epoch, content digest, normalized typed value or bounded raw-result reference; status (observed/supported, contested, superseded, retracted, expired) with explicit transition events; parent/supersedes links, trust classification, tool/model-call provenance. A model assertion is a hypothesis/claim until an appropriate source supports it.

**ModelCallRecord / ContextSnapshot**: request ID, mission/task/attempt/agent/model, context schema version, complete IDs/revisions/digests of every injected observation and inherited model-produced artifact; tool schema hash, prefix digest/length, scoped context digest, token usage and timing. Include facts from tool results, summaries, pages, memories, and replayed history — lineage is not limited to citations. Record collection/range revisions for query or negative evidence ('no active restrictions exist'); inserting a relevant restriction must invalidate the absence observation. Propagate the union of injected dependencies into outputs and handoffs conservatively; a specialist can add but not remove dependencies. Use scoped retrieval and measure false invalidation honestly.

**TaskAttempt / DependencyEdge**: stable task ID and attempt ID; parent/child; prerequisites; causal data dependencies distinct from scheduling edges; role/capability scope; status and transition version; worker lease owner, expiry, monotonically increasing fencing token, retry count, bounded budget. An output is usable only while its supporting read set remains valid. Detect cycles; cap breadth/depth/total tasks; delegation cannot evade permission scope or budgets.

**ActionIntent / Authorization / ResultReceipt**: exact tool/adapter/action; normalized payload and hash; target resource/environment; actor capability; source dependency vector; expected target version; policy version; idempotency key; expiry; attempt fencing token. Required predicates derive from a server-owned adapter policy. Approval binds exact payload and dependency snapshot; evidence change between approval and execution requires revalidation. Statuses: proposed, admitted, blocked, committed, dispatched, verified, failed, outcome_unknown. Distinguish committed control-plane desired state from completed external side effect. Bind idempotency keys to payload hash; reuse with different payload fails; duplicate delivery recovers the original result.

Separate authoring and dispatch lease lifecycles: validate the author's fence at proposal publication; the dispatcher has its own lease/fence and checks proposal generation, evidence and payload binding at execution.

**Invalidation / RecoveryEvent**: source change, old/new receipt IDs, reason, graph snapshot/version, affected attempts/outputs/actions, preserved branches, scheduled repairs, idempotent event ID. Immediate eligibility checks are transactional; closure materialization and repair scheduling may be async provided every publication/reuse/delegation/commit independently rejects obsolete support. Default conservatively when support sufficiency is unknown.

Invariants:

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
For **controlled sandbox configuration mutations**, put the source/version authority and supported configuration targets under the same PostgreSQL transactional boundary. All controlled writers, including the fault injector, update the authoritative versions consistently.

In a short transaction, lock in stable order (or equivalent reviewed isolation); verify the complete required source-version vector, current receipt support, actor permissions, target version, task fencing token and idempotency binding; apply the mutation; record result/outbox event. Explicit row versioning, not timestamps. Bounded retries on serialization/deadlock failures.

Use **per-resource/source versions**, not a mission-global epoch (which would destroy selective recovery). Use a run generation only for global lifecycle cancellation/restart.

Never hold a DB transaction open while calling an LLM, Docker, Redis, or network API. An outbox does not make external effects atomic. For Redis reconciliation, restarts or remote actions: dispatch checks, resource fencing where supported, idempotency, readback, explicit outcome_unknown/reconcile state. If the target cannot reject an obsolete token at its effect boundary, narrow the guarantee and state the residual race (label "freshness-at-dispatch" in UI and report).

The strong guarantee is limited to supported controlled commits against **registered** evidence under the common authority. Compensation is optional, only for explicitly reversible operations, and must check the current target version first.

Build a tool-coverage matrix by execution path: controlled sandbox action service and direct HTTP routes; `ComputerService.action` and owner/manual routes; MCP `ConnectionService.call`, read tools, mutating calls, approval creation and callback; Composio; converted client tools and learned skill executors; page editing and page-context ingestion; background/headless/channel invocation. Instrument every enabled path, preserve OpenDots permissions/approvals, default-disable unknown capabilities for incident agents, and omit arbitrary shell from the controlled toolset.
</atomicity_and_action_boundary>

<persistent_runtime>
PostgreSQL is the source of truth for missions, tasks, attempts, leases, read sets, events, and outbox records. Redis may deliver wakeups or cache data; losing Redis must not lose authoritative work or authorize duplicate commits.

Documented mission lifecycle and task state machine with compare-and-set transitions (pending, runnable, leased, running, waiting, succeeded, invalidated, repairing, failed, cancelled or simplified equivalents with specified transitions). Durable leases with fencing tokens; every publish/commit checks the active token; a recovered expired lease prevents the old worker from publishing. Crash recovery for outbox and unknown action outcomes, with boundary failure-injection tests.

The Nemotron planner emits validated structured plans/tasks. Workers call bounded `delegate_task`, `observe_source`, `propose_action`, `get_task_status`, and other typed domain tools. Tools derive identity and permissions server-side. Validate malformed model JSON/tool calls; bounded correction or visible failure.

When evidence changes: persist change + invalidation; mark affected attempts/outputs/actions unusable and block new admission immediately; abort affected inference/tool work best-effort; invalidate dependent child/handoff work; create fresh recovery attempts with scoped current reads (no blind replay); preserve independent branches; let Nemotron replan; verify recovered outputs and mission acceptance.

Successful controlled writes advance source revisions with server-authored `causedByActionId` and expected before/after transition; a matching self-write goes to postcondition verification with fresh evidence, not replay or a repair storm. Unexpected interleaving or mismatched post-state triggers recovery. The model cannot spoof the marker.

Cancellation/pause semantics must specify active requests, leases, queued intents, and committed effects. Persist and show the distinction.
</persistent_runtime>

<crusoe_and_nemotron>
Use the existing OpenAI-compatible adapter where it works, behind a small provider interface if needed. Default live settings (see LEAD_NOTES.md for the verified model ID):

```dotenv
OPENAI_BASE_URL=https://api.inference.crusoecloud.com/v1
OPENAI_MODEL=nvidia/NVIDIA-Nemotron-3-Super-120B-A12B
OPENAI_API_KEY=<server-side Crusoe key>
```

Use distinct least-privilege database credentials. Source/version rows and supported configuration targets MUST share one PostgreSQL database/transaction boundary. Do not silently fall back to another provider in live mode.

Live smoke test before relying on features: (1) text completion with timing and returned model identity; (2) typed read-only tool call and tool-result continuation through the real adapter; (3) structured output validation; (4) streaming translation and cancellation; (5) timeout/rate-limit/provider-error handling with bounded exponential backoff and jitter; distinguish safe inference retry from retrying a mutating tool. BLOCKED if credentials missing; live mode fails clearly if Crusoe is unreachable.

Context compiler with deterministic serialization and a stable authorized prefix:

```text
Common instructions + compatible ordered tool schemas
Stable authorized project/runbook context
Specialist instructions
Current scoped versioned evidence + task + volatile time
```

Never share unauthorized context to improve caching; do not pad prompts. Do not claim different models share KV cache. MemoryAlloy is Crusoe's caching infrastructure; the NemoDots ledger supplies operational memory.

Instrument every model request: mission/task/attempt, requested/returned model, provider host, timing, first nonempty token timing, input/output/cached tokens when returned (missing = null, not zero), retries, status, context/prefix hashes. Do not log full prompts by default.

Crusoe must power the whole team: planning, concurrent specialists, and evidence-triggered replanning, proven by request traces. A provider outage should visibly stop reasoning.
</crusoe_and_nemotron>

<frontend>
Extend OpenDots into a focused incident workspace (restrained charcoal/slate with electric-green accent if it fits; no NVIDIA logos/endorsement implication). Required views, preferably one coherent mission page:

1. Goal and lifecycle controls; configured provider/model; Live / Fixture / Blocked badge.
2. Agent/team activity: delegated task tree, parentage, capabilities, attempts, current work.
3. Typed evidence ledger: source, scope, value, revision, observed time, status, supersession, consuming branches.
4. Dependency graph or accessible task list with affected region highlighted; scheduling vs evidence edges distinguished.
5. Action inspector: payload, required evidence, expected versions, admission result, blocked reason, commit/dispatch/unknown outcome, verification receipt.
6. Recovery timeline: why a branch stopped, what was re-read, what was preserved, new attempts.
7. Real checkout health, data-integrity acceptance and order probe results.
8. Provider telemetry and comparison report with unavailable fields shown honestly.

Server events with durable IDs, reconnect/replay, dedup and scope checks; refresh reconstructs from storage. Sanitize untrusted content. Do not expose the private fault manifest or oracle. Provide a manual source-edit control and an automatic injector run.
</frontend>

<phases_and_exit_gates>
**Phase 0 — dependency and source audit**: verify refs, instructions, Node/npm, licenses, lockfile, models; run upstream baseline checks and record pre-existing failures; inspect Intelligence config; produce `ARCHITECTURE.md`, `TOOL_COVERAGE.md`, `DEPENDENCIES.md`, `IMPLEMENTATION_STATUS.md` and initial contracts. Exit: paths/dependencies known; action boundary accepted by architect and concurrency reviewer.

**Phase 1 — real sandbox and provider smoke**: services for operational PostgreSQL, checkout app/storage, Redis, migrations, healthchecks; separate injector/acceptance credentials; deterministic seed; healthy create/read order flow and fault effects verified externally; Crusoe smoke suite. Exit: real faults change observable behavior; provider tool-call path works or is BLOCKED.

**Phase 2 — ledger, dependency closure and controlled commits**: migrations, repositories, validation, immutable receipts, readset capture, dependency edges, admission/commit transaction, idempotency, version-conflict and invalidation tests; concurrency reviewer writes stale-before-commit and stale-after-local-check tests. Exit: real controlled mutation rejected on stale/contested/unauthorized evidence and safe on current evidence; direct-route bypass tests pass.

**Phase 3 — persistent autonomous team**: leased coordinator, outbox recovery, Nemotron planning, scoped worker contexts, bounded recursive delegation; one healthy mission end to end, then a changed-evidence run with selective recovery; kill/restart worker and prove fencing. Exit: no prerecorded reasoning; independent acceptance decides success.

**Phase 4 — OpenDots integration and mission UI**: provenance at central model/context construction and all enabled execution/approval paths; mission views, evidence pages, streamed events, controls, real telemetry; setup without credentials, disconnected services, refresh/reconnect, owner/Space isolation. Exit: a user can start and inspect a real mission through the app.

**Phase 5 — adversarial hardening and fair evaluation**: run TEST_PROMPT.md; repair failures; targeted and broad regressions; baselines and evaluation; export raw results; disclose limitations.

**Phase 6 — reproducibility and delivery**: setup, env template, migrate/seed/reset, clean-start, demo guide, architecture explanation, limitations; preserve LICENSE; THIRD_PARTY_NOTICES.md; run manifests and machine-readable reports under ignored `artifacts/` with a small checked-in summary; bind gates to commit + dirty-diff digest + lockfile/oracle hashes. Never say 'production-ready', 'never stale' or 'all tests pass' without scoped evidence.
</phases_and_exit_gates>

<testing_and_evaluation>
Preserve upstream `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Add separate deterministic DB/adapter integration, Playwright UI, live Crusoe smoke, live incident evaluation, and report commands with explicit modes. The unit suite must not need network credentials.

Required deterministic checks: source scoping, supersession/conflicts, transitive invalidation, independent support/preservation, inherited and replayed-context provenance, approval-then-change, racing commits, lease fencing, duplicate/unknown outcomes, unauthorized direct service paths, model output validation, prompt injection as data, UI event ordering and reconnect.

Evaluation separates correctness from efficiency:

1. **Strong temporal-memory + broad-restart baseline** with identical tools, policies, checks, model, budget; reruns broad affected work on change.
2. **Simple dependent-task restart baseline** with a conventional task DAG and the same admission checks.
3. **NemoDots selective repair**.

Do not label homemade substitutes as Graphiti/MemTX/CoAgent. For context efficiency: matched 2×2 (broad vs selective × ordinary vs cache-aware layout) with identical information/tools/models/budgets/fault schedules. Seeded fixtures, multiple fault types, benign controls, frozen held-out seeds. No fabricated significance or savings; publish failures and false blocks.

Per trial: scenario/seed/commit/config; source changes; verified resolution; stale controlled commits; unsafe/untracked actions; false blocks; missed affected descendants; invalidation/preservation counts; retries/unknown outcomes; model calls/tokens; cached token availability; recovery time and completion time (setup vs inference vs tool latency); repeated-work counts.

Required qualitative demonstration: a real trace where an action derived from receipt r1 is rejected after r2 is registered, its worker re-reads/replans, an independent branch is not rerun, and an independent order/inventory probe verifies the eventual repair. Reproduce the stale-commit boundary deterministically too.
</testing_and_evaluation>

<final_acceptance>
Complete only when the locally runnable application, integration, hardening, documentation and available live verification are done. Missing external access → state exactly which live gates are BLOCKED after finishing all independent work.

Final report: what NemoDots does and the actual architecture; exact startup and test commands; PASS/FAIL/BLOCKED/NOT_RUN table with evidence paths; proof Crusoe/Nemotron powered planning, delegation and recovery; controlled-commit guarantee and external-effect limits; measured comparison or NOT_RUN; open findings and required external setup.
</final_acceptance>
