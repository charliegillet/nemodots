# NemoDots — independent verification and repair prompt

Run this in Claude Code in the implemented NemoDots checkout, using `claude-opus-5` for the lead verifier and critical adversarial reviewers, and `claude-sonnet-5-5` for test implementation and dependency checks. Read BUILD_PROMPT.md and the reviewed contracts first. This is an execution assignment: inspect actual files, create meaningful missing acceptance tests, run them, reproduce failures, coordinate fixes, and rerun the affected checks. A checklist without execution is not completion.

<verification_contract>
You are independent from the implementation authors. Treat implementation explanations and old green logs as claims to check. Freeze the behavior contract and fixture/oracle version before evaluating. Derive expected results from the external specification and independently generated fixtures, not from production graph traversal or the same helper used by the implementation.

Use native agent teams if genuinely supported; otherwise explicitly use persistent subagents. Verify the effective models and never silently substitute the requested IDs. Spawn these independent responsibilities in bounded waves: dependency/reproduction auditor, concurrency adversary, tool-path/security adversary, live integration verifier, UI/E2E verifier, evaluation skeptic. Builders can repair production code; test owners do not weaken acceptance to get green.

A reviewer with Bash is behaviorally instructed to avoid production edits, not technically sandboxed. Use isolated test projects/Compose namespaces and separate least-privilege credentials where real isolation matters. Do not run destructive cleanup against existing databases, named volumes, browser profiles, or user projects.

Record the exact Git HEAD plus dirty-diff digest and untracked source manifest, Node/npm/Claude/Docker versions, lockfile digest, image versions, test mode, settings names without values, fixture hashes, scenario seeds, command, exit code, output artifact and time. Do not use presence of an environment variable as proof its service works.

Use PASS / FAIL / BLOCKED / NOT_RUN for each gate. No credentials means live acceptance is BLOCKED, not PASS. Missing tests are NOT_RUN until implemented. Test mocks are valid for deterministic adapter/error checks; they cannot establish live model inference, Intelligence persistence, Redis effects, or application recovery.

Never skip an assertion, broaden a mock, swallow a provider exception, change the fault to an easier one, or lower a threshold merely to produce a green report. Legitimate specification or oracle bugs require an explicit reviewed correction with before/after rationale.
</verification_contract>

<gate_0_reproduction>
1. Inspect applicable repository instructions, build documents, package.json, package-lock.json, migrations, configuration schema and all new operational modules.
2. Verify Node >=24 and npm; preserve the npm lockfile. Run `npm ci` in the application checkout. Record pre-existing install/runtime problems accurately rather than rewriting dependencies wholesale.
3. Run upstream `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Run formatting checks where applicable to changed files. Do not invent command names: inspect the implemented scripts before invoking additional suites.
4. Start an isolated test stack with healthy PostgreSQL, actual Redis and the checkout API. Verify migrations from empty storage and a supported upgrade path without wiping existing data. Confirm seed/reset is scoped to test resources.
5. Check clean start, restart and useful setup state without Crusoe/Intelligence configuration. The app must distinguish fixture mode from live mode and from blocked setup.
6. Verify upstream MIT and copied service notices remain; source refs and service pins match the actual code. Check secrets are absent from Git changes, generated frontend assets, logs and screenshots without dumping candidate values.
</gate_0_reproduction>

<gate_1_ledger_and_lineage>
Write/run precise cases with independently enumerated expected records/edges:

1. Immutable receipt identity; source revision and payload digest mismatch rejected; malformed and oversized inputs fail safely.
2. Same entity/predicate name in different environments, resources, Spaces or owners cannot collide or grant access.
3. A new supported observation supersedes the prior current observation according to the declared source policy. Conflicting/contested and retracted/expired support blocks dependent actions until resolved.
4. Out-of-order source delivery cannot resurrect an old revision. Test ABA: value A → B → A still has a new revision; old A receipts do not become current again accidentally.
5. Model hypotheses cannot mint trusted facts or use a page's prose as an authoritative operational value without the documented promotion/read mechanism.
6. Context compilation records every injected observation, tool result, inherited artifact, relevant page snapshot, summary and history item. Deliberately omit an LLM citation: runtime lineage must still include the supplied premise.
7. Replayed stale history, old handoff output and stale summary cannot reenter a repaired model call as current support. Check the actual request's scoped context record, not just a frontend label.
8. Supersession invalidates a hand-enumerated transitive closure of affected attempts, outputs, queued actions and child tasks; unrelated branches remain usable. Test a diamond graph, multiple parents, cycles rejected, and simultaneous invalidations.
9. Independent sufficient support preserves an artifact only if that support relation is actually represented. Where support sufficiency is unknown, conservative invalidation must not be advertised as exact reasoning.
10. A harmless update or change to another scope does not invalidate unrelated work. Quantify false invalidation rather than hiding it.
11. Direct edits to a page change its document revision but cannot mutate authoritative ledger values silently. Consumers of page content get traceable snapshot dependencies.
12. A negative/collection read such as 'no restrictive policy exists' records a collection/range epoch. Insert a relevant restriction afterward; all dependent publication/admission checks reject the old absence observation.
13. Advance an authoritative epoch before its watcher processes the event. An output, handoff, child enqueue, context reuse or action based on the old epoch must fail immediately; a pending replacement observation is not permission to reuse stale support.
</gate_1_ledger_and_lineage>

<gate_2_admission_and_races>
Use deterministic barriers/latches/test hooks at actual transaction boundaries. Sleeps alone are not a reliable race oracle. Run against real PostgreSQL connections, not only repository mocks.

1. **Stale before admission:** propose from r1, register r2, admit r1 intent. It must fail with no controlled mutation.
2. **Stale between local check and commit:** pause after a preliminary freshness read; register r2; resume commit. The authoritative commit check must reject r1.
3. **Concurrent commit ordering:** race registration/invalidation and a controlled mutation. Record the serialization order. A mutation legitimately committed before the superseding event is not retrospectively a violation; an r1 mutation serialized afterward must not commit.
4. **Approval race:** approve the r1 payload; register r2 before executing the callback; invoke the callback. Revalidate and reject stale execution. Approval cannot replace version checks.
5. **Payload binding:** change target, amount/config value, resource, environment, policy ID or dependency vector after admission. Require fresh authorization. Reject reused idempotency keys with different payload hashes.
6. **Missing predicates:** the worker omits a required source, cites a valid irrelevant receipt, or requests an easier policy. Server policy must reject it or add/validate mandatory support itself.
7. **Cross-resource vector:** mutate one of several required sources; validate the complete vector under the common authority. A target-only CAS is insufficient.
8. **Per-resource independence:** change a source used by branch A and show branch B can commit with its own valid support. A mission-global epoch must not unnecessarily poison all branches.
9. **Lease fencing:** worker A loses its lease; worker B obtains a newer token; late A attempts to publish output, delegate, renew incorrectly or commit. All stale-token operations fail.
10. **Duplicate delivery:** replay task/outbox/action messages and approval callbacks. Include two simultaneous identical requests that both reach initial lookup before either commits. Idempotency serialization/recheck must yield one controlled effect and the same original receipt to both callers, rather than a spurious stale rejection after the first changes its source revision.
11. **Crash before/after commit:** kill workers at leased, admitted, transaction-committed, outbox-sent and result-not-recorded boundaries. Recovery must distinguish uncommitted, committed and unknown outcomes without blind duplicate effects.
12. **External effects:** deliberately lose a Redis/Docker/HTTP response after a real effect. The system must reconcile/read back or stay outcome_unknown. A local outbox record does not prove a remote effect occurred once.
13. **Compensation, if implemented:** reversible change can be compensated under its declared preconditions; later valid target changes prevent an old compensation from overwriting them. Irreversible effects are never represented as undone.
14. **Cancellation/pause:** queued work stops under lifecycle fencing; already committed effects remain in history; in-flight external requests have accurate uncertain/cancelled status. Do not infer physical cancellation merely from AbortController firing.
15. **Separate lease lifecycles:** a valid proposal from a successfully completed author may execute under a new current dispatch lease. An expired author cannot publish a new proposal, and an expired dispatcher cannot commit an existing one. Do not conflate authoring and dispatch fences.
16. **Successful self-write:** a valid action atomically advances its target/source revision r1→r2. Its trusted causedByActionId/expected-transition marker routes to fresh r2 verification without replaying the mutation, cancelling the successful action or launching endless repair. A mismatched/unrelated interleaving still invalidates affected future work. The model cannot forge the marker.

For a supported controlled commit, check authoritative source/target versions, actual domain state and audit receipt together. State the boundary: registered evidence under common authority. Add a test documenting that unobserved changes or uninstrumented arbitrary remote side effects are outside that guarantee rather than pretending the controller prevents them.
</gate_2_admission_and_races>

<gate_3_tool_and_scope_audit>
Trace real execution paths and test service/HTTP APIs directly, not solely through UI wrappers:

- Incident adapter and route; computer service and owner routes; MCP read executor, write executor, approval creation/callback; Composio; converted client tools; learned skills; page edits; background/headless/channel paths if enabled.
- Every enabled model-visible read produces scoped provenance. Every enabled mutation has the declared policy checks at its execution boundary. Disabled paths fail clearly for incident agents.
- Verify permission revocation and cross-Dot/Space/resource identities; model-supplied identifiers cannot grant authority.
- Unknown tool names and unclassified read/write capabilities fail closed for the controlled incident scope. Never trust a tool name containing 'read' as proof of read-only behavior.
- General shell/browser actions are absent from the protected incident toolset or honestly labeled outside the strong guarantee. No host-shell fallback, raw database credentials or Docker socket is exposed to the model.
- Put instruction-like text in logs, tool results, pages and runbooks. It must remain untrusted data and cannot disable checks, obtain secrets or change the provider.
- Approved callbacks retain exact payload binding and fresh evidence validation after a tab closes/reconnects. Preserve upstream owner approval semantics.
- Read server configuration and built assets to verify Crusoe keys/Intelligence secrets remain server-side. Do not print secret values as part of the audit.
</gate_3_tool_and_scope_audit>

<gate_4_autonomy_and_persistence>
1. Create a mission from the UI/API with only the goal and legitimate constraints. Show actual model-generated task choices, tool calls, dependencies, handoffs and at least one justified recursive child delegation.
2. Confirm max depth/total tasks/concurrency/budgets are enforced server-side. A child cannot expand its permissions or escape its parent's constraints.
3. Inject changed source evidence after a branch read. A normal watcher/tool must discover it; the fault injector cannot send its hidden diagnosis or expected repair to agents.
4. Record the stale intent block, fresh context/model call and repaired attempt. Confirm the independent branch's model/tool calls were not repeated merely because another branch changed.
5. Kill the coordinator/worker and restart. Rebuild state from PostgreSQL; leases/fencing and outbox resume safely. Lose Redis separately: work may be delayed, but authoritative state must survive.
6. Repeat two source changes during recovery. Duplicate notifications must not create an unbounded repair storm or resurrect an invalid attempt.
7. Cause malformed tool JSON, model refusal, provider timeout, rate limit and exhausted budget. Return explicit useful failure/blocking states, without fabricating successful output.
8. Reload the user conversation after a real Intelligence turn. Confirm durable conversation continuity through the configured service rather than assuming SQLite page metadata proves it.
</gate_4_autonomy_and_persistence>

<gate_5_live_crusoe_nemotron>
Run only when the real configured account is available; keep all other deterministic gates runnable without it.

- Confirm actual model endpoint is `https://api.inference.crusoecloud.com/v1` and requested model is currently available. Core default is `nvidia/Nemotron-3-Super-120B-A12B`.
- Execute real text, typed tool-call/continuation, streaming and cancellation smoke tests through the application's actual adapter. A direct SDK example alone does not prove the app wiring.
- Collect redacted request receipts showing planner, specialists, verifier reasoning and changed-evidence replanning used Crusoe/Nemotron. Record returned model/provider correlation information where available.
- Interrupt network/provider availability. Reasoning must retry or block; it must not silently switch vendor or continue from a prerecorded answer.
- Confirm unused voice, Learning, public research and connector inference paths are disabled or separately verified. `OPENAI_BASE_URL` does not automatically reroute every upstream feature.
- Verify stable prefix/tool-schema digests within compatible permission/model groups; changing evidence appears in the dynamic context. Different model weights do not share KV cache. Missing cached-token data is unavailable, not zero.
- Verify client timing measures first nonempty content/token event consistently; report transport/tool/model latency boundaries. Aggregate Crusoe metrics update every minute and filter project/model; do not present them as per-mission spans.
- Inference and monitoring tokens are separate; missing monitoring access blocks only that optional corroboration, not an otherwise proven live inference result.

If access is missing, state precisely which live requests could not run. Fixture tests are still useful but cannot clear this gate.
</gate_5_live_crusoe_nemotron>

<gate_6_black_box_incident_acceptance>
The independent verifier owns private scenario seeds and acceptance probes. Runtime agents must not have filesystem/API access to the private manifest, hidden expected repairs, evaluator credentials or scenario-control tools. Ordinary source observations must still expose sufficient operational symptoms for diagnosis.

Run at least these scenario classes: no-fault healthy control; unrelated benign source change; repairable checkout fault; dependent source change after a proposed repair; second change during repair; conflicting observations; provider disruption; worker crash. Add held-out variations in resource/config values and timing so a hardcoded answer cannot pass all scenarios.

For each trial, independently inspect:

1. Real checkout requests before/after; a fresh create/read order round trip.
2. Direct application data invariants using separate verifier access: unchanged business hashes during the explicitly read-only repair/load phase, followed by exactly the permitted order/inventory changes from the fresh mutating checkout probe and preservation of all other seeded data. If concurrent writes are allowed, use an independent operation log to compute permitted deltas. Do not demand unchanged global counts while also creating a legitimate order.
3. Health stability across the declared window, not a single cached green object.
4. Source/target revision history, rejected stale intents, actual controlled mutations, external unknown outcomes and final readbacks.
5. Actual invalidated versus preserved branches and repeated-work counts.
6. Model-call provenance and current context, including delegation/replanning decisions.

An agent that refuses every action can avoid stale commits but fails the resolution objective. Conversely, a restored health endpoint does not pass if data integrity failed. Score both correctness and useful completion.

Use deterministic adapter scenarios to prove rare races. Keep their results distinct from autonomous model trials. Do not secretly force a model's action just to guarantee a photogenic stale-intent moment.
</gate_6_black_box_incident_acceptance>

<gate_7_frontend_and_observability>
Use real browser/E2E tests against the integrated backend. Verify goal/start/pause/resume/cancel, setup/blocked/live/fixture labels, source/evidence drilldowns, task tree, action inspector, recovery timeline and independent verification results. Refresh/reconnect mid-run; events deduplicate and state reconstructs from durable records.

Check keyboard access, readable status text without color-only meaning, empty/error/loading states, bounded graph/list rendering, and both successful and failed missions. Verify page projections link to typed facts and cannot silently replace them. Screenshots alone do not prove backend effects; pair UI evidence with run/action IDs and external probes.

Check the telemetry view does not invent savings, cache hits or provider claims. Actual model/config and limitations must be visible where meaningful. Preserve upstream page/chat functionality and existing owner/auth/origin protections.
</gate_7_frontend_and_observability>

<gate_8_evaluation_fairness>
Compare matched broad restart, simple dependent-task restart and NemoDots selective repair using identical source access, action guards, models, constraints and total budgets. If a named external system is claimed as a baseline, verify its actual implementation/configuration; a toy substitute cannot bear that name.

Use the frozen held-out scenarios, repeated trials and benign controls. Prevent information leakage from evaluation manifests or repeated tuning on held-out seeds. Export all trials, including failures, not only the best demo.

For the context experiment, compare ordinary/cache-aware layouts crossed with broad/selective recovery. Verify equal source information and tool capabilities. Counterbalance run order or document provider-cache contamination. Do not pad context, claim a cache-disable API without documentation, reuse stale facts for hits, compare different models as if only caching changed, or attribute all app latency to MemoryAlloy.

Report resolution, stale controlled commits, unsafe/untracked actions, false blocks, missed invalidations, false invalidations, preserved work, repeated calls/tokens, unknown outcomes and recovery/completion time. Include actual usage and explicit unavailable data. State cohort size, seed/config/commit, budgets, uncertainty and pricing assumptions. A modest or negative efficiency result is acceptable; fabricated confidence is not.

Use targeted mutation tests for critical invariants where useful: deliberately bypass final version check, remove inherited readset edges, ignore lease fencing, accept duplicate differing payloads. Independent tests should catch these mutations. Do not chase an arbitrary overall coverage percentage or write tests that merely assert the implementation's constants.
</gate_8_evaluation_fairness>

<repair_loop_and_delivery>
For each substantive failure, record severity, exact file/path, reproduction command, expected versus actual behavior and affected requirement. Give the builder a minimal reproducible case. Require the relevant test to fail before the fix and pass after it where practical. Rerun affected gates after a fix; rerun the integrated regression suite after shared contracts or control paths change.

Produce `docs/nemodots/VERIFICATION_REPORT.md` plus machine-readable artifacts. Include:

- Environment and exact revision/diff/fixture identity.
- A table of gates with PASS/FAIL/BLOCKED/NOT_RUN, commands and evidence.
- Live versus fixture results in separate rows.
- Each resolved or open critical/high finding and the supporting regression.
- The actual controlled commit guarantee, external-side-effect limits and unknown outcomes.
- Provider/model compliance for both the Claude engineering team and Nemotron runtime.
- Baseline results or NOT_RUN; no invented numbers.
- Reproduction and startup commands; any missing external account/configuration step.

Completion requires all mandatory deterministic gates green and actual live acceptance green when the required services are available. If a necessary service is unavailable, finish the independent work, preserve the exact pending commands, and report the live gate as incomplete. Never declare the product fully verified merely because the frontend builds.
</repair_loop_and_delivery>
