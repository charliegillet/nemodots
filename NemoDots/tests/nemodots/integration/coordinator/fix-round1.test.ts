// Regression tests for the review findings of fix round 1 (each failed against
// the code as reviewed): task-graph wake-ups, concurrent invalidation and
// postcondition writers, the publication guard vector, acceptance rooted in a
// ledger receipt, the D9 settling rules, planner/replan bounds, repair
// inheritance, outbox liveness and poison-task bounds.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AcceptanceInFlightError,
  AcceptanceRejectedError,
  DelegationRejectedError,
  OpenInvalidationsError,
  SupportError,
  createCoordinator,
  createOutbox,
  enqueueOutbox,
  evaluateOpen,
  type IntentRecord,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { acceptMission } from '../../../../src/server/nemodots/coordinator/missions.js';
import type {
  ActionId,
  AttemptId,
  MissionId,
  ObservationReceipt,
  TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';
import { latch } from '../../helpers/barrier.js';
import {
  attemptRow,
  barrierCoordinator,
  claimStart,
  count,
  describeSettled,
  expireLease,
  insertLedgerInvalidation,
  invalidationFor,
  ledgerProbeReceipt,
  plannedMission,
  probeReceipt,
  receipt,
  recoveryKinds,
  sleep,
  staleVersion,
  taskRow,
  until,
  vectorOf,
  withHarness,
  type Harness,
} from './harness.js';

const two = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

const handoff = (content: unknown = { ok: true }) => ({
  kind: 'handoff' as const,
  content,
  dependencyVector: [],
});

async function finishAll(h: Harness, taskIds: TaskId[]) {
  for (const taskId of taskIds) {
    const claimed = await claimStart(h, { taskId });
    await h.coordinator.publishOutput(claimed.context, handoff({ taskId }));
  }
}

async function openEvents(h: Harness, missionId: string) {
  const client = await h.pool.connect();
  try {
    return (await evaluateOpen(client, h.coordinator.deps, missionId)).open;
  } finally {
    client.release();
  }
}

const missionStatus = async (h: Harness, missionId: MissionId) =>
  (await h.coordinator.control.get(missionId)).status;

// ------------------------------------------------------------- task graph

it('two prerequisites completing concurrently still promote their dependent (lost wake-up)', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0, 1] },
    ]);
    const [a, b, c] = planned.taskIds;
    const ca = await claimStart(h, { taskId: a, workerId: 'wa' });
    const cb = await claimStart(h, { taskId: b, workerId: 'wb' });
    // Both transactions run their dependency check before either commits.
    const racy = barrierCoordinator(h, 'output.published', 2);
    const results = await Promise.allSettled([
      racy.publishOutput(ca.context, handoff({ a: 1 })),
      racy.publishOutput(cb.context, handoff({ b: 1 })),
    ]);
    expect(results.map(describeSettled)).toEqual(['fulfilled', 'fulfilled']);
    expect((await taskRow(h, a)).status).toBe('succeeded');
    expect((await taskRow(h, b)).status).toBe('succeeded');
    expect((await taskRow(h, c)).status).toBe('runnable');
    // The mission can finish.
    await finishAll(h, [c]);
    await h.coordinator.outbox.drain();
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
  });
});

it('evaluateMission and the maintenance sweep promote a dependent whose wake-up was lost', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    const [a, b] = planned.taskIds;
    const ca = await claimStart(h, { taskId: a });
    await h.coordinator.publishOutput(ca.context, handoff());
    expect((await taskRow(h, b)).status).toBe('runnable');
    // Lose the promotion (what the READ COMMITTED race did) and its messages.
    await h.admin.query(
      `UPDATE coordinator.tasks SET status = 'pending' WHERE id = $1`,
      [b],
    );
    await h.admin.query(`DELETE FROM coordinator.outbox_applied`);
    await h.admin.query(`DELETE FROM coordinator.outbox`);
    await h.coordinator.runMaintenance();
    expect((await taskRow(h, b)).status).toBe('runnable');
    // And evaluate on its own does the same.
    await h.admin.query(
      `UPDATE coordinator.tasks SET status = 'pending' WHERE id = $1`,
      [b],
    );
    await h.coordinator.control.evaluate(planned.missionId);
    expect((await taskRow(h, b)).status).toBe('runnable');
  });
});

it('a dependent of a failed or cancelled task is cancelled, and delegation refuses such a dependency', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, two);
      const parent = await claimStart(h, { taskId: planned.taskIds[0] });
      const delegate = (title: string, dependsOn: TaskId[]) =>
        h.coordinator.delegate(parent.context, {
          title,
          role: 'verifier',
          question: `question ${title}`,
          dependsOn,
          justification: 'needed',
          dependencyVector: [],
        });
      const first = await delegate('first', []);
      const second = await delegate('second', [first.taskId]);
      expect((await taskRow(h, second.taskId)).status).toBe('pending');
      await h.coordinator.markWaiting(parent.context);

      const child = await claimStart(h, { taskId: first.taskId });
      expect(
        await h.coordinator.failAttempt(child.context, { reason: 'boom' }),
      ).toBe('failed');
      // The dependent can never run: cancelled with a recorded reason.
      const dependent = await taskRow(h, second.taskId);
      expect(dependent.status).toBe('cancelled');
      const reasons = await h.admin.query(
        `SELECT payload ->> 'reason' AS reason FROM coordinator.events
          WHERE payload ->> 'taskId' = $1 AND kind = 'task.status'
          ORDER BY id DESC LIMIT 1`,
        [second.taskId],
      );
      expect(reasons.rows[0].reason).toBe('prerequisite_failed');
      const status = await h.coordinator.resumeFromWaiting(parent.context);
      expect(status.allTerminal).toBe(true);
      // A new delegation may not depend on the failed child.
      await expect(delegate('third', [first.taskId])).rejects.toBeInstanceOf(
        DelegationRejectedError,
      );
    },
    { config: { taskDefaults: { maxAttempts: 1, maxIterations: 12, maxTokens: 20_000 } } },
  );
});

it('a worker that dies between claim and start exhausts maxAttempts instead of looping forever', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [t1] = planned.taskIds;
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const claimed = await h.coordinator.claimAttempt({
        workerId: `w${i}`,
        taskId: t1,
      });
      expect(claimed).not.toBeNull();
      await expireLease(h, claimed!.context.attemptId);
      outcomes.push((await h.coordinator.reapExpired())[0].task);
    }
    expect(outcomes).toEqual(['requeued', 'requeued', 'failed']);
    expect((await taskRow(h, t1)).status).toBe('failed');
    expect(await h.coordinator.claimAttempt({ workerId: 'w9', taskId: t1 })).toBeNull();
  });
});

// ------------------------------------------------- concurrent recovery writers

it('two attempts rejected for the same stale receipt at the same time both follow the C13 path', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const ca = await claimStart(h, { taskId: a, workerId: 'wa' });
    const cb = await claimStart(h, { taskId: b, workerId: 'wb' });
    const shared = vectorOf([
      { sourceKey: 'checkout.config/cache.namespace', sourceRevision: 3 },
    ]);
    h.validator.failWith = staleVersion(shared[0].receiptId);
    // Both rejection transactions are parked before COMMIT.
    const racy = barrierCoordinator(h, 'attempt.finished', 2);
    const results = await Promise.allSettled([
      racy.publishOutput(ca.context, {
        kind: 'finding',
        content: { a: 1 },
        dependencyVector: shared,
      }),
      racy.publishOutput(cb.context, {
        kind: 'finding',
        content: { b: 1 },
        dependencyVector: shared,
      }),
    ]);
    expect(results.map(describeSettled).map((r) => r.split(':')[0])).toEqual([
      'SupportError',
      'SupportError',
    ]);
    expect((await attemptRow(h, ca.context.attemptId)).status).toBe('invalidated');
    expect((await attemptRow(h, cb.context.attemptId)).status).toBe('invalidated');
    // One shared event, both attempts and tasks in it, a repair per task.
    const rows = await h.admin.query(
      `SELECT event FROM coordinator.invalidations WHERE mission_id = $1`,
      [planned.missionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].event.affected.attemptIds.sort()).toEqual(
      [ca.context.attemptId, cb.context.attemptId].sort(),
    );
    const repairs = (await recoveryKinds(h, planned.missionId)).filter(
      (fact) => fact.kind === 'repair_scheduled',
    );
    expect(repairs.map((fact) => fact.task_id).sort()).toEqual([a, b].sort());
    h.validator.failWith = null;
    expect((await taskRow(h, a)).status).toBe('runnable');
    expect((await taskRow(h, b)).status).toBe('runnable');
  });
});

it('the watcher delivering one event concurrently from two places records it once, without error', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a] = planned.taskIds;
    const attempt = await claimStart(h, { taskId: a });
    const event = invalidationFor({
      missionId: planned.missionId,
      attemptIds: [attempt.context.attemptId],
      taskIds: [a],
    });
    const results = await Promise.allSettled([
      h.coordinator.onInvalidation(event),
      h.coordinator.onInvalidation(event),
      h.coordinator.onInvalidation(event),
    ]);
    expect(results.map(describeSettled)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(
      await count(h, 'coordinator.invalidations', 'mission_id = $1', [
        planned.missionId,
      ]),
    ).toBe(1);
    expect((await taskRow(h, a)).status).toBe('runnable');
  });
});

it('a second rejection for the same receipt leaves the first task\'s fresh repair alone', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, two);
      const [t1, t2] = planned.taskIds;
      const stale = vectorOf([
        { sourceKey: 'checkout.config/cache.namespace', sourceRevision: 3 },
      ]);
      const c1 = await claimStart(h, { taskId: t1 });
      const c2 = await claimStart(h, { taskId: t2 });
      h.validator.failWith = new SupportError('stale_version', 'r3 vs 4', stale[0].receiptId);
      await expect(
        h.coordinator.publishOutput(c1.context, {
          kind: 'handoff',
          content: { x: 1 },
          dependencyVector: stale,
        }),
      ).rejects.toBeInstanceOf(SupportError);
      // T1 repairs with fresh evidence.
      h.validator.failWith = null;
      const repair = await claimStart(h, { taskId: t1 });
      expect(repair.attempt.kind).toBe('repair');
      const out = await h.coordinator.publishOutput(repair.context, {
        kind: 'handoff',
        content: { x: 2 },
        dependencyVector: vectorOf([
          { sourceKey: 'checkout.config/cache.namespace', sourceRevision: 4 },
        ]),
      });
      // T2 is now rejected for the SAME stale receipt (same event id).
      h.validator.failWith = new SupportError('stale_version', 'r3 vs 4', stale[0].receiptId);
      await expect(
        h.coordinator.publishOutput(c2.context, {
          kind: 'handoff',
          content: { y: 1 },
          dependencyVector: stale,
        }),
      ).rejects.toBeInstanceOf(SupportError);
      h.validator.failWith = null;
      const output = await h.admin.query(
        `SELECT usable FROM coordinator.task_outputs WHERE id = $1`,
        [out.outputId],
      );
      expect(output.rows[0].usable).toBe(true);
      expect((await taskRow(h, t1)).status).toBe('succeeded');
      expect((await taskRow(h, t2)).status).toBe('runnable');
    },
    { coordinator: { recovery: { replanOnRootInvalidation: false } } },
  );
});

it('two verified self-writes settled concurrently create one postcondition task and no error', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'cache_specialist' },
      { role: 'investigator' },
    ]);
    const [actor] = planned.taskIds;
    const att = await claimStart(h, { taskId: actor });
    await h.coordinator.publishOutput(att.context, handoff({ proposed: true }));
    const ids = [randomUUID() as ActionId, randomUUID() as ActionId];
    for (const id of ids)
      h.intents.add({
        id,
        missionId: planned.missionId,
        taskId: actor,
        attemptId: att.context.attemptId,
        status: 'verified',
      } as IntentRecord);
    const racy = barrierCoordinator(h, 'task.created', 2, 400);
    const results = await Promise.allSettled(
      ids.map((id) => racy.onSelfWriteSettled(id, 'verified')),
    );
    expect(results.map(describeSettled)).toEqual(['fulfilled', 'fulfilled']);
    expect(
      await count(
        h,
        'coordinator.tasks',
        `mission_id = $1 AND role = 'postcondition' AND status NOT IN ('succeeded','failed','cancelled')`,
        [planned.missionId],
      ),
    ).toBe(1);
  });
});

it('the database refuses a second open postcondition task for a mission', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const insert = (ordinal: number, dedupe: string) =>
      h.admin.query(
        `INSERT INTO coordinator.tasks
           (id, mission_id, depth, ordinal, title, question, role, capabilities,
            status, generation, max_attempts, budget, dedupe_key)
         VALUES ($1, $2, 0, $3, 't', 'q', 'postcondition', '{observe}',
                 'runnable', 0, 3, '{"maxIterations":1,"maxTokens":1,"maxChildren":0}', $4)`,
        [randomUUID(), planned.missionId, ordinal, dedupe],
      );
    await insert(50, 'one');
    await expect(insert(51, 'two')).rejects.toMatchObject({ code: '23505' });
  });
});

// ------------------------------------------------ the publication guard vector

it('publishOutput asserts the attempt readset even when the caller\'s vector omits it', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const t = await claimStart(h, { taskId: planned.taskIds[0] });
    const read = vectorOf([{ sourceKey: 'checkout.health', sourceRevision: 1 }]);
    await h.coordinator.addReadSet(t.context, read);
    h.validator.calls = [];
    h.validator.failWith = staleVersion(read[0].receiptId);
    await expect(
      h.coordinator.publishOutput(t.context, handoff()),
    ).rejects.toBeInstanceOf(SupportError);
    expect(h.validator.calls[0].ids).toContain(read[0].receiptId);
    expect(h.validator.calls[0].lockMode).toBe('share');
    expect((await attemptRow(h, t.context.attemptId)).status).toBe('invalidated');
    expect(await h.ledger.rows('artifact:task_output')).toHaveLength(0);
  });
});

it('a published output, finding and delegated task carry the readset as evidence edges', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const t = await claimStart(h, { taskId: planned.taskIds[0] });
    const read = vectorOf([{ sourceKey: 'checkout.health', sourceRevision: 1 }]);
    await h.coordinator.addReadSet(t.context, read);
    await h.coordinator.publishFinding(t.context, {
      claim: 'health is degraded',
      supportingReceiptIds: [],
      confidence: 'high',
      dependencyVector: [],
    });
    const child = await h.coordinator.delegate(t.context, {
      title: 'check',
      role: 'verifier',
      question: 'verify it',
      dependsOn: [],
      justification: 'independent check',
      dependencyVector: [],
    });
    await h.coordinator.publishOutput(t.context, handoff());
    for (const kind of [
      'artifact:finding',
      'artifact:task',
      'artifact:task_output',
    ]) {
      const body = (await h.ledger.rows(kind))[0].body as {
        dependencyVector: { receiptId: string }[];
      };
      expect(body.dependencyVector.map((entry) => entry.receiptId)).toEqual([
        read[0].receiptId,
      ]);
    }
    // The delegated child inherits the parent's context, readset included.
    expect((await taskRow(h, child.taskId)).inherited_dependency_vector).toEqual(
      read,
    );
  });
});

it('a stale readset rejects publishFinding and delegate as well', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    for (const act of ['finding', 'delegate'] as const) {
      const t = await claimStart(h, {
        taskId: planned.taskIds[act === 'finding' ? 0 : 1],
      });
      const read = vectorOf([{ sourceKey: 'checkout.metrics', sourceRevision: 2 }]);
      await h.coordinator.addReadSet(t.context, read);
      h.validator.failWith = staleVersion(read[0].receiptId);
      const call =
        act === 'finding'
          ? h.coordinator.publishFinding(t.context, {
              claim: 'c',
              supportingReceiptIds: [],
              confidence: 'low',
              dependencyVector: [],
            })
          : h.coordinator.delegate(t.context, {
              title: 'x',
              role: 'verifier',
              question: 'q',
              dependsOn: [],
              justification: 'j',
              dependencyVector: [],
            });
      await expect(call).rejects.toBeInstanceOf(SupportError);
      h.validator.failWith = null;
      expect((await attemptRow(h, t.context.attemptId)).status).toBe('invalidated');
    }
  });
});

it('a model call rejected by a SupportError is still stored as unfenced telemetry', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const t = await claimStart(h, { taskId: planned.taskIds[0] });
    const vector = vectorOf([{ sourceKey: 'checkout.health', sourceRevision: 1 }]);
    h.validator.failWith = staleVersion(vector[0].receiptId);
    const modelCallId = randomUUID();
    const record = {
      id: modelCallId,
      attemptId: t.context.attemptId,
      taskId: t.context.taskId,
      role: 'worker',
      model: 'm',
      provider: 'crusoe',
      outcome: 'completed',
      scope: { missionId: planned.missionId },
      outputDependencyVector: [],
      attempts: [
        {
          n: 1,
          outcome: 'recorded',
          usage: { promptTokens: 10, completionTokens: 5, cachedTokens: null },
        },
      ],
    } as never;
    const snapshot = {
      dependencyVector: vector,
      prefixDigest: 'a'.repeat(64),
      contextDigest: 'b'.repeat(64),
    } as never;
    await expect(
      h.coordinator.recordModelCall(t.context, { record, snapshot }),
    ).rejects.toBeInstanceOf(SupportError);
    expect(
      await count(h, 'public.coord_test_ledger', `kind = 'model_call'`),
    ).toBe(0);
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0].fenceReason).toBe('publication_rejected');
    expect(h.orphans[0].record.id).toBe(modelCallId);
    expect(
      await count(h, 'public.coord_test_orphans', 'model_call_id = $1', [
        modelCallId,
      ]),
    ).toBe(1);
    expect((await attemptRow(h, t.context.attemptId)).status).toBe('invalidated');
  });
});

// -------------------------------------------------------------- acceptance

async function toAwaitingAcceptance(h: Harness) {
  const planned = await plannedMission(h, two);
  await finishAll(h, planned.taskIds);
  expect(await h.coordinator.control.evaluate(planned.missionId)).toBe(
    'awaiting_acceptance',
  );
  return planned;
}

it('completeAcceptance takes a receipt id and re-validates it against the ledger under the lock', async () => {
  await withHarness(async (h) => {
    const planned = await toAwaitingAcceptance(h);
    // A receipt id the ledger never saw.
    const forged = probeReceipt(planned.missionId, 'pass');
    await expect(
      h.coordinator.control.completeAcceptance(planned.missionId, forged.id),
    ).rejects.toBeInstanceOf(AcceptanceRejectedError);
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');

    // A real receipt that has been superseded since: the validator refuses it.
    const real = await ledgerProbeReceipt(h, planned.missionId, 'pass');
    h.validator.calls = [];
    h.validator.failWith = staleVersion(real.id);
    await expect(
      h.coordinator.control.completeAcceptance(planned.missionId, real.id),
    ).rejects.toBeInstanceOf(AcceptanceRejectedError);
    expect(h.validator.calls.map((call) => call.ids)).toEqual([[real.id]]);
    expect(h.validator.calls[0].lockMode).toBe('share');
    h.validator.failWith = null;

    // Even with a permissive validator, a superseded ledger row is refused.
    const old = await ledgerProbeReceipt(h, planned.missionId, 'pass');
    await h.admin.query(
      `UPDATE ledger.observation_receipts
          SET status = 'superseded', status_version = status_version + 1
        WHERE id = $1`,
      [old.id],
    );
    await expect(
      h.coordinator.control.completeAcceptance(planned.missionId, old.id),
    ).rejects.toBeInstanceOf(AcceptanceRejectedError);
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');

    const good = await ledgerProbeReceipt(h, planned.missionId, 'pass');
    const done = await h.coordinator.control.completeAcceptance(
      planned.missionId,
      good.id,
    );
    expect(done.status).toBe('succeeded');
    expect(done.acceptanceReceiptId).toBe(good.id);
  });
});

it('the database refuses a succeeded mission without an acceptance receipt that exists in the ledger', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    await expect(
      h.admin.query(
        `UPDATE coordinator.missions SET status = 'succeeded' WHERE id = $1`,
        [planned.missionId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.admin.query(
        `UPDATE coordinator.missions SET status = 'succeeded', acceptance_receipt_id = $2
          WHERE id = $1`,
        [planned.missionId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

it('succeeded is refused while the ledger closure marked a task invalidated and recovery has not run (D9 window)', async () => {
  await withHarness(async (h) => {
    const planned = await toAwaitingAcceptance(h);
    const [a] = planned.taskIds;
    // Exactly what ledger/supersession.ts does inside the closure transaction.
    await h.admin.query(
      `UPDATE coordinator.tasks SET status = 'invalidated',
              transition_version = transition_version + 1 WHERE id = $1`,
      [a],
    );
    await h.admin.query(
      `UPDATE coordinator.task_outputs SET usable = false, unusable_reason = 'invalidated:x'
        WHERE task_id = $1`,
      [a],
    );
    const pass = await ledgerProbeReceipt(h, planned.missionId, 'pass');
    await expect(
      h.coordinator.control.completeAcceptance(planned.missionId, pass.id),
    ).rejects.toBeInstanceOf(OpenInvalidationsError);
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
    expect((await taskRow(h, a)).status).toBe('invalidated');
  });
});

it('a ledger invalidation the coordinator has not received blocks settling until it is delivered', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    await finishAll(h, planned.taskIds);
    // Do not run the outbox: evaluate directly after the closure committed.
    const event = invalidationFor({
      missionId: planned.missionId,
      preserved: planned.taskIds,
    });
    await insertLedgerInvalidation(h.admin, event);
    expect(await h.coordinator.control.evaluate(planned.missionId)).toBe('unchanged');
    expect(await missionStatus(h, planned.missionId)).toBe('running');
    await h.coordinator.onInvalidation(event);
    expect(await h.coordinator.control.evaluate(planned.missionId)).toBe(
      'awaiting_acceptance',
    );
    // The same applies to the final step.
    const second = invalidationFor({
      missionId: planned.missionId,
      preserved: planned.taskIds,
    });
    await insertLedgerInvalidation(h.admin, second);
    const pass = await ledgerProbeReceipt(h, planned.missionId, 'pass');
    await expect(
      h.coordinator.control.completeAcceptance(planned.missionId, pass.id),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OpenInvalidationsError &&
        error.eventIds.includes(second.id),
    );
    await h.coordinator.onInvalidation(second);
    const done = await h.coordinator.control.completeAcceptance(
      planned.missionId,
      pass.id,
    );
    expect(done.status).toBe('succeeded');
  });
});

it('a mission.accept message deferred by open invalidations is never parked, and succeeds once they close', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, two);
      await finishAll(h, planned.taskIds);
      await h.coordinator.outbox.drain();
      expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
      h.probe.receipt = probeReceipt(planned.missionId, 'pass');
      const actionId = randomUUID() as ActionId;
      h.intents.add({
        id: actionId,
        missionId: planned.missionId,
        taskId: planned.taskIds[0],
        attemptId: randomUUID() as AttemptId,
        status: 'committed',
      } as IntentRecord);
      await h.coordinator.onInvalidation(
        invalidationFor({ missionId: planned.missionId, actionIds: [actionId] }),
      );
      const messageRow = async () =>
        (
          await h.admin.query(
            `SELECT * FROM coordinator.outbox WHERE topic = 'mission.accept' AND mission_id = $1
              ORDER BY id DESC LIMIT 1`,
            [planned.missionId],
          )
        ).rows[0];
      // Far more deliveries than maxAttempts (2): the message is deferred, not failed.
      for (let i = 0; i < 6; i += 1) {
        await h.admin.query(
          `UPDATE coordinator.outbox SET available_at = now()
            WHERE topic = 'mission.accept' AND processed_at IS NULL`,
        );
        await h.coordinator.outbox.drain();
      }
      const waiting = await messageRow();
      expect(waiting.failed_at).toBeNull();
      expect(waiting.processed_at).toBeNull();
      expect(waiting.attempts).toBeLessThan(2);
      expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
      // The intent settles, the invalidation resolves, and the same message succeeds.
      h.intents.setStatus(actionId, 'verified');
      await h.coordinator.recovery.reevaluate(planned.missionId);
      await h.admin.query(
        `UPDATE coordinator.outbox SET available_at = now()
          WHERE topic = 'mission.accept' AND processed_at IS NULL`,
      );
      await h.coordinator.outbox.drain();
      expect(await missionStatus(h, planned.missionId)).toBe('succeeded');
    },
    { coordinator: { outbox: { maxAttempts: 2 } } },
  );
});

it('the maintenance reconciler re-enqueues mission.accept when the message was parked', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    await finishAll(h, planned.taskIds);
    await h.coordinator.outbox.drain();
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
    // The message exhausted its attempts (e.g. the probe was unreachable).
    await h.admin.query(
      `UPDATE coordinator.outbox SET failed_at = now()
        WHERE topic = 'mission.accept' AND mission_id = $1`,
      [planned.missionId],
    );
    h.probe.receipt = probeReceipt(planned.missionId, 'pass');
    await h.coordinator.runMaintenance();
    await h.admin.query(
      `UPDATE coordinator.outbox SET available_at = now()
        WHERE topic = 'mission.accept' AND processed_at IS NULL AND failed_at IS NULL`,
    );
    // Not enqueued twice by repeated maintenance.
    await h.coordinator.runMaintenance();
    expect(
      await count(
        h,
        'coordinator.outbox',
        `topic = 'mission.accept' AND mission_id = $1 AND processed_at IS NULL AND failed_at IS NULL`,
        [planned.missionId],
      ),
    ).toBe(1);
    await h.coordinator.outbox.drain();
    expect(await missionStatus(h, planned.missionId)).toBe('succeeded');
  });
});

it('acceptMission is single-flight per mission', async () => {
  await withHarness(async (h) => {
    const planned = await toAwaitingAcceptance(h);
    const gate = latch();
    let probeRuns = 0;
    let receiptBuilt: ObservationReceipt | null = null;
    const deps = {
      ...h.coordinator.deps,
      probe: {
        async run(missionId: MissionId) {
          probeRuns += 1;
          await gate.promise;
          receiptBuilt = await ledgerProbeReceipt(h, missionId, 'pass');
          return receiptBuilt;
        },
      },
    };
    const first = acceptMission(deps, planned.missionId);
    await until(async () => probeRuns > 0, 'the first probe to start');
    await expect(acceptMission(deps, planned.missionId)).rejects.toBeInstanceOf(
      AcceptanceInFlightError,
    );
    gate.open();
    const done = await first;
    expect(done.status).toBe('succeeded');
    expect(probeRuns).toBe(1);
    expect(done.acceptanceReceiptId).toBe(receiptBuilt!.id);
  });
});

// ------------------------------------------------------------------ outbox

it('a handler that runs longer than the claim keeps its message (the claim is renewed)', async () => {
  await withHarness(async (h) => {
    const deliveries: string[] = [];
    const hold = latch();
    const slow = createOutbox(h.coordinator.deps, {
      workerId: 'slow',
      claimMs: 90,
      handlers: {
        'test.long': async () => {
          deliveries.push('slow');
          await hold.promise;
        },
      },
    });
    const other = createOutbox(h.coordinator.deps, {
      workerId: 'other',
      claimMs: 90,
      handlers: {
        'test.long': async () => {
          deliveries.push('other');
        },
      },
    });
    const client = await h.pool.connect();
    await enqueueOutbox(client, { topic: 'test.long', payload: {} });
    client.release();
    const run = slow.processBatch();
    await until(async () => deliveries.length > 0, 'the handler to start');
    await sleep(400); // four claim lengths
    expect(await other.processBatch()).toBe(0);
    hold.open();
    await run;
    expect(deliveries).toEqual(['slow']);
  });
});

it('a slow handler blocks neither other messages nor the maintenance step', async () => {
  await withHarness(async (h) => {
    const hold = latch();
    const handled: string[] = [];
    let maintenanceRuns = 0;
    const outbox = createOutbox(h.coordinator.deps, {
      workerId: 'loop',
      pollMs: 20,
      batchSize: 4,
      maintenance: async () => {
        maintenanceRuns += 1;
      },
      handlers: {
        'test.slow': async () => {
          handled.push('slow:start');
          await hold.promise;
          handled.push('slow:end');
        },
        'test.fast': async () => {
          handled.push('fast');
        },
      },
    });
    const client = await h.pool.connect();
    await enqueueOutbox(client, { topic: 'test.slow', payload: {} });
    await enqueueOutbox(client, { topic: 'test.fast', payload: {} });
    client.release();
    await outbox.start();
    await until(async () => handled.includes('fast'), 'the fast message');
    const before = maintenanceRuns;
    await until(async () => maintenanceRuns >= before + 2, 'maintenance to keep running');
    expect(handled).not.toContain('slow:end');
    hold.open();
    await outbox.stop();
    expect(handled).toContain('slow:end');
  });
});

it('every coordinator process gets its own worker id by default', async () => {
  await withHarness(async (h) => {
    const again = createCoordinator(h.coordinator.deps);
    expect(again.workerId).not.toBe(h.coordinator.workerId);
    expect(h.coordinator.workerId).toMatch(/^coordinator-\d+-[0-9a-f]{8}$/);
    await again.outbox.stop();
  });
});

// -------------------------------------------- livelocks and recovery bounds

it('a replan that cancels an invalidated root task closes its invalidation, so the mission can settle', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const running = await claimStart(h, { taskId: a });
    // The ledger closure marks the attempt invalidated.
    await h.admin.query(
      `UPDATE coordinator.task_attempts SET status = 'invalidated' WHERE id = $1`,
      [running.context.attemptId],
    );
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [running.context.attemptId],
        taskIds: [a],
        preserved: [b],
      }),
    );
    const replanner = await claimStart(h, { taskId: planned.plannerContext.taskId });
    const plan = await h.coordinator.publishPlan(replanner.context, {
      createdByModelCallId: randomUUID() as never,
      plan: {
        tasks: ['new 1', 'new 2'].map((title) => ({
          title,
          question: 'q',
          role: 'investigator',
          capabilities: [],
          dependsOn: [],
        })),
      },
      cancelTaskIds: [a],
    });
    await finishAll(h, [b, ...plan.taskIds]);
    expect((await taskRow(h, a)).status).toBe('cancelled');
    expect(await openEvents(h, planned.missionId)).toEqual([]);
    await h.coordinator.runMaintenance();
    await h.coordinator.outbox.drain();
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
  });
});

it('a delegated child whose repairs are exhausted closes its invalidation, so the mission can settle', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const parent = await claimStart(h, { taskId: a });
    const { taskId: child } = await h.coordinator.delegate(parent.context, {
      title: 'verify',
      role: 'verifier',
      question: 'check it',
      dependsOn: [],
      justification: 'needs a verifier',
      dependencyVector: [],
    });
    await h.coordinator.markWaiting(parent.context);
    const c1 = await claimStart(h, { taskId: child });
    const r = receipt();
    h.validator.failWith = staleVersion(r);
    await expect(
      h.coordinator.publishOutput(c1.context, {
        kind: 'finding',
        content: { x: 1 },
        dependencyVector: vectorOf([
          { sourceKey: 'checkout.health', sourceRevision: 1, receiptId: r },
        ]),
      }),
    ).rejects.toThrow();
    h.validator.failWith = null;
    for (let i = 0; i < 3; i += 1) {
      const c = await claimStart(h, { taskId: child });
      await h.coordinator.failAttempt(c.context, { reason: 'provider error' });
    }
    expect((await taskRow(h, child)).status).toBe('failed');
    expect((await h.coordinator.resumeFromWaiting(parent.context)).allTerminal).toBe(true);
    await h.coordinator.publishOutput(parent.context, handoff());
    await finishAll(h, [b]);
    await h.coordinator.runMaintenance();
    expect(await openEvents(h, planned.missionId)).toEqual([]);
    await h.coordinator.outbox.drain();
    expect(await missionStatus(h, planned.missionId)).toBe('awaiting_acceptance');
  });
});

it('a closure that reaches the planner re-plans within replanCap and does not multiply root tasks', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const plannerTask = planned.plannerContext.taskId;
    let plannerAttempt = planned.plannerContext.attemptId as string;
    const task = (title: string) => ({
      title,
      question: 'q',
      role: 'investigator',
      capabilities: [],
      dependsOn: [],
    });
    const eventIds: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      const event = invalidationFor({
        missionId: planned.missionId,
        sourceKey: 'checkout.health',
        attemptIds: [plannerAttempt],
        taskIds: [plannerTask],
      });
      eventIds.push(event.id);
      await h.coordinator.onInvalidation(event);
      const planner = await taskRow(h, plannerTask);
      if (round < 3) {
        expect(planner.status).toBe('runnable');
        expect(planner.repair.kind).toBe('replan');
        const replanner = await claimStart(h, { taskId: plannerTask });
        plannerAttempt = replanner.context.attemptId;
        await h.coordinator.publishPlan(replanner.context, {
          createdByModelCallId: randomUUID() as never,
          plan: { tasks: [task(`r${round} a`), task(`r${round} b`)] },
        });
      } else {
        // replanCap (3) reached: the plan stands.
        expect(planner.status).toBe('succeeded');
      }
    }
    expect(
      await count(
        h,
        'coordinator.recovery_events',
        `mission_id = $1 AND kind = 'replan_scheduled'`,
        [planned.missionId],
      ),
    ).toBe(3);
    expect(
      await count(
        h,
        'coordinator.recovery_events',
        `mission_id = $1 AND kind = 'repair_scheduled' AND task_id = $2`,
        [planned.missionId, plannerTask],
      ),
    ).toBe(0);
    // 2 original + 3 replans x 2 (the 4th event did not re-plan).
    expect(
      await count(
        h,
        'coordinator.tasks',
        `mission_id = $1 AND parent_id IS NULL AND role = 'investigator'`,
        [planned.missionId],
      ),
    ).toBe(8);
    // The planner never holds an invalidation open.
    expect(await openEvents(h, planned.missionId)).toEqual([]);
  });
});

it('a replan supersedes the root tasks that were only waiting for a repair', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const [a, b] = planned.taskIds;
    const running = await claimStart(h, { taskId: a });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [running.context.attemptId],
        taskIds: [a],
        preserved: [b],
      }),
    );
    expect((await taskRow(h, a)).status).toBe('runnable'); // awaiting its repair
    const replanner = await claimStart(h, { taskId: planned.plannerContext.taskId });
    expect(replanner.attempt.kind).toBe('replan');
    await h.coordinator.publishPlan(replanner.context, {
      createdByModelCallId: randomUUID() as never,
      plan: {
        tasks: ['x', 'y'].map((title) => ({
          title,
          question: 'q',
          role: 'investigator',
          capabilities: [],
          dependsOn: [],
        })),
      },
    });
    expect((await taskRow(h, a)).status).toBe('cancelled');
    expect((await taskRow(h, b)).status).toBe('runnable'); // the preserved branch is untouched
  });
});

it('a repair attempt of a delegated child keeps the context it inherited from its parent', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const parent = await claimStart(h, { taskId: planned.taskIds[0] });
    const inherited = vectorOf([{ sourceKey: 'checkout.health', sourceRevision: 4 }]);
    const { taskId: child } = await h.coordinator.delegate(parent.context, {
      title: 'verify',
      role: 'verifier',
      question: 'check it',
      dependsOn: [],
      justification: 'needs a verifier',
      dependencyVector: inherited,
    });
    const c1 = await claimStart(h, { taskId: child });
    expect(c1.attempt.inheritedDependencyVector).toEqual(inherited);
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        sourceKey: 'checkout.metrics',
        attemptIds: [c1.context.attemptId],
        taskIds: [child],
      }),
    );
    const repair = await claimStart(h, { taskId: child });
    expect(repair.attempt.kind).toBe('repair');
    expect(repair.attempt.inheritedDependencyVector).toEqual(inherited);
    h.validator.calls = [];
    await h.coordinator.publishOutput(repair.context, {
      kind: 'verification',
      content: { ok: true },
      dependencyVector: [],
    });
    expect(h.validator.calls[0].ids).toEqual([inherited[0].receiptId]);
    const artifact = (await h.ledger.rows('artifact:task_output')).at(-1)!
      .body as { dependencyVector: unknown[] };
    expect(artifact.dependencyVector).toEqual(inherited);
  });
});

it('a repair drops only the inherited receipts the ledger no longer treats as current', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const parent = await claimStart(h, { taskId: planned.taskIds[0] });
    const kept = vectorOf([{ sourceKey: 'checkout.health', sourceRevision: 4 }]);
    const stale = vectorOf([{ sourceKey: 'checkout.metrics', sourceRevision: 2 }]);
    const base = probeReceipt(planned.missionId, 'pass');
    // Register both receipts in the ledger; the second is then superseded.
    const { insertLedgerReceipt } = await import('./harness.js');
    for (const [entry, status] of [
      [kept[0], 'supported'],
      [stale[0], 'supported'],
    ] as const)
      await insertLedgerReceipt(h.admin, {
        ...base,
        id: entry.receiptId,
        source: { ...base.source, key: entry.sourceKey },
        status,
      });
    await h.admin.query(
      `UPDATE ledger.observation_receipts
          SET status = 'superseded', status_version = status_version + 1 WHERE id = $1`,
      [stale[0].receiptId],
    );
    const { taskId: child } = await h.coordinator.delegate(parent.context, {
      title: 'verify',
      role: 'verifier',
      question: 'check it',
      dependsOn: [],
      justification: 'needs a verifier',
      dependencyVector: vectorOf([...kept, ...stale]),
    });
    const c1 = await claimStart(h, { taskId: child });
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        attemptIds: [c1.context.attemptId],
        taskIds: [child],
      }),
    );
    const repair = await claimStart(h, { taskId: child });
    expect(repair.attempt.inheritedDependencyVector).toEqual(kept);
  });
});

it('every state lock order used by recovery and publication completes under overlap without deadlock errors', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const claims = [];
    for (const taskId of planned.taskIds)
      claims.push(await claimStart(h, { taskId }));
    // Publications of some tasks overlap invalidations that name others.
    const work = [
      h.coordinator.publishOutput(claims[0].context, handoff()),
      h.coordinator.publishOutput(claims[1].context, handoff()),
      h.coordinator.onInvalidation(
        invalidationFor({
          missionId: planned.missionId,
          attemptIds: [claims[2].context.attemptId],
          taskIds: [planned.taskIds[2]],
          preserved: [planned.taskIds[0], planned.taskIds[1]],
        }),
      ),
      h.coordinator.onInvalidation(
        invalidationFor({
          missionId: planned.missionId,
          attemptIds: [claims[3].context.attemptId],
          taskIds: [planned.taskIds[3]],
        }),
      ),
    ];
    const results = await Promise.allSettled(work);
    expect(results.map(describeSettled)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
  });
});
