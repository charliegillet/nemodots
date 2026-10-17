// The deterministic seed: shape, idempotence and the baseline config.
import { expect, it } from 'vitest';
import {
  HEALTHY_BASELINE,
  seedCheckout,
} from '../../../../src/server/nemodots/sandbox/seed.js';
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
    expect(s.replica).toEqual(s.inventory);
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
    await pools.injector.query(
      "UPDATE checkout.config_entries SET value = '1'::jsonb, version = version + 1 WHERE key = 'db.pool_max'",
    );
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
    await pools.checkout.query(
      "UPDATE checkout.inventory SET quantity = quantity - 5 WHERE sku = 'SKU-0001'",
    );
    await seedCheckout(pools.admin);
    const rows = await pools.verifier.query(
      "SELECT i.quantity AS primary, r.quantity AS replica FROM checkout.inventory i JOIN checkout.inventory_replica r USING (sku) WHERE sku = 'SKU-0001'",
    );
    expect(rows.rows[0].replica - rows.rows[0].primary).toBe(5);
  });
});
