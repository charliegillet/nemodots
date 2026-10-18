// Live: SIGKILL the separate worker process in the middle of an attempt. The
// reaper expires the lease, another worker process claims the task with a
// newer fencing token, and a late publish replayed with the killed worker's
// token is rejected (finding I9). The mission outcome after takeover is
// recorded as an observation: it depends on the model, not on this property.
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import { FenceError } from '../../../../src/server/nemodots/coordinator/index.js';
import {
  APP_ROOT,
  diagnose,
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
const children: ChildProcess[] = [];

function worker(): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server/nemodots/worker-main.ts'],
    {
      cwd: APP_ROOT,
      env: {
        ...instance.env,
        NEMODOTS_ENV_FILE: 'none',
        OWNER_ID: 'live-owner',
      } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  children.push(child);
  return child;
}

beforeAll(async () => {
  try {
    requireLive();
  } catch (error) {
    blocked = (error as Error).message;
    throw error;
  }
  instance = await startLiveInstance();
  instance.env.NEMODOTS_LEASE_MS = '3000';
  instance.env.NEMODOTS_WORKERS = '0'; // only worker-main processes work
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
  for (const child of children) child.kill('SIGKILL');
  await pool?.end().catch(() => undefined);
  await nemodots?.stop().catch(() => undefined);
  instance?.stop();
  writeResults(
    'worker-crash',
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

async function until<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

it('a killed worker process is replaced and its stale fence is refused', async () => {
  const first = worker();
  const created = await request('/missions', {
    goal: 'Restore checkout availability while preserving customer data.',
  });
  await request(`/missions/${created.id}/start`, {});

  // wait for an attempt that the first process is running
  const held = await until(
    'an attempt running in the first worker process',
    async () => {
      const { rows } = await pool.query(
        `SELECT a.id, a.task_id, a.fencing_token, a.generation, a.lease_owner,
                t.role, t.capabilities
           FROM coordinator.task_attempts a JOIN coordinator.tasks t ON t.id = a.task_id
          WHERE a.mission_id = $1 AND a.status = 'running' AND a.lease_owner LIKE $2
          ORDER BY a.started_at LIMIT 1`,
        [created.id, `worker-main-${first.pid}-%`],
      );
      return rows[0] ?? null;
    },
    90_000,
  );
  const killedAt = Date.now();
  first.kill('SIGKILL');

  // the reaper expires the orphaned attempt (3 s lease) and frees the task
  const expired = await until(
    'the killed worker’s attempt to be expired',
    async () => {
      const { rows } = await pool.query(
        `SELECT status FROM coordinator.task_attempts WHERE id = $1`,
        [held.id],
      );
      return rows[0] && rows[0].status !== 'running' ? rows[0].status : null;
    },
    60_000,
  );
  expect(['expired', 'aborted']).toContain(expired);

  // a second process takes the task over with a newer fencing token
  const second = worker();
  const takeover = await until(
    'another worker process to claim the same task',
    async () => {
      const { rows } = await pool.query(
        `SELECT id, fencing_token, lease_owner, status FROM coordinator.task_attempts
          WHERE task_id = $1 AND id <> $2 AND lease_owner LIKE $3
          ORDER BY started_at LIMIT 1`,
        [held.task_id, held.id, `worker-main-${second.pid}-%`],
      );
      return rows[0] ?? null;
    },
    90_000,
  );
  expect(Number(takeover.fencing_token)).toBeGreaterThan(
    Number(held.fencing_token),
  );

  // replay a publish with the killed worker's token: rejected, nothing written
  const stale = {
    missionId: created.id,
    taskId: held.task_id,
    attemptId: held.id,
    fencingToken: Number(held.fencing_token),
    generation: Number(held.generation),
    capabilities: held.capabilities,
    role: held.role,
  };
  const before = await pool.query(
    `SELECT count(*)::int AS n FROM coordinator.task_outputs WHERE attempt_id = $1`,
    [held.id],
  );
  let rejection: unknown = null;
  try {
    await nemodots.coordinator!.publishOutput(
      stale as never,
      {
        kind: 'handoff',
        content: { summary: 'late publish from a killed worker' },
        dependencyVector: [],
      } as never,
    );
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(FenceError);
  const after = await pool.query(
    `SELECT count(*)::int AS n FROM coordinator.task_outputs WHERE attempt_id = $1`,
    [held.id],
  );
  expect(after.rows[0].n).toBe(before.rows[0].n);

  // what happened to the mission afterwards is an observation
  const settledBy = Date.now() + 5 * 60_000;
  let snapshot: Json = {};
  while (Date.now() < settledBy) {
    snapshot = await request(`/missions/${created.id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.mission.status))
      break;
    await sleep(3000);
  }
  checks.push({
    name: 'worker-crash takeover',
    status: 'PASS',
    observed: {
      killedAfterMs: Date.now() - killedAt,
      oldAttemptEndedAs: expired,
      newFenceGreater: true,
      lateProvideRejectedWith: (rejection as FenceError).reason,
      missionStatusAfterTakeover: snapshot.mission?.status,
      ...(snapshot.mission?.status !== 'succeeded'
        ? { diagnosis: await diagnose(pool, created.id) }
        : {}),
    },
  });
  failed = false;
}, 600_000);
