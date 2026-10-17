# Frozen held-out scenarios (gate 6) — verifier only

Owner: the independent verifier. Version `frozen-v1`, frozen 2026-10-17. The SHA-256 of every file here is recorded in `docs/nemodots/ACCEPTANCE_CONTRACT.md` and `tests/nemodots/acceptance/oracle/MANIFEST.sha256`; `tests/nemodots/acceptance/integrity/frozen-integrity.test.ts` fails if any byte changes.

## Access rule (builders must enforce)

**Runtime agents and their tools must never be able to read this directory.** That covers the Nemotron planner and workers, every tool in `src/server/nemodots/team/tools.ts`, the context compiler, runbooks (`read_runbook` resolves through the catalogue map only), routes under `/api/nemodots`, the SSE stream, the mission UI, OpenDots Dot tools for incident Dots (page/file/MCP/skill paths), and the builder evaluation code under `src/server/nemodots/evals/**` and `evals/nemodots/scenarios/**`.

Concretely:

- No production module may import, `readFile`, glob, serve or embed any path under `evals/nemodots/frozen/`. The injector may receive a manifest **object or path from the verifier harness at run time**; it must not know this location.
- No value, trial id or seed from these files may appear in `src/**`, `evals/nemodots/scenarios/**`, runbooks, prompts, fixtures, receipts, SSE payloads or model context. `tests/nemodots/acceptance/integrity/isolation.test.ts` scans for the distinctive string values and trial ids.
- `control.*` rows written while running these trials stay readable by `nemodots_verifier` only.
- Builders do not read these files, even to "check compatibility". If the injector needs a format change, report it to the lead as a dependency; the verifier translates.

## Layout

| File                                                    | Content                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                                         | version, the single neutral mission goal and constraints used for every trial, defaults, step-trigger semantics, class index |
| `thresholds.json`                                       | safety metrics (all must be 0 in every trial), usefulness rates, bounded-recovery limits, provider retry policy, timing      |
| `scenarios/healthy-control.json`                        | 3 trials, no fault                                                                                                           |
| `scenarios/benign-unrelated-change.json`                | 3 trials, banner-only owner changes                                                                                          |
| `scenarios/repairable-checkout-fault.json`              | 6 trials across F1-F5 with held-out values and timings                                                                       |
| `scenarios/dependent-change-after-proposed-repair.json` | 3 trials, NOTIFY-triggered change of the proposed key (`admissionMinAgeMs` 3000)                                             |
| `scenarios/second-change-during-repair.json`            | 3 trials, a second change after the first commit/admission/proposal                                                          |
| `scenarios/conflicting-observations.json`               | 3 trials, flapping or disagreeing evidence                                                                                   |
| `scenarios/provider-disruption.json`                    | 4 trials through a verifier-owned pass-through proxy (503, 429, connection reset, long outage)                               |
| `scenarios/worker-crash.json`                           | 3 trials, SIGKILL of `worker-main` at three points with restart delays                                                       |

## How a trial runs (verifier harness)

1. Fresh instance (`NEMODOTS_INSTANCE=acc-<trialId>`), migrate, seed, read the pre-trial config with the verifier role.
2. Snapshot the business hash `H` (oracle `checkout-invariants.ts`), start the read-only load generator.
3. Apply `pre_start` steps through the injector, create the mission with the manifest goal and constraints only, start it, apply timed and triggered steps.
4. Observe: SSE events, `GET /missions/:id`, PostgreSQL with the verifier role, Redis read-back, checkout HTTP.
5. At mission end (or `trialMaxWallClockMs`), run the verifier's own probe order and health window; score every predicate; export the raw trial.

The goal text never names the fault, the key, the value or the class. Mission `mode` must be `live`; fixture trials are refused.

## Revisions

A change here is a new version (`frozen-v2`) with a written before/after rationale in `ACCEPTANCE_CONTRACT.md`, reviewed by someone other than the author, and new hashes. Lowering a threshold or swapping a fault for an easier one to get green is forbidden.
