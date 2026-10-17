// The invalidation closure on real PostgreSQL: the recursive CTE agrees with
// hand-enumerated sets, marks are compare-and-set, unrelated work is
// untouched, per-mission subsets partition correctly (I10), and caps behave
// (C14). Graph shapes mirror the frozen oracle cases CL-1..CL-9 but are
// enumerated independently here.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EdgeError,
  ClosureCapExceeded,
  addEdges,
  assertCurrent,
  listEdges,
  listInvalidationEvents,
  eventForMission,
  registerObservation,
  registerWithoutClosure,
  supersedeAndInvalidate,
  traverseClosure,
  transitionReceipt,
  getInvalidationEvent,
  markInvalidationResolved,
} from '../../../../src/server/nemodots/ledger/index.js';
import type { ReceiptId } from '../../../../src/server/nemodots/contracts/index.js';
import {
  attempt,
  ev,
  inh,
  intent,
  modelCall,
  output,
  receipt,
  sch,
  task,
} from '../../ledger/graph-dsl.js';
import { barrier, withTimeout } from '../../helpers/barrier.js';
import {
  changeReceipt,
  coordinatorState,
  loadGraph,
  symbolic,
  symbolicPerMission,
  type LoadedGraph,
} from './graph-fixture.js';
import {
  FX,
  count,
  inTx,
  newScope,
  resetAuthority,
  seedConfig,
  sourceRef,
  useLedgerDb,
} from './fixtures.js';

const getDb = useLedgerDb();

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

const sets = (partial: Partial<ReturnType<typeof symbolic>>) => ({
  modelCallIds: [],
  attemptIds: [],
  outputIds: [],
  actionIds: [],
  taskIds: [],
  ...partial,
});

async function stillCurrent(graph: LoadedGraph, symbols: string[]) {
  for (const symbol of symbols)
    await inTx(getDb().app, (client) =>
      assertCurrent(
        client,
        [graph.id(symbol) as ReceiptId],
        { lockMode: 'share' },
        FX,
      ),
    );
}

async function noLongerCurrent(graph: LoadedGraph, symbol: string) {
  await expect(
    inTx(getDb().app, (client) =>
      assertCurrent(
        client,
        [graph.id(symbol) as ReceiptId],
        { lockMode: 'share' },
        FX,
      ),
    ),
  ).rejects.toMatchObject({ reason: 'stale_version' });
}

describe('linear chain with an inherited child (CL-1 shape)', () => {
  const nodes = [
    receipt('R1'),
    receipt('R9'),
    task('T1', 'm1'),
    task('T2', 'm1'),
    task('T3', 'm1'),
    attempt('A1', 'm1', 'T1'),
    modelCall('M1', 'm1', 'T1'),
    output('O1', 'm1', 'T1'),
    attempt('A2', 'm1', 'T2'),
    modelCall('M2', 'm1', 'T2'),
    intent('I2', 'm1', 'T2'),
    output('O2', 'm1', 'T2'),
    attempt('A3', 'm1', 'T3'),
    modelCall('M3', 'm1', 'T3'),
    output('O3', 'm1', 'T3'),
  ];
  const edges = [
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
  const options = {
    receipts: {
      R1: { key: 'checkout.config/db.pool_max' },
      R9: { key: 'checkout.health' },
    },
    attemptStatus: { A1: 'running', A2: 'running', A3: 'running' },
    intentStatus: { I2: 'proposed' },
  };

  it('affected equals the hand-enumerated closure; marks follow the transition tables; the scheduled sibling is preserved', async () => {
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const before = await coordinatorState(getDb().app, graph);
    expect(before.T3).toBe('succeeded');

    const change = await changeReceipt(
      getDb().app,
      graph,
      'R1',
      'member_value_change',
    );
    const event = change.invalidation!;
    expect(event.reason).toBe('newer_observation');
    expect(event.oldReceiptId).toBe(graph.id('R1'));
    expect(event.newReceiptId).toBe(change.receipt.id);
    expect(event.closure).toEqual({ depth: 4, nodes: 7, capped: false });
    expect(symbolic(graph, event.affected)).toEqual(
      sets({
        modelCallIds: ['M1', 'M2'],
        attemptIds: ['A1', 'A2'],
        outputIds: ['O1', 'O2'],
        actionIds: ['I2'],
        taskIds: ['T1', 'T2'],
      }),
    );
    expect(symbolicPerMission(graph, event)).toEqual([
      {
        missionId: 'm1',
        affected: sets({
          modelCallIds: ['M1', 'M2'],
          attemptIds: ['A1', 'A2'],
          outputIds: ['O1', 'O2'],
          actionIds: ['I2'],
          taskIds: ['T1', 'T2'],
        }),
        preserved: ['T3'],
      },
    ]);

    // marks: running attempts invalidated, succeeded tasks invalidated, outputs unusable, proposed intent blocked
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      A1: 'invalidated',
      A2: 'invalidated',
      A3: 'running',
      T1: 'invalidated',
      T2: 'invalidated',
      T3: 'succeeded',
      O1: 'unusable',
      O2: 'unusable',
      O3: 'usable',
      I2: 'blocked(stale_version)',
    });
    expect(change.marks).toMatchObject({
      attemptsInvalidated: [graph.id('A1'), graph.id('A2')].sort(),
      intentsBlocked: [graph.id('I2')],
    });
    await noLongerCurrent(graph, 'R1');
    await stillCurrent(graph, ['R9']);
    const { rows } = await getDb().app.query(
      'SELECT abort_reason FROM fx_coordinator.task_attempts WHERE id = $1',
      [graph.id('A1')],
    );
    expect(rows[0].abort_reason).toBe('readset_invalidated');
    const { rows: out } = await getDb().app.query(
      'SELECT unusable_reason FROM fx_coordinator.task_outputs WHERE id = $1',
      [graph.id('O1')],
    );
    expect(out[0].unusable_reason).toBe(`invalidated:${event.id}`);
  });

  it('the CTE agrees with the reference traversal over the stored edges', async () => {
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const stored = await listEdges(getDb().app);
    const reference = traverseClosure(
      stored
        .filter((edge) => edge.missionId === graph.id('m1'))
        .map((edge) => ({
          kind: edge.kind,
          fromKind: edge.from.kind,
          fromId: edge.from.id,
          toKind: edge.to.kind,
          toId: edge.to.id,
        })),
      { kind: 'receipt', id: graph.id('R1') },
    );
    expect(reference.nodes.map((n) => graph.symbol(n.id)).sort()).toEqual([
      'A1',
      'A2',
      'I2',
      'M1',
      'M2',
      'O1',
      'O2',
    ]);
  });

  it('a change to the unrelated receipt invalidates only its own branch (zero false invalidation)', async () => {
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const change = await changeReceipt(
      getDb().app,
      graph,
      'R9',
      'observed_digest_change',
    );
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({
        modelCallIds: ['M3'],
        attemptIds: ['A3'],
        outputIds: ['O3'],
        taskIds: ['T3'],
      }),
    );
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      A1: 'running',
      A2: 'running',
      A3: 'invalidated',
      T1: 'succeeded',
      T2: 'succeeded',
      T3: 'invalidated',
      O1: 'usable',
      O2: 'usable',
      O3: 'unusable',
      I2: 'proposed',
    });
    await stillCurrent(graph, ['R1']);
  });
});

describe('diamond and multiple parents', () => {
  const nodes = [
    receipt('Rl'),
    receipt('Rr'),
    receipt('Rs'),
    receipt('Rx'),
    task('TL', 'm1'),
    task('TR', 'm1'),
    task('TJ', 'm1'),
    task('TX', 'm1'),
    attempt('AL', 'm1', 'TL'),
    modelCall('ML', 'm1', 'TL'),
    output('OL', 'm1', 'TL'),
    attempt('AR', 'm1', 'TR'),
    modelCall('MR', 'm1', 'TR'),
    output('OR', 'm1', 'TR'),
    attempt('AJ', 'm1', 'TJ'),
    modelCall('MJ', 'm1', 'TJ'),
    output('OJ', 'm1', 'TJ'),
    intent('IJ', 'm1', 'TJ'),
    attempt('AX', 'm1', 'TX'),
    modelCall('MX', 'm1', 'TX'),
    output('OX', 'm1', 'TX'),
  ];
  const edges = [
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
  const options = {
    receipts: {
      Rl: { key: 'checkout.config/cache.schema_version' },
      Rr: { key: 'redis.stats' },
      Rs: { key: 'checkout.health' },
      Rx: { key: 'checkout.orders.recent' },
    },
    intentStatus: { IJ: 'admitted' },
  };

  it('one arm changes: that arm and the join (with its admitted intent) are affected, the other arm survives', async () => {
    await seedConfig(getDb().app, { 'cache.schema_version': 4 });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rl',
      'member_value_change',
    );
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({
        modelCallIds: ['MJ', 'ML'],
        attemptIds: ['AJ', 'AL'],
        outputIds: ['OJ', 'OL'],
        actionIds: ['IJ'],
        taskIds: ['TJ', 'TL'],
      }),
    );
    expect(
      symbolicPerMission(graph, change.invalidation!)[0].preserved,
    ).toEqual(['TR', 'TX']);
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      IJ: 'blocked(stale_version)',
      OR: 'usable',
      OX: 'usable',
      TR: 'succeeded',
    });
    await stillCurrent(graph, ['Rr', 'Rs', 'Rx']);
  });

  it('the shared root changes: both arms and the join, each exactly once', async () => {
    await seedConfig(getDb().app, { 'cache.schema_version': 4 });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rs',
      'observed_digest_change',
    );
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({
        modelCallIds: ['MJ', 'ML', 'MR'],
        attemptIds: ['AJ', 'AL', 'AR'],
        outputIds: ['OJ', 'OL', 'OR'],
        actionIds: ['IJ'],
        taskIds: ['TJ', 'TL', 'TR'],
      }),
    );
    expect(
      symbolicPerMission(graph, change.invalidation!)[0].preserved,
    ).toEqual(['TX']);
  });
});

describe('multiple parents are conservative', () => {
  it('either parent changing invalidates the node and the child that inherited it', async () => {
    const nodes = [
      receipt('Ra'),
      receipt('Rb'),
      task('TP', 'm1'),
      task('TQ', 'm1'),
      attempt('AP', 'm1', 'TP'),
      modelCall('MP', 'm1', 'TP'),
      output('OP', 'm1', 'TP'),
      attempt('AQ', 'm1', 'TQ'),
      modelCall('MQ', 'm1', 'TQ'),
      output('OQ', 'm1', 'TQ'),
    ];
    const edges = [
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
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: { Ra: { key: 'checkout.metrics' }, Rb: { key: 'redis.stats' } },
    });
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rb',
      'observed_digest_change',
    );
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({
        modelCallIds: ['MP', 'MQ'],
        attemptIds: ['AP', 'AQ'],
        outputIds: ['OP', 'OQ'],
        taskIds: ['TP', 'TQ'],
      }),
    );
    await stillCurrent(graph, ['Ra']);
  });
});

describe('per-mission partition (I10)', () => {
  const nodes = [
    receipt('Rsh'),
    receipt('Ro'),
    task('Tm1', 'm1'),
    task('Tm2', 'm2'),
    task('Tm2b', 'm2'),
    task('Tm3', 'm3'),
    attempt('Am1', 'm1', 'Tm1'),
    modelCall('Mm1', 'm1', 'Tm1'),
    output('Om1', 'm1', 'Tm1'),
    attempt('Am2', 'm2', 'Tm2'),
    modelCall('Mm2', 'm2', 'Tm2'),
    output('Om2', 'm2', 'Tm2'),
    attempt('Am2b', 'm2', 'Tm2b'),
    output('Om2b', 'm2', 'Tm2b'),
    attempt('Am3', 'm3', 'Tm3'),
    output('Om3', 'm3', 'Tm3'),
  ];
  const edges = [
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
  const options = {
    receipts: {
      Rsh: { key: 'checkout.config/db.pool_max' },
      Ro: { key: 'checkout.health' },
    },
  };

  it('a receipt shared by two missions: one global event, each mission its own subset, the third mission nothing', async () => {
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rsh',
      'member_value_change',
    );
    const event = change.invalidation!;
    expect(event.missionIds.map((id) => graph.symbol(id)).sort()).toEqual([
      'm1',
      'm2',
    ]);
    expect(symbolic(graph, event.affected).attemptIds).toEqual(['Am1', 'Am2']);
    expect(symbolicPerMission(graph, event)).toEqual([
      {
        missionId: 'm1',
        affected: sets({
          modelCallIds: ['Mm1'],
          attemptIds: ['Am1'],
          outputIds: ['Om1'],
          taskIds: ['Tm1'],
        }),
        preserved: [],
      },
      {
        missionId: 'm2',
        affected: sets({
          modelCallIds: ['Mm2'],
          attemptIds: ['Am2'],
          outputIds: ['Om2'],
          taskIds: ['Tm2'],
        }),
        preserved: ['Tm2b'],
      },
    ]);

    // each mission's stream receives only its own subset
    const m1 = eventForMission(event, graph.id('m1'))!;
    expect(m1.missionIds).toEqual([graph.id('m1')]);
    expect(JSON.stringify(m1)).not.toContain(graph.id('m2'));
    expect(JSON.stringify(m1)).not.toContain(graph.id('Am2'));
    expect(eventForMission(event, graph.id('m3'))).toBeNull();

    // and the read model filters the same way
    const forM2 = await listInvalidationEvents(getDb().app, {
      missionId: graph.id('m2'),
    });
    expect(forM2).toHaveLength(1);
    expect(forM2[0].affected.attemptIds).toEqual([graph.id('Am2')]);
    expect(
      await listInvalidationEvents(getDb().app, { missionId: graph.id('m3') }),
    ).toEqual([]);
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      Om3: 'usable',
      Om2b: 'usable',
      Tm2b: 'succeeded',
    });
  });
});

describe('simultaneous invalidations', () => {
  const nodes = [
    receipt('Rp'),
    receipt('Rq'),
    receipt('Ru'),
    task('Tp', 'm1'),
    task('Tq', 'm1'),
    task('Ts', 'm1'),
    task('Tu', 'm1'),
    attempt('Ap', 'm1', 'Tp'),
    output('Op', 'm1', 'Tp'),
    attempt('Aq', 'm1', 'Tq'),
    output('Oq', 'm1', 'Tq'),
    attempt('As', 'm1', 'Ts'),
    modelCall('Ms', 'm1', 'Ts'),
    output('Os', 'm1', 'Ts'),
    intent('Is', 'm1', 'Ts'),
    attempt('Au', 'm1', 'Tu'),
    output('Ou', 'm1', 'Tu'),
  ];
  const edges = [
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

  it('two changes meeting on shared nodes, in lock step, both commit without deadlock', async () => {
    await seedConfig(getDb().app, {
      'db.pool_max': 3,
      'db.statement_timeout_ms': 800,
    });
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: {
        Rp: { key: 'checkout.config/db.pool_max' },
        Rq: { key: 'checkout.config/db.statement_timeout_ms' },
        Ru: { key: 'checkout.health' },
      },
      attemptStatus: {
        Ap: 'running',
        Aq: 'running',
        As: 'running',
        Au: 'running',
      },
    });
    const lockStep = barrier(2);
    const hooks = {
      afterPreliminaryRead: async () => {
        await withTimeout(
          lockStep.arrive(),
          5_000,
          'both registrations in flight',
        );
      },
    };
    const results = await withTimeout(
      Promise.all([
        changeReceipt(getDb().app, graph, 'Rp', 'member_value_change', hooks),
        changeReceipt(getDb().app, graph, 'Rq', 'member_value_change', hooks),
      ]),
      20_000,
      'simultaneous invalidations',
    );
    const events = results.map((r) => r.invalidation!);
    expect(events).toHaveLength(2);
    const union = new Set(
      events.flatMap((e) => symbolic(graph, e.affected).attemptIds),
    );
    expect([...union].sort()).toEqual(['Ap', 'Aq', 'As']);
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      Ap: 'invalidated',
      Aq: 'invalidated',
      As: 'invalidated',
      Au: 'running',
      Is: 'blocked(stale_version)',
      Os: 'unusable',
      Ou: 'usable',
      Tp: 'invalidated',
      Tq: 'invalidated',
      Ts: 'invalidated',
      Tu: 'succeeded',
    });
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.invalidation_events WHERE old_receipt_id = ANY($1::uuid[])',
        [[graph.id('Rp'), graph.id('Rq')]],
      ),
    ).toBe(2);
    await stillCurrent(graph, ['Ru']);
  });
});

describe('negative evidence and benign changes (C1/D1)', () => {
  const nodes = [
    receipt('Rcoll'),
    receipt('Rban'),
    receipt('Rh'),
    task('Tn', 'm1'),
    task('Tv', 'm1'),
    task('Tz', 'm1'),
    attempt('An', 'm1', 'Tn'),
    modelCall('Mn', 'm1', 'Tn'),
    output('On', 'm1', 'Tn'),
    intent('In', 'm1', 'Tn'),
    attempt('Av', 'm1', 'Tv'),
    output('Ov', 'm1', 'Tv'),
    attempt('Az', 'm1', 'Tz'),
    output('Oz', 'm1', 'Tz'),
  ];
  const edges = [
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
  const options = {
    receipts: {
      Rcoll: { key: 'checkout.config' },
      Rban: { key: 'checkout.config/ui.banner_text' },
      Rh: { key: 'checkout.health' },
    },
    intentStatus: { In: 'admitted' },
  };

  it('a key insert supersedes the collection receipt and invalidates the absence-based branch only', async () => {
    await seedConfig(getDb().app, {
      'ui.banner_text': 'one',
      'db.pool_max': 3,
    });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rcoll',
      'collection_insert',
    );
    expect(change.invalidation!.reason).toBe('collection_changed');
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({
        modelCallIds: ['Mn'],
        attemptIds: ['An'],
        outputIds: ['On'],
        actionIds: ['In'],
        taskIds: ['Tn'],
      }),
    );
    expect(
      symbolicPerMission(graph, change.invalidation!)[0].preserved,
    ).toEqual(['Tv', 'Tz']);
    expect((await coordinatorState(getDb().app, graph)).In).toBe(
      'blocked(stale_version)',
    );
    await stillCurrent(graph, ['Rban', 'Rh']);
  });

  it('a benign member value change (B1) invalidates the member branch, leaves the collection receipt and its branch', async () => {
    await seedConfig(getDb().app, {
      'ui.banner_text': 'one',
      'db.pool_max': 3,
    });
    const graph = await loadGraph(getDb().app, nodes, edges, options);
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rban',
      'member_value_change',
    );
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({ attemptIds: ['Av'], outputIds: ['Ov'], taskIds: ['Tv'] }),
    );
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      In: 'admitted',
      On: 'usable',
      Tn: 'succeeded',
    });
    await stillCurrent(graph, ['Rcoll', 'Rh']);
  });
});

describe('diverging scheduling and evidence edges (D8) and environments', () => {
  it('a scheduled successor without an evidence path is preserved', async () => {
    const nodes = [
      receipt('Rk1'),
      receipt('Rk2'),
      task('Ts1', 'm1'),
      task('Ts2', 'm1'),
      attempt('As1', 'm1', 'Ts1'),
      modelCall('Ms1', 'm1', 'Ts1'),
      output('Os1', 'm1', 'Ts1'),
      attempt('As2', 'm1', 'Ts2'),
      modelCall('Ms2', 'm1', 'Ts2'),
      output('Os2', 'm1', 'Ts2'),
    ];
    const edges = [
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
    await seedConfig(getDb().app, {
      'db.pool_max': 3,
      'routing.inventory_source': 'primary',
    });
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: {
        Rk1: { key: 'checkout.config/db.pool_max' },
        Rk2: { key: 'checkout.config/routing.inventory_source' },
      },
    });
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rk1',
      'member_value_change',
    );
    expect(symbolic(graph, change.invalidation!.affected).taskIds).toEqual([
      'Ts1',
    ]);
    expect(
      symbolicPerMission(graph, change.invalidation!)[0].preserved,
    ).toEqual(['Ts2']);
    expect((await coordinatorState(getDb().app, graph)).Os2).toBe('usable');
  });

  it('the same key in two environments: no collision, no cross invalidation', async () => {
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const nodes = [
      receipt('Rt'),
      receipt('Re'),
      task('Tt', 'm1'),
      task('Te', 'm2'),
      attempt('At', 'm1', 'Tt'),
      output('Ot', 'm1', 'Tt'),
      attempt('Ae', 'm2', 'Te'),
      output('Oe', 'm2', 'Te'),
    ];
    const edges = [
      ev('Rt', 'At'),
      ev('At', 'Ot'),
      ev('Re', 'Ae'),
      ev('Ae', 'Oe'),
    ];
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: {
        Rt: { key: 'checkout.config/db.pool_max', environment: 'test' },
        Re: { key: 'checkout.config/db.pool_max', environment: 'eval' },
      },
    });
    expect(graph.id('Rt')).not.toBe(graph.id('Re'));
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rt',
      'member_value_change',
    );
    // both environments watch the same authority row, but each source is its own ledger entry
    expect(symbolic(graph, change.invalidation!.affected)).toEqual(
      sets({ attemptIds: ['At'], outputIds: ['Ot'], taskIds: ['Tt'] }),
    );
    expect((await coordinatorState(getDb().app, graph)).Oe).toBe('usable');
  });
});

describe('selective CAS marks (CL-9 shape)', () => {
  it('only proposed/admitted intents are blocked, only running attempts invalidated; terminal rows keep their state', async () => {
    const nodes = [
      receipt('Rv'),
      task('Tw', 'm1'),
      attempt('Aw', 'm1', 'Tw'),
      modelCall('Mw', 'm1', 'Tw'),
      intent('Iw1', 'm1', 'Tw'),
      intent('Iw2', 'm1', 'Tw'),
      intent('Iw3', 'm1', 'Tw'),
      intent('Iw4', 'm1', 'Tw'),
      intent('Iw5', 'm1', 'Tw'),
      output('Ow', 'm1', 'Tw'),
    ];
    const edges = [
      ev('Rv', 'Aw'),
      ev('Rv', 'Mw'),
      ev('Mw', 'Iw1'),
      ev('Mw', 'Iw2'),
      ev('Mw', 'Iw3'),
      ev('Mw', 'Iw4'),
      ev('Mw', 'Iw5'),
      ev('Mw', 'Ow'),
      ev('Aw', 'Ow'),
    ];
    await seedConfig(getDb().app, { 'orders.write_enabled': true });
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: { Rv: { key: 'checkout.config/orders.write_enabled' } },
      attemptStatus: { Aw: 'published' },
      intentStatus: {
        Iw1: 'verified',
        Iw2: 'blocked',
        Iw3: 'proposed',
        Iw4: 'committed',
        Iw5: 'admitted',
      },
    });
    const change = await changeReceipt(
      getDb().app,
      graph,
      'Rv',
      'member_value_change',
    );
    expect(symbolic(graph, change.invalidation!.affected).actionIds).toEqual([
      'Iw1',
      'Iw2',
      'Iw3',
      'Iw4',
      'Iw5',
    ]);
    const after = await coordinatorState(getDb().app, graph);
    expect(after).toMatchObject({
      Iw1: 'verified',
      Iw2: 'blocked',
      Iw3: 'blocked(stale_version)',
      Iw4: 'committed',
      Iw5: 'blocked(stale_version)',
      Aw: 'published',
      Tw: 'invalidated',
      Ow: 'unusable',
    });
  });

  it('a concurrent commit that holds the intent row is serialized: the closure waits and then sees the committed state', async () => {
    const nodes = [
      receipt('R'),
      task('T', 'm1'),
      attempt('A', 'm1', 'T'),
      modelCall('M', 'm1', 'T'),
      intent('I', 'm1', 'T'),
    ];
    const edges = [ev('R', 'A'), ev('R', 'M'), ev('M', 'I'), ev('A', 'I')];
    await seedConfig(getDb().app, { 'db.pool_max': 3 });
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: { R: { key: 'checkout.config/db.pool_max' } },
      intentStatus: { I: 'admitted' },
    });
    const committer = await getDb().app.connect();
    try {
      await committer.query('BEGIN');
      await committer.query(
        'SELECT id FROM fx_coordinator.action_intents WHERE id = $1 FOR UPDATE',
        [graph.id('I')],
      );
      const invalidation = changeReceipt(
        getDb().app,
        graph,
        'R',
        'member_value_change',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      // the commit transaction finishes first: committed, not blocked
      await committer.query(
        "UPDATE fx_coordinator.action_intents SET status = 'committed', status_version = status_version + 1 WHERE id = $1",
        [graph.id('I')],
      );
      await committer.query('COMMIT');
      await withTimeout(invalidation, 10_000, 'closure after the commit');
    } finally {
      committer.release();
    }
    expect((await coordinatorState(getDb().app, graph)).I).toBe('committed');
  });
});

describe('retraction and expiry run the closure with no replacement', () => {
  it('retracting a receipt invalidates its dependents with reason retraction and newReceiptId null', async () => {
    const nodes = [
      receipt('R'),
      task('T', 'm1'),
      attempt('A', 'm1', 'T'),
      output('O', 'm1', 'T'),
    ];
    const edges = [ev('R', 'A'), ev('A', 'O')];
    const graph = await loadGraph(getDb().app, nodes, edges, {
      receipts: { R: { key: 'checkout.health' } },
      attemptStatus: { A: 'running' },
    });
    const result = await inTx(getDb().app, (client) =>
      transitionReceipt(
        client,
        {
          receiptId: graph.id('R'),
          to: 'retracted',
          reason: 'owner_retraction',
        },
        { ledger: FX },
      ),
    );
    expect(result.receipt.status).toBe('retracted');
    expect(result.invalidation).toMatchObject({
      reason: 'retraction',
      newReceiptId: null,
      oldReceiptId: graph.id('R'),
    });
    expect(symbolic(graph, result.invalidation!.affected)).toEqual(
      sets({ attemptIds: ['A'], outputIds: ['O'], taskIds: ['T'] }),
    );
    expect(await coordinatorState(getDb().app, graph)).toMatchObject({
      A: 'invalidated',
      O: 'unusable',
    });
  });

  it('contesting a receipt blocks at assertCurrent but does not invalidate dependents (it is reversible)', async () => {
    const nodes = [
      receipt('R'),
      task('T', 'm1'),
      attempt('A', 'm1', 'T'),
      output('O', 'm1', 'T'),
    ];
    const graph = await loadGraph(
      getDb().app,
      nodes,
      [ev('R', 'A'), ev('A', 'O')],
      {
        receipts: { R: { key: 'checkout.health' } },
        attemptStatus: { A: 'running' },
      },
    );
    const result = await inTx(getDb().app, (client) =>
      transitionReceipt(
        client,
        {
          receiptId: graph.id('R'),
          to: 'contested',
          reason: 'conflicting_observation',
        },
        { ledger: FX },
      ),
    );
    expect(result.invalidation).toBeNull();
    expect(await coordinatorState(getDb().app, graph)).toMatchObject({
      A: 'running',
      O: 'usable',
    });
  });
});

describe('caps (C14)', () => {
  async function observedHead(key: string) {
    const scope = newScope();
    const first = await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, key),
          normalizedValue: { rev: 1 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX },
      ),
    );
    return { scope, first };
  }

  async function bulkFan(receiptId: string, missionId: string, size: number) {
    const taskId = randomUUID();
    await getDb().admin.query(
      `INSERT INTO ledger.dependency_nodes (kind, id, mission_id, task_id)
       SELECT 'attempt', gen_random_uuid(), $2::uuid, $3::uuid FROM generate_series(1, $1::int)`,
      [size, missionId, taskId],
    );
    await getDb().admin.query(
      `INSERT INTO ledger.dependency_edges (id, mission_id, kind, from_kind, from_id, to_kind, to_id)
       SELECT gen_random_uuid(), $2::uuid, 'evidence', 'receipt', $1::uuid, 'attempt', n.id
         FROM ledger.dependency_nodes n WHERE n.kind = 'attempt' AND n.mission_id = $2::uuid`,
      [receiptId, missionId],
    );
  }

  it('10001 reached nodes: ClosureCapExceeded, no receipt row; registerWithoutClosure then succeeds with a capped event', async () => {
    const { scope, first } = await observedHead('checkout.health');
    const missionId = randomUUID();
    await bulkFan(first.receipt.id, missionId, 10_001);
    const { app } = getDb();
    const before = await count(
      app,
      'SELECT count(*) AS n FROM ledger.observation_receipts WHERE source_id = (SELECT source_id FROM ledger.observation_receipts WHERE id = $1)',
      [first.receipt.id],
    );

    const attempt = () =>
      inTx(app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef(scope, 'checkout.health'),
            normalizedValue: { rev: 2 },
            provenance: { kind: 'watcher' },
          },
          { ledger: FX, marker: null },
        ),
      );
    const error = await attempt().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClosureCapExceeded);
    expect(error).toMatchObject({
      cap: 'nodes',
      code: 'closure_cap_exceeded',
      oldReceiptId: first.receipt.id,
      missionIds: [missionId],
    });
    expect(
      await count(
        app,
        'SELECT count(*) AS n FROM ledger.observation_receipts WHERE source_id = (SELECT source_id FROM ledger.observation_receipts WHERE id = $1)',
        [first.receipt.id],
      ),
    ).toBe(before);
    expect(
      await count(
        app,
        "SELECT count(*) AS n FROM ledger.observation_receipts WHERE id = $1 AND status = 'supported'",
        [first.receipt.id],
      ),
    ).toBe(1);

    const coarseAffected = {
      modelCallIds: [],
      attemptIds: [],
      outputIds: [],
      actionIds: [],
      taskIds: [],
    };
    const registered = await inTx(app, (client) =>
      registerWithoutClosure(
        client,
        {
          source: sourceRef(scope, 'checkout.health'),
          normalizedValue: { rev: 2 },
          provenance: { kind: 'watcher' },
        },
        {
          ledger: FX,
          coarse: {
            perMission: [
              {
                missionId: missionId as never,
                affected: coarseAffected as never,
                preserved: { taskIds: [] },
              },
            ],
            nodes: 10_001,
          },
        },
      ),
    );
    expect(registered.receipt.sourceRevision).toBe(2);
    expect(registered.supersededReceiptId).toBe(first.receipt.id);
    expect(registered.invalidation).toMatchObject({
      reason: 'closure_cap_exceeded',
      closure: { capped: true, depth: 0, nodes: 10_001 },
      missionIds: [missionId],
    });
    expect(registered.marks).toBeNull();
    const stored = await getInvalidationEvent(app, registered.invalidation!.id);
    expect(stored).toEqual(registered.invalidation);
    expect(
      await count(
        app,
        "SELECT count(*) AS n FROM ledger.observation_receipts WHERE id = $1 AND status = 'superseded'",
        [first.receipt.id],
      ),
    ).toBe(1);
  });

  it('exactly 10000 reached nodes is within the cap', async () => {
    const { scope, first } = await observedHead('checkout.metrics');
    await bulkFan(first.receipt.id, randomUUID(), 10_000);
    const result = await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(scope, 'checkout.metrics'),
          normalizedValue: { rev: 2 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    expect(result.invalidation!.closure).toEqual({
      depth: 1,
      nodes: 10_000,
      capped: false,
    });
    expect(result.invalidation!.affected.attemptIds).toHaveLength(10_000);
  });

  it('a chain deeper than 64 exceeds the depth cap; 64 is accepted', async () => {
    const chain = async (key: string, length: number) => {
      const { scope, first } = await observedHead(key);
      const missionId = randomUUID();
      const taskId = randomUUID();
      await getDb().admin.query(
        `WITH ids AS (SELECT gen_random_uuid() AS id, n FROM generate_series(1, $1::int) n),
         nodes AS (INSERT INTO ledger.dependency_nodes (kind, id, mission_id, task_id)
                   SELECT 'attempt', id, $2::uuid, $3::uuid FROM ids RETURNING id)
         INSERT INTO ledger.dependency_edges (id, mission_id, kind, from_kind, from_id, to_kind, to_id)
         SELECT gen_random_uuid(), $2::uuid, 'evidence',
                CASE WHEN cur.n = 1 THEN 'receipt' ELSE 'attempt' END,
                CASE WHEN cur.n = 1 THEN $4::uuid ELSE prev.id END,
                'attempt', cur.id
           FROM ids cur LEFT JOIN ids prev ON prev.n = cur.n - 1`,
        [length, missionId, taskId, first.receipt.id],
      );
      return { scope, first, missionId };
    };
    const over = await chain('checkout.health', 70);
    const error = await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(over.scope, 'checkout.health'),
          normalizedValue: { rev: 2 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClosureCapExceeded);
    expect(error).toMatchObject({ cap: 'depth', missionIds: [over.missionId] });

    const atCap = await chain('checkout.metrics', 64);
    const ok = await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(atCap.scope, 'checkout.metrics'),
          normalizedValue: { rev: 2 },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    expect(ok.invalidation!.closure).toEqual({
      depth: 64,
      nodes: 64,
      capped: false,
    });
  });
});

describe('supersedeAndInvalidate called directly, and resolution', () => {
  it('registers the replacement, supersedes the prior head and records one event; the coordinator resolves it later', async () => {
    const nodes = [receipt('R'), task('T', 'm1'), attempt('A', 'm1', 'T')];
    const graph = await loadGraph(getDb().app, nodes, [ev('R', 'A')], {
      receipts: { R: { key: 'checkout.health' } },
    });
    const { app } = getDb();
    const prior = await app.query(
      'SELECT id FROM ledger.observation_receipts WHERE id = $1',
      [graph.id('R')],
    );
    expect(prior.rows).toHaveLength(1);
    const change = await changeReceipt(
      app,
      graph,
      'R',
      'observed_digest_change',
    );
    const event = change.invalidation!;
    expect(event.resolvedAt).toBeNull();
    expect(await listInvalidationEvents(app, { unresolvedOnly: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: event.id })]),
    );
    expect(await markInvalidationResolved(app, event.id)).toBe(true);
    expect(await markInvalidationResolved(app, event.id)).toBe(false);
    const resolved = await getInvalidationEvent(app, event.id);
    expect(resolved!.resolvedAt).not.toBeNull();
    // the rest of the event is immutable
    await expect(
      app.query(
        "UPDATE ledger.invalidation_events SET reason = 'expiry' WHERE id = $1",
        [event.id],
      ),
    ).rejects.toThrow(/append-only/);
    expect(typeof supersedeAndInvalidate).toBe('function');
  });
});

describe('edge graph integrity', () => {
  const ids = () => ({
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    mission: randomUUID(),
    task: randomUUID(),
  });
  const node = (
    kind: 'attempt' | 'task_output' | 'model_call',
    id: string,
    mission: string,
    task: string,
  ) => ({
    kind,
    id,
    missionId: mission,
    taskId: task,
  });

  it('rejects an edge that closes a cycle (newer back to older), writing nothing, even with earlier edges in the batch', async () => {
    const { a, b, c, mission, task: taskId } = ids();
    const [na, nb, nc] = [
      node('attempt', a, mission, taskId),
      node('task_output', b, mission, taskId),
      node('model_call', c, mission, taskId),
    ];
    await inTx(getDb().app, (client) =>
      addEdges(client, [
        { kind: 'evidence', from: na, to: nb },
        { kind: 'inheritance', from: nb, to: nc },
      ]),
    );
    const before = await count(
      getDb().app,
      'SELECT count(*) AS n FROM ledger.dependency_edges',
    );
    const fresh = randomUUID();
    await expect(
      inTx(getDb().app, (client) =>
        addEdges(client, [
          {
            kind: 'evidence',
            from: nc,
            to: node('attempt', fresh, mission, taskId),
          },
          { kind: 'evidence', from: nc, to: na },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'edge_cycle' });
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.dependency_edges',
      ),
    ).toBe(before);
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.dependency_nodes WHERE id = $1',
        [fresh],
      ),
    ).toBe(0);
  });

  it('is idempotent per edge and refuses an edge between two missions', async () => {
    const { a, b, mission, task: taskId } = ids();
    const edge = {
      kind: 'evidence' as const,
      from: node('attempt', a, mission, taskId),
      to: node('task_output', b, mission, taskId),
    };
    expect(await inTx(getDb().app, (c) => addEdges(c, [edge]))).toEqual({
      inserted: 1,
      existing: 0,
    });
    expect(await inTx(getDb().app, (c) => addEdges(c, [edge]))).toEqual({
      inserted: 0,
      existing: 1,
    });
    await expect(
      inTx(getDb().app, (c) =>
        addEdges(c, [
          {
            kind: 'evidence',
            from: node('attempt', a, mission, taskId),
            to: node('task_output', randomUUID(), randomUUID(), taskId),
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(EdgeError);
  });

  it('two transactions each adding half of a cycle: exactly one commits (advisory serialization)', async () => {
    const { a, b, mission, task: taskId } = ids();
    const na = node('attempt', a, mission, taskId);
    const nb = node('task_output', b, mission, taskId);
    await inTx(getDb().app, async (client) => {
      const { ensureNode } =
        await import('../../../../src/server/nemodots/ledger/index.js');
      await ensureNode(client, na);
      await ensureNode(client, nb);
    });
    const meet = barrier(2);
    const attempt = (from: typeof na, to: typeof nb) =>
      inTx(getDb().app, async (client) => {
        await withTimeout(meet.arrive(), 5_000, 'both writers');
        return addEdges(client, [{ kind: 'evidence', from, to }]);
      }).then(
        () => 'committed',
        (error: { code?: string }) => error.code ?? 'error',
      );
    const outcomes = await withTimeout(
      Promise.all([attempt(na, nb), attempt(nb, na)]),
      10_000,
      'cycle race',
    );
    expect(outcomes.sort()).toEqual(['committed', 'edge_cycle']);
  });

  it('scheduling edges stay among tasks and cannot loop', async () => {
    const { a, b, mission } = ids();
    const t1 = { kind: 'task' as const, id: a, missionId: mission };
    const t2 = { kind: 'task' as const, id: b, missionId: mission };
    await inTx(getDb().app, (c) =>
      addEdges(c, [{ kind: 'scheduling', from: t1, to: t2 }]),
    );
    await expect(
      inTx(getDb().app, (c) =>
        addEdges(c, [{ kind: 'scheduling', from: t2, to: t1 }]),
      ),
    ).rejects.toMatchObject({ code: 'edge_cycle' });
    // an evidence edge in the opposite direction is a different class and is allowed
    await expect(
      inTx(getDb().app, (c) =>
        addEdges(c, [{ kind: 'evidence', from: t2, to: t1 }]),
      ),
    ).resolves.toEqual({ inserted: 1, existing: 0 });
  });
});
