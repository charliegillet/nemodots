// Replan coalescing behind a verified self-write (CONTRACTS.md section 1,
// revision 3): when a postcondition gate holds the repairs of an invalidation,
// the replan that the same event triggers is held behind the same gate
// (replan_coalesced) and released with the repairs; without a gate (mismatch or
// no self-write) the replan is scheduled at once, bounded by replanCap.
import { expect, it } from 'vitest';
import {
  EventBuffer,
  createEventSink,
} from '../../../../src/server/nemodots/coordinator/events.js';
import { releaseGate } from '../../../../src/server/nemodots/coordinator/recovery.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import type { TaskId } from '../../../../src/server/nemodots/contracts/index.js';
import {
  claimStart,
  count,
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

async function plannerOf(h: Harness, missionId: string) {
  const { rows } = await h.admin.query(
    `SELECT id, status, repair FROM coordinator.tasks WHERE mission_id = $1 AND role = 'planner'`,
    [missionId],
  );
  return rows[0] as {
    id: string;
    status: string;
    repair: { kind: string } | null;
  };
}

const kindCount = (h: Harness, kind: string) =>
  count(h, 'coordinator.recovery_events', `kind = '${kind}'`);

async function gateTask(h: Harness, missionId: string) {
  const { rows } = await h.admin.query(
    `SELECT id FROM coordinator.tasks WHERE mission_id = $1 AND role = 'postcondition'`,
    [missionId],
  );
  return rows[0].id as TaskId;
}

async function verifiedHit(h: Harness) {
  const planned = await plannedMission(h, two);
  const [root] = planned.taskIds;
  const attempt = await claimStart(h, { taskId: root });
  const event = invalidationFor({
    missionId: planned.missionId,
    attemptIds: [attempt.context.attemptId],
    taskIds: [root],
    selfWrite: 'verified',
  });
  await h.coordinator.onInvalidation(event);
  return { planned, root, event };
}

it('a verified self-write hitting a root task: postcondition scheduled, repair AND replan coalesced, no immediate replan', async () => {
  await withHarness(async (h) => {
    const { planned, root } = await verifiedHit(h);
    const kinds = (await recoveryKinds(h, planned.missionId)).map(
      (r) => r.kind,
    );
    expect(kinds).toContain('postcondition_scheduled');
    expect(kinds).toContain('repair_coalesced');
    expect(kinds).toContain('replan_coalesced');
    expect(kinds).not.toContain('replan_scheduled');
    expect(kinds).not.toContain('repair_scheduled');
    expect((await taskRow(h, root)).status).toBe('invalidated');
    const planner = await plannerOf(h, planned.missionId);
    expect(planner.status).toBe('invalidated');
    expect(planner.repair?.kind).toBe('replan');
    // redelivery of the same event adds nothing
    expect(await kindCount(h, 'replan_coalesced')).toBe(1);
  });
});

it('when the postcondition completes the held repair and exactly one replan are released together', async () => {
  await withHarness(async (h) => {
    const { planned, root } = await verifiedHit(h);
    const verifier = await claimStart(h, {
      taskId: await gateTask(h, planned.missionId),
    });
    await h.coordinator.publishOutput(verifier.context, {
      kind: 'verification',
      content: { observed: 'ok' },
      dependencyVector: [],
    });
    expect((await taskRow(h, root)).status).toBe('runnable');
    const planner = await plannerOf(h, planned.missionId);
    expect(planner.status).toBe('runnable');
    expect(planner.repair?.kind).toBe('replan');
    expect(await kindCount(h, 'replan_scheduled')).toBe(1);
    expect(await kindCount(h, 'repair_scheduled')).toBe(1);
    // the replan attempt is a replan attempt
    const replan = await claimStart(h, { taskId: planner.id as TaskId });
    expect(replan.attempt.kind).toBe('replan');
  });
});

it('when the postcondition itself fails the held repair and replan proceed as normal', async () => {
  await withHarness(async (h) => {
    const { planned, root } = await verifiedHit(h);
    const gate = await gateTask(h, planned.missionId);
    for (let i = 0; i < 3; i += 1) {
      const attempt = await claimStart(h, { taskId: gate });
      await h.coordinator.failAttempt(attempt.context, {
        reason: 'probe unreachable',
      });
    }
    expect((await taskRow(h, gate)).status).toBe('failed');
    expect((await taskRow(h, root)).status).toBe('runnable');
    expect((await plannerOf(h, planned.missionId)).status).toBe('runnable');
    expect(await kindCount(h, 'replan_scheduled')).toBe(1);
    expect(await kindCount(h, 'repair_scheduled')).toBe(1);
  });
});

it('a mismatched self-write has no gate: repair and replan are scheduled at once', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [root] = planned.taskIds;
    const attempt = await claimStart(h, { taskId: root });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [attempt.context.attemptId],
        taskIds: [root],
        selfWrite: 'mismatch',
        reason: 'self_write_mismatch',
      }),
    );
    const kinds = (await recoveryKinds(h, planned.missionId)).map(
      (r) => r.kind,
    );
    expect(kinds).toContain('repair_scheduled');
    expect(kinds).toContain('replan_scheduled');
    expect(kinds).not.toContain('replan_coalesced');
    expect(kinds).not.toContain('postcondition_scheduled');
    expect((await plannerOf(h, planned.missionId)).status).toBe('runnable');
  });
});

it('no self-write: exactly one replan_scheduled per event, even with two root tasks invalidated', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    const attemptB = await claimStart(h, { taskId: b });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [attemptA.context.attemptId, attemptB.context.attemptId],
        taskIds: [a, b],
      }),
    );
    expect(await kindCount(h, 'replan_scheduled')).toBe(1);
    expect(await kindCount(h, 'repair_scheduled')).toBe(2);
    expect(await kindCount(h, 'replan_coalesced')).toBe(0);
  });
});

const three = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

async function verifiedHitOn(
  h: Harness,
  planned: Awaited<ReturnType<typeof plannedMission>>,
  index: number,
) {
  const task = planned.taskIds[index];
  const attempt = await claimStart(h, { taskId: task });
  const event = invalidationFor({
    missionId: planned.missionId,
    attemptIds: [attempt.context.attemptId],
    taskIds: [task],
    selfWrite: 'verified',
    sourceKey: `checkout.config/db.k${index}`,
  });
  await h.coordinator.onInvalidation(event);
  return { task, event };
}

it('two events behind one gate: one replan for the planner, the second merge is recorded explicitly, released exactly once', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const first = await verifiedHitOn(h, planned, 0);
    const second = await verifiedHitOn(h, planned, 1);
    // one open gate per mission
    expect(await count(h, 'coordinator.tasks', "role = 'postcondition'")).toBe(
      1,
    );
    const merged = (
      await h.admin.query<{ detail: string }>(
        `SELECT detail FROM coordinator.recovery_events
          WHERE mission_id = $1 AND kind = 'replan_coalesced' ORDER BY created_at`,
        [planned.missionId],
      )
    ).rows;
    expect(merged).toHaveLength(2); // the hold (event 1) and the explicit merge (event 2)
    expect(merged.some((r) => r.detail.startsWith('merged'))).toBe(true);
    expect(await kindCount(h, 'replan_scheduled')).toBe(0);

    const verifier = await claimStart(h, {
      taskId: await gateTask(h, planned.missionId),
    });
    await h.coordinator.publishOutput(verifier.context, {
      kind: 'verification',
      content: { observed: 'ok' },
      dependencyVector: [],
    });
    expect(await kindCount(h, 'replan_scheduled')).toBe(1);
    expect(await kindCount(h, 'repair_scheduled')).toBe(2);
    expect((await taskRow(h, first.task)).status).toBe('runnable');
    expect((await taskRow(h, second.task)).status).toBe('runnable');
    expect((await plannerOf(h, planned.missionId)).status).toBe('runnable');
    void first;
  });
});

it('a second release call, a redelivered event and a pause/resume in between never replan twice', async () => {
  await withHarness(async (h) => {
    const { planned, event } = await (async () => {
      const r = await verifiedHit(h);
      return { planned: r.planned, event: r.event };
    })();
    await h.coordinator.control.pause(planned.missionId);
    await h.coordinator.control.resume(planned.missionId);
    // the hold survived the pause
    expect((await plannerOf(h, planned.missionId)).status).toBe('invalidated');
    await h.coordinator.onInvalidation(event); // redelivery
    expect(await kindCount(h, 'replan_coalesced')).toBe(1);

    const verifier = await claimStart(h, {
      taskId: await gateTask(h, planned.missionId),
    });
    await h.coordinator.publishOutput(verifier.context, {
      kind: 'verification',
      content: {},
      dependencyVector: [],
    });
    const gate = await gateTask(h, planned.missionId);
    const released = await withTransaction(h.pool, async (client) => {
      const tx = { client, events: new EventBuffer(createEventSink()) };
      return releaseGate(tx as never, planned.missionId, gate);
    });
    expect(released).toBe(0);
    expect(await kindCount(h, 'replan_scheduled')).toBe(1);
    expect(await kindCount(h, 'repair_scheduled')).toBe(1);
  });
});

it('the reaper path releases the held replan too: the gate attempts expire until the postcondition fails', async () => {
  await withHarness(async (h) => {
    const { planned, root } = await verifiedHit(h);
    const gate = await gateTask(h, planned.missionId);
    for (let i = 0; i < 3; i += 1) {
      const attempt = await claimStart(h, { taskId: gate });
      await h.admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
        [attempt.context.attemptId],
      );
      await h.coordinator.reapExpired();
    }
    expect((await taskRow(h, gate)).status).toBe('failed');
    expect((await taskRow(h, root)).status).toBe('runnable');
    expect((await plannerOf(h, planned.missionId)).status).toBe('runnable');
    expect(await kindCount(h, 'replan_scheduled')).toBe(1);
  });
});

it('replanCap holds across a hold: a released replan counts, a later event cannot add another', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, three);
      await verifiedHitOn(h, planned, 0);
      const verifier = await claimStart(h, {
        taskId: await gateTask(h, planned.missionId),
      });
      await h.coordinator.publishOutput(verifier.context, {
        kind: 'verification',
        content: {},
        dependencyVector: [],
      });
      expect(await kindCount(h, 'replan_scheduled')).toBe(1);
      // a later, ungated root invalidation: the replan is pending and the cap is reached
      const task = planned.taskIds[2];
      const attempt = await claimStart(h, { taskId: task });
      await h.coordinator.onInvalidation(
        invalidationFor({
          missionId: planned.missionId,
          attemptIds: [attempt.context.attemptId],
          taskIds: [task],
          sourceKey: 'checkout.config/db.k9',
        }),
      );
      expect(await kindCount(h, 'replan_scheduled')).toBe(1);
    },
    { config: { replanCap: 1 } },
  );
});

it('C-10: a later UNGATED event that reaches the held planner merges into the held replan; it never releases it early and it still counts as replan_*', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, two);
      const [root] = planned.taskIds;
      const rootAttempt = await claimStart(h, { taskId: root });
      await h.coordinator.onInvalidation(
        invalidationFor({
          missionId: planned.missionId,
          attemptIds: [rootAttempt.context.attemptId],
          taskIds: [root],
          selfWrite: 'verified',
          sourceKey: 'checkout.config/db.k0',
        }),
      );
      const planner = await plannerOf(h, planned.missionId);
      expect(planner.status).toBe('invalidated');
      // the planner's own latest attempt read something a later, ungated event changes
      const plannerAttempt = (
        await h.admin.query(
          `SELECT id FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n DESC LIMIT 1`,
          [planner.id],
        )
      ).rows[0].id as string;
      await h.coordinator.onInvalidation(
        invalidationFor({
          missionId: planned.missionId,
          attemptIds: [plannerAttempt],
          taskIds: [planner.id],
          sourceKey: 'checkout.health',
        }),
      );
      // still held, nothing escaped the cap, no repair_* was recorded for a planner run
      expect((await plannerOf(h, planned.missionId)).status).toBe(
        'invalidated',
      );
      expect(await kindCount(h, 'replan_scheduled')).toBe(0);
      const plannerRows = await h.admin.query<{ kind: string }>(
        `SELECT kind FROM coordinator.recovery_events WHERE task_id = $1`,
        [planner.id],
      );
      expect(plannerRows.rows.map((r) => r.kind).sort()).toEqual([
        'replan_coalesced',
        'replan_coalesced',
      ]);

      const verifier = await claimStart(h, {
        taskId: await gateTask(h, planned.missionId),
      });
      await h.coordinator.publishOutput(verifier.context, {
        kind: 'verification',
        content: {},
        dependencyVector: [],
      });
      expect(await kindCount(h, 'replan_scheduled')).toBe(1);
      expect((await plannerOf(h, planned.missionId)).status).toBe('runnable');
    },
    { config: { replanCap: 2 } },
  );
});
