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
  describe('the repair chain is followed transitively (DA-02)', () => {
    // A repair scheduled for a second event names the LATEST attempt, which can
    // be the first repair that the second event aborted, not the original.
    const middle: AttemptStatus[] = [
      'aborted',
      'failed',
      'expired',
      'invalidated',
    ];
    it.each(middle)(
      'invalidated -> %s repair -> published repair closes the first event',
      (status) => {
        const first = attempt('invalidated');
        const second = attempt(status, first.id);
        const third = attempt('published', second.id);
        const attempts = [first, second, third];
        expect(openInvalidation(eventFor([first.id]), attempts, [])).toBe(
          false,
        );
        // the second event's own attempt is closed too: terminal, or invalidated
        // with a published descendant
        expect(openInvalidation(eventFor([second.id]), attempts, [])).toBe(
          false,
        );
      },
    );
    it.each([
      'running',
      'failed',
      'aborted',
      'expired',
      'invalidated',
    ] as const)(
      'a chain whose last repair is %s (nothing published) leaves the first event open',
      (last) => {
        const first = attempt('invalidated');
        const second = attempt('aborted', first.id);
        const third = attempt(last, second.id);
        expect(
          openInvalidation(eventFor([first.id]), [first, second, third], []),
        ).toBe(true);
      },
    );
    it("only the attempt's own chain counts: another attempt's published repair does not close it", () => {
      const first = attempt('invalidated');
      const other = attempt('invalidated');
      const otherRepair = attempt('published', other.id);
      const attempts = [first, other, otherRepair];
      expect(openInvalidation(eventFor([first.id]), attempts, [])).toBe(true);
      expect(openInvalidation(eventFor([other.id]), attempts, [])).toBe(false);
    });
    it('a published descendant on any branch closes it', () => {
      const first = attempt('invalidated');
      const dead = attempt('failed', first.id);
      const deadChild = attempt('failed', dead.id);
      const alive = attempt('aborted', first.id);
      const published = attempt('published', alive.id);
      expect(
        openInvalidation(
          eventFor([first.id]),
          [first, dead, deadChild, alive, published],
          [],
        ),
      ).toBe(false);
    });
    it('every affected attempt of the event must resolve', () => {
      const first = attempt('invalidated');
      const second = attempt('aborted', first.id);
      const third = attempt('published', second.id);
      const lonely = attempt('invalidated');
      expect(
        openInvalidation(
          eventFor([first.id, lonely.id]),
          [first, second, third, lonely],
          [],
        ),
      ).toBe(true);
    });
    it('terminates on a cycle through a non-published attempt and stays open', () => {
      const start = attempt('invalidated');
      const b = attempt('aborted', start.id);
      const a = {
        ...start,
        repairOf: {
          attemptId: b.id,
          invalidationEventId: 'a'.repeat(64) as InvalidationEventId,
        },
      };
      expect(openInvalidation(eventFor([a.id]), [a, b], [])).toBe(true);
    });
    it('handles a very long chain without recursion', () => {
      const head = attempt('invalidated');
      const chain = [head];
      for (let i = 0; i < 5_000; i += 1)
        chain.push(attempt('aborted', chain[chain.length - 1].id));
      expect(openInvalidation(eventFor([head.id]), chain, [])).toBe(true);
      const done = [...chain, attempt('published', chain[chain.length - 1].id)];
      expect(openInvalidation(eventFor([head.id]), done, [])).toBe(false);
    });
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
