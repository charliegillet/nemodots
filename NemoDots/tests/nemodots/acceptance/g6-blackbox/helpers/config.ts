// Gate 6 black-box harness: fixed port block, database/Redis namespacing and
// the safety guards every helper shares. Nothing here imports production code.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);

/** Port block reserved for this suite so other acceptance suites can run concurrently. */
export const G6 = {
  host: '127.0.0.1',
  checkoutPort: 4720,
  appPort: 4721,
  /** the provider pass-through proxy of provider-disruption trials */
  proxyPort: 4722,
  dbPrefix: 'acc6_',
  redisDb: 7,
  redisPrefixBase: 'nemodots:acc6',
} as const;

export const ROLE_ENV = {
  admin: 'NEMODOTS_PG_URL_ADMIN',
  app: 'NEMODOTS_PG_URL_APP',
  checkout: 'NEMODOTS_PG_URL_CHECKOUT',
  injector: 'NEMODOTS_PG_URL_INJECTOR',
  verifier: 'NEMODOTS_PG_URL_VERIFIER',
} as const;
export type Role = keyof typeof ROLE_ENV;

/** Thrown when an external prerequisite is missing: reported BLOCKED, never skipped. */
export class BlockedError extends Error {
  constructor(message: string) {
    super(`BLOCKED: ${message}`);
    this.name = 'BlockedError';
  }
}

/** Thrown when a production module or export the suite drives does not exist. */
export class EntryPointMissingError extends Error {
  constructor(entryPoint: string, reason: string) {
    super(
      `ENTRY POINT MISSING: ${entryPoint} (${reason}). Required by the g6-blackbox suite dependency list.`,
    );
    this.name = 'EntryPointMissingError';
  }
}

export function roleUrl(role: Role, env = process.env): string {
  const name = ROLE_ENV[role];
  const value = env[name];
  if (!value)
    throw new BlockedError(
      `${name} is not set; run through npm run test:nemodots:acceptance (stack.mjs exec) against an initialised, started NemoDots stack.`,
    );
  const parsed = new URL(value);
  if (parsed.port === '5432')
    throw new Error(`Refusing the user PostgreSQL on 5432 (${name}).`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    throw new Error(`${name} must point at a loopback host.`);
  return value;
}

export function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

export function redisBaseUrl(env = process.env): string {
  const raw = env.NEMODOTS_REDIS_URL;
  if (!raw)
    throw new BlockedError('NEMODOTS_REDIS_URL is not set (stack.mjs exec).');
  const parsed = new URL(raw);
  if (parsed.port === '6379')
    throw new Error('Refusing the user Redis on 6379.');
  return raw;
}

/** Same Redis server, database index 7. */
export function redisTrialUrl(env = process.env): string {
  const next = new URL(redisBaseUrl(env));
  next.pathname = `/${G6.redisDb}`;
  return next.toString();
}

export function probeSecret(env = process.env): string {
  const value = env.NEMODOTS_PROBE_SECRET;
  if (!value)
    throw new BlockedError(
      'NEMODOTS_PROBE_SECRET is not set (stack.mjs exec).',
    );
  return value;
}

/** Trial id -> database name `acc6_<id>` (lowercase, [a-z0-9_] only, <= 63 chars). */
export function trialDatabaseName(trialId: string): string {
  const name = `${G6.dbPrefix}${trialId.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  if (!/^acc6_[a-z0-9_]{1,50}$/.test(name))
    throw new Error(`Unsafe trial database name ${name}`);
  return name;
}

export function trialRedisPrefix(trialId: string): string {
  return `${G6.redisPrefixBase}:${trialId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export const checkoutBase = `http://${G6.host}:${G6.checkoutPort}`;
export const appBase = `http://${G6.host}:${G6.appPort}`;
export const apiBase = `${appBase}/api/nemodots`;

export function newOwnerToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Reads only OPENAI_BASE_URL from process.env or the gitignored NemoDots/.env.
 * Secrets are never read or logged by this suite: the app child loads them
 * itself and the proxy forwards the app's own Authorization header.
 */
export function upstreamBaseUrl(env = process.env): string | null {
  if (env.OPENAI_BASE_URL) return env.OPENAI_BASE_URL;
  const file = resolve(APP_ROOT, '.env');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*OPENAI_BASE_URL\s*=\s*(.*)\s*$/.exec(line);
    if (match) return match[1].replace(/^['"]|['"]$/g, '') || null;
  }
  return null;
}

export const SCRATCH = resolve(APP_ROOT, '.local/acceptance/g6');
