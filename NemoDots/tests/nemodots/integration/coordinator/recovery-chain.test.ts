// Demo adversary DA-02: on the demo path a schema advance supersedes the config
// key and checkout.metrics a few hundred milliseconds apart. The repair
// scheduled for the first event is aborted by the second; the next repair names
// the ABORTED repair (repairOf = the latest attempt), not the original. The
// first event used to stay open forever, even after a verified repair
// published, and the mission failed repair_not_schedulable. An invalidated
// attempt is now resolved through its whole repair chain (transitively), and a
// task that succeeded again after the event closes it however the chain is
// linked.
import { expect, it } from 'vitest';
import { evaluateOpen } from '../../../../src/server/nemodots/coordinator/index.js';
import { evaluateMission } from '../../../../src/server/nemodots/coordinator/missions.js';
import {
  attemptRow,
  claimStart,
  invalidationFor,
  plannedMission,
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

async function open(h: Harness, missionId: string) {
  const client = await h.pool.connect();
  try {
    return (await evaluateOpen(client, h.coordinator.deps, missionId)).open;
  } finally {
    client.release();
  }
}

const resolved = async (h: Harness, eventId: string) =>
  (
    await h.admin.query<{ resolved_at: Date | null }>(
      'SELECT resolved_at FROM coordinator.invalidations WHERE event_id = $1',
      [eventId],
    )
  ).rows[0].resolved_at !== null;

const missionRow = async (h: Harness, id: string) =>
  (
    await h.admin.query<{ status: string; failure_reason: string | null }>(
      'SELECT status, failure_reason FROM coordinator.missions WHERE id = $1',
      [id],
    )
  ).rows[0];

/**
 * Task `a`: attempt A1 invalidated by the ledger closure (status first) and
 * repaired by R1; a second event aborts R1 while it runs and schedules R2,
 * which names R1. R2 is claimed and started but not yet published. Task `b`
 * finishes normally.
 */
async function chain(h: Harness) {
  const planned = await plannedMission(h, two);
  const [a, b] = planned.taskIds;
  const first = await claimStart(h, { taskId: a });
  const other = await claimStart(h, { taskId: b });
  await h.admin.query(
    "UPDATE coordinator.task_attempts SET status = 'invalidated' WHERE id = $1",
    [first.context.attemptId],
  );
  const e1 = invalidationFor({
    missionId: planned.missionId,
    attemptIds: [first.context.attemptId],
    taskIds: [a],
    preserved: [b],
  });
  await h.coordinator.onInvalidation(e1);
  const r1 = await claimStart(h, { taskId: a });
  const e2 = invalidationFor({
    missionId: planned.missionId,
    attemptIds: [r1.context.attemptId],
    taskIds: [a],
    preserved: [b],
  });
  await h.coordinator.onInvalidation(e2);
  const r2 = await claimStart(h, { taskId: a });
  await h.coordinator.publishOutput(other.context, {
    kind: 'finding',
    content: { b: true },
    dependencyVector: [],
  });
  return { planned, a, b, first, r1, r2, e1, e2 };
}

it('shape: the second repair names the aborted first repair, not the original attempt', async () => {
  await withHarness(async (h) => {
    const c = await chain(h);
    const original = await attemptRow(h, c.first.context.attemptId);
    const firstRepair = await attemptRow(h, c.r1.context.attemptId);
    const secondRepair = await attemptRow(h, c.r2.context.attemptId);
    expect(original.status).toBe('invalidated');
    expect(firstRepair.status).toBe('aborted');
    expect(firstRepair.repair_of.attemptId).toBe(c.first.context.attemptId);
    expect(secondRepair.status).toBe('running');
    expect(secondRepair.repair_of.attemptId).toBe(c.r1.context.attemptId);
  }, NO_REPLAN);
});

it('both events stay open while the last repair is unfinished (fail closed)', async () => {
  await withHarness(async (h) => {
    const c = await chain(h);
    const ids = (await open(h, c.planned.missionId)).map((o) => o.row.event_id);
    expect(ids).toContain(c.e1.id);
    expect(await resolved(h, c.e1.id)).toBe(false);
  }, NO_REPLAN);
});

it('a verified repair published through the chain closes BOTH events and the mission is accepted, not failed repair_not_schedulable', async () => {
  await withHarness(async (h) => {
    const c = await chain(h);
    await h.coordinator.publishOutput(c.r2.context, {
      kind: 'finding',
      content: { repaired: true },
      dependencyVector: [],
    });
    expect((await taskRow(h, c.a)).status).toBe('succeeded');
    expect(await open(h, c.planned.missionId)).toEqual([]);
    expect(await evaluate(h, c.planned.missionId)).toBe('awaiting_acceptance');
    const mission = await missionRow(h, c.planned.missionId);
    expect(mission.status).toBe('awaiting_acceptance');
    expect(mission.failure_reason).toBeNull();
    expect(await resolved(h, c.e1.id)).toBe(true);
    expect(await resolved(h, c.e2.id)).toBe(true);
  }, NO_REPLAN);
});

it('a task that succeeded again after the event closes it even when the repair chain is not linked to the original attempt', async () => {
  await withHarness(async (h) => {
    const c = await chain(h);
    await h.coordinator.publishOutput(c.r2.context, {
      kind: 'finding',
      content: { repaired: true },
      dependencyVector: [],
    });
    // sever the chain: both repairs become plain retries that name nothing;
    // re-open both events
    await h.admin.query(
      `UPDATE coordinator.task_attempts SET repair_of = NULL, kind = 'retry' WHERE id = ANY($1::uuid[])`,
      [[c.r1.context.attemptId, c.r2.context.attemptId]],
    );
    await h.admin.query(
      'UPDATE coordinator.invalidations SET resolved_at = NULL WHERE mission_id = $1',
      [c.planned.missionId],
    );
    const client = await h.pool.connect();
    try {
      const evaluation = await evaluateOpen(
        client,
        h.coordinator.deps,
        c.planned.missionId,
      );
      expect(evaluation.open).toEqual([]);
      expect(evaluation.closed.map((row) => row.event_id).sort()).toEqual(
        [c.e1.id, c.e2.id].sort(),
      );
    } finally {
      client.release();
    }
  }, NO_REPLAN);
});

it('an output that is no longer usable does not count as a repair, by chain or by re-success (fail closed)', async () => {
  await withHarness(async (h) => {
    const c = await chain(h);
    const published = await h.coordinator.publishOutput(c.r2.context, {
      kind: 'finding',
      content: { repaired: true },
      dependencyVector: [],
    });
    await h.admin.query(
      "UPDATE coordinator.task_outputs SET usable = false, unusable_reason = 'invalidated' WHERE id = $1",
      [(published as { outputId: string }).outputId],
    );
    await h.admin.query(
      'UPDATE coordinator.invalidations SET resolved_at = NULL WHERE mission_id = $1',
      [c.planned.missionId],
    );
    const ids = (await open(h, c.planned.missionId)).map((o) => o.row.event_id);
    expect(ids).toContain(c.e1.id);
  }, NO_REPLAN);
});
