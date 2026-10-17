// Gate 0 item 4, "start an isolated test stack": the verifier brings up a
// NEW stack instance from empty storage with the stack script
// (init, start, status, migrate, seed, checkout health, stop) instead of
// reusing a pre-started one. The instance uses its own ports (PostgreSQL
// and Redis and checkout on free ports chosen at run time) and the instance name `acc0f`, so it
// never touches the shared 55432/56379 stack, nor the user's 5432/6379.
//
// stack.mjs derives its data directory from its own location
// (NemoDots/.local/<instance>), so the instance lives under .local/acc0f; it
// is stopped and deleted at the end (only a directory whose instance.json
// carries this exact name and was written by the stack script).
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  appendManifest,
  cleanEnv,
  makeRedactor,
  parseEnvText,
  portIsFree,
  run,
  sleep,
  type RunResult,
} from './helpers/common.js';

const INSTANCE = 'acc0f';
// Ports are chosen from the free ones at run time: other agents start their own
// instances (for example `demo`) on neighbouring fixed ports concurrently.
let PG_PORT = 0;
let REDIS_PORT = 0;
let CHECKOUT_PORT = 0;
const STACK = path.join(APP_ROOT, 'scripts/nemodots/stack.mjs');
const INSTANCE_DIR = path.join(APP_ROOT, '.local', INSTANCE);
const ROLES_FILE = path.join(INSTANCE_DIR, 'stack', 'roles.env');

let redact: (t: string) => string = (t) => t;
let n = 0;

const stack = (args: string[], extraEnv: Record<string, string> = {}) =>
  run('node', [STACK, ...args], {
    cwd: APP_ROOT,
    env: cleanEnv({ NEMODOTS_INSTANCE: INSTANCE, ...extraEnv }),
    logName: `g0-fresh-${(n += 1)}-${args[0]}.log`,
    timeoutMs: 300_000,
    redact,
  });

function removeOwnInstance() {
  const meta = path.join(INSTANCE_DIR, 'stack', 'instance.json');
  if (!existsSync(meta)) return;
  const info = JSON.parse(readFileSync(meta, 'utf8')) as {
    instance?: string;
    createdBy?: string;
  };
  if (
    info.instance === INSTANCE &&
    info.createdBy === 'scripts/nemodots/stack.mjs'
  )
    rmSync(INSTANCE_DIR, { recursive: true, force: true });
}

async function readRoles() {
  return parseEnvText(readFileSync(ROLES_FILE, 'utf8'));
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  // Distinct ephemeral ports; none may be 5432 or 6379 or one of the shared stack's.
  const taken = new Set([5432, 6379, 55432, 56379, 4510, 4600, 4601]);
  const picked: number[] = [];
  while (picked.length < 3) {
    const port = await freePort();
    if (!taken.has(port) && !picked.includes(port)) picked.push(port);
  }
  [PG_PORT, REDIS_PORT, CHECKOUT_PORT] = picked;
  // A leftover instance from an earlier aborted run: stop it, then delete it.
  if (existsSync(INSTANCE_DIR)) {
    await stack(['stop']);
    removeOwnInstance();
  }
  expect(existsSync(INSTANCE_DIR), `${INSTANCE_DIR} could not be cleaned`).toBe(
    false,
  );
});

afterAll(async () => {
  await stack(['stop']).catch(() => undefined);
  removeOwnInstance();
});

describe('G0.4 a fresh isolated stack from empty storage', () => {
  it('[G0.4] the stack script refuses the user ports 5432 / 6379 at init and creates nothing', async () => {
    for (const flags of [
      ['--pg-port', '5432'],
      ['--redis-port', '6379'],
    ]) {
      const r = await run(
        'node',
        [STACK, 'init', '--instance', 'acc0r', ...flags],
        {
          cwd: APP_ROOT,
          env: cleanEnv(),
          logName: `g0-fresh-refuse-${flags[0].slice(2)}.log`,
          timeoutMs: 60_000,
        },
      );
      expect(r.code, r.tail).not.toBe(0);
      expect(r.tail).toMatch(/5432|6379|refus/i);
    }
    const leftover = path.join(APP_ROOT, '.local', 'acc0r');
    const created = existsSync(leftover);
    if (created) rmSync(leftover, { recursive: true, force: true });
    expect(
      created,
      'a refused init must not create an instance directory',
    ).toBe(false);
  });

  it('[G0.4] init creates the instance (initdb, roles.env 0600) on the chosen ports', async () => {
    for (const port of [PG_PORT, REDIS_PORT, CHECKOUT_PORT])
      expect(await portIsFree(port), `port ${port} is in use`).toBe(true);
    const r = await stack([
      'init',
      '--pg-port',
      String(PG_PORT),
      '--redis-port',
      String(REDIS_PORT),
      '--checkout-port',
      String(CHECKOUT_PORT),
    ]);
    expect(r.code, r.tail).toBe(0);
    const meta = JSON.parse(
      readFileSync(path.join(INSTANCE_DIR, 'stack', 'instance.json'), 'utf8'),
    ) as { pgPort: number; redisPort: number; checkoutPort: number };
    expect([meta.pgPort, meta.redisPort, meta.checkoutPort]).toEqual([
      PG_PORT,
      REDIS_PORT,
      CHECKOUT_PORT,
    ]);
    expect(statSync(ROLES_FILE).mode & 0o077, 'roles.env must be 0600').toBe(0);
    const roles = await readRoles();
    redact = makeRedactor(
      Object.entries(roles).flatMap(([k, v]) => {
        if (k.startsWith('NEMODOTS_PG_URL_'))
          return [decodeURIComponent(new URL(v).password)];
        return k === 'NEMODOTS_PROBE_SECRET' ? [v] : [];
      }),
    );
    for (const role of ['ADMIN', 'APP', 'CHECKOUT', 'INJECTOR', 'VERIFIER'])
      expect(new URL(roles[`NEMODOTS_PG_URL_${role}`]).port).toBe(
        String(PG_PORT),
      );
  });

  it('[G0.4] start brings up PostgreSQL and Redis on those ports and status exits 0; both answer an independent client', async () => {
    const start = await stack(['start']);
    expect(start.code, start.tail).toBe(0);
    const status = await stack(['status']);
    expect(status.code, status.tail).toBe(0);
    const roles = await readRoles();
    const client = new pg.Client({
      connectionString: roles.NEMODOTS_PG_URL_ADMIN,
    });
    await client.connect();
    try {
      const row = (
        await client.query<{ u: string; p: string; d: string }>(
          'SELECT current_user AS u, inet_server_port()::text AS p, current_database() AS d',
        )
      ).rows[0];
      expect(row).toEqual({
        u: 'nemodots_admin',
        p: String(PG_PORT),
        d: 'nemodots',
      });
    } finally {
      await client.end();
    }
    const redis = createClient({ url: `redis://127.0.0.1:${REDIS_PORT}/0` });
    await redis.connect();
    try {
      expect(await redis.ping()).toBe('PONG');
      expect(await redis.info('server')).toMatch(
        new RegExp(`tcp_port:${REDIS_PORT}`),
      );
    } finally {
      await redis.quit();
    }
  });

  const viaStack = (file: string, args: string[] = []) =>
    stack(['run', file, ...args]);

  it('[G0.4] migrations and the seed run from empty storage through the npm-script path (stack run), and --check is clean', async () => {
    const migrate = await viaStack('src/server/nemodots/db/migrate.ts');
    expect(migrate.code, migrate.tail).toBe(0);
    const check = await viaStack('src/server/nemodots/db/migrate.ts', [
      '--check',
    ]);
    expect(check.code, check.tail).toBe(0);
    const seed = await viaStack('src/server/nemodots/sandbox/seed.ts');
    expect(seed.code, seed.tail).toBe(0);
    const roles = await readRoles();
    const client = new pg.Client({
      connectionString: roles.NEMODOTS_PG_URL_VERIFIER,
    });
    await client.connect();
    try {
      const n1 = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM checkout.orders',
      );
      const n2 = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM checkout.inventory',
      );
      expect(Number(n1.rows[0].n)).toBeGreaterThan(0);
      expect(Number(n2.rows[0].n)).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it('[G0.4] the checkout API of this instance reports ok after migrate and seed (restarting the stack if it started before the schema existed)', async () => {
    const health = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${CHECKOUT_PORT}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        return ((await res.json()) as { status?: string }).status ?? 'none';
      } catch {
        return 'unreachable';
      }
    };
    let state = 'none';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      state = await health();
      if (state === 'ok') break;
      await sleep(500);
    }
    let restarted = false;
    if (state !== 'ok') {
      restarted = true;
      const stop = await stack(['stop']);
      expect(stop.code, stop.tail).toBe(0);
      const start = await stack(['start']);
      expect(start.code, start.tail).toBe(0);
      const d2 = Date.now() + 30_000;
      while (Date.now() < d2) {
        state = await health();
        if (state === 'ok') break;
        await sleep(500);
      }
    }
    appendManifest({
      gate: 0,
      step: 'fresh-stack-checkout',
      instance: INSTANCE,
      restartedAfterSeed: restarted,
      finalHealth: state,
    });
    expect(state).toBe('ok');
    const status: RunResult = await stack(['status']);
    expect(status.code, status.tail).toBe(0);
  }, 240_000);

  it('[G0.4] stop frees every port, and status then exits non-zero (no stale ok)', async () => {
    const stop = await stack(['stop']);
    expect(stop.code, stop.tail).toBe(0);
    for (const port of [PG_PORT, REDIS_PORT, CHECKOUT_PORT]) {
      const deadline = Date.now() + 15_000;
      let free = false;
      while (Date.now() < deadline && !(free = await portIsFree(port)))
        await sleep(250);
      expect(free, `port ${port} still bound after stop`).toBe(true);
    }
    const status = await stack(['status']);
    expect(status.code, status.tail).not.toBe(0);
  }, 120_000);
});
