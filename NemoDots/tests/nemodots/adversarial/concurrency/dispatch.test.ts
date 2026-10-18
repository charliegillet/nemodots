// W5.2: the Redis effect (ARCHITECTURE 5.3, findings C3/C11): duplicate
// delivery, unknown outcomes, zombie dispatchers and a namespace version that
// moves between commit and dispatch. Effects are counted from Redis itself.
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  effectKey,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  injectConfig,
  intentRow,
  proposeFlush,
  settle,
  waitForDbClockPast,
  withEnv,
  type Env,
} from './harness.js';

afterEach(() => clearHooks());

async function seedKeys(env: Env, namespace: string, n: number, tag: string) {
  for (let i = 0; i < n; i += 1)
    await env.redis.client.set(
      `${env.prefix}:cache:${namespace}:v1:${tag}-${i}`,
      JSON.stringify({ i }),
    );
}

async function keysOf(env: Env, namespace: string) {
  const found: string[] = [];
  for await (const batch of env.redis.client.scanIterator({
    MATCH: `${env.prefix}:cache:${namespace}:*`,
    COUNT: 200,
  }))
    found.push(...(Array.isArray(batch) ? batch : [batch]));
  return found.sort();
}

/** proposed -> admitted -> committed flush; returns the commit fence. */
async function committedFlush(env: Env) {
  const sc = await proposeFlush(env);
  const admitted = await env.actions.admit(sc.intent.id, 'd1');
  expect(admitted.status).toBe('admitted');
  const fence = (admitted as unknown as { dispatch: { fence: number } })
    .dispatch.fence;
  const committed = await env.actions.commit(sc.intent.id, fence);
  expect(committed.status).toBe('committed');
  return { sc, fence };
}

describe('Redis effect', () => {
  it('cleared: crash between effect and record, then a second dispatcher -> already_applied, one effect', () =>
    withEnv(
      async (env) => {
        await seedKeys(env, 'catalog-a', 5, 'old');
        const { sc, fence } = await committedFlush(env);
        setHook('after_effect_before_record', ({ actionId }) => {
          if (actionId === sc.intent.id) throw new Error('dispatcher crashed');
        });
        const crashed = await settle(
          env.actions.dispatch(sc.intent.id, fence, 'd1'),
        );
        expect(crashed.ok).toBe(false);
        clearHooks();
        expect(await keysOf(env, 'catalog-a')).toEqual([]);
        // the cache refills before anyone settles the intent
        await seedKeys(env, 'catalog-a', 3, 'new');
        const row = await intentRow(env, sc.intent.id);
        expect(row.status).toBe('committed');
        await waitForDbClockPast(env, row.dispatcher_lease_expires_at as Date);

        const second = await env.actions.dispatch(sc.intent.id, fence, 'd2');
        expect(second.status).toBe('verified');
        expect(await keysOf(env, 'catalog-a')).toHaveLength(3); // no second UNLINK
        const { rows } = await env.admin.query(
          'SELECT external_effect FROM coordinator.result_receipts WHERE action_id = $1',
          [sc.intent.id],
        );
        expect(rows[0].external_effect.scriptResult).toBe('already_applied');
      },
      { dispatchLeaseMs: 300 },
    ));

  it('cleared: a zombie dispatcher parked after its effect finds the intent settled by its successor', () =>
    withEnv(
      async (env) => {
        await seedKeys(env, 'catalog-a', 4, 'old');
        const { sc, fence } = await committedFlush(env);
        const parked = latch();
        const release = latch();
        setHook('after_effect_before_record', async ({ actionId }) => {
          if (actionId !== sc.intent.id || parked.isOpen) return;
          parked.open();
          await release.promise;
        });
        const zombie = env.actions.dispatch(sc.intent.id, fence, 'd1');
        await withTimeout(parked.promise, 5_000, 'd1 parked after its effect');
        await seedKeys(env, 'catalog-a', 2, 'refill');
        const row = await intentRow(env, sc.intent.id);
        await waitForDbClockPast(env, row.dispatcher_lease_expires_at as Date);
        const successor = await env.actions.dispatch(sc.intent.id, fence, 'd2');
        expect(successor.status).toBe('verified');
        release.open();
        const late = await settle(zombie);
        // the zombie must not record anything over the successor's result
        if (late.ok) expect(late.value.status).toBe('verified');
        expect((await intentRow(env, sc.intent.id)).status).toBe('verified');
        expect(await keysOf(env, 'catalog-a')).toHaveLength(2);
        expect(env.effectRedis.evalCalls).toBe(2);
      },
      { dispatchLeaseMs: 300 },
    ));

  it('cleared: lost acknowledgement -> outcome_unknown; reconcile reads the marker and never re-runs', () =>
    withEnv(async (env) => {
      await seedKeys(env, 'catalog-a', 3, 'old');
      const { sc, fence } = await committedFlush(env);
      env.effectRedis.loseNextResponse = true;
      const unknown = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(unknown.status).toBe('outcome_unknown');
      await seedKeys(env, 'catalog-a', 2, 'refill');
      const settled = await env.actions.reconcile(sc.intent.id);
      expect(settled.status).toBe('verified');
      expect(env.effectRedis.evalCalls).toBe(1);
      expect(await keysOf(env, 'catalog-a')).toHaveLength(2);
    }));

  it('cleared: failure before Redis -> outcome_unknown; reconcile settles failed(effect_not_applied), no effect', () =>
    withEnv(async (env) => {
      await seedKeys(env, 'catalog-a', 3, 'old');
      const { sc, fence } = await committedFlush(env);
      env.effectRedis.failNext = true;
      const unknown = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(unknown.status).toBe('outcome_unknown');
      const settled = await env.actions.reconcile(sc.intent.id);
      expect(settled.status).toBe('failed');
      expect(settled.failureReason).toBe('effect_not_applied');
      // a redelivered dispatch of the failed intent does nothing
      const again = await env.actions.dispatch(sc.intent.id, fence, 'd2');
      expect(again.status).toBe('failed');
      expect(await keysOf(env, 'catalog-a')).toHaveLength(3);
      expect(
        await env.redis.client.get(effectKey(env.prefix, sc.intent.id)),
      ).toBeNull();
    }));

  it('cleared: cache.namespace advanced after commit and before dispatch -> claim refused, no effect', () =>
    withEnv(async (env) => {
      await seedKeys(env, 'catalog-a', 3, 'old');
      const { sc, fence } = await committedFlush(env);
      setHook('after_commit_before_dispatch', () => undefined);
      await injectConfig(env, 'cache.namespace', 'catalog-b');
      const result = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(result.status).toBe('failed');
      expect(result.failureReason).toBe('dispatch_fence_invalid');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await keysOf(env, 'catalog-a')).toHaveLength(3);
    }));
});
