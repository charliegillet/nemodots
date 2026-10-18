// The three recovery-scope arms, on hand-enumerated graphs. Only the scope
// differs between arms (CONTRACTS rev3); these are pure functions.
import { describe, expect, it } from 'vitest';
import type {
  RecoveryScopeTask,
  TaskId,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  STRATEGY_RULES,
  broadRestart,
  dagRestart,
  ruleFor,
  schedulingDescendants,
  selective,
} from '../../../src/server/nemodots/evals/strategies/index.js';
import { STRATEGIES } from '../../../src/server/nemodots/evals/types.js';

const id = (name: string) => name as TaskId;
const task = (
  name: string,
  extra: Partial<RecoveryScopeTask> = {},
): RecoveryScopeTask => ({
  id: id(name),
  parentId: null,
  prerequisites: [],
  role: 'investigator',
  status: 'succeeded',
  ...extra,
});

// diverging_edges: route is scheduled after cache but reads none of its evidence
const tasks: RecoveryScopeTask[] = [
  task('plan', { role: 'planner' }),
  task('cache'),
  task('route', { prerequisites: [id('cache')] }),
  task('verify', { role: 'verifier', parentId: id('cache') }),
  task('extra'),
  task('failed', { status: 'failed' }),
  task('cancelled', { status: 'cancelled' }),
];
const input = {
  missionId: 'M' as never,
  closureTaskIds: [id('cache'), id('verify')],
  directReaderTaskIds: [id('cache')],
  tasks,
};

describe('recovery scope arms', () => {
  it('selective restarts exactly the evidence closure', () => {
    expect(selective.select(input).restartTaskIds).toEqual(['cache', 'verify']);
  });

  it('dag-restart adds everything scheduled after the direct readers (children and dependents), not unrelated work', () => {
    expect(dagRestart.select(input).restartTaskIds).toEqual([
      'cache',
      'route',
      'verify',
    ]);
  });

  it('broad-restart restarts every non-planner task that is not failed or cancelled, succeeded ones included', () => {
    expect(broadRestart.select(input).restartTaskIds).toEqual([
      'cache',
      'route',
      'verify',
      'extra',
    ]);
  });

  it('the arms differ only in scope: selective ⊆ dag-restart ⊆ broad-restart on this graph, and the differences are the ones the scenario predicts', () => {
    const [s, d, b] = [selective, dagRestart, broadRestart].map(
      (rule) => new Set(rule.select(input).restartTaskIds),
    );
    for (const task of s) expect(d.has(task)).toBe(true);
    for (const task of d) expect(b.has(task)).toBe(true);
    // route: dag-restart only (scheduling edge without evidence); extra: broad only
    expect([...d].filter((t) => !s.has(t))).toEqual(['route']);
    expect([...b].filter((t) => !d.has(t))).toEqual(['extra']);
  });

  it('dag-restart follows scheduling transitively and through children of dependents', () => {
    const chain: RecoveryScopeTask[] = [
      task('a'),
      task('b', { prerequisites: [id('a')] }),
      task('c', { prerequisites: [id('b')] }),
      task('d', { parentId: id('c'), role: 'verifier' }),
      task('x'),
    ];
    expect(
      dagRestart.select({
        missionId: 'M' as never,
        closureTaskIds: [],
        directReaderTaskIds: [id('a')],
        tasks: chain,
      }).restartTaskIds,
    ).toEqual(['a', 'b', 'c', 'd']);
    expect([...schedulingDescendants([id('x')], chain)]).toEqual(['x']);
  });

  it('selective ignores scheduling edges even when a task has many dependents', () => {
    const wide: RecoveryScopeTask[] = [
      task('root'),
      task('d1', { prerequisites: [id('root')] }),
      task('d2', { prerequisites: [id('root')] }),
    ];
    expect(
      selective.select({
        missionId: 'M' as never,
        closureTaskIds: [id('root')],
        directReaderTaskIds: [id('root')],
        tasks: wide,
      }).restartTaskIds,
    ).toEqual(['root']);
  });

  it('results follow the mission task order and mention only known tasks', () => {
    const out = selective.select({
      ...input,
      closureTaskIds: [id('verify'), id('cache'), id('ghost')],
    });
    expect(out.restartTaskIds).toEqual(['cache', 'verify']);
  });

  it('every strategy has a rule with a matching name, and the rules are pure', () => {
    for (const name of STRATEGIES) {
      expect(STRATEGY_RULES[name].name).toBe(name);
      expect(ruleFor(name)).toBe(STRATEGY_RULES[name]);
      const before = JSON.stringify(input);
      expect(STRATEGY_RULES[name].select(input)).toEqual(
        STRATEGY_RULES[name].select(input),
      );
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it('rule lookup is own-property only', () => {
    for (const name of ['constructor', 'toString', '__proto__'])
      expect(() => ruleFor(name as never)).toThrow(RangeError);
  });

  it('arm names describe behaviour and carry no product names', () => {
    for (const name of STRATEGIES)
      expect(name).not.toMatch(/graphiti|memtx|coagent|nemodots/i);
  });
});
