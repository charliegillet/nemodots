// C11 (medium): the Redis fence never reflected PostgreSQL version advances.
// Expected (ARCHITECTURE 5.3, 14 C11): claimDispatch is a compare-and-set on
// checkout.config_entries['cache.namespace'].version equal to the version the
// flush was committed at; a moved authority fails the intent
// (failed(dispatch_fence_invalid)) and NO script runs. Residual window: the
// authority may move between the claim's commit and the script (freshness-at-
// dispatch is evaluated once, at the claim); that window is asserted here as
// the documented limit, not as a defence.
import { describe, expect, it } from 'vitest';
import { EFFECT_SCRIPT } from '../../../../src/server/nemodots/actions/index.js';
import {
  authorizations,
  cacheKeys,
  countingRedis,
  externalChange,
  flushScenario,
  intentStatus,
  latch,
  park,
  proposeFlush,
  seedCache,
  withWorld,
  type World,
} from './harness.js';

async function committed(world: World) {
  const s = await flushScenario(world);
  const intent = await proposeFlush(world, s);
  const admitted = await world.service.admit(intent.id, 'dispatcher-a');
  await world.service.commit(intent.id, admitted.dispatch!.fence);
  return intent;
}

describe('C11 flush after the namespace authority advanced', () => {
  it('advance before dispatch: failed(dispatch_fence_invalid), the script never runs, the cache survives', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a', 'b']);
        const intent = await committed(world);
        await externalChange(world, 'cache.namespace', 'catalog-b');
        const result = await world.service.process(intent.id, 'dispatcher-a');
        expect(result.status).toBe('failed');
        expect((await intentStatus(world, intent.id)).failureReason).toBe(
          'dispatch_fence_invalid',
        );
        expect(counter.scripts).toBe(0);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        const authz = await authorizations(world, intent.id);
        expect(authz.at(-1)).toMatchObject({
          stage: 'dispatch',
          decision: 'blocked',
        });
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });

  it('advance parked between the commit and the dispatch (after_commit_before_dispatch): refused', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a']);
        const s = await flushScenario(world);
        const intent = await proposeFlush(world, s);
        const parked = park('after_commit_before_dispatch');
        const run = world.service.process(intent.id, 'dispatcher-a');
        await parked.arrived;
        expect((await intentStatus(world, intent.id)).status).toBe('committed');
        await externalChange(world, 'cache.namespace', 'catalog-c');
        parked.release();
        const result = await run;
        expect(result.status).toBe('failed');
        expect(counter.scripts).toBe(0);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });

  it('advance raced against the claim transaction itself (parked before its first lock): refused', async () => {
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a']);
        const intent = await committed(world);
        const parked = park('before_lock', (c) => c.stage === 'dispatch');
        const run = world.service.process(intent.id, 'dispatcher-a');
        await parked.arrived;
        await externalChange(world, 'cache.namespace', 'catalog-d');
        parked.release();
        const result = await run;
        expect(result.status).toBe('failed');
        expect(counter.scripts).toBe(0);
      },
      { redis: true, wrapRedis: countingRedis(counter) },
    );
  });

  it('RESIDUAL WINDOW: an advance after the claim committed but before the script runs is NOT detected (freshness-at-dispatch is checked once, at the claim)', async () => {
    const gate = latch();
    const reached = latch();
    const counter = { scripts: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['a', 'b']);
        const intent = await committed(world);
        const run = world.service.process(intent.id, 'dispatcher-a');
        await reached.promise; // claim committed, script not yet sent
        await externalChange(world, 'cache.namespace', 'catalog-e');
        gate.open(undefined);
        const result = await run;
        // The documented limit: the flush of the OLD namespace still ran.
        expect(counter.scripts).toBe(1);
        expect(result.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
      },
      {
        redis: true,
        wrapRedis: (client) => ({
          ...countingRedis(counter)(client),
          async eval(script, options) {
            if (script === EFFECT_SCRIPT) {
              reached.open(undefined);
              await gate.promise;
              counter.scripts += 1;
            }
            return client.eval(script, options);
          },
        }),
      },
    );
  });
});
