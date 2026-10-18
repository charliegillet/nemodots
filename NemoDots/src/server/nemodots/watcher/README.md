# Source watcher

The normal path from "the world changed" to receipts, confirmations and
invalidations (ARCHITECTURE sections 5.2, 5.4 and 9.4). It is **not** the
correctness gate: G1/G2 compare recorded versions under lock on every commit
and publication, so a late or missing watcher delays recovery but never makes
stale evidence usable. The watcher therefore prefers exactness over speed: it
registers only what it read from the authority through `SourceReaderPort`, never
infers a value, and lets the ledger re-check every controlled value against the
authority row under `FOR SHARE`.

## Wiring (composition root)

```ts
const watcher = createWatcher({
  pool, // nemodots_app
  readers: createSourceReaders({ pg: pool, ... }),
  recovery: {
    onInvalidation: (e) => coordinator.onInvalidation(e),
    onSelfWriteSettled: (id, outcome) => actions.settleFromHistory(id, outcome), // then coordinator recovery
    pauseMission: (id) => coordinator.control.pause(id), // closure-cap path (C14)
  },
  intents: createSqlIntentSettlement({ pool }), // read-only view of action_intents
  config: { ownerId, environment, intervalMs: env.watchIntervalMs },
});
await watcher.start(); // LISTEN nemodots_source_changed + poll
const ownerEdit = createOwnerEdit({ pool, watcher });
```

`onSelfWriteSettled` must be idempotent per action: the watcher calls it from the
history walk, and again from the settlement sweep if a call failed or a tool
registered the revision first.

## What a poll does

| Step         | Controlled sources (`checkout.config`, `checkout.config/<key>`)                                                                          | Observed sources (health, metrics, orders.recent, redis.stats, followed `checkout.inventory/<sku>`)                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Decide       | authority version above the ledger's newest receipt revision                                                                             | every poll                                                                                                               |
| Read         | `SourceReaderPort.read` (outside any transaction)                                                                                        | same                                                                                                                     |
| Classify     | history walk of `config_versions` rows `r+1..r+n` (`self-write.ts`)                                                                      | none                                                                                                                     |
| Register     | `registerObservation`, revision = authority version; a lost race re-reads (at most 3 times), `stale_observation_rejected` is logged once | `registerObservation`: same normalized digest becomes a `receipt_confirmations` row, a new digest a new revision (I2/D2) |
| After COMMIT | `RecoveryPort.onInvalidation(event)`                                                                                                     | same                                                                                                                     |
| Removed key  | the member's receipt is retracted (`source_removed`), dependents are invalidated                                                         |                                                                                                                          |

A NOTIFY on `nemodots_source_changed` runs the controlled part for the named key
(and the collection when the membership changed) without waiting for the next
poll. A malformed payload only triggers a full controlled sync.

## Self-writes (finding C7)

`self-write.ts` reads the history, not the head: every row with a
`caused_by_action_id` settles that intent (`after_digest` equals the digest of
the intent's value: `verified`, otherwise `failed`), and the receipt carries the
classification of the LAST row (`verified`, `mismatch`, or `none` when an
injector/owner write came last, the history has a gap, or the action id is
unknown). The database nulls `caused_by_action_id` for every role except
`nemodots_app`, so the marker cannot be forged. The actor column is never read.

Intents are settled **before** the receipt is registered: a crash in between is
repaired by the next poll (the walk repeats, settlement is idempotent), whereas
settling afterwards would lose the rows the ledger had already moved past.
`sweepSettlements` additionally settles committed intents whose row is at or
below the ledger's newest revision (a tool registered the revision first).

## Closure cap (finding C14)

On `ClosureCapExceeded` the watcher reads the coarse set (every running attempt,
its task, every live intent of the missions that cite the old receipt), pauses
those missions, then registers the receipt without a closure in a fresh
transaction. The ledger records the coarse event (`closure_cap_exceeded`,
`closure.capped`) and marks the coarse set like a real closure.

## Redelivery

An `InvalidationEvent` is committed with the receipt and delivered afterwards.
`redeliverPending` hands ledger events that name an existing mission with no
coordinator copy to `onInvalidation` again, so a crash or a failed delivery does
not leave a mission unable to settle.

## Single instance

`scheduler.ts` holds one PostgreSQL session per watcher: `pg_try_advisory_lock`
and `LISTEN` share its lifetime. A second instance is a standby (no LISTEN, no
poll) and takes over within one interval after the leader stops or its session
dies.

## Source types

The ledger refuses one source key with two types, so every writer must agree.
`observedSourceType()` is the single table: HTTP views of the checkout
(`checkout.health`, `checkout.metrics`, `checkout.inventory/<sku>`) are
`observed_endpoint`; datastore views (`checkout.orders.recent`, `redis.stats`)
are `observed_store`. The watcher prefers the type already stored in the ledger.

## Reserved mission id

Receipts are shared across missions, but the ledger stores a mission id on every
receipt and the contract requires a v4 UUID. Receipts registered by the watcher
carry `WATCHER_MISSION_ID` (`00000000-0000-4000-8000-00000000a1c7`).
