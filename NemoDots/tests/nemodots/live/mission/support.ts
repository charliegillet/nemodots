// Support for the live mission suites: a dedicated `live-<rand>` stack
// instance on free ports (never 5432/6379, never `dev`), the three OPENAI
// names loaded into THIS process from .env, the BLOCKED gate, and redacted
// result files. Nothing here prints a value from .env or roles.env.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { readRolesFile } from '../../../../src/server/nemodots/config/roles-file.js';
import { resolveMode } from '../../../../src/server/nemodots/inference/mode.js';

export const APP_ROOT = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
);
const NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
const SECRET_NAMES = ['OPENAI_API_KEY'];

export function loadDotEnv() {
  const file = path.join(APP_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !NAMES.includes(match[1])) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** Prints BLOCKED and throws (never skips) when live requirements are unmet. */
export function requireLive() {
  loadDotEnv();
  const mode = resolveMode(process.env);
  if (mode.mode !== 'live') {
    const names = [
      ...(mode.mode === 'blocked'
        ? [...mode.missingEnv, ...mode.invalidEnv]
        : []),
    ];
    const message = `BLOCKED: ${names.join(', ') || 'live mode'} missing`;
    console.error(message);
    throw new Error(message);
  }
  return mode;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

export interface LiveInstance {
  name: string;
  env: Record<string, string>;
  ports: { pg: number; redis: number; checkout: number };
  stack(...args: string[]): { status: number; output: string };
  run(entry: string): { status: number; output: string };
  stop(): void;
}

export async function startLiveInstance(): Promise<LiveInstance> {
  const name = `live-${randomBytes(3).toString('hex')}`;
  const ports = {
    pg: await freePort(),
    redis: await freePort(),
    checkout: await freePort(),
  };
  const base = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NEMODOTS_INSTANCE: name,
    NEMODOTS_PG_PORT: String(ports.pg),
    NEMODOTS_REDIS_PORT: String(ports.redis),
    NEMODOTS_CHECKOUT_PORT: String(ports.checkout),
  };
  const exec = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [path.join('scripts', 'nemodots', 'stack.mjs'), ...args],
      { cwd: APP_ROOT, env: { ...base, DO_NOT_TRACK: '1' }, encoding: 'utf8' },
    );
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-2000),
    };
  };
  const must = (label: string, result: { status: number; output: string }) => {
    if (result.status !== 0)
      throw new Error(
        `${label} failed (exit ${result.status}): ${result.output}`,
      );
  };
  must('init', exec(['init']));
  must('start', exec(['start']));
  must('migrate', exec(['run', 'src/server/nemodots/db/migrate.ts']));
  must('seed', exec(['run', 'src/server/nemodots/sandbox/seed.ts']));
  const roles = readRolesFile(APP_ROOT, name);
  return {
    name,
    ports,
    env: {
      ...base,
      ...roles,
      NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${ports.checkout}`,
      NEMODOTS_REDIS_URL: `redis://127.0.0.1:${ports.redis}/0`,
      NEMODOTS_REDIS_PREFIX: `nemodots:${name}`,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
      OPENAI_MODEL: process.env.OPENAI_MODEL ?? '',
    },
    stack: (...args) => exec(args),
    run: (entry) => exec(['run', entry]),
    stop() {
      exec(['stop']);
      rmSync(path.join(APP_ROOT, '.local', name), {
        recursive: true,
        force: true,
      });
    },
  };
}

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'NOT_MET' | 'NOT_RUN';
  observed?: Record<string, unknown>;
  note?: string;
}

/** Writes the redacted results; refuses to leave a file containing a secret value. */
export function writeResults(
  suite: string,
  instance: string,
  status: 'PASS' | 'FAIL' | 'BLOCKED',
  checks: Check[],
) {
  const dir = path.join(APP_ROOT, '.local', 'dev', 'live');
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ suite, instance, at: new Date().toISOString(), status, checks }, null, 2)}\n`;
  for (const name of SECRET_NAMES) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 6 && text.includes(value))
      throw new Error('secret found in live results; file not written');
  }
  writeFileSync(path.join(dir, `mission-${suite}.json`), text, { mode: 0o600 });
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** A redacted picture of where a mission is stuck: statuses, counts and error classes only. */
export async function diagnose(
  pool: {
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  missionId: string,
) {
  const q = async (text: string) => (await pool.query(text, [missionId])).rows;
  return {
    mission: await q(
      `SELECT status, transition_version, generation, left(coalesce(failure_reason, ''), 160) AS failure_reason
         FROM coordinator.missions WHERE id = $1`,
    ),
    attemptFailures: await q(
      `SELECT status, abort_reason, left(coalesce(failure_reason, ''), 200) AS failure_reason
         FROM coordinator.task_attempts WHERE mission_id = $1 AND (failure_reason IS NOT NULL OR abort_reason IS NOT NULL)
        ORDER BY started_at LIMIT 12`,
    ),
    modelCalls: await q(
      `SELECT role, outcome, count(*)::int AS n FROM ledger.model_call_records WHERE mission_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    tasks: await q(
      `SELECT role, status, count(*)::int AS n FROM coordinator.tasks WHERE mission_id = $1 GROUP BY role, status ORDER BY role, status`,
    ),
    attempts: await q(
      `SELECT status, kind, (lease_expires_at < now()) AS lease_expired, count(*)::int AS n
         FROM coordinator.task_attempts WHERE mission_id = $1 GROUP BY 1, 2, 3 ORDER BY 1, 2`,
    ),
    outbox: await q(
      `SELECT topic, attempts, (processed_at IS NOT NULL) AS processed, (failed_at IS NOT NULL) AS failed,
              left(coalesce(last_error, ''), 120) AS last_error
         FROM coordinator.outbox WHERE mission_id = $1 OR mission_id IS NULL ORDER BY id DESC LIMIT 15`,
    ),
    invalidations: await q(
      `SELECT source_key, reason, self_write, (resolved_at IS NOT NULL) AS resolved
         FROM ledger.invalidation_events WHERE mission_ids ? $1::text ORDER BY created_at`,
    ),
    recoveries: await q(
      `SELECT kind, count(*)::int AS n FROM coordinator.recovery_events WHERE mission_id = $1 GROUP BY kind ORDER BY kind`,
    ),
    lastEvents: await q(
      `SELECT id, kind FROM coordinator.events WHERE mission_id = $1 ORDER BY id DESC LIMIT 8`,
    ),
  };
}
