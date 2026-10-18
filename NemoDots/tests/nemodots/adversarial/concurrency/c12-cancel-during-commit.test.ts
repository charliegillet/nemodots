// C12 (low): the generation subselect was unlocked, so a commit could land
// after a cancel. Expected (ARCHITECTURE 5.1 step 3, 6, 14 C12): the mission
// row is locked FOR SHARE as the first statement after the intent lock; a
// cancel (generation + 1, FOR UPDATE) waits for the in-flight commit and then
// rejects later ones; effects committed before the cancel's lock are listed in
// the cancellation record (committedEffects).
import { describe, expect, it } from 'vitest';
import {
  actionHistory,
  admitAndCommit,
  cacheKeys,
  configState,
  countingRedis,
  flushScenario,
  intentStatus,
  park,
  proposeFlush,
  proposePool,
  scenario,
  seedCache,
  waitForLockWaiters,
  withWorld,
} from './harness.js';

describe('C12 cancel during commit', () => {
  it('a cancel issued while a commit holds every lock waits for it; the effect is listed in committedEffects', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      const parked = park('after_lock_before_commit');
      const commit = world.service.commit(intent.id, admitted.dispatch!.fence);
      await parked.arrived;
      const cancel = world
        .coordinator()
        .control.cancel(world.missionId as never);
      await waitForLockWaiters(world, 1);
      // The cancel has not taken effect yet.
      const mid = await world.admin.query(
        'SELECT status, generation FROM coordinator.missions WHERE id = $1',
        [world.missionId],
      );
      expect(mid.rows[0]).toMatchObject({ status: 'running', generation: 0 });
      parked.release();
      const [committed, mission] = await Promise.all([commit, cancel]);
      expect(committed.status).toBe('committed');
      expect(mission.status).toBe('cancelled');
      expect(mission.generation).toBe(1);
      expect(mission.cancellation?.committedEffects).toContain(intent.id);
      expect((await configState(world, 'db.pool_max')).value).toBe(20);
      expect(await actionHistory(world, intent.id)).toHaveLength(1);
    });
  });

  it('cancel first, commit second: the commit writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      await world.coordinator().control.cancel(world.missionId as never);
      const result = await world.service.commit(intent.id, admitted.dispatch!.fence);
      expect(['cancelled', 'blocked']).toContain(result.status);
      expect((await configState(world, 'db.pool_max')).version).toBe(1);
      expect(await actionHistory(world, intent.id)).toHaveLength(0);
      expect((await intentStatus(world, intent.id)).status).not.toBe('committed');
    });
  });

  it('the half-cancelled window (mission cancelled and generation bumped, queued intents not yet marked): the commit blocks', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      await world.admin.query(
        "UPDATE coordinator.missions SET status = 'cancelled', generation = generation + 1 WHERE id = $1",
        [world.missionId],
      );
      const result = await world.service.commit(intent.id, admitted.dispatch!.fence);
      expect(result.status).toBe('blocked');
      expect(['mission_not_running', 'generation_mismatch']).toContain(result.blockReason);
      expect((await configState(world, 'db.pool_max')).version).toBe(1);
    });
  });

  it('a committed flush not yet dispatched is failed by the claim after the cancel: no script runs, the cache survives', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a', 'b']);
        const s = await flushScenario(world);
        const intent = await proposeFlush(world, s);
        const admitted = await world.service.admit(intent.id, 'dispatcher-a');
        await world.service.commit(intent.id, admitted.dispatch!.fence);
        await world.coordinator().control.cancel(world.missionId as never);
        await world.service.process(intent.id, 'dispatcher-a');
        const status = await intentStatus(world, intent.id);
        expect(status.status).toBe('failed');
        expect(status.failureReason).toBe('dispatch_fence_invalid');
        expect(counter.scripts).toBe(0);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        void admitAndCommit;
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });
});
