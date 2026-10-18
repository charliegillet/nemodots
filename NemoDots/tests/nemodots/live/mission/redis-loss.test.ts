// Redis is an effect target and a cache, never an authority. Stop the
// instance's OWN Redis (its port only, never 6379) while a mission exists:
// health reports redis down, PostgreSQL state is untouched and still served,
// and after the stack restarts Redis the system reports ok again and the
// mission is intact. No model call is made (no worker is attached), so this
// proves persistence and recovery of the composition, NOT the Redis effect
// marker path, which is covered by the actions integration tests.
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import {
  requireLive,
  sleep,
  startLiveInstance,
  writeResults,
  type Check,
  type LiveInstance,
} from './support.js';

const checks: Check[] = [];
let failed = true;
let blocked: string | null = null;
let instance: LiveInstance;
let nemodots: NemoDots;
let pool: pg.Pool;

beforeAll(async () => {
  try {
    requireLive();
  } catch (error) {
    blocked = (error as Error).message;
    throw error;
  }
  instance = await startLiveInstance();
  instance.env.NEMODOTS_WORKERS = '0';
  nemodots = createNemoDots(instance.env, {
    workspace: { ownerId: 'live-owner' },
  });
  await nemodots.start();
  pool = new pg.Pool({
    connectionString: instance.env.NEMODOTS_PG_URL_VERIFIER,
    max: 2,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await nemodots?.stop().catch(() => undefined);
  instance?.stop();
  writeResults(
    'redis-loss',
    instance?.name ?? 'none',
    blocked ? 'BLOCKED' : failed ? 'FAIL' : 'PASS',
    checks,
  );
}, 60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const request = (path: string, body?: unknown) =>
  Promise.resolve(
    nemodots.router.request(
      path,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    ),
  ).then((r) => r.json() as Promise<Json>);

async function untilRedis(expected: 'ok' | 'down', timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await request('/health');
    if (health.redis === expected) return health;
    if (Date.now() > deadline)
      throw new Error(`redis did not become ${expected}`);
    await sleep(500);
  }
}

it('survives losing its own Redis and recovers when it returns', async () => {
  expect((await request('/health')).redis).toBe('ok');
  const created = await request('/missions', {
    goal: 'Restore checkout availability while preserving customer data.',
  });
  await request(`/missions/${created.id}/start`, {});
  const before = await request(`/missions/${created.id}`);
  expect(before.mission.status).toBe('running');

  // stop THIS instance's Redis only, by its own port
  expect(instance.ports.redis).not.toBe(6379);
  const stop = spawnSync(
    'redis-cli',
    ['-p', String(instance.ports.redis), 'shutdown', 'nosave'],
    { encoding: 'utf8' },
  );
  expect([0, 1]).toContain(stop.status ?? 1); // redis-cli reports the closed connection
  const down = await untilRedis('down', 20_000);
  expect(down.postgres).toBe('ok');

  // authoritative state is in PostgreSQL and still served
  const during = await request(`/missions/${created.id}`);
  expect(during.mission.id).toBe(created.id);
  expect(during.mission.status).toBe('running');
  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM coordinator.tasks WHERE mission_id = $1`,
    [created.id],
  );
  expect(rows.rows[0].n).toBe(before.tasks.length);

  // the stack restarts the missing process; the system recovers by itself
  const start = instance.stack('start');
  expect(start.status).toBe(0);
  const up = await untilRedis('ok', 30_000);
  expect(up.postgres).toBe('ok');
  const after = await request(`/missions/${created.id}`);
  expect(after.mission.status).toBe('running');
  expect(after.lastEventId).toBeGreaterThanOrEqual(before.lastEventId);

  checks.push({
    name: 'redis loss',
    status: 'PASS',
    observed: {
      redisDuringLoss: down.redis,
      postgresDuringLoss: down.postgres,
      missionStatusDuringLoss: during.mission.status,
      redisAfterRestart: up.redis,
      note: 'no worker attached; Redis effect marker path not exercised here',
    },
  });
  failed = false;
}, 240_000);
