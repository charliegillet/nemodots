// The composition root against a real migrated database and Redis: blocked
// boot names the absent variable, pending migrations refuse the start, a boot
// without the stack keeps /api/state serving, stop() shuts everything down,
// and a separate worker-main process picks up attempts while the server runs
// no workers of its own. Inference is a local stub that speaks Chat
// Completions; it proves wiring, not reasoning (that is the live suite).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/server/app.js';
import { Runner } from '../../../../src/server/runner.js';
import { Store } from '../../../../src/server/store.js';
import {
  MigrationsPendingError,
  createNemoDots,
  type NemoDots,
} from '../../../../src/server/nemodots/bootstrap.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';

const OPENAI = {
  OPENAI_API_KEY: 'stub-key-0123456789',
  OPENAI_MODEL: 'stub/model',
};
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function envFor(
  db: TestDatabase,
  redis: { url: string; prefix: string },
  extra: Record<string, string | undefined> = {},
) {
  return {
    NEMODOTS_INSTANCE: 'dev',
    NEMODOTS_PG_URL_APP: db.urls.app,
    NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
    NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
    NEMODOTS_PROBE_SECRET: 'probe-secret-for-bootstrap-test-0123',
    NEMODOTS_REDIS_URL: redis.url,
    NEMODOTS_REDIS_PREFIX: redis.prefix,
    NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:4599',
    NEMODOTS_WATCH_INTERVAL_MS: '60000',
    NEMODOTS_WORKERS: '0',
    ...extra,
  } as Record<string, string | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = (response: Response | Promise<Response>) =>
  Promise.resolve(response).then((r) => r.json() as Promise<Json>);

function track(nemodots: NemoDots) {
  closers.push(() => nemodots.stop());
  return nemodots;
}

/** A stand-in for the provider: any chat completion answers with an empty plan. */
async function stubProvider() {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'stub/model' }] }));
        return;
      }
      requests += 1;
      const stream = (() => {
        try {
          return JSON.parse(body).stream === true;
        } catch {
          return false;
        }
      })();
      const content = '{"tasks":[]}';
      if (stream) {
        response.setHeader('content-type', 'text/event-stream');
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'x', model: 'stub/model', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1 } } : {}) })}\n\n`;
        response.end(
          chunk({ role: 'assistant', content }, null) +
            chunk({}, 'stop') +
            'data: [DONE]\n\n',
        );
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'x',
            model: 'stub/model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests: () => requests,
  };
}

describe('blocked boot', () => {
  it.each(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'])(
    'with %s absent, health names exactly it and mission creation is 503',
    async (missing) => {
      await withTestDatabase(async (db) =>
        withTestRedis(async (redis) => {
          const env = envFor(db, redis, {
            ...OPENAI,
            OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
            [missing]: undefined,
          });
          const nemodots = track(
            createNemoDots(env, { workspace: { ownerId: 'owner' } }),
          );
          const health = await json(nemodots.router.request('/health'));
          expect(health.mode).toBe('blocked');
          expect(health.missingEnv).toEqual([missing]);
          expect(health.postgres).toBe('ok');
          const create = await Promise.resolve(
            nemodots.router.request('/missions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ goal: 'restore the checkout' }),
            }),
          );
          expect(create.status).toBe(503);
          expect(await create.json()).toMatchObject({ missingEnv: [missing] });
          await nemodots.start();
          expect(nemodots.state()).toBe('running');
          await nemodots.stop();
        }),
      );
    },
  );
});

describe('migrations', () => {
  it('pending or unknown migrations refuse the start and the router answers 503', async () => {
    await withTestDatabase(async (db) =>
      withTestRedis(async (redis) => {
        const admin = createRolePool('admin', db.urls.admin, { max: 1 });
        closers.push(() => admin.end());
        await admin.query(
          "DELETE FROM public.schema_migrations WHERE id = '0007_source_space'",
        );
        const nemodots = track(
          createNemoDots(
            envFor(db, redis, {
              NEMODOTS_PG_URL_ADMIN: db.urls.admin,
              NEMODOTS_INFERENCE_MODE: 'blocked',
            }),
            { workspace: { ownerId: 'owner' } },
          ),
        );
        await expect(nemodots.start()).rejects.toBeInstanceOf(
          MigrationsPendingError,
        );
        expect(nemodots.state()).toBe('failed');
        const missions = await Promise.resolve(
          nemodots.router.request('/missions'),
        );
        expect(missions.status).toBe(503);
        expect(await missions.json()).toMatchObject({
          reason: 'migrations_pending',
        });
        // health stays reachable so an operator can see why
        expect((await json(nemodots.router.request('/health'))).postgres).toBe(
          'ok',
        );
      }),
    );
  });

  it('a database that is up to date starts', async () => {
    await withTestDatabase(async (db) =>
      withTestRedis(async (redis) => {
        const nemodots = track(
          createNemoDots(
            envFor(db, redis, {
              NEMODOTS_PG_URL_ADMIN: db.urls.admin,
              NEMODOTS_INFERENCE_MODE: 'blocked',
            }),
            { workspace: { ownerId: 'owner' } },
          ),
        );
        await nemodots.start();
        expect(nemodots.state()).toBe('running');
      }),
    );
  });
});

describe('without the stack', () => {
  it('reports postgres down while the upstream app keeps serving /api/state', async () => {
    const store = new Store(':memory:');
    closers.push(() => store.close());
    const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
    const nemodots = track(
      createNemoDots(
        {
          NEMODOTS_INSTANCE: 'dev',
          NEMODOTS_PG_URL_APP: 'postgres://nemodots_app:x@127.0.0.1:1/nemodots',
          NEMODOTS_PG_URL_VERIFIER:
            'postgres://nemodots_verifier:x@127.0.0.1:1/nemodots',
          NEMODOTS_PG_URL_INJECTOR:
            'postgres://nemodots_injector:x@127.0.0.1:1/nemodots',
          NEMODOTS_PROBE_SECRET: 'probe-secret-for-bootstrap-test-0123',
          NEMODOTS_REDIS_URL: 'redis://127.0.0.1:1/0',
          NEMODOTS_INFERENCE_MODE: 'blocked',
        },
        { workspace: { ownerId: 'owner' } },
      ),
    );
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      nemodots,
    });
    await nemodots.start().catch(() => undefined);
    expect((await app.request('/api/state')).status).toBe(200);
    const health = await json(app.request('/api/nemodots/health'));
    expect(health).toMatchObject({
      postgres: 'down',
      redis: 'down',
      mode: 'blocked',
    });
    expect(JSON.stringify(health)).not.toContain('postgres://');
  });
});

describe('shutdown', () => {
  it('stop() ends the server-side loops and releases the pools', async () => {
    await withTestDatabase(async (db) =>
      withTestRedis(async (redis) => {
        const provider = await stubProvider();
        const nemodots = createNemoDots(
          envFor(db, redis, {
            ...OPENAI,
            OPENAI_BASE_URL: provider.baseUrl,
            NEMODOTS_WORKERS: '1',
          }),
          { workspace: { ownerId: 'owner' } },
        );
        await nemodots.start();
        expect(nemodots.state()).toBe('running');
        expect((await nemodots.health()).postgres).toBe('ok');
        await nemodots.stop();
        expect(nemodots.state()).toBe('stopped');
        // pools are closed: health can no longer reach PostgreSQL
        expect((await nemodots.health()).postgres).toBe('down');
        await nemodots.stop(); // idempotent
      }),
    );
  });
});

describe('a separate worker process', () => {
  it('picks up attempts while the server runs no workers (NEMODOTS_WORKERS=0)', async () => {
    await withTestDatabase(async (db) =>
      withTestRedis(async (redis) => {
        const provider = await stubProvider();
        const env = envFor(db, redis, {
          ...OPENAI,
          OPENAI_BASE_URL: provider.baseUrl,
          NEMODOTS_WORKERS: '0',
        });
        const server = track(
          createNemoDots(env, { workspace: { ownerId: 'owner' } }),
        );
        await server.start();
        const app = createRolePool('app', db.urls.app, { max: 2 });
        closers.push(() => app.end());

        const created = await json(
          server.router.request('/missions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ goal: 'restore the checkout' }),
          }),
        );
        expect(created.status).toBe('created');

        const child: ChildProcess = spawn(
          process.execPath,
          ['--import', 'tsx', 'src/server/nemodots/worker-main.ts'],
          {
            cwd: path.resolve(import.meta.dirname, '../../../..'),
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              NEMODOTS_ENV_FILE: 'none',
              OWNER_ID: 'owner',
              ...Object.fromEntries(
                Object.entries(env).filter(([, v]) => v !== undefined),
              ),
            } as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout?.on('data', (c) => (output += c));
        child.stderr?.on('data', (c) => (output += c));
        closers.push(async () => {
          child.kill('SIGKILL');
        });

        // no attempt can be claimed by anyone but the child
        await server.router.request(`/missions/${created.id}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const deadline = Date.now() + 40_000;
        let owner: string | null = null;
        while (Date.now() < deadline && !owner) {
          const { rows } = await app.query<{ lease_owner: string }>(
            `SELECT lease_owner FROM coordinator.task_attempts WHERE mission_id = $1 LIMIT 1`,
            [created.id],
          );
          owner = rows[0]?.lease_owner ?? null;
          if (!owner) await new Promise((r) => setTimeout(r, 250));
        }
        expect(output).not.toMatch(/BLOCKED|fatal/);
        expect(owner).toMatch(/^worker-main-/);
        expect(provider.requests()).toBeGreaterThanOrEqual(1);

        // SIGTERM is a clean stop
        const exited = new Promise<number | null>((resolve) =>
          child.once('exit', (code) => resolve(code)),
        );
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        expect(output).toContain('worker: stopped');
      }),
    );
  }, 90_000);

  it('prints BLOCKED with the names and exits non-zero when a provider variable is missing', async () => {
    await withTestDatabase(async (db) =>
      withTestRedis(async (redis) => {
        const env = envFor(db, redis, { OPENAI_MODEL: 'stub/model' });
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'src/server/nemodots/worker-main.ts'],
          {
            cwd: path.resolve(import.meta.dirname, '../../../..'),
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              NEMODOTS_ENV_FILE: 'none',
              ...Object.fromEntries(
                Object.entries(env).filter(([, v]) => v !== undefined),
              ),
            } as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stderr?.on('data', (c) => (output += c));
        const code = await new Promise<number | null>((resolve) =>
          child.once('exit', (c) => resolve(c)),
        );
        expect(code).toBe(2);
        expect(output).toContain('BLOCKED:');
        expect(output).toContain('OPENAI_API_KEY');
        expect(output).toContain('OPENAI_BASE_URL');
        expect(output).not.toContain('postgres://');
      }),
    );
  }, 60_000);
});
