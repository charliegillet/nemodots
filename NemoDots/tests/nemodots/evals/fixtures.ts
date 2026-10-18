// Synthetic observations for the oracle tests: a hand-built diverging_edges
// mission. Ids are readable strings (the oracle treats them as opaque).
//
//   tasks:      plan (planner)          cache (investigator)   route (investigator)
//               verify (verifier, child of cache)               extra (investigator)
//   scheduling: cache -> route (the plan ordered routing after cache work)
//   evidence:   R-cache -> A-cache -> O-cache -> A-verify -> O-verify
//               R-route -> A-route -> O-route
//               R-extra -> A-extra -> O-extra
//
// A change to R-cache therefore reaches {cache, verify}; route is scheduled
// after cache but rests on none of its evidence; extra is unrelated.
import {
  loadScenario,
  resolveScenario,
} from '../../../src/server/nemodots/sandbox/manifest.js';
import type {
  ObsEdge,
  ObsInvalidation,
  ObsIntent,
  ObsNode,
  Observations,
} from '../../../src/server/nemodots/evals/observations.js';

export const T0 = Date.parse('2026-10-18T10:00:00.000Z');
export const at = (seconds: number) =>
  new Date(T0 + seconds * 1000).toISOString();

export const MISSION = 'M1';

export const task = (
  id: string,
  role: string,
  extra: Partial<Observations['tasks'][number]> = {},
): Observations['tasks'][number] => ({
  id,
  parentId: null,
  role,
  status: 'succeeded',
  prerequisites: [],
  outputId: id === 'plan' ? null : `O-${id}`,
  outputUsable: id === 'plan' ? null : true,
  attemptCount: 1,
  ...extra,
});

export const TASKS = [
  task('plan', 'planner'),
  task('cache', 'investigator'),
  task('route', 'investigator', { prerequisites: ['cache'] }),
  task('verify', 'verifier', { parentId: 'cache' }),
  task('extra', 'investigator'),
];

const node = (kind: string, id: string, taskId: string | null): ObsNode => ({
  kind,
  id,
  missionId: kind === 'receipt' ? null : MISSION,
  taskId,
});

export const NODES: ObsNode[] = [
  node('receipt', 'R-cache', null),
  node('receipt', 'R-route', null),
  node('receipt', 'R-extra', null),
  ...['cache', 'route', 'verify', 'extra'].flatMap((t) => [
    node('attempt', `A-${t}`, t),
    node('task_output', `O-${t}`, t),
    node('task', t, t),
  ]),
];

const edge = (
  kind: ObsEdge['kind'],
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  seconds = 1,
): ObsEdge => ({
  kind,
  fromKind,
  fromId,
  toKind,
  toId,
  createdAt: at(seconds),
});

export const EDGES: ObsEdge[] = [
  edge('evidence', 'receipt', 'R-cache', 'attempt', 'A-cache'),
  edge('evidence', 'attempt', 'A-cache', 'task_output', 'O-cache'),
  edge('inheritance', 'task_output', 'O-cache', 'attempt', 'A-verify'),
  edge('evidence', 'attempt', 'A-verify', 'task_output', 'O-verify'),
  edge('evidence', 'receipt', 'R-route', 'attempt', 'A-route'),
  edge('evidence', 'attempt', 'A-route', 'task_output', 'O-route'),
  edge('evidence', 'receipt', 'R-extra', 'attempt', 'A-extra'),
  edge('evidence', 'attempt', 'A-extra', 'task_output', 'O-extra'),
  edge('scheduling', 'task', 'cache', 'task', 'route'),
];

/** The ledger-correct event for a change of R-cache. */
export const CACHE_EVENT: ObsInvalidation = {
  id: 'E1',
  sourceKey: 'checkout.config/cache.schema_version',
  reason: 'newer_observation',
  selfWrite: 'none',
  oldReceiptId: 'R-cache',
  newReceiptId: 'R-cache-2',
  createdAt: at(10),
  affected: {
    modelCallIds: [],
    attemptIds: ['A-cache', 'A-verify'],
    outputIds: ['O-cache', 'O-verify'],
    actionIds: [],
    taskIds: ['cache', 'verify'],
  },
  capped: false,
};

export function intent(id: string, extra: Partial<ObsIntent> = {}): ObsIntent {
  return {
    id,
    taskId: 'cache',
    attemptId: 'A-cache',
    action: 'set_config',
    target: { key: 'cache.schema_version', value: 1 },
    status: 'verified',
    blockReason: null,
    failureReason: null,
    expectedTargetVersion: 5,
    idempotencyKey: `idem-${id}`,
    payloadHash: `hash-${id}`,
    proposedAt: at(20),
    admittedAt: at(21),
    committedAt: at(22),
    verifiedAt: at(23),
    ...extra,
  };
}

/** A healthy, correct selective trial of diverging_edges. */
export function baseObservations(): Observations {
  return {
    missionId: MISSION,
    missionStatus: 'succeeded',
    startedAt: at(0),
    endedAt: at(60),
    tasks: TASKS.map((t) => ({ ...t })),
    attempts: [],
    nodes: NODES,
    edges: EDGES,
    invalidations: [{ ...CACHE_EVENT }],
    intents: [intent('I1')],
    authorizations: [],
    results: [],
    configHistory: [
      // the injected faults and the late second advance (injector)
      {
        key: 'cache.schema_version',
        version: 2,
        value: 2,
        causedByActionId: null,
        actor: 'injector',
        at: at(2),
      },
      {
        key: 'routing.inventory_source',
        version: 2,
        value: 'replica_stale',
        causedByActionId: null,
        actor: 'injector',
        at: at(2),
      },
      {
        key: 'cache.schema_version',
        version: 5,
        value: 5,
        causedByActionId: null,
        actor: 'injector',
        at: at(8),
      },
      // the team's commit: based on version 5, writes 6
      {
        key: 'cache.schema_version',
        version: 6,
        value: 1,
        causedByActionId: 'I1',
        actor: 'action',
        at: at(22),
      },
    ],
    telemetry: {
      calls: 20,
      promptTokens: 10000,
      completionTokens: 1000,
      cachedTokens: 4000,
      retries: 1,
      errors: 0,
      providerMismatches: 0,
      fixtureCalls: 0,
    },
    timing: {
      setupMs: 1000,
      inferenceMs: 30000,
      toolMs: 2000,
      recoveryMs: 15000,
      completionMs: 60000,
    },
    independent: { probe: 'pass', failedInvariants: [], healthOk: true },
    arm: { recoveryScopeRule: 'selective', contextLayouts: ['cache_aware'] },
  };
}

export const manifest = () => loadScenario('diverging_edges');
export const steps = (seed = 1) => resolveScenario(manifest(), seed);
