// Demo adversary DA-03: evaluateMission moved a mission to awaiting_acceptance as
// soon as every task was terminal, although an intent was still proposed (waiting
// out admission.minAgeMs) or admitted/committed/dispatched but not settled. The
// acceptance probe then judged a half-applied repair, failed, and burned the
// replan cap while the correct repair sat in the queue. A mission is not ready
// for acceptance while any live intent exists.
import { expect, it } from 'vitest';
import {
  evaluateMission,
  evaluateStalled,
} from '../../../../src/server/nemodots/coordinator/missions.js';
import {
  LIVE_STATUSES,
  type ActionStatus,
} from '../../../../src/server/nemodots/contracts/index.js';
import { randomUUID } from 'node:crypto';
import {
  claimStart,
  plannedMission,
  withHarness,
  type Harness,
} from './harness.js';

const evaluate = (h: Harness, missionId: string) =>
  evaluateMission(h.coordinator.deps as never, missionId as never);

const missionStatus = async (h: Harness, id: string) =>
  (
    await h.admin.query<{ status: string }>(
      'SELECT status FROM coordinator.missions WHERE id = $1',
      [id],
    )
  ).rows[0].status;

const acceptRows = async (h: Harness, missionId: string) =>
  Number(
    (
      await h.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM coordinator.outbox WHERE mission_id = $1 AND topic = 'mission.accept'`,
        [missionId],
      )
    ).rows[0].n,
  );

/** Two planned tasks, claimed and published: every task is terminal. */
async function finished(h: Harness) {
  const planned = await plannedMission(h, [
    { role: 'investigator' },
    { role: 'investigator' },
  ]);
  const attempts = [];
  for (const taskId of planned.taskIds) {
    const attempt = await claimStart(h, { taskId });
    await h.coordinator.publishOutput(attempt.context, {
      kind: 'finding',
      content: { ok: true },
      dependencyVector: [],
    });
    attempts.push(attempt);
  }
  return { ...planned, attempt: attempts[0] };
}

const addIntent = (
  h: Harness,
  w: Awaited<ReturnType<typeof finished>>,
  status: ActionStatus,
) => {
  const id = randomUUID();
  h.intents.add({
    id: id as never,
    missionId: w.missionId,
    taskId: w.taskIds[0],
    attemptId: w.attempt.context.attemptId,
    status,
  } as never);
  return id;
};

it('control: with no intent the mission moves to awaiting_acceptance and a mission.accept is queued', async () => {
  await withHarness(async (h) => {
    const w = await finished(h);
    expect(await evaluate(h, w.missionId)).toBe('awaiting_acceptance');
    expect(await missionStatus(h, w.missionId)).toBe('awaiting_acceptance');
    expect(await acceptRows(h, w.missionId)).toBe(1);
  });
});

it.each([...LIVE_STATUSES])(
  'an intent still %s keeps the mission running: no acceptance, no mission.accept',
  async (status) => {
    await withHarness(async (h) => {
      const w = await finished(h);
      addIntent(h, w, status);
      expect(await evaluate(h, w.missionId)).toBe('unchanged');
      expect(await missionStatus(h, w.missionId)).toBe('running');
      expect(await acceptRows(h, w.missionId)).toBe(0);
    });
  },
);

it.each(['blocked', 'failed', 'cancelled', 'verified'] as const)(
  'a settled (%s) intent does not hold the mission back',
  async (status) => {
    await withHarness(async (h) => {
      const w = await finished(h);
      addIntent(h, w, status);
      expect(await evaluate(h, w.missionId)).toBe('awaiting_acceptance');
    });
  },
);

it("only the mission's own intents count", async () => {
  await withHarness(async (h) => {
    const w = await finished(h);
    h.intents.add({
      id: randomUUID() as never,
      missionId: randomUUID() as never,
      taskId: w.taskIds[0],
      attemptId: w.attempt.context.attemptId,
      status: 'proposed',
    } as never);
    expect(await evaluate(h, w.missionId)).toBe('awaiting_acceptance');
  });
});

it('the mission waits through every live status and advances once the last intent settles, by the maintenance sweep alone', async () => {
  await withHarness(async (h) => {
    const w = await finished(h);
    const id = addIntent(h, w, 'proposed');
    // no mission.evaluate message is pending: the sweep is the only driver
    await h.admin.query(
      `UPDATE coordinator.outbox SET processed_at = now()
        WHERE mission_id = $1 AND topic = 'mission.evaluate'`,
      [w.missionId],
    );
    for (const status of [
      'proposed',
      'admitted',
      'committed',
      'dispatched',
    ] as const) {
      h.intents.setStatus(id, status);
      expect(await evaluateStalled(h.coordinator.deps as never)).toBe(1);
      expect(await missionStatus(h, w.missionId)).toBe('running');
    }
    h.intents.setStatus(id, 'outcome_unknown');
    await evaluateStalled(h.coordinator.deps as never);
    expect(await missionStatus(h, w.missionId)).toBe('running');
    h.intents.setStatus(id, 'verified');
    await evaluateStalled(h.coordinator.deps as never);
    expect(await missionStatus(h, w.missionId)).toBe('awaiting_acceptance');
    expect(await acceptRows(h, w.missionId)).toBe(1);
  });
});

it('a mission with nothing that succeeded still fails while an intent is live (the wait is not a wedge)', async () => {
  await withHarness(async (h) => {
    const w = await finished(h);
    addIntent(h, w, 'proposed');
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'cancelled' WHERE id = ANY($1::uuid[])",
      [w.taskIds],
    );
    expect(await evaluate(h, w.missionId)).toBe('failed');
    expect(await missionStatus(h, w.missionId)).toBe('failed');
  });
});
