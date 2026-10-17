// RecoveryPort: status-first aborts, repair / replan / postcondition scheduling,
// coalescing behind verified self-writes, branch_preserved and the D9
// invalidation_resolved rule.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  evaluateOpen,
  OpenInvalidationsError,
} from '../../../../src/server/nemodots/coordinator/index.js';
import {
  EventPayloadSchema,
  MissionSnapshotSchema,
  type ActionId,
  type TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  attemptRow,
  claimStart,
  count,
  eventKinds,
  invalidationFor,
  plannedMission,
  probeReceipt,
  recoveryKinds,
  taskRow,
  vectorOf,
  withHarness,
  type Harness,
} from './harness.js';

const three = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
  { role: 'investigator' as const, dependsOn: [0] },
];

async function open(h: Harness, missionId: string) {
  const client = await h.pool.connect();
  try {
    return (await evaluateOpen(client, h.coordinator.deps, missionId)).open;
  } finally {
    client.release();
  }
}

async function resolvedAt(h: Harness, eventId: string) {
  const { rows } = await h.admin.query(
    `SELECT resolved_at FROM coordinator.invalidations WHERE event_id = $1`,
    [eventId],
  );
  return rows[0].resolved_at as Date | null;
}

it('aborts only attempts whose readset is affected and records branch_preserved for the hand-enumerated others', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a, b, c] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    const attemptB = await claimStart(h, { taskId: b });
    const event = invalidationFor({
      missionId: planned.missionId,
      attemptIds: [attemptA.context.attemptId],
      taskIds: [a],
      preserved: [b, c],
    });

    await h.coordinator.onInvalidation(event);

    // A: status written first, with the reason.
    const aborted = await attemptRow(h, attemptA.context.attemptId);
    expect(aborted.status).toBe('aborted');
    expect(aborted.abort_reason).toBe('readset_invalidated');
    // B: untouched and still able to publish.
    expect((await attemptRow(h, attemptB.context.attemptId)).status).toBe(
      'running',
    );
    expect((await taskRow(h, b)).status).toBe('running');
    // A's task is back in the pool with a repair spec naming this invalidation.
    const task = await taskRow(h, a);
    expect(task.status).toBe('runnable');
    expect(task.repair).toMatchObject({
      kind: 'repair',
      repairOf: {
        attemptId: attemptA.context.attemptId,
        invalidationEventId: event.id,
      },
    });

    const recoveries = await recoveryKinds(h, planned.missionId);
    const pick = (kind: string) =>
      recoveries
        .filter((row) => row.kind === kind)
        .map((row) => row.task_id ?? row.attempt_id);
    expect(pick('attempt_aborted')).toEqual([attemptA.context.taskId]);
    expect(pick('repair_scheduled')).toEqual([a]);
    expect(pick('branch_preserved').sort()).toEqual([b, c].sort());
    // A root task invalidation re-invokes the planner (bounded).
    expect(pick('replan_scheduled')).toHaveLength(1);

    // Everything emitted validates against the shared event schemas.
    const events = await h.admin.query(
      `SELECT payload FROM coordinator.events WHERE mission_id = $1`,
      [planned.missionId],
    );
    for (const row of events.rows) EventPayloadSchema.parse(row.payload);

    // The repair attempt is marked as such and starts without the old context.
    const repair = await claimStart(h, { taskId: a, workerId: 'repairer' });
    expect(repair.attempt.kind).toBe('repair');
    expect(repair.attempt.repairOf).toEqual({
      attemptId: attemptA.context.attemptId,
      invalidationEventId: event.id,
    });
    expect(repair.attempt.inheritedDependencyVector).toEqual([]);

    // B publishes normally: its branch was preserved.
    await expect(
      h.coordinator.publishOutput(attemptB.context, {
        kind: 'handoff',
        content: { ok: true },
        dependencyVector: [],
      }),
    ).resolves.toBeDefined();
  });
});

it('does not abort an attempt the ledger closure already marked invalidated, but still schedules its repair', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a] = planned.taskIds;
    const claimed = await claimStart(h, { taskId: a });
    // What the ledger's closure transaction does (status first).
    await h.admin.query(
      `UPDATE coordinator.task_attempts SET status = 'invalidated' WHERE id = $1`,
      [claimed.context.attemptId],
    );
    const event = invalidationFor({
      missionId: planned.missionId,
      attemptIds: [claimed.context.attemptId],
      taskIds: [a],
    });
    await h.coordinator.onInvalidation(event);
    const attempt = await attemptRow(h, claimed.context.attemptId);
    expect(attempt.status).toBe('invalidated');
    expect(attempt.finished_at).not.toBeNull(); // stamped by the trigger
    const kinds = (await recoveryKinds(h, planned.missionId)).map(
      (row) => row.kind,
    );
    expect(kinds).not.toContain('attempt_aborted');
    expect(kinds).toContain('repair_scheduled');
    expect((await taskRow(h, a)).status).toBe('runnable');
  });
});

it('marks affected outputs and findings unusable and re-delivery changes nothing', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a] = planned.taskIds;
    const first = await claimStart(h, { taskId: a });
    const vector = vectorOf([
      { sourceKey: 'checkout.health', sourceRevision: 1 },
    ]);
    await h.coordinator.addReadSet(first.context, vector);
    await h.coordinator.publishFinding(first.context, {
      claim: 'x',
      supportingReceiptIds: [vector[0].receiptId],
      confidence: 'low',
      dependencyVector: vector,
    });
    const { outputId } = await h.coordinator.publishOutput(first.context, {
      kind: 'finding',
      content: { v: 1 },
      dependencyVector: vector,
    });
    const event = invalidationFor({
      missionId: planned.missionId,
      attemptIds: [first.context.attemptId],
      taskIds: [a],
      outputIds: [outputId],
      oldReceiptId: vector[0].receiptId,
    });
    await h.coordinator.onInvalidation(event);
    const output = await h.admin.query(
      `SELECT usable, unusable_reason FROM coordinator.task_outputs WHERE id = $1`,
      [outputId],
    );
    expect(output.rows[0].usable).toBe(false);
    expect(output.rows[0].unusable_reason).toMatch(/^invalidated:/);
    expect(await count(h, 'coordinator.findings', 'usable')).toBe(0);
    // A succeeded task goes succeeded -> invalidated -> repairing -> runnable.
    expect((await taskRow(h, a)).status).toBe('runnable');
    expect((await taskRow(h, a)).finished_at).toBeNull();

    const before = await recoveryKinds(h, planned.missionId);
    const eventsBefore = (await eventKinds(h, planned.missionId)).length;
    await h.coordinator.onInvalidation(event);
    expect(await recoveryKinds(h, planned.missionId)).toEqual(before);
    expect((await eventKinds(h, planned.missionId)).length).toBe(eventsBefore);
    expect(await count(h, 'coordinator.invalidations')).toBe(1);
  });
});

it('emits invalidation_resolved only when the last affected task publishes a repair (D9)', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a, b] = planned.taskIds;
    const attemptA = await claimStart(h, { taskId: a });
    const attemptB = await claimStart(h, { taskId: b });
    const event = invalidationFor({
      missionId: planned.missionId,
      attemptIds: [attemptA.context.attemptId, attemptB.context.attemptId],
      taskIds: [a, b],
    });
    await h.coordinator.onInvalidation(event);
    expect(await open(h, planned.missionId)).toHaveLength(1);
    expect(await resolvedAt(h, event.id)).toBeNull();

    // Aborted attempts are terminal, yet the invalidation is still open: the
    // contract helper alone would call it closed; ARCHITECTURE 7.1 requires a
    // published repair.
    const repairA = await claimStart(h, { taskId: a });
    await h.coordinator.publishOutput(repairA.context, {
      kind: 'handoff',
      content: { r: 'a' },
      dependencyVector: [],
    });
    expect(await resolvedAt(h, event.id)).toBeNull();
    expect(await open(h, planned.missionId)).toHaveLength(1);
    expect(
      (await recoveryKinds(h, planned.missionId)).map((r) => r.kind),
    ).not.toContain('invalidation_resolved');

    const repairB = await claimStart(h, { taskId: b });
    await h.coordinator.publishOutput(repairB.context, {
      kind: 'handoff',
      content: { r: 'b' },
      dependencyVector: [],
    });
    expect(await resolvedAt(h, event.id)).not.toBeNull();
    expect(await open(h, planned.missionId)).toHaveLength(0);
    const kinds = (await recoveryKinds(h, planned.missionId)).map(
      (r) => r.kind,
    );
    expect(
      kinds.filter((kind) => kind === 'invalidation_resolved'),
    ).toHaveLength(1);
    expect(await eventKinds(h, planned.missionId)).toContain(
      'invalidation.resolved',
    );

    // The snapshot carries the mission-scoped event with resolvedAt set.
    const snapshot = await h.coordinator.control.snapshot(planned.missionId);
    MissionSnapshotSchema.parse(snapshot);
    expect(snapshot.invalidations).toHaveLength(1);
    expect(snapshot.invalidations[0].resolvedAt).not.toBeNull();
    expect(snapshot.invalidations[0].missionIds).toEqual([planned.missionId]);
    expect(snapshot.lastEventId).toBeGreaterThan(0);
  });
});

it('succeeded is refused while an invalidation is open and reachable once the repair published (D9)', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'investigator' },
      ]);
      const [a, b] = planned.taskIds;
      for (const taskId of [a, b]) {
        const claimed = await claimStart(h, { taskId });
        await h.coordinator.publishOutput(claimed.context, {
          kind: 'handoff',
          content: { done: taskId },
          dependencyVector: [],
        });
      }
      await h.coordinator.outbox.drain();
      expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
        'awaiting_acceptance',
      );

      const event = invalidationFor({
        missionId: planned.missionId,
        taskIds: [a],
        attemptIds: [],
      });
      await h.coordinator.onInvalidation(event);
      const pass = probeReceipt(planned.missionId, 'pass');
      await expect(
        h.coordinator.control.completeAcceptance(planned.missionId, pass),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof OpenInvalidationsError &&
          error.eventIds.includes(event.id),
      );
      // Refusal leaves the mission where it was.
      expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
        'awaiting_acceptance',
      );

      // The scheduled repair wakes the mission (awaiting_acceptance -> running).
      await h.coordinator.outbox.drain();
      expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
        'running',
      );
      const repair = await claimStart(h, { taskId: a });
      expect(repair.attempt.kind).toBe('repair');
      await h.coordinator.publishOutput(repair.context, {
        kind: 'handoff',
        content: { fixed: true },
        dependencyVector: [],
      });
      await h.coordinator.outbox.drain();
      expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
        'awaiting_acceptance',
      );

      const done = await h.coordinator.control.completeAcceptance(
        planned.missionId,
        pass,
      );
      expect(done.status).toBe('succeeded');
      expect(done.acceptanceReceiptId).toBe(pass.id);
      expect(done.finishedAt).not.toBeNull();
    },
    // The planner replan that a root invalidation normally schedules has its
    // own test; disabling it here isolates the D9 rule.
    { coordinator: { recovery: { replanOnRootInvalidation: false } } },
  );
});

it('a verified self-write schedules a postcondition attempt and coalesces other branches behind it; the acting lineage keeps its output', async () => {
  for (const order of ['settled-first', 'event-first'] as const) {
    await withHarness(async (h) => {
      const planned = await plannedMission(h, [
        { role: 'cache_specialist' },
        { role: 'investigator' },
        { role: 'investigator', dependsOn: [0] },
      ]);
      const [actor, other] = planned.taskIds;
      const actorAttempt = await claimStart(h, { taskId: actor });
      await h.coordinator.publishOutput(actorAttempt.context, {
        kind: 'handoff',
        content: { proposed: true },
        dependencyVector: [],
      });
      const otherAttempt = await claimStart(h, { taskId: other });
      const actionId = randomUUID() as ActionId;
      h.intents.add({
        id: actionId,
        missionId: planned.missionId,
        taskId: actor,
        attemptId: actorAttempt.context.attemptId,
        status: 'verified',
      });
      const event = invalidationFor({
        missionId: planned.missionId,
        attemptIds: [otherAttempt.context.attemptId],
        taskIds: [other],
        selfWrite: 'verified',
        preserved: [],
      });

      if (order === 'settled-first') {
        await h.coordinator.onSelfWriteSettled(actionId, 'verified');
        await h.coordinator.onInvalidation(event);
      } else {
        await h.coordinator.onInvalidation(event);
        await h.coordinator.onSelfWriteSettled(actionId, 'verified');
      }

      // Exactly one postcondition task either way.
      const post = await h.admin.query(
        `SELECT id, status, repair FROM coordinator.tasks WHERE mission_id = $1 AND role = 'postcondition'`,
        [planned.missionId],
      );
      expect(post.rows, order).toHaveLength(1);
      expect(post.rows[0].status).toBe('runnable');
      expect(post.rows[0].repair.kind).toBe('postcondition');
      // The acting lineage is not invalidated.
      expect((await taskRow(h, actor)).status).toBe('succeeded');
      expect((await taskRow(h, actor)).output_id).not.toBeNull();
      // The other branch's repair is held behind the postcondition attempt.
      expect((await taskRow(h, other)).status).toBe('invalidated');
      const kinds = (await recoveryKinds(h, planned.missionId)).map(
        (r) => r.kind,
      );
      expect(kinds).toContain('postcondition_scheduled');
      expect(kinds).toContain('repair_coalesced');
      expect(kinds).not.toContain('repair_scheduled');
      expect(
        (
          await h.admin.query(
            `SELECT gate_task_id FROM coordinator.invalidations WHERE event_id = $1`,
            [event.id],
          )
        ).rows[0].gate_task_id,
      ).toBe(post.rows[0].id);

      // The postcondition attempt runs with its own kind; publishing releases the repair.
      const verifier = await claimStart(h, {
        taskId: post.rows[0].id as TaskId,
      });
      expect(verifier.attempt.kind).toBe('postcondition');
      expect(verifier.context.role).toBe('postcondition');
      await h.coordinator.publishOutput(verifier.context, {
        kind: 'verification',
        content: { observed: 'ok' },
        dependencyVector: [],
      });
      expect((await taskRow(h, other)).status).toBe('runnable');
      expect(
        (await recoveryKinds(h, planned.missionId)).map((r) => r.kind),
      ).toContain('repair_scheduled');
      const repair = await claimStart(h, { taskId: other });
      expect(repair.attempt.kind).toBe('repair');
    });
  }
});

it('a failed self-write postcondition sends the proposing task back for repair', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'cache_specialist' },
      { role: 'investigator' },
    ]);
    const [actor] = planned.taskIds;
    const claimed = await claimStart(h, { taskId: actor });
    await h.coordinator.publishOutput(claimed.context, {
      kind: 'handoff',
      content: {},
      dependencyVector: [],
    });
    const actionId = randomUUID() as ActionId;
    h.intents.add({
      id: actionId,
      missionId: planned.missionId,
      taskId: actor,
      attemptId: claimed.context.attemptId,
      status: 'failed',
    });
    await h.coordinator.onSelfWriteSettled(actionId, 'failed');
    expect((await taskRow(h, actor)).status).toBe('runnable');
    const rows = await recoveryKinds(h, planned.missionId);
    expect(rows.map((r) => r.kind)).toContain('repair_scheduled');
    await expect(
      h.coordinator.onSelfWriteSettled(randomUUID() as ActionId, 'verified'),
    ).rejects.toMatchObject({ name: 'IntentNotFoundError' });
  });
});

it('root-task invalidations re-invoke the planner at most replanCap times per mission', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, three);
      const [a, b] = planned.taskIds;
      // Tasks that never ran have nothing to repair: run them first.
      await claimStart(h, { taskId: a });
      await claimStart(h, { taskId: b });
      const first = invalidationFor({
        missionId: planned.missionId,
        taskIds: [a],
      });
      const second = invalidationFor({
        missionId: planned.missionId,
        taskIds: [b],
      });
      await h.coordinator.onInvalidation(first);
      await h.coordinator.onInvalidation(second);
      expect(
        await count(
          h,
          'coordinator.recovery_events',
          "kind = 'replan_scheduled'",
        ),
      ).toBe(1);
      // Both tasks still got their repairs.
      expect(
        await count(
          h,
          'coordinator.recovery_events',
          "kind = 'repair_scheduled'",
        ),
      ).toBe(2);
    },
    { config: { replanCap: 1 } },
  );
});

it('a capped closure pauses the mission and records mission_paused_closure_cap', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a, b] = planned.taskIds;
    const running = await claimStart(h, { taskId: a });
    const event = invalidationFor({
      missionId: planned.missionId,
      taskIds: [a, b],
      attemptIds: [running.context.attemptId],
      reason: 'closure_cap_exceeded',
      capped: true,
    });
    await h.coordinator.onInvalidation(event);
    const mission = await h.coordinator.control.get(planned.missionId);
    expect(mission.status).toBe('paused');
    const kinds = (await recoveryKinds(h, planned.missionId)).map(
      (row) => row.kind,
    );
    expect(kinds).toContain('mission_paused_closure_cap');
    expect(
      await h.coordinator.claimAttempt({
        workerId: 'w',
        missionId: planned.missionId,
      }),
    ).toBeNull();
    await h.coordinator.control.resume(planned.missionId);
    const repair = await claimStart(h, { taskId: a });
    expect(['repair', 'retry']).toContain(repair.attempt.kind);
  });
});

it('sweep() processes an invalidation that was recorded but never processed (crash between the phases)', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a] = planned.taskIds;
    const running = await claimStart(h, { taskId: a });
    const event = invalidationFor({
      missionId: planned.missionId,
      taskIds: [a],
      attemptIds: [running.context.attemptId],
    });
    // Phase 1 only: the row exists, nothing acted on it.
    await h.admin.query(
      `INSERT INTO coordinator.invalidations (event_id, mission_id, event, source_key, reason, self_write)
       VALUES ($1, $2, $3::jsonb, $4, $5, 'none')`,
      [
        event.id,
        planned.missionId,
        JSON.stringify(event),
        event.sourceKey,
        event.reason,
      ],
    );
    expect((await attemptRow(h, running.context.attemptId)).status).toBe(
      'running',
    );
    expect(await open(h, planned.missionId)).toHaveLength(1); // unprocessed counts as open
    expect(await h.coordinator.recovery.sweep()).toBe(1);
    expect((await attemptRow(h, running.context.attemptId)).status).toBe(
      'aborted',
    );
    expect((await taskRow(h, a)).status).toBe('runnable');
  });
});

it('affected intents keep the invalidation open until the actions package closes them; closed ones are recorded as intent_blocked', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'cache_specialist' },
      { role: 'investigator' },
    ]);
    const [a] = planned.taskIds;
    const running = await claimStart(h, { taskId: a });
    const blocked = randomUUID() as ActionId;
    const admitted = randomUUID() as ActionId;
    for (const [id, status] of [
      [blocked, 'blocked'],
      [admitted, 'admitted'],
    ] as const)
      h.intents.add({
        id,
        missionId: planned.missionId,
        taskId: a,
        attemptId: running.context.attemptId,
        status,
      });
    const event = invalidationFor({
      missionId: planned.missionId,
      taskIds: [a],
      attemptIds: [running.context.attemptId],
      actionIds: [blocked, admitted],
    });
    await h.coordinator.onInvalidation(event);
    const repair = await claimStart(h, { taskId: a });
    await h.coordinator.publishOutput(repair.context, {
      kind: 'handoff',
      content: {},
      dependencyVector: [],
    });
    // The task is repaired but one intent is still admitted: open.
    expect(await resolvedAt(h, event.id)).toBeNull();
    const intentBlocked = (
      await h.admin.query(
        `SELECT action_id FROM coordinator.recovery_events WHERE kind = 'intent_blocked'`,
      )
    ).rows;
    expect(intentBlocked.map((row) => row.action_id)).toEqual([blocked]);

    h.intents.setStatus(admitted, 'cancelled');
    expect(await h.coordinator.recovery.reevaluate(planned.missionId)).toEqual([
      event.id,
    ]);
    expect(await resolvedAt(h, event.id)).not.toBeNull();
  });
});

it('a replan attempt publishes a new plan that can supersede obsolete tasks', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, three);
    const [a, b, c] = planned.taskIds;
    const running = await claimStart(h, { taskId: a });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        taskIds: [a],
        attemptIds: [running.context.attemptId],
        preserved: [b, c],
      }),
    );
    const plannerTask = (
      await h.admin.query(
        `SELECT id, status, repair FROM coordinator.tasks
          WHERE mission_id = $1 AND role = 'planner'`,
        [planned.missionId],
      )
    ).rows[0];
    expect(plannerTask.status).toBe('runnable');
    expect(plannerTask.repair.kind).toBe('replan');

    const replanner = await claimStart(h, { taskId: plannerTask.id as TaskId });
    expect(replanner.attempt.kind).toBe('replan');
    expect(replanner.context.role).toBe('planner');
    const task = (title: string) => ({
      title,
      question: 'q',
      role: 'investigator',
      capabilities: [],
      dependsOn: [],
    });
    const published = await h.coordinator.publishPlan(replanner.context, {
      createdByModelCallId: randomUUID() as never,
      plan: { tasks: [task('new 1'), task('new 2')] },
      cancelTaskIds: [c],
    });
    expect(published.taskIds).toHaveLength(2);
    expect((await taskRow(h, c)).status).toBe('cancelled');
    expect((await taskRow(h, b)).status).toBe('runnable'); // untouched
    expect((await taskRow(h, plannerTask.id)).status).toBe('succeeded');
    // Replan tasks are still scheduling artifacts: no edges.
    expect(await h.ledger.rows('artifact:task')).toHaveLength(0);
  });
});
