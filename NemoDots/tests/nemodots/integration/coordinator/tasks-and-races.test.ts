// Waiting/children, request_replan, and concurrent publication races.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CapabilityDeniedError,
  FenceError,
} from '../../../../src/server/nemodots/coordinator/index.js';
import type { TaskId } from '../../../../src/server/nemodots/contracts/index.js';
import {
  attemptRow,
  claimStart,
  count,
  plannedMission,
  sleep,
  taskRow,
  vectorOf,
  withHarness,
} from './harness.js';

it('wait_for_children: the parent is parked in waiting and resumes only when every child is terminal', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const parent = await claimStart(h, { taskId: planned.taskIds[0] });
    const vector = vectorOf([]);
    const child = await h.coordinator.delegate(parent.context, {
      title: 'check redis',
      role: 'verifier',
      question: 'what is in redis?',
      dependsOn: [],
      justification: 'needs an independent read',
      dependencyVector: vector,
    });
    await h.coordinator.markWaiting(parent.context);
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('waiting');

    let state = await h.coordinator.resumeFromWaiting(parent.context);
    expect(state.allTerminal).toBe(false);
    expect(state.children.map((c) => c.id)).toEqual([child.taskId]);
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('waiting');

    const childClaim = await claimStart(h, { taskId: child.taskId });
    await h.coordinator.publishOutput(childClaim.context, {
      kind: 'verification',
      content: { seen: true },
      dependencyVector: [],
    });
    state = await h.coordinator.resumeFromWaiting(parent.context);
    expect(state.allTerminal).toBe(true);
    expect(state.children[0]).toMatchObject({ status: 'succeeded' });
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('running');

    // get_task_status is scoped to the mission.
    const status = await h.coordinator.getTaskStatus(
      planned.missionId,
      child.taskId,
    );
    expect(status.task.status).toBe('succeeded');
    expect(status.outputUsable).toBe(true);
    const other = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    await expect(
      h.coordinator.getTaskStatus(other.missionId, child.taskId),
    ).rejects.toMatchObject({ name: 'TaskNotFoundError' });

    await h.coordinator.publishOutput(parent.context, {
      kind: 'handoff',
      content: { rolledUp: true },
      dependencyVector: [],
    });
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('succeeded');
  });
});

it('a parent can still publish straight from waiting (children finished while it slept)', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const parent = await claimStart(h, { taskId: planned.taskIds[0] });
    await h.coordinator.markWaiting(parent.context);
    await h.coordinator.publishOutput(parent.context, {
      kind: 'handoff',
      content: {},
      dependencyVector: [],
    });
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('succeeded');
  });
});

it('request_replan needs the capability, is bounded per mission and only fires when the planner is idle', async () => {
  await withHarness(
    async (h) => {
      const planned = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'verifier' },
      ]);
      const verifier = await claimStart(h, { taskId: planned.taskIds[1] });
      await expect(
        h.coordinator.requestReplan(verifier.context, 'no capability'),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);

      const investigator = await claimStart(h, { taskId: planned.taskIds[0] });
      expect(
        await h.coordinator.requestReplan(
          investigator.context,
          'the plan misses the db',
        ),
      ).toEqual({ scheduled: true });
      const plannerRow = (
        await h.admin.query(
          `SELECT id, status, repair FROM coordinator.tasks WHERE mission_id = $1 AND role = 'planner'`,
          [planned.missionId],
        )
      ).rows[0];
      expect(plannerRow.status).toBe('runnable');
      expect(plannerRow.repair.kind).toBe('replan');
      // The planner is not idle any more: a second request does nothing.
      expect(
        await h.coordinator.requestReplan(investigator.context, 'again'),
      ).toEqual({ scheduled: false });
      expect(
        await count(
          h,
          'coordinator.recovery_events',
          "kind = 'replan_scheduled'",
        ),
      ).toBe(1);
    },
    { config: { replanCap: 1 } },
  );
});

it('concurrent publications by many attempts (plan, delegate, finding, model-call-free output) neither deadlock nor lose rows', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(
      h,
      Array.from({ length: 6 }, () => ({ role: 'investigator' as const })),
    );
    const claims = [];
    for (const taskId of planned.taskIds)
      claims.push(await claimStart(h, { taskId }));
    const vector = vectorOf([
      { sourceKey: 'checkout.health', sourceRevision: 3 },
    ]);
    const results = await Promise.all(
      claims.map(async (claimed, i) => {
        await h.coordinator.addReadSet(claimed.context, vector);
        const child = await h.coordinator.delegate(claimed.context, {
          title: `child ${i}`,
          role: 'verifier',
          question: 'q',
          dependsOn: [],
          justification: 'parallel check',
          dependencyVector: vector,
          toolCallId: `tool-${i}`,
        });
        await h.coordinator.publishFinding(claimed.context, {
          claim: `claim ${i}`,
          supportingReceiptIds: [vector[0].receiptId],
          confidence: 'low',
          dependencyVector: vector,
        });
        await h.coordinator.publishOutput(claimed.context, {
          kind: 'finding',
          content: { i },
          dependencyVector: vector,
        });
        return child;
      }),
    );
    expect(new Set(results.map((r) => r.taskId)).size).toBe(6);
    expect(await count(h, 'coordinator.findings')).toBe(6);
    expect(await count(h, 'coordinator.tasks', "role = 'verifier'")).toBe(6);
    expect(
      await count(
        h,
        'coordinator.tasks',
        "status = 'succeeded' AND role = 'investigator'",
      ),
    ).toBe(6);
    // Ordinals stayed unique and dense under concurrent enqueues.
    const ordinals = (
      await h.admin.query(
        `SELECT ordinal FROM coordinator.tasks WHERE mission_id = $1 ORDER BY ordinal`,
        [planned.missionId],
      )
    ).rows.map((row) => row.ordinal);
    expect(ordinals).toEqual(
      Array.from({ length: ordinals.length }, (_, i) => i),
    );
  });
});

it('cancel racing many publications: every publication either committed before the cancel or is fenced; nothing commits after', async () => {
  await withHarness(async (h) => {
    // Stagger the cancel so it lands before, between and after the publications.
    for (const delayMs of [0, 3, 8, 15, 30]) {
      const planned = await plannedMission(
        h,
        Array.from({ length: 6 }, () => ({ role: 'investigator' as const })),
      );
      const claims: Awaited<ReturnType<typeof claimStart>>[] = [];
      for (const taskId of planned.taskIds)
        claims.push(
          await claimStart(h, { taskId, missionId: planned.missionId }),
        );
      const publish = (claimed: (typeof claims)[number]) =>
        h.coordinator
          .publishOutput(claimed.context, {
            kind: 'handoff',
            content: { id: randomUUID() },
            dependencyVector: [],
          })
          .then(
            () => 'committed' as const,
            (error: unknown) => {
              expect(error).toBeInstanceOf(FenceError);
              return 'fenced' as const;
            },
          );
      const [outcomes, mission] = await Promise.all([
        Promise.all(claims.map(publish)),
        sleep(delayMs).then(() =>
          h.coordinator.control.cancel(planned.missionId),
        ),
      ]);
      expect(mission.status).toBe('cancelled');
      const committed = outcomes.filter(
        (outcome) => outcome === 'committed',
      ).length;
      const stored = await count(
        h,
        'coordinator.task_outputs',
        "mission_id = $1 AND kind = 'handoff'",
        [planned.missionId],
      );
      expect(stored, `delay ${delayMs}`).toBe(committed);
      // The cancel's exclusive lock waited for in-flight publications: those are
      // committed, everything else was fenced and its task cancelled.
      const tasks = (
        await h.admin.query(
          `SELECT status, count(*) AS n FROM coordinator.tasks
            WHERE mission_id = $1 AND role = 'investigator' GROUP BY status`,
          [planned.missionId],
        )
      ).rows;
      const byStatus = Object.fromEntries(
        tasks.map((row) => [row.status, Number(row.n)]),
      );
      expect(byStatus.succeeded ?? 0, `delay ${delayMs}`).toBe(committed);
      expect(byStatus.cancelled ?? 0, `delay ${delayMs}`).toBe(6 - committed);
      expect(mission.cancellation?.abortedAttemptIds.length).toBe(
        6 - committed,
      );
      expect(
        await count(
          h,
          'coordinator.tasks',
          "mission_id = $1 AND status NOT IN ('succeeded','failed','cancelled')",
          [planned.missionId],
        ),
      ).toBe(0);
    }
  });
});

it('the reaper leaves live leases alone, skips attempts of finished missions and is safe to run concurrently', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const live = await claimStart(h, {
      taskId: planned.taskIds[0],
      leaseMs: 60_000,
    });
    const dead = await claimStart(h, {
      taskId: planned.taskIds[1],
      leaseMs: 60_000,
    });
    expect(await h.coordinator.reapExpired()).toEqual([]);
    await h.admin.query(
      `UPDATE coordinator.task_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [dead.context.attemptId],
    );
    const reapers = await Promise.all([
      h.coordinator.reapExpired(),
      h.coordinator.reapExpired(),
      h.coordinator.reapExpired(),
    ]);
    expect(reapers.flat()).toHaveLength(1); // exactly one reaper took it over
    expect((await taskRow(h, planned.taskIds[1])).fence_seq).toBeGreaterThan(
      dead.context.fencingToken,
    );
    await expect(h.coordinator.heartbeat(live.context)).resolves.toBeDefined();
    const later = await h.coordinator.getTaskStatus(
      planned.missionId,
      planned.taskIds[1] as TaskId,
    );
    expect(later.task.status).toBe('runnable');
  });
});

it('claims racing a cancel never leave a running attempt behind: the claim is swept or never happens', async () => {
  await withHarness(async (h) => {
    for (const delayMs of [0, 2, 5, 10, 20]) {
      const planned = await plannedMission(h, [
        { role: 'investigator' },
        { role: 'investigator' },
      ]);
      const [claims, mission] = await Promise.all([
        Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            h.coordinator.claimAttempt({
              workerId: `racer-${i}`,
              missionId: planned.missionId,
            }),
          ),
        ),
        sleep(delayMs).then(() =>
          h.coordinator.control.cancel(planned.missionId),
        ),
      ]);
      expect(mission.status).toBe('cancelled');
      expect(
        await count(
          h,
          'coordinator.task_attempts',
          "mission_id = $1 AND status = 'running'",
          [planned.missionId],
        ),
        `delay ${delayMs}`,
      ).toBe(0);
      const claimed = claims.filter((claim) => claim !== null);
      // every attempt that was handed out was aborted by the cancel (status first) ...
      for (const claim of claimed) {
        const row = await attemptRow(h, claim!.context.attemptId);
        expect(row.status).toBe('aborted');
        expect(row.abort_reason).toBe('mission_cancelled');
        await expect(
          h.coordinator.startAttempt(claim!.context),
        ).rejects.toBeInstanceOf(FenceError);
      }
      // ... and nothing can be claimed afterwards.
      expect(
        await h.coordinator.claimAttempt({
          workerId: 'late',
          missionId: planned.missionId,
        }),
      ).toBeNull();
    }
  });
});
