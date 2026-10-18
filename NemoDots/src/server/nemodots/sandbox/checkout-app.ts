// The checkout API (ARCHITECTURE.md section 9.1): a real workload whose
// behaviour depends on Redis and on the versioned configuration, so that a
// bounded configuration change is a real repair.
//
//   GET  /health            deterministic status + per-check booleans + error classes
//   GET  /ready             readiness (PostgreSQL, Redis, configuration)
//   GET  /products          Redis cache-aside catalog
//   GET  /inventory/:sku    stock as the API sees it (primary or the stale replica)
//   POST /orders            one transaction, FOR UPDATE on inventory
//   GET  /orders/:id
//   GET  /metrics           rolling error classes, cache hit/miss, decode-error schemas
//
// Runs as role nemodots_checkout. No healthy configuration value is stated in
// this file: every behaviour is driven by the rows the version authority
// wrote (baseline = seed.ts / scenario manifests).
//
// Fault classes (config key -> behaviour here):
//   cache.namespace / cache.schema_version  checkout-cache.ts (F1, F2)
//   db.pool_max / db.statement_timeout_ms   BusinessPools: 503 pool_timeout /
//                                           statement_timeout (F3)
//   routing.inventory_source = replica_stale  stock checks read the frozen
//                                           replica while the primary keeps
//                                           being decremented: oversell (F4)
//   orders.write_enabled = false            503 writes_disabled (F5)
//   ui.banner_text                          cosmetic (B1)
import { Hono } from 'hono';
import type { Context } from 'hono';
import pg from 'pg';
import { createClient } from 'redis';
import { z } from 'zod';
import { assertSafePgUrl, assertSafeRedisUrl } from '../config/env.js';
import { withTransaction } from '../db/tx.js';
import {
  CacheDecodeError,
  CheckoutCache,
  RedisUnavailableError,
  type RedisClient,
} from './checkout-cache.js';
import {
  BusinessPools,
  ConfigStore,
  QUERY_COST_SECONDS,
  isConnectionFailure,
  isPoolTimeout,
  sqlCode,
} from './checkout-db.js';
import { CheckoutMetrics, type ErrorClass } from './checkout-metrics.js';
import type { CheckoutSettings } from './config-schema.js';
import { PROBE_SKU } from './constants.js';
import {
  PROBE_HEADER,
  parseProbeHeader,
  type ProbeHeader,
} from './probe-auth.js';

/** Concurrency of the pool capacity self-test run by /health. */
export const HEALTH_CAPACITY_CONCURRENCY = 8;
/**
 * The capacity self-test is single-flight and its result is shared for this
 * long (per pool configuration), so concurrent or frequent /health polls (the
 * watcher, the probe's window, the UI proxy, team reads) can never starve each
 * other of connections and fake the pool-exhaustion symptom.
 */
export const HEALTH_CAPACITY_CACHE_MS = 1_000;

export interface CheckoutDeps {
  /** NEMODOTS_PG_URL_CHECKOUT */
  pgUrl: string;
  redisUrl: string;
  redisPrefix: string;
  probeSecret: string;
  now?: () => number;
}

export interface CheckoutRuntime {
  app: Hono;
  metrics: CheckoutMetrics;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorClass: string,
    message: string,
    readonly serverClass?: ErrorClass,
    readonly extra?: { expectedSchema: number; foundSchema: number | null },
  ) {
    super(message);
  }
}

const OrderBodySchema = z
  .object({
    customer: z.string().min(1).max(80).optional(),
    items: z
      .array(
        z
          .object({
            sku: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/),
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Json {
  status: number;
  body: unknown;
}

export function createCheckoutApp(deps: CheckoutDeps): CheckoutRuntime {
  assertSafePgUrl('NEMODOTS_PG_URL_CHECKOUT', deps.pgUrl);
  assertSafeRedisUrl('NEMODOTS_REDIS_URL', deps.redisUrl);
  const now = deps.now ?? Date.now;
  const metrics = new CheckoutMetrics(now);

  const controlPool = new pg.Pool({
    connectionString: deps.pgUrl,
    max: 3,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
    application_name: 'nemodots-checkout-control',
  });
  controlPool.on('error', () => {});
  const pools = new BusinessPools(deps.pgUrl);
  // The /health capacity self-test runs on its OWN pool with the same size,
  // statement timeout and acquire timeout as the business pool. It exercises
  // the configured capacity (db.pool_max, the F3 repair knob) without taking
  // connections from customer, probe or reader traffic, so polling /health can
  // never create the pool_timeout symptom it is looking for.
  const healthPools = new BusinessPools(deps.pgUrl, 'nemodots-checkout-health');
  const config = new ConfigStore(
    controlPool,
    now,
    (settings: CheckoutSettings) => {
      pools.configure(settings.dbPoolMax, settings.dbStatementTimeoutMs);
      healthPools.configure(settings.dbPoolMax, settings.dbStatementTimeoutMs);
    },
  );

  const redis: RedisClient = createClient({
    url: deps.redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: (retries: number) =>
        Math.min(100 * 2 ** retries, 1_000),
    },
  });
  redis.on('error', () => {});
  void redis.connect().catch(() => {});
  const cache = new CheckoutCache(redis, deps.redisPrefix, now);

  /**
   * Cache-aside read. `tracked: false` keeps the read out of the metrics
   * windows (probe traffic and the /health canary must not move the
   * normalized `checkout.metrics` value; ARCHITECTURE 9.4, finding D2).
   */
  async function cached<T>(
    settings: CheckoutSettings,
    name: string,
    loader: () => Promise<T>,
    tracked = true,
  ): Promise<T> {
    try {
      const result = await cache.readThrough(settings, name, loader);
      if (tracked) metrics.recordCache(result.hit);
      return result.value;
    } catch (error) {
      if (error instanceof RedisUnavailableError) {
        if (tracked) {
          metrics.recordError('redis_unavailable');
          metrics.recordCache(false);
        }
        return loader();
      }
      throw error;
    }
  }

  /** A unit of database work: hold a connection for the simulated query cost. */
  const work = (client: pg.PoolClient) =>
    client.query('SELECT pg_sleep($1)', [QUERY_COST_SECONDS]);

  function toHttpError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof CacheDecodeError)
      return new HttpError(
        500,
        'cache_decode_error',
        error.message,
        'cache_decode_error',
        {
          expectedSchema: error.expectedSchema,
          foundSchema: error.foundSchema,
        },
      );
    if (isPoolTimeout(error))
      return new HttpError(
        503,
        'pool_timeout',
        'no database connection became available in time',
        'pool_timeout',
      );
    if (sqlCode(error) === '57014')
      return new HttpError(
        503,
        'statement_timeout',
        'a statement exceeded the configured timeout',
        'statement_timeout',
      );
    if (isConnectionFailure(error))
      return new HttpError(
        503,
        'db_unavailable',
        'database unavailable',
        'db_unavailable',
      );
    return new HttpError(
      500,
      'internal_error',
      'internal error',
      'internal_error',
    );
  }

  /** Records a classified failure once (server-side classes only). */
  function record(error: HttpError) {
    if (error.serverClass) metrics.recordError(error.serverClass, error.extra);
  }

  interface RouteContext {
    /** The authenticated probe tag of this request, if any. */
    probe: ProbeHeader;
    /** Probe traffic is evidence-neutral: it never enters the metrics windows. */
    tracked: boolean;
  }

  /** Runs a business route: configuration gate, error classification, metrics. */
  async function business(
    c: Context,
    handler: (settings: CheckoutSettings, ctx: RouteContext) => Promise<Json>,
  ) {
    let status = 500;
    let tracked = true;
    try {
      const probe = parseProbeHeader(
        deps.probeSecret,
        c.req.header(PROBE_HEADER),
      );
      if (probe.kind === 'invalid')
        throw new HttpError(403, 'probe_auth_failed', 'probe tag rejected');
      tracked = probe.kind !== 'valid';
      const state = await config.get();
      if (!state.ok) {
        throw new HttpError(
          503,
          'config_invalid',
          state.reason === 'invalid'
            ? 'configuration is invalid'
            : 'configuration is unavailable',
          'config_invalid',
        );
      }
      const result = await handler(state.settings, { probe, tracked });
      status = result.status;
      return c.json(result.body as object, status as 200);
    } catch (raw) {
      const error = toHttpError(raw);
      if (tracked) record(error);
      status = error.status;
      return c.json(
        { error: error.errorClass, message: error.message, ...error.extra },
        status as 400,
      );
    } finally {
      if (tracked) metrics.recordRequest(status);
    }
  }

  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  // ------------------------------------------------------------- health

  async function controlPing() {
    try {
      await controlPool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  interface Capacity {
    key: string;
    at: number;
    ok: boolean;
    errors: string[];
  }
  let capacityDone: Capacity | null = null;
  let capacityRun: { key: string; promise: Promise<Capacity> } | null = null;

  /**
   * Expected-concurrency self-test of a pool configured like the business
   * pool (see healthPools): HEALTH_CAPACITY_CONCURRENCY units of work at once.
   * Single-flight and cached per pool configuration
   * (HEALTH_CAPACITY_CACHE_MS), and its failures are NOT written to the metrics
   * windows: only customer traffic is, so health polling cannot create the F3
   * symptom on a healthy pool or move the normalized metrics.
   */
  function poolCapacity(): Promise<Capacity> {
    const key = `${healthPools.size}:${healthPools.statementTimeoutMs}`;
    if (
      capacityDone &&
      capacityDone.key === key &&
      now() - capacityDone.at < HEALTH_CAPACITY_CACHE_MS
    )
      return Promise.resolve(capacityDone);
    if (capacityRun && capacityRun.key === key) return capacityRun.promise;
    const promise: Promise<Capacity> = (async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: HEALTH_CAPACITY_CONCURRENCY }, () =>
          healthPools.withClient(work),
        ),
      );
      const errors = new Set<string>();
      for (const attempt of attempts) {
        if (attempt.status === 'fulfilled') continue;
        const mapped = toHttpError(attempt.reason);
        errors.add(
          mapped.errorClass === 'pool_timeout'
            ? 'pool_exhausted'
            : mapped.errorClass,
        );
      }
      const result: Capacity = {
        key,
        at: now(),
        ok: errors.size === 0,
        errors: [...errors].sort(),
      };
      capacityDone = result;
      return result;
    })().finally(() => {
      if (capacityRun?.promise === promise) capacityRun = null;
    });
    capacityRun = { key, promise };
    return promise;
  }

  app.get('/health', async (c) => {
    const [postgres, redisOk, state] = await Promise.all([
      controlPing(),
      cache.ping(),
      config.get(),
    ]);
    const errors = new Set<string>();
    if (!postgres) errors.add('postgres_unreachable');
    if (!redisOk) errors.add('redis_unreachable');
    if (!state.ok && postgres) errors.add('config_invalid');
    const writes = state.ok && state.settings.ordersWriteEnabled;
    if (state.ok && !state.settings.ordersWriteEnabled)
      errors.add('writes_disabled');
    let cacheOk = false;
    let poolOk = false;
    if (postgres && redisOk && state.ok) {
      // The cache canary goes through the same read-through path as /products
      // but is not counted as a cache hit or miss.
      try {
        await cached(
          state.settings,
          'canary',
          async () => ({ canary: true }),
          false,
        );
        cacheOk = true;
      } catch (error) {
        if (error instanceof CacheDecodeError) {
          record(toHttpError(error)); // keeps the decode error's schemas in /metrics
          errors.add('cache_decode_error');
        } else errors.add('redis_unreachable');
      }
      const capacity = await poolCapacity();
      poolOk = capacity.ok;
      for (const error of capacity.errors) errors.add(error);
    }
    const checks = {
      postgres,
      redis: redisOk,
      config_parse: state.ok,
      writes,
      cache: cacheOk,
      pool: poolOk,
    };
    const status =
      !postgres || !redisOk || !state.ok
        ? 'down'
        : Object.values(checks).every(Boolean)
          ? 'ok'
          : 'degraded';
    return c.json(
      { status, checks, errors: [...errors].sort() },
      status === 'ok' ? 200 : 503,
    );
  });

  app.get('/ready', async (c) => {
    const [postgres, redisOk, state] = await Promise.all([
      controlPing(),
      cache.ping(),
      config.get(),
    ]);
    const reasons = [
      ...(postgres ? [] : ['postgres']),
      ...(redisOk ? [] : ['redis']),
      ...(state.ok ? [] : ['config']),
    ];
    return c.json(
      { ready: reasons.length === 0, reasons },
      reasons.length ? 503 : 200,
    );
  });

  app.get('/metrics', (c) => c.json(metrics.snapshot()));

  // ------------------------------------------------------------- catalog

  app.get('/products', (c) =>
    business(c, async (settings, ctx) => {
      const products = await cached(
        settings,
        'products',
        () =>
          pools.withClient(async (client) => {
            await work(client);
            const rows = await client.query<{
              sku: string;
              name: string;
              category: string;
              price_cents: number;
            }>(
              `SELECT sku, name, category, price_cents FROM checkout.products
              WHERE listed ORDER BY sku`,
            );
            return rows.rows.map((r) => ({
              sku: r.sku,
              name: r.name,
              category: r.category,
              priceCents: r.price_cents,
            }));
          }),
        ctx.tracked,
      );
      return {
        status: 200,
        body: { products, banner: settings.bannerText },
      };
    }),
  );

  app.get('/inventory/:sku', (c) =>
    business(c, async (settings) => {
      const sku = c.req.param('sku');
      if (!SKU_PATTERN.test(sku))
        throw new HttpError(400, 'invalid_request', 'invalid sku');
      const source = settings.inventorySource;
      const quantity = await pools.withClient(async (client) => {
        await work(client);
        const table =
          source === 'primary'
            ? 'checkout.inventory'
            : 'checkout.inventory_replica';
        const row = await client.query<{ quantity: number }>(
          `SELECT quantity FROM ${table} WHERE sku = $1`,
          [sku],
        );
        return row.rows.length ? row.rows[0].quantity : null;
      });
      if (quantity === null)
        throw new HttpError(404, 'not_found', 'unknown sku');
      return { status: 200, body: { sku, quantity, source } };
    }),
  );

  // -------------------------------------------------------------- orders

  app.post('/orders', (c) =>
    business(c, async (settings, { probe }) => {
      if (!settings.ordersWriteEnabled)
        throw new HttpError(
          503,
          'writes_disabled',
          'order writes are disabled',
          'writes_disabled',
        );
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        throw new HttpError(400, 'invalid_request', 'body must be JSON');
      }
      const parsed = OrderBodySchema.safeParse(json);
      if (!parsed.success)
        throw new HttpError(400, 'invalid_request', 'invalid order');
      const lines = new Map<string, number>();
      for (const item of parsed.data.items)
        lines.set(item.sku, (lines.get(item.sku) ?? 0) + item.quantity);
      if (
        probe.kind === 'valid' &&
        [...lines.keys()].some((sku) => sku !== PROBE_SKU)
      )
        throw new HttpError(
          403,
          'probe_scope',
          'probe orders may only contain the probe item',
        );
      const skus = [...lines.keys()].sort();
      const orderId = crypto.randomUUID();
      const customer = parsed.data.customer ?? 'anonymous';
      const result = await pools.withPool((pool) =>
        withTransaction(pool, async (client) => {
          await work(client);
          const priced: {
            sku: string;
            quantity: number;
            priceCents: number;
          }[] = [];
          for (const sku of skus) {
            const quantity = lines.get(sku)!;
            const product = await client.query<{ price_cents: number }>(
              'SELECT price_cents FROM checkout.products WHERE sku = $1',
              [sku],
            );
            if (!product.rows.length)
              throw new HttpError(404, 'unknown_sku', `unknown sku ${sku}`);
            // The primary row is always locked: the decrement happens on it.
            const primary = await client.query<{ quantity: number }>(
              'SELECT quantity FROM checkout.inventory WHERE sku = $1 FOR UPDATE',
              [sku],
            );
            let available = primary.rows[0].quantity;
            if (settings.inventorySource === 'replica_stale') {
              const replica = await client.query<{ quantity: number }>(
                'SELECT quantity FROM checkout.inventory_replica WHERE sku = $1',
                [sku],
              );
              available = replica.rows[0].quantity;
            }
            if (available < quantity)
              throw new HttpError(
                409,
                'out_of_stock',
                `insufficient stock for ${sku}`,
              );
            await client.query(
              'UPDATE checkout.inventory SET quantity = quantity - $2, updated_at = now() WHERE sku = $1',
              [sku, quantity],
            );
            priced.push({
              sku,
              quantity,
              priceCents: product.rows[0].price_cents,
            });
          }
          const total = priced.reduce(
            (sum, line) => sum + line.quantity * line.priceCents,
            0,
          );
          const created = await client.query<{ created_at: Date }>(
            `INSERT INTO checkout.orders (id, status, customer, total_cents, probe_run_id)
             VALUES ($1, 'confirmed', $2, $3, $4) RETURNING created_at`,
            [
              orderId,
              customer,
              total,
              probe.kind === 'valid' ? probe.runId : null,
            ],
          );
          await client.query(
            `INSERT INTO checkout.order_items (order_id, sku, quantity, price_cents)
             SELECT $1, * FROM unnest($2::text[], $3::int[], $4::int[])`,
            [
              orderId,
              priced.map((l) => l.sku),
              priced.map((l) => l.quantity),
              priced.map((l) => l.priceCents),
            ],
          );
          return {
            id: orderId,
            status: 'confirmed',
            customer,
            totalCents: total,
            items: priced,
            createdAt: created.rows[0].created_at.toISOString(),
          };
        }),
      );
      return { status: 201, body: result };
    }),
  );

  app.get('/orders/:id', (c) =>
    business(c, async () => {
      const id = c.req.param('id');
      if (!UUID_PATTERN.test(id))
        throw new HttpError(400, 'invalid_request', 'invalid order id');
      const order = await pools.withClient(async (client) => {
        await work(client);
        const row = await client.query<{
          id: string;
          status: string;
          customer: string;
          total_cents: number;
          created_at: Date;
        }>(
          'SELECT id, status, customer, total_cents, created_at FROM checkout.orders WHERE id = $1',
          [id],
        );
        if (!row.rows.length) return null;
        const items = await client.query<{
          sku: string;
          quantity: number;
          price_cents: number;
        }>(
          'SELECT sku, quantity, price_cents FROM checkout.order_items WHERE order_id = $1 ORDER BY sku',
          [id],
        );
        return {
          id: row.rows[0].id,
          status: row.rows[0].status,
          customer: row.rows[0].customer,
          totalCents: row.rows[0].total_cents,
          items: items.rows.map((i) => ({
            sku: i.sku,
            quantity: i.quantity,
            priceCents: i.price_cents,
          })),
          createdAt: row.rows[0].created_at.toISOString(),
        };
      });
      if (!order) throw new HttpError(404, 'not_found', 'order not found');
      return { status: 200, body: order };
    }),
  );

  app.notFound((c) =>
    c.json({ error: 'not_found', message: 'no such route' }, 404),
  );
  app.onError((_error, c) => {
    metrics.recordError('internal_error');
    return c.json({ error: 'internal_error', message: 'internal error' }, 500);
  });

  return {
    app,
    metrics,
    async close() {
      redis.destroy();
      await pools.close();
      await healthPools.close();
      await controlPool.end().catch(() => {});
    },
  };
}
