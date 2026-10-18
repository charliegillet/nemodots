// Hand-enumerated invalidation closures (TEST_PROMPT gate 1 items 2, 8-10,
// 12; ARCHITECTURE 5.2, 5.4; CONTRACTS 6). Every `expected` set below was
// written by hand from the drawn graph; the self-check test recomputes it
// with an independent reference traversal and fails on any disagreement.
//
// Oracle rules (see README.md):
//   R1 closure = nodes reachable from the old receipt over `evidence` and
//      `inheritance` edges only; `scheduling` edges never propagate.
//   R2 a task is affected iff one of its attempts is affected.
//   R3 preserved tasks of a mission = its tasks minus affected tasks.
//   R4 affected intents in `proposed | admitted` become
//      `blocked(stale_version)`; intents in any other status keep it.
//   R5 one invalidation_events row per changed receipt; a mission with no
//      affected node receives no event at all.
//   R6 v1 has no representation of independent sufficient support, so the
//      closure is conservative and is labelled so (`conservative: true`).
import type {
  AffectedSets,
  ClosureCase,
  GraphEdge,
  GraphNode,
  RejectionCase,
  SelfWriteCase,
} from './types.js';
import type { ActionStatus, TaskRole } from './spec-enums.js';

const SHARED = 'shared';

function r(
  id: string,
  seq: number,
  sourceKey: string,
  environment: 'dev' | 'test' | 'eval' = 'test',
): GraphNode {
  return {
    id,
    kind: 'receipt',
    missionId: SHARED,
    seq,
    sourceKey,
    revision: 1,
    environment,
  };
}
function t(
  id: string,
  seq: number,
  missionId: string,
  role: TaskRole,
  parentTaskId: string | null = null,
): GraphNode {
  return { id, kind: 'task', missionId, seq, role, parentTaskId };
}
function a(
  id: string,
  seq: number,
  missionId: string,
  taskId: string,
): GraphNode {
  return {
    id,
    kind: 'attempt',
    missionId,
    seq,
    taskId,
    attemptStatus: 'published',
  };
}
function m(
  id: string,
  seq: number,
  missionId: string,
  taskId: string,
): GraphNode {
  return { id, kind: 'model_call', missionId, seq, taskId };
}
function o(
  id: string,
  seq: number,
  missionId: string,
  taskId: string,
): GraphNode {
  return { id, kind: 'task_output', missionId, seq, taskId };
}
function i(
  id: string,
  seq: number,
  missionId: string,
  taskId: string,
  intentStatus: ActionStatus,
): GraphNode {
  return { id, kind: 'action_intent', missionId, seq, taskId, intentStatus };
}
const ev = (from: string, to: string): GraphEdge => ({
  kind: 'evidence',
  from,
  to,
});
const inh = (from: string, to: string): GraphEdge => ({
  kind: 'inheritance',
  from,
  to,
});
const sch = (from: string, to: string): GraphEdge => ({
  kind: 'scheduling',
  from,
  to,
});
function sets(partial: Partial<AffectedSets>): AffectedSets {
  return {
    modelCallIds: [],
    attemptIds: [],
    outputIds: [],
    actionIds: [],
    taskIds: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// CL-1 linear chain with an inherited child and one unrelated scheduled task.
//
//   R1(pool_max) -> A1,M1 -> O1 =inh=> A2,M2 -> I2(proposed), O2      [T1 -> T2]
//   R9(health)   -> A3,M3 -> O3                                        [T3]
//   T1 --sched--> T3
const CL1_NODES: GraphNode[] = [
  r('R1', 1, 'checkout.config/db.pool_max'),
  r('R9', 2, 'checkout.health'),
  t('T1', 3, 'm1', 'investigator'),
  t('T3', 4, 'm1', 'investigator'),
  a('A1', 5, 'm1', 'T1'),
  m('M1', 6, 'm1', 'T1'),
  o('O1', 7, 'm1', 'T1'),
  t('T2', 8, 'm1', 'database_specialist', 'T1'),
  a('A2', 9, 'm1', 'T2'),
  m('M2', 10, 'm1', 'T2'),
  i('I2', 11, 'm1', 'T2', 'proposed'),
  o('O2', 12, 'm1', 'T2'),
  a('A3', 13, 'm1', 'T3'),
  m('M3', 14, 'm1', 'T3'),
  o('O3', 15, 'm1', 'T3'),
];
const CL1_EDGES: GraphEdge[] = [
  ev('R1', 'A1'),
  ev('R1', 'M1'),
  ev('M1', 'O1'),
  ev('A1', 'O1'),
  inh('O1', 'A2'),
  inh('O1', 'M2'),
  ev('M2', 'I2'),
  ev('A2', 'I2'),
  ev('M2', 'O2'),
  ev('A2', 'O2'),
  ev('R9', 'A3'),
  ev('R9', 'M3'),
  ev('M3', 'O3'),
  ev('A3', 'O3'),
  sch('T1', 'T3'),
];

// ---------------------------------------------------------------------------
// CL-2 diamond: two arms share Rs(health); the join TJ inherits both arms.
//
//   Rl(schema) ─┐                       ┌─ Rr(redis.stats)
//               AL,ML -> OL ═inh═╗  ╔═inh═ OR <- AR,MR
//   Rs(health) ─┴───────────────╫──╫────────────────┘
//                               AJ,MJ -> OJ, IJ(admitted)
//   Rx(orders.recent) -> AX,MX -> OX   (unrelated)
const CL2_NODES: GraphNode[] = [
  r('Rl', 1, 'checkout.config/cache.schema_version'),
  r('Rr', 2, 'redis.stats'),
  r('Rs', 3, 'checkout.health'),
  r('Rx', 4, 'checkout.orders.recent'),
  t('TL', 5, 'm1', 'cache_specialist'),
  t('TR', 6, 'm1', 'cache_specialist'),
  t('TJ', 7, 'm1', 'cache_specialist'),
  t('TX', 8, 'm1', 'investigator'),
  a('AL', 9, 'm1', 'TL'),
  m('ML', 10, 'm1', 'TL'),
  o('OL', 11, 'm1', 'TL'),
  a('AR', 12, 'm1', 'TR'),
  m('MR', 13, 'm1', 'TR'),
  o('OR', 14, 'm1', 'TR'),
  a('AJ', 15, 'm1', 'TJ'),
  m('MJ', 16, 'm1', 'TJ'),
  o('OJ', 17, 'm1', 'TJ'),
  i('IJ', 18, 'm1', 'TJ', 'admitted'),
  a('AX', 19, 'm1', 'TX'),
  m('MX', 20, 'm1', 'TX'),
  o('OX', 21, 'm1', 'TX'),
];
const CL2_EDGES: GraphEdge[] = [
  ev('Rl', 'AL'),
  ev('Rl', 'ML'),
  ev('Rs', 'AL'),
  ev('Rs', 'ML'),
  ev('ML', 'OL'),
  ev('AL', 'OL'),
  ev('Rr', 'AR'),
  ev('Rr', 'MR'),
  ev('Rs', 'AR'),
  ev('Rs', 'MR'),
  ev('MR', 'OR'),
  ev('AR', 'OR'),
  inh('OL', 'AJ'),
  inh('OL', 'MJ'),
  inh('OR', 'AJ'),
  inh('OR', 'MJ'),
  ev('MJ', 'OJ'),
  ev('AJ', 'OJ'),
  ev('MJ', 'IJ'),
  ev('AJ', 'IJ'),
  ev('Rx', 'AX'),
  ev('Rx', 'MX'),
  ev('MX', 'OX'),
  ev('AX', 'OX'),
  sch('TL', 'TJ'),
  sch('TR', 'TJ'),
];

// ---------------------------------------------------------------------------
// CL-3 multiple parents: AP rests on Ra AND Rb (either would logically
// suffice); its verifier child TQ inherits OP. Changing Rb alone must still
// invalidate AP (conservative, R6).
const CL3_NODES: GraphNode[] = [
  r('Ra', 1, 'checkout.metrics'),
  r('Rb', 2, 'redis.stats'),
  t('TP', 3, 'm1', 'cache_specialist'),
  a('AP', 4, 'm1', 'TP'),
  m('MP', 5, 'm1', 'TP'),
  o('OP', 6, 'm1', 'TP'),
  t('TQ', 7, 'm1', 'verifier', 'TP'),
  a('AQ', 8, 'm1', 'TQ'),
  m('MQ', 9, 'm1', 'TQ'),
  o('OQ', 10, 'm1', 'TQ'),
];
const CL3_EDGES: GraphEdge[] = [
  ev('Ra', 'AP'),
  ev('Rb', 'AP'),
  ev('Ra', 'MP'),
  ev('Rb', 'MP'),
  ev('MP', 'OP'),
  ev('AP', 'OP'),
  inh('OP', 'AQ'),
  inh('OP', 'MQ'),
  ev('MQ', 'OQ'),
  ev('AQ', 'OQ'),
];

// ---------------------------------------------------------------------------
// CL-4 one shared receipt read by two missions; a third mission reads only
// health. Per-mission partition (finding I10).
const CL4_NODES: GraphNode[] = [
  r('Rsh', 1, 'checkout.config/db.pool_max'),
  r('Ro', 2, 'checkout.health'),
  t('Tm1', 3, 'm1', 'database_specialist'),
  a('Am1', 4, 'm1', 'Tm1'),
  m('Mm1', 5, 'm1', 'Tm1'),
  o('Om1', 6, 'm1', 'Tm1'),
  t('Tm2', 7, 'm2', 'database_specialist'),
  a('Am2', 8, 'm2', 'Tm2'),
  m('Mm2', 9, 'm2', 'Tm2'),
  o('Om2', 10, 'm2', 'Tm2'),
  t('Tm2b', 11, 'm2', 'investigator'),
  a('Am2b', 12, 'm2', 'Tm2b'),
  o('Om2b', 13, 'm2', 'Tm2b'),
  t('Tm3', 14, 'm3', 'investigator'),
  a('Am3', 15, 'm3', 'Tm3'),
  o('Om3', 16, 'm3', 'Tm3'),
];
const CL4_EDGES: GraphEdge[] = [
  ev('Rsh', 'Am1'),
  ev('Rsh', 'Mm1'),
  ev('Mm1', 'Om1'),
  ev('Am1', 'Om1'),
  ev('Rsh', 'Am2'),
  ev('Rsh', 'Mm2'),
  ev('Mm2', 'Om2'),
  ev('Am2', 'Om2'),
  ev('Ro', 'Am2b'),
  ev('Am2b', 'Om2b'),
  ev('Ro', 'Am3'),
  ev('Am3', 'Om3'),
];

// ---------------------------------------------------------------------------
// CL-5 simultaneous invalidations of two controlled members behind a
// barrier; As reads both, Au reads only health.
const CL5_NODES: GraphNode[] = [
  r('Rp', 1, 'checkout.config/db.pool_max'),
  r('Rq', 2, 'checkout.config/db.statement_timeout_ms'),
  r('Ru', 3, 'checkout.health'),
  t('Tp', 4, 'm1', 'database_specialist'),
  a('Ap', 5, 'm1', 'Tp'),
  o('Op', 6, 'm1', 'Tp'),
  t('Tq', 7, 'm1', 'database_specialist'),
  a('Aq', 8, 'm1', 'Tq'),
  o('Oq', 9, 'm1', 'Tq'),
  t('Ts', 10, 'm1', 'database_specialist'),
  a('As', 11, 'm1', 'Ts'),
  m('Ms', 12, 'm1', 'Ts'),
  o('Os', 13, 'm1', 'Ts'),
  i('Is', 14, 'm1', 'Ts', 'proposed'),
  t('Tu', 15, 'm1', 'investigator'),
  a('Au', 16, 'm1', 'Tu'),
  o('Ou', 17, 'm1', 'Tu'),
];
const CL5_EDGES: GraphEdge[] = [
  ev('Rp', 'Ap'),
  ev('Ap', 'Op'),
  ev('Rq', 'Aq'),
  ev('Aq', 'Oq'),
  ev('Rp', 'As'),
  ev('Rq', 'As'),
  ev('Rp', 'Ms'),
  ev('Rq', 'Ms'),
  ev('Ms', 'Os'),
  ev('As', 'Os'),
  ev('Ms', 'Is'),
  ev('As', 'Is'),
  ev('Ru', 'Au'),
  ev('Au', 'Ou'),
];

// ---------------------------------------------------------------------------
// CL-6 negative / collection evidence. Tn concluded "no restrictive key
// exists" from the membership collection and proposed In; Tv read the banner
// member; Tz read only health.
const CL6_NODES: GraphNode[] = [
  r('Rcoll', 1, 'checkout.config'),
  r('Rban', 2, 'checkout.config/ui.banner_text'),
  r('Rh', 3, 'checkout.health'),
  t('Tn', 4, 'm1', 'database_specialist'),
  a('An', 5, 'm1', 'Tn'),
  m('Mn', 6, 'm1', 'Tn'),
  o('On', 7, 'm1', 'Tn'),
  i('In', 8, 'm1', 'Tn', 'admitted'),
  t('Tv', 9, 'm1', 'investigator'),
  a('Av', 10, 'm1', 'Tv'),
  o('Ov', 11, 'm1', 'Tv'),
  t('Tz', 12, 'm1', 'investigator'),
  a('Az', 13, 'm1', 'Tz'),
  o('Oz', 14, 'm1', 'Tz'),
];
const CL6_EDGES: GraphEdge[] = [
  ev('Rcoll', 'An'),
  ev('Rcoll', 'Mn'),
  ev('Rh', 'An'),
  ev('Rh', 'Mn'),
  ev('Mn', 'On'),
  ev('An', 'On'),
  ev('Mn', 'In'),
  ev('An', 'In'),
  ev('Rban', 'Av'),
  ev('Av', 'Ov'),
  ev('Rh', 'Az'),
  ev('Az', 'Oz'),
];

// ---------------------------------------------------------------------------
// CL-7 diverging scheduling vs evidence edges (finding D8): Ts2 runs after
// Ts1 but never reads Rk1 nor inherits Os1.
const CL7_NODES: GraphNode[] = [
  r('Rk1', 1, 'checkout.config/db.pool_max'),
  r('Rk2', 2, 'checkout.config/routing.inventory_source'),
  t('Ts1', 3, 'm1', 'database_specialist'),
  a('As1', 4, 'm1', 'Ts1'),
  m('Ms1', 5, 'm1', 'Ts1'),
  o('Os1', 6, 'm1', 'Ts1'),
  t('Ts2', 7, 'm1', 'routing_specialist'),
  a('As2', 8, 'm1', 'Ts2'),
  m('Ms2', 9, 'm1', 'Ts2'),
  o('Os2', 10, 'm1', 'Ts2'),
];
const CL7_EDGES: GraphEdge[] = [
  ev('Rk1', 'As1'),
  ev('Rk1', 'Ms1'),
  ev('Ms1', 'Os1'),
  ev('As1', 'Os1'),
  sch('Ts1', 'Ts2'),
  ev('Rk2', 'As2'),
  ev('Rk2', 'Ms2'),
  ev('Ms2', 'Os2'),
  ev('As2', 'Os2'),
];

// ---------------------------------------------------------------------------
// CL-8 same key in two environments (collision rule, gate 1.2).
const CL8_NODES: GraphNode[] = [
  r('Rt', 1, 'checkout.config/db.pool_max', 'test'),
  r('Re', 2, 'checkout.config/db.pool_max', 'eval'),
  t('Tt', 3, 'm1', 'database_specialist'),
  a('At', 4, 'm1', 'Tt'),
  o('Ot', 5, 'm1', 'Tt'),
  t('Te', 6, 'm2', 'database_specialist'),
  a('Ae', 7, 'm2', 'Te'),
  o('Oe', 8, 'm2', 'Te'),
];
const CL8_EDGES: GraphEdge[] = [
  ev('Rt', 'At'),
  ev('At', 'Ot'),
  ev('Re', 'Ae'),
  ev('Ae', 'Oe'),
];

// ---------------------------------------------------------------------------
// CL-9 reachable intents in terminal or non-live statuses keep their status.
const CL9_NODES: GraphNode[] = [
  r('Rv', 1, 'checkout.config/orders.write_enabled'),
  r('Rh2', 2, 'checkout.health'),
  t('Tw', 3, 'm1', 'database_specialist'),
  a('Aw', 4, 'm1', 'Tw'),
  m('Mw', 5, 'm1', 'Tw'),
  i('Iw1', 6, 'm1', 'Tw', 'verified'),
  i('Iw2', 7, 'm1', 'Tw', 'blocked'),
  i('Iw3', 8, 'm1', 'Tw', 'proposed'),
  o('Ow', 9, 'm1', 'Tw'),
];
const CL9_EDGES: GraphEdge[] = [
  ev('Rv', 'Aw'),
  ev('Rv', 'Mw'),
  ev('Rh2', 'Aw'),
  ev('Rh2', 'Mw'),
  ev('Mw', 'Iw1'),
  ev('Mw', 'Iw2'),
  ev('Mw', 'Iw3'),
  ev('Mw', 'Ow'),
  ev('Aw', 'Ow'),
];

export const CLOSURE_CASES: readonly ClosureCase[] = [
  {
    id: 'CL-1',
    title:
      'linear chain through an inherited child; scheduled sibling preserved',
    covers: ['gate1.8', 'gate1.10'],
    nodes: CL1_NODES,
    edges: CL1_EDGES,
    changes: [
      {
        oldReceipt: 'R1',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['M1', 'M2'],
        attemptIds: ['A1', 'A2'],
        outputIds: ['O1', 'O2'],
        actionIds: ['I2'],
        taskIds: ['T1', 'T2'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['M1', 'M2'],
            attemptIds: ['A1', 'A2'],
            outputIds: ['O1', 'O2'],
            actionIds: ['I2'],
            taskIds: ['T1', 'T2'],
          }),
          preservedTaskIds: ['T3'],
        },
      ],
      intentStatusAfter: {
        I2: { status: 'blocked', blockReason: 'stale_version' },
      },
      invalidationEvents: 1,
      conservative: false,
      dagRestartTaskIds: ['T1', 'T2', 'T3'],
      receiptsStillCurrent: ['R9'],
    },
  },
  {
    id: 'CL-2a',
    title:
      'diamond: change one arm only; join and its admitted intent affected',
    covers: ['gate1.8'],
    nodes: CL2_NODES,
    edges: CL2_EDGES,
    changes: [
      {
        oldReceipt: 'Rl',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['ML', 'MJ'],
        attemptIds: ['AL', 'AJ'],
        outputIds: ['OL', 'OJ'],
        actionIds: ['IJ'],
        taskIds: ['TL', 'TJ'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['ML', 'MJ'],
            attemptIds: ['AL', 'AJ'],
            outputIds: ['OL', 'OJ'],
            actionIds: ['IJ'],
            taskIds: ['TL', 'TJ'],
          }),
          preservedTaskIds: ['TR', 'TX'],
        },
      ],
      intentStatusAfter: {
        IJ: { status: 'blocked', blockReason: 'stale_version' },
      },
      invalidationEvents: 1,
      conservative: false,
      dagRestartTaskIds: ['TL', 'TJ'],
      receiptsStillCurrent: ['Rr', 'Rs', 'Rx'],
    },
  },
  {
    id: 'CL-2b',
    title: 'diamond: change the shared root; join reached twice, listed once',
    covers: ['gate1.8'],
    nodes: CL2_NODES,
    edges: CL2_EDGES,
    changes: [
      {
        oldReceipt: 'Rs',
        reason: 'newer_observation',
        via: 'observed_digest_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['ML', 'MR', 'MJ'],
        attemptIds: ['AL', 'AR', 'AJ'],
        outputIds: ['OL', 'OR', 'OJ'],
        actionIds: ['IJ'],
        taskIds: ['TL', 'TR', 'TJ'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['ML', 'MR', 'MJ'],
            attemptIds: ['AL', 'AR', 'AJ'],
            outputIds: ['OL', 'OR', 'OJ'],
            actionIds: ['IJ'],
            taskIds: ['TL', 'TR', 'TJ'],
          }),
          preservedTaskIds: ['TX'],
        },
      ],
      intentStatusAfter: {
        IJ: { status: 'blocked', blockReason: 'stale_version' },
      },
      invalidationEvents: 1,
      conservative: false,
      dagRestartTaskIds: ['TL', 'TR', 'TJ'],
      receiptsStillCurrent: ['Rl', 'Rr', 'Rx'],
    },
  },
  {
    id: 'CL-3',
    title:
      'multiple parents: one of two sufficient supports changes (conservative)',
    covers: ['gate1.8', 'gate1.9'],
    nodes: CL3_NODES,
    edges: CL3_EDGES,
    changes: [
      {
        oldReceipt: 'Rb',
        reason: 'newer_observation',
        via: 'observed_digest_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['MP', 'MQ'],
        attemptIds: ['AP', 'AQ'],
        outputIds: ['OP', 'OQ'],
        taskIds: ['TP', 'TQ'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['MP', 'MQ'],
            attemptIds: ['AP', 'AQ'],
            outputIds: ['OP', 'OQ'],
            taskIds: ['TP', 'TQ'],
          }),
          preservedTaskIds: [],
        },
      ],
      intentStatusAfter: {},
      invalidationEvents: 1,
      conservative: true,
      receiptsStillCurrent: ['Ra'],
    },
  },
  {
    id: 'CL-4',
    title:
      'shared receipt across missions: per-mission subsets, no event for m3',
    covers: ['gate1.2', 'gate1.8'],
    nodes: CL4_NODES,
    edges: CL4_EDGES,
    changes: [
      {
        oldReceipt: 'Rsh',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['Mm1', 'Mm2'],
        attemptIds: ['Am1', 'Am2'],
        outputIds: ['Om1', 'Om2'],
        taskIds: ['Tm1', 'Tm2'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['Mm1'],
            attemptIds: ['Am1'],
            outputIds: ['Om1'],
            taskIds: ['Tm1'],
          }),
          preservedTaskIds: [],
        },
        {
          missionId: 'm2',
          affected: sets({
            modelCallIds: ['Mm2'],
            attemptIds: ['Am2'],
            outputIds: ['Om2'],
            taskIds: ['Tm2'],
          }),
          preservedTaskIds: ['Tm2b'],
        },
      ],
      intentStatusAfter: {},
      invalidationEvents: 1,
      conservative: false,
      receiptsStillCurrent: ['Ro'],
    },
  },
  {
    id: 'CL-5',
    title: 'two simultaneous member invalidations behind a barrier',
    covers: ['gate1.8'],
    nodes: CL5_NODES,
    edges: CL5_EDGES,
    changes: [
      {
        oldReceipt: 'Rp',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
      {
        oldReceipt: 'Rq',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: true,
    expected: {
      affected: sets({
        modelCallIds: ['Ms'],
        attemptIds: ['Ap', 'Aq', 'As'],
        outputIds: ['Op', 'Oq', 'Os'],
        actionIds: ['Is'],
        taskIds: ['Tp', 'Tq', 'Ts'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['Ms'],
            attemptIds: ['Ap', 'Aq', 'As'],
            outputIds: ['Op', 'Oq', 'Os'],
            actionIds: ['Is'],
            taskIds: ['Tp', 'Tq', 'Ts'],
          }),
          preservedTaskIds: ['Tu'],
        },
      ],
      intentStatusAfter: {
        Is: { status: 'blocked', blockReason: 'stale_version' },
      },
      invalidationEvents: 2,
      conservative: false,
      receiptsStillCurrent: ['Ru'],
    },
  },
  {
    id: 'CL-6a',
    title:
      'negative evidence: key insert bumps the collection, absence is stale',
    covers: ['gate1.12'],
    nodes: CL6_NODES,
    edges: CL6_EDGES,
    changes: [
      {
        oldReceipt: 'Rcoll',
        reason: 'collection_changed',
        via: 'collection_insert',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['Mn'],
        attemptIds: ['An'],
        outputIds: ['On'],
        actionIds: ['In'],
        taskIds: ['Tn'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['Mn'],
            attemptIds: ['An'],
            outputIds: ['On'],
            actionIds: ['In'],
            taskIds: ['Tn'],
          }),
          preservedTaskIds: ['Tv', 'Tz'],
        },
      ],
      intentStatusAfter: {
        In: { status: 'blocked', blockReason: 'stale_version' },
      },
      invalidationEvents: 1,
      conservative: false,
      receiptsStillCurrent: ['Rban', 'Rh'],
    },
  },
  {
    id: 'CL-6b',
    title:
      'benign member value change (B1) leaves the collection receipt current',
    covers: ['gate1.10', 'gate1.12'],
    nodes: CL6_NODES,
    edges: CL6_EDGES,
    changes: [
      {
        oldReceipt: 'Rban',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        attemptIds: ['Av'],
        outputIds: ['Ov'],
        taskIds: ['Tv'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            attemptIds: ['Av'],
            outputIds: ['Ov'],
            taskIds: ['Tv'],
          }),
          preservedTaskIds: ['Tn', 'Tz'],
        },
      ],
      intentStatusAfter: { In: { status: 'admitted' } },
      invalidationEvents: 1,
      conservative: false,
      receiptsStillCurrent: ['Rcoll', 'Rh'],
    },
  },
  {
    id: 'CL-7',
    title:
      'diverging edges: scheduled successor without evidence path is preserved',
    covers: ['gate1.10', 'gate8'],
    nodes: CL7_NODES,
    edges: CL7_EDGES,
    changes: [
      {
        oldReceipt: 'Rk1',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['Ms1'],
        attemptIds: ['As1'],
        outputIds: ['Os1'],
        taskIds: ['Ts1'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['Ms1'],
            attemptIds: ['As1'],
            outputIds: ['Os1'],
            taskIds: ['Ts1'],
          }),
          preservedTaskIds: ['Ts2'],
        },
      ],
      intentStatusAfter: {},
      invalidationEvents: 1,
      conservative: false,
      dagRestartTaskIds: ['Ts1', 'Ts2'],
      receiptsStillCurrent: ['Rk2'],
    },
  },
  {
    id: 'CL-8',
    title: 'same key in two environments: no collision, no cross invalidation',
    covers: ['gate1.2'],
    nodes: CL8_NODES,
    edges: CL8_EDGES,
    changes: [
      {
        oldReceipt: 'Rt',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        attemptIds: ['At'],
        outputIds: ['Ot'],
        taskIds: ['Tt'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            attemptIds: ['At'],
            outputIds: ['Ot'],
            taskIds: ['Tt'],
          }),
          preservedTaskIds: [],
        },
      ],
      intentStatusAfter: {},
      invalidationEvents: 1,
      conservative: false,
      receiptsStillCurrent: ['Re'],
    },
  },
  {
    id: 'CL-9',
    title: 'reachable intents: only proposed/admitted are blocked',
    covers: ['gate1.8'],
    nodes: CL9_NODES,
    edges: CL9_EDGES,
    changes: [
      {
        oldReceipt: 'Rv',
        reason: 'newer_observation',
        via: 'member_value_change',
      },
    ],
    concurrent: false,
    expected: {
      affected: sets({
        modelCallIds: ['Mw'],
        attemptIds: ['Aw'],
        outputIds: ['Ow'],
        actionIds: ['Iw1', 'Iw2', 'Iw3'],
        taskIds: ['Tw'],
      }),
      perMission: [
        {
          missionId: 'm1',
          affected: sets({
            modelCallIds: ['Mw'],
            attemptIds: ['Aw'],
            outputIds: ['Ow'],
            actionIds: ['Iw1', 'Iw2', 'Iw3'],
            taskIds: ['Tw'],
          }),
          preservedTaskIds: [],
        },
      ],
      intentStatusAfter: {
        Iw1: { status: 'verified' },
        Iw2: { status: 'blocked' },
        Iw3: { status: 'blocked', blockReason: 'stale_version' },
      },
      invalidationEvents: 1,
      conservative: false,
      receiptsStillCurrent: ['Rh2'],
    },
  },
];

export const REJECTION_CASES: readonly RejectionCase[] = [
  {
    id: 'RJ-1',
    title: 'plan with a two-task scheduling cycle',
    covers: ['gate1.8'],
    operation: { kind: 'plan', dependsOn: [[1], [0]] },
    expected: {
      rejected: true,
      acceptedCodes: ['scheduling_cycle'],
      writesNothing: true,
    },
  },
  {
    id: 'RJ-2',
    title: 'plan with a self-dependency',
    covers: ['gate1.8'],
    operation: { kind: 'plan', dependsOn: [[0], []] },
    expected: {
      rejected: true,
      acceptedCodes: ['scheduling_cycle'],
      writesNothing: true,
    },
  },
  {
    id: 'RJ-3',
    title: 'delegated child that depends on its waiting parent',
    covers: ['gate1.8', 'gate4.2'],
    operation: {
      kind: 'delegate',
      existing: [
        { id: 'T0', parentTaskId: null, waitsOn: ['T1'] },
        { id: 'T1', parentTaskId: 'T0', waitsOn: [] },
      ],
      parentTaskId: 'T1',
      childDependsOn: ['T1'],
    },
    expected: {
      rejected: true,
      acceptedCodes: ['scheduling_cycle'],
      writesNothing: true,
    },
  },
  {
    id: 'RJ-4',
    title: 'delegated grandchild that depends on the waiting root',
    covers: ['gate1.8', 'gate4.2'],
    operation: {
      kind: 'delegate',
      existing: [
        { id: 'T0', parentTaskId: null, waitsOn: ['T1'] },
        { id: 'T1', parentTaskId: 'T0', waitsOn: [] },
      ],
      parentTaskId: 'T1',
      childDependsOn: ['T0'],
    },
    expected: {
      rejected: true,
      acceptedCodes: ['scheduling_cycle'],
      writesNothing: true,
    },
  },
  {
    id: 'RJ-5',
    title: 'evidence edge from a newer node back to an older one (cycle)',
    covers: ['gate1.8'],
    operation: {
      kind: 'edge',
      nodes: [
        a('X1', 1, 'm1', 'TX'),
        o('X2', 2, 'm1', 'TX'),
        a('X3', 3, 'm1', 'TY'),
      ],
      existing: [ev('X1', 'X2'), inh('X2', 'X3')],
      add: ev('X3', 'X1'),
    },
    expected: {
      rejected: true,
      acceptedCodes: ['edge_order', 'edge_cycle'],
      writesNothing: true,
    },
  },
  {
    id: 'RJ-6',
    title: 'closure deeper than the depth cap (64)',
    covers: ['gate1.8'],
    operation: { kind: 'generated', shape: 'chain', size: 70 },
    expected: {
      rejected: true,
      acceptedCodes: ['closure_cap_exceeded'],
      writesNothing: true,
      afterwards: {
        missionsPaused: true,
        coarseEventCapped: true,
        receiptRegistered: true,
        recoveryKind: 'mission_paused_closure_cap',
      },
    },
  },
  {
    id: 'RJ-7',
    title: 'closure larger than the node cap (10 000)',
    covers: ['gate1.8'],
    operation: { kind: 'generated', shape: 'fanout', size: 10_001 },
    expected: {
      rejected: true,
      acceptedCodes: ['closure_cap_exceeded'],
      writesNothing: true,
      afterwards: {
        missionsPaused: true,
        coarseEventCapped: true,
        receiptRegistered: true,
        recoveryKind: 'mission_paused_closure_cap',
      },
    },
  },
];

// Self-write classification against config_versions history (ARCHITECTURE
// 5.4, TEST_PROMPT gate 2 item 16). Lineage: T_parent -> T_act proposed X;
// T_other read the pre-write revision independently.
export const SELF_WRITE_CASES: readonly SelfWriteCase[] = [
  {
    id: 'SW-1',
    title: 'verified self-write: acting lineage routed to postcondition',
    covers: ['gate2.16'],
    history: [{ by: 'action', actionId: 'X', afterDigestMatches: true }],
    actingLineageTaskIds: ['T_parent', 'T_act'],
    otherReaderTaskIds: ['T_other'],
    expected: {
      headSelfWrite: 'verified',
      intentOutcome: { X: { status: 'verified' } },
      actingLineageInvalidated: false,
      otherReadersInvalidated: true,
      postconditionAttempts: 1,
      recoveryKinds: ['postcondition_scheduled', 'repair_coalesced'],
      maxRepairAttemptsPerTask: 1,
    },
  },
  {
    id: 'SW-2',
    title: 'self-write whose after-digest mismatches: full invalidation',
    covers: ['gate2.16'],
    history: [{ by: 'action', actionId: 'X', afterDigestMatches: false }],
    actingLineageTaskIds: ['T_parent', 'T_act'],
    otherReaderTaskIds: ['T_other'],
    expected: {
      headSelfWrite: 'mismatch',
      intentOutcome: {
        X: { status: 'failed', failureReason: 'postcondition_mismatch' },
      },
      actingLineageInvalidated: true,
      otherReadersInvalidated: true,
      postconditionAttempts: 0,
      recoveryKinds: ['repair_scheduled'],
      maxRepairAttemptsPerTask: 1,
    },
  },
  {
    id: 'SW-3',
    title: 'self-write followed by an injector write before the watcher runs',
    covers: ['gate2.16', 'gate2.3'],
    history: [
      { by: 'action', actionId: 'X', afterDigestMatches: true },
      { by: 'injector' },
    ],
    actingLineageTaskIds: ['T_parent', 'T_act'],
    otherReaderTaskIds: ['T_other'],
    expected: {
      headSelfWrite: 'none',
      intentOutcome: { X: { status: 'verified' } },
      actingLineageInvalidated: true,
      otherReadersInvalidated: true,
      postconditionAttempts: 0,
      recoveryKinds: ['repair_scheduled'],
      maxRepairAttemptsPerTask: 1,
    },
  },
];
