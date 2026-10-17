// Lifecycle of one system under test per trial: a fresh `acc6_<trial>`
// database on the NemoDots PostgreSQL, Redis database 7 under a trial prefix,
// the checkout API on 4720, the OpenDots app (with NemoDots) on 4721 and an
// optional separate worker process. Only processes started here are stopped.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  APP_ROOT,
  BlockedError,
  EntryPointMissingError,
  G6,
  ROLE_ENV,
  SCRATCH,
  apiBase,
  checkoutBase,
  probeSecret,
  redisTrialUrl,
  roleUrl,
  trialDatabaseName,
  trialRedisPrefix,
  withDatabase,
} from './config.js';
import { sleep } from './http.js';
import { unlinkTrialKeys } from './verifier-db.js';

/** Production modules this suite launches or imports. Reported together. */
export const ENTRY_FILES = {
  migrate: 'src/server/nemodots/db/migrate.ts',
  seed: 'src/server/nemodots/sandbox/seed.ts',
  checkoutMain: 'src/server/nemodots/sandbox/checkout-main.ts',
  versionAuthority: 'src/server/nemodots/sandbox/version-authority.ts',
  appServer: 'src/server/index.ts',
  bootstrap: 'src/server/nemodots/bootstrap.ts',
  workerMain: 'src/server/nemodots/worker-main.ts',
} as const;

export function assertEntryFiles(names: (keyof typeof ENTRY_FILES)[]) {
  const missing = names
    .filter((name) => !existsSync(resolve(APP_ROOT, ENTRY_FILES[name])))
    .map((name) => `${ENTRY_FILES[name]} (module file does not exist)`);
  if (missing.length)
    throw new EntryPointMissingError(
      missing.join(', '),
      'production wave not built yet',
    );
}

export async function importEntry<T = Record<string, unknown>>(
  name: keyof typeof ENTRY_FILES,
): Promise<T> {
  assertEntryFiles([name]);
  try {
    return (await import(
      /* @vite-ignore */ pathToFileURL(resolve(APP_ROOT, ENTRY_FILES[name]))
        .href
    )) as T;
  } catch (error) {
    throw new EntryPointMissingError(
      ENTRY_FILES[name],
      `module failed to load: ${(error as Error).message}`,
    );
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', () => resolvePort(false));
    server.listen(port, G6.host, () => server.close(() => resolvePort(true)));
  });
}

const PASS_THROUGH = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_URL',
  'NEMODOTS_PLANNER_MODEL',
  'NEMODOTS_WORKER_MODEL',
] as const;

function pick(names: readonly string[]) {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export interface SutOptions {
  trialId: string;
  ownerToken: string;
  /** OPENAI_BASE_URL override (the verifier proxy); otherwise the app's own .env applies. */
  providerBaseUrl?: string;
  /** Run the mission worker as a separate killable process (worker-crash trials). */
  separateWorker: boolean;
  /** default live; deterministic adapter scenarios use blocked so no inference is spent */
  inferenceMode?: 'live' | 'blocked';
  /** false = checkout sandbox only (no OpenDots app, no worker); default true */
  withApp?: boolean;
  /** extra environment for the app and worker (e.g. NEMODOTS_MUTATION, NEMODOTS_TEST_HOOKS) */
  extraEnv?: Record<string, string>;
  /** override of the Redis URL the app and worker use (a verifier-owned TCP proxy) */
  appRedisUrl?: string;
}

export class Sut {
  readonly database: string;
  readonly redisPrefix: string;
  private readonly dir: string;
  private readonly children = new Map<string, ChildProcess>();
  private created = false;
  private readerRole: string | null = null;
  private readerPassword: string | null = null;

  private constructor(readonly options: SutOptions) {
    this.database = trialDatabaseName(options.trialId);
    this.redisPrefix = trialRedisPrefix(options.trialId);
    this.dir = resolve(SCRATCH, this.database);
  }

  get roleEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [role, name] of Object.entries(ROLE_ENV))
      out[name] = withDatabase(
        roleUrl(role as keyof typeof ROLE_ENV),
        this.database,
      );
    return out;
  }

  /**
   * Only the roles ARCHITECTURE section 3 says the OpenDots server process
   * holds: app, injector and verifier. Never admin or checkout, and never the
   * harness reader role.
   */
  private get appRoleEnv(): Record<string, string> {
    const all = this.roleEnv;
    return {
      [ROLE_ENV.app]: all[ROLE_ENV.app],
      [ROLE_ENV.injector]: all[ROLE_ENV.injector],
      [ROLE_ENV.verifier]: all[ROLE_ENV.verifier],
    };
  }

  /** Connection string of the harness-only read-only role (not in any child's environment). */
  get readerUrl(): string {
    if (!this.readerRole || !this.readerPassword)
      throw new Error('reader role not provisioned');
    const url = new URL(withDatabase(roleUrl('admin'), this.database));
    url.username = this.readerRole;
    url.password = this.readerPassword;
    return url.toString();
  }

  private baseEnv(): Record<string, string> {
    const url = new URL(roleUrl('admin'));
    return {
      NEMODOTS_INSTANCE: process.env.NEMODOTS_INSTANCE ?? 'dev',
      NEMODOTS_PG_HOST: url.hostname,
      NEMODOTS_PG_PORT: url.port,
      NEMODOTS_PG_DATABASE: this.database,
      NEMODOTS_REDIS_URL: redisTrialUrl(),
      NEMODOTS_REDIS_PREFIX: this.redisPrefix,
      NEMODOTS_CHECKOUT_PORT: String(G6.checkoutPort),
      NEMODOTS_CHECKOUT_URL: checkoutBase,
      NEMODOTS_PROBE_SECRET: probeSecret(),
      DO_NOT_TRACK: '1',
    };
  }

  static async start(options: SutOptions): Promise<Sut> {
    assertEntryFiles([
      'migrate',
      'seed',
      'checkoutMain',
      'versionAuthority',
      ...(options.withApp === false
        ? []
        : (['appServer', 'bootstrap'] as const)),
      ...(options.separateWorker ? (['workerMain'] as const) : []),
    ]);
    for (const port of [G6.checkoutPort, G6.appPort])
      if (!(await portFree(port)))
        throw new BlockedError(
          `port ${port} of the g6 block is already in use`,
        );
    const sut = new Sut(options);
    mkdirSync(sut.dir, { recursive: true });
    await sut.createDatabase();
    try {
      await sut.migrate();
      await sut.runOnce('seed', ENTRY_FILES.seed, sut.fullEnv());
      await sut.provisionReader();
      sut.spawnChild('checkout', ENTRY_FILES.checkoutMain, {
        PATH: process.env.PATH ?? '',
        NEMODOTS_PG_URL_CHECKOUT: sut.roleEnv.NEMODOTS_PG_URL_CHECKOUT,
        NEMODOTS_REDIS_URL: redisTrialUrl(),
        NEMODOTS_REDIS_PREFIX: sut.redisPrefix,
        NEMODOTS_CHECKOUT_PORT: String(G6.checkoutPort),
        NEMODOTS_PROBE_SECRET: probeSecret(),
      });
      await sut.waitFor(`${checkoutBase}/health`, 60_000, 'checkout API');
      if (options.withApp !== false) {
        sut.spawnApp();
        await sut.waitForApp();
        // A separate worker is started by the caller, after it has proved that
        // the app process itself hosts no workers (NEMODOTS_WORKERS=0).
      }
    } catch (error) {
      await sut.stop();
      throw error;
    }
    return sut;
  }

  private fullEnv(): Record<string, string> {
    return { ...pick(PASS_THROUGH), ...this.baseEnv(), ...this.roleEnv };
  }

  private appEnv(): Record<string, string> {
    return {
      ...pick(PASS_THROUGH),
      ...this.baseEnv(),
      ...this.appRoleEnv,
      ...(this.options.appRedisUrl
        ? { NEMODOTS_REDIS_URL: this.options.appRedisUrl }
        : {}),
      ...(this.options.extraEnv ?? {}),
      HOST: G6.host,
      PORT: String(G6.appPort),
      OWNER_TOKEN: this.options.ownerToken,
      DATABASE_PATH: resolve(this.dir, 'opendots.sqlite'),
      NEMODOTS_INFERENCE_MODE: this.options.inferenceMode ?? 'live',
      WEB_SEARCH_PROVIDER: 'disabled',
      ...(this.options.providerBaseUrl
        ? { OPENAI_BASE_URL: this.options.providerBaseUrl }
        : {}),
      ...(this.options.separateWorker ? { NEMODOTS_WORKERS: '0' } : {}),
    };
  }

  private async createDatabase() {
    const admin = new pg.Client({
      connectionString: roleUrl('admin'),
      application_name: 'acc6-admin',
    });
    await admin.connect();
    try {
      const name = this.database;
      if (!/^acc6_[a-z0-9_]+$/.test(name))
        throw new Error('unsafe database name');
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${this.readerRoleName()}`);
      await admin.query(`CREATE DATABASE ${name} OWNER nemodots_admin`);
      this.created = true;
    } finally {
      await admin.end();
    }
  }

  private readerRoleName() {
    const name = this.database.replace(/^acc6_/, 'acc6_ro_');
    if (!/^acc6_ro_[a-z0-9_]{1,45}$/.test(name))
      throw new Error('unsafe reader role name');
    return name;
  }

  /**
   * A harness-only read-only role for invariant reads. It is created per trial,
   * granted SELECT on the checkout, ledger and coordinator schemas only, and
   * its password exists only in this process. Neither the app nor the worker
   * environment contains it, so "separate verifier credential" is literal.
   */
  private async provisionReader() {
    const role = this.readerRoleName();
    const password = randomBytes(18).toString('hex');
    const admin = new pg.Client({
      connectionString: withDatabase(roleUrl('admin'), this.database),
      application_name: 'acc6-admin',
    });
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${this.database} TO ${role}`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA checkout, ledger, coordinator TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA checkout, ledger, coordinator TO ${role}`,
      );
    } catch (error) {
      throw new BlockedError(
        `cannot provision the harness reader role (needs CREATEROLE on the admin role): ${(error as Error).message.replace(password, '<redacted>')}`,
      );
    } finally {
      await admin.end().catch(() => undefined);
    }
    this.readerRole = role;
    this.readerPassword = password;
  }

  private async migrate() {
    const mod = await importEntry<{
      migrate?: (o: { connectionString: string }) => Promise<unknown>;
    }>('migrate');
    if (typeof mod.migrate !== 'function')
      throw new EntryPointMissingError(
        `${ENTRY_FILES.migrate}#migrate`,
        'module has no such export',
      );
    await mod.migrate({ connectionString: this.roleEnv.NEMODOTS_PG_URL_ADMIN });
  }

  private logFd(name: string) {
    return openSync(resolve(this.dir, `${name}.log`), 'a');
  }

  private runOnce(name: string, file: string, env: Record<string, string>) {
    return new Promise<void>((resolveRun, reject) => {
      const fd = this.logFd(name);
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', resolve(APP_ROOT, file)],
        {
          cwd: APP_ROOT,
          env,
          stdio: ['ignore', fd, fd],
        },
      );
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolveRun()
          : reject(
              new Error(
                `${name} exited with code ${code} (see ${this.dir}/${name}.log)`,
              ),
            ),
      );
    });
  }

  private spawnChild(name: string, file: string, env: Record<string, string>) {
    const fd = this.logFd(name);
    const child = spawn(
      process.execPath,
      ['--env-file-if-exists=.env', '--import', 'tsx', resolve(APP_ROOT, file)],
      { cwd: APP_ROOT, env, stdio: ['ignore', fd, fd], detached: false },
    );
    this.children.set(name, child);
    return child;
  }

  private spawnApp() {
    this.spawnChild('app', ENTRY_FILES.appServer, this.appEnv());
  }

  startWorker() {
    return this.spawnChild('worker', ENTRY_FILES.workerMain, this.appEnv());
  }

  /** pid of a child this harness started (app, worker, checkout), or null. */
  pidOf(name: 'app' | 'worker' | 'checkout'): number | null {
    const child = this.children.get(name);
    return child && child.exitCode === null && child.pid ? child.pid : null;
  }

  /** SIGSTOP / SIGCONT / SIGKILL of a child this harness started (zombie-worker scenarios). */
  signal(name: 'app' | 'worker', signal: NodeJS.Signals): boolean {
    const child = this.children.get(name);
    if (!child || child.exitCode !== null) return false;
    return child.kill(signal);
  }

  /** SIGKILL the app (crash at a barrier) and wait for it to exit. */
  async killApp(): Promise<boolean> {
    const app = this.children.get('app');
    if (!app || app.exitCode !== null) return false;
    const exited = new Promise<void>((r) => app.once('exit', () => r()));
    app.kill('SIGKILL');
    await exited;
    this.children.delete('app');
    return true;
  }

  /** Restart the app against the same database and Redis prefix (recovery scenarios). */
  async restartApp(): Promise<void> {
    this.spawnApp();
    await this.waitForApp();
  }

  /** Kills only the separate worker process this harness started. */
  async killWorker(): Promise<boolean> {
    const worker = this.children.get('worker');
    if (!worker || worker.exitCode !== null) return false;
    const exited = new Promise<void>((r) => worker.once('exit', () => r()));
    worker.kill('SIGKILL');
    await exited;
    this.children.delete('worker');
    return true;
  }

  private async waitFor(
    url: string,
    timeoutMs: number,
    label: string,
    headers?: Record<string, string>,
  ) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      for (const [name, child] of this.children)
        if (child.exitCode !== null)
          throw new Error(
            `${name} exited early with code ${child.exitCode} (see ${this.dir}/${name}.log)`,
          );
      try {
        const response = await fetch(url, { headers });
        await response.arrayBuffer();
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = (error as Error).message;
      }
      await sleep(500);
    }
    throw new Error(`${label} not ready within ${timeoutMs} ms (${last})`);
  }

  private waitForApp() {
    return this.waitFor(`${apiBase}/health`, 90_000, 'NemoDots app', {
      authorization: `Bearer ${this.options.ownerToken}`,
    });
  }

  async stop(): Promise<void> {
    for (const [name, child] of [...this.children].reverse()) {
      if (child.exitCode === null) {
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
        await exited;
        clearTimeout(timer);
      }
      this.children.delete(name);
    }
    try {
      await unlinkTrialKeys(this.redisPrefix);
    } catch {
      /* Redis may be the thing under test */
    }
    if (this.created) {
      const admin = new pg.Client({
        connectionString: roleUrl('admin'),
        application_name: 'acc6-admin',
      });
      try {
        await admin.connect();
        await admin.query(
          `DROP DATABASE IF EXISTS ${this.database} WITH (FORCE)`,
        );
        await admin.query(`DROP ROLE IF EXISTS ${this.readerRoleName()}`);
      } catch {
        /* leftover acc6_ databases are removed on the next start */
      } finally {
        await admin.end().catch(() => undefined);
      }
      this.created = false;
    }
    if (process.env.ACC6_KEEP_LOGS !== '1')
      rmSync(resolve(this.dir, 'opendots.sqlite'), { force: true });
  }
}
