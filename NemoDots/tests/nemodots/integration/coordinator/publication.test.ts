// Publication guard: fence, SupportValidator, rejection paths (G2, C12, C13).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CapabilityDeniedError,
  CitationOutOfScopeError,
  DelegationRejectedError,
  FenceError,
  PlanRejectedError,
  SupportError,
} from '../../../../src/server/nemodots/coordinator/index.js';
import {
  EventPayloadSchema,
  type ModelCallRecord,
  type TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';
import { latch } from '../../helpers/barrier.js';
import {
  attemptRow,
  claimStart,
  count,
  eventKinds,
  plannedMission,
  receipt,
  recoveryKinds,
  sleep,
  staleVersion,
  taskRow,
  vectorOf,
  withHarness,
} from './harness.js';

const TWO_INVESTIGATORS = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

it('publishOutput is one transaction: output, edges, attempt published, task succeeded, dependents promoted, events in order', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    const [first, second] = planned.taskIds;
    // D1: the plan is a scheduling artifact. No artifact edge and an empty vector.
    expect(await h.ledger.rows('artifact:task')).toHaveLength(0);
    const plan = await h.admin.query(
      `SELECT kind, dependency_vector FROM coordinator.task_outputs WHERE kind = 'plan'`,
    );
    expect(plan.rows).toEqual([{ kind: 'plan', dependency_vector: [] }]);
    const created = await h.admin.query(
      `SELECT created_by_model_call_id FROM coordinator.tasks WHERE id = ANY($1::uuid[])`,
      [planned.taskIds],
    );
    expect(
      created.rows.every((row) => row.created_by_model_call_id !== null),
    ).toBe(true);

    const claimed = await claimStart(h, { taskId: first });
    const vector = vectorOf([
      { sourceKey: 'checkout.config/cache.namespace', sourceRevision: 3 },
      { sourceKey: 'checkout.health', sourceRevision: 9 },
    ]);
    const { outputId, digest } = await h.coordinator.publishOutput(
      claimed.context,
      {
        kind: 'finding',
        content: { claim: 'namespace is stale' },
        dependencyVector: vector,
      },
    );
    // Validator saw the exact ids under a share lock.
    expect(h.validator.calls.at(-1)).toEqual({
      ids: vector.map((entry) => entry.receiptId),
      lockMode: 'share',
    });
    expect((await taskRow(h, first)).status).toBe('succeeded');
    expect((await taskRow(h, first)).output_id).toBe(outputId);
    expect((await attemptRow(h, claimed.context.attemptId)).status).toBe(
      'published',
    );
    expect((await taskRow(h, second)).status).toBe('runnable');
    const artifact = (await h.ledger.rows('artifact:task_output'))[0];
    expect(artifact.id).toBe(outputId);
    const stored = await h.admin.query(
      `SELECT digest, dependency_vector FROM coordinator.task_outputs WHERE id = $1`,
      [outputId],
    );
    expect(stored.rows[0].digest).toBe(digest);
    expect(stored.rows[0].dependency_vector).toEqual(vector);

    // Every emitted event satisfies the shared payload schema, in a sensible order.
    const events = await h.admin.query(
      `SELECT payload FROM coordinator.events WHERE mission_id = $1 ORDER BY id`,
      [planned.missionId],
    );
    for (const row of events.rows) EventPayloadSchema.parse(row.payload);
    const kinds = events.rows.map((row) => row.payload.kind);
    const tail = kinds.slice(kinds.lastIndexOf('attempt.started'));
    expect(tail.indexOf('output.published')).toBeLessThan(
      tail.indexOf('attempt.finished'),
    );
    expect(tail).toContain('task.status');
  });
});

it('publishPlan rejects cycles, capability escalation, role misuse and the task cap, writing nothing and leaving the attempt running', async () => {
  await withHarness(
    async (h) => {
      const mission = await h.coordinator.control.create({ goal: 'g' });
      await h.coordinator.control.start(mission.id);
      const planner = (await h.coordinator.claimAttempt({
        workerId: 'p',
        missionId: mission.id,
      }))!;
      await h.coordinator.startAttempt(planner.context);
      const base = { createdByModelCallId: null };
      const task = (over: Record<string, unknown>) => ({
        title: 't',
        question: 'q',
        role: 'investigator',
        capabilities: [],
        dependsOn: [],
        ...over,
      });
      const cases: [string, unknown, RegExp][] = [
        [
          'cycle',
          { tasks: [task({ dependsOn: [1] }), task({ dependsOn: [0] })] },
          /cycle/,
        ],
        [
          'investigator asking for propose_config_change (D5)',
          {
            tasks: [
              task({ capabilities: ['propose_config_change'] }),
              task({}),
            ],
          },
          /ROLE_CAPABILITIES.investigator/,
        ],
        [
          'planner role in a plan',
          { tasks: [task({ role: 'planner' }), task({})] },
          /not a plan role/,
        ],
        ['only one task', { tasks: [task({})] }, /tasks/],
        [
          'over the mission task cap',
          { tasks: [task({}), task({}), task({}), task({})] },
          /room for/,
        ],
      ];
      for (const [label, plan, pattern] of cases) {
        await expect(
          h.coordinator.publishPlan(planner.context, { ...base, plan }),
          label,
        ).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof PlanRejectedError && pattern.test(error.message),
        );
      }
      expect(await count(h, 'coordinator.tasks')).toBe(1); // only the planner seed
      expect((await attemptRow(h, planner.context.attemptId)).status).toBe(
        'running',
      );
      // The attempt can still publish a valid plan afterwards.
      await h.coordinator.publishPlan(planner.context, {
        ...base,
        plan: { tasks: [task({}), task({})] },
      });
      expect(await count(h, 'coordinator.tasks')).toBe(3);
    },
    {
      config: {
        budgets: {
          maxTasks: 4,
          maxDepth: 3,
          maxBreadth: 4,
          maxTokens: 1000,
          maxInferenceCalls: 10,
          maxWallClockMs: 60_000,
        },
      },
    },
  );
});

it('only the planner task may publish a plan', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, TWO_INVESTIGATORS);
    const worker = await claimStart(h, { taskId: planned.taskIds[0] });
    await expect(
      h.coordinator.publishPlan(worker.context, {
        createdByModelCallId: null,
        plan: {
          tasks: [
            {
              title: 't',
              question: 'q',
              role: 'investigator',
              capabilities: [],
              dependsOn: [],
            },
            {
              title: 't',
              question: 'q',
              role: 'investigator',
              capabilities: [],
              dependsOn: [],
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(PlanRejectedError);
  });
});

it('delegate enforces role, capability intersection, justification, depth, breadth, total and deadlock rules, and is idempotent per tool call', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, [
        { role: 'cache_specialist' },
        { role: 'investigator' },
        { role: 'verifier' },
      ]);
      const specialist = await claimStart(h, { taskId: planned.taskIds[0] });
      const vector = vectorOf([
        { sourceKey: 'redis.stats', sourceRevision: 2 },
      ]);
      const ask = (over: Record<string, unknown>) => ({
        title: 'verify the flush',
        role: 'verifier' as const,
        question: 'did the namespace change?',
        dependsOn: [] as TaskId[],
        justification: 'an independent check of the change',
        dependencyVector: vector,
        ...over,
      });

      // Specialists delegate only 'verifier' (D5).
      await expect(
        h.coordinator.delegate(
          specialist.context,
          ask({ role: 'investigator' }),
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DelegationRejectedError &&
          /may not delegate to role/.test(error.message),
      );
      // Justification is required for delegated tasks.
      await expect(
        h.coordinator.delegate(specialist.context, ask({ justification: '' })),
      ).rejects.toBeInstanceOf(DelegationRejectedError);
      // dependsOn must name tasks of this mission.
      await expect(
        h.coordinator.delegate(
          specialist.context,
          ask({ dependsOn: [randomUUID()] }),
        ),
      ).rejects.toBeInstanceOf(DelegationRejectedError);

      const created = await h.coordinator.delegate(
        specialist.context,
        ask({ toolCallId: 'call-1' }),
      );
      expect(created.created).toBe(true);
      // A replayed tool call returns the same task instead of a second child.
      const replay = await h.coordinator.delegate(
        specialist.context,
        ask({ toolCallId: 'call-1' }),
      );
      expect(replay).toEqual({ taskId: created.taskId, created: false });

      const child = await taskRow(h, created.taskId);
      expect(child.parent_id).toBe(planned.taskIds[0]);
      expect(child.depth).toBe(1);
      expect(child.role).toBe('verifier');
      // ROLE_CAPABILITIES.verifier ∩ parent.capabilities
      expect([...child.capabilities].sort()).toEqual([
        'observe',
        'publish_finding',
      ]);
      expect(child.status).toBe('runnable');
      expect(child.inherited_dependency_vector).toEqual(vector);
      const edges = await h.ledger.rows('artifact:task');
      expect(edges).toHaveLength(1);

      // Breadth: maxBreadth is 2 in this harness.
      await h.coordinator.delegate(
        specialist.context,
        ask({ title: 'second' }),
      );
      await expect(
        h.coordinator.delegate(specialist.context, ask({ title: 'third' })),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DelegationRejectedError &&
          /breadth/.test(error.message),
      );

      // Depth: a verifier at depth 1 cannot delegate at all (no capability).
      const verifier = await claimStart(h, { taskId: created.taskId });
      await expect(
        h.coordinator.delegate(verifier.context, ask({})),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
    },
    {
      config: {
        budgets: {
          maxTasks: 24,
          maxDepth: 3,
          maxBreadth: 2,
          maxTokens: 100_000,
          maxInferenceCalls: 100,
          maxWallClockMs: 600_000,
        },
      },
    },
  );
});

it('delegate refuses a dependsOn that would deadlock the parent and honours maxDepth and maxTasks', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'investigator' },
      ]);
      const parent = await claimStart(h, { taskId: planned.taskIds[0] });
      const v = vectorOf([]);
      const ask = (over: Record<string, unknown>) => ({
        title: 'x',
        role: 'investigator' as const,
        question: 'q',
        dependsOn: [] as TaskId[],
        justification: 'because',
        dependencyVector: v,
        ...over,
      });
      // A child that requires its own parent can never start: the parent waits for it.
      await expect(
        h.coordinator.delegate(
          parent.context,
          ask({ dependsOn: [planned.taskIds[0]] }),
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DelegationRejectedError &&
          /cycle/.test(error.message),
      );
      const a = await h.coordinator.delegate(parent.context, ask({}));
      // depth 2 child (allowed, maxDepth 2) ...
      const childClaim = await claimStart(h, { taskId: a.taskId });
      const b = await h.coordinator.delegate(childClaim.context, ask({}));
      // ... and depth 3 is over maxDepth.
      const grandClaim = await claimStart(h, { taskId: b.taskId });
      await expect(
        h.coordinator.delegate(grandClaim.context, ask({})),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DelegationRejectedError &&
          /maxDepth/.test(error.message),
      );
    },
    {
      config: {
        budgets: {
          maxTasks: 24,
          maxDepth: 2,
          maxBreadth: 4,
          maxTokens: 100_000,
          maxInferenceCalls: 100,
          maxWallClockMs: 600_000,
        },
      },
    },
  );
});

it('publishFinding scope-checks citations against the snapshot vector, readset and inherited vector', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, TWO_INVESTIGATORS);
    const claimed = await claimStart(h, { taskId: planned.taskIds[0] });
    const seen = vectorOf([
      { sourceKey: 'checkout.health', sourceRevision: 5 },
    ]);
    const unseen = receipt();
    await expect(
      h.coordinator.publishFinding(claimed.context, {
        claim: 'cites something it never read',
        supportingReceiptIds: [seen[0].receiptId, unseen],
        confidence: 'high',
        dependencyVector: seen,
      }),
    ).rejects.toBeInstanceOf(CitationOutOfScopeError);
    expect(await count(h, 'coordinator.findings')).toBe(0);

    // A receipt added to the readset (observe_source) is in scope.
    const observed = vectorOf([
      { sourceKey: 'redis.stats', sourceRevision: 1 },
    ]);
    await h.coordinator.addReadSet(claimed.context, observed);
    expect(
      (await attemptRow(h, claimed.context.attemptId)).read_set_receipt_ids,
    ).toEqual([observed[0].receiptId]);
    const { findingId } = await h.coordinator.publishFinding(claimed.context, {
      claim: 'stats disagree with health',
      supportingReceiptIds: [seen[0].receiptId, observed[0].receiptId],
      confidence: 'medium',
      dependencyVector: seen,
    });
    const stored = await h.admin.query(
      `SELECT claim, usable, dependency_vector FROM coordinator.findings WHERE id = $1`,
      [findingId],
    );
    expect(stored.rows[0].usable).toBe(true);
    // The finding rests on the snapshot vector plus the cited readset entry.
    expect(stored.rows[0].dependency_vector).toHaveLength(2);
    const last = h.validator.calls.at(-1)!;
    expect(last.lockMode).toBe('share');
    expect(new Set(last.ids)).toEqual(
      new Set([seen[0].receiptId, observed[0].receiptId]),
    );
  });
});

function recordFor(context: {
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
    model: { requested: 'm', returned: 'm' },
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
          promptTokens: 4,
          completionTokens: 2,
          cachedTokens: 0,
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
    outputDigest: null,
    outputDependencyVector: [],
    toolCalls: [],
    createdAt: now,
  } as unknown as ModelCallRecord;
}

function snapshot(vector: ReturnType<typeof vectorOf>) {
  return {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: '1'.repeat(64),
    prefixLength: 1,
    contextDigest: '2'.repeat(64),
    contextLength: 2,
    toolSchemaHash: '3'.repeat(64),
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

it('recordModelCall stores through the ledger port in the publication transaction and appends the model_call id to the attempt', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, TWO_INVESTIGATORS);
    const claimed = await claimStart(h, { taskId: planned.taskIds[0] });
    const record = recordFor(claimed.context);
    await h.coordinator.recordModelCall(claimed.context, {
      record,
      snapshot: snapshot(
        vectorOf([{ sourceKey: 'checkout.health', sourceRevision: 1 }]),
      ),
    });
    expect((await h.ledger.rows('model_call')).map((row) => row.id)).toEqual([
      record.id,
    ]);
    expect(
      (await attemptRow(h, claimed.context.attemptId)).model_call_ids,
    ).toEqual([record.id]);
    expect(await eventKinds(h, planned.missionId)).toContain(
      'model_call.recorded',
    );
    // A record that names another attempt is a programming error, not a fence failure.
    const foreign = recordFor({ ...claimed.context, attemptId: randomUUID() });
    await expect(
      h.coordinator.recordModelCall(claimed.context, {
        record: foreign,
        snapshot: snapshot([]),
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

it('a SupportError at publication invalidates the attempt, writes a synthetic invalidation and schedules a repair, with no partial rows (C13)', async () => {
  const publishers: [
    string,
    (
      h: Parameters<Parameters<typeof withHarness>[0]>[0],
      ctx: any,
      v: any,
    ) => Promise<unknown>,
  ][] = [
    // eslint-disable-line @typescript-eslint/no-explicit-any
    [
      'publishOutput',
      (h, ctx, v) =>
        h.coordinator.publishOutput(ctx, {
          kind: 'finding',
          content: { a: 1 },
          dependencyVector: v,
        }),
    ],
    [
      'delegate',
      (h, ctx, v) =>
        h.coordinator.delegate(ctx, {
          title: 't',
          role: 'verifier',
          question: 'q',
          dependsOn: [],
          justification: 'j',
          dependencyVector: v,
        }),
    ],
    [
      'publishFinding',
      (h, ctx, v) =>
        h.coordinator.publishFinding(ctx, {
          claim: 'c',
          supportingReceiptIds: [v[0].receiptId],
          confidence: 'low',
          dependencyVector: v,
        }),
    ],
    [
      'recordModelCall',
      (h, ctx, v) =>
        h.coordinator.recordModelCall(ctx, {
          record: recordFor(ctx),
          snapshot: snapshot(v),
        }),
    ],
    ['addReadSet', (h, ctx, v) => h.coordinator.addReadSet(ctx, v)],
  ];
  for (const [name, publish] of publishers) {
    await withHarness(async (h) => {
      const planned = await plannedMission(h, [
        { role: 'cache_specialist' },
        { role: 'investigator' },
      ]);
      const taskId = planned.taskIds[0];
      const claimed = await claimStart(h, { taskId });
      const vector = vectorOf([
        { sourceKey: 'checkout.config/cache.namespace', sourceRevision: 3 },
        { sourceKey: 'checkout.health', sourceRevision: 2 },
      ]);
      const stale = vector[0];
      h.validator.failWith = staleVersion(stale.receiptId);
      const outputsBefore = await count(h, 'coordinator.task_outputs');
      const tasksBefore = await count(h, 'coordinator.tasks');
      const ledgerBefore = (await h.ledger.rows()).length;

      await expect(
        publish(h, claimed.context, vector),
        name,
      ).rejects.toBeInstanceOf(SupportError);

      // No partial rows from the rolled-back publication.
      expect(await count(h, 'coordinator.task_outputs')).toBe(outputsBefore);
      expect(await count(h, 'coordinator.findings')).toBe(0);
      expect(await count(h, 'coordinator.tasks')).toBe(tasksBefore);
      expect((await h.ledger.rows()).length).toBe(ledgerBefore);

      // The attempt is invalidated (not failed) with abortReason publication_rejected.
      const attempt = await attemptRow(h, claimed.context.attemptId);
      expect(attempt.status).toBe('invalidated');
      expect(attempt.abort_reason).toBe('publication_rejected');

      // Synthetic invalidation event, mission-scoped, naming the rejected receipt.
      const inv = await h.admin.query(
        `SELECT event, reason, processed_at FROM coordinator.invalidations WHERE mission_id = $1`,
        [planned.missionId],
      );
      expect(inv.rows).toHaveLength(1);
      expect(inv.rows[0].reason).toBe('publication_rejected');
      expect(inv.rows[0].processed_at).not.toBeNull();
      expect(inv.rows[0].event.oldReceiptId).toBe(stale.receiptId);
      expect(inv.rows[0].event.sourceKey).toBe(stale.sourceKey);
      expect(inv.rows[0].event.affected.attemptIds).toEqual([
        claimed.context.attemptId,
      ]);
      expect(inv.rows[0].event.missionIds).toEqual([planned.missionId]);

      // repair_scheduled, and the task is back in the pool with a repair spec.
      const recoveries = await recoveryKinds(h, planned.missionId);
      expect(recoveries.map((r) => r.kind)).toContain('repair_scheduled');
      const task = await taskRow(h, taskId);
      expect(task.status).toBe('runnable');
      expect(task.repair).toMatchObject({
        kind: 'repair',
        repairOf: { attemptId: claimed.context.attemptId },
      });
      const kinds = await eventKinds(h, planned.missionId);
      expect(kinds).toContain('invalidation.recorded');

      // The next attempt is a repair of the invalidated one, not a blind retry.
      h.validator.failWith = null;
      const repair = await claimStart(h, { taskId, workerId: 'worker-b' });
      expect(repair.attempt.kind).toBe('repair');
      expect(repair.attempt.repairOf?.attemptId).toBe(
        claimed.context.attemptId,
      );
      expect(repair.attempt.inheritedDependencyVector).toEqual([]);
      // The rejected attempt is not charged against maxAttempts.
      expect(
        await count(
          h,
          'coordinator.task_attempts',
          "task_id = $1 AND status IN ('failed','expired')",
          [taskId],
        ),
      ).toBe(0);
    });
  }
});

it('cancel waits for an in-flight publication holding FOR SHARE, then rejects the next publication and lists committedEffects (C12)', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, TWO_INVESTIGATORS);
    const claimed = await claimStart(h, { taskId: planned.taskIds[0] });
    const effect = randomUUID();
    h.intents.committed.set(planned.missionId, [effect as never]);
    h.cancelQueued.ids = [randomUUID() as never];

    // Park the publication inside its transaction, after the mission FOR SHARE.
    const parked = latch();
    const release = latch();
    h.validator.hold = async () => {
      parked.open();
      await release.promise;
    };
    const inFlight = h.coordinator.publishOutput(claimed.context, {
      kind: 'handoff',
      content: { done: true },
      dependencyVector: vectorOf([
        { sourceKey: 'checkout.health', sourceRevision: 1 },
      ]),
    });
    await parked.promise;

    let cancelled = false;
    const cancel = h.coordinator.control
      .cancel(planned.missionId)
      .then((mission) => {
        cancelled = true;
        return mission;
      });
    await sleep(400);
    expect(
      cancelled,
      'cancel must wait for the publication holding FOR SHARE',
    ).toBe(false);

    release.open();
    await inFlight; // the in-flight publication finishes first ...
    const mission = await cancel;
    expect(mission.status).toBe('cancelled');
    expect(mission.generation).toBe(1);
    // ... and it is a committed publication, which the cancel does not undo.
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('succeeded');
    expect(mission.cancellation).toMatchObject({
      committedEffects: [effect],
      cancelledIntentIds: h.cancelQueued.ids,
      abortedAttemptIds: [],
    });
    expect(h.cancelQueued.calls).toEqual([
      { missionId: planned.missionId, generation: 1 },
    ]);

    // The next publication of any attempt of this mission is rejected.
    h.validator.hold = null;
    const second = await h.admin.query(
      `SELECT id FROM coordinator.tasks WHERE id = $1`,
      [planned.taskIds[1]],
    );
    expect(second.rows).toHaveLength(1);
    await expect(
      h.coordinator.publishOutput(claimed.context, {
        kind: 'handoff',
        content: {},
        dependencyVector: [],
      }),
    ).rejects.toBeInstanceOf(FenceError);
    expect((await taskRow(h, planned.taskIds[1])).status).toBe('cancelled');
  });
});

it('cancel aborts running attempts first (status before signal) and records them', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, TWO_INVESTIGATORS);
    const running = await claimStart(h, { taskId: planned.taskIds[0] });
    const mission = await h.coordinator.control.cancel(planned.missionId);
    expect(mission.cancellation?.abortedAttemptIds).toEqual([
      running.context.attemptId,
    ]);
    const attempt = await attemptRow(h, running.context.attemptId);
    expect(attempt.status).toBe('aborted');
    expect(attempt.abort_reason).toBe('mission_cancelled');
    await expect(
      h.coordinator.publishOutput(running.context, {
        kind: 'handoff',
        content: {},
        dependencyVector: [],
      }),
    ).rejects.toMatchObject({
      name: 'FenceError',
      reason: 'generation_mismatch',
    });
    // Cancelled twice is an illegal transition.
    await expect(
      h.coordinator.control.cancel(planned.missionId),
    ).rejects.toMatchObject({
      name: 'MissionStateError',
    });
  });
});
