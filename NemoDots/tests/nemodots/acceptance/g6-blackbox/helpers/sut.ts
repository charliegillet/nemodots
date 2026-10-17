// Lifecycle of one system under test per trial: a fresh `acc6_<trial>`
// database on the NemoDots PostgreSQL, Redis database 7 under a trial prefix,
// the checkout API on 4720, the OpenDots app (with NemoDots) on 4721 and an
// optional separate worker process. Only processes started here are stopped.
import { spawn, type ChildProcess } from 'node:child_process';
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
}

export class Sut {
  readonly database: string;
  readonly redisPrefix: string;
  private readonly dir: string;
  private readonly children = new Map<string, ChildProcess>();
  private created = false;

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
      'appServer',
      'bootstrap',
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
      sut.spawnChild('checkout', ENTRY_FILES.checkoutMain, {
        PATH: process.env.PATH ?? '',
        NEMODOTS_PG_URL_CHECKOUT: sut.roleEnv.NEMODOTS_PG_URL_CHECKOUT,
        NEMODOTS_REDIS_URL: redisTrialUrl(),
        NEMODOTS_REDIS_PREFIX: sut.redisPrefix,
        NEMODOTS_CHECKOUT_PORT: String(G6.checkoutPort),
        NEMODOTS_PROBE_SECRET: probeSecret(),
      });
      await sut.waitFor(`${checkoutBase}/health`, 60_000, 'checkout API');
      sut.spawnApp();
      await sut.waitForApp();
      if (options.separateWorker) sut.startWorker();
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
      ...this.fullEnv(),
      HOST: G6.host,
      PORT: String(G6.appPort),
      OWNER_TOKEN: this.options.ownerToken,
      DATABASE_PATH: resolve(this.dir, 'opendots.sqlite'),
      NEMODOTS_INFERENCE_MODE: 'live',
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
      await admin.query(`CREATE DATABASE ${name} OWNER nemodots_admin`);
      this.created = true;
    } finally {
      await admin.end();
    }
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
