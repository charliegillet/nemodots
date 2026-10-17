// Typed NEMODOTS_* environment parsing (ARCHITECTURE.md section 12).
//
// Rules enforced here:
// - Error messages name variables, never values (URLs carry role passwords).
// - The user's own PostgreSQL (5432) and Redis (6379) are refused everywhere:
//   as explicit ports and as URL ports, including URLs that omit the port and
//   would therefore fall back to those defaults.
// - There is no default OPENAI_BASE_URL (finding I1). Live mode needs all of
//   OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL; missing names are
//   reported, a provider host is never invented.

export const PG_ROLES = [
  'admin',
  'app',
  'checkout',
  'injector',
  'verifier',
] as const;
export type PgRole = (typeof PG_ROLES)[number];

export const FORBIDDEN_PORTS: readonly number[] = [5432, 6379];
export const DEFAULT_PG_PORT = 55432;
export const DEFAULT_REDIS_PORT = 56379;
export const DEFAULT_CHECKOUT_PORT = 4510;

export const LIVE_ENV_NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const;
export type LiveEnvName = (typeof LIVE_ENV_NAMES)[number];

export const INFERENCE_MODES = ['live', 'fixture', 'blocked'] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];

type Env = Record<string, string | undefined>;

export class NemoDotsEnvError extends Error {
  readonly names: string[];
  constructor(names: string[], message: string) {
    super(message);
    this.name = 'NemoDotsEnvError';
    this.names = names;
  }
}

export function pgUrlEnvName(role: PgRole) {
  return `NEMODOTS_PG_URL_${role.toUpperCase()}`;
}

export interface NemoDotsConfig {
  instance: string;
  pg: {
    host: string;
    port: number;
    database: string;
    urls: Partial<Record<PgRole, string>>;
  };
  redis: { url: string; prefix: string };
  checkout: { port: number; url: string };
  probe: { secret?: string; windowMs: number };
  inference: {
    requestedMode: InferenceMode;
    fixturePath?: string;
    maxInFlight: number;
    plannerModel?: string;
    workerModel?: string;
  };
  leaseMs: number;
  dispatchLeaseMs: number;
  maxTasks: number;
  maxDepth: number;
  watchIntervalMs: number;
  workers: number;
  incidentDotIds: string[];
  testHooks: string[];
}

function text(env: Env, name: string) {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = text(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw))
    throw new NemoDotsEnvError([name], `${name} must be an integer.`);
  const value = Number(raw);
  if (value < min || value > max)
    throw new NemoDotsEnvError(
      [name],
      `${name} must be between ${min} and ${max}.`,
    );
  return value;
}

export function assertAllowedPort(name: string, port: number) {
  if (FORBIDDEN_PORTS.includes(port))
    throw new NemoDotsEnvError(
      [name],
      `${name} uses port ${port}, which belongs to the user's own PostgreSQL/Redis; NemoDots refuses it.`,
    );
}

function port(env: Env, name: string, fallback: number) {
  const value = integer(env, name, fallback, 1, 65535);
  assertAllowedPort(name, value);
  return value;
}

function parseUrl(name: string, value: string, protocols: string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NemoDotsEnvError([name], `${name} is not a valid URL.`);
  }
  if (!protocols.includes(url.protocol))
    throw new NemoDotsEnvError(
      [name],
      `${name} must use ${protocols.join(' or ')}.`,
    );
  return url;
}

const OVERRIDING_QUERY_KEYS = ['host', 'port', 'hostaddr', 'service'];

/** Validates a PostgreSQL URL without ever echoing it. Returns its port. */
export function assertSafePgUrl(name: string, value: string) {
  const url = parseUrl(name, value, ['postgres:', 'postgresql:']);
  // pg (pg-connection-string) lets ?host=, ?port=, ?hostaddr= and ?service=
  // override the authority, which would bypass the port check below. Refuse
  // them rather than re-implement the parser's precedence rules.
  for (const key of url.searchParams.keys()) {
    if (OVERRIDING_QUERY_KEYS.includes(key.toLowerCase()))
      throw new NemoDotsEnvError(
        [name],
        `${name} must not carry a ${key} query parameter; put the host and port in the URL authority.`,
      );
  }
  const urlPort = url.port ? Number(url.port) : 5432;
  assertAllowedPort(name, urlPort);
  if (!url.hostname)
    throw new NemoDotsEnvError([name], `${name} must name a host.`);
  return { port: urlPort, host: url.hostname, database: url.pathname.slice(1) };
}

/** Validates a Redis URL without ever echoing it. Returns its port. */
export function assertSafeRedisUrl(name: string, value: string) {
  const url = parseUrl(name, value, ['redis:', 'rediss:']);
  const urlPort = url.port ? Number(url.port) : 6379;
  assertAllowedPort(name, urlPort);
  return { port: urlPort, host: url.hostname };
}

const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function parseNemoDotsEnv(env: Env = process.env): NemoDotsConfig {
  const instance = text(env, 'NEMODOTS_INSTANCE') ?? 'dev';
  if (!INSTANCE_PATTERN.test(instance))
    throw new NemoDotsEnvError(
      ['NEMODOTS_INSTANCE'],
      'NEMODOTS_INSTANCE must match ^[a-z0-9][a-z0-9-]{0,23}$.',
    );
  const explicitPgPort = text(env, 'NEMODOTS_PG_PORT') !== undefined;
  let pgPort = port(env, 'NEMODOTS_PG_PORT', DEFAULT_PG_PORT);
  const pgHost = text(env, 'NEMODOTS_PG_HOST') ?? '127.0.0.1';
  const database = text(env, 'NEMODOTS_PG_DATABASE') ?? 'nemodots';
  const urls: Partial<Record<PgRole, string>> = {};
  const urlPorts: { name: string; port: number }[] = [];
  for (const role of PG_ROLES) {
    const name = pgUrlEnvName(role);
    const value = text(env, name);
    if (!value) continue;
    urls[role] = value;
    urlPorts.push({ name, port: assertSafePgUrl(name, value).port });
  }
  // The checkout child is given only its own role URL (finding I3), so
  // NEMODOTS_PG_PORT is usually absent there. Cross-check against it only when
  // it is set explicitly; otherwise the URLs must agree with each other and
  // define the port.
  const reference = explicitPgPort ? pgPort : urlPorts[0]?.port;
  for (const entry of urlPorts) {
    if (entry.port !== reference)
      throw new NemoDotsEnvError(
        explicitPgPort
          ? [entry.name, 'NEMODOTS_PG_PORT']
          : [entry.name, urlPorts[0]!.name],
        explicitPgPort
          ? `${entry.name} does not use NEMODOTS_PG_PORT (${pgPort}).`
          : `${entry.name} does not use the same port as ${urlPorts[0]!.name}.`,
      );
  }
  if (!explicitPgPort && reference !== undefined) pgPort = reference;
  const redisPort = port(env, 'NEMODOTS_REDIS_PORT', DEFAULT_REDIS_PORT);
  const redisUrl =
    text(env, 'NEMODOTS_REDIS_URL') ?? `redis://127.0.0.1:${redisPort}/0`;
  assertSafeRedisUrl('NEMODOTS_REDIS_URL', redisUrl);
  const redisPrefix =
    text(env, 'NEMODOTS_REDIS_PREFIX') ?? `nemodots:${instance}`;
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(redisPrefix))
    throw new NemoDotsEnvError(
      ['NEMODOTS_REDIS_PREFIX'],
      'NEMODOTS_REDIS_PREFIX must match ^[A-Za-z0-9:_-]{1,64}$.',
    );
  const checkoutPort = port(
    env,
    'NEMODOTS_CHECKOUT_PORT',
    DEFAULT_CHECKOUT_PORT,
  );
  const checkoutUrl =
    text(env, 'NEMODOTS_CHECKOUT_URL') ?? `http://127.0.0.1:${checkoutPort}`;
  const checkoutParsed = parseUrl('NEMODOTS_CHECKOUT_URL', checkoutUrl, [
    'http:',
    'https:',
  ]);
  if (checkoutParsed.port) {
    assertAllowedPort('NEMODOTS_CHECKOUT_URL', Number(checkoutParsed.port));
  }
  const requestedMode = (text(env, 'NEMODOTS_INFERENCE_MODE') ??
    'live') as InferenceMode;
  if (!INFERENCE_MODES.includes(requestedMode))
    throw new NemoDotsEnvError(
      ['NEMODOTS_INFERENCE_MODE'],
      'NEMODOTS_INFERENCE_MODE must be live, fixture or blocked.',
    );
  const list = (name: string) =>
    (text(env, name) ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return {
    instance,
    pg: { host: pgHost, port: pgPort, database, urls },
    redis: { url: redisUrl, prefix: redisPrefix },
    checkout: { port: checkoutPort, url: checkoutUrl },
    probe: {
      secret: text(env, 'NEMODOTS_PROBE_SECRET'),
      windowMs: integer(env, 'NEMODOTS_PROBE_WINDOW_MS', 20_000, 0, 600_000),
    },
    inference: {
      requestedMode,
      fixturePath: text(env, 'NEMODOTS_FIXTURE_PATH'),
      maxInFlight: integer(env, 'NEMODOTS_INFERENCE_MAX_IN_FLIGHT', 4, 1, 4),
      plannerModel: text(env, 'NEMODOTS_PLANNER_MODEL'),
      workerModel: text(env, 'NEMODOTS_WORKER_MODEL'),
    },
    leaseMs: integer(env, 'NEMODOTS_LEASE_MS', 30_000, 1_000, 600_000),
    dispatchLeaseMs: integer(
      env,
      'NEMODOTS_DISPATCH_LEASE_MS',
      30_000,
      1_000,
      600_000,
    ),
    maxTasks: integer(env, 'NEMODOTS_MAX_TASKS', 24, 1, 200),
    maxDepth: integer(env, 'NEMODOTS_MAX_DEPTH', 3, 1, 8),
    watchIntervalMs: integer(
      env,
      'NEMODOTS_WATCH_INTERVAL_MS',
      2_000,
      100,
      600_000,
    ),
    workers: integer(env, 'NEMODOTS_WORKERS', 2, 0, 16),
    incidentDotIds: list('NEMODOTS_INCIDENT_DOT_IDS'),
    testHooks: list('NEMODOTS_TEST_HOOKS'),
  };
}

/** The connection string for one role, or a NemoDotsEnvError naming the variable. */
export function pgUrl(config: NemoDotsConfig, role: PgRole) {
  const url = config.pg.urls[role];
  if (!url) {
    const name = pgUrlEnvName(role);
    throw new NemoDotsEnvError(
      [name],
      `${name} is not set. Role URLs live in .local/<instance>/stack/roles.env; run commands through \`npm run nemodots:*\` scripts.`,
    );
  }
  return url;
}

export interface LiveRequirements {
  satisfied: boolean;
  /** Names among OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL that are unset or empty. */
  missingEnv: LiveEnvName[];
  /** Names that are set but unusable (for example a malformed base URL). */
  invalidEnv: LiveEnvName[];
}

export function liveRequirements(env: Env = process.env): LiveRequirements {
  const missingEnv = LIVE_ENV_NAMES.filter((name) => !text(env, name));
  const invalidEnv: LiveEnvName[] = [];
  const baseUrl = text(env, 'OPENAI_BASE_URL');
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        invalidEnv.push('OPENAI_BASE_URL');
    } catch {
      invalidEnv.push('OPENAI_BASE_URL');
    }
  }
  return {
    satisfied: missingEnv.length === 0 && invalidEnv.length === 0,
    missingEnv,
    invalidEnv,
  };
}

export interface ProviderConfig {
  baseUrl: string;
  host: string;
  model: string;
  plannerModel: string;
  workerModel: string;
}

export type ResolvedInference =
  | { mode: 'live'; missingEnv: []; provider: ProviderConfig }
  | { mode: 'fixture'; missingEnv: []; fixturePath: string }
  | {
      mode: 'blocked';
      missingEnv: string[];
      invalidEnv: string[];
      reason: 'requested' | 'missing_env';
    };

/**
 * Resolves the server-side inference mode. Live mode never falls back to
 * another provider or a default host: if a live requirement is missing the
 * result is `blocked` with the missing names.
 */
export function resolveInference(env: Env = process.env): ResolvedInference {
  const requested = (text(env, 'NEMODOTS_INFERENCE_MODE') ?? 'live') as string;
  if (requested === 'fixture') {
    const fixturePath = text(env, 'NEMODOTS_FIXTURE_PATH');
    if (!fixturePath)
      return {
        mode: 'blocked',
        missingEnv: ['NEMODOTS_FIXTURE_PATH'],
        invalidEnv: [],
        reason: 'missing_env',
      };
    return { mode: 'fixture', missingEnv: [], fixturePath };
  }
  const live = liveRequirements(env);
  if (requested === 'blocked')
    return {
      mode: 'blocked',
      missingEnv: live.missingEnv,
      invalidEnv: live.invalidEnv,
      reason: 'requested',
    };
  if (requested !== 'live')
    throw new NemoDotsEnvError(
      ['NEMODOTS_INFERENCE_MODE'],
      'NEMODOTS_INFERENCE_MODE must be live, fixture or blocked.',
    );
  if (!live.satisfied)
    return {
      mode: 'blocked',
      missingEnv: live.missingEnv,
      invalidEnv: live.invalidEnv,
      reason: 'missing_env',
    };
  const baseUrl = text(env, 'OPENAI_BASE_URL')!;
  const model = text(env, 'OPENAI_MODEL')!;
  return {
    mode: 'live',
    missingEnv: [],
    provider: {
      baseUrl,
      host: new URL(baseUrl).host,
      model,
      plannerModel: text(env, 'NEMODOTS_PLANNER_MODEL') ?? model,
      workerModel: text(env, 'NEMODOTS_WORKER_MODEL') ?? model,
    },
  };
}
