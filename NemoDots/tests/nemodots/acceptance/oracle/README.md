# NemoDots deterministic acceptance oracle (frozen, oracle-v3)

Owner: the independent verifier. Frozen 2026-10-17, before wave 4. The SHA-256 of every file is in `MANIFEST.sha256` and in `docs/nemodots/ACCEPTANCE_CONTRACT.md`; `../integrity/frozen-integrity.test.ts` fails on any change.

## Independence

- Derived from `CONTRACTS.md` (revision 2), `ARCHITECTURE.md` (revision 2), `TEST_PROMPT.md` and `LEAD_NOTES.md` only.
- Imports nothing from `src/**`. Enums and value domains are transcribed by hand in `spec-enums.ts`.
- Every expected closure was enumerated by hand from the drawn graph. `../integrity/oracle-selfcheck.test.ts` recomputes it with a reference traversal written in the test (not production code) and fails on disagreement.
- Config values here are test-local values the driver seeds into a fresh `nemodots_test_*` database. They are not the sandbox baseline, which lives only in `sandbox/seed.ts`.

## Files

| File                     | Content                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec-enums.ts`          | closed enums, `LIVE_STATUSES`, config value domains, caps and freshness windows                                                                                                                                                                                                                                                                                               |
| `types.ts`               | the data shapes below                                                                                                                                                                                                                                                                                                                                                         |
| `closures.ts`            | `CLOSURE_CASES` (linear chain, diamond one-arm and shared-root, multiple parents, cross-mission partition, simultaneous invalidations, negative/collection evidence, B1 benign change, diverging edges, cross-environment, terminal intents), `REJECTION_CASES` (plan/delegate cycles, edge cycle, depth and node caps), `SELF_WRITE_CASES` (verified, mismatch, interleaved) |
| `ledger.ts`              | `LEDGER_CASES`: immutability, revision/digest tampering, oversize/malformed, cross-environment, supersession, late delivery, ABA, confirmations, freshness, concurrent registration, contested/retracted/expired, model claims, page edits, G3 staleness before the watcher, membership collection                                                                            |
| `admission.ts`           | `SETUP_CONFIG`, `ADMISSION_CASES` covering TEST_PROMPT gate 2 items 1-16 plus findings C2-C5, C10, C11, I2, I8 and one documented outside-the-guarantee case; `LEASE_CASES`                                                                                                                                                                                                   |
| `checkout-invariants.ts` | business hash H definition and invariants INV-1..INV-9 for the read-only phase, one fresh probe order, the repair phase and the health window                                                                                                                                                                                                                                 |

## Rules the oracle encodes

- **R1** Closure = nodes reachable from the superseded receipt over `evidence` and `inheritance` edges. `scheduling` edges never propagate.
- **R2** A task is affected iff one of its attempts is affected.
- **R3** Preserved tasks of a mission = its tasks minus affected tasks.
- **R4** Affected intents in `proposed | admitted` end `blocked(stale_version)`. Intents in other statuses keep their status.
- **R5** One `invalidation_events` row per changed receipt. A mission with no affected node gets no `invalidation.recorded` event.
- **R7** (oracle-v3) One replan per invalidation event per mission. A replan held behind a postcondition (`replan_coalesced`) and its single release (`replan_scheduled`, after it) count as one replan. A second `replan_scheduled` or `replan_coalesced` for the same event and mission is a planning storm, and it is a defect.
- **R6** v1 does not represent independent sufficient support. Closures are conservative, and CL-3 is labelled `conservative: true` so no report calls this exact reasoning.
- **R7** Controlled revisions in `ledger.ts` are relative (`relRevision`, `claimRevision`, `configVersionDelta`): `0` is the authority version right after the case's `seed_config` ops. Observed revisions are absolute and ledger-assigned from 1. Source keys in `final` are written `<environment>:<sourceKey>`. The labels of a `register_concurrent` op must both resolve to the receipt that is current afterwards.
- **R8** `anyOf` lists alternative fail-closed behaviours the contract permits (for example "the server adds the mandatory health receipt" versus `blocked(missing_required_source)`). Every alternative is strict, and none permits the guarded value to be committed.
- **R9** Every admission/commit test checks three things together: the intent status and Authorization rows, the authority version and value in `checkout.config_entries`, and the `config_versions`/`result_receipts` rows.

## How the driver uses it

`../driver/entry-points.ts` lists the production entry points each case needs. A missing module or export fails the case with `ENTRY POINT MISSING`. Once the entry points exist, the verifier binds the driver to their signatures; until then the case fails with `DRIVER WIRING PENDING`. Binding the driver never edits an expectation here. Symbolic ids (`A1`, `I`, `r1`) are mapped to the real UUIDs the driver creates.

## Revisions

A correction is a new oracle version with a written before/after rationale in `docs/nemodots/ACCEPTANCE_CONTRACT.md` section 9, reviewed by someone other than its author, and new hashes. Weakening an expectation to make an implementation pass is forbidden.

### oracle-v2 (acceptance-v2, 2026-10-18)

The verifier authored it. It was reviewed independently by the concurrency adversary (`docs/nemodots/review/CONCURRENCY_REVIEW.md`) and approved by the lead. Only `admission.ts` changed. No other case and no threshold changed, and the held-out manifest stays `frozen-v1`.

- **ADM-03b.**
  - Before: I `blocked(stale_version)`, with a commit-stage Authorization `blocked(stale_version)`.
  - After: both `stale_pending_observation`.
  - Rationale: the injector's change is never registered, so the target receipt is still `supported` and records the old version. `assertCurrent` runs before the target-version check (`actions/predicates.ts:256` before `:270`), and `judge` returns `stale_pending_observation` whenever live > recorded (`ledger/support.ts:80-85`). `stale_version` cannot be reached in this state: versions only increase, and the commit's CAS fallback (`actions/commit.ts:160`) cannot fire while the row is held FOR UPDATE. This is the G3 fail-closed code for an unregistered replacement. The case still checks refusal under lock with no mutation, and exactly one code is pinned (no "accept either").
- **ADM-08.**
  - Before: register a change to IA's key, then park IA's commit at `after_lock_before_commit` while IB commits. Expected IA `blocked(stale_version)`, IB committed, `actionRows` 1, `nonBlockingWithinMs` 2000.
  - After: no change to IA's premise. IA's commit is parked at `after_lock_before_commit` holding its rows, and IB (another key) commits during the park. Expected IA and IB both committed (admission and commit Authorization rows), `routing.inventory_source` +1 = `primary`, `orders.write_enabled` +1 = `true`, `actionRows` 2, `resultReceipts` 2, `nonBlockingWithinMs` 2000.
  - Rationale: the v1 step could not be reached. Registration blocks IA through the closure (ARCH 5.2 step 4). Committing a blocked intent returns the stored decision at `actions/commit.ts:79-80`, without an Authorization. `after_lock_before_commit` (`actions/commit.ts:214`) sits only on the success path, after the outbox enqueue. So IA never parks, and IB never commits while IA holds its locks. An unregistered variant fails the same way, through `block()` (`commit.ts:118-144`). The revised step tests the case's property directly: a parked commit on one resource never delays another. "IA blocked" stays an unhooked, unnamed test (G2-08a).

### oracle-v3 (acceptance-v3, 2026-10-18)

The verifier authored it. The lead approved it, including the ruling that a verified self-write gates the replan (CONTRACTS.md "Revision 3 (replan coalescing)"). The concurrency adversary reviewed it independently against the code and CONFIRMED this version, after rejecting an earlier draft that froze an ungated replan into SW-1. Changed files: `closures.ts` (SW-1..SW-3), `spec-enums.ts` (`RECOVERY_KIND` gains `replan_coalesced`), `types.ts` (two optional SW fields) and this README (R7). The held-out manifest stays `frozen-v1`.

- **SW-1** (verified self-write).
  - Before: `recoveryKinds` `postcondition_scheduled`, `repair_coalesced`.
  - After: during the gate, `postcondition_scheduled`, `repair_coalesced`, `replan_coalesced`, with no immediate `replan_scheduled`. New fields: `replansReleasedAfterPostcondition: 1`, so exactly one `replan_scheduled` for the held replan's event once the postcondition settles; and `replanTriggerTaskIds: ['T_other']`, so the unrelated root is the only invalidated root of that event and the acting lineage (T_parent, T_act) is excused.
- **SW-2, SW-3.**
  - Before: `recoveryKinds` `repair_scheduled`.
  - After: `repair_scheduled`, `replan_scheduled`.
- **Rationale:**
  - Every SW case invalidates a root task: T_other in all three, and T_parent in SW-2 and SW-3.
  - ARCHITECTURE line 310: the planner is re-invoked when a root task is invalidated. Production: `coordinator/recovery.ts` root trigger, then `scheduleReplan`.
  - `scheduleReplan` records nothing without a succeeded planner or when `replanCap` is reached (`recovery.ts:405-406` in the tree at this freeze; the adversary cited `:398-399` in the revision it reviewed). The v2 values therefore held only in a mission without a planner, which the product never runs.
  - For a verified self-write, `scheduleReplan` holds the replan when the event has a postcondition gate (`kind: gateTaskId !== null ? 'replan_coalesced' : 'replan_scheduled'`, `recovery.ts:427`). `releaseGate` (`recovery.ts:570`, called from `coordinator/publish.ts:214` when the postcondition publishes) releases it as one `replan_scheduled` with the same `invalidationEventId`.
  - The acting lineage, including its delegation ancestors, is excused from the closure (`ledger/lineage.ts`), so it cannot be the trigger.
- **Tests (not frozen):** the g2 harness seeds a succeeded planner under `replanCap` for every mission (self-check H-8). `withWorld(..., { planner: false })` keeps the no-replan path tested (G2-16h).
- Nothing is loosened: routing decisions are added and none are removed.
