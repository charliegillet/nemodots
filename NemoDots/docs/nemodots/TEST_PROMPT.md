# NemoDots — independent verification and repair prompt

> Lead amendments for this run (models, environment) live in `docs/nemodots/LEAD_NOTES.md`.

Read BUILD_PROMPT.md and the reviewed contracts first. This is an execution assignment: inspect actual files, create meaningful missing acceptance tests, run them, reproduce failures, coordinate fixes, and rerun the affected checks. A checklist without execution is not completion.

<verification_contract>
You are independent from the implementation authors. Treat implementation explanations and old green logs as claims to check. Freeze the behavior contract and fixture/oracle version before evaluating. Derive expected results from the external specification and independently generated fixtures, not from production graph traversal or the same helper used by the implementation.

Responsibilities: dependency/reproduction auditor, concurrency adversary, tool-path/security adversary, live integration verifier, UI/E2E verifier, evaluation skeptic. Builders can repair production code; test owners do not weaken acceptance to get green.

Use isolated test databases/namespaces and separate least-privilege credentials where isolation matters. Do not run destructive cleanup against existing databases, volumes, browser profiles, or user projects.

Record Git HEAD plus dirty-diff digest and untracked source manifest, Node/npm/Claude versions, lockfile digest, test mode, settings names without values, fixture hashes, scenario seeds, command, exit code, output artifact and time. Presence of an environment variable is not proof its service works.

Use PASS / FAIL / BLOCKED / NOT_RUN for each gate. No credentials means live acceptance is BLOCKED. Missing tests are NOT_RUN until implemented. Mocks are valid for deterministic adapter/error checks; they cannot establish live inference, Intelligence persistence, Redis effects, or application recovery.

Never skip an assertion, broaden a mock, swallow a provider exception, change the fault to an easier one, or lower a threshold to produce a green report. Spec/oracle bugs require an explicit reviewed correction with before/after rationale.
</verification_contract>

<gate_0_reproduction>
1. Inspect repository instructions, build documents, package.json, package-lock.json, migrations, configuration schema and all new operational modules.
2. Verify Node >=24 and npm; preserve the lockfile; run `npm ci`. Record pre-existing problems accurately.
3. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, plus formatting checks on changed files. Inspect implemented scripts before invoking additional suites.
4. Start an isolated test stack with healthy PostgreSQL, real Redis and the checkout API. Verify migrations from empty storage and a supported upgrade path without wiping existing data. Seed/reset scoped to test resources.
5. Clean start, restart and useful setup state without Crusoe/Intelligence configuration; fixture vs live vs blocked are distinguished.
6. Upstream MIT and copied notices remain; source refs and pins match code. Secrets absent from Git changes, frontend assets, logs and screenshots (check without dumping values).
</gate_0_reproduction>

<gate_1_ledger_and_lineage>
With independently enumerated expected records/edges:
1. Immutable receipt identity; revision/digest mismatch rejected; malformed and oversized inputs fail safely.
2. Same entity/predicate in different environments/resources/Spaces/owners cannot collide or grant access.
3. New supported observation supersedes the prior current one per source policy; contested/retracted/expired support blocks dependent actions until resolved.
4. Out-of-order delivery cannot resurrect an old revision. ABA: A → B → A gets a new revision; old A receipts stay non-current.
5. Model hypotheses cannot mint trusted facts or use page prose as authoritative values without the documented promotion mechanism.
6. Context compilation records every injected observation, tool result, inherited artifact, page snapshot, summary and history item; omitting an LLM citation still leaves the premise in lineage.
7. Replayed stale history, old handoff output and stale summary cannot reenter a repaired model call as current support (check the actual request's context record).
8. Supersession invalidates a hand-enumerated transitive closure of attempts, outputs, queued actions and child tasks; unrelated branches remain usable. Diamond graph, multiple parents, cycles rejected, simultaneous invalidations.
9. Independent sufficient support preserves an artifact only if represented; conservative invalidation is not advertised as exact reasoning.
10. Harmless updates / other-scope changes do not invalidate unrelated work; quantify false invalidation.
11. Page edits change document revision but cannot silently mutate ledger values; consumers get traceable snapshot dependencies.
12. Negative/collection read ('no restrictive policy exists') records a collection/range epoch; inserting a restriction makes dependent publication/admission reject the old absence observation.
13. Advance an authoritative epoch before the watcher processes it: outputs, handoffs, child enqueues, context reuse or actions on the old epoch fail immediately; pending replacement is not permission.
</gate_1_ledger_and_lineage>

<gate_2_admission_and_races>
Deterministic barriers/latches/test hooks at real transaction boundaries, real PostgreSQL connections:
1. Stale before admission: propose from r1, register r2, admit r1 → fail, no mutation.
2. Stale between local check and commit: pause after preliminary read; register r2; resume → reject r1.
3. Concurrent commit ordering: race registration and mutation; record serialization order; an r1 mutation serialized after must not commit.
4. Approval race: approve r1 payload; register r2; invoke callback → revalidate and reject.
5. Payload binding: changed target/value/resource/environment/policy/dependency vector after admission requires fresh authorization; reused idempotency key with different hash rejected.
6. Missing predicates: omitted required source, irrelevant valid receipt, easier policy → rejected or server adds/validates mandatory support.
7. Cross-resource vector: mutate one of several required sources; full vector validated; target-only CAS insufficient.
8. Per-resource independence: change branch A's source; branch B still commits.
9. Lease fencing: stale-token publish/delegate/renew/commit all fail.
10. Duplicate delivery incl. two simultaneous identical requests: one effect, same original receipt to both.
11. Crash at leased/admitted/committed/outbox-sent/result-not-recorded: recovery distinguishes uncommitted, committed and unknown without blind duplicates.
12. External effects: lose a Redis/HTTP response after a real effect → reconcile/read back or stay outcome_unknown.
13. Compensation (if implemented) respects later valid changes; irreversible effects never shown as undone.
14. Cancellation/pause: queued work stops; committed effects remain in history; in-flight external requests show accurate status.
15. Separate lease lifecycles: completed author's valid proposal executes under a new dispatch lease; expired author can't publish; expired dispatcher can't commit.
16. Successful self-write r1→r2 with trusted causedByActionId routes to fresh verification without replay/repair storm; mismatched interleaving still invalidates; model can't forge the marker.

Check authoritative versions, actual domain state and audit receipt together. Add a test documenting that unobserved changes or uninstrumented remote effects are outside the guarantee.
</gate_2_admission_and_races>

<gate_3_tool_and_scope_audit>
Trace real execution paths and test service/HTTP APIs directly: incident adapter/route; computer service and owner routes; MCP read/write executors, approval creation/callback; Composio; client tools; learned skills; page edits; background/headless/channel paths.
- Every enabled model-visible read produces scoped provenance; every enabled mutation has policy checks at its execution boundary; disabled paths fail clearly.
- Permission revocation and cross-Dot/Space/resource identities; model-supplied IDs grant nothing.
- Unknown tools and unclassified capabilities fail closed. A name containing 'read' is not proof of read-only.
- No shell/browser in protected toolset (or labeled outside guarantee); no host-shell fallback, raw DB creds or Docker socket to the model.
- Instruction-like text in logs/tool results/pages/runbooks stays untrusted data.
- Approved callbacks keep payload binding and fresh evidence validation after reconnect; upstream owner approval semantics preserved.
- Crusoe keys/Intelligence secrets server-side only (check built assets without printing values).
</gate_3_tool_and_scope_audit>

<gate_4_autonomy_and_persistence>
1. Create a mission from UI/API with only goal and constraints; show model-generated tasks, tool calls, dependencies, handoffs and at least one justified recursive child delegation.
2. Depth/total tasks/concurrency/budgets enforced server-side; children cannot expand permissions.
3. Inject changed evidence after a branch read; the watcher discovers it; injector leaks no diagnosis.
4. Record stale intent block, fresh context/model call and repaired attempt; independent branch's calls not repeated.
5. Kill coordinator/worker and restart; rebuild from PostgreSQL; fencing and outbox resume safely. Lose Redis: delayed but authoritative state survives.
6. Two source changes during recovery: no unbounded repair storm or resurrection.
7. Malformed tool JSON, refusal, timeout, rate limit, exhausted budget → explicit failure/blocking states.
8. Reload a user conversation after a real Intelligence turn (BLOCKED without Intelligence).
</gate_4_autonomy_and_persistence>

<gate_5_live_crusoe_nemotron>
- Endpoint `https://api.inference.crusoecloud.com/v1`; requested model currently available.
- Real text, tool-call/continuation, streaming and cancellation through the app's adapter.
- Redacted request receipts showing planner, specialists, verifier reasoning and changed-evidence replanning on Crusoe/Nemotron.
- Provider interruption → retry or block; never vendor switch or prerecorded answer.
- Unused voice/Learning/research/connector inference paths disabled or separately verified.
- Stable prefix/tool-schema digests within compatible groups; changing evidence in dynamic context; missing cached tokens = unavailable.
- Client timing measures first nonempty content; aggregate Crusoe metrics are not per-mission spans.
- Inference and monitoring tokens are separate.
</gate_5_live_crusoe_nemotron>

<gate_6_black_box_incident_acceptance>
Verifier owns private scenario seeds and probes; runtime agents have no access to the manifest, expected repairs, evaluator credentials or scenario-control tools. Scenario classes: healthy control; benign unrelated change; repairable checkout fault; dependent change after proposed repair; second change during repair; conflicting observations; provider disruption; worker crash. Held-out variations in values/timing.

Per trial independently inspect: real checkout requests before/after and a fresh create/read order; data invariants with separate verifier access (unchanged business hashes during read-only phase, then exactly permitted probe deltas); health stability over the window; revision history, rejected stale intents, mutations, unknown outcomes, readbacks; invalidated vs preserved branches and repeated work; model-call provenance. Score correctness and useful completion (refusing every action fails). Deterministic adapter scenarios prove rare races and are reported separately.
</gate_6_black_box_incident_acceptance>

<gate_7_frontend_and_observability>
Real browser/E2E tests against the backend: start/pause/resume/cancel; setup/blocked/live/fixture labels; evidence drilldowns; task tree; action inspector; recovery timeline; verification results; refresh/reconnect mid-run with dedup and reconstruction. Keyboard access, non-color status text, empty/error/loading states, bounded rendering, successful and failed missions. Page projections link to typed facts. Telemetry view invents no savings. Upstream page/chat and owner/auth/origin protections preserved.
</gate_7_frontend_and_observability>

<gate_8_evaluation_fairness>
Matched broad restart, simple dependent-task restart and NemoDots selective repair with identical sources, guards, models, constraints and budgets. Frozen held-out scenarios, repeated trials, benign controls, no manifest leakage; export all trials. Context 2×2 with equal information; counterbalance order or document cache contamination. Report resolution, stale commits, unsafe actions, false blocks, missed and false invalidations, preserved work, repeated calls/tokens, unknown outcomes, recovery/completion time, cohort size, uncertainty, pricing assumptions. Mutation tests for critical invariants (bypass final version check, remove inherited readset edges, ignore fencing, accept duplicate differing payloads) must be caught.
</gate_8_evaluation_fairness>

<repair_loop_and_delivery>
For each failure record severity, file, reproduction command, expected vs actual, affected requirement; test fails before fix and passes after where practical; rerun affected gates and the integrated suite after shared-contract changes.

Produce `docs/nemodots/VERIFICATION_REPORT.md` plus machine-readable artifacts: environment and revision identity; gate table with commands and evidence; live vs fixture rows; critical/high findings and regressions; the controlled commit guarantee and limits; provider/model compliance for the Claude team and Nemotron runtime; baseline results or NOT_RUN; reproduction commands and missing external setup.
</repair_loop_and_delivery>
