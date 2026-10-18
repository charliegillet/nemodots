# actions: the controlled action boundary

`propose -> admit -> commit -> dispatch -> reconcile`, plus `reclaim`,
`settleFromHistory` and `compensate`. ARCHITECTURE sections 4-5 and CONTRACTS
section 5 are the specification; this file states what the code guarantees and
what it does not.

## What is guaranteed (G1)

A `set_config` commits only inside ONE PostgreSQL transaction that

1. locks the intent row `FOR UPDATE` (a stored result receipt short-circuits:
   duplicate deliveries write nothing and return the original receipt, C2),
2. checks the dispatch fence and the unexpired dispatcher lease
   (`DispatchFenceError` otherwise, nothing written),
3. share-locks the mission and checks status and generation,
4. locks the controlled rows `FOR UPDATE` (collection first, members in key
   order) and then the ledger rows (`SupportValidator.assertCurrent`, lock mode
   `update`),
5. re-runs EVERY admission predicate: policy version, expiry, capability,
   payload binding and domain, required sources, the FULL dependency vector
   (status, recorded version = live version, freshness), the target version and
   the value digest the proposal assumed,
6. writes the mutation through `advanceConfig` (the single writer of
   `config_entries`, `causedBy {actor: 'action', actionId}`), the
   `config_versions` row with before/after digests, the result receipt, the
   commit authorization, the outbox row and the events.

Admission runs the same predicates earlier (`FOR SHARE`) and durably claims the
dispatch lease. Between admission and commit the predicates may become false;
the commit detects that. Lock order everywhere: coordinator rows (intent,
mission) -> controlled config rows -> ledger rows, the order the ledger's
closure also follows (`ledger/prelock.ts`).

The author fence is checked once, inside the proposal transaction. The
dispatch fence is a separate lifecycle: a completed author's proposal remains
valid for dispatch, an expired author cannot propose, an expired dispatcher
cannot commit.

Idempotency keys come from the tool call id and are bound to a payload hash
(action + strict payload + citations). Same key + same hash returns the stored
intent; same key + different hash is `blocked(idempotency_conflict)`. Only LIVE
intents reserve a key (partial unique index), so a blocked intent never stops a
fresh proposal from a new tool call.

## Windows and residual races (stated, not hidden)

- **Observed sources: freshness-at-admission, not currency.** health, metrics,
  redis.stats, orders and inventory have ledger-assigned revisions. A change
  the watcher has not observed cannot be detected. The commit requires the
  receipt to be `supported` and its last confirmation to be younger than the
  policy `maxAgeMs` (120 s for `checkout.health` and `redis.stats`) AT COMMIT
  TIME. The exact window in which an unobserved change can slip through is
  `maxAgeMs` plus the commit latency, bounded further by the poll interval of
  the watcher (a changed digest supersedes the receipt and blocks immediately
  through the closure).
- **Controlled sources are immediate (G3).** A version advanced without a
  receipt fails closed as `stale_pending_observation`; after the replacement is
  registered the same race reports `stale_version`. Both are blocks.
- **The Redis effect is freshness-at-dispatch.** `claimDispatch` re-checks that
  `cache.namespace` is still at the committed version inside a transaction and
  then the transaction ends: no PostgreSQL lock is held across the Redis call.
  A change to `cache.namespace` after the claim and before the Lua script runs
  is not detected by PostgreSQL. What the effect boundary does enforce: the
  per-action marker (no second effect without a new authorization) and the
  namespace fence in Redis (an obsolete flush, one whose committed version is
  strictly older than a flush that already ran, returns `fence_newer`).
  The Redis fence orders flushes among themselves ONLY; it is not an authority
  and does not observe config writes.
- **A lost response is `outcome_unknown`**, never success. `reconcile` reads the
  marker back: a dispatch fence value means the effect ran exactly once
  (`verified`), `fence_newer` means it was refused, absence means it did not
  run (`failed(effect_not_applied)`, re-dispatchable only through a new
  authorization). `reconcile` never re-runs the effect. A `committed` intent
  with no marker is left alone: it is simply not dispatched yet.
- **Marker expiry.** The effect marker has a TTL (`effectHorizonSec`, default 7
  days). Reconciling after it expired reads "absent" and would settle a real
  effect as `effect_not_applied`; reconcile within the horizon.
- **Compensation** exists for `set_config` only, refuses when the target
  version moved, and is itself an intent that must pass G1. A flush is never
  shown as undone.
- The proposal's `expectedTargetVersion` is read from the receipt the model
  saw; a receipt pointing at an older version is rejected by the commit, not
  repaired.

## Test hooks

`NEMODOTS_TEST_HOOKS=1` enables `setHook(name, handler)` at
`after_preliminary_read`, `before_lock`, `after_lock_before_commit` (parks
INSIDE the commit transaction by design), `after_commit_before_dispatch` and
`after_effect_before_record`. Without the variable `setHook` throws and `hook()`
is a no-op. Throwing from a hook simulates a crash at that boundary.

## Wiring

`createActions({ pool (nemodots_app), validator (ledger createSupportValidator),
events (createEventSink), redis | null, redisPrefix, dispatchLeaseMs })`.
`propose`/`admit`/`commit`/`dispatch`/`reconcile`/`cancelQueued` implement
`ActionAdmissionPort`; `intents` is the coordinator's `IntentReader`. The
outbox topics `action.proposed` (admission, scheduled by the coordinator) and
`action.dispatch` (flush commits) are enqueued here; a handler for
`action.dispatch` calls `dispatch(actionId, fence)` and belongs to the
composition root. `settleFromHistory` is what the watcher's history walk
calls for every `config_versions` row with a `caused_by_action_id`.
