// SourceReaderPort for the checkout sandbox (ARCHITECTURE.md 9.4, CONTRACTS 10).
//
// Every reader returns `{ normalizedValue, raw, revisionHint }`. The normalized
// value is what gets digested: it excludes latencies, timestamps, raw counters,
// probe-tagged rows and the actor columns, so that identical traffic produces
// an identical digest across polls (finding D2). `raw` keeps the unnormalized
// body for display. `revisionHint` is the authority version for controlled
// sources and null for observed ones (the ledger assigns those).
//
//   checkout.health          status enum, per-check booleans, error classes
//   checkout.metrics         error-class set, expected/found schema (no ratios)
//   checkout.orders.recent   bucketed non-probe count, status set
//   checkout.inventory/<sku> consistent flag, stock bands, API-minus-authority divergence
//   redis.stats              key counts per namespace:schema suffix
//   checkout.config/<key>    { key, value, version } only (no actor columns)
//   checkout.config          sorted key list + collection version
//
// Reads PostgreSQL as an authority reader (nemodots_app or nemodots_verifier:
// SELECT on checkout.*), the checkout API over HTTP, and Redis key names via
// SCAN. Nothing here touches control.*, ledger.* or coordinator.*.
import type pg from 'pg';
import {
  SOURCE_KEY_PATTERNS,
  type Scope,
  type SourceKey,
} from '../contracts/ids.js';
import type { SourceReaderPort } from '../contracts/ports.js';
import { parseCacheKey, type RedisClient } from './checkout-cache.js';

export class UnsupportedSourceError extends Error {
  constructor(readonly sourceKey: string) {
    super(`source ${sourceKey} is not served by the checkout readers`);
    this.name = 'UnsupportedSourceError';
  }
}

export interface ReaderDeps {
  /** SELECT on checkout.* (nemodots_app or nemodots_verifier). */
  pg: Pick<pg.Pool, 'query'>;
  /** Redis for key-name statistics; may be absent (redis.stats is then unreachable). */
  redis?: RedisClient;
  redisPrefix: string;
  checkoutUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  httpTimeoutMs?: number;
}

// ------------------------------------------------------------ pure helpers

/**
 * Stock bands. Exact quantities move with every ordinary order, so they never
 * enter a digest; the band only changes at a meaningful threshold (oversold,
 * sold out, running low), and `divergence` (API view minus authority) carries
 * the F4 lag, which is zero in a healthy checkout (finding D2).
 */
export type StockBand = 'negative' | 'zero' | 'low' | 'ok';
export const LOW_STOCK_BELOW = 10;
export function stockBand(quantity: number | null): StockBand | null {
  if (quantity === null) return null;
  if (quantity < 0) return 'negative';
  if (quantity === 0) return 'zero';
  return quantity < LOW_STOCK_BELOW ? 'low' : 'ok';
}

export type OrderCountBucket = '0' | '1-10' | '11-100' | '>100';
export function orderCountBucket(count: number): OrderCountBucket {
  if (count <= 0) return '0';
  if (count <= 10) return '1-10';
  if (count <= 100) return '11-100';
  return '>100';
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

export function normalizeHealth(raw: unknown) {
  const body = asRecord(raw);
  const checks = asRecord(body.checks);
  const status = body.status;
  const bool = (name: string) => checks[name] === true;
  return {
    status: status === 'ok' || status === 'degraded' ? status : 'down',
    checks: {
      postgres: bool('postgres'),
      redis: bool('redis'),
      config_parse: bool('config_parse'),
      writes: bool('writes'),
      cache: bool('cache'),
      pool: bool('pool'),
    },
    errors: [...new Set(strings(body.errors))].sort(),
  };
}

/**
 * `checkout.metrics` as the agents may rely on it: WHICH error classes occurred
 * in the window and, for a cache decode error, which schema the API expected
 * and which it found. Nothing that moves with ordinary traffic is digested:
 * no counters, no request totals, no cache-hit or error-rate ratios (they
 * change with every order, catalogue read or observation and would mint a
 * revision, and with it a false invalidation of every reader, in a healthy
 * checkout). Probe-tagged requests are not tracked at all; the readers' own
 * requests can only add an error class that is really occurring.
 */
export function normalizeMetrics(raw: unknown) {
  const body = asRecord(raw);
  const errors = asRecord(body.errors);
  const decode = body.cache_decode_error;
  const decodeRecord = asRecord(decode);
  return {
    errorClasses: [...new Set(strings(errors.windowClasses))].sort(),
    cacheDecodeError:
      decode && typeof decodeRecord.expectedSchema === 'number'
        ? {
            expectedSchema: decodeRecord.expectedSchema,
            foundSchema:
              typeof decodeRecord.foundSchema === 'number'
                ? decodeRecord.foundSchema
                : null,
          }
        : null,
  };
}

export function normalizeRedisKeys(
  keys: readonly string[],
  prefix: string,
  activeNamespace: string | null,
) {
  const keyCounts: Record<string, number> = {};
  for (const key of keys) {
    const parsed = parseCacheKey(prefix, key);
    if (!parsed) continue;
    const suffix = `${parsed.namespace}:v${parsed.schema}`;
    keyCounts[suffix] = (keyCounts[suffix] ?? 0) + 1;
  }
  return { reachable: true, activeNamespace, keyCounts };
}

/** Maximum authority/API/authority rounds of one inventory read. */
const INVENTORY_PAIR_ATTEMPTS = 5;

// ----------------------------------------------------------------- readers

type ReadResult = Awaited<ReturnType<SourceReaderPort['read']>>;

export function createSourceReaders(deps: ReaderDeps): SourceReaderPort {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.httpTimeoutMs ?? 5_000;

  async function http(path: string): Promise<unknown | null> {
    try {
      const response = await doFetch(`${deps.checkoutUrl}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      // /health answers 503 with a body when degraded or down: the body is the observation.
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }

  async function readHealth(): Promise<ReadResult> {
    const raw = await http('/health');
    if (raw === null)
      return {
        normalizedValue: {
          status: 'down',
          checks: {
            postgres: false,
            redis: false,
            config_parse: false,
            writes: false,
            cache: false,
            pool: false,
          },
          errors: ['checkout_unreachable'],
        },
        raw: { unreachable: true },
        revisionHint: null,
      };
    return { normalizedValue: normalizeHealth(raw), raw, revisionHint: null };
  }

  async function readMetrics(): Promise<ReadResult> {
    const raw = await http('/metrics');
    if (raw === null)
      return {
        normalizedValue: {
          errorClasses: ['checkout_unreachable'],
          cacheDecodeError: null,
        },
        raw: { unreachable: true },
        revisionHint: null,
      };
    return { normalizedValue: normalizeMetrics(raw), raw, revisionHint: null };
  }

  async function readOrdersRecent(): Promise<ReadResult> {
    const since = new Date(now() - 10 * 60_000).toISOString();
    const rows = await deps.pg.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM checkout.orders
        WHERE probe_run_id IS NULL AND created_at >= $1
        GROUP BY status ORDER BY status`,
      [since],
    );
    const count = rows.rows.reduce((sum, r) => sum + Number(r.n), 0);
    return {
      normalizedValue: {
        countBucket: orderCountBucket(count),
        statuses: rows.rows.map((r) => r.status).sort(),
      },
      raw: { windowMinutes: 10, count, byStatus: rows.rows },
      revisionHint: null,
    };
  }

  /** One snapshot of the authority row plus the probe-tagged reservations. */
  async function authoritySnapshot(sku: string) {
    const authority = await deps.pg.query<{ quantity: number; probe: string }>(
      `SELECT i.quantity,
              COALESCE((SELECT sum(oi.quantity) FROM checkout.order_items oi
                          JOIN checkout.orders o ON o.id = oi.order_id
                         WHERE oi.sku = i.sku AND o.probe_run_id IS NOT NULL), 0) AS probe
         FROM checkout.inventory i WHERE i.sku = $1`,
      [sku],
    );
    const row = authority.rows[0] ?? null;
    return {
      row,
      quantity: row ? row.quantity : null,
      probeReserved: row ? Number(row.probe) : 0,
    };
  }

  /**
   * The authority and the API view are read as a STABLE PAIR: authority, then
   * the API, then the authority again, repeated (bounded) until both authority
   * snapshots agree. An order that commits between the two sides therefore
   * never shows up as `consistent: false`, and a probe-tagged order (which
   * moves stock and the probe reservation together) never changes the
   * normalized value. Under constant writes to one SKU the bound is hit and
   * the last pair is reported (a documented limit: sustained traffic on a
   * single SKU can still produce a transient inconsistent reading).
   */
  async function readInventory(sku: string): Promise<ReadResult> {
    let before = await authoritySnapshot(sku);
    let api: Record<string, unknown>;
    for (let attempt = 1; ; attempt += 1) {
      api = asRecord(await http(`/inventory/${encodeURIComponent(sku)}`));
      const after = await authoritySnapshot(sku);
      const stable =
        before.quantity === after.quantity &&
        before.probeReserved === after.probeReserved;
      before = after;
      if (stable || attempt >= INVENTORY_PAIR_ATTEMPTS) break;
    }
    // Probe-tagged reservations are excluded from both sides (D2).
    const probeReserved = before.probeReserved;
    const authorityQuantity =
      before.quantity === null ? null : before.quantity + probeReserved;
    const apiRaw =
      typeof api.quantity === 'number' ? (api.quantity as number) : null;
    // Only the primary view reflects probe reservations; the stale replica never does.
    const apiQuantity =
      apiRaw === null
        ? null
        : api.source === 'primary'
          ? apiRaw + probeReserved
          : apiRaw;
    return {
      normalizedValue: {
        sku,
        consistent:
          authorityQuantity !== null &&
          apiQuantity !== null &&
          authorityQuantity === apiQuantity,
        authorityStock: stockBand(authorityQuantity),
        apiStock: stockBand(apiQuantity),
        divergence:
          authorityQuantity !== null && apiQuantity !== null
            ? apiQuantity - authorityQuantity
            : null,
      },
      raw: { authority: before.row, api },
      revisionHint: null,
    };
  }

  async function readRedisStats(): Promise<ReadResult> {
    const namespace = await deps.pg.query<{ value: unknown }>(
      "SELECT value FROM checkout.config_entries WHERE key = 'cache.namespace'",
    );
    const active =
      namespace.rows.length && typeof namespace.rows[0].value === 'string'
        ? (namespace.rows[0].value as string)
        : null;
    if (!deps.redis || !deps.redis.isReady)
      return {
        normalizedValue: {
          reachable: false,
          activeNamespace: active,
          keyCounts: {},
        },
        raw: { reachable: false },
        revisionHint: null,
      };
    const keys: string[] = [];
    try {
      for await (const batch of deps.redis.scanIterator({
        MATCH: `${deps.redisPrefix}:cache:*`,
        COUNT: 500,
      }))
        keys.push(...(batch as string[]));
    } catch {
      return {
        normalizedValue: {
          reachable: false,
          activeNamespace: active,
          keyCounts: {},
        },
        raw: { reachable: false },
        revisionHint: null,
      };
    }
    const normalized = normalizeRedisKeys(keys, deps.redisPrefix, active);
    return {
      normalizedValue: normalized,
      raw: { keyCount: keys.length },
      revisionHint: null,
    };
  }

  async function readConfigMember(key: string): Promise<ReadResult> {
    const row = await deps.pg.query<{ value: unknown; version: string }>(
      'SELECT value, version FROM checkout.config_entries WHERE key = $1',
      [key],
    );
    if (!row.rows.length) {
      const collection = await deps.pg.query<{ version: string }>(
        'SELECT version FROM checkout.config_collection WHERE singleton',
      );
      return {
        normalizedValue: null,
        raw: { exists: false, key },
        revisionHint: Number(collection.rows[0]?.version ?? 0),
      };
    }
    const version = Number(row.rows[0].version);
    return {
      normalizedValue: { key, value: row.rows[0].value, version },
      raw: { key, value: row.rows[0].value, version },
      revisionHint: version,
    };
  }

  async function readCollection(): Promise<ReadResult> {
    // One statement so the keys and the collection version are one snapshot.
    const rows = await deps.pg.query<{ keys: string[]; version: string }>(
      `SELECT COALESCE((SELECT array_agg(key ORDER BY key) FROM checkout.config_entries), '{}') AS keys,
              (SELECT version FROM checkout.config_collection WHERE singleton) AS version`,
    );
    const collectionVersion = Number(rows.rows[0].version);
    const value = { keys: rows.rows[0].keys, collectionVersion };
    return {
      normalizedValue: value,
      raw: value,
      revisionHint: collectionVersion,
    };
  }

  return {
    async read(key: SourceKey, _scope: Scope): Promise<ReadResult> {
      const text = key as string;
      if (SOURCE_KEY_PATTERNS['checkout.health'].test(text))
        return readHealth();
      if (SOURCE_KEY_PATTERNS['checkout.metrics'].test(text))
        return readMetrics();
      if (SOURCE_KEY_PATTERNS['checkout.orders.recent'].test(text))
        return readOrdersRecent();
      if (SOURCE_KEY_PATTERNS['redis.stats'].test(text))
        return readRedisStats();
      if (SOURCE_KEY_PATTERNS['checkout.config'].test(text))
        return readCollection();
      if (text.startsWith('checkout.inventory/')) {
        if (SOURCE_KEY_PATTERNS['checkout.inventory/<sku>'].test(text))
          return readInventory(text.slice('checkout.inventory/'.length));
      }
      if (text.startsWith('checkout.config/')) {
        if (SOURCE_KEY_PATTERNS['checkout.config/<key>'].test(text))
          return readConfigMember(text.slice('checkout.config/'.length));
      }
      throw new UnsupportedSourceError(text);
    },
  };
}
