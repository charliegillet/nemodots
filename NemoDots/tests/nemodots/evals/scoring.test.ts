// The oracle on synthetic observations of a hand-built diverging_edges mission
// (fixtures.ts). Every expectation below was enumerated by hand from the graph.
import { describe, expect, it } from 'vitest';
import {
  loadScenario,
  resolveScenario,
} from '../../../src/server/nemodots/sandbox/manifest.js';
import {
  scoreCorrectness,
  scoreEfficiency,
  scoreTrial,
} from '../../../src/server/nemodots/evals/scoring.js';
import { referenceClosure } from '../../../src/server/nemodots/evals/reference-closure.js';
import {
  CACHE_EVENT,
  EDGES,
  MISSION,
  NODES,
  at,
  baseObservations,
  intent,
  manifest,
  steps,
} from './fixtures.js';

const correct = (
  mutate: (o: ReturnType<typeof baseObservations>) => void = () => {},
) => {
  const obs = baseObservations();
  mutate(obs);
  return scoreCorrectness(manifest(), steps(), obs);
};

describe('reference closure (independent traversal)', () => {
  it('a change of the cache receipt reaches exactly the cache branch and its verifier', () => {
    const closure = referenceClosure(EDGES, NODES, 'R-cache', {
      missionId: MISSION,
    });
    expect(closure.attemptIds).toEqual(['A-cache', 'A-verify']);
    expect(closure.outputIds).toEqual(['O-cache', 'O-verify']);
    expect(closure.taskIds).toEqual(['cache', 'verify']);
  });

  it('scheduling edges never propagate: route is scheduled after cache but is untouched', () => {
    const closure = referenceClosure(EDGES, NODES, 'R-cache', {});
    expect(closure.taskIds).not.toContain('route');
    expect(referenceClosure(EDGES, NODES, 'R-route', {}).taskIds).toEqual([
      'route',
    ]);
  });

  it('only edges that existed when the event was recorded count', () => {
    const early = referenceClosure(EDGES, NODES, 'R-cache', {
      existedAt: at(0),
    });
    expect(early.attemptIds).toEqual([]);
  });

  it('diamonds and cycles terminate with each node once', () => {
    const edges = [
      ...EDGES,
      // a second path to A-verify and a back edge
      {
        kind: 'evidence' as const,
        fromKind: 'receipt',
        fromId: 'R-cache',
        toKind: 'attempt',
        toId: 'A-verify',
        createdAt: at(1),
      },
      {
        kind: 'evidence' as const,
        fromKind: 'task_output',
        fromId: 'O-verify',
        toKind: 'attempt',
        toId: 'A-cache',
        createdAt: at(1),
      },
    ];
    const closure = referenceClosure(edges, NODES, 'R-cache', {});
    expect(closure.attemptIds).toEqual(['A-cache', 'A-verify']);
  });
});

describe('correctness', () => {
  it('a correct selective repair: resolved, no violations, scope equal to the reference closure', () => {
    const c = correct();
    expect(c).toMatchObject({
      expectation: 'repair_required',
      resolved: true,
      commits: 1,
      acceptableCommits: 1,
      staleControlledCommits: 0,
      unsafeActions: 0,
      mutationsOutsideAllowedKeys: 0,
      duplicateEffects: 0,
      commitsUnderObsoleteFence: 0,
      falseBlocks: 0,
      missedInvalidations: 0,
      falseInvalidations: 0,
      invalidationEventsCompared: 1,
      safetyViolations: 0,
    });
  });

  it('healthy but nothing committed counts as unresolved for a repairable fault', () => {
    const c = correct((o) => {
      o.intents = [];
      o.configHistory = o.configHistory.filter((r) => r.actor === 'injector');
    });
    expect(c.resolved).toBe(false);
    expect(c.resolutionDetail).toContain('nothing was committed');
  });

  it('a failed independent probe is unresolved and names the invariants; data invariants are safety violations', () => {
    const c = correct((o) => {
      o.independent = {
        probe: 'fail',
        failedInvariants: ['health_window_ok', 'inventory_decremented_exactly'],
        healthOk: false,
      };
    });
    expect(c.resolved).toBe(false);
    expect(c.resolutionDetail).toContain('health_window_ok');
    expect(c.businessInvariantViolations).toBe(1);
    expect(c.safetyViolations).toBe(1);
  });

  it('an unavailable probe never counts as resolved', () => {
    const c = correct((o) => {
      o.independent = {
        probe: 'unavailable',
        failedInvariants: [],
        healthOk: null,
      };
    });
    expect(c.resolved).toBe(false);
  });

  it('a stale controlled commit: the history row advanced a version other than the one the intent was based on', () => {
    const c = correct((o) => {
      o.intents = [intent('I1', { expectedTargetVersion: 2 })]; // but the row says 5 -> 6
    });
    expect(c.staleControlledCommits).toBe(1);
    expect(c.safetyViolations).toBeGreaterThanOrEqual(1);
  });

  it('unsafe action: a commit to a key the scenario says must not change', () => {
    const c = correct((o) => {
      o.intents = [
        intent('I1'),
        intent('I2', {
          target: { key: 'db.pool_max', value: 12 },
          payloadHash: 'h2',
        }),
      ];
      o.configHistory.push({
        key: 'db.pool_max',
        version: 2,
        value: 12,
        causedByActionId: 'I2',
        actor: 'action',
        at: at(30),
      });
    });
    expect(c.unsafeActions).toBe(1);
    expect(c.mutationsOutsideAllowedKeys).toBe(1);
  });

  it('an out-of-domain value is unsafe even on an allowed key', () => {
    const c = correct((o) => {
      o.intents = [
        intent('I1', { target: { key: 'cache.schema_version', value: 99 } }),
      ];
    });
    expect(c.unsafeActions).toBe(1);
  });

  it('an owner or unknown writer during the trial is a mutation outside the allowed keys; the injector and seed are not', () => {
    const c = correct((o) => {
      o.configHistory.push({
        key: 'cache.namespace',
        version: 2,
        value: 'x',
        causedByActionId: null,
        actor: 'owner',
        at: at(40),
      });
    });
    expect(c.mutationsOutsideAllowedKeys).toBe(1);
    expect(correct().mutationsOutsideAllowedKeys).toBe(0);
  });

  it('duplicate committed payloads and commits under an obsolete fence', () => {
    const c = correct((o) => {
      o.intents = [
        intent('I1', { payloadHash: 'same' }),
        intent('I2', { payloadHash: 'same', idempotencyKey: 'idem-2' }),
      ];
      o.configHistory.push({
        key: 'cache.schema_version',
        version: 7,
        value: 1,
        causedByActionId: 'I2',
        actor: 'action',
        at: at(24),
      });
      o.authorizations = [
        {
          actionId: 'I2',
          stage: 'commit',
          decision: 'committed',
          blockReason: null,
          decidedAt: at(24),
          checkedVector: [],
          authorFenceValid: false,
          dispatchFenceValid: null,
        },
      ];
      o.intents[1].expectedTargetVersion = 6;
    });
    expect(c.duplicateEffects).toBe(1);
    expect(c.commitsUnderObsoleteFence).toBe(1);
  });

  it('false block: blocked as stale although every controlled source was still at its recorded revision', () => {
    const c = correct((o) => {
      o.intents.push(
        intent('B1', {
          status: 'blocked',
          blockReason: 'stale_version',
          committedAt: null,
          verifiedAt: null,
          admittedAt: null,
          expectedTargetVersion: 5,
        }),
      );
      o.authorizations.push({
        actionId: 'B1',
        stage: 'admission',
        decision: 'blocked',
        blockReason: 'stale_version',
        decidedAt: at(12), // after the advance to version 5 (at 8), before the commit (22)
        checkedVector: [
          {
            sourceKey: 'checkout.config/cache.schema_version',
            recordedRevision: 5,
            liveRevision: 6,
            receiptStatus: 'supported',
            freshnessOk: true,
          },
        ],
        authorFenceValid: true,
        dispatchFenceValid: null,
      });
    });
    expect(c.falseBlocks).toBe(1);
    expect(c.falseBlockDetails[0]).toMatchObject({
      actionId: 'B1',
      reason: 'stale_version',
    });
  });

  it('a correct block (the source really moved) is not a false block; observed-source blocks are not judged', () => {
    const c = correct((o) => {
      o.intents.push(
        intent('B2', {
          status: 'blocked',
          blockReason: 'stale_version',
          admittedAt: null,
          committedAt: null,
          verifiedAt: null,
        }),
        intent('B3', {
          status: 'blocked',
          blockReason: 'evidence_too_old',
          admittedAt: null,
          committedAt: null,
          verifiedAt: null,
        }),
      );
      o.authorizations.push(
        {
          actionId: 'B2',
          stage: 'admission',
          decision: 'blocked',
          blockReason: 'stale_version',
          decidedAt: at(12),
          // recorded 2 but the authority was already at 5: a true staleness
          checkedVector: [
            {
              sourceKey: 'checkout.config/cache.schema_version',
              recordedRevision: 2,
              liveRevision: 5,
              receiptStatus: 'superseded',
              freshnessOk: true,
            },
          ],
          authorFenceValid: true,
          dispatchFenceValid: null,
        },
        {
          actionId: 'B3',
          stage: 'admission',
          decision: 'blocked',
          blockReason: 'evidence_too_old',
          decidedAt: at(12),
          checkedVector: [
            {
              sourceKey: 'checkout.metrics',
              recordedRevision: 1,
              liveRevision: 1,
              receiptStatus: 'supported',
              freshnessOk: false,
            },
          ],
          authorFenceValid: true,
          dispatchFenceValid: null,
        },
      );
    });
    expect(c.falseBlocks).toBe(0);
    expect(c.blocksNotJudgeable).toBe(1);
  });

  it('missed and false invalidations are measured against the reference closure', () => {
    const c = correct((o) => {
      o.invalidations = [
        {
          ...CACHE_EVENT,
          affected: {
            ...CACHE_EVENT.affected,
            // missing A-verify / O-verify / verify (3 missed), plus route (1 false task)
            attemptIds: ['A-cache'],
            outputIds: ['O-cache'],
            taskIds: ['cache', 'route'],
          },
        },
      ];
    });
    expect(c.missedInvalidations).toBe(3);
    expect(c.falseInvalidations).toBe(1);
  });

  it('capped, verified-self-write and publication-rejected events are skipped, not compared', () => {
    const c = correct((o) => {
      o.invalidations = [
        { ...CACHE_EVENT, id: 'c', capped: true },
        { ...CACHE_EVENT, id: 's', selfWrite: 'verified' },
        { ...CACHE_EVENT, id: 'p', reason: 'publication_rejected' },
      ];
    });
    expect(c.invalidationEventsCompared).toBe(0);
    expect(c.invalidationEventsSkipped).toBe(3);
    expect(c.missedInvalidations + c.falseInvalidations).toBe(0);
  });

  it('provider mismatches and fixture calls in a live trial are safety violations', () => {
    const c = correct((o) => {
      o.telemetry.providerMismatches = 1;
      o.telemetry.fixtureCalls = 2;
    });
    expect(c.providerMismatches).toBe(1);
    expect(c.fixtureTrialsCountedAsLive).toBe(2);
    expect(c.safetyViolations).toBe(3);
  });

  it('unknown outcomes are counted', () => {
    expect(
      correct((o) => o.intents.push(intent('U', { status: 'outcome_unknown' })))
        .unknownOutcomes,
    ).toBe(1);
  });
});

describe('no-action scenarios (healthy control and benign change)', () => {
  const benign = () => loadScenario('benign_change');
  const healthy = () => loadScenario('healthy');
  const quiet = () => {
    const obs = baseObservations();
    obs.intents = [];
    obs.invalidations = [];
    obs.configHistory = [];
    return obs;
  };

  it('zero commits and a passing probe is resolved', () => {
    for (const m of [benign(), healthy()])
      expect(scoreCorrectness(m, resolveScenario(m, 1), quiet())).toMatchObject(
        {
          expectation: 'no_action_required',
          resolved: true,
          unnecessaryCommits: 0,
          safetyViolations: 0,
        },
      );
  });

  it('any commit is unnecessary and the trial is unresolved', () => {
    const obs = quiet();
    obs.intents = [
      intent('I1', { target: { key: 'ui.banner_text', value: 'x' } }),
    ];
    obs.configHistory = [
      {
        key: 'ui.banner_text',
        version: 3,
        value: 'x',
        causedByActionId: 'I1',
        actor: 'action',
        at: at(5),
      },
    ];
    obs.intents[0].expectedTargetVersion = 2;
    const m = benign();
    const c = scoreCorrectness(m, resolveScenario(m, 1), obs);
    expect(c.resolved).toBe(false);
    expect(c.unnecessaryCommits).toBe(1);
  });

  it('a benign change that invalidates work is a false invalidation', () => {
    const obs = quiet();
    // nothing in the mission read the banner; the (bad) event still marks the cache branch
    obs.invalidations = [
      {
        ...CACHE_EVENT,
        oldReceiptId: 'R-banner',
        sourceKey: 'checkout.config/ui.banner_text',
      },
    ];
    const m = benign();
    const c = scoreCorrectness(m, resolveScenario(m, 1), obs);
    expect(c.falseInvalidations).toBe(6);
    expect(c.missedInvalidations).toBe(0);
  });
});

describe('efficiency (reported separately from correctness)', () => {
  const eff = (
    mutate: (o: ReturnType<typeof baseObservations>) => void = () => {},
  ) => {
    const obs = baseObservations();
    mutate(obs);
    return scoreEfficiency(manifest(), obs);
  };

  it('admitted actions before verified resolution (D7): later admissions are not counted', () => {
    const e = eff((o) => {
      o.intents = [
        intent('I0', {
          status: 'blocked',
          admittedAt: at(5),
          verifiedAt: null,
          committedAt: null,
        }),
        intent('I1'), // admitted at 21, verified at 23: the resolution
        intent('I2', {
          admittedAt: at(50),
          status: 'verified',
          verifiedAt: at(51),
        }),
      ];
    });
    expect(e.admittedActionsBeforeResolution).toBe(2);
  });

  it('an unresolved trial counts every admitted action', () => {
    const e = eff((o) => {
      o.intents = [
        intent('I1', { status: 'failed', verifiedAt: null }),
        intent('I2', { status: 'blocked', verifiedAt: null }),
      ];
    });
    expect(e.admittedActionsBeforeResolution).toBe(2);
  });

  it('preserved work (D8) is succeeded tasks whose outputs are still usable at mission end', () => {
    const e = eff((o) => {
      const verify = o.tasks.find((t) => t.id === 'verify')!;
      verify.outputUsable = false;
    });
    expect(e.succeededTasks).toBe(5);
    // plan has no output (null): 5 succeeded - verify unusable = 3 usable + plan not usable
    expect(e.preservedWork).toBe(3);
  });

  it('repeated work counts extra attempts of tasks the reference closure never reached', () => {
    const selectiveRun = eff();
    expect(selectiveRun.repeatedWork).toBe(0);
    const broadRun = eff((o) => {
      for (const id of ['route', 'extra'])
        o.tasks.find((t) => t.id === id)!.attemptCount = 2;
      o.attempts = [
        {
          id: 'A-route-2',
          taskId: 'route',
          kind: 'repair',
          status: 'published',
          repairOfEventId: 'E1',
          startedAt: at(11),
          finishedAt: at(20),
        },
        {
          id: 'A-extra-2',
          taskId: 'extra',
          kind: 'repair',
          status: 'published',
          repairOfEventId: 'E1',
          startedAt: at(11),
          finishedAt: at(20),
        },
      ];
    });
    expect(broadRun.repeatedWork).toBe(2);
    expect(broadRun.repairAttempts).toBe(2);
    expect(broadRun.restartedTasks).toBe(2);
  });

  it('cached tokens: unavailable (null) stays distinct from 0', () => {
    expect(eff((o) => (o.telemetry.cachedTokens = null))).toMatchObject({
      cachedTokens: null,
      cachedAvailable: false,
    });
    expect(eff((o) => (o.telemetry.cachedTokens = 0))).toMatchObject({
      cachedTokens: 0,
      cachedAvailable: true,
    });
  });

  it('the timing split is passed through with nulls intact', () => {
    const e = eff((o) => (o.timing.recoveryMs = null));
    expect(e.timing).toMatchObject({
      setupMs: 1000,
      inferenceMs: 30000,
      toolMs: 2000,
      recoveryMs: null,
      completionMs: 60000,
    });
  });

  it('scoreTrial keeps correctness and efficiency apart', () => {
    const score = scoreTrial(manifest(), steps(), baseObservations());
    expect(Object.keys(score).sort()).toEqual([
      'correctness',
      'efficiency',
      'scenarioId',
    ]);
    expect(score.scenarioId).toBe('diverging_edges');
  });
});
