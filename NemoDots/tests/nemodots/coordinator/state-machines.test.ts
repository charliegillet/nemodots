// The coordinator moves entities only along edges listed in
// contracts/transitions.ts (ARCHITECTURE.md section 7).
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_TRANSITIONS,
  IllegalTransitionError,
  MISSION_TRANSITIONS,
  MissionStatusSchema,
  TASK_TRANSITIONS,
  AttemptStatusSchema,
  TaskStatusSchema,
  assertTransition,
  canTransition,
  isTerminal,
  type AttemptStatus,
  type MissionStatus,
  type TaskStatus,
} from '../../../src/server/nemodots/contracts/index.js';

// Every edge the coordinator code takes (grep: transitionMission / transitionTask /
// finishAttempt / requeueTask / promoteRunnable / terminate). Keep in sync with the code.
const MISSION_EDGES: [MissionStatus, MissionStatus][] = [
  ['created', 'running'], // start
  ['created', 'blocked_provider'], // start, provider unreachable
  ['blocked_provider', 'created'], // start, provider back
  ['running', 'paused'], // pause
  ['paused', 'running'], // resume
  ['running', 'awaiting_acceptance'], // evaluate
  ['awaiting_acceptance', 'running'], // evaluate (repair scheduled), failed probe + replan
  ['awaiting_acceptance', 'succeeded'], // completeAcceptance (pass, zero open invalidations)
  ['awaiting_acceptance', 'failed'], // failed probe without replan
  ['running', 'failed'], // root task failed
  ['created', 'cancelled'],
  ['blocked_provider', 'cancelled'],
  ['running', 'cancelled'],
  ['paused', 'cancelled'],
  ['awaiting_acceptance', 'cancelled'],
];

const TASK_EDGES: [TaskStatus, TaskStatus][] = [
  ['pending', 'runnable'], // promoteRunnable
  ['runnable', 'leased'], // claim
  ['leased', 'running'], // start
  ['leased', 'runnable'], // requeue before start
  ['running', 'succeeded'],
  ['running', 'failed'],
  ['waiting', 'failed'],
  ['running', 'waiting'],
  ['waiting', 'running'],
  ['running', 'invalidated'], // requeue / recovery
  ['waiting', 'invalidated'],
  ['succeeded', 'invalidated'], // recovery
  ['invalidated', 'repairing'],
  ['repairing', 'runnable'],
  // cancel / fail sweeps
  ['pending', 'cancelled'],
  ['runnable', 'cancelled'],
  ['leased', 'cancelled'],
  ['running', 'cancelled'],
  ['waiting', 'cancelled'],
  ['invalidated', 'cancelled'],
  ['repairing', 'cancelled'],
];

describe('coordinator edges are legal', () => {
  it.each(MISSION_EDGES)('mission %s -> %s', (from, to) => {
    expect(canTransition('mission', from, to)).toBe(true);
    expect(() => assertTransition('mission', from, to)).not.toThrow();
  });
  it.each(TASK_EDGES)('task %s -> %s', (from, to) => {
    expect(canTransition('task', from, to)).toBe(true);
  });
  it.each([
    'published',
    'failed',
    'aborted',
    'expired',
    'invalidated',
  ] as AttemptStatus[])('attempt running -> %s', (to) => {
    expect(canTransition('attempt', 'running', to)).toBe(true);
  });

  it('requeuing an in-flight task uses only legal edges, whichever way the lead rules on running -> runnable', () => {
    const direct = canTransition('task', 'running', 'runnable');
    const recovery =
      canTransition('task', 'running', 'invalidated') &&
      canTransition('task', 'invalidated', 'repairing') &&
      canTransition('task', 'repairing', 'runnable');
    expect(direct || recovery).toBe(true);
    const waitingDirect = canTransition('task', 'waiting', 'runnable');
    const waitingRecovery =
      canTransition('task', 'waiting', 'invalidated') &&
      canTransition('task', 'invalidated', 'repairing');
    expect(waitingDirect || waitingRecovery).toBe(true);
    expect(canTransition('task', 'leased', 'runnable')).toBe(true);
  });
});

describe('transition tables are exhaustive and closed', () => {
  const cases = [
    ['mission', MissionStatusSchema.options, MISSION_TRANSITIONS],
    ['task', TaskStatusSchema.options, TASK_TRANSITIONS],
    ['attempt', AttemptStatusSchema.options, ATTEMPT_TRANSITIONS],
  ] as const;
  for (const [kind, statuses, table] of cases)
    it(`${kind}: every ordered pair agrees with the table, forbidden pairs throw IllegalTransitionError`, () => {
      for (const from of statuses)
        for (const to of statuses) {
          const allowed = (table as Record<string, readonly string[]>)[
            from
          ].includes(to);
          expect(
            canTransition(kind, from as never, to as never),
            `${from}->${to}`,
          ).toBe(allowed);
          if (allowed)
            expect(() =>
              assertTransition(kind, from as never, to as never),
            ).not.toThrow();
          else
            expect(() =>
              assertTransition(kind, from as never, to as never),
            ).toThrow(IllegalTransitionError);
        }
    });

  it('terminal statuses have no outgoing edge, except a succeeded task which recovery may invalidate', () => {
    for (const status of [
      'succeeded',
      'failed',
      'cancelled',
    ] as MissionStatus[])
      expect(MISSION_TRANSITIONS[status]).toEqual([]);
    expect(TASK_TRANSITIONS.failed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
    expect(TASK_TRANSITIONS.succeeded).toEqual(['invalidated']);
    for (const status of [
      'published',
      'failed',
      'aborted',
      'expired',
      'invalidated',
    ] as AttemptStatus[]) {
      expect(ATTEMPT_TRANSITIONS[status]).toEqual([]);
      expect(isTerminal('attempt', status)).toBe(true);
    }
  });

  it('succeeded is only reachable from awaiting_acceptance', () => {
    const into = MissionStatusSchema.options.filter((from) =>
      MISSION_TRANSITIONS[from].includes('succeeded'),
    );
    expect(into).toEqual(['awaiting_acceptance']);
  });
});
