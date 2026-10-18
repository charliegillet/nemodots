// Shared support for the browser end-to-end suites: where the dedicated ci-e2e
// stack lives, a launcher for the BUILT server (one process per scenario, each
// with its own owner id so scenarios never see each other's missions), the
// system-Chrome launcher, evidence capture and the secret scan.
//
// Nothing here prints a secret. Secrets are read only to be searched for.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';

export const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
export const INSTANCE = process.env.NEMODOTS_INSTANCE ?? '';
const FORBIDDEN_PORTS = new Set([5432, 6379, 55432, 56379]);
export const E2E_DIR = path.join(
  APP_ROOT,
  '.local',
  INSTANCE || 'ci-e2e',
  'e2e',
);
export const SHOT_DIR = path.join(E2E_DIR, 'screens');
const SERVER_ENTRY = path.join(
  APP_ROOT,
  'dist',
  'server',
  'server',
  'index.js',
);

/** The suite only ever runs against a dedicated ci-* stack. */
export function assertCiStack(): void {
  if (!/^ci-[a-z0-9-]+$/.test(INSTANCE))
    throw new Error(
      `BLOCKED: NEMODOTS_INSTANCE must name a ci-* instance (got "${INSTANCE || 'unset'}"); run through npm run test:nemodots:e2e`,
    );
  for (const name of [
    'NEMODOTS_PG_PORT',
    'NEMODOTS_REDIS_PORT',
    'NEMODOTS_CHECKOUT_PORT',
  ]) {
    const port = Number(process.env[name]);
    if (!Number.isInteger(port) || FORBIDDEN_PORTS.has(port))
      throw new Error(`BLOCKED: ${name} must be set to a dedicated port`);
  }
}

// ----------------------------------------------------------------- secrets

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

/** Values from the repository .env for the named variables (empty ones omitted). */
export function dotenv(names: readonly string[]): Record<string, string> {
  const all = parseEnvFile(path.join(APP_ROOT, '.env'));
  const picked: Record<string, string> = {};
  for (const name of names) if (all[name]) picked[name] = all[name];
  return picked;
}

const SECRET_NAMES = [
  'OPENAI_API_KEY',
  'INTELLIGENCE_API_KEY',
  'CPK_INTELLIGENCE_API_KEY',
  'OWNER_TOKEN',
  'COMPOSIO_API_KEY',
  'PARALLEL_API_KEY',
];

/** Every secret value this run could have held, for the scan. Never logged. */
export function secretValues(extra: readonly string[] = []): string[] {
  const values = new Set<string>(extra.filter((v) => v.length >= 8));
  const fromEnv = dotenv(SECRET_NAMES);
  for (const value of Object.values(fromEnv))
    if (value.length >= 8) values.add(value);
  const roles = parseEnvFile(
    path.join(APP_ROOT, '.local', INSTANCE, 'stack', 'roles.env'),
  );
  for (const [name, value] of Object.entries(roles)) {
    if (!/PASSWORD|SECRET|TOKEN|URL/i.test(name)) continue;
    if (value.length >= 8) values.add(value);
    // the password inside a connection URL is a secret on its own
    const inUrl = /:\/\/[^:/@]+:([^@]+)@/.exec(value);
    if (inUrl && inUrl[1].length >= 8) values.add(inUrl[1]);
  }
  return [...values];
}

// ------------------------------------------------------------------ chrome

export const CHROME_MISSING = 'BLOCKED: Google Chrome not found';

export async function launchChrome(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    console.error(CHROME_MISSING);
    throw new Error(CHROME_MISSING);
  }
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Console errors and failed requests seen so far. */
  problems: string[];
  close(): Promise<void>;
}

export async function openSession(
  baseURL: string,
  options: {
    token?: string;
    viewport?: { width: number; height: number };
  } = {},
): Promise<Session> {
  const browser = await launchChrome();
  const context = await browser.newContext({
    baseURL,
    viewport: options.viewport ?? { width: 1360, height: 900 },
  });
  if (options.token) {
    // The unlock form stores the token in sessionStorage; seeding it here is
    // the same state the form leaves behind. It never goes into a URL.
    await context.addInitScript((token) => {
      try {
        sessionStorage.setItem('opendots-token', token);
      } catch {
        /* storage unavailable */
      }
    }, options.token);
  }
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return {
    browser,
    context,
    page,
    problems,
    async close() {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

// --------------------------------------------------------------- evidence

/**
 * Saves a screenshot plus the page's rendered text and DOM next to it, so the
 * secret scan covers what a person could read, not only the pixels.
 */
export async function shot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const base = path.join(SHOT_DIR, name.replace(/[^a-z0-9._-]/gi, '_'));
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  fs.writeFileSync(`${base}.txt`, await page.locator('body').innerText());
  fs.writeFileSync(`${base}.html`, await page.content());
  return `${base}.png`;
}

export interface ScanResult {
  files: number;
  hits: string[];
}

/** Names (never contents) of files under `dir` that contain any secret value. */
export function scanForSecrets(
  dir: string,
  secrets: readonly string[],
): ScanResult {
  const result: ScanResult = { files: 0, hits: [] };
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else {
        result.files += 1;
        const bytes = fs.readFileSync(full);
        for (const secret of secrets)
          if (bytes.includes(Buffer.from(secret))) {
            result.hits.push(path.relative(APP_ROOT, full));
            break;
          }
      }
    }
  };
  if (fs.existsSync(dir)) visit(dir);
  return result;
}

// ----------------------------------------------------------------- servers

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface ServerOptions {
  /** Short label used for the log and sqlite file names. */
  name: string;
  ownerId: string;
  /** Becomes OWNER_TOKEN; scenarios that test the lock set it. */
  ownerToken?: string;
  /** Environment for the server, on top of the stack's NEMODOTS_* values. */
  env?: Record<string, string>;
  /** Reuse a port (to restart a server where it was). Default: a free one. */
  port?: number;
  /** Keep the log file of an earlier run of the same name (append). */
  appendLog?: boolean;
}

export interface RunningServer {
  url: string;
  port: number;
  ownerId: string;
  logFile: string;
  stop(): Promise<void>;
  /** SIGKILL: the process vanishes without shutting anything down. */
  kill(): Promise<void>;
}

const INHERITED = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NEMODOTS_INSTANCE',
  'NEMODOTS_PG_HOST',
  'NEMODOTS_PG_PORT',
  'NEMODOTS_PG_DATABASE',
  'NEMODOTS_REDIS_PORT',
  'NEMODOTS_REDIS_URL',
  'NEMODOTS_REDIS_PREFIX',
  'NEMODOTS_CHECKOUT_PORT',
  'NEMODOTS_CHECKOUT_URL',
  'NEMODOTS_PG_URL_APP',
  'NEMODOTS_PG_URL_INJECTOR',
  'NEMODOTS_PG_URL_VERIFIER',
  'NEMODOTS_PROBE_SECRET',
];

/**
 * Starts the built server on a free port with a minimal, explicit environment:
 * the stack's own values, no inherited provider or Intelligence keys, and
 * whatever the scenario adds. Stops with SIGTERM (the server's own shutdown).
 */
export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  if (!fs.existsSync(SERVER_ENTRY))
    throw new Error('BLOCKED: dist/ is missing; run npm run build first');
  fs.mkdirSync(E2E_DIR, { recursive: true });
  const port = options.port ?? (await freePort());
  const logFile = path.join(E2E_DIR, `${options.name}.server.log`);
  const sqlite = path.join(E2E_DIR, `${options.name}.sqlite`);
  if (!options.appendLog)
    for (const suffix of ['', '-wal', '-shm'])
      fs.rmSync(`${sqlite}${suffix}`, { force: true });
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    OWNER_ID: options.ownerId,
    DATABASE_PATH: sqlite,
    NEMODOTS_WATCH_INTERVAL_MS: '1000',
    NODE_ENV: 'production',
    DO_NOT_TRACK: '1',
    ...(options.ownerToken ? { OWNER_TOKEN: options.ownerToken } : {}),
    ...options.env,
  });
  const log = fs.openSync(logFile, options.appendLog ? 'a' : 'w');
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const url = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = options.ownerToken
    ? { authorization: `Bearer ${options.ownerToken}` }
    : {};
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited)
      throw new Error(`server ${options.name} exited early (see ${logFile})`);
    try {
      const health = await fetch(`${url}/api/nemodots/health`, { headers });
      if (health.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server ${options.name} did not become ready`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    url,
    port,
    ownerId: options.ownerId,
    logFile,
    async kill() {
      if (exited) return;
      const gone = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await gone;
    },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      const gone = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await gone;
      clearTimeout(timer);
    },
  };
}

// ------------------------------------------------------------------- misc

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a value or the timeout passes. */
export async function until<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export function ownerId(label: string): string {
  return `e2e-${label}-${Math.random().toString(16).slice(2, 8)}`;
}

export function fixtureFile(name: string): string {
  fs.mkdirSync(E2E_DIR, { recursive: true });
  const file = path.join(E2E_DIR, `${name}.fixture.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: 'nemodots.inference.fixture.v1',
      label: 'e2e: no recorded responses',
      provenance: 'hand-authored',
      host: 'fixture.local',
      models: ['fixture-model'],
      entries: [],
    }),
  );
  return file;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** Node-side API call against a running server (the browser uses the app's own client). */
export async function apiCall(
  server: { url: string },
  route: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const method = options.method ?? 'GET';
  const response = await fetch(`${server.url}/api${route}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(method === 'GET' || options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, headers: response.headers };
}

/** A read against PostgreSQL as the admin role, for facts the API does not expose. */
export async function adminRows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = process.env.NEMODOTS_PG_URL_ADMIN;
  if (!url) throw new Error('BLOCKED: NEMODOTS_PG_URL_ADMIN is not set');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on('error', () => undefined);
  try {
    return (await pool.query<T>(sql, params)).rows;
  } finally {
    await pool.end();
  }
}
