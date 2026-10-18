// The healthy checkout over HTTP (app.request): catalog, cache-aside, orders,
// inventory arithmetic, config-driven health and Redis dependence.
import { describe, expect, it } from 'vitest';
import { withSandbox } from './harness.js';

describe('healthy checkout', () => {
  it('serves /health ok and /ready', async () => {
    await withSandbox(async (s) => {
      const health = await s.request('/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({
        status: 'ok',
        checks: {
          postgres: true,
          redis: true,
          config_parse: true,
          writes: true,
          cache: true,
          pool: true,
        },
        errors: [],
      });
      expect((await s.request('/ready')).body).toEqual({
        ready: true,
        reasons: [],
      });
    });
  });

  it('health is deterministic: repeated calls return the same body', async () => {
    await withSandbox(async (s) => {
      const first = await s.request('/health');
      const second = await s.request('/health');
      const third = await s.request('/health');
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
    });
  });

  it('creates and reads an order; inventory falls by exactly the ordered quantity', async () => {
    await withSandbox(async (s) => {
      const stock = async (sku: string) =>
        (
          await s.pools.verifier.query(
            'SELECT quantity FROM checkout.inventory WHERE sku = $1',
            [sku],
          )
        ).rows[0].quantity as number;
      const a0 = await stock('SKU-0001');
      const b0 = await stock('SKU-0002');
      const created = await s.request('/orders', {
        body: {
          customer: 'alice',
          items: [
            { sku: 'SKU-0001', quantity: 2 },
            { sku: 'SKU-0002', quantity: 1 },
            { sku: 'SKU-0001', quantity: 1 },
          ],
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('confirmed');
      expect(created.body.items).toEqual([
        expect.objectContaining({ sku: 'SKU-0001', quantity: 3 }),
        expect.objectContaining({ sku: 'SKU-0002', quantity: 1 }),
      ]);
      expect(await stock('SKU-0001')).toBe(a0 - 3);
      expect(await stock('SKU-0002')).toBe(b0 - 1);
      const read = await s.request(`/orders/${created.body.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual(created.body);
      const view = await s.request('/inventory/SKU-0001');
      expect(view.body).toEqual({
        sku: 'SKU-0001',
        quantity: a0 - 3,
        source: 'primary',
      });
    });
  });

  it('rejects bad input, unknown skus, insufficient stock; nothing is written on failure', async () => {
    await withSandbox(async (s) => {
      const orders = async () =>
        Number(
          (
            await s.pools.verifier.query(
              'SELECT count(*) AS n FROM checkout.orders',
            )
          ).rows[0].n,
        );
      const before = await orders();
      expect((await s.request('/orders', { body: { items: [] } })).status).toBe(
        400,
      );
      expect(
        (
          await s.request('/orders', {
            body: { items: [{ sku: 'NOPE-0001', quantity: 1 }] },
          })
        ).status,
      ).toBe(404);
      // SKU-0024 is scarce (3 units)
      const tooMany = await s.request('/orders', {
        body: {
          items: [
            { sku: 'SKU-0001', quantity: 1 },
            { sku: 'SKU-0024', quantity: 4 },
          ],
        },
      });
      expect(tooMany.status).toBe(409);
      expect(tooMany.body.error).toBe('out_of_stock');
      expect(await orders()).toBe(before);
      const stock = await s.pools.verifier.query(
        "SELECT quantity FROM checkout.inventory WHERE sku IN ('SKU-0001','SKU-0024') ORDER BY sku",
      );
      expect(stock.rows[1].quantity).toBe(3);
      expect((await s.request('/orders/not-a-uuid')).status).toBe(400);
      expect(
        (await s.request('/orders/00000000-0000-4000-8000-000000000000'))
          .status,
      ).toBe(404);
      expect((await s.request('/nope')).status).toBe(404);
    });
  });

  it('caches the catalog in Redis under <prefix>:cache:<namespace>:v<schema>: and hits on the second read', async () => {
    await withSandbox(async (s) => {
      const first = await s.request('/products');
      expect(first.status).toBe(200);
      expect(first.body.products).toHaveLength(24);
      expect(
        first.body.products.map((p: { sku: string }) => p.sku),
      ).not.toContain('PROBE-SKU');
      const key = `${s.redis.prefix}:cache:catalog-a:v1:products`;
      expect(await s.redis.client.exists(key)).toBe(1);
      expect(await s.redis.client.ttl(key)).toBeGreaterThan(0);
      const before = (await s.request('/metrics')).body.cache;
      const second = await s.request('/products');
      expect(second.body).toEqual(first.body);
      const after = (await s.request('/metrics')).body.cache;
      expect(after.hits).toBe(before.hits + 1);
      expect(after.misses).toBe(before.misses);
    });
  });

  it('a config change takes effect only after the 250 ms config cache expires', async () => {
    await withSandbox(async (s) => {
      expect((await s.request('/health')).status).toBe(200);
      const run = await s.inject('writes_disabled');
      await run.done;
      // inside the 250 ms window the previous snapshot is still served
      expect((await s.request('/health')).body.status).toBe('ok');
      s.reloadConfig();
      expect((await s.request('/health')).body.status).toBe('degraded');
    });
  });

  it('refuses a probe tag without a valid HMAC and keeps probe orders to PROBE-SKU', async () => {
    await withSandbox(async (s) => {
      const forged = await s.request('/orders', {
        body: { items: [{ sku: 'PROBE-SKU', quantity: 1 }] },
        headers: { 'x-nemodots-probe': 'probe-12345678.' + '0'.repeat(64) },
      });
      expect(forged.status).toBe(403);
      expect(forged.body.error).toBe('probe_auth_failed');
      const scope = await s.request('/orders', {
        body: { items: [{ sku: 'SKU-0001', quantity: 1 }] },
        headers: s.probeHeader('probe-abcdef12'),
      });
      expect(scope.status).toBe(403);
      expect(scope.body.error).toBe('probe_scope');
      const ok = await s.request('/orders', {
        body: { items: [{ sku: 'PROBE-SKU', quantity: 1 }] },
        headers: s.probeHeader('probe-abcdef12'),
      });
      expect(ok.status).toBe(201);
      const tagged = await s.pools.verifier.query(
        'SELECT probe_run_id FROM checkout.orders WHERE id = $1',
        [ok.body.id],
      );
      expect(tagged.rows[0].probe_run_id).toBe('probe-abcdef12');
    });
  });
});

describe('Redis dependence', () => {
  it('/health is down when Redis is unreachable; business reads fall back to the database', async () => {
    // a port nothing listens on (not 6379)
    await withSandbox(
      async (s) => {
        const health = await s.request('/health');
        expect(health.status).toBe(503);
        expect(health.body.status).toBe('down');
        expect(health.body.checks.redis).toBe(false);
        expect(health.body.errors).toContain('redis_unreachable');
        expect((await s.request('/ready')).status).toBe(503);
        const products = await s.request('/products');
        expect(products.status).toBe(200);
        expect(products.body.products).toHaveLength(24);
        expect(
          (await s.request('/metrics')).body.errors.windowClasses,
        ).toContain('redis_unavailable');
      },
      { redisUrl: 'redis://127.0.0.1:56999/0' },
    );
  });
});
