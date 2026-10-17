// Starts an isolated NemoDots composition for the Gate 7 suite on the
// acceptance port block: checkout API on 4740, OpenDots app on 4741, a fresh
// `acc7_<hex>` database on the NemoDots PostgreSQL (55432), Redis db 8 on 56379.
// Everything started here is stopped here; nothing else is touched.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { stackRoleUrls, withDatabase } from '../../../helpers/test-db.js';
import { testRedisUrl, unlinkByPrefix } from '../../../helpers/test-redis.js';
import { createClient } from 'redis';
import {
  APP_PORT,
  APP_ROOT,
  APP_URL,
  CHECKOUT_PORT,
  CHECKOUT_URL,
  DB_PREFIX,
  REDIS_DB_INDEX,
  SCRATCH,
  liveCredentials,
  readLocalSecrets,
  redact,
  registerSecret,
  sleep,
  until,
} from './env.js';

export type StackMode = 'blocked' | 'fixture' | 'live';

export interface StartOptions {
  mode: StackMode;
  /** Run the checkout API (default: true unless mode is blocked). */
  checkout?: boolean;
  /** Seed checkout data (default: same as checkout). */
  seed?: boolean;
  /** Give the app the Intelligence key from the local .env (default false). */
  intelligence?: boolean;
  /** Require this owner token on /api (a fresh random one when true). */
  ownerToken?: boolean;
  /** Extra non-secret env for the app process. */
  extraEnv?: Record<string, string>;
  /** Fixture file for mode fixture. */
  fixturePath?: string;
}

export class EntryPointMissing extends Error {
  constructor(what: string, detail: string) {
    super(
      `ENTRY POINT MISSING: ${what} (${detail}). Required by the Gate 7 suite; see docs/nemodots/ACCEPTANCE_CONTRACT.md.`,
    );
    this.name = 'EntryPointMissing';
  }
}

interface Managed {
  name: string;
  proc: ChildProcess;
  logPath: string;
}

function tail(path: string, lines = 40) {
  try {
    return redact(
      readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n'),
    );
  } catch {
    return '(no log)';
  }
}

const DEFAULT_FIXTURE = resolve(
  APP_ROOT,
  'tests/nemodots/fixtures/inference/text-completion.fixture.json',
);

/** The newest mtime under a directory (files only), or 0. */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

/**
 * The browser tests drive the built client served by the app. A missing or
 * stale build is a FAIL with an explicit reason, never a silent pass against
 * an old bundle.
 */
export function assertClientBuilt() {
  const page = resolve(APP_ROOT, 'src/client/nemodots/MissionPage.tsx');
  if (!existsSync(page))
    throw new EntryPointMissing(
      'src/client/nemodots/MissionPage.tsx',
      'the integrated mission page does not exist yet',
    );
  const index = resolve(APP_ROOT, 'dist/client/index.html');
  if (!existsSync(index))
    throw new Error(
      'CLIENT BUILD MISSING: dist/client/index.html does not exist; run `npm run build` (owner of node_modules/dist: the integrator).',
    );
  const built = statSync(index).mtimeMs;
  const source = newestMtime(resolve(APP_ROOT, 'src/client'));
  if (source > built + 1000)
    throw new Error(
      'CLIENT BUILD STALE: src/client is newer than dist/client; run `npm run build` before the Gate 7 browser tests.',
    );
}

export class Acc7Stack {
  readonly appUrl = APP_URL;
  readonly checkoutUrl = CHECKOUT_URL;
  readonly db: { name: string; urls: ReturnType<typeof stackRoleUrls> };
  readonly redisPrefix: string;
  readonly ownerToken: string | null;
  readonly mode: StackMode;
  private managed: Managed[] = [];
  private stopped = false;
  private readonly adminUrl: string;

  private constructor(
    options: StartOptions,
    db: { name: string; urls: ReturnType<typeof stackRoleUrls> },
    redisPrefix: string,
    adminUrl: string,
    private readonly probeSecret: string,
    private readonly runDir: string,
  ) {
    this.mode = options.mode;
    this.db = db;
    this.redisPrefix = redisPrefix;
    this.adminUrl = adminUrl;
    this.ownerToken = options.ownerToken
      ? randomBytes(18).toString('hex')
      : null;
    registerSecret(this.ownerToken ?? undefined);
  }

  static async start(options: StartOptions): Promise<Acc7Stack> {
    assertClientBuilt();
    mkdirSync(SCRATCH, { recursive: true });
    const base = stackRoleUrls();
    const name = `${DB_PREFIX}${randomBytes(6).toString('hex')}`;
    if (!new RegExp(`^${DB_PREFIX}[0-9a-f]+$`).test(name))
      throw new Error('invalid database name');
    const runDir = resolve(SCRATCH, name);
    mkdirSync(runDir, { recursive: true });
    const admin = new pg.Client({
      connectionString: base.admin,
      application_name: 'nemodots-acceptance-g7',
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name} OWNER nemodots_admin`);
    } finally {
      await admin.end();
    }
    const urls = Object.fromEntries(
      Object.entries(base).map(([role, url]) => [
        role,
        withDatabase(url, name),
      ]),
    ) as ReturnType<typeof stackRoleUrls>;
    for (const url of Object.values(urls)) registerSecret(url);
    const probeSecret = randomBytes(24).toString('hex');
    registerSecret(probeSecret);
    const stack = new Acc7Stack(
      options,
      { name, urls },
      `acc7:${randomBytes(6).toString('hex')}`,
      base.admin,
      probeSecret,
      runDir,
    );
    try {
      await stack.boot(options);
    } catch (error) {
      await stack.stop().catch(() => undefined);
      throw error;
    }
    return stack;
  }

  private redisUrl() {
    const url = new URL(testRedisUrl());
    url.pathname = `/${REDIS_DB_INDEX}`;
    return url.toString();
  }

  private baseEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LC_ALL: 'C',
      NODE_ENV: 'production',
      NEMODOTS_INSTANCE: process.env.NEMODOTS_INSTANCE ?? 'dev',
      NEMODOTS_PG_DATABASE: this.db.name,
      NEMODOTS_PG_URL_ADMIN: this.db.urls.admin,
      NEMODOTS_PG_URL_APP: this.db.urls.app,
      NEMODOTS_PG_URL_CHECKOUT: this.db.urls.checkout,
      NEMODOTS_PG_URL_INJECTOR: this.db.urls.injector,
      NEMODOTS_PG_URL_VERIFIER: this.db.urls.verifier,
      NEMODOTS_REDIS_URL: this.redisUrl(),
      NEMODOTS_REDIS_PREFIX: this.redisPrefix,
      NEMODOTS_CHECKOUT_PORT: String(CHECKOUT_PORT),
      NEMODOTS_CHECKOUT_URL: CHECKOUT_URL,
      NEMODOTS_PROBE_SECRET: this.probeSecret,
    };
  }

  private spawnManaged(
    name: string,
    entry: string,
    env: Record<string, string>,
    args: string[] = [],
  ): Managed {
    const logPath = resolve(this.runDir, `${name}.log`);
    const fd = openSync(logPath, 'a');
    const proc = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: APP_ROOT,
      env,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const managed = { name, proc, logPath };
    this.managed.push(managed);
    return managed;
  }

  private async runOnce(
    name: string,
    entry: string,
    env: Record<string, string>,
  ) {
    const abs = resolve(APP_ROOT, entry);
    if (!existsSync(abs))
      throw new EntryPointMissing(entry, 'file does not exist');
    const managed = this.spawnManaged(name, abs, env);
    const code = await new Promise<number | null>((done) =>
      managed.proc.once('exit', (c) => done(c)),
    );
    if (code !== 0)
      throw new Error(
        `${name} exited with code ${code}. Log tail:\n${tail(managed.logPath)}`,
      );
  }

  private async boot(options: StartOptions) {
    const { migrate } = (await import(
      resolve(APP_ROOT, 'src/server/nemodots/db/migrate.ts')
    )) as typeof import('../../../../../src/server/nemodots/db/migrate.js');
    await migrate({ connectionString: this.db.urls.admin });

    const wantCheckout = options.checkout ?? options.mode !== 'blocked';
    if (wantCheckout) {
      if (options.seed ?? true)
        await this.runOnce(
          'seed',
          'src/server/nemodots/sandbox/seed.ts',
          this.baseEnv(),
        );
      const checkoutEntry = resolve(
        APP_ROOT,
        'src/server/nemodots/sandbox/checkout-main.ts',
      );
      if (!existsSync(checkoutEntry))
        throw new EntryPointMissing(
          'src/server/nemodots/sandbox/checkout-main.ts',
          'file does not exist',
        );
      const env = this.baseEnv();
      // Finding I3: the checkout child gets only its own role URL.
      const checkoutEnv = {
        NEMODOTS_PG_URL_CHECKOUT: env.NEMODOTS_PG_URL_CHECKOUT!,
        NEMODOTS_REDIS_URL: env.NEMODOTS_REDIS_URL!,
        NEMODOTS_REDIS_PREFIX: env.NEMODOTS_REDIS_PREFIX!,
        NEMODOTS_CHECKOUT_PORT: env.NEMODOTS_CHECKOUT_PORT!,
        NEMODOTS_PROBE_SECRET: env.NEMODOTS_PROBE_SECRET!,
        LC_ALL: 'C',
        PATH: env.PATH!,
      };
      const checkout = this.spawnManaged(
        'checkout',
        checkoutEntry,
        checkoutEnv,
      );
      await until(
        `checkout API on ${CHECKOUT_URL}`,
        async () => {
          if (checkout.proc.exitCode !== null)
            throw new Error(
              `checkout exited. Log tail:\n${tail(checkout.logPath)}`,
            );
          const res = await fetch(`${CHECKOUT_URL}/health`).catch(() => null);
          return res !== null;
        },
        { timeoutMs: 30_000 },
      );
    }

    const appEnv: Record<string, string> = {
      ...this.baseEnv(),
      HOST: '127.0.0.1',
      PORT: String(APP_PORT),
      APP_ORIGIN: APP_URL,
      DATABASE_PATH: resolve(this.runDir, 'opendots.sqlite'),
      OWNER_ID: 'acc7-owner',
      DO_NOT_TRACK: '1',
      ...(this.ownerToken ? { OWNER_TOKEN: this.ownerToken } : {}),
      ...(options.extraEnv ?? {}),
    };
    if (options.intelligence) {
      const secrets = readLocalSecrets(['CPK_INTELLIGENCE_API_KEY']);
      if (!secrets.CPK_INTELLIGENCE_API_KEY)
        throw new Error(
          'BLOCKED: CPK_INTELLIGENCE_API_KEY is not available in NemoDots/.env; the Intelligence-dependent chat check cannot run.',
        );
      appEnv.CPK_INTELLIGENCE_API_KEY = secrets.CPK_INTELLIGENCE_API_KEY;
    }
    if (options.mode === 'live') {
      const creds = liveCredentials();
      if (!creds.ok)
        throw new Error(
          `BLOCKED: live mode needs ${creds.missing.join(', ')} (names only); Gate 7 live rows cannot run.`,
        );
      Object.assign(appEnv, creds.env, { NEMODOTS_INFERENCE_MODE: 'live' });
    } else if (options.mode === 'fixture') {
      Object.assign(appEnv, {
        NEMODOTS_INFERENCE_MODE: 'fixture',
        NEMODOTS_FIXTURE_PATH: options.fixturePath ?? DEFAULT_FIXTURE,
      });
    }
    // mode blocked: no OPENAI_*, no inference mode -> the server must report
    // blocked with the missing names.

    const entry = resolve(APP_ROOT, 'src/server/index.ts');
    const app = this.spawnManaged('app', entry, appEnv);
    await until(
      `app on ${APP_URL}`,
      async () => {
        if (app.proc.exitCode !== null)
          throw new Error(`app exited. Log tail:\n${tail(app.logPath)}`);
        const res = await fetch(`${APP_URL}/api/nemodots/health`, {
          headers: this.ownerToken
            ? { Authorization: `Bearer ${this.ownerToken}` }
            : {},
        }).catch(() => null);
        if (!res) return false;
        if (
          res.status === 404 ||
          !(res.headers.get('content-type') ?? '').includes('json')
        )
          throw new EntryPointMissing(
            'GET /api/nemodots/health',
            `app answered ${res.status} ${res.headers.get('content-type')}; /api/nemodots is not mounted`,
          );
        return true;
      },
      { timeoutMs: 60_000 },
    );
  }

  get authHeaders(): Record<string, string> {
    return this.ownerToken
      ? { Authorization: `Bearer ${this.ownerToken}` }
      : {};
  }

  logTail(name: 'app' | 'checkout' | 'seed') {
    return tail(resolve(this.runDir, `${name}.log`));
  }

  /** Stops what this object started and drops its database and Redis keys. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const { proc } of this.managed.reverse()) {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        const exited = await Promise.race([
          new Promise<boolean>((done) => proc.once('exit', () => done(true))),
          sleep(5000).then(() => false),
        ]);
        if (!exited) proc.kill('SIGKILL');
      }
    }
    const admin = new pg.Client({
      connectionString: this.adminUrl,
      application_name: 'nemodots-acceptance-g7',
    });
    try {
      await admin.connect();
      if (new RegExp(`^${DB_PREFIX}[0-9a-f]+$`).test(this.db.name))
        await admin.query(
          `DROP DATABASE IF EXISTS ${this.db.name} WITH (FORCE)`,
        );
    } finally {
      await admin.end().catch(() => undefined);
    }
    const redis = createClient({ url: this.redisUrl() });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      await unlinkByPrefix(redis as never, this.redisPrefix);
    } catch {
      // Redis already gone; nothing of ours to remove.
    } finally {
      redis.destroy();
    }
    rmSync(this.runDir, { recursive: true, force: true });
  }
}
