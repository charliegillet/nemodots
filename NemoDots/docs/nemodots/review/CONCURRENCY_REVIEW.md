# W5.2 concurrency adversary review

- Task: `W5.2-concurrency-adversary`. Status: **PASS on the final tree, for the enumerated races only.** No finding is open. C-01 to C-13 were each reproduced with a failing test, fixed in the working tree, and re-verified with the reproduction unchanged, except the C-09/C-12 vocabulary update noted below. All stay as regression tests.
- Reviewer: concurrency-devils-advocate, run as a persistent subagent (no native teams). Requested model `claude-opus-5` (user-approved mapping); effective model reported by the runtime: **`claude-opus-5-5`**.
- Contracts: CONTRACTS.md v1 revision 3 (section 1); ARCHITECTURE.md sections 4-8; BUILD_PROMPT `<atomicity_and_action_boundary>`, `<contracts_and_invariants>`, `<persistent_runtime>`.
- Independence: expectations come from those documents only. The suites do not import the builders' harnesses. I did not read `evals/nemodots/frozen/**`. In `tests/nemodots/acceptance/**` I read only the two README notes the lead authorized (section "Frozen-oracle revision review"). I made no implementation edits.
- Source identity of the final run (2026-10-18T01:26:39Z): branch `nemodots`, HEAD `8f4d4cf`; `src/server/nemodots/actions/` is untracked. sha256 over the sorted `shasum -a 256` list of `src/server/nemodots/**/*.ts` = `bc381f75ba83799c3f91ddd4a0956ebf51c625a539675cd059b31161589d6411`. The same over `tests/nemodots/adversarial/concurrency/*` = `29df86c48ada9a7b99f92be76203c1291697e77a21070e36b939466a9c613cfa`. Times below are machine-local (UTC+05:30).

## Command and checks

The lead added `tests/nemodots/adversarial/**` to `vitest.integration.config.ts` (and excluded it from `npm test`); the suite's former local config is deleted.

```sh
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH NEMODOTS_INSTANCE=dev \
  NEMODOTS_PG_PORT=55442 NEMODOTS_REDIS_PORT=56389 NEMODOTS_CHECKOUT_PORT=4520
npm run test:nemodots:db -- tests/nemodots/adversarial/concurrency
```

Final runs (two consecutive): 11 files, 68 tests, 68 passed, 0 failed, 0 skipped, exit 0.

| check                                                     | exit | note             |
| --------------------------------------------------------- | ---- | ---------------- |
| suite above (x2)                                          | 0    | 68/68            |
| `prettier --check tests/nemodots/adversarial/concurrency` | 0    |                  |
| `eslint tests/nemodots/adversarial/concurrency`           | 0    |                  |
| `npm run typecheck`                                       | 0    | whole repository |
| `npm run check-format`                                    | 0    | whole repository |

Method: every test uses a fresh migrated database (`helpers/test-db.ts`) and a Redis prefix, with real PostgreSQL roles (app, injector, admin, checkout, verifier) and real Redis. Orderings come from the action test hooks (`NEMODOTS_TEST_HOOKS=1`), `helpers/barrier.ts` latches, `pg_locks` waiter counts, and gates: an admin transaction holding a table lock or a row lock that the code under test needs between two of its statements. Lease-expiry tests poll the database clock; no sleep decides an ordering. `harness.ts` wraps the pools and counts every 40P01/40001 raised, because `withTransaction` retries both silently.

## Findings (all reproduced, all fixed in the working tree, now regression tests)

| id   | sev    | invariant                                                                                                                                               | cause (at reproduction)                                                                                                                                                                                                                                                                                          | repro test                                                                                    | expected vs actual at reproduction                                                                                                                           | fix seen in code, and why the pass is for the right reason                                                                                                                                                                                                                                                               |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-01 | medium | CONTRACTS 5 / C5: a replayed tool call id with a different payload hash gives `idempotency_conflict`; BUILD_PROMPT "reuse with different payload fails" | `policy.ts` `idempotencyKeyOf` includes `expectedTargetVersion`, which is derived from the payload's own target, so a tampered target or action changed the key and the lookup in `propose.ts` found no row                                                                                                      | `idempotency.test.ts` C-01a, C-01b                                                            | expected: conflict, 1 live intent. Actual (05:50): replay stored `proposed`, 2 live intents for one tool call                                                | `propose.ts:186-192` now also matches `attempt_id = $2 AND tool_call_id = $3`. Setup unchanged; the test still asserts that the two targets' versions differ, so the key still differs and only the new match clause catches it                                                                                          |
| C-02 | medium | ARCHITECTURE 5.1: overlapping writers serialize without deadlock (W5.2: no 40P01)                                                                       | commit: intent, then mission; pause/cancel: mission, then attempts; closure prelock: attempts, then intents. A 3-cycle                                                                                                                                                                                           | `cancel-pause.test.ts` C-02                                                                   | expected: 0 deadlocks. Actual (05:52): 1 deadlock, 1.2 s, recovered by retry                                                                                 | `predicates.ts` `lockMissionThenIntent` is used by every action transaction, and `prelock.ts` `lockCoordinatorRows` now share-locks the missions first. The wait graph after the fix: pause waits on the mission tuple held by the commit, and the registration waits on the intent. No cycle; 0 deadlocks across 5 runs |
| C-03 | medium | BUILD_PROMPT: outputs and handoffs carry the union of injected dependencies (add, never remove); G2/G3                                                  | `publish.ts` `publishOutput`, `publishFinding` and `delegate` asserted only `requested ∪ inherited`, not the attempt's recorded `read_set_vector`                                                                                                                                                                | `provenance-scope.test.ts` C-03a (output), C-03b (finding), C-03c (delegate)                  | expected: SupportError, nothing written. Actual (05:5x-06:05): output and finding published on a read the injector had made stale, before the watcher ran    | `publish.ts` `outputVector()` = requested ∪ inherited ∪ `read_set_vector`, used at lines 251, 253, 434, 498 and 577. The setup is unchanged and still passes `dependencyVector: []`. The C-03c gap was found by reading the code; its fix (06:22) landed before the valid setup first ran, so C-03c never failed         |
| C-04 | low    | ARCHITECTURE 5.1: an admitted intent with an expired lease is re-claimable                                                                              | `admit.ts`: expiry decided with `clock_timestamp()`, re-claim UPDATE guarded by `<= now()` (the transaction start), so 0 rows and `ActionNotFoundError`                                                                                                                                                          | `commit-boundary.test.ts` C-04                                                                | expected: re-claimed. Actual (05:49): `ActionNotFoundError` for an existing intent                                                                           | the guard is gone (the row is locked and expiry is computed inside the transaction). Same hook setup: the transaction still begins before expiry and decides after it                                                                                                                                                    |
| C-05 | low    | ARCHITECTURE 6: the dispatcher lease runs `NEMODOTS_DISPATCH_LEASE_MS` from the grant                                                                   | re-claim and first-admission leases were `now() + ms`, which is the transaction start. A re-claim that waited returned a lease already expired                                                                                                                                                                   | `commit-boundary.test.ts` C-05                                                                | expected: lease live on return, new dispatcher commits. Actual (06:05): lease expired on return (fails closed, liveness only)                                | `admit.ts:114`, `rows.ts:198` (`setIntervalMs`), `dispatch.ts:174` use `clock_timestamp() + ms`, and the `rows.ts:204` guard uses `clock_timestamp()`. Same straddling setup                                                                                                                                             |
| C-06 | medium | ARCHITECTURE 5.1 no deadlock; probe of the new lock order: action vs cancel vs coordinator event inserts                                                | intent-first event writers (`settle.ts` x3, `reconcile.ts`, `dispatch.ts` `recordOutcome`) took the C6 events advisory lock, and then the `coordinator.events` foreign-key check took FOR KEY SHARE on the mission. Pause/cancel hold the mission FOR UPDATE and take the advisory lock last, in their own flush | `cancel-pause.test.ts` C-06 (a gate holds the attempt row that pause locks after the mission) | expected: 0 deadlocks. Actual (06:1x, 2 of 2 runs): 1 deadlock. Wait graph: pause waits on the advisory lock, settle waits on the missions tuple (KEY SHARE) | all five use `lockMissionThenIntent` (06:21). Settle now waits behind pause's FOR UPDATE at its first statement while holding nothing                                                                                                                                                                                    |

### Fresh-inversion probe of the new lock order

The order is now mission → attempt → task → output → intent → config rows (collection first) → ledger sources → receipts → events advisory lock (always last). For each class of coordinator writer I checked who locks what first:

- Mission first: fence, `claimAttempt`, `reapExpired`, recovery (`processOne`, `onInvalidation`, `reevaluate`, `onSelfWriteSettled`), plan/delegate (mission FOR UPDATE), every action transaction, and the closure prelock, including the closure-cap coarse path (`receipts.ts` preview, then `lockCoordinatorRows`).
- Intent first, with no mission: only `queries.ts` `cancelQueued` (around line 142). It writes no events, so it takes no mission key share, and it runs after the cancel transaction has committed.
- A transaction that holds the events advisory lock and then needs a conflicting lock: none found. Every flush is the last statement. Registration emits events after its coordinator, mission and ledger locks are already held.
- Registration is the only writer that touches several missions; it share-locks all of them, sorted, before anything else.

C-06 was the only fresh inversion I found, and it is fixed. Not probed: the outbox worker's handlers (W5.1 wiring absent) and the heartbeat. The heartbeat is a single UPDATE with no events.

## Dispatch across pause / resume / cancel (re-verification, `dispatch-lifecycle.test.ts`)

Lead ruling under test: a pause defers dispatch, a cancel ends a never-claimed flush as `failed(effect_not_applied)` with Authorization(dispatch, `mission_not_running`) and lists it in `committedEffects`, and claimed or dispatched flushes are left to their dispatcher. The change under test is in `actions/dispatch.ts` (`claimDispatch` locks the mission first; `recheckMission` runs after the new hook `after_claim_before_effect`; `findDispatchable`) and `actions/queries.ts` (`cancelQueued`).

Confirmed (PASS):

- A pause committed before the claim: `deferred`, 0 script calls, keys intact. Resume, `findDispatchable` lists the intent, dispatch gives `verified` with exactly one script call, and a later redelivery is a no-op.
- A pause between the claim and the effect (inside the hook): no effect, lease released, and resume gives exactly one effect.
- A cancel before any claim: `failed(effect_not_applied)`, exactly one Authorization `dispatch:blocked:mission_not_running`, listed in `committedEffects`, Redis untouched, and a late redelivery issues no script call.
- A cancel between the claim and the effect: the dispatcher's recheck settles it `failed` with no script call.
- Residual window (stated): a pause that commits after the last pre-effect read does not stop the effect. The effect runs once and is recorded `verified`. Characterized, not a defect.
- Lock order of the new transactions: `claimDispatch`, `recheckMission`, `recordOutcome` and `cancelQueued` all lock the mission (FOR SHARE), then the intent, then config FOR SHARE, and append events last. `findDispatchable` is a plain read. No new inversion. C-02 and C-06 still pass.

C-07 and C-08 were reproduced (failing runs at test hash `fc8eb0e3…`) and fixed in `actions/dispatch.ts` (06:36):

- C-07: the lazy branch now fails only a never-claimed flush. A claimed one goes to `settleClaimedOfStoppedMission`, which calls `reconcile`.
- C-08: `recheckMission` stops on any fence mismatch.

The unchanged tests (same hash `fc8eb0e3…`) then passed: C-07 ends `verified` through the marker, and C-08 makes 0 script calls. They are kept as regression tests.

C-09 was reproduced (2 of 2 runs) and is fixed. `settleClaimedOfStoppedMission` now plants a refusal marker with `SET NX` before recording "not run" (`actions/dispatch.ts:568-582`). The C-09 test passes unchanged, and it stays as a regression test.

Findings from the reviews of the C-09 fix and of replan coalescing. All three were reproduced with failing tests, then fixed in the working tree, and they are now regression tests:

| id   | sev    | invariant                                         | cause at reproduction                                                                                                                                                                                                                 | repro                             | expected vs actual at reproduction                                                                                                                       | fix (re-verified, repro passing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-10 | medium | CONTRACTS 1 rev3 "replan coalescing"; `replanCap` | `coordinator/recovery.ts` eligible loop: a later ungated event that reached the held planner (`invalidated` is in `ACTIVE_FOR_REPAIR`) requeued it with `holdInvalidated: false` and recorded `repair_scheduled`                      | `replan-coalescing.test.ts` C-10  | at reproduction (06:47): the planner was released early, recorded as a repair, and the final `replan_scheduled` count was 0 (not counted toward the cap) | 06:50: a held planner (or repair) that a later event reaches is recorded `replan_coalesced` / `repair_coalesced` and stays held. The repro passes unchanged                                                                                                                                                                                                                                                                                                                                                                   |
| C-12 | low    | the cancel ruling; BUILD_PROMPT invariant 8       | the C-09 tombstone reused `fence_newer`, which `reconcile` maps to `dispatch_fence_invalid`                                                                                                                                           | `dispatch-lifecycle.test.ts` C-12 | at reproduction: a lost tombstone ack led to `failed(dispatch_fence_invalid)` for a never-run, cancelled flush                                           | 06:49: a distinct `not_applied` marker. The Lua script returns `refused_not_applied` for it with no effect (`actions/dispatch.ts:64-68`), and `readMarker`/`reconcile` map it to `failed(effect_not_applied)` (`actions/reconcile.ts:44-45`, `:103`). I updated two test details to the new marker vocabulary without loosening the record-versus-Redis consistency check: C-09 now treats `not_applied` as a refusal, and C-12 detects the tombstone script by shape (`SET … NX` without `SCAN`) instead of by its old value |
| C-13 | low    | the lead's "a merge is never silently dropped"    | `recordReplanMerge` recorded the merge only when the planner still carried a `repair` spec. `claimAttempt` clears it (`coordinator/leases.ts:137`), so a root invalidation during a RUNNING replan was neither scheduled nor recorded | `replan-coalescing.test.ts` C-13  | at reproduction (06:51): no `replan_*` record for the event                                                                                              | 06:53: a merge is recorded whenever the planner is not settled (`recovery.ts:457-475`). At `replanCap` nothing is recorded by design, because no replan is pending                                                                                                                                                                                                                                                                                                                                                            |

Judgements requested by the lead:

- **No cap re-check at release: airtight on the final tree.**
  - Every path that can record `replan_scheduled` either requires a `succeeded` planner (`scheduleReplan`, also behind `requestReplan`) or is the release itself. Concurrent events serialize on the planner row (`lockGateAndPlanner`).
  - While the planner is held, a later event now only records `replan_coalesced` (the C-10 fix).
  - The reaper touches only expired running attempts, and the held planner has none. Pause and resume do not touch it. Cancel or fail cancels it, so it is never released.
  - Before the C-10 fix the argument did not hold: a planner run could be recorded as `repair_scheduled` and escape the cap.
- **Lock order mission → attempts → open gate → planner → other tasks by id: consistent.** No inversion against publication, `publishPlan`, `requestReplan` or the reaper.
  - Every path that holds the gate takes it first. Any recovery during an open gate blocks on the gate before it takes the planner or other tasks.
  - `requestReplan` holds its own attempt, and recovery locks the running attempts of affected tasks before any task row, so the two serialize at the attempt.
  - `processOne` locks only an UNPROCESSED invalidation row, while `resolveClosedInvalidations` updates only PROCESSED rows: unprocessed rows are always open (`evaluateOpen`, the `processed_at === null` branch). The two never contend.
- **Tombstone value.** The builder's objection to a plain `not_applied` was correct for the old script, whose existing-marker branch returned `already_applied` for any value other than `fence_newer`. That would have let a racing dispatcher record `verified` for a flush that never ran. The fix that landed has a distinct `not_applied` with its own script branch (`refused_not_applied`, no effect) and its own reconcile mapping (`effect_not_applied`). That is sound: no effect in any interleaving, and an honest reason under every crash timing (C-12 repro passes). `fence_newer` alone was not honest (C-12).

Replan coalescing, confirmed (PASS, `replan-coalescing.test.ts`; setup uses the coordinator integration harness, while the expectations come from the ruling):

- The held planner is not claimable while the gate is open.
- It stays held across a pause and a resume.
- Completing the gate releases it exactly once, as `replan_scheduled`, with one `replan_coalesced` for the event; a second `releaseGate` call releases 0.
- A postcondition that fails for good still releases exactly one replan.
- A second verified event behind the same gate records its own `replan_coalesced`.
- Lock order: `scheduleReplan` and `releaseGate` run inside transactions that already hold the mission (recovery `processOne` takes the mission FOR SHARE first; the publication and reaper paths do too), then the planner task FOR UPDATE, then invalidations, with events appended last. No new inversion was found.
- Migration `0008_recovery_kinds` recreates the kind CHECK with an explicit literal list that includes `replan_coalesced`.

## Cleared hypotheses (regression tests, all PASS)

`commit-boundary.test.ts`

- Stale before commit: blocked, value untouched, no action row.
- Stale after the preliminary unlocked read.
- A writer arriving after the commit's checks waits and applies on top: the action at v+1, then the injector at v+2.
- Duplicate commit with one fence: one effect, one commit Authorization, the same receipt id.
- A zombie dispatcher writes nothing after a re-claim.
- ABA, controlled: version v+2 blocks the intent and supersedes the v receipt.
- ABA, observed: ok→degraded→ok supersedes the first receipt.
- A non-target key in the vector changing mid-commit blocks it; an unrelated key stays writable.
- Invalidation versus commit ordering, both orders, under READ COMMITTED and SERIALIZABLE (the isolation level is asserted). Commit first: the registration waits and the applied action stays `committed`. Invalidation first: blocked, nothing mutated.

`dispatch.test.ts`

- Crash after the effect and before the record: the second dispatcher gets `already_applied`; refilled keys survive.
- A zombie dispatcher parked after its effect is superseded by its successor; effect once.
- Lost acknowledgement: `outcome_unknown`, then reconcile gives `verified`; no second script run.
- Failure before Redis: `failed(effect_not_applied)`, no marker.
- A `cache.namespace` advance between commit and dispatch: `failed(dispatch_fence_invalid)` with 0 script calls (C3/C11).

`idempotency.test.ts`

- Same-target tamper (in-domain value) gives `idempotency_conflict`; an out-of-domain replay is rejected with `ProposalRejectedError(payload_invalid)` and stores nothing (ADM-06c ordering). The tamper value is now inside the value domain: proposals outside it are rejected up front with `ProposalRejectedError(payload_invalid)` since a later edit, which is an acceptable earlier rejection.
- Concurrent identical deliveries give one intent.
- Re-proposal after a block through a new tool call (C5).

`cancel-pause.test.ts`

- Cancel waits for a parked commit, records `committedEffects`, cancels queued intents and bumps the generation (C12).
- Pause waits for the commit, and a later commit is `blocked(mission_not_running)`.

`events.test.ts`

- No id above an open event-writing transaction's id becomes visible.
- Ids are contiguous per transaction under concurrent commits (C6).

`self-write.test.ts`

- The injector and admin roles cannot set `caused_by_action_id` on the head or the history.
- The checkout and verifier roles get 42501.
- The strict payload rejects a marker field.
- A forged `selfWrite: 'verified'` claim excuses nobody.
- A foreign write between the watcher's classification and its registration gives a head with `selfWrite: 'none'`, the intent `verified`, and the lineage invalidated (C7).

`fences-cap.test.ts`

- A zombie author cannot propose or publish.
- A proposal from a then-valid author stays committable after a takeover.
- The author token is not accepted as a dispatch fence.
- Closure cap: the mission pauses, the receipt is registered, the commit is blocked, and no loop occurs (C14).

`publication-collection.test.ts`

- A publication's FOR SHARE makes a writer wait (C9).
- A read added after its receipt was superseded invalidates the attempt (C13).
- Collection-first key insert against a commit gives 0 deadlocks (C1).
- B1 isolation (C1/D1).

`provenance-scope.test.ts`

- An output carrying its stale read is rejected (G3).
- A citation from another scope gives `citation_out_of_scope`.
- A receipt from another Space is refused by `assertCurrent`.
- A supersession in one Space leaves the other Space's receipt current (revision 3).

## Frozen-oracle revision review (independent of verifier and builder)

Read once, as authorized: `tests/nemodots/acceptance/g2-races/README.md`, the "Reviewed-correction PROPOSALS" ADM-03b row and "Separate-review note: ADM-08". No other acceptance file was read.

- **ADM-03b: CONFIRM changing the expected code to `stale_pending_observation`. REJECT the table's "at COMMIT accept either".** The change is not registered, so the target receipt is still `supported` and records the old version. `assertCurrent` runs before the target-version check (`actions/predicates.ts:256` before `:270`), and `judge` returns `stale_pending_observation` whenever live > recorded (`ledger/support.ts:80-85`). `stale_version` is unreachable for this state: versions only increase, so live < recorded cannot happen, and the commit's own CAS fallback (`actions/commit.ts:160`) cannot fire while the row is held FOR UPDATE. My reproductions saw `stale_pending_observation` every time. The property the case tests (refusal under lock, no mutation) is kept. "Accept either" would loosen the oracle with no reason, so pin the exact code at both stages.
- **ADM-08: CONFIRM that the original step is unreachable. REJECT the proposed revision as written: it is unreachable too.** Original: the registration blocks IA through the closure (ARCH 5.2 step 4). A commit of a blocked intent returns the stored decision at `actions/commit.ts:79-80`, after `lockMissionThenIntent`. It returns rather than throwing, and writes no Authorization, so the README's "throws before taking any lock" is inaccurate in detail. Either way, `after_lock_before_commit` (`actions/commit.ts:214`) is never reached. Proposed (`register: false`): IA's commit now fails its predicates and returns through `block()` (`commit.ts:118-144`). That path also never calls `after_lock_before_commit`, because the hook sits only on the success path after the outbox enqueue. So "IA blocked with the commit-stage Authorization" and "parked at `after_lock_before_commit`" cannot both hold, `during: commit IB` never runs while IA holds its locks, and the case's property (a parked commit on one resource never delays another) is not exercised. Two ways to keep the property: (a) leave IA's premise unchanged, park the successful IA commit at `after_lock_before_commit` holding its rows, require IB (another key) to commit within 2000 ms, then release IA (both committed, `actionRows` 2). This is the README's G2-08b. (b) Keep "IA blocked" as a separate case (G2-08a) that is not hooked. A hook on the block path would need a builder change to `test-hooks.ts`.

## Residual freshness windows (stated, not defects)

- Observed sources (`checkout.health`, `redis.stats`) are **freshness-at-admission**. Admission and commit require a confirmation younger than `maxAgeMs` = 120 000 ms (`contracts/policy.ts`). A change the watcher has not observed, including an unobserved A→B→A, is undetectable; the window is up to `maxAgeMs` plus commit latency, bounded by `NEMODOTS_WATCH_INTERVAL_MS`.
- The flush is **freshness-at-dispatch**. The `claimDispatch` CAS checks the `cache.namespace` version in PostgreSQL. The Redis fence only orders flushes against the last applied version, so an advance between the claim and the script is invisible to Redis.
- Closure cap: `ClosureCapExceeded.missionIds` comes from a truncated closure, so missions beyond the cap are neither paused nor listed in the coarse event. G1/G2 still reject the superseded receipt, so this degrades recovery, not admission.

## Scope and closure

The enumerated hypothesis list is **closed**: everything in the W5.2 contract and in the lead's mission list. That covers stale-before-commit and stale-after-local-check, lease overlap and zombie workers, fencing on publish, delegate, propose, admit, commit and dispatch, authoring-fence versus dispatch-fence confusion, ABA, two-key races, invalidation/commit ordering (READ COMMITTED and SERIALIZABLE), duplicate delivery and unknown outcomes, self-write spoofing and interleaving, cancel and pause during commit and dispatch, closure-cap and lock-order deadlocks, incomplete provenance, cross-scope and cross-mission support, event-id ordering, dispatch across pause/resume/cancel, and replan coalescing. Each hypothesis is a test in this directory that passes on the final tree.

The core G1 guarantee held in every round: no controlled commit under a stale required version, receipt, fence, generation or idempotency binding. None of the 13 findings was an effect under invalid evidence, a lost committed effect or a duplicate effect. They were liveness defects (C-02, C-05, C-06, all retried and recovered), record-honesty defects (C-04, C-07, C-09, C-12, C-13), fail-open boundary gaps with no model-reachable path (C-01, C-03), and dispatch-semantics gaps (C-08, C-10).

Per the wrap-up scope, new probes after this point are opened only for a plausible critical or high issue: an effect under invalid evidence, a lost committed effect, a duplicate effect, or a deadlock in a normal path. I saw none, so lower observations are recorded below as residual risks with limits.

## Residual risks (documented, with limits; not open findings)

- **Freshness-at-admission** for observed sources (`checkout.health`, `redis.stats`). Limit: a change the watcher has not observed is invisible for up to `maxAgeMs` (120 000 ms) plus commit latency, in practice bounded by `NEMODOTS_WATCH_INTERVAL_MS`. An unobserved A→B→A is undetectable.
- **Freshness-at-dispatch** for the flush. Limit: a pause, cancel or `cache.namespace` advance that commits after the dispatcher's last pre-effect read (`recheckMission`) does not stop the effect. The window is one PostgreSQL round trip plus the time to the Redis `EVAL`. The effect still runs at most once (the marker), and since C-09/C-12 the record is honest.
- **Closure cap.** Limit: `ClosureCapExceeded.missionIds` comes from a truncated closure, so missions beyond the cap (10 000 nodes / depth 64) are neither paused nor listed in the coarse event. Their attempts keep running until a publication or commit rejects the superseded receipt (G1/G2 still hold). Recovery is degraded; admission is not.
- **`request_replan` is not gated.** Limit: a worker's explicit `request_replan` while a verified self-write's postcondition gate is open schedules an immediate `replan_scheduled` (`publish.ts` `requestReplan` → `scheduleReplan` with no gate). The ruling covers replans triggered by invalidation events only. This is bounded by `replanCap` and by the capability: only investigators hold `request_replan`.
- **No record at `replanCap`.** Limit: once the cap is reached, a root invalidation records no `replan_*` kind, because no replan is pending. The cap is visible in the mission config; there is no explicit "suppressed" record.
- **Not covered.**
  - The outbox/HTTP delivery of `action.dispatch` and the dispatch worker loop: the units are tested, the W5.1 composition is not.
  - `compensate` racing a new writer.
  - The approval race (W3.3).
  - LS-1 claim races, which are probabilistic in the verifier's suite.
  - Live Crusoe paths: none are needed for this review, and none ran.
- **Evidence binding.** No universal safety claim. The actions and coordinator code changed about ten times during the review, and the results bind only to the source and test hashes at the top.
- **Test hygiene (resolved by the lead).** During one debug run, a pg `DatabaseError` 57P01 from my own temporary pools (no `'error'` listener, force-dropped database) was serialized by vitest with the hidden `client.password`. Production serialization was checked and is clean. `tests/nemodots/helpers/pg-error-guard.ts`, now a setup file of `vitest.integration.config.ts`, attaches a default listener. Rotating the dev-stack app-role password is still advised.
