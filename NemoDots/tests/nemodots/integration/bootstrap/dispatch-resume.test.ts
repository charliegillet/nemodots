// A paused mission's committed flush is deferred, not failed (actions
// semantics). The composition must dispatch it after resume, exactly once:
// commit -> pause -> (nothing dispatched while paused) -> resume -> one
// dispatch -> verified. A cancel settles it as not run. The Redis effect is
// real; the mission and intent come from the actions suite's own fixtures.
import { afterEach, expect, it } from 'vitest';
import { createNemoDots } from '../../../../src/server/nemodots/bootstrap.js';
import {
  admitIntent,
  authorizations,
  createWorld,
  intentRow,
  proposeFlush,
  receiptsOf,
  scanCount,
  seedCacheKeys,
  sleep,
  withEnv,
  type Env,
} from '../actions/harness.js';

const NS = 'catalog-a';
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function until<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

async function scenario(env: Env) {
  const world = await createWorld(env);
  // createWorld stores empty budgets/provider; the routes validate a full Mission.
  await env.admin.query(
    `UPDATE coordinator.missions SET budgets = $2::jsonb, provider = $3::jsonb WHERE id = $1`,
    [
      world.missionId,
      JSON.stringify({
        maxTasks: 24,
        maxDepth: 3,
        maxBreadth: 4,
        maxTokens: 200000,
        maxInferenceCalls: 200,
        maxWallClockMs: 600000,
      }),
      JSON.stringify({
        host: 'fixture.invalid',
        plannerModel: 'fixture',
        workerModel: 'fixture',
      }),
    ],
  );
  const sc = await proposeFlush(env, { world, namespace: NS });
  await seedCacheKeys(env, NS, 3);
  const { fence } = await admitIntent(env, { intent: sc.intent } as never);
  const nemodots = createNemoDots(
    {
      NEMODOTS_INSTANCE: 'dev',
      NEMODOTS_PG_URL_APP: env.db.urls.app,
      NEMODOTS_PG_URL_VERIFIER: env.db.urls.verifier,
      NEMODOTS_PG_URL_INJECTOR: env.db.urls.injector,
      NEMODOTS_PROBE_SECRET: 'probe-secret-for-bootstrap-test-0123',
      NEMODOTS_REDIS_URL: env.redis.url,
      NEMODOTS_REDIS_PREFIX: env.prefix,
      NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:4599',
      NEMODOTS_INFERENCE_MODE: 'blocked',
      NEMODOTS_WATCH_INTERVAL_MS: '60000',
      NEMODOTS_WORKERS: '0',
    },
    { workspace: { ownerId: world.ownerId } },
  );
  closers.push(() => nemodots.stop());
  const post = (path: string) =>
    Promise.resolve(
      nemodots.router.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ).then((r) => r.json() as Promise<Json>);
  return { world, sc, fence, nemodots, post };
}

const dispatchStage = async (env: Env, id: string) =>
  (await authorizations(env, id)).filter((a) => a.stage === 'dispatch');

it('commit, pause, resume: the deferred flush is dispatched exactly once', async () => {
  await withEnv(async (env) => {
    const { world, sc, fence, nemodots, post } = await scenario(env);
    // committed first (the desired state is recorded), then the mission pauses
    const committed = await env.actions.commitDetailed(sc.intent.id, fence);
    expect(committed.intent.status).toBe('committed');
    expect((await post(`/missions/${world.missionId}/pause`)).status).toBe(
      'paused',
    );

    await nemodots.start();
    // The sweep runs while the mission is paused: nothing is dispatched.
    await sleep(2_500);
    expect(env.effectRedis.evalCalls).toBe(0);
    expect(await scanCount(env, NS)).toBe(3);
    expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
    expect(await dispatchStage(env, sc.intent.id)).toEqual([]);

    expect((await post(`/missions/${world.missionId}/resume`)).status).toBe(
      'running',
    );
    await until('the flush to be verified', async () => {
      const row = await intentRow(env, sc.intent.id);
      return row.status === 'verified' ? row : null;
    });
    expect(await scanCount(env, NS)).toBe(0);
    expect(env.effectRedis.evalCalls).toBe(0); // the bootstrap's own client did it
    expect(await dispatchStage(env, sc.intent.id)).toHaveLength(1);
    expect(await receiptsOf(env, sc.intent.id)).toHaveLength(1);

    // further sweeps do not dispatch it again
    await sleep(2_000);
    expect(await dispatchStage(env, sc.intent.id)).toHaveLength(1);
    expect(await receiptsOf(env, sc.intent.id)).toHaveLength(1);
  });
}, 60_000);

it('cancel instead of resume: the committed flush ends as not run and Redis is untouched', async () => {
  await withEnv(async (env) => {
    const { world, sc, fence, nemodots, post } = await scenario(env);
    await env.actions.commitDetailed(sc.intent.id, fence);
    await post(`/missions/${world.missionId}/pause`);
    await nemodots.start();
    expect((await post(`/missions/${world.missionId}/cancel`)).status).toBe(
      'cancelled',
    );
    const row = await until('the flush to be settled', async () => {
      const current = await intentRow(env, sc.intent.id);
      return current.status === 'committed' ? null : current;
    });
    expect(row.status).toBe('failed');
    expect(await scanCount(env, NS)).toBe(3);
    // the only dispatch-stage record is the refusal; no effect was authorized
    expect(await dispatchStage(env, sc.intent.id)).toEqual([
      expect.objectContaining({
        decision: 'blocked',
        block_reason: 'mission_not_running',
      }),
    ]);
  });
}, 60_000);
