# NemoDots deterministic acceptance oracle (frozen v1)

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
- **R6** v1 does not represent independent sufficient support. Closures are conservative, and CL-3 is labelled `conservative: true` so no report calls this exact reasoning.
- **R7** Controlled revisions in `ledger.ts` are relative (`relRevision`, `claimRevision`, `configVersionDelta`): `0` is the authority version right after the case's `seed_config` ops. Observed revisions are absolute and ledger-assigned from 1. Source keys in `final` are written `<environment>:<sourceKey>`. The labels of a `register_concurrent` op must both resolve to the receipt that is current afterwards.
- **R8** `anyOf` lists alternative fail-closed behaviours the contract permits (for example "the server adds the mandatory health receipt" versus `blocked(missing_required_source)`). Every alternative is strict, and none permits the guarded value to be committed.
- **R9** Every admission/commit test checks three things together: the intent status and Authorization rows, the authority version and value in `checkout.config_entries`, and the `config_versions`/`result_receipts` rows.

## How the driver uses it

`../driver/entry-points.ts` lists the production entry points each case needs. A missing module or export fails the case with `ENTRY POINT MISSING`. Once the entry points exist, the verifier binds the driver to their signatures; until then the case fails with `DRIVER WIRING PENDING`. Binding the driver never edits an expectation here. Symbolic ids (`A1`, `I`, `r1`) are mapped to the real UUIDs the driver creates.

## Revisions

A correction is a new oracle version with a written before/after rationale in `docs/nemodots/ACCEPTANCE_CONTRACT.md` section 9, reviewed by someone other than its author, and new hashes. Weakening an expectation to make an implementation pass is forbidden.
