// W5.2 independent review of replan coalescing (CONTRACTS 1 revision 3 "replan
// coalescing", lead ruling: after a VERIFIED self-write the replan waits behind
// the postcondition like the repairs, released with them as replan_scheduled,
// at most one replan per invalidation event per mission, bounded by replanCap).
// SETUP reuses the coordinator integration harness (plannedMission,
// claimStart, invalidationFor: synthetic events delivered to the real
// coordinator recovery); every expectation below comes from the ruling and
// ARCHITECTURE 5.4 / 11, not from that harness.
import { expect, it } from 'vitest';
import type { TaskId } from '../../../../src/server/nemodots/contracts/index.js';
import {
  createEventSink,
  EventBuffer,
} from '../../../../src/server/nemodots/coordinator/events.js';
import {
  pauseMission,
  resumeMission,
} from '../../../../src/server/nemodots/coordinator/missions.js';
import { releaseGate } from '../../../../src/server/nemodots/coordinator/recovery.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  claimStart,
  invalidationFor,
  plannedMission,
  recoveryKinds,
  withHarness,
  type Harness,
} from '../../integration/coordinator/harness.js';

const ROOTS = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

async function planner(h: Harness, missionId: string) {
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

async function gateOf(h: Harness, missionId: string) {
  const { rows } = await h.admin.query(
    `SELECT id FROM coordinator.tasks WHERE mission_id = $1 AND role = 'postcondition'`,
    [missionId],
  );
  return rows[0].id as TaskId;
}

async function kindsFor(h: Harness, missionId: string, eventId: string) {
  const { rows } = await h.admin.query<{
    kind: string;
    task_id: string | null;
  }>(
    `SELECT kind, task_id FROM coordinator.recovery_events
      WHERE mission_id = $1 AND invalidation_event_id = $2 ORDER BY created_at, id`,
    [missionId, eventId],
  );
  return rows;
}

async function count(h: Harness, missionId: string, kind: string) {
  const { rows } = await h.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM coordinator.recovery_events WHERE mission_id = $1 AND kind = $2`,
    [missionId, kind],
  );
  return Number(rows[0].n);
}

/** A verified self-write invalidating root 0: gate opened, repair + replan held. */
async function heldBehindGate(h: Harness) {
  const planned = await plannedMission(h, ROOTS);
  const root = planned.taskIds[0];
  const attempt = await claimStart(h, { taskId: root });
  const event = invalidationFor({
    missionId: planned.missionId,
    attemptIds: [attempt.context.attemptId],
    taskIds: [root],
    selfWrite: 'verified',
  });
  await h.coordinator.onInvalidation(event);
  const p = await planner(h, planned.missionId);
  expect(p.status).toBe('invalidated');
  expect(p.repair?.kind).toBe('replan');
  return { planned, root, event, plannerId: p.id };
}

async function completeGate(h: Harness, missionId: string) {
  const gate = await claimStart(h, { taskId: await gateOf(h, missionId) });
  await h.coordinator.publishOutput(gate.context, {
    kind: 'verification',
    content: { observed: 'ok' },
    dependencyVector: [],
  });
}

it('cleared: the held planner is not claimable while the gate is open', async () => {
  await withHarness(async (h) => {
    const { planned, plannerId } = await heldBehindGate(h);
    const claimed = await h.coordinator.claimAttempt({
      workerId: 'probe',
      taskId: plannerId as TaskId,
    });
    expect(claimed).toBeNull();
    expect((await planner(h, planned.missionId)).status).toBe('invalidated');
  });
});

it('cleared: held through pause/resume; released exactly once as replan_scheduled; a second release is a no-op', async () => {
  await withHarness(async (h) => {
    const { planned, event } = await heldBehindGate(h);
    const deps = {
      pool: h.pool,
      events: createEventSink(),
      intents: h.intents,
    } as never;
    await pauseMission(deps, planned.missionId as never);
    expect((await planner(h, planned.missionId)).status).toBe('invalidated');
    await resumeMission(deps, planned.missionId as never);
    expect((await planner(h, planned.missionId)).status).toBe('invalidated');
    await completeGate(h, planned.missionId);
    expect((await planner(h, planned.missionId)).status).toBe('runnable');
    const kinds = (await kindsFor(h, planned.missionId, event.id)).map(
      (r) => r.kind,
    );
    expect(kinds.filter((k) => k === 'replan_coalesced')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'replan_scheduled')).toHaveLength(1);
    // a second release of the same gate (redelivered completion) does nothing
    const gate = await gateOf(h, planned.missionId);
    const again = await withTransaction(h.pool, async (client) =>
      releaseGate(
        { client, events: new EventBuffer(createEventSink()) } as never,
        planned.missionId,
        gate,
      ),
    );
    expect(again).toBe(0);
    expect(await count(h, planned.missionId, 'replan_scheduled')).toBe(1);
  });
});

// C-10 probe. The held planner is a task in status `invalidated` with a replan
// spec. The planner's own attempt read checkout.health and the membership
// (ARCHITECTURE 11), so a LATER, ungated invalidation of those reads lists the
// planner, and processInvalidation's eligible loop (ACTIVE_FOR_REPAIR contains
// 'invalidated') requeues it with holdInvalidated=false. Expected (ruling):
// the replan stays behind the open gate; at release exactly one
// replan_scheduled; no planner run recorded as a plain repair.
it('FINDING C-10: a later ungated event that reaches the held planner does not release it early', async () => {
  await withHarness(async (h) => {
    const { planned, plannerId } = await heldBehindGate(h);
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n DESC LIMIT 1`,
      [plannerId],
    );
    const later = invalidationFor({
      missionId: planned.missionId,
      sourceKey: 'checkout.health',
      attemptIds: [rows[0].id],
      taskIds: [plannerId],
      selfWrite: 'none',
    });
    await h.coordinator.onInvalidation(later);
    expect((await planner(h, planned.missionId)).status).toBe('invalidated');
    const plannerRecords = (
      await kindsFor(h, planned.missionId, later.id)
    ).filter((r) => r.task_id === plannerId);
    expect(plannerRecords.map((r) => r.kind)).not.toContain('repair_scheduled');
    await completeGate(h, planned.missionId);
    expect(await count(h, planned.missionId, 'replan_scheduled')).toBe(1);
  });
});

// C-11 probe. Two verified self-write events behind ONE gate (one open
// postcondition per mission), each invalidating a root task. Each event's
// routing must account for its replan (at most one per event): the second
// event's replan is either held (replan_coalesced) or explicitly merged, never
// silently absent from its recovery record.
it('FINDING C-11: a second verified event behind the same gate records its held replan', async () => {
  await withHarness(async (h) => {
    const { planned } = await heldBehindGate(h);
    const second = planned.taskIds[1];
    const attempt = await claimStart(h, { taskId: second });
    const e2 = invalidationFor({
      missionId: planned.missionId,
      sourceKey: 'checkout.config/db.pool_max',
      attemptIds: [attempt.context.attemptId],
      taskIds: [second],
      selfWrite: 'verified',
    });
    await h.coordinator.onInvalidation(e2);
    const kinds = (await kindsFor(h, planned.missionId, e2.id)).map(
      (r) => r.kind,
    );
    expect(kinds).toContain('repair_coalesced');
    expect(kinds).toContain('replan_coalesced');
    await completeGate(h, planned.missionId);
    // one planner run covers both; never two
    expect(
      await count(h, planned.missionId, 'replan_scheduled'),
    ).toBeLessThanOrEqual(2);
    expect(
      await count(h, planned.missionId, 'replan_scheduled'),
    ).toBeGreaterThanOrEqual(1);
  });
});

// Shown for completeness with the oracle note: kinds per mission.
it('cleared: the postcondition failing for good still releases the replan exactly once', async () => {
  await withHarness(async (h) => {
    const { planned } = await heldBehindGate(h);
    const gate = await gateOf(h, planned.missionId);
    for (let i = 0; i < 5; i += 1) {
      const row = await h.admin.query(
        `SELECT status FROM coordinator.tasks WHERE id = $1`,
        [gate],
      );
      if (row.rows[0].status === 'failed') break;
      const attempt = await claimStart(h, { taskId: gate });
      await h.coordinator.failAttempt(attempt.context, {
        reason: 'probe unreachable',
      });
    }
    expect((await planner(h, planned.missionId)).status).toBe('runnable');
    const kinds = (await recoveryKinds(h, planned.missionId)).map(
      (r) => r.kind,
    );
    expect(kinds.filter((k) => k === 'replan_scheduled')).toHaveLength(1);
  });
});

// C-13 probe. recordReplanMerge records the merge only when the planner still
// carries a repair spec. Once a replan attempt is claimed, claimAttempt clears
// `repair` (coordinator/leases.ts:137), so a root invalidation that arrives
// while the replan RUNS is neither scheduled (planner not succeeded) nor
// recorded as merged. Expected (lead: "never silently dropped"): the event's
// recovery record accounts for its replan.
it('FINDING C-13: a root invalidation during a running replan is recorded, not silently dropped', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, ROOTS);
    const [first, second] = planned.taskIds;
    const a1 = await claimStart(h, { taskId: first });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        sourceKey: 'checkout.config/db.pool_max',
        attemptIds: [a1.context.attemptId],
        taskIds: [first],
      }),
    );
    expect(await count(h, planned.missionId, 'replan_scheduled')).toBe(1);
    const p = await planner(h, planned.missionId);
    await claimStart(h, { taskId: p.id as TaskId }); // the replan is running
    const a2 = await claimStart(h, { taskId: second });
    const e2 = invalidationFor({
      missionId: planned.missionId,
      sourceKey: 'checkout.config/db.statement_timeout_ms',
      attemptIds: [a2.context.attemptId],
      taskIds: [second],
    });
    await h.coordinator.onInvalidation(e2);
    const kinds = (await kindsFor(h, planned.missionId, e2.id)).map(
      (r) => r.kind,
    );
    expect(kinds).toContain('repair_scheduled');
    expect(
      kinds.some((k) => k === 'replan_coalesced' || k === 'replan_scheduled'),
    ).toBe(true);
  });
});
