// Regression tests for the round-1 review findings of the action boundary:
//
//   idempotency is bound to the TOOL CALL, not to a key that includes the
//   action and the target (a replay that changes either must conflict);
//   a toolCallId the emitting model call never produced is refused;
//   a second dispatcher cannot claim while another's lease is live;
//   an effect that may have been attempted is NEVER run a second time, even
//   when Redis lost its marker (the attempt is recorded in PostgreSQL before
//   the script runs, and the Redis epoch tells a restart from an absent marker);
//   reconcile never overrides durable evidence that the effect was applied.
import { describe, expect, it } from 'vitest';
import {
  EFFECT_SCRIPT,
  InvalidProposalError,
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
  admitAndCommit,
  authorizations,
  cacheKeys,
  configState,
  countRows,
  createAttempt,
  emitModelCall,
  expireDispatcherLease,
  externalChange,
  flushInput,
  flushScenario,
  intentRow,
  memberReceipt,
  observed,
  proposeFlush,
  redisValue,
  results,
  seedCache,
  setConfigInput,
  sleep,
  withWorld,
  type World,
} from './harness.js';

async function committedFlush(world: World) {
  const s = await flushScenario(world);
  const proposed = await proposeFlush(world, s);
  expect(proposed.status).toBe('proposed');
  const { committed } = await admitAndCommit(world, proposed.id);
  expect(committed.status).toBe('committed');
  return committed;
}

/** What a restart of the stack's Redis (--save '' --appendonly no) does. */
async function restartRedis(world: World) {
  const r = world.redis!;
  const keys: string[] = [];
  for await (const batch of r.client.scanIterator({
    MATCH: `${r.prefix}:*`,
    COUNT: 200,
  }))
    keys.push(...batch);
  const doomed = keys.filter(
    (key) =>
      key.startsWith(`${r.prefix}:effect:`) ||
      key.endsWith(':epoch') ||
      key.includes(':fence:'),
  );
  if (doomed.length > 0) await r.client.del(doomed);
}

/** A client that counts the scripts which actually reach Redis. */
function counting(counter: { evals: number }) {
  return (client: RedisEffectClient): RedisEffectClient => ({
    get: (key) => client.get(key),
    set: (key, value, options) => client.set(key, value, options),
    eval(script, options) {
      // Only the effect script counts: tombstone writes are not effects.
      if (script === EFFECT_SCRIPT) counter.evals += 1;
      return client.eval(script, options);
    },
  });
}

const dispatchAuthorizations = async (world: World, actionId: string) =>
  (await authorizations(world, actionId)).filter(
    (a) => a.stage === 'dispatch' && a.decision === 'dispatched',
  );

describe('idempotency is bound to the tool call (C5)', () => {
  it('one tool call id used for a flush and then for a set_config: the second is blocked(idempotency_conflict) and never commits', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const attempt = await createAttempt(world, {
          role: 'cache_specialist',
        });
        const ns = await memberReceipt(world, 'cache.namespace');
        const pool = await memberReceipt(world, 'db.pool_max');
        const stats = await observed(world, 'redis.stats', {
          activeNamespace: 'catalog-a',
        });
        const health = await observed(world, 'checkout.health', {
          status: 'degraded',
        });
        const { modelCallId, toolCallId } = await emitModelCall(
          world,
          attempt,
          [ns, pool, stats, health],
        );
        const ctx = { ...attempt.context, modelCallId, toolCallId } as never;
        const flush = await world.service.propose(flushInput('catalog-a'), ctx);
        const tampered = await world.service.propose(
          setConfigInput(world, await configState(world, 'db.pool_max'), {
            value: 20,
          }),
          ctx,
        );
        expect(flush.status).toBe('proposed');
        expect(tampered.status).toBe('blocked');
        expect(tampered.blockReason).toBe('idempotency_conflict');
        const [auth] = await authorizations(world, tampered.id);
        expect(auth.idempotency_binding).toBe('conflict');
        const done = await admitAndCommit(world, tampered.id);
        expect(done.committed.status).toBe('blocked');
        // Version, value and rows: db.pool_max was never touched.
        expect(await configState(world, 'db.pool_max')).toMatchObject({
          value: 10,
          version: 1,
          causedBy: null,
        });
        expect(
          await countRows(
            world,
            'coordinator.action_intents',
            "attempt_id = $1 AND status IN ('proposed','admitted','committed','dispatched','verified','outcome_unknown')",
            [attempt.attemptId],
          ),
        ).toBe(1);
        // The original is unaffected, and an exact replay returns it.
        expect(
          (await world.service.propose(flushInput('catalog-a'), ctx)).id,
        ).toBe(flush.id);
      },
      { redis: true },
    );
  });

  it('one tool call id replayed against another target key (another version) is blocked(idempotency_conflict)', async () => {
    await withWorld(async (world) => {
      await externalChange(world, 'db.statement_timeout_ms', 6000); // version 2
      const attempt = await createAttempt(world);
      const pool = await memberReceipt(world, 'db.pool_max');
      const timeout = await memberReceipt(world, 'db.statement_timeout_ms');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const { modelCallId, toolCallId } = await emitModelCall(world, attempt, [
        pool,
        timeout,
        health,
      ]);
      const ctx = { ...attempt.context, modelCallId, toolCallId } as never;
      const first = await world.service.propose(
        setConfigInput(world, await configState(world, 'db.pool_max'), {
          key: 'db.pool_max',
          value: 20,
        }),
        ctx,
      );
      const replay = await world.service.propose(
        setConfigInput(
          world,
          await configState(world, 'db.statement_timeout_ms'),
          { key: 'db.statement_timeout_ms', value: 100 },
        ),
        ctx,
      );
      expect(first.status).toBe('proposed');
      expect(replay.status).toBe('blocked');
      expect(replay.blockReason).toBe('idempotency_conflict');
      const done = await admitAndCommit(world, replay.id);
      expect(done.committed.status).toBe('blocked');
      expect(await configState(world, 'db.statement_timeout_ms')).toMatchObject(
        {
          value: 6000,
          version: 2,
          actor: 'injector',
          causedBy: null,
        },
      );
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 10,
        version: 1,
      });
    });
  });

  it('the database refuses a second live intent for one (attempt, tool call) even when the key differs', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const pool = await memberReceipt(world, 'db.pool_max');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const { modelCallId, toolCallId } = await emitModelCall(world, attempt, [
        pool,
        health,
      ]);
      const first = await world.service.propose(
        setConfigInput(world, await configState(world, 'db.pool_max'), {
          value: 20,
        }),
        { ...attempt.context, modelCallId, toolCallId } as never,
      );
      const client = await world.admin.connect();
      try {
        await client.query(
          'CREATE TEMP TABLE dup AS SELECT * FROM coordinator.action_intents WHERE id = $1',
          [first.id],
        );
        await client.query(
          `UPDATE dup SET id = gen_random_uuid(), idempotency_key = repeat('a', 64)`,
        );
        await expect(
          client.query(
            'INSERT INTO coordinator.action_intents SELECT * FROM dup',
          ),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        client.release();
      }
      expect(await countRows(world, 'coordinator.action_intents')).toBe(1);
    });
  });

  it('a tool call id the emitting model call never produced is refused and writes nothing', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const pool = await memberReceipt(world, 'db.pool_max');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const { modelCallId, toolCallId } = await emitModelCall(world, attempt, [
        pool,
        health,
      ]);
      const input = setConfigInput(
        world,
        await configState(world, 'db.pool_max'),
        {
          value: 20,
        },
      );
      const before = {
        intents: await countRows(world, 'coordinator.action_intents'),
        outbox: await countRows(world, 'coordinator.outbox'),
        events: await countRows(world, 'coordinator.events'),
      };
      await expect(
        world.service.propose(input, {
          ...attempt.context,
          modelCallId,
          toolCallId: 'call_never_emitted',
        } as never),
      ).rejects.toBeInstanceOf(InvalidProposalError);
      expect({
        intents: await countRows(world, 'coordinator.action_intents'),
        outbox: await countRows(world, 'coordinator.outbox'),
        events: await countRows(world, 'coordinator.events'),
      }).toEqual(before);
      // The id the model did emit works, and a regenerated id still does not.
      const real = await world.service.propose(input, {
        ...attempt.context,
        modelCallId,
        toolCallId,
      } as never);
      expect(real.status).toBe('proposed');
      await expect(
        world.service.propose(input, {
          ...attempt.context,
          modelCallId,
          toolCallId: `${toolCallId}-retry`,
        } as never),
      ).rejects.toBeInstanceOf(InvalidProposalError);
      expect(await countRows(world, 'coordinator.action_intents')).toBe(1);
    });
  });
});

describe('dispatch leases (ARCHITECTURE section 6)', () => {
  it('a second dispatcher cannot claim while the first one’s lease is live: one dispatch Authorization, the first dispatcher’s facts are recorded', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const intent = await committedFlush(world);
        let release!: () => void;
        const parked = new Promise<void>((resolve) => (release = resolve));
        let reached = false;
        setBarrier('after_effect_before_record', async (ctx) => {
          if (ctx.stage !== 'dispatch' || reached) return;
          reached = true;
          await parked;
        });
        const first = dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        while (!reached) await sleep(10);
        const live = await intentRow(world, intent.id);
        expect(
          new Date(live.dispatcher_lease_expires_at as string).getTime(),
        ).toBeGreaterThan(Date.now());

        const other = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(other.disposition).toBe('unchanged');
        expect(other.intent.status).toBe('committed');
        const same = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(same.disposition).toBe('unchanged');
        expect(await dispatchAuthorizations(world, intent.id)).toHaveLength(1);

        release();
        const done = await first;
        expect(done.disposition).toBe('verified');
        expect(done.scriptResult).toBe('applied');
        expect(done.deletedCount).toBe(2);
        expect(await dispatchAuthorizations(world, intent.id)).toHaveLength(1);
        const rows = await results(world, intent.id);
        expect(rows.map((r) => r.outcome)).toEqual([
          'committed',
          'dispatched',
          'verified',
        ]);
        expect(rows[1].external_effect).toMatchObject({
          scriptResult: 'applied',
          deletedCount: 2,
        });
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        expect((await intentRow(world, intent.id)).status).toBe('verified');
      },
      { redis: true, dispatchLeaseMs: 60_000 },
    );
  });

  it('a dispatcher whose lease lapsed during the script cannot record; the work is settled from the marker without a second effect', async () => {
    const counter = { evals: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const intent = await committedFlush(world);
        setBarrier('after_effect_before_record', async (ctx) => {
          if (ctx.stage === 'dispatch')
            await expireDispatcherLease(world, intent.id);
        });
        const late = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        setBarrier('after_effect_before_record', null);
        // Its lease was gone: nothing was recorded under it.
        expect(late.disposition).toBe('unchanged');
        expect((await intentRow(world, intent.id)).status).toBe('committed');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        await seedCache(world, 'catalog-a', ['fresh']);

        const settled = await world.service.process(intent.id, 'dispatcher-b');
        expect(settled.status).toBe('verified');
        expect(counter.evals).toBe(1);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        expect(await dispatchAuthorizations(world, intent.id)).toHaveLength(1);
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
      { redis: true, wrapRedis: counting(counter) },
    );
  });

  it('a different dispatcher cannot dispatch a committed flush while the admitting dispatcher’s lease is live', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const intent = await committedFlush(world); // dispatcher-a
        const other = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(other.disposition).toBe('unchanged');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
        await expireDispatcherLease(world, intent.id);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(done.intent.status).toBe('verified');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
      },
      { redis: true },
    );
  });
});

describe('no second effect without a new authorization (C3)', () => {
  it('crash after the effect, Redis restarts (marker, fence, epoch gone), the cache refills: the flush is NOT run again', async () => {
    const counter = { evals: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const intent = await committedFlush(world);
        setBarrier('after_effect_before_record', (ctx) => {
          if (ctx.stage === 'dispatch')
            throw new SimulatedCrash('after_effect_before_record');
        });
        await expect(
          dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        setBarrier('after_effect_before_record', null);
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        expect(counter.evals).toBe(1);

        await restartRedis(world);
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();
        await seedCache(world, 'catalog-a', ['fresh1', 'fresh2', 'fresh3']);
        await expireDispatcherLease(world, intent.id);

        const second = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-b',
        );
        expect(second.disposition).toBe('outcome_unknown');
        expect(second.scriptResult).toBeNull();
        expect(second.intent.status).toBe('outcome_unknown');
        const piped = await world.service.process(intent.id, 'dispatcher-b');
        expect(piped.status).toBe('outcome_unknown');
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        // Absence of the marker after a restart is not proof of anything.
        expect(reconciled.finding).toBe('epoch_changed');
        expect(reconciled.intent.status).toBe('outcome_unknown');
        expect(reconciled.intent.failureReason).toBeNull();

        expect(counter.evals).toBe(1); // zero additional scripts, zero additional UNLINKs
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(3);
        expect(await dispatchAuthorizations(world, intent.id)).toHaveLength(1);
        expect((await results(world, intent.id)).map((r) => r.outcome)).toEqual(
          ['committed', 'outcome_unknown'],
        );
      },
      { redis: true, wrapRedis: counting(counter) },
    );
  });

  it('crash after the effect, Redis unchanged: the next dispatcher settles from the marker (verified, deleted count from the marker), no additional script', async () => {
    const counter = { evals: 0 };
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const intent = await committedFlush(world);
        setBarrier('after_effect_before_record', (ctx) => {
          if (ctx.stage === 'dispatch')
            throw new SimulatedCrash('after_effect_before_record');
        });
        await expect(
          dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        setBarrier('after_effect_before_record', null);
        await seedCache(world, 'catalog-a', ['fresh']);
        await expireDispatcherLease(world, intent.id);
        const settled = await world.service.process(intent.id, 'dispatcher-b');
        expect(settled.status).toBe('verified');
        expect(counter.evals).toBe(1);
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(1);
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
      { redis: true, wrapRedis: counting(counter) },
    );
  });

  it('crash between the claim and the script (nothing ran), Redis unchanged: reconcile fences the action and fails it; the namespace is untouched', async () => {
    const counter = { evals: 0 };
    let crash = true;
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const intent = await committedFlush(world);
        await expect(
          dispatchIntentDetailed(world.deps, intent.id, 'dispatcher-a'),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        crash = false;
        expect(counter.evals).toBe(0);
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();
        await expireDispatcherLease(world, intent.id);
        const settled = await world.service.process(intent.id, 'dispatcher-b');
        expect(settled.status).toBe('failed');
        expect(settled.failureReason).toBe('effect_not_applied');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        expect(counter.evals).toBe(0);
        expect(await redisValue(world, `effect:${intent.id}`)).toMatch(
          /^tombstone/,
        );
        // A late script call (an abandoned request) is inert.
        const r = world.redis!;
        const lateReply = (await r.client.eval(EFFECT_SCRIPT, {
          keys: [
            effectKey(r.prefix, intent.id),
            fenceKey(r.prefix),
            epochKey(r.prefix),
          ],
          arguments: ['9', '1', `${r.prefix}:cache:catalog-a:*`, '600', 'x'],
        })) as unknown[];
        expect(lateReply[0]).not.toBe('applied');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
      },
      {
        redis: true,
        wrapRedis: (client) => {
          const counted = counting(counter)(client);
          return {
            get: counted.get,
            set: counted.set,
            eval(script, options) {
              if (crash) throw new SimulatedCrash('after_effect_before_record');
              return counted.eval(script, options);
            },
          };
        },
      },
    );
  });

  it('Redis restarts between the claim and the script: the script refuses (epoch changed), nothing is deleted, the intent fails(effect_not_applied)', async () => {
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2']);
        const intent = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('failed');
        expect(done.intent.failureReason).toBe('effect_not_applied');
        expect(await cacheKeys(world, 'catalog-a')).toHaveLength(2);
        // The refusal leaves a tombstone, so a replay of this call is inert too.
        expect(await redisValue(world, `effect:${intent.id}`)).toBe(
          'tombstone:epoch_changed',
        );
        expect(await dispatchAuthorizations(world, intent.id)).toHaveLength(1);
      },
      {
        redis: true,
        wrapRedis: (client) => ({
          get: (key) => client.get(key),
          set: (key, value, options) => client.set(key, value, options),
          async eval(script, options) {
            // The restart: everything volatile is gone before the script lands.
            await client.eval("redis.call('DEL', KEYS[1]) return 1", {
              keys: [options.keys[2]],
              arguments: [],
            });
            return client.eval(script, options);
          },
        }),
      },
    );
  });
});

describe('reconcile never overrides durable evidence that the effect was applied', () => {
  it('the read-back failed (outcome_unknown with scriptResult applied), then the marker is lost in a restart: verified from the stored receipt, never effect_not_applied', async () => {
    let failGet = true;
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1', 'p2', 'p3']);
        const intent = await committedFlush(world);
        const first = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(first.disposition).toBe('outcome_unknown');
        expect(first.scriptResult).toBe('applied');
        expect(await cacheKeys(world, 'catalog-a')).toEqual([]);
        failGet = false;
        await restartRedis(world);
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();

        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('effect_applied');
        expect(reconciled.intent.status).toBe('verified');
        expect(reconciled.intent.failureReason).toBeNull();
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();
        const rows = await results(world, intent.id);
        expect(rows.map((r) => r.outcome)).toEqual([
          'committed',
          'dispatched',
          'outcome_unknown',
          'verified',
        ]);
        expect(rows[3].external_effect).toMatchObject({
          scriptResult: 'applied',
          deletedCount: 3,
          markerPresent: false,
        });
      },
      {
        redis: true,
        wrapRedis: (client) => ({
          async get(key) {
            if (failGet && key.includes(':effect:'))
              throw new Error('connection reset');
            return client.get(key);
          },
          set: (key, value, options) => client.set(key, value, options),
          eval: (script, options) => client.eval(script, options),
        }),
      },
    );
  });

  it('a dispatched-and-unknown flush whose epoch changed and that has no applied evidence stays outcome_unknown (not failed)', async () => {
    let lose = true;
    await withWorld(
      async (world) => {
        await seedCache(world, 'catalog-a', ['p1']);
        const intent = await committedFlush(world);
        const done = await dispatchIntentDetailed(
          world.deps,
          intent.id,
          'dispatcher-a',
        );
        expect(done.disposition).toBe('outcome_unknown');
        lose = false;
        await restartRedis(world);
        const reconciled = await reconcileIntentDetailed(world.deps, intent.id);
        expect(reconciled.finding).toBe('epoch_changed');
        expect(reconciled.intent.status).toBe('outcome_unknown');
        expect(await redisValue(world, `effect:${intent.id}`)).toBeNull();
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
});
