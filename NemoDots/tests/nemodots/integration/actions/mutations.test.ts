// NEMODOTS_MUTATION (ACCEPTANCE_CONTRACT 4.2): each mutation switches off one
// guard. For every mutation this file shows (a) the guard fires on the clean
// build and (b) the same scenario passes straight through under the mutation.
// The mutation is set through the test seam (NEMODOTS_TEST_HOOKS=1 is set by
// the harness); the cache is reset after every test so nothing leaks.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  isMutated,
  mutationLabel,
  setMutationForTests,
  type Mutation,
} from '../../../../src/server/nemodots/config/mutation.js';
import { inheritDependencies } from '../../../../src/server/nemodots/context/provenance.js';
import { FenceError } from '../../../../src/server/nemodots/coordinator/errors.js';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import { linkInheritance } from '../../../../src/server/nemodots/ledger/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  admitIntent,
  count,
  createWorld,
  emitCall,
  injectConfig,
  intentRow,
  liveConfig,
  observeMember,
  observeObserved,
  proposeFlush,
  proposeSetConfig,
  scanCount,
  seedCacheKeys,
  withEnv,
} from './harness.js';
import { effectKey } from '../../../../src/server/nemodots/actions/index.js';

afterEach(() => {
  setMutationForTests(null);
  clearHooks();
});

const KEY = 'db.pool_max';
const mutate = (name: Mutation | null) => setMutationForTests(name);

it('is inert by default: no mutation is active and the label is null', () => {
  expect(mutationLabel()).toBeNull();
  expect(isMutated('skip_freshness')).toBe(false);
});

describe('bypass_final_version_check', () => {
  async function staleCommit(
    env: Parameters<Parameters<typeof withEnv>[0]>[0],
  ) {
    const sc = await proposeSetConfig(env);
    const { fence } = await admitIntent(env, sc);
    await injectConfig(env, KEY, 11);
    await observeMember(env, sc.world, KEY, { marker: null });
    return {
      sc,
      result: await env.actions.commitDetailed(sc.intent.id, fence),
    };
  }

  it('clean: the final authority re-check blocks a commit on stale evidence; mutated: it commits over the newer value', async () => {
    await withEnv(async (env) => {
      const clean = await staleCommit(env);
      expect(clean.result.intent.status).toBe('blocked');
      expect(await liveConfig(env, KEY)).toMatchObject({
        value: 11,
        version: 2,
      });

      mutate('bypass_final_version_check');
      const world = await createWorld(env);
      const sc = await proposeSetConfig(env, {
        world,
        key: 'db.statement_timeout_ms',
        value: 4_000,
      });
      const { fence } = await admitIntent(env, sc);
      await injectConfig(env, 'db.statement_timeout_ms', 6_000);
      await observeMember(env, sc.world, 'db.statement_timeout_ms', {
        marker: null,
      });
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent.status).toBe('committed');
      // the action overwrote a newer valid value it never saw
      expect(await liveConfig(env, 'db.statement_timeout_ms')).toMatchObject({
        value: 4_000,
        version: 3,
      });
    });
  });
});

describe('drop_inherited_edges', () => {
  it('clean: the intent vector is the emitting snapshot vector plus citations; mutated: only the citations remain', async () => {
    await withEnv(async (env) => {
      const clean = await proposeSetConfig(env);
      expect(clean.intent.dependencyVector.map((e) => e.sourceKey)).toContain(
        'checkout.health',
      );
      mutate('drop_inherited_edges');
      const mutated = await proposeSetConfig(env);
      expect(mutated.intent.dependencyVector.map((e) => e.sourceKey)).toEqual([
        'checkout.config/db.pool_max',
      ]);
    });
  });

  it('clean: linkInheritance writes the inheritance edges; mutated: none', async () => {
    await withEnv(async (env) => {
      const link = (n: string) => ({
        missionId: randomUUID(),
        taskId: randomUUID(),
        attemptId: randomUUID(),
        outputId: randomUUID(),
        modelCallIds: [n === 'x' ? randomUUID() : randomUUID()],
      });
      const written = async () =>
        withTransaction(env.app, (client) =>
          linkInheritance(client, link('a')),
        );
      expect((await written()).inserted).toBeGreaterThan(0);
      mutate('drop_inherited_edges');
      expect((await written()).inserted).toBe(0);
    });
  });

  it('clean: inheritDependencies keeps every input dependency; mutated: the inputs are dropped', () => {
    const entry = (key: string) => ({
      sourceKey: key,
      sourceRevision: 1,
      receiptId: randomUUID(),
    });
    const input = [entry('checkout.health')];
    expect(
      inheritDependencies({ dependencyVector: [] }, [input as never]),
    ).toHaveLength(1);
    mutate('drop_inherited_edges');
    expect(
      inheritDependencies({ dependencyVector: [] }, [input as never]),
    ).toHaveLength(0);
  });
});

describe('ignore_fencing', () => {
  it('clean: a stale dispatch fence cannot commit; mutated: it commits', async () => {
    await withEnv(async (env) => {
      const a = await proposeSetConfig(env);
      const { fence } = await admitIntent(env, a);
      await expect(
        env.actions.commitDetailed(a.intent.id, fence + 1000),
      ).rejects.toMatchObject({ reason: 'fence_mismatch' });
      expect((await intentRow(env, a.intent.id)).status).toBe('admitted');

      mutate('ignore_fencing');
      const done = await env.actions.commitDetailed(a.intent.id, fence + 1000);
      expect(done.intent.status).toBe('committed');
      expect(await liveConfig(env, KEY)).toMatchObject({
        value: 20,
        version: 2,
      });
    });
  });

  it('clean: an expired author attempt cannot propose; mutated: it can', async () => {
    await withEnv(async (env) => {
      const world = await createWorld(env);
      const member = await observeMember(env, world, KEY);
      const health = await observeObserved(env, world, 'checkout.health', {
        status: 'ok',
      });
      const call = await emitCall(env, world, [member, health], 'call_fenced');
      await env.admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [world.attemptId],
      );
      const input = {
        action: 'set_config',
        payload: {
          key: KEY,
          value: 20,
          expectedCurrentValueDigest: digest(10),
        },
        supportingReceiptIds: [member.id],
        rationale: 'x',
      };
      await expect(
        env.actions.propose(input as never, { ...world.ctx, ...call } as never),
      ).rejects.toBeInstanceOf(FenceError);
      mutate('ignore_fencing');
      const intent = await env.actions.propose(
        input as never,
        { ...world.ctx, ...call } as never,
      );
      expect(intent.status).toBe('proposed');
    });
  });
});

describe('accept_duplicate_differing_payloads', () => {
  it('clean: a replayed tool call with another payload is blocked(idempotency_conflict); mutated: it is accepted as the stored call', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env, { toolCallId: 'call_dup' });
      const tampered = {
        action: 'set_config',
        payload: { ...sc.payload, value: 5 },
        supportingReceiptIds: [sc.member.id],
        rationale: 'tampered',
      };
      const ctx = { ...sc.world.ctx, ...sc.call } as never;
      const clean = await env.actions.propose(tampered as never, ctx);
      expect(clean).toMatchObject({
        status: 'blocked',
        blockReason: 'idempotency_conflict',
      });

      const before = await count(
        env.admin,
        'SELECT count(*) AS n FROM coordinator.action_intents',
      );
      mutate('accept_duplicate_differing_payloads');
      const accepted = await env.actions.propose(tampered as never, ctx);
      expect(accepted.id).toBe(sc.intent.id);
      expect(accepted.status).toBe('proposed');
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.action_intents',
        ),
      ).toBe(before);
    });
  });
});

describe('skip_effect_marker', () => {
  async function crashedFlush(
    env: Parameters<Parameters<typeof withEnv>[0]>[0],
  ) {
    const sc = await proposeFlush(env, { namespace: 'catalog-a' });
    await seedCacheKeys(env, 'catalog-a', 3);
    const admitted = await env.actions.admit(sc.intent.id, 'd1');
    const fence = admitted.dispatch!.fence;
    await env.actions.commitDetailed(sc.intent.id, fence);
    setHook('after_effect_before_record', () => {
      throw new Error('dispatcher crashed');
    });
    await expect(env.actions.dispatch(sc.intent.id, fence)).rejects.toThrow(
      'crashed',
    );
    clearHooks();
    await env.admin.query(
      "UPDATE coordinator.action_intents SET dispatcher_lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [sc.intent.id],
    );
    // entries written after the effect must survive a correct second dispatcher
    await seedCacheKeys(env, 'catalog-a', 4, 2);
    return { sc, fence };
  }

  it('clean: the marker makes the second dispatcher a no-op (already_applied); mutated: it flushes again and leaves no marker', async () => {
    await withEnv(async (env) => {
      const clean = await crashedFlush(env);
      const settled = await env.actions.dispatch(
        clean.sc.intent.id,
        clean.fence,
        'd2',
      );
      expect(settled.status).toBe('verified');
      expect(await scanCount(env, 'catalog-a')).toBe(4);
      expect(
        await env.redis.client.get(effectKey(env.prefix, clean.sc.intent.id)),
      ).not.toBeNull();
    });
    mutate('skip_effect_marker');
    await withEnv(async (env) => {
      const dup = await crashedFlush(env);
      await env.actions.dispatch(dup.sc.intent.id, dup.fence, 'd2');
      expect(await scanCount(env, 'catalog-a')).toBe(0); // a second, unauthorized flush
      expect(
        await env.redis.client.get(effectKey(env.prefix, dup.sc.intent.id)),
      ).toBeNull();
    });
  });
});

describe('skip_freshness', () => {
  it('clean: an aged health receipt is blocked(evidence_too_old); mutated: it is admitted', async () => {
    await withEnv(async (env) => {
      const aged = async (tool: string) => {
        const world = await createWorld(env);
        const member = await observeMember(env, world, KEY);
        const health = await observeObserved(
          env,
          world,
          'checkout.health',
          { status: 'ok' },
          { observedAt: new Date(Date.now() - 10 * 60 * 1000) },
        );
        const call = await emitCall(env, world, [member, health], tool);
        return env.actions.propose(
          {
            action: 'set_config',
            payload: {
              key: KEY,
              value: 20,
              expectedCurrentValueDigest: digest(10),
            },
            supportingReceiptIds: [member.id],
            rationale: 'x',
          } as never,
          { ...world.ctx, ...call } as never,
        );
      };
      const first = await aged('call_a');
      expect(await env.actions.admit(first.id, 'd1')).toMatchObject({
        status: 'blocked',
        blockReason: 'evidence_too_old',
      });
      mutate('skip_freshness');
      const second = await aged('call_b');
      expect((await env.actions.admit(second.id, 'd1')).status).toBe(
        'admitted',
      );
    });
  });
});
