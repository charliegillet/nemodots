// W5.2: cancel / pause against in-flight commits (finding C12, ARCHITECTURE 6
// "Run generation") and the lock order of commit, pause and a closure
// registration (ARCHITECTURE 5.1 "overlapping writers serialize without
// deadlock", ledger/prelock.ts).
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  createIntentReader,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  cancelMission,
  pauseMission,
} from '../../../../src/server/nemodots/coordinator/missions.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  createWorld,
  intentRow,
  liveConfig,
  observeObserved,
  proposeSetConfig,
  settle,
  waitForLockWaiters,
  withEnv,
  type Env,
} from './harness.js';

afterEach(() => clearHooks());

function missionDeps(env: Env) {
  return {
    pool: env.app,
    events: createEventSink(),
    intents: createIntentReader(),
    actions: env.actions,
  } as unknown as Parameters<typeof cancelMission>[0];
}

async function fenceOf(env: Env, actionId: string) {
  const admitted = await env.actions.admit(actionId as never, 'd1');
  expect(admitted.status).toBe('admitted');
  return (admitted as unknown as { dispatch: { fence: number } }).dispatch
    .fence;
}

describe('cancel and pause during an in-flight commit', () => {
  it('cleared: cancel waits for the commit, lists it as a committed effect and cancels queued intents', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const sc = await proposeSetConfig(env, { world });
      const queued = await proposeSetConfig(env, {
        world,
        key: 'db.statement_timeout_ms',
        value: 4_000,
      });
      const fence = await fenceOf(env, sc.intent.id);
      const parked = latch();
      const release = latch();
      setHook('after_lock_before_commit', async ({ actionId }) => {
        if (actionId !== sc.intent.id) return;
        parked.open();
        await release.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await withTimeout(parked.promise, 5_000, 'commit parked');
      let cancelled = false;
      const cancel = cancelMission(
        missionDeps(env),
        world.missionId as never,
      ).then((m) => {
        cancelled = true;
        return m;
      });
      await waitForLockWaiters(env, 1);
      expect(cancelled).toBe(false);
      release.open();
      expect((await commit).intent.status).toBe('committed');
      const mission = await cancel;
      expect(mission.status).toBe('cancelled');
      expect(mission.generation).toBe(1);
      expect(mission.cancellation?.committedEffects).toContain(sc.intent.id);
      expect(mission.cancellation?.cancelledIntentIds).toContain(
        queued.intent.id,
      );
      expect((await intentRow(env, queued.intent.id)).status).toBe('cancelled');
      expect(await liveConfig(env, 'db.pool_max')).toMatchObject({ value: 20 });
    }));

  it('cleared: pause waits for the commit; a later commit of the same mission is blocked', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const sc = await proposeSetConfig(env, { world });
      const later = await proposeSetConfig(env, {
        world,
        key: 'db.statement_timeout_ms',
        value: 4_000,
      });
      const fence = await fenceOf(env, sc.intent.id);
      const laterFence = await fenceOf(env, later.intent.id);
      const parked = latch();
      const release = latch();
      setHook('after_lock_before_commit', async ({ actionId }) => {
        if (actionId !== sc.intent.id) return;
        parked.open();
        await release.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await withTimeout(parked.promise, 5_000, 'commit parked');
      const pause = pauseMission(missionDeps(env), world.missionId as never);
      await waitForLockWaiters(env, 1);
      release.open();
      expect((await commit).intent.status).toBe('committed');
      expect((await pause).status).toBe('paused');
      const blocked = await env.actions.commitDetailed(
        later.intent.id,
        laterFence,
      );
      expect(blocked.intent.status).toBe('blocked');
      expect(blocked.intent.blockReason).toBe('mission_not_running');
      expect(await liveConfig(env, 'db.statement_timeout_ms')).toMatchObject({
        value: 5_000,
      });
    }));
});

// C-02 (medium, liveness): REPRODUCED, then fixed concurrently. With the
// intent-first order of the original commit.ts (intent FOR UPDATE, then mission
// FOR SHARE), pause/cancel (mission FOR UPDATE -> attempts FOR UPDATE,
// coordinator/missions.ts) and a closure registration (attempts/tasks FOR
// UPDATE -> intents FOR UPDATE, ledger/prelock.ts) formed a cycle and
// PostgreSQL aborted one of them with 40P01 after deadlock_timeout (first run
// 2026-10-18 05:52: deadlocks=1, 1.2 s). The working tree then changed
// commit/admit/dispatch to lockMissionThenIntent (actions/predicates.ts), the
// order ARCHITECTURE 5.1 already implies for every other coordinator writer
// (mission -> attempt -> task -> intent); with it this test passes. Kept as
// the regression test. The window between the commit's first lock and the
// mission lock is widened with an ACCESS EXCLUSIVE lock on result_receipts,
// which commit reads in between.
describe('lock order: commit vs pause vs closure registration', () => {
  it('C-02 regression: no deadlock between a commit, a pause and an invalidating registration', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await fenceOf(env, sc.intent.id);
      const gate = new pg.Client({ connectionString: env.db.urls.admin });
      await gate.connect();
      try {
        await gate.query('BEGIN');
        await gate.query(
          'LOCK TABLE coordinator.result_receipts IN ACCESS EXCLUSIVE MODE',
        );
        // 1. commit takes its first coordinator lock(s), then waits on the gate
        const commit = settle(env.actions.commitDetailed(sc.intent.id, fence));
        await waitForLockWaiters(env, 1);
        // 2. the registration's closure prelocks the attempt, then waits on the intent
        const registration = settle(
          observeObserved(env, sc.world, 'checkout.health', {
            status: 'degraded',
          }),
        );
        await waitForLockWaiters(env, 2);
        // 3. pause takes the mission, then waits on the attempt
        const pause = settle(
          pauseMission(missionDeps(env), sc.world.missionId as never),
        );
        await waitForLockWaiters(env, 3);
        // 4. the commit continues (the old order then wanted the mission: cycle)
        await gate.query('COMMIT');
        const results = await Promise.all([commit, registration, pause]);
        for (const result of results) expect(result.ok).toBe(true);
        expect(env.conflicts.deadlocks).toBe(0);
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined);
        await gate.end();
      }
    }));
});

// FINDING C-06 (medium, liveness). Event writers that lock the INTENT first
// and never the mission (actions/settle.ts settleFromHistory / settleMismatch /
// settleSuperseded, reconcile.ts, dispatch.ts recordOutcome) take the C6
// events advisory lock (coordinator/events.ts append) and THEN the INSERT's
// foreign-key check takes FOR KEY SHARE on coordinator.missions. A pause or
// cancel holds that row FOR UPDATE (conflicts with KEY SHARE) and takes the
// same advisory lock last, in its own events flush. Pause waits for the
// advisory lock, the settle waits for the mission row: 40P01. The window is
// widened by holding the attempt row that pause locks after the mission.
describe('lock order: intent-first event writers vs pause', () => {
  it('FINDING C-06: settleFromHistory concurrent with a pause does not deadlock', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await fenceOf(env, sc.intent.id);
      const committed = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(committed.intent.status).toBe('committed');
      const after = committed.receipt!.controlPlane!;
      const gate = new pg.Client({ connectionString: env.db.urls.admin });
      await gate.connect();
      try {
        await gate.query('BEGIN');
        await gate.query(
          'SELECT id FROM coordinator.task_attempts WHERE id = $1 FOR UPDATE',
          [sc.world.attemptId],
        );
        // 1. pause holds the mission FOR UPDATE, then waits on the attempt
        const pause = settle(
          pauseMission(missionDeps(env), sc.world.missionId as never),
        );
        await waitForLockWaiters(env, 1);
        // 2. the watcher's settlement takes the events lock, then waits on
        //    the mission row (FK key share)
        const settled = settle(
          env.actions.settleFromHistory(sc.intent.id as never, {
            afterDigest: after.afterDigest,
            configVersion: after.targetVersionAfter,
          }),
        );
        await waitForLockWaiters(env, 2);
        // 3. pause proceeds to its own events flush
        await gate.query('COMMIT');
        const results = await Promise.all([pause, settled]);
        for (const result of results) expect(result.ok).toBe(true);
        expect((await intentRow(env, sc.intent.id)).status).toBe('verified');
        expect(env.conflicts.deadlocks).toBe(0);
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined);
        await gate.end();
      }
    }));
});
