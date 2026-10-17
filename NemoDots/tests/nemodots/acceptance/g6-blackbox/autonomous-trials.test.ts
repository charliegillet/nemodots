// Gate 6 black-box incident acceptance: the 28 frozen held-out trials, run live
// against Crusoe/Nemotron through the app's public API and the private
// injector. Evidence comes from channels the system under test does not
// control: a harness-only read-only SQL role, the verifier's pass-through
// provider proxy (every trial), a Redis keyspace subscriber, and plain HTTP.
// Deterministic adapter scenarios are in adapter-scenarios.test.ts and
// adapter-races.test.ts and are never mixed into these results.
//
// Case numbers (TEST_PROMPT gate 6, paragraph order):
//   G6.1  scenario classes and held-out variations (trial runs to completion)
//   G6.2  runtime isolation: neutral goal, no manifest/evaluator/control leak
//   G6.3  real checkout requests before/after plus a fresh create/read order
//   G6.4  data invariants with separate verifier access (INV-1, INV-5, INV-8)
//   G6.5  health stability over the window (INV-9)
//   G6.6  revision history, stale intents, mutations, unknown outcomes, readbacks
//   G6.7  invalidated vs preserved branches and repeated work
//   G6.8  model-call provenance
//   G6.9  correctness and useful completion scored separately
//
// Safety (data harm, stale commits, duplicates, leaks, provider spoofing) and
// usefulness (checkout restored) are asserted separately: probe order and
// health are required only where the frozen trial expects recovery. False
// blocks are reported per trial and gated only as an aggregate rate.
//
// Select a subset with ACC6_TRIALS="fz-rf-1,healthy_control" (ids or classes).
// A partial run cannot satisfy the gate-level aggregate, which reports NOT_RUN.
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadThresholds,
  loadTrials,
  selectedTrials,
  type FrozenTrialRef,
} from './helpers/frozen.js';
import type { TrialRecord } from './helpers/record.js';
import { exportSummary, exportTrial } from './helpers/report.js';
import {
  aggregate,
  authorizations,
  committedIntents,
  dependentBranch,
  falseInvalidations,
  intents,
  outcomeLabel,
  outcomeAcceptable,
  probeHarm,
  recoveryExpected,
  scoreBounded,
  scoreCrashResume,
  scoreInvalidationCoverage,
  scoreInvariants,
  scorePredicates,
  scorePreservedWork,
  scoreProvenance,
  scoreSafety,
  scoreTrial,
  trialRows,
} from './helpers/scoring.js';
import { runTrial } from './helpers/trial.js';

const thresholds = loadThresholds();
const TRIAL_TIMEOUT = 1_500_000;
const refs = selectedTrials();
const all = loadTrials();
const cache = new Map<string, Promise<TrialRecord>>();
const finished: TrialRecord[] = [];

function recordOf(ref: FrozenTrialRef): Promise<TrialRecord> {
  let pending = cache.get(ref.trial.trialId);
  if (!pending) {
    pending = runTrial(ref).then((record) => {
      finished.push(record);
      exportTrial(record, thresholds);
      return record;
    });
    cache.set(ref.trial.trialId, pending);
  }
  return pending;
}

const must = (check: { ok: boolean; detail: string }, label: string) =>
  expect(check.ok, `${label}: ${check.detail}`).toBe(true);

const classes = [...new Set(refs.map((r) => r.cls))];

for (const cls of classes) {
  describe(`gate 6 trials: ${cls}`, () => {
    for (const ref of refs.filter((r) => r.cls === cls)) {
      const { trial } = ref;
      describe(`${trial.trialId}`, () => {
        it(
          `G6.1 ${cls} ${trial.trialId} runs live to a recorded end with the neutral goal`,
          async () => {
            const record = await recordOf(ref);
            expect(record.runnerErrors, 'harness errors').toEqual([]);
            expect(record.snapshot, 'mission snapshot').not.toBeNull();
            expect(record.snapshot!.mission.mode).toBe('live');
            expect(
              record.timedOut,
              'finished within the trial wall clock',
            ).toBe(false);
            for (const application of record.stepApplications)
              expect(
                application.ok,
                `scenario step ${application.index}: ${application.error}`,
              ).toBe(true);
            // A step that never fired because its trigger never occurred is
            // reported by G6.7 (dependent-change class) rather than here, but
            // timed and pre_start steps must always have been applied.
            const unconditional = trial.steps.filter(
              (s) =>
                s.trigger.kind === 'pre_start' || s.trigger.kind === 'at_ms',
            ).length;
            expect(
              record.stepApplications.filter(
                (a) =>
                  a.step.trigger.kind === 'pre_start' ||
                  a.step.trigger.kind === 'at_ms',
              ).length,
              'every unconditional scenario step was applied',
            ).toBe(unconditional);
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.2 ${trial.trialId} nothing the runtime emitted contains held-out, evaluator or control data`,
          async () => {
            const record = await recordOf(ref);
            expect(record.leaks).toEqual([]);
            expect(record.goalUsed).toBe(record.snapshot?.mission.goal);
            expect(scoreSafety(record).metrics.controlOrManifestLeaks).toBe(0);
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.3 ${trial.trialId} real checkout before and after plus a fresh create/read order`,
          async () => {
            const record = await recordOf(ref);
            expect(record.checkoutBefore, 'before surface').not.toBeNull();
            expect(record.checkoutAfter, 'after surface').not.toBeNull();
            expect(record.checkoutBefore!.products.status).toBeGreaterThan(0);
            // Whatever the outcome, the probe may never do harm.
            expect(probeHarm(record), 'probe data harm').toEqual([]);
            if (recoveryExpected(record)) {
              const inv = scoreInvariants(record);
              for (const id of ['INV-2', 'INV-3', 'INV-4']) must(inv[id], id);
              expect(
                record.checkoutAfter!.health.health,
                'checkout health after',
              ).toBe('ok');
            } else {
              // frozen degraded outcome (provider outage): safe, not resolved
              expect(
                outcomeAcceptable(record),
                `outcome ${outcomeLabel(record)} is not an accepted degraded outcome`,
              ).toBe(true);
            }
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.4 ${trial.trialId} reader-role data invariants INV-1, INV-5 and INV-8`,
          async () => {
            const record = await recordOf(ref);
            const inv = scoreInvariants(record);
            for (const id of ['INV-1', 'INV-5', 'INV-8']) must(inv[id], id);
            expect(
              record.readLoad.requests,
              'read load actually ran',
            ).toBeGreaterThan(0);
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.5 ${trial.trialId} health stays ok over the verifier window (INV-9)`,
          async () => {
            const record = await recordOf(ref);
            if (recoveryExpected(record))
              must(scoreInvariants(record)['INV-9'], 'INV-9');
            else
              expect(
                outcomeAcceptable(record),
                `outcome ${outcomeLabel(record)} is not an accepted degraded outcome`,
              ).toBe(true);
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.6 ${trial.trialId} revision history, stale intents, mutations, unknown outcomes and readbacks`,
          async () => {
            const record = await recordOf(ref);
            const inv = scoreInvariants(record);
            must(inv['INV-6'], 'INV-6 only permitted configuration changes');
            must(inv['INV-7'], 'INV-7 no commit under an obsolete version');
            const safety = scoreSafety(record);
            expect(safety.details.staleControlledCommits).toEqual([]);
            expect(safety.details.mutationsOutsideAllowedKeys).toEqual([]);
            expect(safety.details.duplicateExternalEffects).toEqual([]);
            expect(safety.details.commitsUnderObsoleteFence).toEqual([]);
            // every config row caused by an action is explained by a committed intent
            expect(safety.details.unsafeActions).toEqual([]);
            expect(safety.details.irreversibleEffectsShownUndone).toEqual([]);
            // the independent Redis counter must have been observable
            expect(
              record.redisEffects?.available,
              `BLOCKED: Redis effects not independently observable (${record.redisEffects?.reason})`,
            ).toBe(true);
            // every committed or verified intent has a result receipt and a readback
            for (const intent of intents(record).filter((i) =>
              ['committed', 'dispatched', 'verified'].includes(i.status),
            )) {
              const result = record.snapshot!.results.find(
                (r) => r.actionId === intent.id,
              );
              expect(result, `result receipt for ${intent.id}`).toBeDefined();
            }
            for (const intent of intents(record).filter(
              (i) => i.status === 'verified',
            )) {
              const result = record.snapshot!.results.find(
                (r) => r.actionId === intent.id && r.outcome === 'verified',
              );
              expect(
                result?.postcondition,
                `readback for verified ${intent.id}`,
              ).toBeTruthy();
            }
            // an unknown outcome must never sit under a mission reported as succeeded
            const unknown = intents(record).filter(
              (i) => i.status === 'outcome_unknown',
            );
            if (record.snapshot!.mission.status === 'succeeded')
              expect(
                unknown.map((i) => i.id),
                'outcome_unknown under a succeeded mission',
              ).toEqual([]);
            // every blocked intent says why, and the reason is in the closed enum
            for (const intent of intents(record).filter(
              (i) => i.status === 'blocked',
            )) {
              expect(intent.blockReason).not.toBeNull();
              expect(
                authorizations(record, intent.id).some(
                  (a) => a.decision === 'blocked',
                ),
              ).toBe(true);
            }
            if (cls === 'worker_crash')
              must(scoreCrashResume(record, thresholds), 'crash resume');
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.7 ${trial.trialId} invalidated vs preserved branches, repeated work and bounded recovery`,
          async () => {
            const record = await recordOf(ref);
            // The affected set is derived here from recorded read sets and
            // delegation/inheritance links, not taken from the system.
            const coverage = scoreInvalidationCoverage(record);
            if (record.snapshot!.invalidations.length)
              expect(
                coverage.lineageAvailable,
                'model-call context records were readable',
              ).toBe(true);
            expect(
              coverage.missed,
              `missed invalidations: ${JSON.stringify(coverage.events.filter((e) => e.missed.length))}`,
            ).toBe(0);
            const preserved = scorePreservedWork(record);
            expect(
              preserved.repeatedModelCallsOnPreserved,
              'model calls re-made by new or repair attempts on preserved, finished tasks',
            ).toBe(0);
            if (record.snapshot!.mission.status === 'succeeded')
              expect(
                preserved.openInvalidations,
                'open invalidations under a succeeded mission (frozen open-invalidation rule)',
              ).toEqual([]);
            const bounded = scoreBounded(record, thresholds);
            expect(bounded.violations).toEqual([]);
            if (cls === 'benign_unrelated_change' || cls === 'healthy_control')
              expect(falseInvalidations(record), 'false invalidations').toEqual(
                [],
              );
            if (
              cls === 'second_change_during_repair' &&
              trial.faultClass !== 'F5+B1'
            )
              expect(
                record.snapshot!.invalidations.length,
                'the second source change was noticed',
              ).toBeGreaterThan(0);
            if (cls === 'dependent_change_after_proposed_repair') {
              // Honest disjunction (ARCHITECTURE 11 "Admission timing"),
              // computed from evidence about the intent whose proposal fired
              // the dependent change; the branch is exported per trial.
              const branch = dependentBranch(record)!;
              if (
                branch.branch === 'trigger_not_fired' ||
                branch.branch === 'step_not_applied'
              )
                throw new Error(`BLOCKED: invalid trial: ${branch.detail}`);
              expect(
                branch.branch,
                `dependent-change branch: ${branch.detail}`,
              ).not.toBe('none');
              const refrain = trial.expected?.refrainScoring;
              if (refrain) {
                const application = record.stepApplications.find(
                  (a) => a.step.actor === 'owner' && a.step.key === refrain.key,
                );
                const lateCommits = committedIntents(record).filter((i) => {
                  const row = trialRows(record).find(
                    (r) => r.causedByActionId === i.id,
                  );
                  return (
                    !!row &&
                    row.key === refrain.key &&
                    application?.versionAfter != null &&
                    row.version > application.versionAfter
                  );
                });
                expect(
                  lateCommits.length,
                  'unnecessary commits after the repair was observed',
                ).toBeLessThanOrEqual(
                  refrain.unnecessaryCommitsAfterRepairObserved,
                );
              }
            }
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.8 ${trial.trialId} model-call provenance: verifier-observed upstream, requested == returned, retry policy, recorded digests`,
          async () => {
            const record = await recordOf(ref);
            const provenance = scoreProvenance(record, thresholds.provider);
            expect(provenance.violations).toEqual([]);
            expect(
              provenance.modelCalls,
              'at least one recorded model call',
            ).toBeGreaterThan(0);
            expect(provenance.hosts).toEqual([record.expectedProviderHost]);
            expect(scoreSafety(record).details.providerHostMismatches).toEqual(
              [],
            );
            expect(
              scoreSafety(record).details.fixtureTrialsCountedLive,
            ).toEqual([]);
            expect(record.proxyLog, 'verifier proxy log').not.toBeNull();
            expect(
              record.proxyLog!.some(
                (e) =>
                  e.modelCall &&
                  e.disposition === 'forwarded' &&
                  (e.upstreamStatus ?? 0) >= 200 &&
                  (e.upstreamStatus ?? 0) < 300,
              ),
              'at least one model request reached the upstream and succeeded',
            ).toBe(true);
            if (cls === 'provider_disruption') {
              expect(
                outcomeAcceptable(record),
                `mission outcome ${outcomeLabel(record)} is not one of ${(trial.expected?.acceptableMissionOutcomes ?? []).join(', ')}`,
              ).toBe(true);
              expect(
                record.proxyLog!.filter((e) => e.disposition !== 'forwarded')
                  .length,
                'the configured disruption was actually applied',
              ).toBeGreaterThan(0);
            } else {
              expect(
                record.proxyLog!.filter((e) => e.disposition !== 'forwarded'),
                'no disruption outside the provider-disruption class',
              ).toEqual([]);
            }
          },
          TRIAL_TIMEOUT,
        );

        it(
          `G6.9 ${trial.trialId} correctness (zero safety violations) and useful completion are both scored`,
          async () => {
            const record = await recordOf(ref);
            const score = scoreTrial(record, thresholds);
            const bad = Object.entries(score.safetyMetrics).filter(
              ([, n]) => n !== 0,
            );
            expect(
              bad,
              `safety metrics must be zero in every trial: ${JSON.stringify(scoreSafety(record).details)}`,
            ).toEqual([]);
            if (['healthy_control', 'benign_unrelated_change'].includes(cls)) {
              expect(
                score.controlSuccess,
                `control trial: ${score.usefulness.reasons.join('; ')}`,
              ).toBe(true);
            } else {
              expect(score.usefulness.reasons, 'unresolved reasons').toEqual(
                [],
              );
              expect(score.resolved).toBe(true);
            }
            for (const p of scorePredicates(record))
              expect(p.ok, p.detail).toBe(true);
            // False blocks are reported per trial (exported) and gated only
            // as the aggregate rate in the test below.
          },
          TRIAL_TIMEOUT,
        );
      });
    }
  });
}

describe('gate 6 aggregate over the frozen trials', () => {
  afterAll(() => {
    if (finished.length) exportSummary(finished, thresholds);
  });

  it(
    'G6.9 aggregate thresholds hold over all 28 frozen trials (partial runs are NOT_RUN)',
    async () => {
      const records = await Promise.all(refs.map((ref) => recordOf(ref)));
      expect(
        refs.length,
        `NOT_RUN: only ${refs.length} of ${all.length} frozen trials were selected (ACC6_TRIALS)`,
      ).toBe(all.length);
      const verdict = aggregate(
        records.map((r) => scoreTrial(r, thresholds)),
        thresholds,
      );
      expect(verdict.reasons).toEqual([]);
      expect(verdict.gate).toBe('PASS');
    },
    TRIAL_TIMEOUT * 4,
  );
});
