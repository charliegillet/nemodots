// The openInvalidation predicate (CONTRACTS.md section 6, D9) as a table, plus
// the worker host's drift classification.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  openInvalidation,
  type ActionStatus,
  type AttemptId,
  type AttemptStatus,
  type InvalidationEventId,
  type MissionId,
} from '../../../src/server/nemodots/contracts/index.js';

const mission = randomUUID() as MissionId;
const attempt = (status: AttemptStatus, repairOf?: AttemptId) => ({
  id: randomUUID() as AttemptId,
  status,
  repairOf: repairOf
    ? {
        attemptId: repairOf,
        invalidationEventId: 'a'.repeat(64) as InvalidationEventId,
      }
    : null,
});
const eventFor = (
  attemptIds: string[],
  actionIds: string[] = [],
  missionIds = [mission],
) => {
  const affected = {
    modelCallIds: [],
    attemptIds,
    outputIds: [],
    actionIds,
    taskIds: [],
  } as never;
  return {
    missionIds,
    affected,
    perMission: missionIds.map((missionId) => ({
      missionId,
      affected,
      preserved: { taskIds: [] },
    })),
  };
};

describe('openInvalidation predicate table', () => {
  const closed: AttemptStatus[] = ['published', 'failed', 'aborted', 'expired'];
  it.each(closed)('an affected %s attempt is closed', (status) => {
    const a = attempt(status);
    expect(openInvalidation(eventFor([a.id]), [a], [])).toBe(false);
  });
  it('a running attempt keeps it open', () => {
    const a = attempt('running');
    expect(openInvalidation(eventFor([a.id]), [a], [])).toBe(true);
  });
  it('an invalidated attempt is open until a successor repair published', () => {
    const a = attempt('invalidated');
    expect(openInvalidation(eventFor([a.id]), [a], [])).toBe(true);
    const running = attempt('running', a.id);
    expect(openInvalidation(eventFor([a.id]), [a, running], [])).toBe(true);
    const published = attempt('published', a.id);
    expect(openInvalidation(eventFor([a.id]), [a, published], [])).toBe(false);
  });
  it('a chain of invalidated repairs closes when the last successor published', () => {
    const first = attempt('invalidated');
    const second = attempt('invalidated', first.id);
    const third = attempt('published', second.id);
    expect(
      openInvalidation(eventFor([first.id]), [first, second, third], []),
    ).toBe(false);
    const stuck = attempt('running', second.id);
    expect(
      openInvalidation(eventFor([first.id]), [first, second, stuck], []),
    ).toBe(true);
  });
  it('an affected id that is not known fails closed', () => {
    expect(openInvalidation(eventFor([randomUUID()]), [], [])).toBe(true);
  });
  const closedIntents: ActionStatus[] = [
    'blocked',
    'failed',
    'cancelled',
    'verified',
  ];
  const openIntents: ActionStatus[] = [
    'proposed',
    'admitted',
    'committed',
    'dispatched',
    'outcome_unknown',
  ];
  it.each(closedIntents)('an affected %s intent is closed', (status) => {
    const id = randomUUID();
    expect(openInvalidation(eventFor([], [id]), [], [{ id, status }])).toBe(
      false,
    );
  });
  it.each(openIntents)('an affected %s intent keeps it open', (status) => {
    const id = randomUUID();
    expect(openInvalidation(eventFor([], [id]), [], [{ id, status }])).toBe(
      true,
    );
  });
  it('is evaluated per mission: another mission is not affected', () => {
    const other = randomUUID() as MissionId;
    const a = attempt('running');
    expect(openInvalidation(eventFor([a.id]), [a], [], other)).toBe(false);
    expect(openInvalidation(eventFor([a.id]), [a], [], mission)).toBe(true);
  });
});
