// W6.3 demo adversary, DA-02 at the function level (deterministic; the
// end-to-end reproduction is in scripted-mission.test.ts). On the demo path a
// schema advance supersedes the config key and checkout.metrics a few hundred
// milliseconds apart. The repair scheduled for the first event is aborted by
// the second; the next repair's repairOf names the ABORTED attempt. By the
// rule in contracts/recovery.ts (CONTRACTS 6: "invalidated-with-successor-
// published"), the first event's invalidated attempt then has no published
// successor and the event stays open forever, although the task published a
// repair after the event. ARCHITECTURE 7.1 (D9) words the rule as "terminal
// without a published repair", which this case satisfies.
import { describe, expect, it } from 'vitest';
import {
  openInvalidation,
  type OpenInvalidationAttempt,
} from '../../../../src/server/nemodots/contracts/recovery.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never;
const EVENT_1 = 'a'.repeat(64) as never;
const EVENT_2 = 'b'.repeat(64) as never;
const MISSION = id(99);

const event = (attemptIds: string[]) => ({
  missionIds: [MISSION],
  affected: {
    modelCallIds: [],
    attemptIds: attemptIds as never[],
    outputIds: [],
    actionIds: [],
    taskIds: [],
  },
  perMission: [],
});

describe('DA-02: openInvalidation after a repair that was itself aborted', () => {
  it('control: invalidated attempt -> published repair closes the event', () => {
    const attempts: OpenInvalidationAttempt[] = [
      { id: id(1), status: 'invalidated', repairOf: null },
      {
        id: id(2),
        status: 'published',
        repairOf: { attemptId: id(1), invalidationEventId: EVENT_1 },
      },
    ];
    expect(openInvalidation(event([id(1)]), attempts, [])).toBe(false);
  });

  it('invalidated attempt -> repair aborted by a second event -> published repair closes the first event', () => {
    const attempts: OpenInvalidationAttempt[] = [
      // initial attempt, invalidated by event 1
      { id: id(1), status: 'invalidated', repairOf: null },
      // repair for event 1, aborted (readset_invalidated) by event 2
      {
        id: id(2),
        status: 'aborted',
        repairOf: { attemptId: id(1), invalidationEventId: EVENT_1 },
      },
      // the next repair names the latest attempt, the aborted one, and publishes
      {
        id: id(3),
        status: 'published',
        repairOf: { attemptId: id(2), invalidationEventId: EVENT_2 },
      },
    ];
    // event 2 (affected: attempt 2) is closed: its attempt is aborted
    expect(openInvalidation(event([id(2)]), attempts, [])).toBe(false);
    // event 1 must be closed too: the task published a repair after it
    expect(openInvalidation(event([id(1)]), attempts, [])).toBe(false);
  });
});
