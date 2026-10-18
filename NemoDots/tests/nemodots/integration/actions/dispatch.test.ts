// The Redis effect (ARCHITECTURE 5.3): claimDispatch CAS (C11), the Lua
// script (C3), outcome_unknown and reconcile. Crashes are simulated by hooks
// that throw at the named boundary; the effect is observed in real Redis.
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  effectKey,
  fenceKey,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { latch } from '../../helpers/barrier.js';
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
