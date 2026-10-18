// The Redis effect (ARCHITECTURE 5.3): claimDispatch CAS (C11), the Lua
// script (C3), outcome_unknown and reconcile. Crashes are simulated by hooks
// that throw at the named boundary; the effect is observed in real Redis.
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  createIntentReader,
  effectKey,
  fenceKey,
  findDispatchable,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  cancelMission,
  pauseMission,
  resumeMission,
} from '../../../../src/server/nemodots/coordinator/missions.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  admitIntent,
  authorizations,
  injectConfig,
  intentRow,
  liveConfig,
  proposeFlush,
  receiptsOf,
  scanCount,
  seedCacheKeys,
  withEnv,
  type Env,
} from './harness.js';

afterEach(() => clearHooks());

const NS = 'catalog-a';

/** propose -> admit -> commit a flush; returns the committed intent and the fences. */
async function committedFlush(env: Env, keys = 3) {
  const sc = await proposeFlush(env, { namespace: NS });
  await seedCacheKeys(env, NS, keys);
  const { fence } = await admitIntent(env, {
    intent: sc.intent,
  } as never);
  const result = await env.actions.commitDetailed(sc.intent.id, fence);
  return { ...sc, fence, committed: result };
}

const expireLease = (env: Env, id: string) =>
  env.admin.query(
    "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [id],
  );

const crash = () => {
  throw new Error('simulated dispatcher crash');
};

describe('flush commit', () => {
  it('commits the desired state without touching Redis or the config, and records the version the dispatch CAS will check', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env);
      expect(sc.committed.intent.status).toBe('committed');
      expect(sc.committed.receipt).toMatchObject({
        outcome: 'committed',
        controlPlane: null,
      });
      expect(await scanCount(env, NS)).toBe(3);
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await liveConfig(env, 'cache.namespace')).toMatchObject({
        version: 1,
        value: 'catalog-a',
      });
      const row = await intentRow(env, sc.intent.id);
      expect(row.committed_target_version).toBe(1);
      expect(row.expected_target_version).toBe(1);
      const outbox = await env.admin.query(
        'SELECT topic FROM coordinator.outbox WHERE dedupe_key = $1',
        [`action.committed:${sc.intent.id}`],
      );
      expect(outbox.rows[0].topic).toBe('action.dispatch');
    });
  });
});

describe('dispatch', () => {
  it('applies once: claim, Lua effect, dispatched -> verified, marker and fence in Redis, receipt and events', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 4);
      const done = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(done.status).toBe('verified');
      expect(await scanCount(env, NS)).toBe(0);
      expect(
        await env.redis.client.get(effectKey(env.prefix, sc.intent.id)),
      ).toMatch(/^\d+$/);
      expect(await env.redis.client.get(fenceKey(env.prefix))).toBe('1');
      const [receipt] = await receiptsOf(env, sc.intent.id);
      expect(receipt).toMatchObject({
        outcome: 'verified',
        external_effect: {
          scriptResult: 'applied',
          deletedCount: 4,
          markerPresent: true,
          fenceBefore: 0,
          fenceAfter: 1,
        },
        postcondition: { kind: 'observation', configVersion: 1 },
      });
      expect(
        (await authorizations(env, sc.intent.id)).map(
          (a) => `${a.stage}:${a.decision}`,
        ),
      ).toEqual([
        'admission:admitted',
        'commit:committed',
        'dispatch:dispatched',
      ]);
      const kinds = await env.admin.query(
        "SELECT kind FROM coordinator.events WHERE kind IN ('action.dispatched','action.verified') ORDER BY id",
      );
      expect(kinds.rows.map((r) => r.kind)).toEqual([
        'action.dispatched',
        'action.verified',
      ]);
      // a second delivery is a no-op
      expect((await env.actions.dispatch(sc.intent.id, sc.fence)).status).toBe(
        'verified',
      );
      expect(env.effectRedis.evalCalls).toBe(1);
    });
  });

  it('cache.namespace advanced after the commit and before the dispatch: claimDispatch refuses, no Redis effect (C11)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env);
      await injectConfig(env, 'cache.namespace', 'catalog-b');
      const done = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(done).toMatchObject({
        status: 'failed',
        failureReason: 'dispatch_fence_invalid',
      });
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await scanCount(env, NS)).toBe(3);
      expect(
        await env.redis.client.get(effectKey(env.prefix, sc.intent.id)),
      ).toBeNull();
      expect((await authorizations(env, sc.intent.id)).pop()).toMatchObject({
        stage: 'dispatch',
        decision: 'blocked',
        block_reason: 'dispatch_fence_invalid',
      });
    });
  });

  it('a strictly newer Redis fence returns fence_newer: no effect, failed(dispatch_fence_invalid), and a retry cannot sneak through the marker', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env);
      await env.redis.client.set(fenceKey(env.prefix), '5');
      const done = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(done).toMatchObject({
        status: 'failed',
        failureReason: 'dispatch_fence_invalid',
      });
      expect(await scanCount(env, NS)).toBe(3);
      expect(await env.redis.client.get(fenceKey(env.prefix))).toBe('5');
      expect(
        await env.redis.client.get(effectKey(env.prefix, sc.intent.id)),
      ).toBe('fence_newer');
      expect((await receiptsOf(env, sc.intent.id))[0]).toMatchObject({
        outcome: 'failed',
        external_effect: { scriptResult: 'fence_newer', markerPresent: false },
      });
      // reconcile reads the marker and agrees
      expect((await env.actions.reconcile(sc.intent.id)).status).toBe('failed');
    });
  });

  it('an equal Redis fence is not newer: the effect applies', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env);
      await env.redis.client.set(fenceKey(env.prefix), '1');
      expect((await env.actions.dispatch(sc.intent.id, sc.fence)).status).toBe(
        'verified',
      );
      expect(await scanCount(env, NS)).toBe(0);
    });
  });

  it('crash at after_commit_before_dispatch: committed, no marker; reconcile distinguishes it and does not fail it; a dispatcher then applies once', async () => {
    await withEnv(async (env) => {
      const sc = await proposeFlush(env, { namespace: NS });
      await seedCacheKeys(env, NS, 2);
      const { fence } = await admitIntent(env, { intent: sc.intent } as never);
      setHook('after_commit_before_dispatch', crash);
      await expect(
        env.actions.commitDetailed(sc.intent.id, fence),
      ).rejects.toThrow('simulated dispatcher crash');
      clearHooks();
      expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect((await env.actions.reconcile(sc.intent.id)).status).toBe(
        'committed',
      );
      await expireLease(env, sc.intent.id);
      const done = await env.actions.dispatch(sc.intent.id, 12345, 'second');
      expect(done.status).toBe('verified');
      expect(await scanCount(env, NS)).toBe(0);
    });
  });

  it('dispatcher crash at after_effect_before_record, then a second dispatcher: already_applied, zero additional UNLINKs, settles verified (C3)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      setHook('after_effect_before_record', crash);
      await expect(
        env.actions.dispatch(sc.intent.id, sc.fence),
      ).rejects.toThrow('simulated dispatcher crash');
      clearHooks();
      // the effect happened and nothing was recorded
      expect(await scanCount(env, NS)).toBe(0);
      expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
      expect(await receiptsOf(env, sc.intent.id)).toMatchObject([
        { outcome: 'committed' },
      ]);

      // cache entries written after the effect must survive: a second UNLINK pass would delete them
      const fresh = await seedCacheKeys(env, NS, 5, 2);
      expect(fresh).toHaveLength(5);
      await expireLease(env, sc.intent.id);
      const done = await env.actions.dispatch(sc.intent.id, sc.fence, 'second');
      expect(done.status).toBe('verified');
      expect(await scanCount(env, NS)).toBe(5);
      expect((await receiptsOf(env, sc.intent.id))[0]).toMatchObject({
        external_effect: { scriptResult: 'already_applied', deletedCount: 0 },
      });
      expect(env.effectRedis.evalCalls).toBe(2);
    });
  });

  it('the first dispatcher waking after a second one settled the intent records nothing and does not fail (idempotent)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 2);
      const parked = latch();
      const resume = latch();
      let first = true;
      setHook('after_effect_before_record', async () => {
        if (!first) return;
        first = false;
        parked.open();
        await resume.promise;
      });
      const slow = env.actions.dispatch(sc.intent.id, sc.fence);
      await parked.promise;
      await expireLease(env, sc.intent.id);
      const second = await env.actions.dispatch(
        sc.intent.id,
        sc.fence,
        'second',
      );
      expect(second.status).toBe('verified');
      resume.open();
      const late = await slow;
      expect(late.status).toBe('verified');
      expect(
        (await authorizations(env, sc.intent.id)).filter(
          (a) => a.stage === 'dispatch',
        ),
      ).toHaveLength(2);
      expect(await receiptsOf(env, sc.intent.id)).toHaveLength(1);
    });
  });

  it('another dispatcher holding an unexpired lease cannot be displaced', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env);
      await expect(
        env.actions.dispatch(sc.intent.id, sc.fence + 999, 'intruder'),
      ).rejects.toMatchObject({ reason: 'lease_held' });
      expect(env.effectRedis.evalCalls).toBe(0);
    });
  });

  it('a lost response after a real effect: outcome_unknown, then reconcile reads the marker and settles verified without re-running (gate 2.12)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      env.effectRedis.loseNextResponse = true;
      const done = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(done.status).toBe('outcome_unknown');
      expect(await scanCount(env, NS)).toBe(0); // the effect did run
      expect((await receiptsOf(env, sc.intent.id))[0].outcome).toBe(
        'outcome_unknown',
      );

      await seedCacheKeys(env, NS, 2, 2);
      const settled = await env.actions.reconcile(sc.intent.id);
      expect(settled.status).toBe('verified');
      expect(await scanCount(env, NS)).toBe(2); // reconcile never re-ran the effect
      expect(env.effectRedis.evalCalls).toBe(1);
      expect((await receiptsOf(env, sc.intent.id))[0]).toMatchObject({
        outcome: 'verified',
        external_effect: { markerPresent: true },
      });
    });
  });

  it('Redis unreachable before the effect: outcome_unknown, reconcile finds no marker and settles failed(effect_not_applied)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      env.effectRedis.failNext = true;
      expect((await env.actions.dispatch(sc.intent.id, sc.fence)).status).toBe(
        'outcome_unknown',
      );
      const settled = await env.actions.reconcile(sc.intent.id);
      expect(settled).toMatchObject({
        status: 'failed',
        failureReason: 'effect_not_applied',
      });
      expect(await scanCount(env, NS)).toBe(3);
      expect(env.effectRedis.evalCalls).toBe(1);
    });
  });

  it('without a Redis client the effect is outcome_unknown, not a silent success', async () => {
    await withEnv(
      async (env) => {
        const sc = await committedFlush(env);
        expect(
          (await env.actions.dispatch(sc.intent.id, sc.fence)).status,
        ).toBe('outcome_unknown');
      },
      { noRedis: true },
    );
  });

  it('dispatch of a set_config intent is a no-op: there is no external effect', async () => {
    await withEnv(async (env) => {
      const { proposeSetConfig } = await import('./harness.js');
      const sc = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, sc);
      await env.actions.commitDetailed(sc.intent.id, fence);
      const result = await env.actions.dispatch(sc.intent.id, fence);
      expect(result.status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
    });
  });
});

describe('flush predicates', () => {
  it('a flush is blocked at admission when redis.stats is stale, and at commit when the namespace key moved', async () => {
    await withEnv(async (env) => {
      const stale = await proposeFlush(env, { namespace: NS });
      await injectConfig(env, 'cache.namespace', 'catalog-b');
      const blocked = await env.actions.admit(stale.intent.id, 'd1');
      expect(blocked.status).toBe('blocked');
      expect(['stale_pending_observation', 'stale_version']).toContain(
        blocked.blockReason,
      );

      const second = await proposeFlush(env, { namespace: 'catalog-b' });
      const { fence } = await admitIntent(env, {
        intent: second.intent,
      } as never);
      await injectConfig(env, 'cache.namespace', 'catalog-c');
      const commit = await env.actions.commitDetailed(second.intent.id, fence);
      expect(commit.intent.status).toBe('blocked');
      expect(await liveConfig(env, 'cache.namespace')).toMatchObject({
        value: 'catalog-c',
      });
    });
  });
});

// BUILD_PROMPT: pause and cancel specify what happens to queued intents and
// committed effects, and the distinction is visible.
describe('dispatch under pause and cancel', () => {
  const deps = (env: Env) =>
    ({
      pool: env.app,
      events: createEventSink(),
      intents: createIntentReader(),
      actions: env.actions,
    }) as unknown as Parameters<typeof pauseMission>[0];

  it('pause before dispatch: nothing is dispatched and nothing is written; the intent stays committed; after resume it is dispatched exactly once', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      await pauseMission(deps(env), sc.world.missionId as never);
      const authBefore = (await authorizations(env, sc.intent.id)).length;

      const claim = await env.actions.claimDispatch(sc.intent.id, sc.fence);
      expect(claim.fence).toBeNull();
      expect(claim.deferred).toBe('mission_paused');
      const deferred = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(deferred.status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await scanCount(env, NS)).toBe(3);
      expect((await authorizations(env, sc.intent.id)).length).toBe(authBefore);
      expect((await receiptsOf(env, sc.intent.id))[0].outcome).toBe(
        'committed',
      );

      await resumeMission(deps(env), sc.world.missionId as never);
      const pending = await findDispatchable(env.app as never);
      expect(pending.map((p) => p.id)).toContain(sc.intent.id);
      const done = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(done.status).toBe('verified');
      expect(env.effectRedis.evalCalls).toBe(1);
      expect(await scanCount(env, NS)).toBe(0);
      // and a second delivery does not dispatch again
      await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(env.effectRedis.evalCalls).toBe(1);
    });
  });

  it('cancel before dispatch: the committed effect is listed, ends failed with the explicit reason mission_not_running, and Redis is untouched', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      const queued = await proposeFlush(env, {
        world: sc.world,
        namespace: 'catalog-b',
        toolCallId: 'call_queued',
      }).catch(() => null);
      const cancelled = await cancelMission(
        deps(env),
        sc.world.missionId as never,
      );
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancellation?.committedEffects).toContain(sc.intent.id);
      void queued;

      const row = await intentRow(env, sc.intent.id);
      expect(row).toMatchObject({
        status: 'failed',
        failure_reason: 'effect_not_applied',
      });
      expect(row.block_detail).toContain('mission_not_running');
      const last = (await authorizations(env, sc.intent.id)).pop();
      expect(last).toMatchObject({
        stage: 'dispatch',
        decision: 'blocked',
        block_reason: 'mission_not_running',
      });
      expect((await receiptsOf(env, sc.intent.id))[0]).toMatchObject({
        outcome: 'failed',
        external_effect: null,
      });
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await scanCount(env, NS)).toBe(3);
      // a late dispatch attempt changes nothing
      expect((await env.actions.dispatch(sc.intent.id, sc.fence)).status).toBe(
        'failed',
      );
      expect(env.effectRedis.evalCalls).toBe(0);
    });
  });

  it('cancel does not roll back an effect that was already dispatched', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 2);
      expect((await env.actions.dispatch(sc.intent.id, sc.fence)).status).toBe(
        'verified',
      );
      const cancelled = await cancelMission(
        deps(env),
        sc.world.missionId as never,
      );
      expect(cancelled.cancellation?.committedEffects).toContain(sc.intent.id);
      expect((await intentRow(env, sc.intent.id)).status).toBe('verified');
      expect(await scanCount(env, NS)).toBe(0);
    });
  });

  it('a pause that commits between the claim and the effect (barrier) stops the effect; the intent stays committed and is dispatched after resume', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      const claimed = latch();
      const release = latch();
      setHook('after_claim_before_effect', async () => {
        claimed.open();
        await release.promise;
      });
      const dispatching = env.actions.dispatch(sc.intent.id, sc.fence);
      await withTimeout(claimed.promise, 5_000, 'claim');
      await pauseMission(deps(env), sc.world.missionId as never);
      release.open();
      const result = await withTimeout(dispatching, 5_000, 'dispatch');
      expect(result.status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await scanCount(env, NS)).toBe(3);
      clearHooks();

      await resumeMission(deps(env), sc.world.missionId as never);
      const done = await env.actions.dispatch(sc.intent.id, sc.fence);
      expect(done.status).toBe('verified');
      expect(env.effectRedis.evalCalls).toBe(1);
    });
  });

  it('a pause racing the claim transaction itself: either the dispatch completed first or no effect happens', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      // the claim transaction holds the mission share lock; the pause (mission
      // FOR UPDATE) cannot commit before the claim does
      const [dispatched, paused] = await withTimeout(
        Promise.all([
          env.actions.dispatch(sc.intent.id, sc.fence),
          pauseMission(deps(env), sc.world.missionId as never),
        ]),
        10_000,
        'dispatch vs pause',
      );
      expect(paused.status).toBe('paused');
      if (dispatched.status === 'verified') {
        // the dispatch won: the effect happened before the pause committed
        expect(env.effectRedis.evalCalls).toBe(1);
        expect(await scanCount(env, NS)).toBe(0);
      } else {
        expect(dispatched.status).toBe('committed');
        expect(env.effectRedis.evalCalls).toBe(0);
        expect(await scanCount(env, NS)).toBe(3);
      }
    });
  });

  it('a flush claimed before the cancel, with no marker, is settled not run only after the marker was read; with a marker it is verified (C-07)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      // claimed, then the dispatcher disappeared before touching Redis
      const claim = await env.actions.claimDispatch(
        sc.intent.id,
        sc.fence,
        'd1',
      );
      expect(claim.fence).not.toBeNull();
      await cancelMission(deps(env), sc.world.missionId as never);
      // cancel leaves a claimed flush to its dispatcher
      expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
      await env.admin.query(
        "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [sc.intent.id],
      );
      const settled = await env.actions.dispatch(sc.intent.id, sc.fence, 'd2');
      expect(settled).toMatchObject({
        status: 'failed',
        failureReason: 'effect_not_applied',
      });
      // only the refusal tombstone was planted (one eval); the flush did not run
      expect(env.effectRedis.evalCalls).toBe(1);
      expect(
        await env.redis.client.get(effectKey(env.prefix, sc.intent.id)),
      ).toBe('not_applied');
      expect(await scanCount(env, NS)).toBe(3);
      expect(
        (await authorizations(env, sc.intent.id)).filter(
          (a) => a.block_reason === 'mission_not_running',
        ),
      ).toHaveLength(1);
    });
  });

  it('a dispatcher whose fence was superseded stops without an effect, even when the mission is running (C-08)', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      const parked = latch();
      const release = latch();
      let calls = 0;
      setHook('after_claim_before_effect', async () => {
        calls += 1;
        if (calls > 1) return;
        parked.open();
        await release.promise;
      });
      const first = env.actions.dispatch(sc.intent.id, sc.fence, 'd1');
      await withTimeout(parked.promise, 5_000, 'claim');
      await env.admin.query(
        "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [sc.intent.id],
      );
      const taken = await env.actions.claimDispatch(
        sc.intent.id,
        sc.fence,
        'd2',
      );
      expect(taken.fence).not.toBeNull();
      release.open();
      expect((await first).status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await scanCount(env, NS)).toBe(3);
    });
  });

  it('C-12: a planted not_applied marker with the settlement lost is reconciled as failed(effect_not_applied) with mission_not_running, never as a fence refusal', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      await env.actions.claimDispatch(sc.intent.id, sc.fence, 'd1');
      await cancelMission(deps(env), sc.world.missionId as never);
      expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
      // the tombstone was planted, the PostgreSQL settlement was lost
      await env.redis.client.set(
        effectKey(env.prefix, sc.intent.id),
        'not_applied',
      );
      const settled = await env.actions.reconcile(sc.intent.id);
      expect(settled).toMatchObject({
        status: 'failed',
        failureReason: 'effect_not_applied',
      });
      expect((await intentRow(env, sc.intent.id)).block_detail).toContain(
        'mission_not_running',
      );
      expect(
        (await authorizations(env, sc.intent.id)).filter(
          (a) => a.block_reason === 'mission_not_running',
        ),
      ).toHaveLength(1);
      expect(await scanCount(env, NS)).toBe(3);
    });
  });

  it('C-12: the script finding not_applied answers refused_not_applied, so a racing dispatcher records failed(effect_not_applied), never verified, and nothing is flushed', async () => {
    await withEnv(async (env) => {
      const sc = await committedFlush(env, 3);
      await env.redis.client.set(
        effectKey(env.prefix, sc.intent.id),
        'not_applied',
      );
      const result = await env.actions.dispatch(sc.intent.id, sc.fence, 'd1');
      expect(result).toMatchObject({
        status: 'failed',
        failureReason: 'effect_not_applied',
      });
      expect(await scanCount(env, NS)).toBe(3);
      expect((await receiptsOf(env, sc.intent.id))[0]).toMatchObject({
        outcome: 'failed',
        external_effect: null,
      });
    });
  });
});
