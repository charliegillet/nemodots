// Every fault class applied by the real injector, observed through HTTP and the
// read-only observables, then repaired by a bounded configuration change
// through advanceConfig (the same writer the action commit uses).
import { describe, expect, it } from 'vitest';
import {
  advanceConfigTx,
  configValueDigest,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { createProbe } from '../../../../src/server/nemodots/sandbox/probe.js';
import { withSandbox, type Sandbox } from './harness.js';

/** The bounded repair: a CAS write as the app role (what an admitted action does). */
async function repair(
  s: Sandbox,
  key: string,
  value: string | number | boolean,
) {
  const row = await s.pools.app.query(
    'SELECT version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  const result = await advanceConfigTx(s.pools.app, {
    key,
    value,
    expectedVersion: Number(row.rows[0].version),
    causedBy: { actor: 'owner' },
  });
  s.reloadConfig();
  return result;
}

const order = (s: Sandbox, sku = 'SKU-0001', quantity = 1) =>
  s.request('/orders', { body: { items: [{ sku, quantity }] } });

describe('B1 benign change', () => {
  it('changes only the banner: health stays ok, nothing else advances', async () => {
    await withSandbox(async (s) => {
      expect((await s.request('/health')).status).toBe(200);
      const before = await s.pools.verifier.query(
        'SELECT key, version FROM checkout.config_entries ORDER BY key',
      );
      const collectionBefore = await s.pools.verifier.query(
        'SELECT version FROM checkout.config_collection',
      );
      const run = await s.inject('benign_change', 1);
      expect((await run.done).status).toBe('completed');
      s.reloadConfig();
      const health = await s.request('/health');
      expect(health.body.status).toBe('ok');
      expect((await order(s)).status).toBe(201);
      const after = await s.pools.verifier.query(
        'SELECT key, version FROM checkout.config_entries ORDER BY key',
      );
      const changed = after.rows.filter(
        (row, i) => row.version !== before.rows[i].version,
      );
      expect(changed.map((row) => row.key)).toEqual(['ui.banner_text']);
      expect(
        (
          await s.pools.verifier.query(
            'SELECT version FROM checkout.config_collection',
          )
        ).rows,
      ).toEqual(collectionBefore.rows);
      expect((await s.request('/products')).body.banner).not.toBeNull();
    });
  });

  it('the healthy control scenario injects nothing', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('healthy');
      const summary = await run.done;
      expect(summary).toMatchObject({ status: 'completed', steps: [] });
      expect(
        (
          await s.pools.verifier.query(
            'SELECT count(*) AS n FROM checkout.config_versions WHERE version > 1',
          )
        ).rows[0].n,
      ).toBe('0');
    });
  });
});

describe('F2 cache schema mismatch', () => {
  async function inject(s: Sandbox) {
    // warm the namespace at the baseline schema: a health check writes its canary
    expect((await s.request('/health')).status).toBe(200);
    expect((await s.request('/products')).status).toBe(200);
    const run = await s.inject('cache_schema_mismatch', 1);
    expect((await run.done).status).toBe('completed');
    s.reloadConfig();
  }

  it('answers 500 cache_decode_error with expected/found schema in /metrics and /health', async () => {
    await withSandbox(async (s) => {
      await inject(s);
      const products = await s.request('/products');
      expect(products.status).toBe(500);
      expect(products.body.error).toBe('cache_decode_error');
      expect(products.body.foundSchema).toBe(1);
      expect(products.body.expectedSchema).toBeGreaterThan(1);
      const metrics = (await s.request('/metrics')).body;
      expect(metrics.cache_decode_error).toEqual({
        expectedSchema: products.body.expectedSchema,
        foundSchema: 1,
      });
      expect(metrics.errors.windowClasses).toContain('cache_decode_error');
      const health = await s.request('/health');
      expect(health.status).toBe(503);
      expect(health.body.status).toBe('degraded');
      expect(health.body.errors).toEqual(['cache_decode_error']);
      // orders do not depend on the cache: the fault is isolated to cached reads
      expect((await order(s)).status).toBe(201);
    });
  });

  it('repair by setting the schema back restores /health ok, products and orders; the error leaves the window', async () => {
    await withSandbox(async (s) => {
      await inject(s);
      expect((await s.request('/products')).status).toBe(500);
      const result = await repair(s, 'cache.schema_version', 1);
      expect(result.versionAfter).toBe(3);
      expect((await s.request('/health')).body.status).toBe('ok');
      expect((await s.request('/products')).status).toBe(200);
      expect((await order(s)).status).toBe(201);
      s.clock.advance(31_000);
      const metrics = (await s.request('/metrics')).body;
      expect(metrics.cache_decode_error).toBeNull();
      expect(metrics.errors.windowClasses).toEqual([]);
    });
  });

  it('repair by flushing the namespace also works (blobs of the old schema are gone)', async () => {
    await withSandbox(async (s) => {
      await inject(s);
      expect((await s.request('/products')).status).toBe(500);
      const keys: string[] = [];
      for await (const batch of s.redis.client.scanIterator({
        MATCH: `${s.redis.prefix}:cache:catalog-a:*`,
      }))
        keys.push(...batch);
      expect(keys.length).toBeGreaterThan(0);
      await s.redis.client.unlink(keys);
      expect((await s.request('/products')).status).toBe(200);
      expect((await s.request('/health')).body.status).toBe('ok');
    });
  });
});

describe('F3 pool starvation', () => {
  const burst = (s: Sandbox) =>
    Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        order(s, `SKU-${String(1 + i).padStart(4, '0')}`),
      ),
    );

  it('answers 503 pool_timeout under 10 concurrent requests; raising db.pool_max repairs it', async () => {
    await withSandbox(async (s) => {
      expect((await burst(s)).every((r) => r.status === 201)).toBe(true);
      const run = await s.inject('pool_starvation', 1);
      expect((await run.done).status).toBe('completed');
      s.reloadConfig();
      const responses = await burst(s);
      const failed = responses.filter((r) => r.status === 503);
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((r) => r.body.error === 'pool_timeout')).toBe(true);
      expect(responses.some((r) => r.status === 201)).toBe(true);
      const health = await s.request('/health');
      expect(health.status).toBe(503);
      expect(health.body.status).toBe('degraded');
      expect(health.body.errors).toContain('pool_exhausted');
      expect((await s.request('/metrics')).body.errors.windowClasses).toContain(
        'pool_timeout',
      );

      await repair(s, 'db.pool_max', 10);
      expect((await burst(s)).every((r) => r.status === 201)).toBe(true);
      expect((await s.request('/health')).body.status).toBe('ok');
    });
  });
});

describe('/health capacity self-test', () => {
  const polls = (s: Sandbox, n: number) =>
    Promise.all(Array.from({ length: n }, () => s.request('/health')));

  it('12 concurrent /health polls on a healthy checkout all report ok, round after round, and leave /metrics untouched', async () => {
    await withSandbox(async (s) => {
      for (let round = 0; round < 4; round += 1) {
        const responses = await polls(s, 12);
        expect(responses.map((r) => r.body.status)).toEqual(
          Array(12).fill('ok'),
        );
        expect(responses.every((r) => r.status === 200)).toBe(true);
        expect(responses.flatMap((r) => r.body.errors)).toEqual([]);
        s.clock.advance(1_100); // let the shared self-test result expire
      }
      const metrics = (await s.request('/metrics')).body;
      expect(metrics.errors.windowClasses).toEqual([]);
      expect(metrics.errors.byClass).toEqual({});
      expect(metrics.requests.total).toBe(0);
    });
  });

  it('health polls alongside customer traffic never starve each other on a healthy pool', async () => {
    await withSandbox(async (s) => {
      for (let round = 0; round < 3; round += 1) {
        const [health, ...customers] = await Promise.all([
          polls(s, 6),
          ...Array.from({ length: 4 }, () => s.request('/inventory/SKU-0001')),
        ]);
        expect(health.map((r) => r.body.status)).toEqual(Array(6).fill('ok'));
        expect(customers.every((r) => r.status === 200)).toBe(true);
        s.clock.advance(1_100);
      }
    });
  });

  it('with db.pool_max too small every concurrent poll still reports pool_exhausted, without writing pool_timeout into /metrics', async () => {
    await withSandbox(async (s) => {
      expect(
        (await s.inject('pool_starvation', 1).then((r) => r.done)).status,
      ).toBe('completed');
      s.reloadConfig();
      const responses = await polls(s, 8);
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(response.body.status).toBe('degraded');
        expect(response.body.errors).toContain('pool_exhausted');
        expect(response.body.checks.pool).toBe(false);
      }
      // only customer traffic is written to the windows, never the self-test
      const metrics = (await s.request('/metrics')).body;
      expect(metrics.errors.windowClasses).toEqual([]);
      // the repair is seen on the next poll although the earlier result was shared
      await repair(s, 'db.pool_max', 10);
      expect((await polls(s, 8)).map((r) => r.body.status)).toEqual(
        Array(8).fill('ok'),
      );
    });
  });
});

describe('/health capacity self-test does not compete with customer traffic', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('at db.pool_max=2 a request arriving during /health is never refused, and /metrics stays free of error classes', async () => {
    await withSandbox(async (s) => {
      await repair(s, 'db.pool_max', 2);
      const statuses: number[] = [];
      for (let trial = 0; trial < 12; trial += 1) {
        s.clock.advance(1_100); // expire the shared capacity result: a real self-test runs
        const health = s.request('/health');
        await sleep(5);
        const inventory = await s.request('/inventory/SKU-0001');
        const placed = await order(s, 'SKU-0002');
        statuses.push(inventory.status, placed.status);
        expect((await health).body.status).toBe('ok');
      }
      expect(statuses.filter((status) => status !== 200 && status !== 201)).toEqual(
        [],
      );
      const metrics = (await s.request('/metrics')).body;
      expect(metrics.errors.windowClasses).toEqual([]);
      expect(metrics.errors.byClass).toEqual({});
    });
  });

  it('evidence-neutral reader traffic (probe-tagged GET) never enters the metrics windows', async () => {
    await withSandbox(async (s) => {
      const tagged = await s.request('/inventory/SKU-0001', {
        headers: s.probeHeader('observer-readers'),
      });
      expect(tagged.status).toBe(200);
      expect((await s.request('/metrics')).body.requests.total).toBe(0);
      expect((await s.request('/inventory/SKU-0001')).status).toBe(200);
      expect((await s.request('/metrics')).body.requests.total).toBe(1);
    });
  });
});

describe('F4 stale replica', () => {
  it('is observable with zero customer traffic: the lagging replica already disagrees with the authority and the scarce SKU oversells', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('stale_replica', 1);
      expect((await run.done).status).toBe('completed');
      s.reloadConfig();
      expect((await s.request('/health')).body.status).toBe('ok');
      const view = await s.request('/inventory/SKU-0024');
      expect(view.body).toEqual({
        sku: 'SKU-0024',
        quantity: 5,
        source: 'replica_stale',
      });
      // two more units than the authority holds sell against the stale view
      const sold = await order(s, 'SKU-0024', 4);
      expect(sold.status).toBe(201);
      const stock = await s.pools.verifier.query(
        "SELECT quantity FROM checkout.inventory WHERE sku = 'SKU-0024'",
      );
      expect(stock.rows[0].quantity).toBe(-1);
    });
  });

  it('orders still succeed, /health stays ok, stock is oversold and visible to the verifier; the probe names the invariant; routing back to primary repairs it', async () => {
    await withSandbox(async (s) => {
      const probe = createProbe({
        verifier: s.pools.verifier,
        checkoutUrl: 'http://checkout.invalid',
        probeSecret: s.probeSecret,
        windowMs: 0,
        fetch: s.fetch,
      });
      // a few healthy orders first: the replica snapshot is now behind the primary
      expect((await order(s, 'SKU-0024', 2)).status).toBe(201);
      expect((await probe.execute()).verdict).toBe('pass');

      const run = await s.inject('stale_replica', 1);
      expect((await run.done).status).toBe('completed');
      s.reloadConfig();
      expect((await s.request('/health')).body.status).toBe('ok');

      // SKU-0024 has 1 unit left, the replica still says 5: two more units sell
      const first = await order(s, 'SKU-0024', 2);
      expect(first.status).toBe(201);
      const stock = await s.pools.verifier.query(
        "SELECT quantity FROM checkout.inventory WHERE sku = 'SKU-0024'",
      );
      expect(stock.rows[0].quantity).toBe(-1);
      const view = await s.request('/inventory/SKU-0024');
      expect(view.body).toEqual({
        sku: 'SKU-0024',
        quantity: 5,
        source: 'replica_stale',
      });

      const result = await probe.execute();
      expect(result.verdict).toBe('fail');
      const failing = result.invariants.filter((i) => !i.ok).map((i) => i.name);
      expect(failing).toContain('inventory_view_consistent');
      expect(failing).toContain('no_negative_inventory');
      expect(
        result.invariants.find((i) => i.name === 'order_created')?.ok,
      ).toBe(true);

      await repair(s, 'routing.inventory_source', 'primary');
      const after = await s.request('/inventory/SKU-0024');
      expect(after.body).toEqual({
        sku: 'SKU-0024',
        quantity: -1,
        source: 'primary',
      });
      // the config repair fixed the routing; the oversold row is data damage the
      // probe correctly keeps reporting
      const repaired = await probe.execute();
      expect(
        repaired.invariants.find((i) => i.name === 'inventory_view_consistent')
          ?.ok,
      ).toBe(true);
      expect(
        repaired.invariants.find((i) => i.name === 'no_negative_inventory')?.ok,
      ).toBe(false);
    });
  });

  it('without an oversell the probe fails only the view invariant and passes after the routing repair', async () => {
    await withSandbox(async (s) => {
      const probe = createProbe({
        verifier: s.pools.verifier,
        checkoutUrl: 'http://checkout.invalid',
        probeSecret: s.probeSecret,
        windowMs: 0,
        fetch: s.fetch,
      });
      expect((await order(s, 'SKU-0001', 1)).status).toBe(201);
      await (
        await s.inject('stale_replica', 1)
      ).done;
      s.reloadConfig();
      // a probe order against the stale view decrements the authority but the
      // API view (frozen replica) does not follow
      const failed = await probe.execute();
      expect(failed.verdict).toBe('fail');
      expect(failed.invariants.filter((i) => !i.ok).map((i) => i.name)).toEqual(
        ['inventory_view_consistent'],
      );
      await repair(s, 'routing.inventory_source', 'primary');
      const passed = await probe.execute();
      expect(passed.verdict).toBe('pass');
    });
  });
});

describe('F5 writes disabled', () => {
  it('answers 503 writes_disabled, degrades /health, and is repaired by re-enabling writes', async () => {
    await withSandbox(async (s) => {
      expect((await order(s)).status).toBe(201);
      const run = await s.inject('writes_disabled', 1);
      expect((await run.done).status).toBe('completed');
      s.reloadConfig();
      const refused = await order(s);
      expect(refused.status).toBe(503);
      expect(refused.body.error).toBe('writes_disabled');
      const health = await s.request('/health');
      expect(health.body.status).toBe('degraded');
      expect(health.body.errors).toEqual(['writes_disabled']);
      expect(health.body.checks.writes).toBe(false);
      // reads keep working
      expect((await s.request('/products')).status).toBe(200);
      await repair(s, 'orders.write_enabled', true);
      expect((await s.request('/health')).body.status).toBe('ok');
      expect((await order(s)).status).toBe(201);
    });
  });
});

describe('injector bookkeeping', () => {
  it('records the run in control.* (readable by the verifier only) and tags revisions as the injector', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('writes_disabled', 1);
      await run.done;
      const runs = await s.pools.verifier.query(
        'SELECT scenario_id, seed, status FROM control.scenario_runs',
      );
      expect(runs.rows).toEqual([
        { scenario_id: 'writes_disabled', seed: 1, status: 'completed' },
      ]);
      const steps = await s.pools.verifier.query(
        'SELECT step_index, status, config_key, version_before, version_after FROM control.fault_schedules',
      );
      expect(steps.rows).toEqual([
        {
          step_index: 0,
          status: 'applied',
          config_key: 'orders.write_enabled',
          version_before: '1',
          version_after: '2',
        },
      ]);
      const head = await s.pools.verifier.query(
        "SELECT caused_by_actor, caused_by_action_id, value FROM checkout.config_entries WHERE key = 'orders.write_enabled'",
      );
      expect(head.rows[0]).toEqual({
        caused_by_actor: 'injector',
        caused_by_action_id: null,
        value: false,
      });
      const history = await s.pools.verifier.query(
        "SELECT before_digest, after_digest FROM checkout.config_versions WHERE key = 'orders.write_enabled' AND version = 2",
      );
      expect(history.rows[0]).toEqual({
        before_digest: configValueDigest(true),
        after_digest: configValueDigest(false),
      });
      // no scenario id or diagnosis is reachable by the roles agents use
      await expect(
        s.pools.app.query('SELECT 1 FROM control.scenario_runs'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        s.pools.checkout.query('SELECT 1 FROM control.fault_schedules'),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('is deterministic per (scenario, seed) and varies values across seeds', async () => {
    const { loadScenario, resolveScenario } =
      await import('../../../../src/server/nemodots/sandbox/manifest.js');
    const manifest = loadScenario('cache_schema_mismatch');
    expect(resolveScenario(manifest, 7)).toEqual(resolveScenario(manifest, 7));
    const values = new Set(
      Array.from(
        { length: 40 },
        (_, seed) => resolveScenario(manifest, seed)[0].value,
      ),
    );
    expect([...values].sort()).toEqual([2, 3, 4]);
  });
});
