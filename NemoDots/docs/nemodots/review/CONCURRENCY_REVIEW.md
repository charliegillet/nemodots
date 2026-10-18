# W5.2 concurrency adversary review

- Task: `W5.2-concurrency-adversary`. Status: **FAIL** (2 open findings with failing reproductions: C-03 medium, C-05 low; 3 reproduced findings were fixed in the working tree while the review ran and are now regression tests).
- Reviewer: concurrency-devils-advocate, run as a persistent subagent (no native teams). Requested model `claude-opus-5` (user-approved mapping to `claude-opus-5-5`); effective model reported by the runtime: **`claude-opus-5-5`**.
- Contracts: CONTRACTS.md v1 revision 3 (section 1); ARCHITECTURE.md sections 4-8; BUILD_PROMPT `<atomicity_and_action_boundary>`, `<contracts_and_invariants>`, `<persistent_runtime>`.
- Independence: expectations come from those documents only. I did not read `tests/nemodots/acceptance/**` or `evals/nemodots/frozen/**`, and the suites do not import the builders' test harnesses. Implementation files were not edited.
- Source identity: branch `nemodots`, HEAD `8f4d4cf`. `src/server/nemodots/actions/` is untracked and was edited by another agent during the review (mtimes 05:52:40 and 05:53:47 machine-local). Final run, 2026-10-18T00:35:56Z: sha256 over the sorted `sha256sum` list of `src/server/nemodots/**/*.ts` = `ebbcf3a199439fc9d9876118646852722ed6dd6efac8b7270559372842085a47`; the same over `tests/nemodots/adversarial/concurrency/*` = `52d7781d031355057cfd9146d8c49291e2876d77a1c135d4178f80565335c3ba`. Results are valid for those trees only.

## Command

`vitest.integration.config.ts` includes only `tests/nemodots/integration/**`, so the contract command `npm run test:nemodots:db -- tests/nemodots/adversarial/concurrency` selects no files. This is a dependency for the lead, because I may not edit configs outside my directory. The suite ships its own config inside the directory:

```sh
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PATH NEMODOTS_INSTANCE=dev \
  NEMODOTS_PG_PORT=55442 NEMODOTS_REDIS_PORT=56389 NEMODOTS_CHECKOUT_PORT=4520
node scripts/nemodots/stack.mjs exec -- npx vitest run \
  --config tests/nemodots/adversarial/concurrency/vitest.config.ts
```

Final run: 9 files, 50 tests, 47 passed, 3 failed (C-03a, C-03b, C-05), 0 skipped, exit 1. Every test uses a fresh migrated database (`helpers/test-db.ts`) and a fresh Redis prefix, with real PostgreSQL (app, injector, admin, checkout and verifier roles) and real Redis. Races are ordered with the action test hooks (`NEMODOTS_TEST_HOOKS=1`), `helpers/barrier.ts` latches, `pg_locks` waiter counts, and table-lock gates. No sleeps decide an ordering; lease-expiry tests poll the database clock. `harness.ts` counts every 40P01/40001 that a wrapped pool raises, because `withTransaction` retries both silently.

Other checks: `prettier --check tests/nemodots/adversarial/concurrency` exit 0. `eslint tests/nemodots/adversarial/concurrency` exit 0. `npm run typecheck` reports 0 errors in this directory; it exits non-zero because of errors in other packages (`tests/nemodots/integration/watcher/harness.ts` and `routes.test.ts`, which the ledger `events` change is breaking). `npm run check-format` exits 1, but no file in this directory is flagged.

## Findings

| id   | sev    | state                                    | invariant                                                                                                                                                                                         | cause                                                                                                                                                                                                                                                       | reproduction                                                                                                                                                                       | expected vs actual                                                                                                                                                                                                |
| ---- | ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-03 | medium | **open**                                 | BUILD_PROMPT: "propagate the union of injected dependencies into outputs and handoffs; a specialist can add but not remove"; G2/G3                                                                | `coordinator/publish.ts` `publishOutput` asserts `union(requested, inherited_dependency_vector)` (around lines 218-223); `publishFinding` `vectorFor` (around 566-583) does the same. The attempt's recorded `read_set_vector` is never unioned in | `provenance-scope.test.ts` "FINDING C-03a" (publishOutput) and "C-03b" (publishFinding): `addReadSet` records R (`db.pool_max`), the injector advances the key, no watcher runs, then publish runs with `dependencyVector: []` | expected: SupportError (`stale_pending_observation`) and no output, the same result as when the vector carries R (cleared control test). Actual: output/finding published `ok`, resting on a stale premise inside the G3 window |
| C-05 | low    | **open**                                 | ARCHITECTURE 6: the dispatcher lease is `NEMODOTS_DISPATCH_LEASE_MS` from the grant; an admitted, re-claimed intent is committable by its new dispatcher                                         | `actions/admit.ts` re-claim UPDATE sets `dispatcher_lease_expires_at = now() + lease` (around line 114); `now()` is the transaction start. `rows.ts` `transition()` `setIntervalMs` uses the same rule for first admission                     | `commit-boundary.test.ts` "FINDING C-05": the re-claim's transaction starts before the old lease expires and decides after it                                                     | expected: the new lease is live when the re-claim returns and d2 can commit. Actual: `dispatcher_lease_expires_at <= clock_timestamp()` on return. Fails closed: d2's commit raises `DispatchFenceError(lease_expired)` and the intent is re-claimable again at once (liveness only) |
| C-01 | medium | reproduced, fixed concurrently           | CONTRACTS 5 / C5: one tool call id plus a different payload hash gives `idempotency_conflict`; BUILD_PROMPT: "reuse with different payload fails"                                                 | key = sha256(…, action, expectedTargetVersion, toolCallId) (`policy.ts` `idempotencyKeyOf`), and expectedTargetVersion is derived from the payload's own target, so a tampered target or action changed the key. Fixed: `propose.ts` lookup now also matches `attempt_id + tool_call_id` | `idempotency.test.ts` "C-01a/C-01b regression"                                                                                                                                     | first run (05:50): the replay against another key / another action was stored `proposed`, giving 2 live intents for one tool call. Now: `idempotency_conflict`, 1 live intent (PASS)                                    |
| C-02 | medium | reproduced, fixed concurrently           | ARCHITECTURE 5.1 "overlapping writers serialize without deadlock" (W5.2: no 40P01)                                                                                                                | commit locked intent, then mission (old `commit.ts` order); pause/cancel lock mission, then attempts; closure prelock locks attempts/tasks, then intents with no mission lock: a 3-cycle. Fixed: `predicates.ts` `lockMissionThenIntent` (mission, then intent) used by commit | `cancel-pause.test.ts` "C-02 regression" (an ACCESS EXCLUSIVE gate on `result_receipts` widens the window between the commit's two locks)                                          | first run (05:52): `deadlocks = 1`, 1.2 s (`deadlock_timeout`), recovered by retry. Now: 0 deadlocks, all three complete (PASS, 3 consecutive runs)                                                                   |
| C-04 | low    | reproduced, fixed concurrently           | ARCHITECTURE 5.1: an admitted intent whose lease expired is re-claimable                                                                                                                          | `admit.ts` decided expiry with `clock_timestamp()` but guarded the re-claim UPDATE with `<= now()` (transaction start); 0 rows, so ActionNotFoundError. Fixed: guard removed (the row is locked and expiry is computed inside the transaction)       | `commit-boundary.test.ts` "C-04 regression"                                                                                                                                        | first run (05:49): `ActionNotFoundError` for an existing intent. Now: re-claimed by d2 (PASS)                                                                                                                         |

Fix guidance (for the lead to assign; I made no implementation edits):

- C-03: in `runPublication` callers, include `fenced.attempt.read_set_vector` (and the output vectors of the attempt's recorded model calls) in the asserted and stored vector. A caller can then add dependencies but never remove one. The only caller today, `team/worker-loop.ts` (final-answer branch), already passes a conservative union, so there is no exploit path from the model now. The gap is at the boundary that G2 names as the enforcement point.
- C-05: compute the lease from `clock_timestamp()` in the re-claim UPDATE, in `transition()` `setIntervalMs`, and in `claimDispatch`, so the lease starts at the grant, not at `BEGIN`.

## Cleared hypotheses (kept as regression tests, all PASS)

`commit-boundary.test.ts`

- Stale before commit: the target advanced between admission and commit, so the commit is `blocked(stale_*)`, the value is the injector's, there is no action row in `config_versions`, and the authorizations are `admission:admitted, commit:blocked`.
- Stale after local check: an injector write at `after_preliminary_read` (before any lock) is caught under lock, with no mutation.
- A writer arriving after the commit passed its checks (`after_lock_before_commit`) waits on the row lock and then applies on top. The history is the action at v+1, then the injector at v+2.
- Duplicate delivery: two commits with one fence released together by a `before_lock` barrier give exactly one action row, one `commit` Authorization and the same ResultReceipt id, with `replayed` = [false, true].
- Zombie dispatcher: after lease expiry and re-claim, the old fence's commit throws `DispatchFenceError` and writes nothing (no Authorization, no history row); the new fence commits.
- ABA, controlled: value A→B→A gives version v+2, so the intent made against v is blocked, and registering v+2 supersedes the v receipt.
- ABA, observed: health ok→degraded→ok supersedes the first ok receipt, and the intent is blocked.
- Cross-resource: a non-target key in the vector advancing mid-commit blocks it. An unrelated key stays writable while a commit holds its rows (per-resource versions).
- Invalidation versus commit ordering, under both READ COMMITTED and SERIALIZABLE (the pool's `default_transaction_isolation` is asserted). Commit first: the invalidating registration waits, the intent stays `committed` (applied history is not rewritten), and the receipt is superseded. Invalidation first: the commit is `blocked` with no mutation.

`dispatch.test.ts` (Redis effect counted from Redis keys)

- Crash after the effect and before the record, then a second dispatcher after lease expiry: `already_applied`, intent `verified`, and the refilled keys survive (no second UNLINK).
- A zombie dispatcher parked at `after_effect_before_record` while the successor settles: the zombie records nothing over it. Effect once, 2 script calls.
- Lost acknowledgement: `outcome_unknown`, then reconcile reads the marker and returns `verified`; the script never re-runs.
- Failure before Redis: `outcome_unknown`, then reconcile settles `failed(effect_not_applied)`. A redelivered dispatch does nothing and no marker exists.
- `cache.namespace` advanced after commit and before dispatch: `failed(dispatch_fence_invalid)`, 0 script calls, keys intact (C11).

`idempotency.test.ts`

- Same tool call id with a tampered value on the same target gives `idempotency_conflict`.
- Concurrent identical deliveries return one stored intent.
- After a block, a new tool call can re-propose the same payload (C5).

`cancel-pause.test.ts`

- Cancel waits for a parked commit (mission FOR UPDATE versus FOR SHARE). Afterwards the generation is 1, `committedEffects` holds the committed intent, the queued intent is `cancelled` and listed, and the value is the commit's (C12).
- Pause waits for the commit, and a later commit of the paused mission is `blocked(mission_not_running)`.

`events.test.ts`

- While an event-writing transaction holding id n is open, an admission's events wait on the advisory lock, and no id > n is visible.
- Concurrent commits in two missions: each transaction's event ids are contiguous in id order (C6).

`self-write.test.ts`

- The injector and admin roles cannot set `caused_by_action_id` on `config_entries` or `config_versions`; the trigger nulls it.
- The checkout and verifier roles get 42501.
- A proposal payload carrying `causedByActionId` is rejected by the strict schema.
- A forged `selfWrite: 'verified'` claim for an injector revision excuses nobody: the acting attempt is invalidated.
- Self-write/foreign-write interleaving, using the watcher with a `beforeRegister` hook that writes v3 after the walk classified v2 as a verified self-write: the walk restarts, the head receipt is rev 3 `selfWrite: 'none'`, the intent is `verified`, and the acting lineage is invalidated (C7).

`fences-cap.test.ts`

- An author whose lease was taken over cannot propose (FenceError, 0 rows written).
- A proposal published by a then-valid author stays admissible and committable after the takeover.
- The author token is not accepted as a dispatch fence.
- A zombie author cannot publish an output.
- Closure cap (maxNodes 1): the mission is paused, the receipt is superseded and registered, the dependent commit is blocked, and a second pass does not re-enter the cap path (C14).

`publication-collection.test.ts`

- A writer waits for an in-flight publication that holds its config row FOR SHARE (C9, stalled with a gate on `task_outputs`).
- A read added after its receipt was superseded rejects the publication and leaves the attempt `invalidated` (C13).
- An injector key insert (collection row first) serializes behind a commit that holds the collection with 0 deadlocks (C1).
- B1: a `ui.banner_text` value change supersedes only that member; the collection receipt and the intent's member receipt stay current, and the intent admits (C1/D1).

`provenance-scope.test.ts`

- The same output carrying its stale read is rejected (G3 holds before the watcher runs).
- A receipt from a mission in another scope gives `citation_out_of_scope`.
- `assertCurrent` refuses a receipt from another Space for the same key.
- A supersession in Space 1 leaves the Space 2 receipt current (revision 3).

## Residual freshness windows (stated, not defects)

- Observed sources (`checkout.health`, `redis.stats`) are **freshness-at-admission**. A change the watcher has not observed cannot be detected. Admission and commit require a confirmation younger than `maxAgeMs` = 120 000 ms (`contracts/policy.ts`), so the window is up to `maxAgeMs` plus commit latency, bounded in practice by `NEMODOTS_WATCH_INTERVAL_MS`. An unobserved A→B→A on an observed source is invisible by construction.
- The flush is **freshness-at-dispatch**. The `claimDispatch` CAS checks the `cache.namespace` version in PostgreSQL. The Redis fence only orders flushes against the last *applied* version, so a namespace advance after the claim and before the script runs is not seen by Redis.
- Closure cap: `ClosureCapExceeded.missionIds` comes from a truncated closure, so missions beyond the cap are neither paused nor in the coarse event. Their attempts are not marked `invalidated`, but every publication and commit still rejects the superseded receipt (G1/G2). This is degraded recovery, not unsafe admission (not reproduced separately).

## Remaining risks and limits

- No universal safety claim: the review covers the enumerated races on the source identity above, and the actions package changed during the review.
- `WatcherDeps.ledger` is typed `LedgerOptions`, without `events`, while registration requires `events`. A bootstrap that follows the type gets a runtime `event_sink_missing`. The tests pass `LEDGER as never`. This is a W5.1/ledger dependency.
- Not covered: the HTTP and outbox delivery of `action.dispatch` (W5.1 wiring is absent), `compensate` racing a new writer, and the approval-race item (moved to W3.3).
- Cancel after the commit of a flush and before its dispatch lists the flush in `committedEffects`, then `claimDispatch` fails it with `dispatch_fence_invalid` because the generation moved. This fails closed, but the reason string does not say "cancelled". `claimDispatch` does not check mission *status*, so a flush committed before a pause is dispatched while paused. Both are questions of semantics for the lead.
