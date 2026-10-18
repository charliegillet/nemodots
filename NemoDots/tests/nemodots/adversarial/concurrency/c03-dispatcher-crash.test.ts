// C3 (high): a dispatcher that dies after the Redis effect must not allow a
// second flush under one authorization.
// Expected (ARCHITECTURE 5.3, 14 C3): the per-action effect marker is written
// before the UNLINK loop; reconcile reads the marker back; "no second effect
// without a new authorization, no effect under an obsolete fence". A Redis
// loss between effect and acknowledgement leaves outcome_unknown, never a
// silent re-run.
import { describe, expect, it } from 'vitest';
import { SimulatedCrash, setBarrier } from '../../../../src/server/nemodots/actions/index.js';
import {
  EFFECT_SCRIPT,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  authorizations,
  latch,
  cacheKeys,
  countingRedis,
  createAttempt,
  expireDispatcherLease,
  flushScenario,
  intentStatus,
  proposeFlush,
  redisValue,
  resultOutcomes,
  seedCache,
  withWorld,
  type World,
} from './harness.js';

async function committedFlush(world: World) {
  const s = await flushScenario(world);
  const intent = await proposeFlush(world, s);
  expect(intent.status).toBe('proposed');
  return intent;
}

/** admit + commit by hand so the test controls the dispatch. */
async function commitFlush(world: World, actionId: string) {
  const admitted = await world.service.admit(actionId as never, 'dispatcher-a');
  expect(admitted.status).toBe('admitted');
  const committed = await world.service.commit(
    actionId as never,
    admitted.dispatch!.fence,
  );
  expect(committed.status).toBe('committed');
  return committed;
}

describe('C3 dispatcher crash after the effect', () => {
  it('Redis intact: the next dispatcher settles from the marker (verified); the script ran exactly once and entries written after the crash survive', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['one', 'two', 'three']);
        const intent = await committedFlush(world);
        await commitFlush(world, intent.id);

        // Dispatcher A dies right after the script returned.
        setBarrier('after_effect_before_record', () => {
          throw new SimulatedCrash('after_effect_before_record');
        });
        await expect(
          world.service.process(intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        setBarrier('after_effect_before_record', null);
        expect(counter.scripts).toBe(1);
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        // The effect marker exists; the intent never recorded the outcome.
        const marker = await redisValue(world, `effect:${intent.id}`);
        expect(marker).toMatch(/^applied:\d+:3$/);
        expect((await intentStatus(world, intent.id)).status).toBe('committed');

        // The cache refills after the crash; a second flush now would destroy it.
        await seedCache(world, 'catalog-a', ['fresh-1', 'fresh-2']);
        await expireDispatcherLease(world, intent.id);

        // Two other dispatchers race to take over.
        const settled = await Promise.allSettled([
          world.service.process(intent.id, 'dispatcher-b'),
          world.service.process(intent.id, 'dispatcher-c'),
        ]);
        for (const result of settled) expect(result.status).toBe('fulfilled');
        expect(counter.scripts).toBe(1); // THE property: no second effect
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        const final = await intentStatus(world, intent.id);
        expect(final.status).toBe('verified');
        const outcomes = await resultOutcomes(world, intent.id);
        expect(outcomes.filter((o) => o === 'verified')).toHaveLength(1);
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });

  it('Redis loses every marker, fence and the epoch after the crash (restart without persistence): no second effect, the intent stays unsettled for an operator', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['one', 'two']);
        const intent = await committedFlush(world);
        await commitFlush(world, intent.id);
        setBarrier('after_effect_before_record', () => {
          throw new SimulatedCrash('after_effect_before_record');
        });
        await expect(
          world.service.process(intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        setBarrier('after_effect_before_record', null);
        expect(counter.scripts).toBe(1);

        // Redis "restarts": all volatile state of this action is gone.
        const redis = world.redis!;
        await redis.client.del([
          `${redis.prefix}:effect:${intent.id}`,
          `${redis.prefix}:fence:cache.namespace`,
          `${redis.prefix}:epoch`,
        ]);
        await seedCache(world, 'catalog-a', ['refilled-1', 'refilled-2', 'refilled-3']);
        await expireDispatcherLease(world, intent.id);

        for (const dispatcher of ['dispatcher-b', 'dispatcher-c']) {
          await world.service.process(intent.id, dispatcher);
        }
        expect(counter.scripts).toBe(1);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(3);
        const final = await intentStatus(world, intent.id);
        // Not verified (nothing proves it), never re-run; failed(effect_not_applied)
        // would be wrong too: the script DID run.
        expect(final.status).toBe('outcome_unknown');
        expect(final.failureReason).toBeNull();
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });

  it('several dispatchers dispatch one committed flush simultaneously: exactly one script run', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a', 'b', 'c', 'd']);
        const intent = await committedFlush(world);
        await commitFlush(world, intent.id);
        const results = await Promise.allSettled(
          ['dispatcher-a', 'd2', 'd3', 'd4', 'd5'].map((who) =>
            world.service.process(intent.id, who),
          ),
        );
        for (const result of results) expect(result.status).toBe('fulfilled');
        expect(counter.scripts).toBe(1);
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        // The loser(s) are not told a second flush happened.
        expect(
          (await resultOutcomes(world, intent.id)).filter((o) => o === 'dispatched'),
        ).toHaveLength(1);
        expect((await intentStatus(world, intent.id)).status).toBe('verified');
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });

  it('a slow dispatcher whose lease lapsed between the script and its record loses to the takeover: one effect, one verified receipt, the slow one records nothing', async () => {
    const counter = { scripts: 0 };
    const gate = latch();
    const reached = latch();
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a', 'b']);
        const intent = await committedFlush(world);
        await commitFlush(world, intent.id);
        const slow = world.service.process(intent.id, 'dispatcher-a');
        await reached.promise; // the script has run; A has not recorded anything
        expect(counter.scripts).toBe(1);
        await expireDispatcherLease(world, intent.id);
        const takeover = await world.service.process(intent.id, 'dispatcher-b');
        expect(takeover.status).toBe('verified');
        await seedCache(world, 'catalog-a', ['fresh']);
        gate.open(undefined);
        const late = await slow;
        expect(late.status).toBe('verified'); // the stored truth, not a second attempt
        expect(counter.scripts).toBe(1);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        const outcomes = await resultOutcomes(world, intent.id);
        expect(outcomes.filter((o) => o === 'verified')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'dispatched').length).toBeLessThanOrEqual(1);
      },
      {
        redis: true,
        wrapRedis: (client) => ({
          ...countingRedis(counter)(client),
          async eval(script, options) {
            const reply = await client.eval(script, options);
            if (script === EFFECT_SCRIPT) {
              counter.scripts += 1;
              reached.open(undefined);
              await gate.promise;
            }
            return reply;
          },
        }),
      },
    );
  });

  it('a second flush intent of the same namespace gets its own authorization: two intents, two effects, each exactly once', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['x']);
        const first = await committedFlush(world);
        await commitFlush(world, first.id);
        await world.service.process(first.id, 'dispatcher-a');
        await seedCache(world, 'catalog-a', ['y']);
        const attempt = await createAttempt(world, { role: 'cache_specialist' });
        const s2 = await flushScenario(world, { attempt });
        const second = await proposeFlush(world, s2);
        await world.service.process(second.id, 'dispatcher-a');
        expect(counter.scripts).toBe(2);
        expect((await intentStatus(world, second.id)).status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        void authorizations;
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });
});
