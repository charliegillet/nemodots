// One pg.Pool per PostgreSQL role. Every connection carries an
// application_name naming its role and a 15 s statement timeout, so a stuck
// query cannot hold row locks indefinitely.
import pg from 'pg';
import {
  type NemoDotsConfig,
  type PgRole,
  assertSafePgUrl,
  pgUrl,
  pgUrlEnvName,
} from '../config/env.js';

export const STATEMENT_TIMEOUT_MS = 15_000;
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

/** Pool sizes per role (4-8 connections; the user's cluster is shared by test databases). */
export const POOL_MAX: Record<PgRole, number> = {
  admin: 4,
  app: 8,
  checkout: 8,
  injector: 4,
  verifier: 4,
};

export interface RolePoolOptions {
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
  /** Receives idle-client errors; the default reports the role and message only. */
  onError?: (role: PgRole, error: Error) => void;
}

export function createRolePool(
  role: PgRole,
  connectionString: string,
  options: RolePoolOptions = {},
) {
  assertSafePgUrl(pgUrlEnvName(role), connectionString);
  const max = options.max ?? POOL_MAX[role];
  if (!Number.isInteger(max) || max < 1 || max > 8)
    throw new RangeError(`Pool size for ${role} must be between 1 and 8.`);
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: options.applicationName ?? `nemodots-${role}`,
    statement_timeout: options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on(
    'error',
    options.onError
      ? (error) => options.onError!(role, error)
      : (error) =>
          console.error(`nemodots pg pool (${role}) error: ${error.message}`),
  );
  return pool;
}

export type RolePools<R extends PgRole> = Record<R, pg.Pool> & {
  close(): Promise<void>;
};

/** Creates pools for the requested roles from the parsed config. */
export function createRolePools<R extends PgRole>(
  config: NemoDotsConfig,
  roles: readonly R[],
  options: Omit<RolePoolOptions, 'applicationName' | 'max'> = {},
): RolePools<R> {
  const pools = {} as Record<R, pg.Pool>;
  for (const role of roles)
    pools[role] = createRolePool(role, pgUrl(config, role), options);
  return Object.assign(pools, {
    async close() {
      await Promise.all(roles.map((role) => pools[role].end()));
    },
  });
}
