// MissionControlPort over real PostgreSQL: CAS lifecycle, provider gating,
// acceptance (succeeded needs a passing probe AND zero open invalidations).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AcceptanceRejectedError,
  CasConflictError,
  CoordinatorConfigError,
  MissionStateError,
  ModeMismatchError,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { transitionMission } from '../../../../src/server/nemodots/coordinator/missions.js';
import { EventBuffer } from '../../../../src/server/nemodots/coordinator/events.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  MissionSchema,
  MissionSnapshotSchema,
  TaskSchema,
  TaskAttemptSchema,
  TaskOutputSchema,
  FindingSchema,
  RecoveryEventSchema,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  claimStart,
  count,
  plannedMission,
  probeReceipt,
  taskRow,
  vectorOf,
  withHarness,
} from './harness.js';

const two = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

async function finishAll(
  h: Parameters<Parameters<typeof withHarness>[0]>[0],
  taskIds: string[],
) {
  for (const taskId of taskIds) {
    const claimed = await claimStart(h, { taskId: taskId as never });
    await h.coordinator.publishOutput(claimed.context, {
      kind: 'handoff',
      content: { taskId },
      dependencyVector: [],
    });
  }
  await h.coordinator.outbox.drain();
}

it('create validates the request, stamps the server mode and the admission knob', async () => {
  await withHarness(async (h) => {
    const mission = await h.coordinator.control.create({
      goal: 'checkout is returning errors',
      constraints: ['do not touch ui.banner_text'],
      admission: { minAgeMs: 3000 },
    });
    MissionSchema.parse(mission);
    expect(mission).toMatchObject({
      status: 'created',
      generation: 0,
      transitionVersion: 0,
      mode: 'fixture',
      admission: { minAgeMs: 3000 },
      cancellation: null,
      acceptanceReceiptId: null,
    });
    expect(mission.scope).toMatchObject({
      ownerId: 'owner',
      missionId: mission.id,
      environment: 'test',
    });
    await expect(
      h.coordinator.control.create({ goal: 'x', mode: 'live' }),
    ).rejects.toBeInstanceOf(ModeMismatchError);
    await expect(h.coordinator.control.create({ goal: '' })).rejects.toThrow();
    await expect(
      h.coordinator.control.create({
        goal: 'x',
        admission: { minAgeMs: 61_000 },
      }),
    ).rejects.toThrow();
    await expect(
      h.coordinator.control.create({ goal: 'x', mode: 'fixture' }),
    ).resolves.toBeDefined();
  });
});

it('start gates on the injected provider health: blocked_provider until it recovers, then running with a planner task', async () => {
  await withHarness(async (h) => {
    const mission = await h.coordinator.control.create({ goal: 'g' });
    h.health.healthy = false;
    const blocked = await h.coordinator.control.start(mission.id);
    expect(blocked.status).toBe('blocked_provider');
    expect(await count(h, 'coordinator.tasks')).toBe(0);
    // Still blocked while the provider is down.
    expect((await h.coordinator.control.start(mission.id)).status).toBe(
      'blocked_provider',
    );
    h.health.healthy = true;
    const running = await h.coordinator.control.start(mission.id);
    expect(running.status).toBe('running');
    expect(running.startedAt).not.toBeNull();
    const planner = await h.admin.query(
      `SELECT role, status, capabilities, question, depth FROM coordinator.tasks WHERE mission_id = $1`,
      [mission.id],
    );
    expect(planner.rows).toEqual([
      {
        role: 'planner',
        status: 'runnable',
        capabilities: [],
        question: 'g',
        depth: 0,
      },
    ]);
    await expect(
      h.coordinator.control.start(mission.id),
    ).rejects.toBeInstanceOf(MissionStateError);
    const history = await h.admin.query(
      `SELECT payload->>'to' AS to FROM coordinator.events
        WHERE mission_id = $1 AND kind = 'mission.status' ORDER BY id`,
      [mission.id],
    );
    expect(history.rows.map((row) => row.to)).toEqual([
      'blocked_provider',
      'created',
      'running',
    ]);
  });
});

it('every lifecycle step is a CAS on (id, status, transition_version) and illegal steps are refused', async () => {
  await withHarness(async (h) => {
    const mission = await h.coordinator.control.create({ goal: 'g' });
    await expect(
      h.coordinator.control.pause(mission.id),
    ).rejects.toBeInstanceOf(MissionStateError); // created
    await expect(
      h.coordinator.control.resume(mission.id),
    ).rejects.toBeInstanceOf(MissionStateError);
    const running = await h.coordinator.control.start(mission.id);
    expect(running.transitionVersion).toBe(1);
    const paused = await h.coordinator.control.pause(mission.id);
    expect([paused.status, paused.transitionVersion]).toEqual(['paused', 2]);
    await expect(
      h.coordinator.control.pause(mission.id),
    ).rejects.toBeInstanceOf(MissionStateError);
    const resumed = await h.coordinator.control.resume(mission.id);
    expect([resumed.status, resumed.transitionVersion]).toEqual(['running', 3]);

    // A writer holding a stale row (the version moved) loses the CAS with a typed error.
    const stale = (
      await h.admin.query(`SELECT * FROM coordinator.missions WHERE id = $1`, [
        mission.id,
      ])
    ).rows[0];
    await h.coordinator.control.pause(mission.id);
    await expect(
      withTransaction(h.pool, async (client) => {
        await transitionMission(
          { client, events: new EventBuffer(h.coordinator.deps.events) },
          stale,
          'paused',
          { reason: 'late' },
        );
      }),
    ).rejects.toBeInstanceOf(CasConflictError);
    // And an edge outside contracts/transitions.ts never reaches SQL.
    await expect(
      withTransaction(h.pool, async (client) => {
        const row = (
          await client.query(
            `SELECT * FROM coordinator.missions WHERE id = $1`,
            [mission.id],
          )
        ).rows[0];
        await transitionMission(
          { client, events: new EventBuffer(h.coordinator.deps.events) },
          row,
          'succeeded',
          { reason: 'cheat' },
        );
      }),
    ).rejects.toMatchObject({ name: 'IllegalTransitionError' });
    expect((await h.coordinator.control.get(mission.id)).status).toBe('paused');
  });
});

it('succeeded requires a supported probe receipt with verdict pass for this mission', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    // Not awaiting_acceptance yet: nothing to accept.
    await expect(
      h.coordinator.control.completeAcceptance(
        planned.missionId,
        probeReceipt(planned.missionId, 'pass'),
      ),
    ).rejects.toBeInstanceOf(MissionStateError);
    await finishAll(h, planned.taskIds);
    expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
      'awaiting_acceptance',
    );

    const bad: [string, ReturnType<typeof probeReceipt>][] = [
      [
        'wrong source key',
        probeReceipt(planned.missionId, 'pass', {
          source: {
            ...probeReceipt(planned.missionId, 'pass').source,
            key: 'checkout.health' as never,
          },
        }),
      ],
      [
        'not a probe',
        probeReceipt(planned.missionId, 'pass', { trust: 'observed_tool' }),
      ],
      [
        'superseded',
        probeReceipt(planned.missionId, 'pass', { status: 'superseded' }),
      ],
      ['other mission', probeReceipt(randomUUID() as never, 'pass')],
      [
        'no verdict',
        probeReceipt(planned.missionId, 'pass', {
          normalizedValue: { invariants: [] },
        }),
      ],
    ];
    for (const [label, receipt] of bad)
      await expect(
        h.coordinator.control.completeAcceptance(planned.missionId, receipt),
        label,
      ).rejects.toBeInstanceOf(AcceptanceRejectedError);
    expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
      'awaiting_acceptance',
    );

    const pass = probeReceipt(planned.missionId, 'pass');
    const done = await h.coordinator.control.completeAcceptance(
      planned.missionId,
      pass,
    );
    expect(done.status).toBe('succeeded');
    expect(done.acceptanceReceiptId).toBe(pass.id);
    // Terminal: nothing moves it again.
    await expect(
      h.coordinator.control.cancel(planned.missionId),
    ).rejects.toBeInstanceOf(MissionStateError);
    await expect(
      h.coordinator.control.pause(planned.missionId),
    ).rejects.toBeInstanceOf(MissionStateError);
  });
});

it('the mission.accept outbox message runs the injected probe and settles the mission end to end', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    h.probe.receipt = probeReceipt(planned.missionId, 'pass');
    await finishAll(h, planned.taskIds); // drain() also runs mission.accept
    const mission = await h.coordinator.control.get(planned.missionId);
    expect(mission.status).toBe('succeeded');
    expect(mission.acceptanceReceiptId).toBe(h.probe.receipt.id);
  });
});

it('a failing acceptance probe returns the mission to running with a replan; with no replan left it fails', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    await finishAll(h, planned.taskIds);
    const mission = await h.coordinator.control.completeAcceptance(
      planned.missionId,
      probeReceipt(planned.missionId, 'fail'),
    );
    expect(mission.status).toBe('running');
    const planner = (
      await h.admin.query(
        `SELECT status, repair FROM coordinator.tasks WHERE mission_id = $1 AND role = 'planner'`,
        [planned.missionId],
      )
    ).rows[0];
    expect(planner.status).toBe('runnable');
    expect(planner.repair.kind).toBe('replan');
  });
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, two);
      await finishAll(h, planned.taskIds);
      const mission = await h.coordinator.control.completeAcceptance(
        planned.missionId,
        probeReceipt(planned.missionId, 'fail'),
      );
      expect(mission.status).toBe('failed');
      expect(mission.failureReason).toMatch(/acceptance probe failed/);
    },
    { config: { replanCap: 0 } },
  );
});

it('accept without a probe is a configuration error, not a silent success', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    await finishAll(h, planned.taskIds);
    const bare = { ...h.coordinator.deps, probe: null };
    const { acceptMission } =
      await import('../../../../src/server/nemodots/coordinator/missions.js');
    await expect(acceptMission(bare, planned.missionId)).rejects.toBeInstanceOf(
      CoordinatorConfigError,
    );
    expect((await h.coordinator.control.get(planned.missionId)).status).toBe(
      'awaiting_acceptance',
    );
  });
});

it('a root task failure fails the mission and fences its attempts', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const running = await claimStart(h, { taskId: planned.taskIds[1] });
    const failing = await claimStart(h, { taskId: planned.taskIds[0] });
    for (let i = 0; i < 3; i += 1) {
      const outcome = await h.coordinator.failAttempt(
        i === 0
          ? failing.context
          : (await claimStart(h, { taskId: planned.taskIds[0] })).context,
        { reason: `failure ${i}` },
      );
      expect(outcome).toBe(i < 2 ? 'requeued' : 'failed');
    }
    await h.coordinator.outbox.drain();
    const mission = await h.coordinator.control.get(planned.missionId);
    expect(mission.status).toBe('failed');
    expect(mission.generation).toBe(1);
    expect((await taskRow(h, planned.taskIds[1])).status).toBe('cancelled');
    // The sibling's running attempt was aborted with the mission.
    await expect(
      h.coordinator.publishOutput(running.context, {
        kind: 'handoff',
        content: {},
        dependencyVector: [],
      }),
    ).rejects.toMatchObject({ name: 'FenceError' });
  });
});

it('the snapshot validates against the contract and carries every coordinator-owned collection', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, two);
    const claimed = await claimStart(h, { taskId: planned.taskIds[0] });
    const vector = vectorOf([
      { sourceKey: 'checkout.health', sourceRevision: 1 },
    ]);
    await h.coordinator.addReadSet(claimed.context, vector);
    await h.coordinator.publishFinding(claimed.context, {
      claim: 'health is degraded',
      supportingReceiptIds: [vector[0].receiptId],
      confidence: 'medium',
      dependencyVector: vector,
    });
    await h.coordinator.publishOutput(claimed.context, {
      kind: 'finding',
      content: { a: 1 },
      dependencyVector: vector,
    });
    const snapshot = await h.coordinator.control.snapshot(planned.missionId);
    MissionSnapshotSchema.parse(snapshot);
    for (const task of snapshot.tasks) TaskSchema.parse(task);
    for (const attempt of snapshot.attempts) TaskAttemptSchema.parse(attempt);
    for (const output of snapshot.outputs) TaskOutputSchema.parse(output);
    for (const finding of snapshot.findings) FindingSchema.parse(finding);
    for (const recovery of snapshot.recoveries)
      RecoveryEventSchema.parse(recovery);
    expect(snapshot.tasks.map((task) => task.role)).toEqual([
      'planner',
      'investigator',
      'investigator',
    ]);
    expect(snapshot.outputs.map((output) => output.kind).sort()).toEqual([
      'finding',
      'plan',
    ]);
    expect(snapshot.findings).toHaveLength(1);
    expect(snapshot.findings[0].trust).toBe('model_claim');
    expect(
      snapshot.attempts.find(
        (attempt) => attempt.id === claimed.context.attemptId,
      )?.readSetReceiptIds,
    ).toEqual([vector[0].receiptId]);
    const latest = await h.admin.query(
      `SELECT max(id) AS id FROM coordinator.events WHERE mission_id = $1`,
      [planned.missionId],
    );
    expect(snapshot.lastEventId).toBe(Number(latest.rows[0].id));
  });
});

it('an invalidation is only ever visible in the snapshot of the mission it affects, filtered to that mission (I10)', async () => {
  await withHarness(async (h) => {
    const one = await plannedMission(h, two);
    const other = await plannedMission(h, two);
    const claimed = await claimStart(h, {
      taskId: one.taskIds[0],
      missionId: one.missionId,
    });
    const otherClaimed = await claimStart(h, {
      taskId: other.taskIds[0],
      missionId: other.missionId,
    });
    const { invalidationFor } = await import('./harness.js');
    const base = invalidationFor({
      missionId: one.missionId,
      taskIds: [one.taskIds[0]],
      attemptIds: [claimed.context.attemptId],
      preserved: [one.taskIds[1]],
    });
    // A global event touching both missions, with a different subset each.
    const event = {
      ...base,
      missionIds: [one.missionId, other.missionId],
      affected: {
        ...base.affected,
        attemptIds: [claimed.context.attemptId, otherClaimed.context.attemptId],
        taskIds: [one.taskIds[0], other.taskIds[0]],
      },
      perMission: [
        base.perMission[0],
        {
          missionId: other.missionId,
          affected: {
            modelCallIds: [],
            attemptIds: [otherClaimed.context.attemptId],
            outputIds: [],
            actionIds: [],
            taskIds: [other.taskIds[0]],
          },
          preserved: { taskIds: [other.taskIds[1]] },
        },
      ],
    };
    await h.coordinator.onInvalidation(event);
    const a = await h.coordinator.control.snapshot(one.missionId);
    const b = await h.coordinator.control.snapshot(other.missionId);
    expect(a.invalidations).toHaveLength(1);
    expect(a.invalidations[0].affected.taskIds).toEqual([one.taskIds[0]]);
    expect(a.invalidations[0].affected.attemptIds).toEqual([
      claimed.context.attemptId,
    ]);
    expect(a.invalidations[0].missionIds).toEqual([one.missionId]);
    expect(JSON.stringify(a.invalidations)).not.toContain(other.taskIds[0]);
    expect(b.invalidations[0].affected.taskIds).toEqual([other.taskIds[0]]);
    expect(JSON.stringify(b.invalidations)).not.toContain(one.taskIds[0]);
  });
});
