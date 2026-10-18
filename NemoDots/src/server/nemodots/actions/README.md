# Actions: the controlled-commit boundary

This package implements guarantee **G1** of `docs/nemodots/ARCHITECTURE.md` (sections 4 and 5)
for the two `ActionKind`s of policy-v1: `set_config` and `flush_cache_namespace`. Everything a
model proposes passes through two durable PostgreSQL transactions that both run **every**
predicate, then (for the flush only) one external effect with its own fence.

```text
propose ──► admission txn ──► commit txn ──► [claimDispatch ─► Lua effect ─► record] ──► verified
 (stored)   proposed→admitted   admitted→committed   flush only                         (set_config:
            |blocked            |blocked            committed→dispatched→verified       by the watcher)
                                                    |failed |outcome_unknown
```

No LLM, Redis or HTTP call ever happens inside a PostgreSQL transaction. The only writer of
`checkout.config_entries` is `sandbox/version-authority.ts::advanceConfig`; nothing here bypasses it.

## Modules

| File            | What it is                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.ts`     | Pure policy-v1: required sources, value domains, capability, `maxAgeMs`, payload hash, idempotency key, citation scope, expected target version. `checkBinding` re-derives all of it from a stored row. |
| `propose.ts`    | `ActionAdmissionPort.propose`. Author fence, emitting snapshot vector, citation scope, idempotency, evidence edges, outbox hint, events.                                                                |
| `store.ts`      | Inserts an intent (shared by propose and compensate).                                                                                                                                                   |
| `predicates.ts` | The G1 predicates, shared by admission (`FOR SHARE`) and commit (`FOR UPDATE`).                                                                                                                         |
| `admit.ts`      | Admission and re-admission: `proposed → admitted \| blocked`; claims the dispatch lease.                                                                                                                |
| `commit.ts`     | Commit steps 1-10. Duplicate short-circuit, `DispatchFenceError`, lock order, `advanceConfig`, receipt, Authorization, outbox, events.                                                                  |
| `dispatch.ts`   | Redis epoch, `claimDispatch` CAS (records the attempt), the epoch-and-marker-first Lua script, record (`dispatched → verified`, `failed`, `outcome_unknown`).                                           |
| `reconcile.ts`  | Reads the effect marker, the stored receipts and the Redis epoch; never re-runs the effect.                                                                                                             |
| `reclaim.ts`    | Finds stuck work (expired admission leases, undispatched flushes, unsettled effects); re-admission is `admit.ts`.                                                                                       |
| `settle.ts`     | `settleFromHistory(actionId, outcome)`: the watcher's way to move a committed `set_config` to `verified` or `failed`, and to tell the `RecoveryPort`.                                                   |
| `compensate.ts` | `set_config` reversal as a **new** intent (refused when the version moved; a flush is never "undone").                                                                                                  |
| `service.ts`    | `createActionService(deps)`: the port plus `process` (state-driven pipeline), `sweep`, `coordinatorPort()` (what `coordinator.deps.actions` takes).                                                     |
| `queries.ts`    | `createIntentReader` (coordinator's `IntentReader`), `readActionSnapshot`, `inspectAction` (action inspector).                                                                                          |
| `test-hooks.ts` | The five named barriers. Active only with `NEMODOTS_TEST_HOOKS=1`; `SimulatedCrash` models process death.                                                                                               |

Migration `db/migrations/0005_actions.ts` creates `coordinator.action_intents`, `authorizations`,
`result_receipts` and `coordinator.action_dispatch_seq`. It also installs: a trigger that makes
the binding columns immutable and the status follow `ACTION_TRANSITIONS` (generated from the
contract), an `AFTER INSERT` trigger that notifies `nemodots_action_proposed` with the target key
only, append-only triggers on authorizations and receipts, a unique index allowing one commit
Authorization per action, and a trigger that records an Authorization when the ledger's
invalidation closure blocks a live intent.

## The transactions

**Proposal** (one transaction). The author's fence, generation and lease are validated under the
mission `FOR SHARE` and the attempt and task `FOR UPDATE` (`coordinator/fence.ts`); a lost fence
throws `FenceError` and writes nothing. The intent's dependency vector is the emitting model
call's `snapshot.dependencyVector` **union** the cited receipts, each of which must be in scope
(snapshot vector, attempt readset or inherited vector) or the intent is stored
`blocked(citation_out_of_scope)`. Required sources, value domain and capability come from the
server's policy, never from the model. The `toolCallId` must be one the emitting model call
produced as a `propose_action` call (`ledger.model_call_records.tool_calls`); an invented or
regenerated id throws `InvalidProposalError` and writes nothing. Idempotency is bound to that
**tool call**: inside the per-tool-call advisory lock every intent of `(attempt, toolCallId)` is
looked up, whatever its action or target key. The payload hash (action, payload, target,
environment, policy version, expected version, vector) decides: the same hash returns the stored
intent, any other payload (a different value, a different `ActionKind`, a target key at another
version, other citations) stores `blocked(idempotency_conflict)`. The idempotency key
`sha256(missionId, taskId, attemptId, action, expectedTargetVersion, toolCallId)` stays as the row's
identity, and two partial unique indexes over the live statuses (`idempotency_key`, and
`(attempt_id, tool_call_id)`) are the database backstop: one tool call can never become two live
actions. A proposal the policy refuses is stored as a blocked intent with
an Authorization; a malformed one (unknown `ActionKind`, any extra field such as a forged
`causedByActionId`) throws `InvalidProposalError` and writes nothing.

**Admission** (`admit.ts`). Intent `FOR UPDATE`, mission `FOR SHARE`, controlled rows `FOR SHARE`,
every predicate, then `dispatch_fence = nextval(...)` and a lease of `NEMODOTS_DISPATCH_LEASE_MS`.
`admitted` is durable. An `admitted` intent whose lease expired is re-admitted by the next
dispatcher (all predicates again, a new fence, a new Authorization).

**Commit** (`commit.ts`), in the order of ARCHITECTURE 5.1:

1. intent `FOR UPDATE`. If it is `committed | dispatched | verified | outcome_unknown` (or a
   `committed` result receipt exists) the stored `ResultReceipt` is returned and **nothing is
   written, no Authorization** (duplicate delivery, C2). Not admitted, a different dispatch fence
   or an expired dispatcher lease throws `DispatchFenceError`, again writing nothing.
2. mission `FOR SHARE` (generation and status compared).
3. collection row first, then member rows in key order, `FOR UPDATE`.
4. all predicates re-run (below). A failure writes `Authorization(blocked)`, moves
   `admitted → blocked` and commits that decision.
5. `advanceConfig` with `causedBy {actor: 'action', actionId}`: value, version + 1, the
   `config_versions` row with before/after digests. `flush_cache_namespace` changes no
   configuration.
6. result receipt, `Authorization(stage 'commit')`, `admitted → committed` (CAS on status and
   fence), a `mission.evaluate` outbox hint, events. `pg_notify('nemodots_source_changed')` is
   delivered at COMMIT.

Predicates, in precedence order: stored binding (policy version, strict payload, value domain,
adapter, target, capability, server-derived required sources present in the vector, payload
hash), expiry (10 minutes), mission running and generation, target version equals
`expectedTargetVersion` (`stale_version`), the live value digest equals
`expectedCurrentValueDigest` (`target_version_mismatch`), then the whole supporting vector through
the ledger's `assertCurrent`: every receipt `supported`, every controlled receipt at the live
version, every observed receipt not superseded, and the policy's `maxAgeMs` against
`lastConfirmedAt` (`evidence_too_old`).

## Freshness: what is and is not guaranteed

- **Controlled sources** (`checkout.config/<key>`, the membership collection) are compared with the
  live version under row locks at admission and again at commit. A receipt for an old version is
  non-current from the moment the authority advances, before any watcher runs.
- **Observed sources** (health, metrics, Redis stats, ...) have ledger-assigned revisions. A change
  the watcher has not observed cannot be detected. The property is **freshness at admission**:
  `lastConfirmedAt >= now - maxAgeMs` (policy-v1: 120 000 ms for `checkout.health` and
  `redis.stats`), evaluated with the database clock at admission and again at commit. The exact
  window in which a commit may rest on an observed fact that is no longer true is therefore
  `maxAgeMs` (since the last confirmation) **plus the commit latency** (admission to commit,
  bounded by the 10 minute intent expiry and the dispatcher lease). An observation superseded by a
  newer one is refused immediately (`stale_version`) whenever the ledger knows of it; the invalidation
  closure also blocks live intents and records an Authorization for it.
- **The Redis effect** is evaluated at **freshness at dispatch** for the controlled authority only:
  `claimDispatch` is a compare-and-set on `status = 'committed'` AND the live
  `cache.namespace` version equal to the version committed (C11); a moved authority fails the intent
  (`failed(dispatch_fence_invalid)`), and so does a cancelled mission or an expired intent. Observed
  evidence (`redis.stats`) is not re-read at dispatch: its age is bounded by `maxAgeMs` at commit and
  by the intent expiry (10 minutes after proposal) at dispatch.
- The **Redis fence orders flushes among themselves only** (`<prefix>:fence:cache.namespace`, the
  committed version of the last applied flush). It is never consulted to decide whether a change is
  permitted: that is PostgreSQL's job. The Lua script returns `fence_newer` (no deletion) only
  when the stored fence is strictly newer than the version the flush was committed at.
- Nothing outside the enumerated toolset is covered, and uninstrumented remote effects (a cache
  flush by someone else, a change of an observed source nobody observed) are outside the guarantee.
  `tests/nemodots/integration/actions/limits.test.ts` documents this.

## The external effect and its recovery

`flush_cache_namespace` is committed in PostgreSQL first, then dispatched:

0. The dispatcher reads (creating it with `SET NX` if needed) the **Redis epoch**, `<prefix>:epoch`: an
   id for the state of the Redis instance. Redis unreachable here means nothing was attempted: the
   intent stays `committed`.
1. `claimDispatch` (above) in one statement: a new fence and lease **and the attempt itself**
   (`effect_attempted_at`, `redis_epoch`, write-once), recording `Authorization(stage 'dispatch')`. The
   claim is refused while another dispatcher's lease is live (it is the lease holder's work) and is
   never granted twice: a committed flush that already has an attempt is not claimed again.
2. One Lua script in Redis: epoch differs from the claim's -> `epoch_changed` (tombstone, nothing
   deleted); `SET <prefix>:effect:<actionId> NX` **first** (present -> `already_applied`, nothing else
   touched); strictly newer fence -> `fence_newer`; else `SCAN`/`UNLINK` the namespace and set the fence.
   The marker's final value says what happened (`applied:<fence>:<n>` or `fence_newer:<fence>`), so a
   refused flush is never mistaken for an applied one.
3. `committed -> dispatched -> verified` after a separate `GET` of the marker (the delete count is never
   proof), or `failed(dispatch_fence_invalid)` for `fence_newer`, `failed(effect_not_applied)` for
   `epoch_changed`, or `outcome_unknown` if the call threw or timed out. Every record statement carries the
   dispatch fence **and an unexpired dispatcher lease**: a dispatcher whose lease lapsed during the script
   records nothing, and the intent is settled by reconcile.

### No second effect without a new authorization: the durability assumption

The guarantee does **not** rest on Redis remembering anything. The local stack runs Redis without
persistence (`--save '' --appendonly no`), so a restart loses every marker and fence. The attempt is
therefore recorded in PostgreSQL before the script runs, and:

- A dispatcher that died after the script leaves a `committed` intent with an attempt. The next
  dispatcher (after the lease lapsed) does **not** call the script: `claimDispatch` moves the intent to
  `outcome_unknown` and `process()` reconciles it. If the marker survived: `applied` -> `verified` (deleted
  count from the marker). If Redis restarted: the marker is gone and nothing is re-run.
- `reconcile` reads the marker and never re-runs the effect. With no marker and an attempt recorded it
  decides in this order: (1) a stored result receipt says the script answered `applied` -> `verified`
  (durable evidence is never overridden by a missing volatile marker; the receipt says
  `markerPresent: false`); (2) the Redis epoch equals the one recorded with the claim, so the instance did
  not restart and an atomic script that left no marker never ran -> a tombstone is written with `SET NX`
  in the same Lua call that checks the epoch (a late script call is inert), then `failed(effect_not_applied)`;
  (3) the epoch changed (restart, flush of Redis) -> absence proves nothing: the intent stays
  `outcome_unknown` (finding `epoch_changed`) for an operator and a new intent. Re-dispatch always needs a
  new authorization. Past the marker horizon (7 days) reconcile does not conclude.
- Limit: the epoch detects a lost Redis, not a single deleted or evicted key. Run Redis with
  `maxmemory-policy noeviction` and do not delete `<prefix>:effect:*` or `<prefix>:epoch` by hand. If only
  the marker of a script that did run is deleted and no receipt recorded the script's answer, reconcile
  would report `effect_not_applied` although it ran. Making the stack's Redis durable (AOF with
  `appendfsync always`) removes this residual case; it is a stack setting outside this package.
- `outcome_unknown` flushes that reconcile cannot conclude are re-examined by every `sweep` (oldest
  first, `limit` 50 per call); more than 50 stuck intents would starve newer unsettled work until an
  operator closes them.

## set_config verification and compensation

`set_config`'s effect is the row update itself: `committed` already means applied. Verification arrives from
the watcher walking `checkout.config_versions`; for each history row with a `caused_by_action_id` it calls
`settleFromHistory(actionId, outcome)` (`ActionService.settleFromHistory`, or `createSelfWriteSettler(deps)`),
which re-reads the history row (it must exist and carry the digest the commit recorded), moves
`committed → verified` (postcondition kind `history`) or `failed(postcondition_mismatch |
superseded_before_verification)`, and calls `deps.recovery.onSelfWriteSettled`. Repeats are idempotent.

`compensate(actionId, {supportingReceiptIds})` builds a new `set_config` intent restoring the value before the
action. It is refused when the target version moved since the action, for a flush (irreversible, never shown as
undone), for an intent that is not committed, and for a second reversal. The new intent goes through the same
admission and commit.

## Wiring (composition root)

```ts
const actions = createActionService({ pool: appPool, redis, redisPrefix, dispatchLeaseMs, recovery });
createCoordinator({ ..., intents: createIntentReader(), actions: actions.coordinatorPort(workerId) });
// the watcher: actions.settleFromHistory(actionId, outcome)
// coordinator maintenance (every tick): actions.sweep(workerId)
```

`actions.coordinatorPort().admit` runs the whole pipeline (admit, commit, dispatch), because the outbox message
`action.proposed` is delivered at least once and every step is a compare-and-set. `sweep` recovers what a crash
left behind (expired admission leases, undispatched flushes, unsettled effects); it must be called from the
coordinator's maintenance step.

## Cancellation and pause

| What                                         | Behaviour                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| queued intents (`proposed`, `admitted`)      | cancel bumps the mission generation (the coordinator waits for in-flight commits through the mission `FOR SHARE` lock), then `cancelQueued(missionId, generation)` marks them `cancelled`. A late commit finds `cancelled` and writes nothing.                                               |
| committed effects                            | stay in history and in the `config_versions` log; `IntentReader.committedEffects` lists them (a `set_config` once its commit receipt exists, a flush while its effect is committed, in flight or applied) and the coordinator records them in `Mission.cancellation.committedEffects`.       |
| an in-flight external request (`dispatched`) | is not aborted: the intent keeps its true status (`dispatched`, `outcome_unknown`, then `verified` or `failed`); nothing is shown as undone.                                                                                                                                                 |
| a `committed` flush not yet dispatched       | after a cancel (generation moved) `claimDispatch` fails it (`failed(dispatch_fence_invalid)`, `Authorization(dispatch, blocked, generation_mismatch)`); while the mission is paused it stays `committed` and is dispatched after resume.                                                     |
| dispatcher leases                            | short (`NEMODOTS_DISPATCH_LEASE_MS`), never held across waits; an expired lease makes the old dispatcher's commit fail and lets any dispatcher re-admit. While a lease is live no other dispatcher can claim the flush, and after it lapses the flush is settled by reconcile, never re-run. |
| a paused mission                             | admission and commit are `blocked(mission_not_running)`: queued work stops. The blocked intent is terminal; the team proposes again after resume with fresh evidence.                                                                                                                        |

Statuses other than `running` (including `awaiting_acceptance`) block admission and commit. The coordinator must therefore not
move a mission to `awaiting_acceptance` while an intent it cares about is still `proposed`, `admitted` or `committed`.

## Test hooks (for the concurrency adversary)

`import { setBarrier, SimulatedCrash } from '.../actions/index.js'` with `NEMODOTS_TEST_HOOKS=1`:

| Barrier                        | Reached                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `after_preliminary_read`       | after the non-locking read, before BEGIN (admit, commit, dispatch, reconcile)     |
| `before_lock`                  | inside the transaction, before the intent row lock (admit, commit, claimDispatch) |
| `after_lock_before_commit`     | commit: every lock held, every state row written, before the events and COMMIT    |
| `after_commit_before_dispatch` | after the commit transaction returned                                             |
| `after_effect_before_record`   | after the Lua script returned, before its outcome is recorded                     |

A handler may await a latch (park) or throw `SimulatedCrash`, which every catch in this package rethrows untouched.
Registering a handler without `NEMODOTS_TEST_HOOKS=1` throws. Never set it in a run labelled live.

## Known limits

- `policy-v1` validates only the shape of the flush namespace (`^[a-z0-9-]{1,32}$`), not that it is the active one.
- A compensation is initiated by trusted server code, not by a model; it reuses the original intent's attempt,
  task and emitting call as lineage and carries `compensates_action_id`. Its Authorization records the original
  author's token as the author fence, which was validated when the original was proposed.
- The application role could, by writing the `nemodots.authz_by_writer` setting, suppress the closure-block
  Authorization trigger. The application role is trusted code (finding I14).
