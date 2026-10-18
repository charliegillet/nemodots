// The generic worker host against the real coordinator: heartbeat, the 250 ms
// abort-on-drift check, status-first aborts and the publish step.
import { expect, it } from 'vitest';
import {
  AttemptAbortedError,
  type AttemptHandler,
  type HostRun,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  attemptRow,
  expireLease,
  invalidationFor,
  plannedMission,
  probeReceipt,
  receipt,
  sleep,
  staleVersion,
  taskRow,
  vectorOf,
  withHarness,
  type Harness,
} from './harness.js';

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

function hostFor(
  h: Harness,
  handler: AttemptHandler,
  extra: Record<string, unknown> = {},
) {
  const runs: HostRun[] = [];
  const host = h.coordinator.createWorkerHost({
    workerId: 'host-1',
    handler,
    pollMs: 20,
    abortCheckMs: 50,
    onRun: (run) => runs.push(run),
    ...extra,
  });
  return { host, runs };
}

it('runs a whole mission: planner plan, worker outputs, acceptance probe, succeeded', async () => {
  await withHarness(async (h) => {
    const mission = await h.coordinator.control.create({
      goal: 'restore checkout',
    });
    await h.coordinator.control.start(mission.id);
    h.probe.receipt = probeReceipt(mission.id, 'pass');
    const seen: string[] = [];
    const { host, runs } = hostFor(h, async (claimed) => {
      seen.push(`${claimed.context.role}:${claimed.attempt.kind}`);
      if (claimed.context.role === 'planner')
        return {
          type: 'plan',
          createdByModelCallId: null,
          plan: {
            tasks: [
              {
                title: 'look at health',
                question: 'q1',
                role: 'investigator',
                capabilities: [],
                dependsOn: [],
              },
              {
                title: 'then fix',
                question: 'q2',
                role: 'cache_specialist',
                capabilities: [],
                dependsOn: [0],
              },
            ],
          },
        };
      return {
        type: 'output',
        output: {
          kind: 'handoff',
          content: { by: claimed.context.role },
          dependencyVector: [],
        },
      };
    });
    for (let i = 0; i < 3; i += 1)
      expect((await host.runOnce())?.result).toBe('published');
    expect(await host.runOnce()).toBeNull();
    expect(seen).toEqual([
      'planner:initial',
      'investigator:initial',
      'cache_specialist:initial',
    ]);
    await h.coordinator.outbox.drain();
    const done = await h.coordinator.control.get(mission.id);
    expect(done.status).toBe('succeeded');
    expect(runs.map((run) => run.result)).toEqual([
      'published',
      'published',
      'published',
    ]);
  });
});

it('aborts the handler within the check interval when the ledger invalidates its attempt, and publishes nothing', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const started = latch();
    let observed: string | null = null;
    const { host } = hostFor(h, async (claimed, helpers) => {
      if (claimed.context.taskId !== planned.taskIds[0])
        return { type: 'published' };
      started.open();
      await waitForAbort(helpers.signal);
      observed = helpers.abortReason();
      throw new AttemptAbortedError(observed as never);
    });
    const run = host.runOnce();
    await started.promise;
    const before = Date.now();
    // What the ledger closure does: status first.
    await h.admin.query(
      `UPDATE coordinator.task_attempts SET status = 'invalidated' WHERE task_id = $1 AND status = 'running'`,
      [planned.taskIds[0]],
    );
    const result = (await withTimeout(run, 5_000, 'host run'))!;
    expect(Date.now() - before).toBeLessThan(2_000);
    expect(result.result).toBe('aborted');
    expect(result.abortReason).toBe('readset_invalidated');
    expect(observed).toBe('readset_invalidated');
    expect(await h.ledger.rows('artifact:task_output')).toHaveLength(0);
  });
});

it.each([
  ['pause', 'mission_paused'],
  ['cancel', 'mission_cancelled'],
] as const)('aborts with %s -> abortReason %s', async (action, reason) => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const started = latch();
    const { host } = hostFor(h, async (_claimed, helpers) => {
      started.open();
      await waitForAbort(helpers.signal);
      return {
        type: 'output',
        output: {
          kind: 'handoff',
          content: { late: true },
          dependencyVector: [],
        },
      };
    });
    const run = host.runOnce();
    await started.promise;
    await h.coordinator.control[action](planned.missionId);
    const result = (await withTimeout(run, 5_000, 'host run'))!;
    // The handler returned an output after the abort: it is NOT published.
    expect(result).toMatchObject({ result: 'aborted', abortReason: reason });
    expect(await h.ledger.rows('artifact:task_output')).toHaveLength(0);
  });
});

it('lease loss: a reaper takeover aborts the old host run with lease_lost and its late publication is fenced', async () => {
  await withHarness(async (h) => {
    await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const started = latch();
    const { host } = hostFor(h, async (_claimed, helpers) => {
      started.open();
      await waitForAbort(helpers.signal);
      return {
        type: 'output',
        output: { kind: 'handoff', content: {}, dependencyVector: [] },
      };
    });
    const run = host.runOnce();
    await started.promise;
    const [attempt] = (
      await h.admin.query(
        `SELECT id FROM coordinator.task_attempts WHERE status = 'running'`,
      )
    ).rows;
    await expireLease(h, attempt.id);
    await h.coordinator.reapExpired();
    const result = (await withTimeout(run, 5_000, 'host run'))!;
    expect(result).toMatchObject({
      result: 'aborted',
      abortReason: 'lease_lost',
    });
    expect((await attemptRow(h, attempt.id)).status).toBe('expired');
  });
});

it('heartbeats keep a long-running attempt alive past its lease', async () => {
  await withHarness(async (h) => {
    await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const { host } = hostFor(
      h,
      async () => {
        await sleep(1_200); // three leases
        return {
          type: 'output',
          output: {
            kind: 'handoff',
            content: { slow: true },
            dependencyVector: [],
          },
        };
      },
      { leaseMs: 400 },
    );
    const result = (await host.runOnce())!;
    expect(result.result).toBe('published');
    expect(await h.coordinator.reapExpired()).toEqual([]);
  });
});

it('checkpoint() notices drift at a tool boundary without waiting for the interval', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const started = latch();
    const proceed = latch();
    let boundary: unknown = null;
    const { host } = hostFor(
      h,
      async (_claimed, helpers) => {
        started.open();
        await proceed.promise;
        try {
          await helpers.checkpoint(); // the next "tool call" boundary
        } catch (error) {
          boundary = error;
          throw error;
        }
        return { type: 'published' };
      },
      { abortCheckMs: 60_000 }, // the timer cannot be what notices
    );
    const run = host.runOnce();
    await started.promise;
    await h.coordinator.control.pause(planned.missionId);
    proceed.open();
    const result = (await withTimeout(run, 5_000, 'host run'))!;
    expect(boundary).toBeInstanceOf(AttemptAbortedError);
    expect(result).toMatchObject({
      result: 'aborted',
      abortReason: 'mission_paused',
    });
  });
});

it('a handler error fails the attempt and the task is retried; a failed outcome does the same', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    let calls = 0;
    const { host } = hostFor(h, async (claimed) => {
      if (claimed.context.taskId !== planned.taskIds[0])
        return { type: 'published' };
      calls += 1;
      if (calls === 1) throw new Error('model returned invalid JSON');
      if (calls === 2) return { type: 'failed', reason: 'invalid_output' };
      return {
        type: 'output',
        output: {
          kind: 'handoff',
          content: { ok: true },
          dependencyVector: [],
        },
      };
    });
    const results: string[] = [];
    for (let i = 0; i < 3; i += 1) results.push((await host.runOnce())!.result);
    expect(results).toEqual(['failed', 'failed', 'published']);
    const failed = await h.admin.query(
      `SELECT failure_reason FROM coordinator.task_attempts
        WHERE task_id = $1 AND status = 'failed' ORDER BY n`,
      [planned.taskIds[0]],
    );
    expect(failed.rows.map((row) => row.failure_reason)).toEqual([
      'model returned invalid JSON',
      'invalid_output',
    ]);
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('succeeded');
  });
});

it('a SupportError at publication is reported as support_rejected with the repair already scheduled', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const vector = vectorOf([
      { sourceKey: 'checkout.health', sourceRevision: 7, receiptId: receipt() },
    ]);
    h.validator.failWith = staleVersion(vector[0].receiptId);
    const { host } = hostFor(h, async () => ({
      type: 'output',
      output: {
        kind: 'finding',
        content: { stale: true },
        dependencyVector: vector,
      },
    }));
    const result = (await host.runOnce())!;
    expect(result.result).toBe('support_rejected');
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('runnable');
    h.validator.failWith = null;
    const next = (await host.runOnce())!;
    expect(next.result).toBe('published');
  });
});

it('the host start()/stop() loop claims work in the background and stop() aborts in-flight attempts', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const started = latch();
    const { host, runs } = hostFor(h, async (_claimed, helpers) => {
      started.open();
      await waitForAbort(helpers.signal);
      return { type: 'published' };
    });
    host.start();
    await withTimeout(started.promise, 5_000, 'handler start');
    await host.stop();
    // stop() aborted the run without publishing; the lease expires and the reaper requeues.
    expect(runs.at(-1)).toMatchObject({
      result: 'aborted',
      abortReason: 'host_stopped',
    });
    const [attempt] = (
      await h.admin.query(
        `SELECT id, status FROM coordinator.task_attempts WHERE status = 'running'`,
      )
    ).rows;
    expect(attempt).toBeDefined();
    await expireLease(h, attempt.id);
    const reaped = await h.coordinator.reapExpired();
    expect(reaped[0].task).toBe('requeued');
    expect((await taskRow(h, planned.taskIds[0])).status).toBe('runnable');
  });
});

it('replays a recovery end to end through the host: invalidation aborts the run, the repair attempt gets fresh reads', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator' },
    ]);
    const started = latch();
    const kinds: string[] = [];
    const { host } = hostFor(
      h,
      async (claimed, helpers) => {
        kinds.push(claimed.attempt.kind);
        if (claimed.context.taskId !== planned.taskIds[0])
          return {
            type: 'output',
            output: { kind: 'handoff', content: {}, dependencyVector: [] },
          };
        if (claimed.attempt.kind === 'initial') {
          started.open();
          await waitForAbort(helpers.signal);
          throw new AttemptAbortedError(helpers.abortReason() as never);
        }
        return {
          type: 'output',
          output: {
            kind: 'handoff',
            content: { repaired: true },
            dependencyVector: [],
          },
        };
      },
      { roles: ['investigator'] },
    );
    const first = host.runOnce();
    await started.promise;
    const running = (
      await h.admin.query(
        `SELECT id FROM coordinator.task_attempts WHERE status = 'running'`,
      )
    ).rows[0];
    await h.coordinator.onInvalidation(
      invalidationFor({
        missionId: planned.missionId,
        taskIds: [planned.taskIds[0]],
        attemptIds: [running.id],
        preserved: [planned.taskIds[1]],
      }),
    );
    expect((await first)?.result).toBe('aborted');
    expect((await host.runOnce())?.result).toBe('published'); // the repair of task 0 (claimed first: older created_at)
    expect(kinds).toEqual(['initial', 'repair']);
  });
});
