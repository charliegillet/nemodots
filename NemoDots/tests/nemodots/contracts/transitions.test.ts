import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';

// Expected edges transcribed independently from ARCHITECTURE.md section 7
// (7.1-7.5) and the "Allowed:" lines of CONTRACTS.md sections 2, 4 and 5.
// Every (from, to) pair NOT listed here must be forbidden.
const expected = {
  mission: {
    statuses: C.MissionStatusSchema.options,
    edges: [
      // 7.1: created -> running -> awaiting_acceptance -> succeeded
      'created>running',
      'running>awaiting_acceptance',
      'awaiting_acceptance>succeeded',
      // running <-> paused
      'running>paused',
      'paused>running',
      // running | paused | awaiting_acceptance -> cancelled (+ CONTRACTS: created, blocked_provider)
      'running>cancelled',
      'paused>cancelled',
      'awaiting_acceptance>cancelled',
      'created>cancelled',
      'blocked_provider>cancelled',
      // running | awaiting_acceptance -> failed
      'running>failed',
      'awaiting_acceptance>failed',
      // created -> blocked_provider -> created
      'created>blocked_provider',
      'blocked_provider>created',
      // CONTRACTS 4: awaiting_acceptance -> running (acceptance fails, work resumes)
      'awaiting_acceptance>running',
    ],
  },
  task: {
    statuses: C.TaskStatusSchema.options,
    edges: [
      'pending>runnable',
      'pending>cancelled',
      'runnable>leased',
      'runnable>cancelled',
      'leased>running',
      'leased>runnable',
      'leased>cancelled',
      'running>waiting',
      'running>succeeded',
      'running>failed',
      'running>invalidated',
      'running>cancelled',
      'waiting>running',
      'waiting>invalidated',
      'waiting>failed',
      'waiting>cancelled',
      'succeeded>invalidated',
      'invalidated>repairing',
      'invalidated>cancelled',
      'invalidated>failed',
      'repairing>runnable',
      'repairing>cancelled',
    ],
  },
  attempt: {
    statuses: C.AttemptStatusSchema.options,
    edges: [
      'running>published',
      'running>failed',
      'running>aborted',
      'running>expired',
      'running>invalidated',
    ],
  },
  action: {
    statuses: C.ActionStatusSchema.options,
    edges: [
      'proposed>admitted',
      'admitted>committed',
      'committed>dispatched',
      'dispatched>verified',
      'proposed>blocked',
      'admitted>blocked',
      'committed>outcome_unknown',
      'dispatched>outcome_unknown',
      'outcome_unknown>verified',
      'outcome_unknown>failed',
      'admitted>failed',
      'committed>failed',
      'proposed>cancelled',
      'admitted>cancelled',
      // set_config: no dispatched hop
      'committed>verified',
      // CONTRACTS 5 additionally
      'proposed>failed',
      'dispatched>failed',
    ],
  },
  receipt: {
    statuses: C.ReceiptStatusSchema.options,
    edges: [
      'supported>superseded',
      'supported>contested',
      'supported>retracted',
      'supported>expired',
      'contested>supported',
      'contested>retracted',
    ],
  },
} as const;

const terminal = {
  mission: ['succeeded', 'failed', 'cancelled'],
  task: ['succeeded', 'failed', 'cancelled'],
  attempt: ['published', 'failed', 'aborted', 'expired', 'invalidated'],
  action: ['blocked', 'verified', 'failed', 'cancelled'],
  receipt: ['superseded', 'retracted', 'expired'],
} as const;

type Kind = keyof typeof expected;
const kinds = Object.keys(expected) as Kind[];

describe('transition tables (allowed and forbidden)', () => {
  for (const kind of kinds) {
    const { statuses, edges } = expected[kind];
    const allowed = new Set<string>(edges);
    const pairs = statuses.flatMap((from) =>
      statuses.map((to) => [from, to, allowed.has(`${from}>${to}`)] as const),
    );
    it.each(pairs)(`${kind}: %s -> %s allowed=%s`, (from, to, ok) => {
      expect(C.canTransition(kind, from as never, to as never)).toBe(ok);
    });

    it(`${kind}: table has exactly the expected edges and a row per status`, () => {
      const table = C.TRANSITION_TABLES[kind] as Readonly<
        Record<string, readonly string[]>
      >;
      expect(Object.keys(table).sort()).toEqual([...statuses].sort());
      const actual = Object.entries(table).flatMap(([from, tos]) =>
        tos.map((to) => `${from}>${to}`),
      );
      expect(actual.sort()).toEqual([...edges].sort());
    });

    it(`${kind}: terminal states`, () => {
      const actual = statuses.filter((status) =>
        C.isTerminal(kind, status as never),
      );
      expect(actual.sort()).toEqual([...terminal[kind]].sort());
      // Only the succeeded task may leave a terminal state (succeeded -> invalidated).
      const table = C.TRANSITION_TABLES[kind] as Readonly<
        Record<string, readonly string[]>
      >;
      for (const status of actual)
        if (!(kind === 'task' && status === 'succeeded'))
          expect(table[status]).toEqual([]);
    });
  }

  it('rejects unknown statuses and self-loops', () => {
    expect(C.canTransition('mission', 'bogus' as never, 'running')).toBe(false);
    expect(C.canTransition('mission', 'running', 'running')).toBe(false);
    expect(C.canTransition('task', 'toString' as never, 'running')).toBe(false);
  });

  it('assertTransition throws IllegalTransitionError', () => {
    expect(() => C.assertTransition('action', 'blocked', 'admitted')).toThrow(
      C.IllegalTransitionError,
    );
    expect(() =>
      C.assertTransition('action', 'proposed', 'admitted'),
    ).not.toThrow();
  });

  it('tables are frozen', () => {
    expect(Object.isFrozen(C.ACTION_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(C.ACTION_TRANSITIONS.proposed)).toBe(true);
    expect(() =>
      (C.ACTION_TRANSITIONS.blocked as string[]).push('admitted'),
    ).toThrow();
  });
});
