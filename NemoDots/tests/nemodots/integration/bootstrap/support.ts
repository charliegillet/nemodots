// Shared fixtures for the composition-root suites. Everything runs against the
// NemoDots stack (PostgreSQL 55432 by default, Redis 56379): a fresh
// `nemodots_test_<hex>` database per test and a random Redis prefix, both
// removed afterwards.
//
// Labelled doubles: the inference mode is `fixture` with an EMPTY fixture file
// (the adapter refuses any request without an entry, so nothing is improvised
// and nothing is billed); the upstream Store/Runner exist only because
// createApp needs them. The composition root, the coordinator, the watcher,
// the worker host and PostgreSQL are real.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../../../../src/server/app.js';
import type { NemoDots } from '../../../../src/server/nemodots/bootstrap.js';
import { Runner } from '../../../../src/server/runner.js';
import { Store } from '../../../../src/server/store.js';
import type { Config } from '../../../../src/server/research.js';
import { testRedisUrl, unlinkByPrefix } from '../../helpers/test-redis.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { createClient } from 'redis';

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 15_000,
  stepMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

export interface Scratch {
  dir: string;
  fixturePath: string;
}

/** A scratch directory holding an empty, hand-authored fixture file. */
export function makeScratch(): Scratch {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nemodots-boot-'));
  mkdirSync(dir, { recursive: true });
  const fixturePath = path.join(dir, 'fixture.json');
  writeFileSync(
    fixturePath,
    JSON.stringify({
      format: 'nemodots.inference.fixture.v1',
      label: 'bootstrap suite empty fixture',
      provenance: 'hand-authored',
      host: 'fixture.local',
      models: [],
      entries: [],
    }),
  );
  return { dir, fixturePath };
}

export const dropScratch = (scratch: Scratch) =>
  rmSync(scratch.dir, { recursive: true, force: true });

export const DUMMY_LIVE = {
  OPENAI_API_KEY: 'sk-bootstrap-suite-not-a-real-key-0001',
  OPENAI_BASE_URL: 'https://inference.example.test/v1',
  OPENAI_MODEL: 'nvidia/test-model',
} as const;

export interface BootEnvOptions {
  scratch: Scratch;
  prefix: string;
  workers?: number;
  /** Replaces the fixture default. */
  mode?: 'fixture' | 'live' | 'blocked';
  extra?: Record<string, string | undefined>;
  checkoutPort?: number;
}

/**
 * The environment of one composition: explicit role URLs of the test database
 * (no NEMODOTS_INSTANCE, so nothing is read from roles.env), the NemoDots
 * Redis with a unique prefix, an unused checkout port, no OPENAI_* names
 * unless `extra` supplies them.
 */
export function bootEnv(
  db: TestDatabase,
  options: BootEnvOptions,
): Record<string, string | undefined> {
  const mode = options.mode ?? 'fixture';
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DO_NOT_TRACK: '1',
    NEMODOTS_PG_URL_ADMIN: db.urls.admin,
    NEMODOTS_PG_URL_APP: db.urls.app,
    NEMODOTS_PG_URL_CHECKOUT: db.urls.checkout,
    NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
    NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
    NEMODOTS_REDIS_URL: testRedisUrl(),
    NEMODOTS_REDIS_PREFIX: options.prefix,
    NEMODOTS_CHECKOUT_PORT: String(options.checkoutPort ?? 4599),
    NEMODOTS_PROBE_SECRET: randomBytes(16).toString('hex'),
    NEMODOTS_INFERENCE_MODE: mode,
    ...(mode === 'fixture'
      ? { NEMODOTS_FIXTURE_PATH: options.scratch.fixturePath }
      : {}),
    NEMODOTS_WORKERS: String(options.workers ?? 0),
    NEMODOTS_WATCH_INTERVAL_MS: '500',
    OWNER_ID: 'boot-suite-owner',
    ...options.extra,
  };
}

const researchConfig: Config = {
  mode: 'sample',
  baseUrl: 'https://api.openai.com/v1',
};

export interface Mounted {
  app: Hono;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  close(): void;
}

/** The real upstream createApp with `nemodots` mounted, as index.ts does. */
export function mount(nd: Pick<NemoDots, 'router'>): Mounted {
  const store = new Store(':memory:');
  const runner = new Runner(store, researchConfig);
  const app = createApp({
    store,
    runner,
    config: researchConfig,
    nemodots: nd,
  });
  const request = (pathname: string, init?: RequestInit) =>
    Promise.resolve(app.request(`http://localhost${pathname}`, init));
  return {
    app,
    get: (pathname) => request(pathname),
    post: (pathname, body) =>
      request(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close: () => store.close(),
  };
}

export interface Suite {
  db: TestDatabase;
  prefix: string;
  scratch: Scratch;
  env: (
    options?: Partial<BootEnvOptions>,
  ) => Record<string, string | undefined>;
}

/** A migrated (or deliberately unmigrated) database, a Redis prefix and a scratch dir. */
export async function withSuite<T>(
  fn: (suite: Suite) => Promise<T>,
  options: { migrate?: boolean } = {},
): Promise<T> {
  const scratch = makeScratch();
  const prefix = `nemodots:test:${randomBytes(6).toString('hex')}`;
  try {
    return await withTestDatabase(
      (db) =>
        fn({
          db,
          prefix,
          scratch,
          env: (extra = {}) => bootEnv(db, { scratch, prefix, ...extra }),
        }),
      { migrate: options.migrate },
    );
  } finally {
    dropScratch(scratch);
    const client = createClient({ url: testRedisUrl() });
    client.on('error', () => {});
    try {
      await client.connect();
      await unlinkByPrefix(client, prefix);
    } catch {
      // the stack's Redis is not reachable: nothing to clean
    } finally {
      client.destroy();
    }
  }
}
