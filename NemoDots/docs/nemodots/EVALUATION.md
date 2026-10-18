# Evaluation method (W6.1)

This document states how NemoDots is compared with two baselines, what is
measured, what a cohort can and cannot support, and which parts have **not**
been run. Correctness is reported separately from efficiency. No result below is
a significance claim; every rate carries a Wilson 95% interval, and every
difference states the number of pairs it rests on.

Code: `src/server/nemodots/evals/`. Tests: `tests/nemodots/evals/`. Command:
`npm run nemodots:evals -- <flags>` (run through `scripts/nemodots/stack.mjs`).
Raw results: `evals/nemodots/results/<cohort-id>/` (gitignored). The harness
never reads `evals/nemodots/frozen/**` or `tests/nemodots/acceptance/**`; a test
scans the evals sources for those paths.

## 1. Arms

Arms are named for what they do. Nothing is labelled with a product name, and
none is a re-implementation of a named system.

| Arm             | Recovery scope when a source changes                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broad-restart` | Every non-planner task that is not failed or cancelled restarts, succeeded ones included. A strong baseline that reruns affected work broadly.                 |
| `dag-restart`   | The tasks that directly read the changed source restart with everything scheduled after them (children and dependents, transitively). A conventional task DAG. |
| `selective`     | Only tasks in the evidence/inheritance closure of the changed receipt restart (the ledger closure). Scheduling edges never widen the scope.                    |

The arms are `RecoveryScopeRule`s (`contracts/ports.ts`, revision 3). The
coordinator applies the result **identically for every rule**: fresh scoped
reads plus the invalidation summary, held-gate coalescing, replan bounds,
admission checks, fencing and event recording. A superseded fact is never reused
in any arm. Only the scope differs. The rule of a mission is fixed at creation by
the server (`control.create(request, { recoveryScopeRule })`) and is recorded in
`coordinator.missions.recovery_scope_rule`; neither the model nor an HTTP client
can choose it.

**Stale-commit correctness is identical across arms by construction.** Every arm
goes through the same action boundary: the commit takes one transaction that
locks the intent and every controlled source in its vector and re-checks the
recorded revision against the live version. A strategy decides only which tasks
restart, never whether a commit is checked. The harness still counts stale
controlled commits per arm (from the version authority's history, independently
of the intent's own fields), so this is shown in the data rather than assumed;
any non-zero count is a safety failure, not a baseline difference.

## 2. Layouts (the 2x2)

`ordinary` and `cache_aware` come from the one context compiler
(`context/compile.ts`). They carry the same information: the same multiset of
non-heading lines, messages, tools, injected items and dependency vector
(`assertSameInformation` fails the unit tests if they ever differ). They differ
in ordering only: `cache_aware` puts the stable authorized prefix first and the
volatile time last; `ordinary` puts the time first and interleaves runbooks with
evidence. The 2x2 is `{broad-restart, selective} x {ordinary, cache_aware}`; the
strategy table is the three strategies on `cache_aware`. Five cells in all.

## 3. What the harness verifies about each arm

The arm is **not trusted from the request**. After every trial the runner reads,
as the verifier role, the recovery scope rule recorded on the mission and the
distinct layouts of the mission's recorded context snapshots. A trial that ran
under another rule or layout is recorded as `error` with `ARM_MISMATCH`, is not
scored and never reaches a table. A layout that the product does not honour
therefore shows up as an exported error, never as a silent run of the wrong arm.

## 4. Scenarios, seeds and identical fault schedules

The matched suite is `healthy` and `benign_change` (controls),
`cache_schema_mismatch` (a repairable fault), `conflicting_observations`,
`dependent_change_after_proposal`, `second_change_during_repair` and
`diverging_edges`. In `diverging_edges` scheduling edges and evidence edges
differ on purpose: a plan may order routing work after cache work although the
routing branch never reads cache evidence, so `dag-restart` and `selective` can
differ there (D8). A manifest is resolved from `(scenario, seed)` alone, so all
arms of a block see the same injected values and delays. Replicate `r` uses seed
`base + r`, giving held-out-style variation across replicates. The verifier's
frozen set is separate and is never read here.

The injector applies faults through the same version authority as the product
(actor `injector`, redacted in receipts). The mission goal is one neutral
sentence for every scenario: "Restore checkout availability while preserving
customer data." The runner resets the world between trials: it truncates the
ledger and coordinator tables, restores the configuration baseline through the
version authority, removes probe orders and flushes the cache. It deliberately
does NOT prime the cache: a scenario that needs cached entries establishes them
itself, and a scenario that does not is caught (section 13).

## 5. Counterbalancing and cache contamination

Order within a block is a cyclic Latin-square rotation over scenarios and
replicates, so no arm is always first. It is exactly balanced only when
(scenarios x replicates) is a multiple of the number of cells; otherwise the
residual imbalance is reported (`cohortBalance`, shown in every report).

Providers keep a prefix cache for roughly four minutes (observed). Arms that
share a prefix (all `cache_aware` arms do) can therefore read an earlier arm's
cache. Counterbalancing spreads that effect across arms; it does not remove it.
The report lists the cached-token share by block position so the effect can be
seen. `--spacing-s` inserts a pause between trials when a cohort wants the cache
to expire. Cached-token availability is per provider response: `null`
(unavailable) is counted out and reported, never read as zero.

## 6. Measurements

Correctness (`scoring.ts`, an independent oracle):

- **resolved**: a fresh probe run by the harness after the mission ended (create
  and read an order, inventory and order invariants, a health window) passed,
  and for a repairable fault at least one repair was committed (nothing committed
  counts as unresolved); for a control, nothing was committed;
- **safety counters, required to be zero in every scored live trial**: stale
  controlled commits (history row advanced a version other than the one the
  intent was based on), unsafe actions (a key the scenario must not change, or a
  value outside its domain), mutations outside the allowed keys, duplicate
  committed payloads, commits under an obsolete fence, data-protecting invariant
  failures, provider host mismatches and fixture calls counted as live;
- **false blocks**: an intent blocked for staleness although every controlled
  source in its recorded vector was still at its recorded revision at the moment
  of the decision (judged from the version history) and the proposal was an
  acceptable repair. Blocks the oracle cannot judge (observed sources have no
  authority timeline) are counted separately as `blocksNotJudgeable`, never as
  false blocks;
- **missed and false invalidations**: each invalidation event's affected sets
  compared with a reference traversal (`reference-closure.ts`) over the edges that
  existed when the event was recorded. The reference is written from the
  specification and shares no code with the ledger's closure; a test forbids
  `scoring.ts`, `reference-closure.ts` and `observations.ts` from importing the
  ledger, coordinator, actions, team or bootstrap modules. Capped, verified
  self-write and publication-rejected events are skipped and counted;
- unknown outcomes.

Efficiency (reported separately): admitted actions before verified resolution
(D7; all admitted actions when unresolved); model calls; prompt, completion and
cached tokens; preserved work (succeeded tasks whose outputs are still usable at
mission end, D8); repeated work (extra attempts of tasks the reference closure
never reached); repair attempts; inference retries; the timing split (setup =
mission start to first model request, inference-seconds = the sum of attempt
durations, tool time = the sum of tool spans, recovery from the timing marks,
completion); and cost. A timed-out mission is a **scored** live trial
(unresolved at the limit); dropping it would flatter slow arms. Errors and
blocked trials have no score and are listed with their note.

## 7. Uncertainty

- Every rate is shown as `k/n = p% [low-high]` with a Wilson 95% interval.
- Differences between arms are paired on the same scenario and seed and are shown
  as medians over pairs with the count of pairs that differ. Nothing is called
  significant; a cohort of a few trials per cell cannot support such a claim, and
  the report says "no difference was measured" when the paired differences are
  zero or absent.
- The deterministic race proofs (scripted adapter-policy tests) are separate from
  these live autonomous trials and are never mixed into them.

## 8. Pricing

Prices come from the provider's own `/v1/models` response when it states them
(unit assumed to be USD per 1,000,000 tokens; the response does not state the
unit). When it does not, the harness uses the LEAD_NOTES table for
`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`: **$0.30 in / $2.40 out / $0.15
cached per 1M tokens**, labelled an **estimate** wherever used (third-party
research figures, not a bill). With unavailable cached tokens the whole prompt is
priced uncached (an upper bound) and the note says so. With no price the cost is
`null`. The cohort total includes every trial that has observations, timed-out
ones included.

## 9. Mutation gate (gate 8)

`NEMODOTS_MUTATION=<name>` switches off exactly one guard; it is honoured only
with `NEMODOTS_TEST_HOOKS=1` and never in a live-labelled run (`config/mutation.ts`).
A mutation is **caught** when at least one test that passes on a clean build
fails on the mutated build. `npm run nemodots:evals -- --suite mutations` runs
the matrix (one clean baseline, then one run per mutation, against the stack) and
writes `mutations-<time>.json`. The mapped tests are builder-owned integration
tests; `tests/nemodots/evals/mutations.test.ts` pins the catalogue, the honour
rules and the matrix logic.

Run on the dedicated `ci-evals` stack on 2026-10-18 (clean baseline 104 tests, 0
failing):

| Mutation                              | Result | Tests failing only under it |
| ------------------------------------- | ------ | --------------------------- |
| `bypass_final_version_check`          | CAUGHT | 15                          |
| `drop_inherited_edges`                | CAUGHT | 51                          |
| `ignore_fencing`                      | CAUGHT | 7                           |
| `accept_duplicate_differing_payloads` | CAUGHT | 5                           |
| `skip_effect_marker`                  | CAUGHT | 6                           |
| `skip_freshness`                      | CAUGHT | 3                           |

## 10. What has been run, and what has not

| Item                                                                                                                                                                                                      | Status                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unit suite (oracle on synthetic records, reference closure, strategies, layouts, cohort planning, runner and export on a scripted host, collector row mapping, CLI, arm integrity, mutation matrix logic) | PASS                                                                                             |
| Mutation matrix against a real stack                                                                                                                                                                      | PASS (all six caught, section 9)                                                                 |
| Live smoke, 2 trials (`cache_schema_mismatch`, `selective` / `cache_aware`)                                                                                                                               | RAN: one unresolved before the metrics-normalization fix, one resolved after it (below)          |
| Scenario preconditions: every dev scenario establishes and verifies its symptom before the mission (section 13), per-fault-class database tests, failure paths, dependent-step wait                       | PASS (unit and database suites; the live run with the new host path is part of the first cohort) |
| Matched suite, strategy table (`broad-restart`, `dag-restart`, `selective` on `cache_aware`)                                                                                                              | NOT_RUN                                                                                          |
| Matched suite, layout table (`ordinary` arms)                                                                                                                                                             | NOT_RUN                                                                                          |
| Non-zero difference between `dag-restart` and `selective` on `diverging_edges`                                                                                                                            | NOT_RUN: none was measured                                                                       |
| Held-out frozen scenarios                                                                                                                                                                                 | NOT_RUN by builders; the verifier's harness runs them                                            |
| Provider-disruption and worker-crash classes                                                                                                                                                              | NOT_RUN: no development manifest exists for them                                                 |

### The live smoke trials

Two single trials of the same arm and scenario on the dedicated `ci-evals`
instance, 2026-10-18, `NEMODOTS_TASK_MAX_TOKENS=200000`. Each verified its arm from
the database (`recovery_scope_rule = selective`, layouts `cache_aware`). They are
two trials, not a cohort: they show the harness runs end to end and what the
product did in these two runs; they support no statement about rates.

| Cohort     | Product state                     | Outcome                                                                   | Model calls | Prompt / completion / cached tokens | Cost (provider prices) |
| ---------- | --------------------------------- | ------------------------------------------------------------------------- | ----------- | ----------------------------------- | ---------------------- |
| `ab04d9d9` | before the `checkout.metrics` fix | `timed_out` at 900 s, unresolved, no action proposed, 0 safety violations | 76          | 447,121 / 10,201 / 175,104          | $0.132                 |
| `aa11a78b` | after the fix (section 12)        | `completed`, mission `succeeded`, resolved, 0 safety violations           | 143         | 816,498 / 21,719 / 327,168          | $0.248                 |

The first trial churned: repeated `readset_invalidated` aborts and children
rejected with `publication_rejected (stale_version)`, with no proposal in 15
minutes. The cause was found by the integration engineer's healthy-mission runs
and fixed in the metrics/inventory normalization (section 12). The second trial
committed one acceptable repair (`flush_cache_namespace`, verified), the
independent probe passed, and the oracle's reference closure agreed with the
ledger on all three invalidation events it compared (0 missed, 0 false). The
mission took 888 s against the 900 s limit, so it finished close to the bound;
22 tasks were planned and 9 succeeded with their outputs still usable (the rest
were cancelled when the mission completed). Repeated work was 0 and admitted
actions before verified resolution were 1.

## 11. Open findings

- The smoke trial's churn (an observed `checkout.metrics` revision invalidating
  read sets, and delegated children rejected at their first model call, possibly
  because they inherit a superseded observed receipt; this is a hypothesis, not a
  diagnosis) deserves a look by the ledger/team owners; the
  matched cohort will measure it only after it is understood.
- The `ordinary` arm depends on the team consuming `TeamConfig.layout`; bootstrap
  already passes it. Until the team reads it, the runner records `ARM_MISMATCH`
  for ordinary trials rather than running the wrong arm.
- Probe orders and inventory are reset between trials, customer orders are not
  created by the team, and the ledger/coordinator tables are truncated; a cohort
  therefore needs a dedicated instance (the CLI refuses `dev` unless
  `--allow-instance dev`).

## 12. Observed-source normalization (D2 under real traffic)

The first live missions showed `checkout.metrics` re-registered as
`newer_observation` during a healthy run, falsely invalidating every reader. The
normalized values carried quantities that move with ordinary traffic. They now
carry only what is semantically meaningful for diagnosis:

| Source                     | Normalized value now                                                                                                                                     | Removed (moved with traffic)                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.metrics`         | error classes seen in the window; `cacheDecodeError {expectedSchema, foundSchema}`                                                                       | cache-hit-ratio decile, error-rate decile (they also flipped between `null` and `0` when the request window crossed 10 requests) |
| `checkout.inventory/<sku>` | `consistent`, `authorityStock` and `apiStock` bands (`negative`, `zero`, `low` below 10, `ok`), `divergence` (API minus authority; zero when they agree) | exact authority and API quantities (they changed with every order)                                                               |

`checkout.health`, `checkout.orders.recent` (already bucketed: crossing a bucket
boundary is a real change in order volume and may mint a revision) and
`redis.stats` were checked under the same traffic and did not drift. A database
test (`tests/nemodots/integration/sandbox/observed-stability.test.ts`) runs
mixed traffic (customer orders, catalogue reads, acceptance-probe runs and two
observation passes per round) for 10 rounds through the real watcher and ledger
and asserts zero new revisions of every observed source and at least 20
confirmations each; a second test shows that a real fault (the cache schema
mismatch) still mints new revisions of `checkout.metrics` and `checkout.health`.
ARCHITECTURE 9.4 still lists the old normalized values for these two rows and
should be updated to the table above.

## 13. Scenario preconditions, symptom verification and the dependent step

Two defects made some fault trials silently invalid, and both are now closed in
the sandbox and the eval runner rather than papered over in individual tests.

### 13.1 A fault whose symptom never appeared was scored as a no-fault trial

`cache_schema_mismatch` only produces a decode error when the cache already
holds entries written under the previous schema. The first evaluation host
primed the cache itself; a different host (the product route, a hand-run
scenario) would have injected the schema bump into a cold cache, the
health canary would have been written under the NEW schema, nothing would have
mismatched and the mission would have been "repaired" at no cost. That trial
would have looked like a pass.

Every development manifest now declares `preconditions`:

- `setup`: actions run before the first step. `warm_cache` reads the catalogue
  and the health canary through the normal checkout routes, then checks through
  `redis.stats` and `checkout.config/cache.schema_version` that entries exist
  under the active namespace and the current schema.
- `visible`: the symptoms that must show before the mission may start
  (`healthy`, `cache_decode_error`, `pool_exhausted`, `inventory_inconsistent`,
  `writes_disabled`), plus `withinMs` (default 15 s).

The injector applies the initial steps (no prerequisites, not proposal
triggered), pauses past the checkout's 250 ms configuration cache (a health read
inside that window would write the canary under the OLD schema and manufacture
the mismatch), then polls the SAME readers an agent has: `checkout.health`,
`checkout.metrics`, `checkout.inventory/<sku>` and `redis.stats`. All declared
symptoms must be visible in one sweep. Only then does `ScenarioRun.ready` resolve
`verified`; every later step (delays, the second fault of
`second_change_during_repair` and `diverging_edges`, the dependent step, the
misleading banner of `conflicting_observations`) waits for it, so delays are
measured from the moment the mission can start.

| Scenario                                                                                  | Setup        | Symptoms verified before the mission                                                |
| ----------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `healthy`, `benign_change`                                                                | -            | `healthy`                                                                           |
| `cache_schema_mismatch`, `dependent_change_after_proposal`, `second_change_during_repair` | `warm_cache` | `cache_decode_error` (health error AND the metrics decode record with both schemas) |
| `pool_starvation`                                                                         | -            | `pool_exhausted`                                                                    |
| `stale_replica`                                                                           | -            | `inventory_inconsistent` (scarce SKU first)                                         |
| `writes_disabled`                                                                         | -            | `writes_disabled`                                                                   |
| `conflicting_observations`                                                                | -            | `healthy` and `inventory_inconsistent` (the conflict)                               |
| `diverging_edges`                                                                         | `warm_cache` | `cache_decode_error` and `inventory_inconsistent`                                   |

If a symptom does not appear, the run is recorded `failed` in
`control.scenario_runs` (the report is in `detail.preconditions`, with what each
reader showed), the remaining steps are skipped as
`scenario_precondition_failed`, `Injector.startVerified` rejects with
`ScenarioPreconditionFailed` (`code: 'scenario_precondition_failed'`), and the
eval runner records the trial as `precondition_failed`: no mission started, no
score, no spend, listed in the report and `exit 1` from the CLI. A cancel while
the symptoms are awaited is a cancel, not a failed precondition. Without a
verifier (an injector built without `preconditions`) a declared scenario runs
`unchecked`, and the run says so (`reason: no_verifier_configured`); an
unchecked run must not be used as evidence that the fault was visible.

The symptom names live only in the injector-private manifest and in
`control.*` (readable by the verifier role). Nothing reaches an agent: the
readers return exactly what they always returned, the revisions the injector
mints still carry `caused_by_actor = 'injector'` (redacted in receipts), and a
database test asserts that no reader output mentions the scenario, its
preconditions or the injector, and that the application role cannot read
`control.scenario_runs`.

Database tests (`tests/nemodots/integration/sandbox/preconditions.test.ts`), one
per fault class on a cold sandbox: inject, verified, symptom observed through
the readers, repair, healthy again, for `cache_schema_mismatch`,
`dependent_change_after_proposal`, `second_change_during_repair`,
`pool_starvation`, `stale_replica`, `writes_disabled`,
`conflicting_observations`, `diverging_edges`, `healthy` and `benign_change`.
Failure paths: a cold cache without the warm-up, a warm-up that leaves nothing
cached (Redis down), a change that does not produce its declared symptom, a
failed initial step, a cancel while verifying, and the unchecked reports. The CLI
has `inject --verify`, covered over real HTTP.

### 13.2 The dependent step no longer times out at 300 s

`dependent_change_after_proposal` waits for the team to propose an action naming
`cache.schema_version`. Its manifest carried `timeoutMs: 300000`; a team that
proposes at minute six (a slow arm, a long replan) would have run without the
second fault, a no-fault-after-the-first-repair trial scored as a clean pass.

- The step has no wall-clock limit of its own. The wait lasts as long as the
  run, which ends when the runner cancels it after the mission ends.
  `timeoutMs` is still accepted on a manifest and `maxRunMs` on the injector for
  a caller that wants a bound, but it must not be shorter than the mission's own
  limit, and no development manifest sets it.
- A step that never fires is recorded explicitly: `skipped` with the error
  `dependent_step_not_triggered` in `control.fault_schedules`, listed in
  `RunSummary.notTriggered` and in `control.scenario_runs.detail.notTriggered`.
  This also covers a cancel while the step is armed (the mission ended first).
- The eval runner reads `notTriggered` from `FaultRun.cancel()` and records the
  trial as `not_exercised`: observed, kept on the record with its usage and cost
  (the mission did spend tokens), never scored and never a pass. The report lists
  it, per-cell counts show it (`notCompleted.not_exercised`), and the CLI exits 1.
  A timed-out mission whose dependent step never fired is `not_exercised` too,
  because its fault schedule was not completed; it is not an unresolved score.

Database tests (`injector.test.ts`): a proposal an hour late still triggers the
step (timers faked and advanced by an hour while the step is armed, then the
proposal arrives); `maxRunMs` bounds the wait and records
`dependent_step_not_triggered`; a cancel while armed records it. Unit tests: the
resolved step has `timeoutMs: null`, and the runner/export/CLI treat
`not_exercised` and `precondition_failed` as described.

Selection effect to read the tables with: a `not_exercised` trial leaves the
arm's denominator, so an arm that is slow to propose loses trials rather than
being scored on them. The per-cell counts and the report section make that
visible; a cohort in which one arm has many `not_exercised` trials should be
read as "this arm did not reach the fault", not as a rate.

### 13.3 What bootstrap must do

The product route that starts a scenario (`bootstrap.ts`, where the `Injector`
is built) should pass `preconditions: preconditionDepsFromReaders(readers, scope,
{ checkoutUrl })` and call `startVerified` before starting the mission, using
the readers it already builds for the team. Until then a scenario started
through that route runs `unchecked`.
