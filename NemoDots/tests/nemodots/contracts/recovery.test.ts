import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';
import * as F from './fixtures.js';
import { ids, invalidationId } from './fixtures.js';

type AttemptRow = C.OpenInvalidationAttempt;
const A1 = C.AttemptIdSchema.parse(ids.attempt);
const A2 = C.AttemptIdSchema.parse(ids.attempt2);
const A3 = C.AttemptIdSchema.parse(ids.attempt3);
const X1 = ids.action;
const ev = C.InvalidationEventIdSchema.parse(invalidationId);
const repairOf = (attemptId: C.AttemptId) => ({
  attemptId,
  invalidationEventId: ev,
});

const affected = (attemptIds: C.AttemptId[], actionIds: string[]) => ({
  modelCallIds: [],
  attemptIds,
  outputIds: [],
  actionIds: actionIds.map((id) => C.ActionIdSchema.parse(id)),
  taskIds: [],
});
const event = (attemptIds: C.AttemptId[], actionIds: string[] = []) => ({
  missionIds: [C.MissionIdSchema.parse(ids.mission)],
  affected: affected(attemptIds, actionIds),
  perMission: [
    {
      missionId: C.MissionIdSchema.parse(ids.mission),
      affected: affected(attemptIds, actionIds),
      preserved: { taskIds: [] },
    },
  ],
});
const att = (
  id: C.AttemptId,
  status: C.AttemptStatus,
  of: C.AttemptId | null = null,
): AttemptRow => ({
  id,
  status,
  repairOf: of ? repairOf(of) : null,
});

describe('openInvalidation (CONTRACTS section 6)', () => {
  const attemptCases: [string, C.AttemptStatus, boolean][] = [
    ['running', 'running', true],
    ['published', 'published', false],
    ['failed', 'failed', false],
    ['aborted', 'aborted', false],
    ['expired', 'expired', false],
    ['invalidated without successor', 'invalidated', true],
  ];
  it.each(attemptCases)(
    'affected attempt %s -> open=%s',
    (_label, status, open) => {
      expect(C.openInvalidation(event([A1]), [att(A1, status)], [])).toBe(open);
    },
  );

  it.each([
    ['running successor', 'running', true],
    ['published successor', 'published', false],
    ['failed successor', 'failed', true],
    ['aborted successor', 'aborted', true],
  ] as const)(
    'invalidated attempt with %s -> open=%s',
    (_l, successor, open) => {
      expect(
        C.openInvalidation(
          event([A1]),
          [att(A1, 'invalidated'), att(A2, successor, A1)],
          [],
        ),
      ).toBe(open);
    },
  );

  it('follows a chain of invalidated repairs to a published one', () => {
    const rows = [
      att(A1, 'invalidated'),
      att(A2, 'invalidated', A1),
      att(A3, 'published', A2),
    ];
    expect(C.openInvalidation(event([A1]), rows, [])).toBe(false);
    expect(C.openInvalidation(event([A1]), rows.slice(0, 2), [])).toBe(true);
  });

  it('terminates on a repairOf cycle (fail-closed)', () => {
    const rows = [att(A1, 'invalidated', A2), att(A2, 'invalidated', A1)];
    expect(C.openInvalidation(event([A1]), rows, [])).toBe(true);
  });

  const intentCases: [C.ActionStatus, boolean][] = [
    ['proposed', true],
    ['admitted', true],
    ['committed', true],
    ['dispatched', true],
    ['outcome_unknown', true],
    ['blocked', false],
    ['failed', false],
    ['cancelled', false],
    ['verified', false],
  ];
  it.each(intentCases)('affected intent %s -> open=%s', (status, open) => {
    expect(C.openInvalidation(event([], [X1]), [], [{ id: X1, status }])).toBe(
      open,
    );
  });

  it('is fail-closed when an affected row is missing', () => {
    expect(C.openInvalidation(event([A1]), [], [])).toBe(true);
    expect(C.openInvalidation(event([], [X1]), [], [])).toBe(true);
  });

  it('is closed with nothing affected', () => {
    expect(C.openInvalidation(event([]), [], [])).toBe(false);
  });

  it('uses the per-mission subset when a mission id is given', () => {
    const e = event([A1]);
    e.perMission[0].affected = affected([], []);
    expect(C.openInvalidation(e, [att(A1, 'running')], [])).toBe(true);
    expect(C.openInvalidation(e, [att(A1, 'running')], [], ids.mission)).toBe(
      false,
    );
    expect(
      C.openInvalidation(event([A1]), [att(A1, 'running')], [], ids.mission),
    ).toBe(true);
    expect(
      C.openInvalidation(event([A1]), [att(A1, 'running')], [], ids.mission2),
    ).toBe(false);
  });

  it('closed status sets match the documented predicate', () => {
    expect([...C.CLOSED_ATTEMPT_STATUSES].sort()).toEqual([
      'aborted',
      'expired',
      'failed',
      'published',
    ]);
    expect([...C.CLOSED_INTENT_STATUSES].sort()).toEqual([
      'blocked',
      'cancelled',
      'failed',
      'verified',
    ]);
  });
});

describe('perMission coverage (fail closed)', () => {
  const m = C.MissionIdSchema.parse(ids.mission);
  const other = C.MissionIdSchema.parse(ids.mission2);

  it('schema rejects missionIds without a perMission entry', () => {
    const e = { ...F.invalidation(), perMission: [] };
    expect(C.InvalidationEventSchema.safeParse(e).success).toBe(false);
  });
  it('schema rejects duplicate missionIds and duplicate perMission entries', () => {
    const base = F.invalidation();
    expect(
      C.InvalidationEventSchema.safeParse({
        ...base,
        missionIds: [...base.missionIds, ...base.missionIds],
      }).success,
    ).toBe(false);
    expect(
      C.InvalidationEventSchema.safeParse({
        ...base,
        perMission: [...base.perMission, ...base.perMission],
      }).success,
    ).toBe(false);
  });
  it('mission listed without entry falls back to the global affected set (open)', () => {
    const e = { ...event([A1]), perMission: [] };
    expect(C.openInvalidation(e, [att(A1, 'running')], [], m)).toBe(true);
    expect(C.openInvalidation(e, [att(A1, 'published')], [], m)).toBe(false);
  });
  it('mission not in missionIds is not affected', () => {
    expect(
      C.openInvalidation(event([A1]), [att(A1, 'running')], [], other),
    ).toBe(false);
  });
});
