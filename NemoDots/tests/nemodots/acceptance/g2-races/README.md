# Gate 2 acceptance suite (admission and races)

Ports 4640 (checkout) and 4641 (app) are reserved for this suite; it drives services in process and opens none. Databases come from `tests/nemodots/helpers/test-db.ts` (`withTestDatabase`, `nemodots_test_<rand>` on the instance PostgreSQL, `NEMODOTS_PG_PORT`). Redis db 3 on the instance Redis with a random key prefix. Run (stack up; role URLs from `npm run nemodots:stack -- exec`):

`npx vitest run --config tests/nemodots/acceptance/vitest.config.ts tests/nemodots/acceptance/g2-races`

## Files

- `harness.ts`: world builder, Redis fault proxy (`RedisFault`: lost reply after a real effect, request never sent), Redis `MONITOR` effect counter (`RedisWatch`), race helper `parkedRace`, oracle outcome checker `checkOutcome`.
- `asserts.ts`: `expectStaleBlocked` (commit-stage versus closure path), `expectSerializable`, `expectRefusedCommit`.
- `harness.selfcheck.test.ts`: proves the harness against the REAL ledger, coordinator, version authority and Redis (H-1..H-7). Passes today. A failure in the other files is therefore a product finding, not a harness bug.
- `admission.test.ts`: G2-01..G2-08, G2-17, G2-18. `leases-effects.test.ts`: LS-1..LS-4, LS-6, LS-7, G2-09..G2-12, G2-15 (LS-5). `lifecycle.test.ts`: G2-13, G2-14, G2-16, G2-OUT.

## What is real

Mission/task rows are seeded with verifier SQL and then claimed and started through the real `coordinator/leases.ts` (`claimAttempt`, `startAttempt`). Publication, delegation, findings, model calls, read sets, heartbeat, reaper and `cancel` are the real `coordinator/publish.ts`, `coordinator/leases.ts` and `coordinator/control.ts#createMissionControl`. Model calls and read sets are stored by the real `ledger/model-calls.ts` and `ledger/readset.ts`; receipts by `ledger/receipts.ts#registerObservation` (`RegisterResult.receipt.id`). The coordinator `deps` are composed in the harness (the production composition root does not exist yet): it adapts the ledger to `LedgerWriterPort`, reads `coordinator.action_intents` for the `IntentReader` port (empty until that table exists), and answers `cancelQueued` with "none" only in scenarios that do not load the actions package.

## Two staleness paths (finding: the closure pre-empts the commit)

ARCH 5.2 step 4 moves live intents `proposed|admitted` to `blocked(stale_version)` as soon as a change is REGISTERED, so a commit-stage re-validation never decides those cases. The suite therefore keeps two kinds of test apart:

- unregistered change (`register: false`): only the commit transaction's own re-validation can refuse. Tests require the commit-stage Authorization row, with the live revision of the changed key above the recorded one in `checked_vector`, an unchanged target version and value, and `actionRows` 0. This covers target, non-target cited source, and inherited-only (snapshot vector) premises, before the commit and inside the `before_lock` and `after_preliminary_read` barriers.
- registered change: the closure path. Accepted outcome: the intent is `blocked(stale_version)`, a later commit throws `DispatchFenceError` (ARCH 5.1 step 2) or returns the blocked intent, and an `ledger.invalidation_events` row names the intent. The commit-stage row is not required there.

## Reviewed-correction proposals (ADM-03b and ADM-08 applied in acceptance-v2 / oracle-v2; the others still pending)

The frozen oracle (`oracle/admission.ts`, hash-listed in `oracle/MANIFEST.sha256` and `ACCEPTANCE_CONTRACT.md`) was not edited: `ACCEPTANCE_CONTRACT.md` is itself in the manifest, so editing it would break `integrity/frozen-integrity.test.ts` until someone other than the author reviews the change and recomputes hashes (`.local/acceptance/freeze.sh`, section 9 of the contract). Proposed rows for that revision log:

| Case                                            | Before                                                                                                                                                 | After                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADM-01, 02, 04, 07, 07b, 08 (registered change) | commit/admit writes an Authorization `blocked(stale_version)` after the change                                                                         | accept either that row, or `status=blocked(stale_version)` set by the closure with no further Authorization, a thrown `DispatchFenceError` on commit, and an invalidation event naming the intent | ARCH 5.2 step 4 blocks the intent at registration; ARCH 5.1 step 2 makes commit throw without writing an Authorization for a non-`admitted` intent. The oracle assumed a path the spec says cannot occur.                                                    |
| ADM-02 (`hooked`/`during`)                      | the `during` step is awaited while the commit is parked                                                                                                | `during` runs concurrently under a timeout and `pg_blocking_pids` decides whether it is waiting on the parked commit; the result is judged by serialization order                                 | If the barrier sits after the intent's `FOR UPDATE`, the closure's intent UPDATE waits on the parked commit and an awaiting test deadlocks until the 600 s timeout.                                                                                          |
| ADM-03b versus ADM-01b                          | (APPLIED in oracle-v2 with a different resolution) unregistered change gives `stale_version` (03b) and `stale_pending_observation` (01b) for one state | ADM-03b pins `stale_pending_observation` at both stages; "accept either" was REJECTED by the independent review                                                                                   | `actions/predicates.ts:256` runs `assertCurrent` before the target check at `:270`; `ledger/support.ts:80-85` returns `stale_pending_observation` whenever live > recorded                                                                                   |
| ADM-08                                          | (APPLIED in oracle-v2 as the G2-08b shape) branch A already closure-blocked is then "hooked" at `after_lock_before_commit`                             | IA unchanged and parked at `after_lock_before_commit` holding its rows; IB commits within 2000 ms; both committed, `actionRows` 2                                                                 | a blocked intent's commit returns the stored decision (`actions/commit.ts:79-80`), and the hook sits only on the success path (`commit.ts:214`). The `register: false` variant fails through `block()` (`commit.ts:118-144`), so it cannot be reached either |

## Production entry points still depended on

Resolved at run time; a missing one FAILS with `ENTRY POINT MISSING`. Bound 2026-10-18 to the W3.1 API that landed. ACCEPTANCE_CONTRACT section 6 names the modules and barriers only. Earlier revisions of this file listed `createActionAdmission`, `dispatch.ts#cacheKey` and `pollOnce`. They were the verifier's guesses and no contract required them (lead ruling 2026-10-18), so the harness now uses the real names. No assertion changed.

| Entry point                                                                                                                                                                                                  | Use                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions/index.ts#createActions(ActionsDeps)` with `{ pool, validator, events, redis, redisPrefix, dispatchLeaseMs }`                                                                                        | every intent operation (`propose`, `admit`, `commit`, `dispatch`, `reconcile`, `reclaim`, `compensate(id)`, `cancelQueued`); `validator` and `events` are the same instances the coordinator deps use                    |
| `actions/dispatch.ts#effectKey(prefix, actionId)`, `#fenceKey(prefix)`                                                                                                                                       | `markerPresent`: the marker counts as an applied effect only when it holds a dispatch fence (`'fence_newer'` records a refusal); fence keys are still found by `SCAN prefix:fence:*`                                     |
| `actions/test-hooks.ts#setHook(name, handler)`, `#clearHooks()`; the five section 6 barriers; `NEMODOTS_TEST_HOOKS=1` (set by the harness)                                                                   | barriers (`park`, `onHook`)                                                                                                                                                                                              |
| `sandbox/checkout-cache.ts#cacheKey(prefix, namespace, schema, name)`                                                                                                                                        | `plantCache` uses the checkout's own key format (schema 1), the keys the flush must clear                                                                                                                                |
| `watcher/watcher.ts#createWatcher(WatcherDeps)`, `Watcher.pass({ keys })`                                                                                                                                    | `watcherPoll`: one pass, leadership not required, over the ledger's controlled sources. The reader refuses (no checkout runs here). `missions` = real `MissionControlPort.pause`. `intents` = `actions.selfWriteIntents` |
| `coordinator/control.ts#createMissionControl(deps)`                                                                                                                                                          | LS-6, G2-14, watcher pause                                                                                                                                                                                               |
| `ledger/receipts.ts#registerObservation`, `ledger/model-calls.ts`, `ledger/readset.ts`, `ledger/support.ts`, `coordinator/{publish,leases,recovery,events}.ts`, `sandbox/version-authority.ts#advanceConfig` | real ledger, coordinator and version authority                                                                                                                                                                           |

Schema columns read by SQL (snake_case): `coordinator.action_intents` (`status`, `block_reason`, `failure_reason`, `dependency_vector`, `payload`, `policy_version`, `target`, `tool_call_id`, `dispatch_fence`, `dispatcher_lease_expires_at`, `attempt_id`, `mission_id`), `coordinator.authorizations` (`stage`, `decision`, `block_reason`, `checked_vector`, `decided_at`), `coordinator.result_receipts`, `coordinator.outbox`; the tamper test first asserts that the columns exist (`SCHEMA BINDING` message). Error names: `FenceError` (coordinator), `DispatchFenceError`, and messages containing `stale_version`, `idempotency_conflict`, `payload_invalid`, `capability_denied`, `citation_out_of_scope`, `irreversible`.

## Rebinding notes (2026-10-18)

- G2-11c-flush. Before: the case committed first, then armed the crash and expected `dispatch()` to hit `after_commit_before_dispatch`. After: it arms the crash before `commit()`, because `actions/commit.ts` fires that barrier at the end of `commit()`, after the transaction has committed. That is the same crash point (committed, outbox row pending, no effect), and every assertion is unchanged. Section 6 names the barrier but not the function that owns it. Lead ruling 2026-10-18.
- `gates/gate2-admission.test.ts` and `gate2-selfwrite.test.ts` are now case maps. They fail when an ADM, LS or SW id of the frozen oracle has no g2-races test whose title names it. They don't execute the cases, so each oracle case runs once, in this folder. The g3 and g7 case maps work the same way. Lead ruling 2026-10-18.

## Oracle id audit and tightening (2026-10-18)

Method: for each frozen ADM, LS or SW id, compare the oracle case's steps and `expected` (every `anyOf` branch included) with the test. An id goes into a title only when that test runs the case's setup and asserts all of its expected fields; extra assertions are allowed. A test that accepts an outcome the oracle does not allow, or leaves out an expected field, is not named.

Lead ruling 2026-10-18: tests that were looser than the oracle are tightened to it, and nothing is loosened. Where the oracle allows several outcomes, one complete branch must hold for every intent of the case, never a mix. A step the oracle does not mark as throwing must not throw. `ADM-17` realizes `age_health` by registering a 121 s old health revision before the proposal. `ADM-20` realizes `mutate_redis_unobserved` by planting a key in the namespace that nothing registers. The SW `recoveryKinds` are compared with the ROUTING kinds recorded for the mission (`repair_scheduled`, `replan_scheduled`, `postcondition_scheduled`, `repair_coalesced`). Bookkeeping kinds (`attempt_aborted`, `intent_blocked`, `branch_preserved`, `invalidation_resolved`) are not routing decisions.

Not named: none. ADM-03b and ADM-08 are named after the acceptance-v2 / oracle-v2 re-freeze (G2-03b, G2-08b). G2-08a ("IA blocked" while A's row is locked by an uncommitted write) is an unhooked case with no oracle id, so it stays unnamed.

SW-1, SW-2 and SW-3 are named: G2-16e, G2-16f and G2-16g. The watcher is given the production `SelfWriteIntentPort` adapter, `actions.selfWriteIntents`.

### ADM-08 (resolved in oracle-v2)

The concurrency adversary confirmed that the v1 step cannot be reached and rejected this note's `register: false` proposal, which cannot be reached either. One detail in the earlier version of this note was wrong: committing a blocked intent does not throw; it returns the stored decision (`actions/commit.ts:79-80`). The oracle now uses the G2-08b shape. The before/after and rationale are in `../oracle/README.md` and in `ACCEPTANCE_CONTRACT.md` section 9.

### SW-1 and SW-3 acting lineage (withdrawn proposal)

The earlier proposal to change the lineage to `['T_act', 'T_ver']` is withdrawn. The contradiction was in the design, and rev3 D5 (`contracts/task.ts#allowedCapabilities`) resolved it: a specialist delegated by a parent that holds `delegate` keeps its `propose_*` capabilities. G2-16e, G2-16f and G2-16g build the frozen lineage, an investigator `T_parent` that delegates the specialist `T_act` through the real `delegate()`. The oracle is unchanged. A task counts as invalidated when one of its attempts was moved to `invalidated`; the task row itself may already be `runnable` again for repair.

## oracle-v3: SW recoveryKinds (APPLIED in acceptance-v3, 2026-10-18)

Status: applied. The lead approved it, the concurrency adversary CONFIRMED this version, and the before/after with file:line rationale is in `../oracle/README.md` (oracle-v3) and in `ACCEPTANCE_CONTRACT.md` section 9. SW-1's release and trigger are frozen as `replansReleasedAfterPostcondition: 1` and `replanTriggerTaskIds: ['T_other']`. The storm rule is frozen as oracle rule R7.

| Case | Field                       | Before (oracle-v2, `oracle/closures.ts`)          | After (oracle-v3)                                                     |
| ---- | --------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| SW-1 | `recoveryKinds` (line 1045) | `['postcondition_scheduled', 'repair_coalesced']` | `['postcondition_scheduled', 'repair_coalesced', 'replan_coalesced']` |
| SW-2 | `recoveryKinds` (line 1064) | `['repair_scheduled']`                            | `['repair_scheduled', 'replan_scheduled']`                            |
| SW-3 | `recoveryKinds` (line 1084) | `['repair_scheduled']`                            | `['repair_scheduled', 'replan_scheduled']`                            |

No other field and no other case changes. Nothing is loosened: the change adds expected routing decisions and removes none. SW `recoveryKinds` are compared, as before, with the routing kinds recorded right after the watcher pass. `replan_coalesced` is a routing kind.

Rationale:

- Every SW case invalidates a root task: T_other in all three, and T_parent in SW-2 and SW-3.
- ARCHITECTURE line 310: the planner is re-invoked when a root task is invalidated. Production: `coordinator/recovery.ts` (root trigger, then `scheduleReplan`).
- Every real mission has a planner whose plan succeeded. Without one, `scheduleReplan` records nothing, so the v2 values held only in a mission without a planner, a state the product never runs in.
- SW-1 (lead ruling): a verified self-write gates the other branches' repairs behind its postcondition. The replan waits too (`replan_coalesced`), and it is released with the repairs when the postcondition settles (`releaseGate`). An ungated replan would plan on a state that is still being verified.

Rules the tests enforce (not frozen, in `harness.ts` and `lifecycle.test.ts`):

1. One replan per invalidation event per mission (`expectNoReplanStorm`): at most one `replan_coalesced` (held) and at most one `replan_scheduled` (executed). When both exist, the scheduled one is the release of the held one and comes after it. `withWorld` runs it after every passing scenario. One replan per root task would be reported as a production defect, not as an oracle change.
2. A succeeded planner for every mission by default (`seedMission`), with no replan recorded yet and `replanCap` 3. "Exactly one" can therefore hold, and self-check H-8 proves it. `withWorld(..., { planner: false })` creates missions without one.
3. SW-1 release: after the postcondition task publishes its verification (real `publishOutput`), exactly one `replan_scheduled` exists for the held replan's event, and only one in total (G2-16e).
4. SW-1 provenance: the held replan's event has exactly one invalidated root task, T_other, and the excused acting lineage (T_parent, T_act) is not among its affected tasks (G2-16e).
5. The no-replan path stays tested: G2-16h runs a root invalidation in a mission without a succeeded planner and expects `repair_scheduled` and no `replan_*`. G2-16i is the positive control with a planner and expects exactly one `replan_scheduled`. Neither has an oracle id.

Evidence (current tree): every g2 file except the three SW tests passes with the planner in place. G2-16h, G2-16i and self-check H-8 pass. A dry run with the oracle-v3 values substituted in the test (file restored afterwards) passed lifecycle 15/15, including the release and provenance checks. Against the frozen oracle-v2, G2-16e, G2-16f and G2-16g fail only on the added routing kind.

## Not deterministic, reported as such

LS-1 (claim race) has no barrier hook inside `claimAttempt`; it samples 8 rounds of 3 concurrent claimants. Everything else uses barriers, held row locks, `pg_blocking_pids`, or a validator-injected park inside the publication transaction (LS-6).
