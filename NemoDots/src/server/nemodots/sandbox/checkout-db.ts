// PostgreSQL access of the checkout API: a small fixed "control" pool for
// configuration and health (so a starved business pool can still be diagnosed),
// the business pool sized from `db.pool_max` with the configured statement
// timeout, and the 250 ms configuration cache.
import pg from 'pg';
import { assertSafePgUrl } from '../config/env.js';
import {
  type CheckoutSettings,
  parseCheckoutSettings,
} from './config-schema.js';

/** How long a request waits for a business connection before 503 pool_timeout. */
export const POOL_ACQUIRE_TIMEOUT_MS = 200;
/**
 * Simulated per-unit-of-work query cost (pg_sleep). The sandbox has a tiny
 * dataset; this makes connection hold times, and therefore pool sizing,
 * observable (10 concurrent requests need pool_max >= 2 to avoid timeouts).
 */
export const QUERY_COST_SECONDS = 0.04;
export const CONFIG_CACHE_MS = 250;

export function isPoolTimeout(error: unknown) {
  return (
    error instanceof Error &&
    /timeout exceeded when trying to connect/i.test(error.message)
  );
}

export function sqlCode(error: unknown) {
  return typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function isConnectionFailure(error: unknown) {
  const code = sqlCode(error);
  if (
    code &&
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01'].includes(code)
  )
    return true;
  return (
    error instanceof Error &&
    /Connection terminated|connect ECONNREFUSED|the database system is/i.test(
      error.message,
    )
  );
}

interface Generation {
  pool: pg.Pool;
  max: number;
  statementTimeoutMs: number;
  refs: number;
  retired: boolean;
  ended: boolean;
}

/** The business pool. Resizing creates a new pool and retires the old one once idle. */
export class BusinessPools {
  private current: Generation | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly applicationName = 'nemodots-checkout',
  ) {
    assertSafePgUrl('NEMODOTS_PG_URL_CHECKOUT', connectionString);
  }

  get size() {
    return this.current?.max ?? null;
  }

  get statementTimeoutMs() {
    return this.current?.statementTimeoutMs ?? null;
  }

  configure(max: number, statementTimeoutMs: number) {
    const previous = this.current;
    if (
      previous &&
      previous.max === max &&
      previous.statementTimeoutMs === statementTimeoutMs
    )
      return;
    const pool = new pg.Pool({
      connectionString: this.connectionString,
      max,
      statement_timeout: statementTimeoutMs,
      connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: this.applicationName,
    });
    pool.on('error', () => {
      // an idle client lost its connection; the next acquire reconnects
    });
    this.current = {
      pool,
      max,
      statementTimeoutMs,
      refs: 0,
      retired: false,
      ended: false,
    };
    if (previous) {
      previous.retired = true;
      this.endIfIdle(previous);
    }
  }

  private endIfIdle(generation: Generation) {
    if (generation.retired && generation.refs === 0 && !generation.ended) {
      generation.ended = true;
      void generation.pool.end().catch(() => {});
    }
  }

  async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const generation = this.current;
    if (!generation) throw new Error('business pool is not configured');
    generation.refs += 1;
    try {
      const client = await generation.pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    } finally {
      generation.refs -= 1;
      this.endIfIdle(generation);
    }
  }

  /** A pool handle for withTransaction that is counted as in use while connecting. */
  async withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
    const generation = this.current;
    if (!generation) throw new Error('business pool is not configured');
    generation.refs += 1;
    try {
      return await fn(generation.pool);
    } finally {
      generation.refs -= 1;
      this.endIfIdle(generation);
    }
  }

  async close() {
    const generation = this.current;
    this.current = null;
    if (generation && !generation.ended) {
      generation.retired = true;
      generation.ended = true;
      await generation.pool.end().catch(() => {});
    }
  }
}

export type ConfigState =
  | {
      ok: true;
      settings: CheckoutSettings;
      fingerprint: string;
    }
  | { ok: false; reason: 'unavailable' | 'invalid'; invalidKeys: string[] };

/**
 * Reads the controlled configuration. The result is cached for 250 ms; after
 * that a cheap fingerprint query (collection version, key count, sum and max of
 * member versions) decides whether the rows are re-read. The sum makes an
 * update of a key that is not the newest still change the fingerprint.
 */
export class ConfigStore {
  private cached: { state: ConfigState; at: number } | null = null;
  private refreshing: Promise<ConfigState> | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => number,
    private readonly onSettings: (settings: CheckoutSettings) => void,
  ) {}

  async get(): Promise<ConfigState> {
    if (this.cached && this.now() - this.cached.at < CONFIG_CACHE_MS)
      return this.cached.state;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<ConfigState> {
    try {
      const probe = await this.pool.query<{
        n: string;
        s: string;
        m: string;
        cv: string;
      }>(
        `SELECT count(*) AS n, COALESCE(sum(version), 0) AS s,
                COALESCE(max(version), 0) AS m,
                (SELECT version FROM checkout.config_collection) AS cv
           FROM checkout.config_entries`,
      );
      const row = probe.rows[0];
      const fingerprint = `${row.cv}:${row.n}:${row.s}:${row.m}`;
      if (
        this.cached?.state.ok &&
        this.cached.state.fingerprint === fingerprint
      ) {
        this.cached = { state: this.cached.state, at: this.now() };
        return this.cached.state;
      }
      const rows = await this.pool.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM checkout.config_entries',
      );
      const parsed = parseCheckoutSettings(
        new Map(rows.rows.map((r) => [r.key, r.value])),
      );
      const state: ConfigState = parsed.ok
        ? { ok: true, settings: parsed.settings, fingerprint }
        : { ok: false, reason: 'invalid', invalidKeys: parsed.invalidKeys };
      if (state.ok) this.onSettings(state.settings);
      this.cached = { state, at: this.now() };
      return state;
    } catch {
      const state: ConfigState = {
        ok: false,
        reason: 'unavailable',
        invalidKeys: [],
      };
      this.cached = { state, at: this.now() };
      return state;
    }
  }
}
