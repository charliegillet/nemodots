// The deterministic seed: shape, idempotence and the baseline config.
import { spawn } from 'node:child_process';
import pg from 'pg';
import { expect, it } from 'vitest';
import { withTestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';
import {
  HEALTHY_BASELINE,
  seedCheckout,
} from '../../../../src/server/nemodots/sandbox/seed.js';
import { advanceConfigTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withSandbox } from './harness.js';

const snapshot = async (pool: import('pg').Pool) => {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  return {
    products: await q('SELECT * FROM checkout.products ORDER BY sku'),
    inventory: await q(
      'SELECT sku, quantity FROM checkout.inventory ORDER BY sku',
    ),
    replica: await q(
      'SELECT sku, quantity FROM checkout.inventory_replica ORDER BY sku',
    ),
    orders: await q(
      'SELECT id, status, customer, total_cents, created_at FROM checkout.orders ORDER BY id',
    ),
    items: await q(
      'SELECT order_id, sku, quantity, price_cents FROM checkout.order_items ORDER BY order_id, sku',
    ),
    config: await q(
      'SELECT key, value, version FROM checkout.config_entries ORDER BY key',
    ),
    versions: await q(
      'SELECT key, version FROM checkout.config_versions ORDER BY key, version',
    ),
    collection: await q('SELECT version FROM checkout.config_collection'),
  };
};

it('seeds 24 listed products, PROBE-SKU, 200 orders and the healthy baseline', async () => {
  await withSandbox(async ({ pools }) => {
    const s = await snapshot(pools.verifier);
    expect(s.products.filter((p) => p.listed)).toHaveLength(24);
    expect(s.products.filter((p) => !p.listed).map((p) => p.sku)).toEqual([
      'PROBE-SKU',
    ]);
    expect(s.inventory).toHaveLength(25);
    // the replica is a lagging snapshot: never below the primary, strictly
    // above it for the SKUs the last seed orders touched, level for PROBE-SKU
    expect(s.replica.map((r) => r.sku)).toEqual(s.inventory.map((r) => r.sku));
    s.replica.forEach((row, i) => {
      expect(row.quantity).toBeGreaterThanOrEqual(s.inventory[i].quantity);
      if (row.sku === 'PROBE-SKU')
        expect(row.quantity).toBe(s.inventory[i].quantity);
    });
    expect(
      s.replica.filter((r, i) => r.quantity > s.inventory[i].quantity).length,
    ).toBeGreaterThanOrEqual(10);
    const scarce = (rows: { sku: string; quantity: number }[]) =>
      rows.find((r) => r.sku === 'SKU-0024')!.quantity;
    expect(scarce(s.inventory)).toBe(3);
    expect(scarce(s.replica)).toBe(5);
    expect(s.orders).toHaveLength(200);
    expect(s.items.length).toBeGreaterThanOrEqual(200);
    expect(Object.fromEntries(s.config.map((c) => [c.key, c.value]))).toEqual(
      HEALTHY_BASELINE,
    );
    expect(s.config.every((c) => c.version === '1')).toBe(true);
    expect(s.collection).toEqual([{ version: '8' }]);
    // every historical order total equals the sum of its lines
    const mismatched = await pools.verifier.query(
      `SELECT o.id FROM checkout.orders o
         JOIN checkout.order_items i ON i.order_id = o.id
        GROUP BY o.id, o.total_cents
       HAVING sum(i.quantity * i.price_cents) <> o.total_cents`,
    );
    expect(mismatched.rows).toHaveLength(0);
    // seed orders are old: nothing counts as a recent order
    const recent = await pools.verifier.query(
      "SELECT count(*) AS n FROM checkout.orders WHERE created_at > now() - interval '10 minutes'",
    );
    expect(recent.rows[0].n).toBe('0');
  });
});

it('is idempotent: a second run changes nothing, including config versions and history', async () => {
  await withSandbox(async ({ pools }) => {
    const before = await snapshot(pools.verifier);
    const summary = await seedCheckout(pools.admin);
    expect(summary).toMatchObject({
      products: 24,
      orders: 200,
      inventoryRows: 25,
      configInserted: [],
      configRestored: [],
    });
    expect(await snapshot(pools.verifier)).toEqual(before);
  });
});

it('does not rewind a changed config unless asked; --reset-config restores through the version authority', async () => {
  await withSandbox(async ({ pools }) => {
    await advanceConfigTx(pools.injector, {
      key: 'db.pool_max',
      value: 1,
      expectedVersion: 1,
      causedBy: { actor: 'injector' },
    });
    const kept = await seedCheckout(pools.admin);
    expect(kept.configRestored).toEqual([]);
    const restored = await seedCheckout(pools.admin, { restoreConfig: true });
    expect(restored.configRestored).toEqual(['db.pool_max']);
    const row = await pools.verifier.query(
      "SELECT value, version, caused_by_actor FROM checkout.config_entries WHERE key = 'db.pool_max'",
    );
    expect(row.rows[0]).toEqual({
      value: 10,
      version: '3',
      caused_by_actor: 'seed',
    });
  });
});

it('keeps stock and replica separate: the replica snapshot is never refreshed by a reseed', async () => {
  await withSandbox(async ({ pools }) => {
    const gap = async () => {
      const rows = await pools.verifier.query(
        "SELECT i.quantity AS primary, r.quantity AS replica FROM checkout.inventory i JOIN checkout.inventory_replica r USING (sku) WHERE sku = 'SKU-0001'",
      );
      return rows.rows[0].replica - rows.rows[0].primary;
    };
    const seeded = await gap();
    await pools.checkout.query(
      "UPDATE checkout.inventory SET quantity = quantity - 5 WHERE sku = 'SKU-0001'",
    );
    await seedCheckout(pools.admin);
    expect(await gap()).toBe(seeded + 5);
  });
});

it('the seed command migrates a freshly initialised database first (stack start does not), then seeds and is repeatable', async () => {
  await withTestDatabase(
    async (db) =>
      withTestRedis(async (redis) => {
        const seedCli = () =>
          new Promise<{ code: number | null; out: string; err: string }>(
            (resolve) => {
              const child = spawn(
                process.execPath,
                ['--import', 'tsx', 'src/server/nemodots/sandbox/seed.ts'],
                {
                  cwd: process.cwd(),
                  env: {
                    PATH: process.env.PATH ?? '',
                    LC_ALL: 'C',
                    NEMODOTS_PG_URL_ADMIN: db.urls.admin,
                    NEMODOTS_PG_URL_APP: db.urls.app,
                    NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
                    NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
                    NEMODOTS_PG_URL_CHECKOUT: db.urls.checkout,
                    NEMODOTS_PROBE_SECRET: 'seed-test-secret',
                    NEMODOTS_REDIS_URL: redis.url,
                  },
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
              let out = '';
              let err = '';
              child.stdout.on('data', (chunk) => (out += chunk));
              child.stderr.on('data', (chunk) => (err += chunk));
              child.on('close', (code) => resolve({ code, out, err }));
            },
          );
        const admin = new pg.Pool({ connectionString: db.urls.admin, max: 1 });
        try {
          const empty = await admin.query(
            "SELECT to_regclass('checkout.products') AS t",
          );
          expect(empty.rows[0].t).toBeNull();
          const first = await seedCli();
          expect(first.err).toBe('');
          expect(first.code).toBe(0);
          expect(first.out).toContain('applied 0004_checkout');
          expect(first.out).toMatch(
            /24 listed products, 25 inventory rows, 200 orders/,
          );
          const second = await seedCli();
          expect(second.code).toBe(0);
          expect(second.out).toContain('config inserted 0');
          expect(second.out).not.toContain('applied');
        } finally {
          await admin.end();
        }
      }),
    { migrate: false },
  );
});
