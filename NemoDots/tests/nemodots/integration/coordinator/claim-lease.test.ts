// Leases and fences against real PostgreSQL (ARCHITECTURE.md section 6).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { FenceError } from '../../../../src/server/nemodots/coordinator/index.js';
import type { ModelCallRecord } from '../../../../src/server/nemodots/contracts/index.js';
import {
  attemptRow,
  claimStart,
  count,
  expireLease,
  plannedMission,
  receipt,
  taskRow,
  vectorOf,
  withHarness,
} from './harness.js';

it('claim race: concurrent claimers of one runnable task have exactly one winner', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    // Only task 0 is runnable (task 1 waits for it).
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.coordinator.claimAttempt({
          workerId: `racer-${i}`,
          missionId: planned.missionId,
        }),
      ),
    );
    const winners = results.filter((claimed) => claimed !== null);
    expect(winners).toHaveLength(1);
    const claimed = winners[0]!;
    expect(claimed.context.taskId).toBe(planned.taskIds[0]);
    expect(claimed.attempt.kind).toBe('initial');
    expect(claimed.context.fencingToken).toBe(1);
    const task = await taskRow(h, planned.taskIds[0]);
    expect(task.status).toBe('leased');
    expect(task.attempt_count).toBe(1);
    expect(task.fence_seq).toBe(1);
    expect(
      await count(h, 'coordinator.task_attempts', 'task_id = $1', [
        planned.taskIds[0],
      ]),
    ).toBe(1);
  });
});

it('claim does not hand out tasks of paused missions or tasks with unmet prerequisites', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    expect((await taskRow(h, planned.taskIds[1])).status).toBe('pending');
    await h.coordinator.control.pause(planned.missionId);
    expect(
      await h.coordinator.claimAttempt({
        workerId: 'w',
        missionId: planned.missionId,
      }),
    ).toBeNull();
    await h.coordinator.control.resume(planned.missionId);
    const claimed = await h.coordinator.claimAttempt({
      workerId: 'w',
      missionId: planned.missionId,
    });
    expect(claimed?.context.taskId).toBe(planned.taskIds[0]);
  });
});

it('heartbeat renews the lease and a stale token or expired lease fails with FenceError', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const first = await claimStart(h, {
      taskId: planned.taskIds[0],
      leaseMs: 5_000,
    });
    const before = (await attemptRow(h, first.context.attemptId))
      .lease_expires_at as Date;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const renewed = await h.coordinator.heartbeat(first.context, 60_000);
    expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(
      before.getTime() + 30_000,
    );

    // Reaper takeover: the old token is dead for the heartbeat too.
    await expireLease(h, first.context.attemptId);
    await expect(h.coordinator.heartbeat(first.context)).rejects.toMatchObject({
      name: 'FenceError',
      reason: 'lease_expired',
    });
    const reaped = await h.coordinator.reapExpired();
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toMatchObject({
      attemptId: first.context.attemptId,
      task: 'requeued',
    });
    await expect(h.coordinator.heartbeat(first.context)).rejects.toMatchObject({
      name: 'FenceError',
      reason: 'attempt_not_running',
    });

    const second = await claimStart(h, {
      taskId: planned.taskIds[0],
      workerId: 'worker-b',
    });
    expect(second.context.fencingToken).toBeGreaterThan(
      first.context.fencingToken,
    );
    expect(second.attempt.kind).toBe('retry');
    await expect(
      h.coordinator.heartbeat(second.context),
    ).resolves.toBeDefined();
    // The first token still cannot heartbeat even though the task is running again.
    await expect(h.coordinator.heartbeat(first.context)).rejects.toBeInstanceOf(
      FenceError,
    );
  });
});

function modelCall(context: {
  attemptId: string;
  taskId: string;
  missionId: string;
}): ModelCallRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    scope: {
      ownerId: 'owner',
      missionId: context.missionId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
    taskId: context.taskId,
    attemptId: context.attemptId,
    role: 'worker',
    model: { requested: 'fixture-worker', returned: 'fixture-worker' },
    provider: { host: 'fixture.invalid', mode: 'fixture' },
    contextSnapshotId: randomUUID(),
    attempts: [
      {
        n: 1,
        startedAt: now,
        headersAt: now,
        firstContentAt: now,
        finishedAt: now,
        httpStatus: 200,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          cachedTokens: null,
          reasoningTokens: null,
        },
        finishReason: 'stop',
        error: null,
        retryAfterMs: null,
        streamed: false,
        outcome: 'recorded',
      },
    ],
    outcome: 'completed',
    outputDigest: 'b'.repeat(64),
    outputDependencyVector: [],
    toolCalls: [],
    createdAt: now,
  } as unknown as ModelCallRecord;
}

function snapshotFor(vector = vectorOf([])) {
  return {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: 'c'.repeat(64),
    prefixLength: 10,
    contextDigest: 'd'.repeat(64),
    contextLength: 20,
    toolSchemaHash: 'e'.repeat(64),
    injected: {
      receipts: [],
      inheritedArtifacts: [],
      runbooks: [],
      pageSnapshots: [],
      memories: [],
      invalidationEvents: [],
      historyItems: [],
    },
    dependencyVector: vector,
    volatile: { nowIso: new Date().toISOString() },
  } as never;
}

it('reaper takeover: the old worker publishOutput/delegate/publishFinding/recordModelCall all throw FenceError and write nothing; the orphaned call is recorded (C16)', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const taskId = planned.taskIds[0];
    const stale = await claimStart(h, { taskId, workerId: 'worker-a' });
    const readReceipt = receipt();
    const vector = vectorOf([
      {
        sourceKey: 'checkout.health',
        sourceRevision: 4,
        receiptId: readReceipt,
      },
    ]);

    // Takeover: lease expires, reaper marks the attempt expired and bumps the fence.
    await expireLease(h, stale.context.attemptId);
    await h.coordinator.reapExpired();
    expect((await attemptRow(h, stale.context.attemptId)).status).toBe(
      'expired',
    );
    const fresh = await claimStart(h, { taskId, workerId: 'worker-b' });
    expect(fresh.context.fencingToken).toBeGreaterThan(
      stale.context.fencingToken,
    );

    const ledgerBefore = (await h.ledger.rows()).length;
    const validatorCallsBefore = h.validator.calls.length;
    const tasksBefore = await count(h, 'coordinator.tasks');
    const outputsBefore = await count(h, 'coordinator.task_outputs');

    await expect(
      h.coordinator.publishOutput(stale.context, {
        kind: 'finding',
        content: { note: 'from the old worker' },
        dependencyVector: vector,
      }),
    ).rejects.toBeInstanceOf(FenceError);
    await expect(
      h.coordinator.delegate(stale.context, {
        title: 'child',
        role: 'verifier',
        question: 'verify',
        dependsOn: [],
        justification: 'because',
        dependencyVector: vector,
      }),
    ).rejects.toBeInstanceOf(FenceError);
    await expect(
      h.coordinator.publishFinding(stale.context, {
        claim: 'a claim',
        supportingReceiptIds: [readReceipt],
        confidence: 'low',
        dependencyVector: vector,
      }),
    ).rejects.toBeInstanceOf(FenceError);
    const record = modelCall(stale.context);
    await expect(
      h.coordinator.recordModelCall(stale.context, {
        record,
        snapshot: snapshotFor(vector),
      }),
    ).rejects.toMatchObject({ name: 'FenceError' });

    // Nothing was written, and the support validator was never reached: the
    // fence check precedes it.
    expect(await count(h, 'coordinator.task_outputs')).toBe(outputsBefore);
    expect(await count(h, 'coordinator.findings')).toBe(0);
    expect(await count(h, 'coordinator.tasks')).toBe(tasksBefore);
    expect((await h.ledger.rows()).length).toBe(ledgerBefore);
    expect(h.validator.calls.length).toBe(validatorCallsBefore);
    expect(
      (await attemptRow(h, stale.context.attemptId)).model_call_ids,
    ).toEqual([]);

    // C16: the completed inference call is stored unfenced, flagged orphaned.
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].fenceReason).toBe('attempt_not_running');
    const orphanRows = await h.admin.query(
      `SELECT attempt_id, model_call_id, outcomes FROM public.coord_test_orphans`,
    );
    expect(orphanRows.rows).toEqual([
      {
        attempt_id: stale.context.attemptId,
        model_call_id: record.id,
        outcomes: ['orphaned_fence'],
      },
    ]);

    // The new owner is unaffected.
    const published = await h.coordinator.publishOutput(fresh.context, {
      kind: 'handoff',
      content: { note: 'from the new worker' },
      dependencyVector: [],
    });
    expect(published.outputId).toBeTruthy();
    expect((await taskRow(h, taskId)).status).toBe('succeeded');
  });
});

it('a worker that exhausts maxAttempts through failures and expiries fails the task and then the mission', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'investigator' },
      ]);
      const taskId = planned.taskIds[0];
      const first = await claimStart(h, { taskId });
      expect(
        await h.coordinator.failAttempt(first.context, { reason: 'boom' }),
      ).toBe('requeued');
      const second = await claimStart(h, { taskId });
      expect(second.attempt.kind).toBe('retry');
      await expireLease(h, second.context.attemptId);
      await h.coordinator.reapExpired();
      const third = await claimStart(h, { taskId });
      expect(
        await h.coordinator.failAttempt(third.context, { reason: 'boom 3' }),
      ).toBe('failed');
      expect((await taskRow(h, taskId)).status).toBe('failed');
      await h.coordinator.outbox.drain();
      const mission = await h.coordinator.control.get(planned.missionId);
      expect(mission.status).toBe('failed');
      expect(mission.failureReason).toContain(taskId);
      // Failed missions leave nothing claimable.
      expect(
        await h.coordinator.claimAttempt({
          workerId: 'w',
          missionId: planned.missionId,
        }),
      ).toBeNull();
    },
    {
      config: {
        taskDefaults: { maxAttempts: 3, maxIterations: 12, maxTokens: 20_000 },
      },
    },
  );
});

it('pause stops new claims and marks draining attempts aborted(mission_paused); resume makes the task claimable again without using up attempts', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const running = await claimStart(h, { taskId: planned.taskIds[0] });
    const paused = await h.coordinator.control.pause(planned.missionId);
    expect(paused.status).toBe('paused');
    const attempt = await attemptRow(h, running.context.attemptId);
    expect(attempt.status).toBe('aborted');
    expect(attempt.abort_reason).toBe('mission_paused');
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('runnable');

    // The aborted worker cannot publish.
    await expect(
      h.coordinator.publishOutput(running.context, {
        kind: 'handoff',
        content: {},
        dependencyVector: [],
      }),
    ).rejects.toBeInstanceOf(FenceError);
    // No claims while paused.
    expect(
      await h.coordinator.claimAttempt({
        workerId: 'w',
        missionId: planned.missionId,
      }),
    ).toBeNull();
    await h.coordinator.control.resume(planned.missionId);
    const again = await claimStart(h, { taskId: planned.taskIds[0] });
    expect(again.attempt.n).toBe(2);
    expect(again.attempt.kind).toBe('retry');
    // Pausing is not the worker's failure.
    expect(
      await count(
        h,
        'coordinator.task_attempts',
        "task_id = $1 AND status IN ('failed','expired')",
        [planned.taskIds[0]],
      ),
    ).toBe(0);
  });
});
