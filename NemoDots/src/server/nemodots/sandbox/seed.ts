// Deterministic checkout seed: 24 listed products, inventory, 200 historical
// orders, the hidden PROBE-SKU and the healthy configuration baseline.
//
// THE HEALTHY BASELINE VALUES LIVE ONLY HERE AND IN THE SCENARIO MANIFESTS
// (ARCHITECTURE.md 9.2, finding D7). Runbooks and team code must not state
// them. `team/**` is grep-tested for these literals.
//
// Idempotent: products/inventory/orders/replica rows use ON CONFLICT DO
// NOTHING and a config key that already exists is left alone (so a second
// run, or a run after a scenario, never rewinds history). `restoreConfig`
// is the explicit way back to the baseline for evaluation resets; it goes
// through the version authority like every other writer.
//
// Run: `npm run nemodots:seed` (as nemodots_admin; the seed is not a runtime
// actor and uses actor 'seed').
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { withTransaction } from '../db/tx.js';
import { PROBE_SKU, PROBE_SKU_STOCK } from './constants.js';
import { loadConfig, roleUrl } from './runtime-env.js';
import {
  advanceConfig,
  advanceConfigUnconditionally,
  lockConfigRows,
  type ConfigScalar,
} from './version-authority.js';

export const SEED_ORDER_COUNT = 200;
export const SEED_PRODUCT_COUNT = 24;
/** Seed orders are placed on this base date (all older than any recent-orders window). */
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
/**
 * The lagging replica (fault class F4) is a snapshot taken before the last
 * REPLICA_LAG_ORDERS seed orders were placed, so for every SKU those orders
 * touched it reports MORE stock than the primary. The scarce SKU additionally
 * lags by SCARCE_REPLICA_LAG units (reservations the replica never saw). With
 * zero customer traffic, routing inventory reads to the replica therefore
 * already makes the authority and the API view disagree and lets orders oversell.
 */
export const REPLICA_LAG_ORDERS = 80;
export const SCARCE_SKU = 'SKU-0024';
export const SCARCE_REPLICA_LAG = 2;

/** Healthy configuration baseline. Do not import from team/** or runbooks. */
export const HEALTHY_BASELINE: Readonly<Record<string, ConfigScalar>> =
  Object.freeze({
    'cache.namespace': 'catalog-a',
    'cache.schema_version': 1,
    'db.pool_max': 10,
    'db.statement_timeout_ms': 5000,
    'routing.inventory_source': 'primary',
    'orders.write_enabled': true,
    'ui.banner_text': 'Free shipping on orders over $50',
  });

const NOUNS = [
  'Trail Backpack',
  'Insulated Bottle',
  'Merino Socks',
  'Canvas Tote',
  'Field Notebook',
  'Desk Lamp',
  'Ceramic Mug',
  'Wool Beanie',
  'Rain Shell',
  'Camp Stove',
  'Headlamp',
  'Water Filter',
  'Sleeping Pad',
  'Trekking Poles',
  'Compass',
  'Dry Bag',
  'Fleece Vest',
  'Cooking Set',
  'Hammock',
  'Multi Tool',
  'Sun Hat',
  'First Aid Kit',
  'Map Case',
  'Fire Starter',
];
const CATEGORIES = ['gear', 'apparel', 'kitchen', 'safety'];

export interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  listed: boolean;
  /** Primary stock. */
  quantity: number;
  /** Stock the (lagging) replica snapshot reports. */
  replicaQuantity: number;
}
export interface SeedOrder {
  id: string;
  customer: string;
  createdAt: string;
  totalCents: number;
  items: { sku: string; quantity: number; priceCents: number }[];
}

const skuFor = (index: number) => `SKU-${String(index + 1).padStart(4, '0')}`;

/** sha256-derived UUID (version nibble 4, variant 8) so ids are stable across runs. */
export function deterministicUuid(label: string) {
  const hex = createHash('sha256').update(label).digest('hex').slice(0, 32);
  const chars = hex.split('');
  chars[12] = '4';
  chars[16] = '89ab'[parseInt(chars[16], 16) % 4];
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function generateSeedData(): {
  products: SeedProduct[];
  orders: SeedOrder[];
} {
  const products: SeedProduct[] = NOUNS.map((name, i) => ({
    sku: skuFor(i),
    name,
    category: CATEGORIES[i % CATEGORIES.length],
    priceCents: 899 + ((i * 1373) % 9100),
    listed: true,
    // SKU-0024 is deliberately scarce: stale-replica oversell is visible on it.
    quantity: i === SEED_PRODUCT_COUNT - 1 ? 3 : 120 + ((i * 37) % 180),
    replicaQuantity: 0, // set below, once the orders are known
  }));
  products.push({
    sku: PROBE_SKU,
    name: 'Acceptance probe item',
    category: 'internal',
    priceCents: 100,
    listed: false,
    quantity: PROBE_SKU_STOCK,
    replicaQuantity: PROBE_SKU_STOCK,
  });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const orders: SeedOrder[] = [];
  for (let n = 0; n < SEED_ORDER_COUNT; n += 1) {
    const rng = hashSequence(`seed-order-${n}`);
    const lines = 1 + (rng() % 3);
    const items: SeedOrder['items'] = [];
    const used = new Set<string>();
    while (items.length < lines) {
      const sku = skuFor(rng() % (SEED_PRODUCT_COUNT - 1));
      if (used.has(sku)) continue;
      used.add(sku);
      items.push({
        sku,
        quantity: 1 + (rng() % 3),
        priceCents: bySku.get(sku)!.priceCents,
      });
    }
    orders.push({
      id: deterministicUuid(`seed-order-${n}`),
      customer: `customer-${String(1 + (rng() % 40)).padStart(3, '0')}`,
      createdAt: new Date(SEED_EPOCH_MS + n * 3_600_000).toISOString(),
      totalCents: items.reduce((sum, i) => sum + i.quantity * i.priceCents, 0),
      items,
    });
  }
  const lag = new Map<string, number>();
  for (const order of orders.slice(SEED_ORDER_COUNT - REPLICA_LAG_ORDERS))
    for (const item of order.items)
      lag.set(item.sku, (lag.get(item.sku) ?? 0) + item.quantity);
  lag.set(SCARCE_SKU, (lag.get(SCARCE_SKU) ?? 0) + SCARCE_REPLICA_LAG);
  for (const product of products)
    product.replicaQuantity = product.quantity + (lag.get(product.sku) ?? 0);
  return { products, orders };
}

function hashSequence(label: string) {
  let counter = 0;
  return () => {
    const hex = createHash('sha256')
      .update(`${label}:${counter}`)
      .digest('hex')
      .slice(0, 8);
    counter += 1;
    return parseInt(hex, 16);
  };
}

export interface SeedSummary {
  products: number;
  orders: number;
  inventoryRows: number;
  configInserted: string[];
  configRestored: string[];
}

/** Seeds through `pool` (nemodots_admin). Safe to run repeatedly. */
export async function seedCheckout(
  pool: pg.Pool,
  options: { restoreConfig?: boolean } = {},
): Promise<SeedSummary> {
  const { products, orders } = generateSeedData();
  const configInserted: string[] = [];
  const configRestored: string[] = [];
  await withTransaction(pool, async (client, attempt) => {
    configInserted.length = 0; // a retry re-runs the whole callback
    configRestored.length = 0;
    await client.query(
      `INSERT INTO checkout.products (sku, name, category, price_cents, listed)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::boolean[])
       ON CONFLICT (sku) DO NOTHING`,
      [
        products.map((p) => p.sku),
        products.map((p) => p.name),
        products.map((p) => p.category),
        products.map((p) => p.priceCents),
        products.map((p) => p.listed),
      ],
    );
    await client.query(
      `INSERT INTO checkout.inventory (sku, quantity)
       SELECT * FROM unnest($1::text[], $2::int[])
       ON CONFLICT (sku) DO NOTHING`,
      [products.map((p) => p.sku), products.map((p) => p.quantity)],
    );
    // The replica is a snapshot that is already behind the primary at first
    // seed (see REPLICA_LAG_ORDERS); it is never refreshed by the API or a
    // reseed (it stands in for a replica that stopped replicating).
    await client.query(
      `INSERT INTO checkout.inventory_replica (sku, quantity)
       SELECT * FROM unnest($1::text[], $2::int[])
       ON CONFLICT (sku) DO NOTHING`,
      [products.map((p) => p.sku), products.map((p) => p.replicaQuantity)],
    );
    await client.query(
      `INSERT INTO checkout.orders (id, status, customer, total_cents, created_at)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::timestamptz[])
       ON CONFLICT (id) DO NOTHING`,
      [
        orders.map((o) => o.id),
        orders.map(() => 'confirmed'),
        orders.map((o) => o.customer),
        orders.map((o) => o.totalCents),
        orders.map((o) => o.createdAt),
      ],
    );
    // Items only for orders this run inserted (an existing order keeps its lines).
    const inserted = await client.query<{ id: string }>(
      `SELECT o.id FROM checkout.orders o
        WHERE o.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM checkout.order_items i WHERE i.order_id = o.id)`,
      [orders.map((o) => o.id)],
    );
    const needItems = new Set(inserted.rows.map((r) => r.id));
    const flat = orders
      .filter((o) => needItems.has(o.id))
      .flatMap((o) => o.items.map((item) => ({ orderId: o.id, ...item })));
    if (flat.length)
      await client.query(
        `INSERT INTO checkout.order_items (order_id, sku, quantity, price_cents)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[], $4::int[])`,
        [
          flat.map((i) => i.orderId),
          flat.map((i) => i.sku),
          flat.map((i) => i.quantity),
          flat.map((i) => i.priceCents),
        ],
      );

    // Lock order of ARCHITECTURE 5.1 step 4-5, taken ONCE up front: the
    // collection row first (only when a baseline key has to be inserted), then
    // every baseline member row in sorted key order. Inserts and restores below
    // then re-enter locks this transaction already holds, so `seed
    // --reset-config` (a live repair tool) cannot deadlock against an action
    // commit or the owner edit.
    const keys = Object.keys(HEALTHY_BASELINE).sort();
    const peek = await client.query<{ key: string }>(
      'SELECT key FROM checkout.config_entries WHERE key = ANY($1::text[])',
      [keys],
    );
    const present = new Set(peek.rows.map((r) => r.key));
    // A retry (attempt > 1) always takes the collection: it follows a peek that
    // raced a concurrent delete.
    const needCollection = attempt > 1 || keys.some((k) => !present.has(k));
    await lockConfigRows(client, { keys, collection: needCollection });
    const rows = await client.query<{ key: string; value: ConfigScalar }>(
      'SELECT key, value FROM checkout.config_entries WHERE key = ANY($1::text[])',
      [keys],
    );
    const existing = new Map(rows.rows.map((r) => [r.key, r.value]));
    if (!needCollection && existing.size !== keys.length)
      // a key vanished between the peek and the member locks: restart with the
      // collection locked first (SQLSTATE 40001 is retried by withTransaction)
      throw Object.assign(
        new Error('baseline key removed concurrently; retrying'),
        { code: '40001' },
      );
    for (const key of keys) {
      const value = HEALTHY_BASELINE[key];
      if (!existing.has(key)) {
        await advanceConfig(client, {
          key,
          value,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'seed' },
        });
        configInserted.push(key);
      } else if (options.restoreConfig && existing.get(key) !== value) {
        await advanceConfigUnconditionally(client, {
          key,
          value,
          causedBy: { actor: 'seed' },
        });
        configRestored.push(key);
      }
    }
  });
  const counts = await pool.query<{
    products: string;
    orders: string;
    inventory: string;
  }>(
    `SELECT (SELECT count(*) FROM checkout.products WHERE listed) AS products,
            (SELECT count(*) FROM checkout.orders WHERE probe_run_id IS NULL) AS orders,
            (SELECT count(*) FROM checkout.inventory) AS inventory`,
  );
  return {
    products: Number(counts.rows[0].products),
    orders: Number(counts.rows[0].orders),
    inventoryRows: Number(counts.rows[0].inventory),
    configInserted,
    configRestored,
  };
}

async function main(argv: string[]) {
  const restoreConfig = argv.includes('--reset-config');
  const unknown = argv.filter((arg) => arg !== '--reset-config');
  if (unknown.length) {
    console.error(`seed: unknown arguments: ${unknown.join(' ')}`);
    return 2;
  }
  const config = loadConfig();
  // `nemodots:stack start` does not migrate, so a freshly initialised instance
  // has no checkout schema yet. The seed brings the schema up to date first
  // (idempotent: a migrated database is left alone) instead of failing with
  // 'relation "checkout.products" does not exist'.
  const migrated = await migrate({
    connectionString: roleUrl(config, 'admin'),
    log: (line) => console.log(`seed: migrate: ${line}`),
  });
  if (migrated.unknown.length)
    throw new Error(
      `database has migrations this build does not know: ${migrated.unknown.join(', ')}`,
    );
  const pool = new pg.Pool({
    connectionString: roleUrl(config, 'admin'),
    max: 2,
    application_name: 'nemodots-seed',
  });
  try {
    const summary = await seedCheckout(pool, { restoreConfig });
    console.log(
      `seed: ${summary.products} listed products, ${summary.inventoryRows} inventory rows, ${summary.orders} orders; config inserted ${summary.configInserted.length}, restored ${summary.configRestored.length}`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked && pathToFileURL(invoked).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `seed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
