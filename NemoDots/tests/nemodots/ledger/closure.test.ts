// Pure closure logic: reachability over evidence + inheritance edges only,
// R2 task derivation, R3 preserved sets, per-mission partition (finding I10)
// and the depth / node caps. Every expected set below is enumerated by hand
// from the drawn graph, not computed by the code under test.
import { describe, expect, it } from 'vitest';
import {
  buildClosure,
  traverseClosure,
  type ClosureResult,
} from '../../../src/server/nemodots/ledger/closure.js';
import {
  attempt,
  buildGraph,
  ev,
  inh,
  intent,
  modelCall,
  output,
  receipt,
  sch,
  task,
} from './graph-dsl.js';

function closureOf(
  graph: ReturnType<typeof buildGraph>,
  rootId: string,
  limits?: { maxDepth: number; maxNodes: number },
): { reached: string[]; result: ClosureResult; depth: number } {
  const traversal = traverseClosure(graph.records, { kind: 'receipt', id: rootId }, limits);
  expect(traversal.exceeded).toBeNull();
  const result = buildClosure(
    traversal.nodes.map((node) => graph.meta(node.id)),
    graph.tasksByMission,
  );
  return {
    reached: traversal.nodes.map((node) => node.id).sort(),
    result,
    depth: traversal.depth,
  };
}

describe('linear chain with an inherited child', () => {
  //   R1 -> A1,M1 -> O1 =inh=> A2,M2 -> I2(proposed), O2     [T1 -> T2]
  //   R9 -> A3,M3 -> O3                                       [T3]
  //   T1 --scheduling--> T3
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

  it('reaches exactly the hand-enumerated nodes and preserves the scheduled sibling', () => {
    const { reached, result, depth } = closureOf(buildGraph(nodes, edges), 'R1');
    expect(reached).toEqual(['A1', 'A2', 'I2', 'M1', 'M2', 'O1', 'O2']);
    expect(result.affected).toEqual({
      modelCallIds: ['M1', 'M2'],
      attemptIds: ['A1', 'A2'],
      outputIds: ['O1', 'O2'],
      actionIds: ['I2'],
      taskIds: ['T1', 'T2'],
    });
    expect(result.perMission).toEqual([
      {
        missionId: 'm1',
        affected: result.affected,
        preserved: { taskIds: ['T3'] },
      },
    ]);
    expect(depth).toBe(4); // R1 -> A1 -> O1 -> A2 -> I2
  });

  it('a change to the unrelated receipt leaves the first branch alone (zero false invalidation)', () => {
    const { reached, result } = closureOf(buildGraph(nodes, edges), 'R9');
    expect(reached).toEqual(['A3', 'M3', 'O3']);
    expect(result.affected.taskIds).toEqual(['T3']);
    expect(result.perMission[0].preserved.taskIds).toEqual(['T1', 'T2']);
  });

  it('scheduling edges never propagate', () => {
    const graph = buildGraph(nodes, [sch('T1', 'T3'), sch('T3', 'T2'), ev('R1', 'A1')]);
    const { reached } = closureOf(graph, 'R1');
    expect(reached).toEqual(['A1']);
  });
});

describe('diamond', () => {
  //   Rl -> AL,ML -> OL =inh=> AJ,MJ -> OJ, IJ(admitted)
  //   Rr -> AR,MR -> OR =inh=> AJ,MJ
  //   Rs -> AL,ML,AR,MR   Rx -> AX,MX -> OX (unrelated)
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

  it('changing one arm affects that arm and the join, not the other arm', () => {
    const { result } = closureOf(buildGraph(nodes, edges), 'Rl');
    expect(result.affected).toEqual({
      modelCallIds: ['MJ', 'ML'],
      attemptIds: ['AJ', 'AL'],
      outputIds: ['OJ', 'OL'],
      actionIds: ['IJ'],
      taskIds: ['TJ', 'TL'],
    });
    expect(result.perMission[0].preserved.taskIds).toEqual(['TR', 'TX']);
  });

  it('changing the shared root affects both arms and the join once (no duplicates)', () => {
    const { result, reached } = closureOf(buildGraph(nodes, edges), 'Rs');
    expect(reached).toEqual([
      'AJ', 'AL', 'AR', 'IJ', 'MJ', 'ML', 'MR', 'OJ', 'OL', 'OR',
    ]);
    expect(result.affected.taskIds).toEqual(['TJ', 'TL', 'TR']);
    expect(result.affected.modelCallIds).toEqual(['MJ', 'ML', 'MR']);
    expect(result.perMission[0].preserved.taskIds).toEqual(['TX']);
  });
});

describe('multiple parents (conservative, R6)', () => {
  //   Ra, Rb -> AP, MP -> OP =inh=> AQ, MQ -> OQ
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
    ev('Ra', 'AP'), ev('Rb', 'AP'), ev('Ra', 'MP'), ev('Rb', 'MP'),
    ev('MP', 'OP'), ev('AP', 'OP'),
    inh('OP', 'AQ'), inh('OP', 'MQ'), ev('MQ', 'OQ'), ev('AQ', 'OQ'),
  ];

  it('either parent changing invalidates the node and everything downstream', () => {
    for (const root of ['Ra', 'Rb']) {
      const { result } = closureOf(buildGraph(nodes, edges), root);
      expect(result.affected).toEqual({
        modelCallIds: ['MP', 'MQ'],
        attemptIds: ['AP', 'AQ'],
        outputIds: ['OP', 'OQ'],
        actionIds: [],
        taskIds: ['TP', 'TQ'],
      });
      expect(result.perMission[0].preserved.taskIds).toEqual([]);
    }
  });
});

describe('per-mission partition (I10)', () => {
  //   Rsh -> (m1) Am1,Mm1 -> Om1 ; (m2) Am2,Mm2 -> Om2   Ro -> Am2b (m2), Am3 (m3)
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
    ev('Rsh', 'Am1'), ev('Rsh', 'Mm1'), ev('Mm1', 'Om1'), ev('Am1', 'Om1'),
    ev('Rsh', 'Am2'), ev('Rsh', 'Mm2'), ev('Mm2', 'Om2'), ev('Am2', 'Om2'),
    ev('Ro', 'Am2b'), ev('Am2b', 'Om2b'), ev('Ro', 'Am3'), ev('Am3', 'Om3'),
  ];

  it('each mission receives only its own subset; a mission with no affected node gets no entry', () => {
    const { result } = closureOf(buildGraph(nodes, edges), 'Rsh');
    expect(result.missionIds).toEqual(['m1', 'm2']);
    expect(result.perMission).toEqual([
      {
        missionId: 'm1',
        affected: {
          modelCallIds: ['Mm1'], attemptIds: ['Am1'], outputIds: ['Om1'],
          actionIds: [], taskIds: ['Tm1'],
        },
        preserved: { taskIds: [] },
      },
      {
        missionId: 'm2',
        affected: {
          modelCallIds: ['Mm2'], attemptIds: ['Am2'], outputIds: ['Om2'],
          actionIds: [], taskIds: ['Tm2'],
        },
        preserved: { taskIds: ['Tm2b'] },
      },
    ]);
    // the global set is the union of the partitions
    expect(result.affected.attemptIds).toEqual(['Am1', 'Am2']);
    expect(JSON.stringify(result.perMission[0])).not.toContain('m2');
  });

  it('the m3-only receipt touches m2 and m3 but never m1', () => {
    const { result } = closureOf(buildGraph(nodes, edges), 'Ro');
    expect(result.missionIds).toEqual(['m2', 'm3']);
    expect(result.perMission[0].preserved.taskIds).toEqual(['Tm2']);
  });
});

describe('caps', () => {
  const chain = (length: number) => {
    const nodes = [receipt('R0')];
    const edges = [];
    let previous = 'R0';
    for (let i = 1; i <= length; i += 1) {
      const id = `A${i}`;
      nodes.push(attempt(id, 'm1', 'T1'));
      edges.push(ev(previous, id));
      previous = id;
    }
    return buildGraph(nodes, edges);
  };

  it('accepts a closure exactly at the depth cap and rejects one deeper', () => {
    const limits = { maxDepth: 64, maxNodes: 10_000 };
    const atCap = traverseClosure(chain(64).records, { kind: 'receipt', id: 'R0' }, limits);
    expect(atCap.exceeded).toBeNull();
    expect(atCap.depth).toBe(64);
    const over = traverseClosure(chain(70).records, { kind: 'receipt', id: 'R0' }, limits);
    expect(over.exceeded).toBe('depth');
  });

  it('accepts exactly maxNodes reached nodes and rejects one more', () => {
    const fan = (n: number) =>
      buildGraph(
        [receipt('R0'), ...Array.from({ length: n }, (_, i) => attempt(`A${i}`, 'm1', 'T1'))],
        Array.from({ length: n }, (_, i) => ev('R0', `A${i}`)),
      );
    const limits = { maxDepth: 64, maxNodes: 50 };
    expect(traverseClosure(fan(50).records, { kind: 'receipt', id: 'R0' }, limits).exceeded).toBeNull();
    expect(traverseClosure(fan(51).records, { kind: 'receipt', id: 'R0' }, limits).exceeded).toBe('nodes');
  });

  it('a cycle that slipped past the edge checks hits the depth cap instead of looping', () => {
    const graph = buildGraph(
      [receipt('R0'), attempt('A1', 'm1', 'T1'), output('O1', 'm1', 'T1')],
      [ev('R0', 'A1'), ev('A1', 'O1'), ev('O1', 'A1')],
    );
    expect(
      traverseClosure(graph.records, { kind: 'receipt', id: 'R0' }, { maxDepth: 64, maxNodes: 10_000 })
        .exceeded,
    ).toBe('depth');
  });
});

describe('buildClosure edge cases', () => {
  it('a receipt with no consumers has an empty closure and no per-mission entry', () => {
    const result = buildClosure([], new Map());
    expect(result.nodes).toBe(0);
    expect(result.perMission).toEqual([]);
    expect(result.affected.taskIds).toEqual([]);
  });

  it('nodes without a mission count globally but belong to no mission partition', () => {
    const graph = buildGraph(
      [receipt('R'), { id: 'A', kind: 'attempt', missionId: null, taskId: null }],
      [ev('R', 'A')],
    );
    const { result } = closureOf(graph, 'R');
    expect(result.affected.attemptIds).toEqual(['A']);
    expect(result.perMission).toEqual([]);
  });
});
