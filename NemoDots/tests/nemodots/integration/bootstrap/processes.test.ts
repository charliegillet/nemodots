// Separate processes: the worker-main entry (finding I9) and the real server
// entry (src/server/index.ts) under SIGTERM. The children are the production
// entry points started with `node --import tsx`; the only double is the empty
// hand-authored fixture (see support.ts), so a model call fails closed instead
// of reaching a provider.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createNemoDots } from '../../../../src/server/nemodots/bootstrap.js';
import { freePort, mount, sleep, until, withSuite } from './support.js';

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const GOAL = 'Restore checkout availability while preserving customer data.';

interface Child {
  process: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(file: string, env: Record<string, string | undefined>): Child {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) clean[name] = value;
  const child = spawn(process.execPath, ['--import', 'tsx', file], {
    cwd: APP_ROOT,
    env: clean,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const sink = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-6_000);
  };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  return {
    process: child,
    output: () => output,
    exited: new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    ),
  };
}

async function stopChild(child: Child) {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGTERM');
    const done = await Promise.race([child.exited, sleep(10_000).then(() => null)]);
    if (!done) child.process.kill('SIGKILL');
  }
}

describe('worker-main (separate worker process)', () => {
  it('NEMODOTS_WORKERS=0 in the server: a worker-main child claims and processes attempts, and exits 0 on SIGTERM', async () => {
    await withSuite(async (suite) => {
      const nd = createNemoDots(suite.env({ workers: 0 }), { log: () => {} });
      const mounted = mount(nd);
      const admin = new pg.Pool({
        connectionString: suite.db.urls.admin,
        max: 1,
      });
      let child: Child | null = null;
      try {
        await nd.start();
        expect((await nd.runtime()).workers).toEqual({
          configured: 0,
          running: false,
        });
        const created = (await (
          await mounted.post('/api/nemodots/missions', { goal: GOAL })
        ).json()) as { id: string };
        await mounted.post(`/api/nemodots/missions/${created.id}/start`, {});

        // Nothing is processed while no worker exists.
        await sleep(2_000);
        const idle = await admin.query(
          'SELECT count(*)::int AS n FROM coordinator.task_attempts WHERE mission_id = $1',
          [created.id],
        );
        expect(idle.rows[0].n).toBe(0);

        child = start('src/server/nemodots/worker-main.ts', {
          ...suite.env({ workers: 2 }),
        });
        const owners = await until(
          async () => {
            if (child!.process.exitCode !== null)
              throw new Error(
                `worker-main exited early (${child!.process.exitCode}): ${child!.output()}`,
              );
            const { rows } = await admin.query<{
              lease_owner: string;
              status: string;
            }>(
              `SELECT DISTINCT lease_owner, status FROM coordinator.task_attempts WHERE mission_id = $1`,
              [created.id],
            );
            return rows.length > 0 ? rows : null;
          },
          'worker-main to claim an attempt',
          60_000,
        );
        for (const row of owners)
          expect(row.lease_owner).toMatch(
            new RegExp(`^worker-${child.process.pid}-`),
          );
        // The attempt reached a terminal state: the empty fixture refuses the
        // planner's call, so it failed closed (no invented answer).
        await until(
          async () => {
            const { rows } = await admin.query(
              `SELECT status FROM coordinator.task_attempts WHERE mission_id = $1 AND status = 'running'`,
              [created.id],
            );
            return rows.length === 0 ? true : null;
          },
          'the claimed attempt to settle',
          60_000,
        );

        await mounted.post(`/api/nemodots/missions/${created.id}/cancel`, {});
        child.process.kill('SIGTERM');
        const result = await Promise.race([
          child.exited,
          sleep(15_000).then(() => null),
        ]);
        expect(result).not.toBeNull();
        expect(result!.code).toBe(0);
        expect(child.output()).toContain('ready: 2 worker(s)');
      } finally {
        if (child) await stopChild(child);
        await nd.stop();
        await admin.end();
        mounted.close();
      }
    });
  }, 180_000);

  it('exits 2 and prints BLOCKED naming the missing variable when inference is unavailable', async () => {
    await withSuite(async (suite) => {
      const child = start('src/server/nemodots/worker-main.ts', {
        ...suite.env({
          mode: 'live',
          workers: 2,
          extra: {
            OPENAI_BASE_URL: 'https://inference.example.test/v1',
            OPENAI_MODEL: 'nvidia/test-model',
          },
        }),
      });
      try {
        const result = await Promise.race([
          child.exited,
          sleep(60_000).then(() => null),
        ]);
        expect(result?.code).toBe(2);
        expect(child.output()).toContain('BLOCKED');
        expect(child.output()).toContain('OPENAI_API_KEY');
        expect(child.output()).not.toContain('example.test');
      } finally {
        await stopChild(child);
      }
    });
  }, 120_000);
});

describe('server entry under SIGTERM', () => {
  it('src/server/index.ts boots NemoDots, serves /api/state, and on SIGTERM stops workers and watcher and exits 0', async () => {
    await withSuite(async (suite) => {
      const port = await freePort();
      const sqlite = path.join(suite.scratch.dir, 'opendots.sqlite');
      const server = start('src/server/index.ts', {
        ...suite.env({ workers: 2 }),
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_PATH: sqlite,
        WEB_SEARCH_PROVIDER: 'disabled',
      });
      const admin = new pg.Pool({
        connectionString: suite.db.urls.admin,
        max: 1,
      });
      try {
        const base = `http://127.0.0.1:${port}`;
        const runtime = await until(
          async () => {
            if (server.process.exitCode !== null)
              throw new Error(
                `server exited early (${server.process.exitCode}): ${server.output()}`,
              );
            const response = await fetch(`${base}/api/nemodots/runtime`).catch(
              () => null,
            );
            if (!response || response.status !== 200) return null;
            const body = (await response.json()) as {
              state: string;
              watcher: { leader: boolean };
              workers: { running: boolean };
            };
            return body.state === 'running' && body.watcher.leader
              ? body
              : null;
          },
          'the server to run NemoDots',
          90_000,
        );
        expect(runtime.workers.running).toBe(true);
        expect((await fetch(`${base}/api/state`)).status).toBe(200);
        expect((await fetch(`${base}/api/nemodots/health`)).status).toBe(200);
        // An unknown path under /api still reaches the upstream JSON 404.
        const missing = await fetch(`${base}/api/nemodots/no-such-route`);
        expect(missing.status).toBe(404);

        const held = async () =>
          Number(
            (
              await admin.query(
                `SELECT count(*) AS n FROM pg_stat_activity
                  WHERE datname = $1 AND usename = 'nemodots_app'`,
                [suite.db.name],
              )
            ).rows[0].n,
          );
        expect(await held()).toBeGreaterThan(0);

        server.process.kill('SIGTERM');
        const result = await Promise.race([
          server.exited,
          sleep(20_000).then(() => null),
        ]);
        expect(result).not.toBeNull();
        expect(result!.code).toBe(0);
        // Workers, the watcher's LISTEN session and every pool are gone.
        await until(async () => (await held()) === 0, 'connections to close', 10_000);
        const locks = await admin.query(
          `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.locktype = 'advisory' AND a.datname = $1`,
          [suite.db.name],
        );
        expect(Number(locks.rows[0].n)).toBe(0);
      } finally {
        await stopChild(server);
        await admin.end();
      }
    });
  }, 180_000);
});
