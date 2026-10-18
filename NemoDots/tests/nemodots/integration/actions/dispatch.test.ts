// flush_cache_namespace, the only external effect, against a real Redis
// prefix: claimDispatch, the marker-first Lua script, record and reconcile
// (TEST_PROMPT gate 2 items 11-13; findings C3, C11).
import { describe, expect, it } from 'vitest';
import {
  EFFECT_SCRIPT,
  SimulatedCrash,
  dispatchIntentDetailed,
  effectKey,
  epochKey,
  fenceKey,
  reconcileIntentDetailed,
  setBarrier,
  type RedisEffectClient,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  authorizations,
  cacheKeys,
  configState,
  countRows,
  expireDispatcherLease,
  externalChange,
  flushScenario,
  intentRow,
  proposeFlush,
  redisValue,
  results,
  seedCache,
  withWorld,
  admitAndCommit,
  type World,
} from './harness.js';

/** Proposes, admits and commits a flush of catalog-a; returns the committed intent. */
async function committedFlush(world: World) {
  const s = await flushScenario(world);
  const proposed = await proposeFlush(world, s);
  expect(proposed.status).toBe('proposed');
  expect(proposed.expectedTargetVersion).toBe(1); // cache.namespace version (C11)
  const { committed } = await admitAndCommit(world, proposed.id);
  expect(committed.status).toBe('committed');
  return { s, intent: committed };
}

describe('flush_cache_namespace', () => {
  it('commits without touching the configuration, then dispatches once and verifies by marker read-back', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2', 'p3']);
        await seedCache(world, 'catalog-b', ['q1']);
        const { intent } = await committedFlush(world);
        // Commit changed no config: the namespace key is untouched, still version 1.
        expect(await configState(world, 'cache.namespace')).toMatchObject({
          value: 'catalog-a',
          version: 1,
          causedBy: null,
        });
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(3);
        expect((await results(world, intent.id)).map((r) => r.outcome)).toEqual(
          ['committed'],
        );
        expect((await results(world, intent.id))[0].control_plane).toBeNull();

        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('verified');
        expect(done.scriptResult).toBe('applied');
        expect(done.deletedCount).toBe(3);
        expect(done.intent.status).toBe('verified');
        // Only the flushed namespace is gone.
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        expect(await cacheKeys(world, 'catalog-b')).toHaveLength(1);
        // Marker and fence in Redis.
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^applied:\d+:3$/,
        );
        expect(await redisValue(world, 'fence:cache.namespace')).toBe('1');
        // Rows: dispatched then verified receipts, a dispatch authorization.
        const rows = await results(world, intent.id);
        expect(rows.map((r) => r.outcome)).toEqual([
          'committed',
          'dispatched',
          'verified',
        ]);
        expect(rows[1].external_effect).toMatchObject({
          scriptResult: 'applied',
          deletedCount: 3,
          markerPresent: true,
          fenceBefore: 0,
          fenceAfter: 1,
        });
        expect(rows[2].postcondition).toMatchObject({
          kind: 'observation',
          configVersion: 1,
        });
        const auth = await authorizations(world, intent.id);
        expect(auth.map((a) => `${a.stage}:${a.decision}`)).toEqual([
          'admission:admitted',
          'commit:committed',
          'dispatch:dispatched',
        ]);
        // The configuration is still untouched after the effect.
        expect(await configState(world, 'cache.namespace')).toMatchObject({
          value: 'catalog-a',
          version: 1,
        });
      },
      { redis: true },
    );
  });

  it('flushes a large namespace completely (SCAN loop and UNLINK chunking) and leaves other namespaces alone', async () => {
    await withWorld(
      async (world) => {
        const names = Array.from({ length: 1300 }, (_, i) => `entry-${i}`);
        await seedCache(world, 'catalog-a', names);
        await seedCache(world, 'catalog-ab', ['must-survive']);
        await seedCache(world, 'catalog-b', ['q1', 'q2']);
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('verified');
        expect(done.deletedCount).toBe(1300);
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        // A namespace that merely starts with the same letters is a different namespace.
        expect(await cacheKeys(world, 'catalog-ab')).toHaveLength(1);
        expect(await cacheKeys(world, 'catalog-b')).toHaveLength(2);
      },
      { redis: true },
    );
  });

  it('dispatching again never repeats the effect', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const { intent } = await committedFlush(world);
        await dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a');
        await seedCache(world, 'catalog-a', ['new1', 'new2']);
        const again = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(again.disposition).toBe('unchanged');
        expect(again.intent.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        expect(
          await countRows(
            world,
            'coordinator.result_receipts',
            "action_id = $1 AND outcome = 'dispatched'",
            [intent.id],
          ),
        ).toBe(1);
      },
      { redis: true },
    );
  });

  it('a dispatcher crash after the effect: the second dispatcher never calls the script, settles from the marker, and deletes nothing (C3)', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const { intent } = await committedFlush(world);
        setBarrier('after_effect_before_record', (context) => {
          if (context.stage === 'dispatch')
            throw new SimulatedCrash('after_effect_before_record');
        });
        await expect(
          dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        // The effect happened, nothing was recorded but the attempt itself.
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        const crashed = await intentRow(world, intent.id);
        expect(crashed.status).toBe('committed');
        expect(crashed.effect_attempted_at).not.toBeNull();
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^applied:/,
        );
        // New entries appear before the second dispatcher runs: they must survive.
        await seedCache(world, 'catalog-a', ['fresh1', 'fresh2', 'fresh3']);
        setBarrier('after_effect_before_record', null);
        // While the first dispatcher's lease is live nobody else may touch it.
        const early = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(early.disposition).toBe('unchanged');
        await expireDispatcherLease(world, intent.id);
        const second = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(second.priorAttempt).toBe(true);
        expect(second.scriptResult).toBeNull();
        expect(second.disposition).toBe('outcome_unknown');
        const settled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(settled.finding).toBe('effect_applied');
        expect(settled.intent.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(3);
        const rows = await results(world, intent.id);
        expect(rows.map((r) => r.outcome)).toEqual([
          'committed',
          'outcome_unknown',
          'dispatched',
          'verified',
        ]);
        expect(rows[2].external_effect).toMatchObject({
          scriptResult: 'applied',
          deletedCount: 2,
          markerPresent: true,
        });
      },
      { redis: true },
    );
  });

  it('reconcile after that crash reads the marker: verified, and the effect is not re-run', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const { intent } = await committedFlush(world);
        setBarrier('after_effect_before_record', () => {
          throw new SimulatedCrash('after_effect_before_record');
        });
        await expect(
          dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        await seedCache(world, 'catalog-a', ['fresh1']);
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('effect_applied');
        expect(reconciled.intent.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        // Reconcile twice: terminal, nothing more.
        expect(
          (await reconcileIntentDetailed(world.deps, intent.id)).finding,
        ).toBe('terminal');
        expect(
          await countRows(
            world,
            'coordinator.result_receipts',
            'action_id = $1',
            [intent.id],
          ),
        ).toBe(3);
      },
      { redis: true },
    );
  });

  it('a crash after commit but before dispatch is awaiting_dispatch, not failed; dispatch then applies it once', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const s = await flushScenario(world);
        const proposed = await proposeFlush(world, s);
        const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
        setBarrier('after_commit_before_dispatch', () => {
          throw new SimulatedCrash('after_commit_before_dispatch');
        });
        await expect(
          world.service.commit(proposed.id, admitted.dispatch!.fence),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        const reconciled = await reconcileIntentDetailed(
          world.deps,
          proposed.id,
        );
        expect(reconciled.finding).toBe('awaiting_dispatch');
        expect(reconciled.intent.status).toBe('committed');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        // dispatcher-a's lease is still live: dispatcher-b must wait for it.
        expect(
          (await world.service.process(proposed.id, 'dispatcher-b')).status,
        ).toBe('committed');
        await expireDispatcherLease(world, proposed.id);
        const done = await world.service.process(proposed.id, 'dispatcher-b');
        expect(done.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
      },
      { redis: true },
    );
  });

  it('a strictly newer Redis fence: fence_newer, nothing deleted, failed(dispatch_fence_invalid) (C3)', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const { intent } = await committedFlush(world);
        await world.redis!.client.set(fenceKey(world.redis!.prefix), '99');
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.scriptResult).toBe('fence_newer');
        expect(done.disposition).toBe('failed');
        expect(done.intent.status).toBe('failed');
        expect(done.intent.failureReason).toBe('dispatch_fence_invalid');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        expect(await redisValue(world, `effect:${intent.id}`)).toBe(
          'fence_newer:99',
        );
        expect(await redisValue(world, 'fence:cache.namespace')).toBe('99');
        const rows = await results(world, intent.id);
        expect(rows.map((r) => r.outcome)).toEqual(['committed', 'failed']);
        expect(rows[1].external_effect).toMatchObject({
          scriptResult: 'fence_newer',
          deletedCount: 0,
          fenceBefore: 99,
        });
        // Reconcile of a marker that says fence_newer never calls it applied.
        expect(
          (await reconcileIntentDetailed(world.deps, intent.id)).finding,
        ).toBe('terminal');
      },
      { redis: true },
    );
  });

  it('an equal fence is not newer: the flush applies', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const { intent } = await committedFlush(world);
        await world.redis!.client.set(fenceKey(world.redis!.prefix), '1');
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.intent.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
      },
      { redis: true },
    );
  });

  it('cache.namespace advanced after the commit: claimDispatch refuses and nothing is deleted (C11)', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const s = await flushScenario(world);
        const proposed = await proposeFlush(world, s);
        const admitted = await world.service.admit(proposed.id, 'dispatcher-a');
        setBarrier('after_commit_before_dispatch', async () => {
          await externalChange(world, 'cache.namespace', 'catalog-c');
        });
        const committed = await world.service.commit(
          proposed.id,
          admitted.dispatch!.fence,
        );
        expect(committed.status).toBe('committed');
        setBarrier('after_commit_before_dispatch', null);
        const done = await dispatchIntentDetailed(
          world.deps,
          proposed.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('failed');
        expect(done.intent.failureReason).toBe('dispatch_fence_invalid');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        expect(await redisValue(world, `effect:${proposed.id}`)).toBeNull();
        const auth = await authorizations(world, proposed.id);
        expect(auth[auth.length - 1]).toMatchObject({
          stage: 'dispatch',
          decision: 'blocked',
          block_reason: 'dispatch_fence_invalid',
          target_expected: '1',
          target_live: '2',
        });
        expect(await configState(world, 'cache.namespace')).toMatchObject({
          value: 'catalog-c',
          version: 2,
          causedBy: null,
        });
      },
      { redis: true },
    );
  });

  it('an intent that expired before dispatch fails(expired) without any effect', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const { intent } = await committedFlush(world);
        await world.admin.query(
          'ALTER TABLE coordinator.action_intents DISABLE TRIGGER action_intents_guard',
        );
        await world.admin.query(
          `UPDATE coordinator.action_intents SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
          [intent.id],
        );
        await world.admin.query(
          'ALTER TABLE coordinator.action_intents ENABLE TRIGGER action_intents_guard',
        );
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.intent.status).toBe('failed');
        expect(done.intent.failureReason).toBe('expired');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
      },
      { redis: true },
    );
  });

  it('a mission cancelled before dispatch (generation moved) fails the intent without any effect', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const { intent } = await committedFlush(world);
        await world.admin.query(
          `UPDATE coordinator.missions SET generation = generation + 1 WHERE id = $1`,
          [world.missionId],
        );
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.intent.status).toBe('failed');
        const auth = await authorizations(world, intent.id);
        expect(auth[auth.length - 1]).toMatchObject({
          stage: 'dispatch',
          block_reason: 'generation_mismatch',
        });
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
      },
      { redis: true },
    );
  });

  it('a paused mission defers the dispatch: the intent stays committed', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const { intent } = await committedFlush(world);
        await world.admin.query(
          `UPDATE coordinator.missions SET status = 'paused' WHERE id = $1`,
          [world.missionId],
        );
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('unchanged');
        expect(done.intent.status).toBe('committed');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        await world.admin.query(
          `UPDATE coordinator.missions SET status = 'running' WHERE id = $1`,
          [world.missionId],
        );
        expect(
          (await dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a'))
            .intent.status,
        ).toBe('verified');
      },
      { redis: true },
    );
  });
});

describe('the port', () => {
  it('dispatch(actionId, fence) accepts the stored fence and refuses a stale one', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const { intent } = await committedFlush(world);
        const fence = intent.dispatch!.fence;
        await expect(
          world.service.dispatch(intent.id, fence + 1),
        ).rejects.toMatchObject({
          name: 'DispatchFenceError',
          reason: 'fence_mismatch',
        });
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        const done = await world.service.dispatch(intent.id, fence);
        expect(done.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        // The dispatcher that went first rotated the fence; the old one is stale.
        await expect(
          world.service.dispatch(intent.id, fence),
        ).resolves.toMatchObject({ status: 'verified' });
      },
      { redis: true },
    );
  });

  it('reconcile of an uncommitted flush reports uncommitted and changes nothing', async () => {
    await withWorld(
      async (world) => {
        const s = await flushScenario(world);
        const proposed = await proposeFlush(world, s);
        const result = await reconcileIntentDetailed(world.deps, proposed.id);
        expect(result.finding).toBe('uncommitted');
        expect(result.intent.status).toBe('proposed');
      },
      { redis: true },
    );
  });
});

describe('a lost response after a real effect (gate 2 item 12)', () => {
  it('the call throws after the script ran: outcome_unknown, then reconcile reads the marker and no second effect happens', async () => {
    let lose = true;
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('outcome_unknown');
        expect(done.intent.status).toBe('outcome_unknown');
        expect(done.scriptResult).toBeNull();
        // The effect happened for real.
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^applied:/,
        );
        expect((await results(world, intent.id)).map((r) => r.outcome)).toEqual(
          ['committed', 'outcome_unknown'],
        );
        lose = false;
        await seedCache(world, 'catalog-a', ['fresh']);
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('effect_applied');
        expect(reconciled.intent.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        const rows = await results(world, intent.id);
        expect(rows.map((r) => r.outcome)).toEqual([
          'committed',
          'outcome_unknown',
          'dispatched',
          'verified',
        ]);
      },
      {
        redis: true,
        wrapRedis: (client) => ({
          get: (key) => client.get(key),
          set: (key, value, options) => client.set(key, value, options),
          async eval(script, options) {
            const reply = await client.eval(script, options);
            if (lose) throw new Error('connection reset after the script ran');
            return reply;
          },
        }),
      },
    );
  });

  it('a marker that lands between reconcile’s read and its tombstone write is honoured (the tombstone is SET NX)', async () => {
    let lose = true;
    let staleReads = 1;
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('outcome_unknown');
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^applied:/,
        );
        lose = false;
        // The first read reports "no marker" (as if it ran before the script landed).
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(staleReads).toBe(0);
        expect(reconciled.finding).toBe('effect_applied');
        expect(reconciled.intent.status).toBe('verified');
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^applied:/,
        );
      },
      {
        redis: true,
        wrapRedis: (client) => ({
          async get(key) {
            if (!lose && staleReads > 0) {
              staleReads -= 1;
              return null;
            }
            return client.get(key);
          },
          set: (key, value, options) => client.set(key, value, options),
          async eval(script, options) {
            const reply = await client.eval(script, options);
            if (lose) throw new Error('connection reset after the script ran');
            return reply;
          },
        }),
      },
    );
  });

  it('the script never answers and never ran: outcome_unknown, then reconcile fences the action and fails it; a late script call is inert', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('outcome_unknown');
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();

        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('effect_not_applied');
        expect(reconciled.intent.status).toBe('failed');
        expect(reconciled.intent.failureReason).toBe('effect_not_applied');
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^tombstone/,
        );

        // The abandoned call finally reaches Redis: the marker is there, so nothing is deleted.
        const redis = world.redis!;
        const epoch = (await redis.client.get(epochKey(redis.prefix)))!;
        const late = (await redis.client.eval(EFFECT_SCRIPT, {
          keys: [
            effectKey(redis.prefix, intent.id),
            fenceKey(redis.prefix),
            epochKey(redis.prefix),
          ],
          arguments: [
            '5',
            '1',
            `${redis.prefix}:cache:catalog-a:*`,
            '600',
            epoch,
          ],
        })) as unknown[];
        expect(late[0]).toBe('already_applied');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        expect(await redisValue(world, 'fence:cache.namespace')).toBeNull();
      },
      {
        redis: true,
        redisTimeoutMs: 150,
        wrapRedis: (client) => ({
          get: (key) => client.get(key),
          set: (key, value, options) => client.set(key, value, options),
          eval: (script, options) =>
            script === EFFECT_SCRIPT
              ? new Promise(() => {})
              : client.eval(script, options),
        }),
      },
    );
  });

  it('reconcile never concludes beyond the marker horizon', async () => {
    await withWorld(
      async (world) => {
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('outcome_unknown');
        await world.admin.query(
          `UPDATE coordinator.action_intents
              SET committed_at = clock_timestamp() - interval '10 days',
                  dispatched_at = clock_timestamp() - interval '10 days'
            WHERE id = $1`,
          [intent.id],
        );
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('unknown');
        expect(reconciled.intent.status).toBe('outcome_unknown');
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();
      },
      {
        redis: true,
        redisTimeoutMs: 100,
        wrapRedis: (client) => ({
          get: (key) => client.get(key),
          set: (key, value, options) => client.set(key, value, options),
          eval: () => new Promise(() => {}),
        }),
      },
    );
  });

  it('Redis down at dispatch: nothing was attempted, so the intent stays committed (not outcome_unknown) and no attempt is recorded', async () => {
    await withWorld(
      async (world) => {
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('unchanged');
        expect(done.intent.status).toBe('committed');
        const row = await intentRow(world, intent.id);
        expect(row.effect_attempted_at).toBeNull();
        expect(row.redis_epoch).toBeNull();
        expect(
          (await authorizations(world, intent.id)).map(
            (a) => `${a.stage}:${a.decision}`,
          ),
        ).toEqual(['admission:admitted', 'commit:committed']);
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('awaiting_dispatch');
      },
      {
        redis: true,
        wrapRedis: (): RedisEffectClient => ({
          get: () => Promise.reject(new Error('ECONNREFUSED')),
          set: () => Promise.reject(new Error('ECONNREFUSED')),
          eval: () => Promise.reject(new Error('ECONNREFUSED')),
        }),
      },
    );
  });

  it('Redis answers the epoch but the script call fails: outcome_unknown; reconcile with Redis down afterwards stays unknown', async () => {
    let down = false;
    await withWorld(
      async (world) => {
        const { intent } = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('outcome_unknown');
        down = true;
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('unknown');
        expect(reconciled.intent.status).toBe('outcome_unknown');
      },
      {
        redis: true,
        wrapRedis: (client): RedisEffectClient => ({
          get: (key) =>
            down ? Promise.reject(new Error('ECONNREFUSED')) : client.get(key),
          set: (key, value, options) =>
            down
              ? Promise.reject(new Error('ECONNREFUSED'))
              : client.set(key, value, options),
          eval: () => Promise.reject(new Error('ECONNREFUSED')),
        }),
      },
    );
  });
});

describe('the pipeline and the sweep', () => {
  it('process() drives proposed -> verified in one call', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const s = await flushScenario(world);
        const proposed = await proposeFlush(world, s);
        const done = await world.service.process(proposed.id, 'dispatcher-a');
        expect(done.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        // Redelivery of the same outbox message is harmless.
        const again = await world.service.process(proposed.id, 'dispatcher-a');
        expect(again.status).toBe('verified');
      },
      { redis: true },
    );
  });

  it('sweep recovers an admitted intent whose dispatcher died, and a committed flush nobody dispatched', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const s = await flushScenario(world);
        const proposed = await proposeFlush(world, s);
        const admitted = await world.service.admit(
          proposed.id,
          'dead-dispatcher',
        );
        expect(admitted.status).toBe('admitted');
        await expireDispatcherLease(world, proposed.id);
        const report = await world.service.sweep('sweeper', {
          settleAfterMs: 0,
        });
        expect(report.errors).toEqual([]);
        expect(report.processed).toContain(proposed.id);
        expect((await intentRow(world, proposed.id)).status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
      },
      { redis: true, dispatchLeaseMs: 1_000 },
    );
  });
});
