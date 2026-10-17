// Starts an isolated NemoDots system for one test file: a fresh `acc4_<hex>`
// database on the NemoDots PostgreSQL (55432, never 5432), a Redis key prefix
// on database index 5, the checkout API on 4680, the OpenDots app (with the
// NemoDots routes) on 4681 and, for kill tests, a separate worker process.
// Everything started here is stopped by `stop()`; only these children are
// signalled. Production entry points are resolved first so a missing module
// fails with ENTRY POINT MISSING instead of an opaque spawn error.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from 'redis';
import {
  type EntryName,
  requireEntries,
} from '../driver/entry-points.js';
import {
  stackRoleUrls,
  withDatabase,
} from '../../helpers/test-db.js';
import { unlinkByPrefix } from '../../helpers/test-redis.js';
import { APP_ROOT, G4, mergedEnv, readDotEnv, redactor } from './config.js';
import { NemoApi } from './api.js';

export const SYSTEM_ENTRIES: EntryName[] = [
  'bootstrap',
  'workerMain',
  'checkoutMain',
  'seed',
  'checkoutMigration',
  'coordinatorMissions',
  'coordinatorTasks',
  'coordinatorLeases',
  'coordinatorPublish',
  'coordinatorRecovery',
  'watcher',
  'advanceConfig',
];

export interface SystemOptions {
  /** Base URL of the provider (scripted stub or passthrough proxy). */
  providerUrl: string;
  providerModel: string;
  /** Extra app environment (caps, intervals). Never secrets from the test. */
  env?: Record<string, string>;
  /** Run workers in a separate `worker-main` process the test can SIGKILL. */
  separateWorker?: boolean;
  /** Pass the Intelligence key through (conversation tests only). */
  intelligence?: boolean;
  /** Redis URL override (private instance for the Redis-loss test). */
  redisUrl?: string;
}

export interface System {
  api: NemoApi;
  baseUrl: string;
  checkoutUrl: string;
  dbName: string;
  redisPrefix: string;
  /** Read-only verifier connection (nemodots_verifier). */
  verifier: pg.Client;
  redis: ReturnType<typeof createClient>;
  logs(): string;
  worker: WorkerHandle | null;
  startWorker(): Promise<WorkerHandle>;
  /** SIGKILL every child process of the app, then start it again. */
  restartApp(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerHandle {
  pid: number;
  kill(signal?: NodeJS.Signals): Promise<void>;
  exited: Promise<number | null>;
}

const NODE = process.execPath;

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
export { waitFor };

function run(command: string[], env: Record<string, string>, label: string, redact: (s: string) => string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(NODE, command, { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out = (out + d).slice(-4000)));
    child.stderr.on('data', (d) => (out = (out + d).slice(-4000)));
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${label} exited with ${code}: ${redact(out).slice(-1500)}`)),
    );
    child.once('error', reject);
  });
}

export async function startSystem(options: SystemOptions): Promise<System> {
  await requireEntries(SYSTEM_ENTRIES);

  const roleUrls = stackRoleUrls();
  const hex = randomBytes(5).toString('hex');
  const dbName = `${G4.dbPrefix}${hex}`;
  if (!/^acc4_[0-9a-f]+$/.test(dbName)) throw new Error('bad database name');
  const redisUrl = options.redisUrl ?? `redis://127.0.0.1:${process.env.NEMODOTS_REDIS_PORT ?? 56379}/${G4.redisDb}`;
  if (/:6379\b/.test(redisUrl)) throw new Error('Refusing the user Redis on 6379.');
  const redisPrefix = `${G4.redisPrefixRoot}:${hex}`;
  const probeSecret = randomBytes(24).toString('hex');
  const scratch = resolve(G4.scratch, hex);
  mkdirSync(scratch, { recursive: true });

  const admin = new pg.Client({ connectionString: roleUrls.admin, application_name: 'nemodots-acc4-admin' });
  await admin.connect();
  const children: ChildProcess[] = [];
  let logBuffer = '';
  let verifier: pg.Client | null = null;
  let redisClient: ReturnType<typeof createClient> | null = null;

  const dbUrl = (role: keyof typeof roleUrls) => withDatabase(roleUrls[role], dbName);
  const roleEnv: Record<string, string> = {
    NEMODOTS_PG_URL_ADMIN: dbUrl('admin'),
    NEMODOTS_PG_URL_APP: dbUrl('app'),
    NEMODOTS_PG_URL_CHECKOUT: dbUrl('checkout'),
    NEMODOTS_PG_URL_INJECTOR: dbUrl('injector'),
    NEMODOTS_PG_URL_VERIFIER: dbUrl('verifier'),
  };
  const dotEnv = readDotEnv();
  const common: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    DO_NOT_TRACK: '1',
    NEMODOTS_INSTANCE: process.env.NEMODOTS_INSTANCE ?? 'dev',
    NEMODOTS_PG_HOST: '127.0.0.1',
    NEMODOTS_PG_PORT: String(new URL(roleUrls.admin).port || 55432),
    NEMODOTS_PG_DATABASE: dbName,
    NEMODOTS_REDIS_URL: redisUrl,
    NEMODOTS_REDIS_PREFIX: redisPrefix,
    NEMODOTS_CHECKOUT_PORT: String(G4.checkoutPort),
    NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${G4.checkoutPort}`,
    NEMODOTS_PROBE_SECRET: probeSecret,
  };
  const appEnv: Record<string, string> = {
    ...common,
    ...roleEnv,
    HOST: '127.0.0.1',
    PORT: String(G4.appPort),
    DATABASE_PATH: resolve(scratch, 'opendots.sqlite'),
    OWNER_ID: dotEnv.OWNER_ID ?? 'acc4-owner',
    NEMODOTS_INFERENCE_MODE: 'live',
    OPENAI_BASE_URL: options.providerUrl,
    OPENAI_MODEL: options.providerModel,
    // The provider is the verifier's own endpoint; the app never sees a real key.
    OPENAI_API_KEY: 'acc4-not-a-real-key-0000000000',
    NEMODOTS_WATCH_INTERVAL_MS: '500',
    NEMODOTS_WORKERS: options.separateWorker ? '0' : '2',
    WEB_SEARCH_PROVIDER: 'disabled',
    ...(options.intelligence
      ? Object.fromEntries(
          ['CPK_INTELLIGENCE_API_KEY', 'INTELLIGENCE_API_KEY', 'INTELLIGENCE_API_URL', 'INTELLIGENCE_GATEWAY_WS_URL', 'INTELLIGENCE_WS_URL']
            .map((name) => [name, mergedEnv()[name]] as const)
            .filter((pair): pair is [string, string] => Boolean(pair[1])),
        )
      : {}),
    ...(options.env ?? {}),
  };
  const redact = redactor({ ...appEnv, ...dotEnv });

  const track = (child: ChildProcess, label: string) => {
    children.push(child);
    const sink = (d: Buffer) => (logBuffer = (logBuffer + `[${label}] ${redact(String(d))}`).slice(-20000));
    child.stdout?.on('data', sink);
    child.stderr?.on('data', sink);
    return child;
  };
  const spawnTs = (file: string, env: Record<string, string>, label: string) =>
    track(spawn(NODE, ['--import', 'tsx', file], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }), label);

  const killChild = async (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill(signal);
    await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await done;
    }
  };

  let app: ChildProcess | null = null;
  let workerHandle: WorkerHandle | null = null;
  const startApp = async () => {
    app = spawnTs('src/server/index.ts', appEnv, 'app');
    await waitFor('app /api/nemodots/health', async () => {
      if (app!.exitCode !== null) throw new Error(`app exited with ${app!.exitCode}: ${logBuffer.slice(-1500)}`);
      const res = await fetch(`http://127.0.0.1:${G4.appPort}/api/nemodots/health`).catch(() => null);
      return res && res.status === 200 ? true : null;
    }, 90_000);
  };

  const system: System = {
    get api() {
      return api;
    },
    baseUrl: `http://127.0.0.1:${G4.appPort}`,
    checkoutUrl: `http://127.0.0.1:${G4.checkoutPort}`,
    dbName,
    redisPrefix,
    get verifier() {
      return verifier!;
    },
    get redis() {
      return redisClient!;
    },
    logs: () => logBuffer,
    get worker() {
      return workerHandle;
    },
    async startWorker() {
      const child = spawnTs('src/server/nemodots/worker-main.ts', { ...appEnv, NEMODOTS_WORKERS: '2' }, 'worker');
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      workerHandle = {
        pid: child.pid!,
        exited,
        kill: (signal = 'SIGKILL') => killChild(child, signal),
      };
      return workerHandle;
    },
    async restartApp() {
      if (app) await killChild(app, 'SIGKILL');
      await startApp();
    },
    async stop() {
      for (const child of [...children].reverse()) await killChild(child).catch(() => undefined);
      try {
        await verifier?.end();
      } catch {
        /* ignore */
      }
      try {
        if (redisClient) await unlinkByPrefix(redisClient, redisPrefix).catch(() => undefined);
        redisClient?.destroy();
      } catch {
        /* ignore */
      }
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await admin.end().catch(() => undefined);
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
  const api = new NemoApi(system.baseUrl);

  try {
    await admin.query(`CREATE DATABASE ${dbName} OWNER nemodots_admin`);
    const { migrate } = await import(
      /* @vite-ignore */ resolve(APP_ROOT, 'src/server/nemodots/db/migrate.ts')
    );
    await migrate({ connectionString: dbUrl('admin') });
    await run(['--import', 'tsx', 'src/server/nemodots/sandbox/seed.ts'], { ...common, ...roleEnv }, 'seed', redact);

    verifier = new pg.Client({ connectionString: dbUrl('verifier'), application_name: 'nemodots-acc4-verifier' });
    await verifier.connect();
    redisClient = createClient({ url: redisUrl });
    redisClient.on('error', () => undefined);
    await redisClient.connect();

    // Checkout API: minimal explicit environment (finding I3).
    spawnTs(
      'src/server/nemodots/sandbox/checkout-main.ts',
      {
        PATH: common.PATH,
        NEMODOTS_PG_URL_CHECKOUT: roleEnv.NEMODOTS_PG_URL_CHECKOUT,
        NEMODOTS_REDIS_URL: redisUrl,
        NEMODOTS_REDIS_PREFIX: redisPrefix,
        NEMODOTS_CHECKOUT_PORT: String(G4.checkoutPort),
        NEMODOTS_PROBE_SECRET: probeSecret,
      },
      'checkout',
    );
    await waitFor('checkout /health', async () => {
      const res = await fetch(`${system.checkoutUrl}/health`).catch(() => null);
      return res ? true : null;
    }, 60_000);

    await startApp();
    if (options.separateWorker) await system.startWorker();
    return system;
  } catch (error) {
    const message = redact((error as Error).message);
    await system.stop().catch(() => undefined);
    throw new Error(`${message}\n--- child log tail ---\n${redact(logBuffer).slice(-2500)}`);
  }
}

/** Current value/version of a controlled config key via the verifier role. */
export async function readConfig(system: System, key: string) {
  const { rows } = await system.verifier.query(
    'SELECT value, version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  if (!rows[0]) throw new Error(`config key ${key} not found`);
  return { value: rows[0].value as unknown, version: Number(rows[0].version) };
}

/** Rows of config_versions caused by an action (the only committed controlled effects). */
export async function committedActionRows(system: System) {
  const { rows } = await system.verifier.query(
    'SELECT key, version, caused_by_action_id FROM checkout.config_versions WHERE caused_by_action_id IS NOT NULL ORDER BY version',
  );
  return rows as { key: string; version: string | number; caused_by_action_id: string }[];
}
