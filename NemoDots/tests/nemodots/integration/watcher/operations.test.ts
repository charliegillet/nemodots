// Scheduling, restart, closure cap, stale replays, redelivery.
import { expect, it } from 'vitest';
import type { SourceKey } from '../../../../src/server/nemodots/contracts/index.js';
import {
  attemptRow,
  claimStart,
  plannedMission,
  receiptsOf,
  recoveryKinds,
  until,
  withWatcherEnv,
} from './harness.js';

const two = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

async function dependent(
  env: Parameters<Parameters<typeof withWatcherEnv>[0]>[0],
  key: string,
) {
  const m = await plannedMission(env.h, two);
  const attempt = await claimStart(env.h, { taskId: m.taskIds[0] });
  const receipt = await env.observeMember(m.missionId, key);
  await env.link(receipt.receipt.id, {
    attemptId: attempt.context.attemptId,
    taskId: m.taskIds[0],
    missionId: m.missionId,
  });
  return { m, attempt, receipt };
}

it('two watcher instances: exactly one registers; a restarted instance does not re-register; the follower takes over when the leader stops', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    await dependent(env, 'db.pool_max');
    const a = env.make();
    const b = env.make();

    await env.inject('db.pool_max', 3);
    const results = await Promise.all([a.tick(), b.tick()]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(a.isLeader() !== b.isLeader()).toBe(true);
    const leader = a.isLeader() ? a : b;
    const follower = a.isLeader() ? b : a;

    expect(await receiptsOf(h, 'checkout.config/db.pool_max')).toHaveLength(2);
    expect(env.recovery.invalidations).toHaveLength(1);

    // the follower does nothing while the leader lives, even on another change
    await env.inject('db.pool_max', 4);
    expect(await follower.tick()).toBeNull();
    expect(await receiptsOf(h, 'checkout.config/db.pool_max')).toHaveLength(2);

    // leader stops: the follower takes over and registers the pending change
    await leader.stop();
    const stats = await follower.tick();
    expect(stats).toMatchObject({ registered: 1 });
    expect(await receiptsOf(h, 'checkout.config/db.pool_max')).toHaveLength(3);

    // restart: nothing changed, nothing is registered again
    await follower.stop();
    const restarted = env.make();
    expect(await restarted.tick()).toMatchObject({
      registered: 0,
      unchanged: 1,
    });
    expect(await receiptsOf(h, 'checkout.config/db.pool_max')).toHaveLength(3);
  });
});

it('a restart does not re-register an observed source: it confirms', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    await env.observeEndpoint(m.missionId, 'checkout.health', { status: 'ok' });
    const first = env.make();
    await first.pass();
    await first.stop();
    const second = env.make();
    expect(await second.tick()).toMatchObject({ registered: 0, confirmed: 1 });
    expect(await receiptsOf(h, 'checkout.health')).toHaveLength(1);
  });
});

it('C14: a capped closure pauses the missions, records a coarse event and still registers the receipt', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    const a1 = await claimStart(h, { taskId: m.taskIds[0] });
    const a2 = await claimStart(h, { taskId: m.taskIds[1] });
    const first = await env.observeEndpoint(m.missionId, 'checkout.health', {
      status: 'ok',
    });
    for (const [attempt, taskId] of [
      [a1, m.taskIds[0]],
      [a2, m.taskIds[1]],
    ] as const)
      await env.link(first.receipt.id, {
        attemptId: attempt.context.attemptId,
        taskId,
        missionId: m.missionId,
      });

    const watcher = env.make({ limits: { maxDepth: 64, maxNodes: 1 } });
    env.reader.values.set('checkout.health' as SourceKey, { status: 'down' });
    expect(await watcher.pass()).toMatchObject({ registered: 1, errors: 0 });

    expect(env.logs.some((l) => l.event === 'closure_cap_exceeded')).toBe(true);
    // receipt registered, old one superseded: the source stays observable
    expect(
      (await receiptsOf(h, 'checkout.health')).map((r) => [
        r.source_revision,
        r.status,
      ]),
    ).toEqual([
      [1, 'superseded'],
      [2, 'supported'],
    ]);
    // mission paused through the control port
    const mission = await h.admin.query(
      'SELECT status FROM coordinator.missions WHERE id = $1',
      [m.missionId],
    );
    expect(mission.rows[0].status).toBe('paused');
    // coarse event: every running attempt of the mission, closure.capped
    const event = env.recovery.invalidations.at(-1)!;
    expect(event.reason).toBe('closure_cap_exceeded');
    expect(event.closure.capped).toBe(true);
    expect([...event.affected.attemptIds].sort()).toEqual(
      [a1.context.attemptId, a2.context.attemptId].sort(),
    );
    expect((await recoveryKinds(h, m.missionId)).map((r) => r.kind)).toContain(
      'mission_paused_closure_cap',
    );
    for (const attempt of [a1, a2])
      expect((await attemptRow(h, attempt.context.attemptId)).status).not.toBe(
        'running',
      );
  });
});

it('a lower-revision replay is rejected by the ledger and logged as stale_observation_rejected; no revision is invented', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const { m } = await dependent(env, 'db.pool_max');
    await env.inject('db.pool_max', 3); // authority v2
    let raced = false;
    const watcher = env.make({
      hooks: {
        // The watcher has read v2; before it registers, the authority moves to
        // v3 and another observer registers v3. The watcher's v2 is now a
        // lower-revision replay.
        async beforeRegister() {
          if (raced) return;
          raced = true;
          await env.inject('db.pool_max', 4);
          await env.observeMember(m.missionId, 'db.pool_max');
        },
      },
    });
    await watcher.pass();
    expect(env.logs.some((l) => l.event === 'stale_observation_rejected')).toBe(
      true,
    );
    expect(
      (await receiptsOf(h, 'checkout.config/db.pool_max')).map((r) => [
        r.source_revision,
        r.status,
      ]),
    ).toEqual([
      [1, 'superseded'],
      [3, 'supported'],
    ]);
  });
});

it('an invalidation the recovery port rejected is redelivered, once, until the coordinator has recorded it', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const { attempt } = await dependent(env, 'db.pool_max');
    env.recovery.failNext = 1;
    await env.inject('db.pool_max', 3);
    const watcher = env.make();
    expect(await watcher.pass()).toMatchObject({
      registered: 1,
      redelivered: 1,
    });
    expect(env.logs.map((l) => l.event)).toEqual(
      expect.arrayContaining([
        'invalidation_delivery_failed',
        'invalidation_redelivered',
      ]),
    );
    expect(env.recovery.invalidations).toHaveLength(1);
    expect((await attemptRow(h, attempt.context.attemptId)).status).not.toBe(
      'running',
    );
    // recorded now: the next pass delivers nothing
    expect(await watcher.pass()).toMatchObject({ redelivered: 0 });
    expect(env.recovery.invalidations).toHaveLength(1);
  });
});

it('logs never carry values or actors', async () => {
  await withWatcherEnv(async (env) => {
    await dependent(env, 'db.pool_max');
    await env.inject('db.pool_max', 3);
    await env.make().pass();
    const text = JSON.stringify(env.logs);
    expect(text).not.toContain('injector');
    expect(text).not.toContain('owner');
    expect(env.logs.length).toBeGreaterThan(0);
    void until;
  });
});
