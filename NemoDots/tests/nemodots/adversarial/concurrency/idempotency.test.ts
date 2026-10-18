// W5.2: idempotency binding of proposals (CONTRACTS 5 / finding C5, BUILD_PROMPT
// "Bind idempotency keys to payload hash; reuse with different payload fails;
// duplicate delivery recovers the original result").
import { describe, expect, it } from 'vitest';
import {
  digest,
  type ActionIntent,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  count,
  createWorld,
  emitCall,
  injectConfig,
  liveConfig,
  observeMember,
  observeObserved,
  proposeSetConfig,
  setConfigInput,
  settle,
  withEnv,
  type Env,
  type World,
} from './harness.js';

const LIVE = [
  'proposed',
  'admitted',
  'committed',
  'dispatched',
  'outcome_unknown',
];

async function liveIntentsOfToolCall(
  env: Env,
  world: World,
  toolCallId: string,
) {
  return count(
    env.admin,
    `SELECT count(*) AS n FROM coordinator.action_intents
      WHERE mission_id = $1 AND tool_call_id = $2 AND status = ANY($3::text[])`,
    [world.missionId, toolCallId, LIVE],
  );
}

describe('idempotency', () => {
  it('cleared: replayed tool call id, tampered value on the same target -> idempotency_conflict', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env, { value: 20 });
      const tampered = {
        ...sc.input,
        payload: { ...sc.input.payload, value: 15 },
      };
      const replay = await env.actions.propose(
        tampered as never,
        { ...sc.world.ctx, ...sc.call } as never,
      );
      expect(replay.status).toBe('blocked');
      expect(replay.blockReason).toBe('idempotency_conflict');
      expect(
        await liveIntentsOfToolCall(env, sc.world, sc.call.toolCallId),
      ).toBe(1);
    }));

  // ADM-06c ruling: the value domain is checked before idempotency, so an
  // out-of-domain replay is rejected outright and stores nothing.
  it('cleared: replayed tool call id with an out-of-domain value -> payload_invalid, nothing stored', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env, { value: 20 });
      const tampered = {
        ...sc.input,
        payload: { ...sc.input.payload, value: 50 }, // db.pool_max domain is 1..20
      };
      const replay = await settle(
        env.actions.propose(
          tampered as never,
          { ...sc.world.ctx, ...sc.call } as never,
        ),
      );
      expect(replay.ok).toBe(false);
      expect(!replay.ok && (replay.error as { reason?: string }).reason).toBe(
        'payload_invalid',
      );
      expect(
        await count(
          env.admin,
          'SELECT count(*) AS n FROM coordinator.action_intents WHERE tool_call_id = $1',
          [sc.call.toolCallId],
        ),
      ).toBe(1);
    }));

  it('cleared: duplicate delivery of the identical proposal returns the stored intent', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const [a, b] = await Promise.all([
        env.actions.propose(
          sc.input as never,
          { ...sc.world.ctx, ...sc.call } as never,
        ),
        env.actions.propose(
          sc.input as never,
          { ...sc.world.ctx, ...sc.call } as never,
        ),
      ]);
      expect(a.id).toBe(sc.intent.id);
      expect(b.id).toBe(sc.intent.id);
      expect(
        await liveIntentsOfToolCall(env, sc.world, sc.call.toolCallId),
      ).toBe(1);
    }));

  it('cleared: a new tool call re-proposing the payload after a block is a fresh intent', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const member = await observeMember(env, world, 'db.pool_max');
      const health = (
        await observeObserved(env, world, 'checkout.health', { status: 'ok' })
      ).receipt;
      const current = (await liveConfig(env, 'db.pool_max'))!.value;
      // first call cites a receipt outside its scope: blocked at proposal
      const bad = setConfigInput('db.pool_max', 20, current, [
        '00000000-0000-4000-8000-000000000000',
      ]);
      const first = await emitCall(env, world, [member, health], {
        argumentsDigest: digest(bad),
      });
      const blocked = await env.actions.propose(
        bad as never,
        { ...world.ctx, ...first } as never,
      );
      expect(blocked.blockReason).toBe('citation_out_of_scope');
      // a new model call / tool call re-proposes with a valid citation
      const good = setConfigInput('db.pool_max', 20, current, [member.id]);
      const second = await emitCall(env, world, [member, health], {
        argumentsDigest: digest(good),
      });
      const again = await env.actions.propose(
        good as never,
        { ...world.ctx, ...second } as never,
      );
      expect(again.id).not.toBe(blocked.id);
      expect(again.status).toBe('proposed');
    }));

  // C-01 (medium): REPRODUCED on the first run (2026-10-18 05:50), then fixed
  // in the working tree (propose.ts, 05:52: the idempotency lookup now also
  // matches attempt_id + tool_call_id). The key is
  // sha256(mission, task, attempt, action, expectedTargetVersion, toolCallId)
  // (policy.ts idempotencyKeyOf) and expectedTargetVersion is derived from the
  // payload's own target, so a replay of one tool call id whose tampered
  // payload named another target at another version, or another action, got a
  // different key, found no prior row and was stored as a second LIVE intent.
  // Kept as the regression tests: one tool call yields at most one live
  // intent; the replay is blocked(idempotency_conflict).
  describe('C-01 regression: one tool call id, tampered payload naming another target', () => {
    async function twoTargets(env: Env) {
      const world = await createWorld(env);
      // move the second key to version 2 so the two targets' versions differ
      await injectConfig(env, 'db.statement_timeout_ms', 6_000);
      const pool = await observeMember(env, world, 'db.pool_max');
      const timeout = await observeMember(
        env,
        world,
        'db.statement_timeout_ms',
      );
      const ns = await observeMember(env, world, 'cache.namespace');
      const health = (
        await observeObserved(env, world, 'checkout.health', { status: 'ok' })
      ).receipt;
      const stats = (
        await observeObserved(env, world, 'redis.stats', {
          namespaces: { 'catalog-a:v1': 3 },
        })
      ).receipt;
      expect(pool.sourceRevision).not.toBe(timeout.sourceRevision);
      const original = setConfigInput(
        'db.pool_max',
        20,
        (await liveConfig(env, 'db.pool_max'))!.value,
        [pool.id],
      );
      const call = await emitCall(
        env,
        world,
        [pool, timeout, ns, health, stats],
        {
          argumentsDigest: digest(original),
        },
      );
      const first = await env.actions.propose(
        original as never,
        { ...world.ctx, ...call } as never,
      );
      expect(first.status).toBe('proposed');
      return { world, call, timeout, ns, first };
    }

    it('C-01a regression: set_config replayed against another key', () =>
      withEnv(async (env) => {
        const { world, call, timeout } = await twoTargets(env);
        const tampered = setConfigInput(
          'db.statement_timeout_ms',
          4_000,
          (await liveConfig(env, 'db.statement_timeout_ms'))!.value,
          [timeout.id],
        );
        const replay: ActionIntent = await env.actions.propose(
          tampered as never,
          { ...world.ctx, ...call } as never,
        );
        expect(replay.blockReason).toBe('idempotency_conflict');
        expect(await liveIntentsOfToolCall(env, world, call.toolCallId)).toBe(
          1,
        );
      }));

    it('C-01b regression: the same tool call id replayed as another action', () =>
      withEnv(async (env) => {
        const { world, call, ns } = await twoTargets(env);
        const flush = {
          action: 'flush_cache_namespace',
          payload: { namespace: 'catalog-a', reason: 'tampered replay' },
          supportingReceiptIds: [ns.id],
          rationale: 'adversarial reproduction',
        };
        const replay: ActionIntent = await env.actions.propose(
          flush as never,
          { ...world.ctx, ...call } as never,
        );
        expect(replay.blockReason).toBe('idempotency_conflict');
        expect(await liveIntentsOfToolCall(env, world, call.toolCallId)).toBe(
          1,
        );
      }));
  });
});
