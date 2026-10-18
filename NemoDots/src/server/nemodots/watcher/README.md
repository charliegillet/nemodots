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

**Hard requirement for system-bootstrap.** `recovery.onSelfWriteSettled` must
settle the intent (`actions.settleFromHistory`, which then tells the
coordinator). Wiring it to `coordinator.onSelfWriteSettled` alone leaves the
intent `committed` forever. The watcher does not trust the call: after every
`onSelfWriteSettled` it re-reads the intent through `IntentSettlementPort`, and
an intent that is still `committed` is reported as an `error` event
(`where: 'onSelfWriteSettled'`, once per action and process) and is not counted
as settled. The port must also be idempotent per action: the watcher calls it
from the history walk, and again from the settlement sweep if a call failed or a
tool registered the revision first. `tests/nemodots/integration/watcher/real-settle.test.ts`
runs the real actions admit / commit / settleFromHistory path against the
watcher, and pins both the right and the wrong wiring.

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

The head receipt is registered (and its event delivered) **before** the intents
are settled. Settling first would let the coordinator schedule a postcondition
task against a head the ledger does not hold yet. A crash between the COMMIT and
the settle calls is repaired by `sweepSettlements`, which settles every
committed intent whose history row is at or below the ledger's newest revision
(the same path covers a tool that registered the revision first); the settlement
is idempotent per action.

### Observed samples are not allowed to go backwards

The ledger orders observed revisions by arrival, not by `observedAt`. An observed
source is read first and registered later, so a tool or probe can register (or
confirm) a LATER reading in between. The registration transaction therefore
checks, under the sources row lock it already holds, that the receipt it
superseded was not observed (or confirmed) after the watcher's sample was
taken. If it was, the transaction is rolled back (receipt, marks and event
included), `stale_sample_discarded` is emitted, and the source is read again (at
most 3 times, then the outcome is `rejected`). The guard covers only the
watcher's own registrations: a tool or probe registration that carries an older
sample than the head would still win. Closing that needs a ledger rule (refuse or
turn into a confirmation an observed registration whose `observedAt` is earlier
than the head's observation or last confirmation); it is reported as a ledger
dependency.

### Known limits (owned outside the watcher)

- **Acting lineage.** ARCHITECTURE 5.4 says a verified self-write does not
  invalidate the acting lineage (proposing attempt, its task, ancestors). The
  ledger closure marks the proposer like any other reader of the old receipt, and
  the coordinator then also schedules a replan for a proposing root task. The
  watcher passes `selfWrite` and `causedByActionId` correctly; the exclusion has
  to be made in the ledger closure or the coordinator (resolve the action id to
  its attempt, task and ancestors). `self-write.test.ts` states the expected
  behaviour with `it.fails` so it cannot be mistaken for a pass.
- **Postcondition when a foreign write landed last (C7, `selfWrite: none`).**
  `RecoveryPort.onSelfWriteSettled('verified')` always schedules a postcondition
  task in the coordinator. For an action whose row is not the last one the head is
  `none` (full invalidation) and that task is not what 5.4 calls for. It costs
  one extra model-backed verification, never an unsafe commit. The fix is in the
  coordinator: `onSelfWriteSettled` should only settle and re-evaluate, and leave
  postcondition scheduling to the `selfWrite == 'verified'` gate in
  `processInvalidation`. Also pinned with `it.fails`.

## Closure cap (finding C14)

On `ClosureCapExceeded` the watcher reads the coarse set, pauses the missions
that cite the old receipt, then registers the receipt without a closure in a
fresh transaction. The ledger records the coarse event (`closure_cap_exceeded`,
`closure.capped`) and marks the coarse set like a real closure.

The coarse set is every running attempt (with its task) and live intent of those
missions, plus whatever a walk of the evidence/inheritance edges from the old
receipt reaches inside them, `COARSE_WALK_DEPTH` (3) hops deep: attempts that
already published, their outputs, model calls, intents and tasks. A task is
listed as `preserved` only if nothing of it was reached. **Known limit:** a
dependent more than three hops from the receipt is not named in the coarse event
(the real closure is what exceeded the cap, so it cannot be walked in full). The
missions are paused, and G1/G2 refuse any publication or commit that cites the
superseded receipt, so such a dependent can be repaired but never trusted.

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
