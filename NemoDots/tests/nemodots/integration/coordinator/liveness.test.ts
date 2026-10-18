// Liveness: an invalidation must always end in a state the mission evaluation
// can act on. These tests reproduce the paths that left a mission `running`
// with every task terminal and an invalidation open, and show the mission
// reaching a terminal or recoverable state with an explicit reason.
import { expect, it } from 'vitest';
import { evaluateMission } from '../../../../src/server/nemodots/coordinator/missions.js';
import {
  claimStart,
  invalidationFor,
  plannedMission,
  recoveryKinds,
  taskRow,
  withHarness,
  type Harness,
} from './harness.js';

const two = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

// the replan is not the subject here: keep the planner settled
const NO_REPLAN = {
  coordinator: { recovery: { replanOnRootInvalidation: false } },
};

const evaluate = (h: Harness, missionId: string) =>
  evaluateMission(h.coordinator.deps as never, missionId as never);

const missionRow = async (h: Harness, id: string) =>
  (
    await h.admin.query(
      'SELECT status, failure_reason FROM coordinator.missions WHERE id = $1',
      [id],
    )
  ).rows[0] as { status: string; failure_reason: string | null };

const invalidationRows = async (h: Harness, missionId: string) =>
  (
    await h.admin.query(
      'SELECT event_id, resolved_at FROM coordinator.invalidations WHERE mission_id = $1',
      [missionId],
    )
  ).rows as { event_id: string; resolved_at: Date | null }[];

const detailsOf = async (h: Harness, missionId: string, kind: string) =>
  (
    await h.admin.query<{ detail: string }>(
      'SELECT detail FROM coordinator.recovery_events WHERE mission_id = $1 AND kind = $2',
      [missionId, kind],
    )
  ).rows.map((r) => r.detail);

it('WEDGE 1: the repair of an affected task is cancelled (obsoleted) -> its invalidated attempt no longer holds the event open; the mission reaches awaiting_acceptance', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    const attemptB = await claimStart(h, { taskId: b });
    // the ledger closure marks A's attempt invalidated (status first)
    await h.admin.query(
      "UPDATE coordinator.task_attempts SET status = 'invalidated' WHERE id = $1",
      [attemptA.context.attemptId],
    );
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [attemptA.context.attemptId],
        taskIds: [a],
      }),
    );
    // a replan obsoletes the task before its repair published anything
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'cancelled' WHERE id = $1",
      [a],
    );
    await h.coordinator.publishOutput(attemptB.context, {
      kind: 'finding',
      content: { ok: true },
      dependencyVector: [],
    });
    expect((await taskRow(h, b)).status).toBe('succeeded');
    expect(await evaluate(h, planned.missionId)).toBe('awaiting_acceptance');
    expect((await missionRow(h, planned.missionId)).status).toBe(
      'awaiting_acceptance',
    );
    expect(
      (await invalidationRows(h, planned.missionId)).every(
        (r) => r.resolved_at,
      ),
    ).toBe(true);
  }, NO_REPLAN);
});

it('WEDGE 2: every planned task ended cancelled/failed below the root -> the mission fails with no_task_succeeded instead of waiting forever', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'cancelled' WHERE id = ANY($1::uuid[])",
      [[a, b]],
    );
    expect(await evaluate(h, planned.missionId)).toBe('failed');
    const mission = await missionRow(h, planned.missionId);
    expect(mission.status).toBe('failed');
    expect(mission.failure_reason).toContain('no_task_succeeded');
  });
});

it('WEDGE 3a: an affected task is terminal "succeeded" with unusable output and no repair -> a repair is scheduled while it has attempts left', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    const out = await h.coordinator.publishOutput(attemptA.context, {
      kind: 'finding',
      content: { v: 1 },
      dependencyVector: [],
    });
    const attemptB = await claimStart(h, { taskId: b });
    await h.coordinator.publishOutput(attemptB.context, {
      kind: 'finding',
      content: { v: 2 },
      dependencyVector: [],
    });
    const event = invalidationFor({
      missionId: planned.missionId,
      taskIds: [a],
    });
    await h.coordinator.onInvalidation(event);
    // the repair that recovery scheduled vanished (state as left by a lost write):
    // the task is back to succeeded, its output unusable, nothing queued
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'succeeded', repair = NULL WHERE id = $1",
      [a],
    );
    await h.admin.query(
      "UPDATE coordinator.task_outputs SET usable = false, unusable_reason = 'invalidated' WHERE id = $1",
      [(out as { outputId: string }).outputId],
    );
    expect(await evaluate(h, planned.missionId)).toBe('running');
    expect((await taskRow(h, a)).status).toBe('runnable');
    const queued = await taskRow(h, a);
    expect(queued.repair).toMatchObject({ kind: 'repair' });
    expect(queued.repair?.reason ?? '').toContain(
      'unrepaired after invalidation',
    );
  }, NO_REPLAN);
});

it('WEDGE 3b: the same, but the task has no attempts left -> the invalidation is settled as repair_not_schedulable and the mission fails with that reason', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    const out = await h.coordinator.publishOutput(attemptA.context, {
      kind: 'finding',
      content: { v: 1 },
      dependencyVector: [],
    });
    const attemptB = await claimStart(h, { taskId: b });
    await h.coordinator.publishOutput(attemptB.context, {
      kind: 'finding',
      content: { v: 2 },
      dependencyVector: [],
    });
    await h.coordinator.onInvalidation(
      invalidationFor({ missionId: planned.missionId, taskIds: [a] }),
    );
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'succeeded', repair = NULL, attempt_count = max_attempts WHERE id = $1",
      [a],
    );
    await h.admin.query(
      "UPDATE coordinator.task_outputs SET usable = false, unusable_reason = 'invalidated' WHERE id = $1",
      [(out as { outputId: string }).outputId],
    );
    expect(await evaluate(h, planned.missionId)).toBe('failed');
    const mission = await missionRow(h, planned.missionId);
    expect(mission.status).toBe('failed');
    expect(mission.failure_reason).toContain('repair_not_schedulable');
    expect(
      (await invalidationRows(h, planned.missionId)).every(
        (r) => r.resolved_at,
      ),
    ).toBe(true);
    expect(
      (await detailsOf(h, planned.missionId, 'invalidation_resolved')).some(
        (d) => d.startsWith('repair_not_schedulable'),
      ),
    ).toBe(true);
  }, NO_REPLAN);
});

it('WEDGE 4: a repair held behind a postcondition gate that is gone (cancelled) is released by the evaluation', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [attemptA.context.attemptId],
        taskIds: [a],
        selfWrite: 'verified',
      }),
    );
    expect((await taskRow(h, a)).status).toBe('invalidated'); // held
    const gate = (
      await h.admin.query(
        "SELECT id FROM coordinator.tasks WHERE mission_id = $1 AND role = 'postcondition'",
        [planned.missionId],
      )
    ).rows[0].id as string;
    // a replan cancels the gate without releasing it
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'cancelled' WHERE id = $1",
      [gate],
    );
    await evaluate(h, planned.missionId);
    expect((await taskRow(h, a)).status).toBe('runnable');
    expect(
      (await recoveryKinds(h, planned.missionId)).map((r) => r.kind),
    ).toContain('repair_scheduled');
  });
});

it('maintenance evaluates a running mission whose tasks are all terminal even with no pending mission.evaluate message', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    await h.admin.query(
      "UPDATE coordinator.tasks SET status = 'cancelled' WHERE id = ANY($1::uuid[])",
      [planned.taskIds],
    );
    await h.admin.query(
      "UPDATE coordinator.outbox SET processed_at = now() WHERE topic = 'mission.evaluate' AND processed_at IS NULL",
    );
    await h.coordinator.runMaintenance();
    expect((await missionRow(h, planned.missionId)).status).toBe('failed');
  });
});
