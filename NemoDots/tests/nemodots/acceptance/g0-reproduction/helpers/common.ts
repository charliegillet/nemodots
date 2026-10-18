// Shared helpers for the gate 0 (reproduction) acceptance suite.
// Independent of production code: it parses roles.env itself and never prints
// a value. Messages carry variable names, paths and counts only.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
export const WORKTREE_ROOT = path.resolve(APP_ROOT, '..');
export const SCRATCH = path.join(APP_ROOT, '.local', 'acceptance', 'g0');

// Port block assigned to this suite so gate suites can run concurrently.
export const CHECKOUT_PORT = 4600;
export const APP_PORT = 4601;
export const DB_PREFIX = 'acc0_';
export const REDIS_DB_INDEX = 1;
export const REDIS_PREFIX = 'acc0:g0';
export const NAME_PATTERN = /^acc0_[0-9a-f]+$/;

export const ROLES = [
  'admin',
  'app',
  'checkout',
  'injector',
  'verifier',
] as const;
export type Role = (typeof ROLES)[number];

export function ensureScratch(sub = '') {
  const dir = path.join(SCRATCH, sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
export const sha256File = (file: string) => sha256(readFileSync(file));

export function parseEnvText(text: string) {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[name] = value;
  }
  return out;
}

export interface StackInstance {
  name: string;
  pgPort: number;
  redisPort: number;
  roleUrls: Record<Role, string>;
  probeSecret: string;
}

const FORBIDDEN_PORTS = new Set([5432, 6379]);

/** A port from the environment, or the default when unset; never the user's 5432/6379. */
function stackPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a port number.`);
  if (FORBIDDEN_PORTS.has(port))
    throw new Error(`${name}=${port} is reserved for the user's own services.`);
  return port;
}

/**
 * Finds the NemoDots stack instance listening on the shared block
 * (PostgreSQL NEMODOTS_PG_PORT, default 55432; Redis NEMODOTS_REDIS_PORT,
 * default 56379). NEMODOTS_INSTANCE wins; otherwise the sorted first
 * instance under .local whose recorded ports match.
 */
export function loadStack(): StackInstance {
  const pgPort = stackPort('NEMODOTS_PG_PORT', 55432);
  const redisPort = stackPort('NEMODOTS_REDIS_PORT', 56379);
  const local = path.join(APP_ROOT, '.local');
  const wanted = process.env.NEMODOTS_INSTANCE;
  const names = wanted
    ? [wanted]
    : readdirSync(local)
        .filter((n) =>
          existsSync(path.join(local, n, 'stack', 'instance.json')),
        )
        .sort((a, b) => (a === 'dev' ? -1 : b === 'dev' ? 1 : a < b ? -1 : 1));
  for (const name of names) {
    const meta = path.join(local, name, 'stack', 'instance.json');
    const rolesFile = path.join(local, name, 'stack', 'roles.env');
    if (!existsSync(meta) || !existsSync(rolesFile)) continue;
    const info = JSON.parse(readFileSync(meta, 'utf8')) as {
      pgPort: number;
      redisPort: number;
    };
    if (info.pgPort !== pgPort || info.redisPort !== redisPort) continue;
    if (statSync(rolesFile).mode & 0o077)
      throw new Error(`roles.env of instance ${name} must have mode 0600.`);
    const env = parseEnvText(readFileSync(rolesFile, 'utf8'));
    const roleUrls = {} as Record<Role, string>;
    for (const role of ROLES) {
      const key = `NEMODOTS_PG_URL_${role.toUpperCase()}`;
      if (!env[key]) throw new Error(`${key} missing from roles.env.`);
      roleUrls[role] = env[key];
    }
    if (!env.NEMODOTS_PROBE_SECRET)
      throw new Error('NEMODOTS_PROBE_SECRET missing from roles.env.');
    return {
      name,
      pgPort: info.pgPort,
      redisPort: info.redisPort,
      roleUrls,
      probeSecret: env.NEMODOTS_PROBE_SECRET,
    };
  }
  throw new Error(
    `No NemoDots stack instance on PostgreSQL ${pgPort} / Redis ${redisPort} found under .local (run \`npm run nemodots:stack -- init\` and \`start\`).`,
  );
}

export function withDb(url: string, database: string) {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

/** Redacts every known secret value from text before it is stored or shown. */
export function makeRedactor(secrets: string[]) {
  const list = secrets.filter((s) => s.length >= 8);
  return (text: string) => {
    let out = text;
    for (const s of list) out = out.split(s).join('[REDACTED]');
    return out;
  };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
  timedOut: boolean;
  logFile: string;
  tail: string;
}

/** Runs a command to completion, appending redacted output to a log file. */
export function run(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    logName: string;
    timeoutMs: number;
    redact?: (t: string) => string;
  },
): Promise<RunResult> {
  const redact = options.redact ?? ((t: string) => t);
  const logFile = path.join(ensureScratch('logs'), options.logName);
  writeFileSync(logFile, `$ ${command} ${args.join(' ')}\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    let timedOut = false;
    const onData = (chunk: Buffer) => {
      const text = redact(chunk.toString('utf8'));
      appendFileSync(logFile, text);
      tail = (tail + text).slice(-4000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        ms: Date.now() - started,
        timedOut,
        logFile,
        tail,
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      appendFileSync(logFile, `spawn error: ${error.message}\n`);
      resolve({
        code: 127,
        signal: null,
        ms: Date.now() - started,
        timedOut,
        logFile,
        tail: error.message,
      });
    });
  });
}

export interface ManagedProcess {
  child: ChildProcess;
  logFile: string;
  output(): string;
  exited(): boolean;
  stop(): Promise<void>;
}

/** Starts a long-running process this suite owns; stop() ends only that pid. */
export function startManaged(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    logName: string;
    redact?: (t: string) => string;
  },
): ManagedProcess {
  const redact = options.redact ?? ((t: string) => t);
  const logFile = path.join(ensureScratch('logs'), options.logName);
  writeFileSync(logFile, `$ ${command} ${args.join(' ')}\n`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let done = false;
  const onData = (chunk: Buffer) => {
    const text = redact(chunk.toString('utf8'));
    appendFileSync(logFile, text);
    output = (output + text).slice(-8000);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', () => {
    done = true;
  });
  child.on('error', (e) => {
    output += `spawn error: ${e.message}`;
    done = true;
  });
  return {
    child,
    logFile,
    output: () => output,
    exited: () => done,
    async stop() {
      if (done) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 8000;
      while (!done && Date.now() < deadline) await sleep(100);
      if (!done) child.kill('SIGKILL');
      while (!done) await sleep(50);
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function portIsFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function waitForHttp(
  url: string,
  proc: ManagedProcess,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (proc.exited())
      throw new Error(`process exited early: ${proc.output()}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${url} not reachable within ${timeoutMs} ms (${last})`);
}

/** Minimal environment so nothing from the developer shell leaks into a probe. */
export function cleanEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LC_ALL: 'C',
    LANG: 'C',
    DO_NOT_TRACK: '1',
    SCARF_ANALYTICS: 'false',
    ...extra,
  };
}

export function appendManifest(entry: Record<string, unknown>) {
  const file = path.join(ensureScratch(), 'run-manifest.ndjson');
  appendFileSync(
    file,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  );
}
