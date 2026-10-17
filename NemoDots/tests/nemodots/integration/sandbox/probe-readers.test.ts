// The acceptance probe and the normalized source readers (ARCHITECTURE 9.4/9.5).
import { describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/digest.js';
import type {
  Scope,
  SourceKey,
} from '../../../../src/server/nemodots/contracts/ids.js';
import type { MissionId } from '../../../../src/server/nemodots/contracts/ids.js';
import {
  PROBE_LOCK_KEY,
  createProbe,
  acceptanceNormalizedValue,
} from '../../../../src/server/nemodots/sandbox/probe.js';
import {
  UnsupportedSourceError,
  createSourceReaders,
} from '../../../../src/server/nemodots/sandbox/readers.js';
import { advanceConfigTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withSandbox, type Sandbox } from './harness.js';

const scope = {
  ownerId: 'owner',
  missionId: '11111111-1111-4111-8111-111111111111',
  spaceId: null,
  environment: 'test',
  resource: 'checkout',
} as unknown as Scope;

const readers = (s: Sandbox, overrides: { redis?: boolean } = {}) =>
  createSourceReaders({
    pg: s.pools.app,
    redis: overrides.redis === false ? undefined : s.redis.client,
    redisPrefix: s.redis.prefix,
    checkoutUrl: 'http://checkout.invalid',
    fetch: s.fetch,
    now: s.clock.now,
  });
const read = (s: Sandbox, key: string) =>
  readers(s).read(key as SourceKey, scope);
const probeFor = (
  s: Sandbox,
  windowMs = 0,
  register?: Parameters<typeof createProbe>[0]['register'],
) =>
  createProbe({
    verifier: s.pools.verifier,
    checkoutUrl: 'http://checkout.invalid',
    probeSecret: s.probeSecret,
    windowMs,
    sampleIntervalMs: 50,
    fetch: s.fetch,
    register,
  });
const order = (s: Sandbox, sku = 'SKU-0001', quantity = 1) =>
  s.request('/orders', { body: { items: [{ sku, quantity }] } });

describe('readers: D2 stability', () => {
  it('5 polls of stable traffic produce an identical health/metrics/orders digest while the raw bodies differ', async () => {
    await withSandbox(async (s) => {
      // steady state: warm the cache (1 miss) and drive many hits so the hit
      // ratio sits in its final decile; two customer orders inside the window
      expect((await s.request('/products')).status).toBe(200);
      for (let i = 0; i < 30; i += 1) await s.request('/products');
      expect((await order(s)).status).toBe(201);
      expect((await order(s, 'SKU-0002')).status).toBe(201);

      const digests: string[] = [];
      const raws = new Set<string>();
      for (let poll = 0; poll < 5; poll += 1) {
        for (let i = 0; i < 3; i += 1) await s.request('/products');
        const health = await read(s, 'checkout.health');
        const metrics = await read(s, 'checkout.metrics');
        const orders = await read(s, 'checkout.orders.recent');
        digests.push(
          digest([
            health.normalizedValue,
            metrics.normalizedValue,
            orders.normalizedValue,
          ]),
        );
        raws.add(JSON.stringify(metrics.raw));
      }
      expect(new Set(digests).size).toBe(1);
      // the raw counters moved on every poll: only normalization makes it stable
      expect(raws.size).toBe(5);
      expect((await read(s, 'checkout.orders.recent')).normalizedValue).toEqual(
        {
          countBucket: '1-10',
          statuses: ['confirmed'],
        },
      );
      expect((await read(s, 'checkout.health')).normalizedValue).toEqual({
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
      expect((await read(s, 'checkout.metrics')).normalizedValue).toEqual({
        errorClasses: [],
        cacheDecodeError: null,
        cacheHitRatioDecile: 9,
        errorRateDecile: 0,
      });
    });
  });

  it('probe-tagged orders are excluded from orders.recent and from inventory normalized values', async () => {
    await withSandbox(async (s) => {
      const ordersBefore = await read(s, 'checkout.orders.recent');
      expect(ordersBefore.normalizedValue).toEqual({
        countBucket: '0',
        statuses: [],
      });
      const inventoryBefore = await read(s, 'checkout.inventory/PROBE-SKU');
      expect(inventoryBefore.normalizedValue).toEqual({
        sku: 'PROBE-SKU',
        authorityQuantity: 1_000_000,
        apiQuantity: 1_000_000,
        consistent: true,
      });

      const result = await probeFor(s).execute();
      expect(result.verdict).toBe('pass');

      // the probe really wrote its tagged order and decremented the authority...
      const tagged = await s.pools.verifier.query(
        'SELECT count(*) AS n FROM checkout.orders WHERE probe_run_id IS NOT NULL',
      );
      expect(tagged.rows[0].n).toBe('1');
      const stock = await s.pools.verifier.query(
        "SELECT quantity FROM checkout.inventory WHERE sku = 'PROBE-SKU'",
      );
      expect(stock.rows[0].quantity).toBe(999_999);
      // ...yet no observed source moved
      const ordersAfter = await read(s, 'checkout.orders.recent');
      expect(digest(ordersAfter.normalizedValue)).toBe(
        digest(ordersBefore.normalizedValue),
      );
      const inventoryAfter = await read(s, 'checkout.inventory/PROBE-SKU');
      expect(digest(inventoryAfter.normalizedValue)).toBe(
        digest(inventoryBefore.normalizedValue),
      );

      // a customer order is visible
      await order(s, 'SKU-0003', 2);
      expect((await read(s, 'checkout.orders.recent')).normalizedValue).toEqual(
        {
          countBucket: '1-10',
          statuses: ['confirmed'],
        },
      );
      const sku = (await read(s, 'checkout.inventory/SKU-0003'))
        .normalizedValue;
      expect(sku).toMatchObject({ sku: 'SKU-0003', consistent: true });
    });
  });

  it('inventory/<sku>: authority and API view diverge under the stale replica', async () => {
    await withSandbox(async (s) => {
      await order(s, 'SKU-0004', 2);
      await (
        await s.inject('stale_replica')
      ).done;
      s.reloadConfig();
      const value = (await read(s, 'checkout.inventory/SKU-0004'))
        .normalizedValue as {
        authorityQuantity: number;
        apiQuantity: number;
        consistent: boolean;
      };
      expect(value.consistent).toBe(false);
      // the API view is the frozen replica snapshot, the authority has moved on
      const replica = await s.pools.verifier.query(
        "SELECT quantity FROM checkout.inventory_replica WHERE sku = 'SKU-0004'",
      );
      expect(value.apiQuantity).toBe(replica.rows[0].quantity);
      expect(
        value.apiQuantity - value.authorityQuantity,
      ).toBeGreaterThanOrEqual(2);
      expect(
        (await read(s, 'checkout.inventory/NOT-A-SKU')).normalizedValue,
      ).toMatchObject({
        authorityQuantity: null,
        consistent: false,
      });
    });
  });
});

describe('readers: redis.stats (D7)', () => {
  it('counts keys per namespace:schema suffix and ignores everything else under the prefix', async () => {
    await withSandbox(async (s) => {
      await s.request('/health'); // canary
      await s.request('/products');
      const redis = s.redis.client;
      await redis.set(`${s.redis.prefix}:cache:catalog-a:v3:legacy`, '{}');
      await redis.set(`${s.redis.prefix}:cache:catalog-b:v1:products`, '{}');
      await redis.set(`${s.redis.prefix}:cache:catalog-b:v1:other`, '{}');
      await redis.set(`${s.redis.prefix}:fence:cache`, '1');
      const stats = await read(s, 'redis.stats');
      expect(stats.normalizedValue).toEqual({
        reachable: true,
        activeNamespace: 'catalog-a',
        keyCounts: { 'catalog-a:v1': 2, 'catalog-a:v3': 1, 'catalog-b:v1': 2 },
      });
      expect(stats.revisionHint).toBeNull();
    });
  });

  it('after a schema fault the older-suffix keys remain visible next to the active expectation', async () => {
    await withSandbox(async (s) => {
      await s.request('/health');
      await s.request('/products');
      await (
        await s.inject('cache_schema_mismatch')
      ).done;
      s.reloadConfig();
      await s.request('/products'); // 500 cache_decode_error
      const stats = (await read(s, 'redis.stats')).normalizedValue;
      expect(stats).toEqual({
        reachable: true,
        activeNamespace: 'catalog-a',
        keyCounts: { 'catalog-a:v1': 2 },
      });
      const metrics = (await read(s, 'checkout.metrics')).normalizedValue as {
        cacheDecodeError: { expectedSchema: number; foundSchema: number };
        errorClasses: string[];
      };
      expect(metrics.errorClasses).toEqual(['cache_decode_error']);
      expect(metrics.cacheDecodeError.foundSchema).toBe(1);
      expect(metrics.cacheDecodeError.expectedSchema).toBeGreaterThan(1);
      const config = (await read(s, 'checkout.config/cache.schema_version'))
        .normalizedValue;
      expect(config).toEqual({
        key: 'cache.schema_version',
        value: metrics.cacheDecodeError.expectedSchema,
        version: 2,
      });
    });
  });

  it('reports reachable:false when Redis is not wired', async () => {
    await withSandbox(async (s) => {
      const value = await readers(s, { redis: false }).read(
        'redis.stats' as SourceKey,
        scope,
      );
      expect(value.normalizedValue).toEqual({
        reachable: false,
        activeNamespace: 'catalog-a',
        keyCounts: {},
      });
    });
  });
});

describe('readers: controlled config sources', () => {
  it('checkout.config/<key> is {key,value,version} only and checkout.config is the sorted membership', async () => {
    await withSandbox(async (s) => {
      const member = await read(s, 'checkout.config/db.pool_max');
      expect(member.normalizedValue).toEqual({
        key: 'db.pool_max',
        value: 10,
        version: 1,
      });
      expect(member.revisionHint).toBe(1);
      expect(JSON.stringify(member)).not.toMatch(/caused_by|actor|seed/);

      const collection = await read(s, 'checkout.config');
      expect(collection.normalizedValue).toEqual({
        keys: [
          'cache.namespace',
          'cache.schema_version',
          'db.pool_max',
          'db.statement_timeout_ms',
          'orders.write_enabled',
          'routing.inventory_source',
          'ui.banner_text',
        ],
        collectionVersion: 8,
      });
      expect(collection.revisionHint).toBe(8);

      // value update: member version moves, membership does not
      await advanceConfigTx(s.pools.injector, {
        key: 'db.pool_max',
        value: 3,
        expectedVersion: 1,
        causedBy: { actor: 'injector' },
      });
      expect((await read(s, 'checkout.config/db.pool_max')).revisionHint).toBe(
        2,
      );
      expect((await read(s, 'checkout.config')).normalizedValue).toEqual(
        collection.normalizedValue,
      );
      // the actor is invisible in the normalized member value
      expect(
        (await read(s, 'checkout.config/db.pool_max')).normalizedValue,
      ).toEqual({
        key: 'db.pool_max',
        value: 3,
        version: 2,
      });

      // insert changes membership; a key that never existed reads as null at
      // member revision 0 (the collection version travels separately in raw)
      const absent = await read(s, 'checkout.config/exp.flag');
      expect(absent.normalizedValue).toBeNull();
      expect(absent.revisionHint).toBe(0);
      expect(absent.raw).toMatchObject({ collectionRevision: 8 });
      await advanceConfigTx(s.pools.injector, {
        key: 'exp.flag',
        value: true,
        expectedVersion: 0,
        insertIfMissing: true,
        causedBy: { actor: 'injector' },
      });
      const after = (await read(s, 'checkout.config')).normalizedValue as {
        keys: string[];
        collectionVersion: number;
      };
      expect(after.collectionVersion).toBe(9);
      expect(after.keys).toContain('exp.flag');
      expect([...after.keys].sort()).toEqual(after.keys);
    });
  });

  it('an absent member is reported at its own tombstone revision: delete -> read -> re-insert -> read strictly increases', async () => {
    await withSandbox(async (s) => {
      const key = 'exp.flag';
      const insert = (value: boolean) =>
        advanceConfigTx(s.pools.injector, {
          key,
          value,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
      // push the collection counter well past the member counter
      await insert(true);
      const bump = await advanceConfigTx(s.pools.injector, {
        key,
        value: false,
        expectedVersion: 1,
        causedBy: { actor: 'injector' },
      });
      for (const other of ['exp.a', 'exp.b', 'exp.c']) {
        await advanceConfigTx(s.pools.injector, {
          key: other,
          value: 1,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
        await advanceConfigTx(s.pools.injector, {
          key: other,
          deleteKey: true,
          expectedVersion: 1,
          causedBy: { actor: 'injector' },
        });
      }
      const present = await read(s, `checkout.config/${key}`);
      expect(present.revisionHint).toBe(bump.versionAfter);
      await advanceConfigTx(s.pools.injector, {
        key,
        deleteKey: true,
        expectedVersion: bump.versionAfter,
        causedBy: { actor: 'injector' },
      });
      const absent = await read(s, `checkout.config/${key}`);
      expect(absent.normalizedValue).toBeNull();
      expect(absent.revisionHint).toBe(bump.versionAfter + 1);
      const collectionNow = (
        (await read(s, 'checkout.config')).normalizedValue as {
          collectionVersion: number;
        }
      ).collectionVersion;
      expect(collectionNow).toBeGreaterThan(absent.revisionHint as number);
      expect(
        (absent.raw as { collectionRevision: number }).collectionRevision,
      ).toBe(collectionNow);
      await insert(true);
      const again = await read(s, `checkout.config/${key}`);
      expect(again.revisionHint).toBe(bump.versionAfter + 2);
      expect(present.revisionHint as number).toBeLessThan(
        absent.revisionHint as number,
      );
      expect(absent.revisionHint as number).toBeLessThan(
        again.revisionHint as number,
      );
    });
  });

  it('reader traffic carries the observer tag when given the probe secret: /inventory/<sku> stays out of the metrics windows', async () => {
    await withSandbox(async (s) => {
      const tagged = createSourceReaders({
        pg: s.pools.app,
        redisPrefix: s.redis.prefix,
        checkoutUrl: 'http://checkout.invalid',
        fetch: s.fetch,
        now: s.clock.now,
        probeSecret: s.probeSecret,
      });
      const value = (
        await tagged.read('checkout.inventory/SKU-0001' as SourceKey, scope)
      ).normalizedValue as { consistent: boolean };
      expect(value.consistent).toBe(true);
      expect((await s.request('/metrics')).body.requests.total).toBe(0);
      // without the secret the read is ordinary tracked traffic
      await read(s, 'checkout.inventory/SKU-0001');
      expect((await s.request('/metrics')).body.requests.total).toBeGreaterThan(
        0,
      );
    });
  });

  it('health/metrics readers report an unreachable checkout instead of throwing; unsupported keys throw', async () => {
    await withSandbox(async (s) => {
      const down = createSourceReaders({
        pg: s.pools.app,
        redisPrefix: s.redis.prefix,
        checkoutUrl: 'http://checkout.invalid',
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      });
      expect(
        (await down.read('checkout.health' as SourceKey, scope))
          .normalizedValue,
      ).toMatchObject({
        status: 'down',
        errors: ['checkout_unreachable'],
      });
      expect(
        (await down.read('checkout.metrics' as SourceKey, scope))
          .normalizedValue,
      ).toMatchObject({
        errorClasses: ['checkout_unreachable'],
      });
      await expect(read(s, 'checkout.acceptance')).rejects.toBeInstanceOf(
        UnsupportedSourceError,
      );
      await expect(read(s, 'runbook/restart')).rejects.toBeInstanceOf(
        UnsupportedSourceError,
      );
    });
  });
});

describe('acceptance probe', () => {
  it('PASS on a healthy checkout: one tagged PROBE-SKU order, exact decrement, every invariant ok', async () => {
    await withSandbox(async (s) => {
      const ordersBefore = Number(
        (
          await s.pools.verifier.query(
            'SELECT count(*) AS n FROM checkout.orders',
          )
        ).rows[0].n,
      );
      const result = await probeFor(s, 300).execute();
      expect(result.verdict).toBe('pass');
      expect(result.invariants.map((i) => [i.name, i.ok])).toEqual([
        ['order_created', true],
        ['order_readback', true],
        ['inventory_decremented_exactly', true],
        ['inventory_view_consistent', true],
        ['no_negative_inventory', true],
        ['business_data_unchanged', true],
        ['health_window_ok', true],
      ]);
      expect(result.healthWindow).toEqual({
        samples: 7,
        okSamples: 7,
        allOk: true,
      });
      const orders = await s.pools.verifier.query(
        'SELECT probe_run_id, customer FROM checkout.orders WHERE probe_run_id IS NOT NULL',
      );
      expect(orders.rows).toHaveLength(1);
      expect(
        Number(
          (
            await s.pools.verifier.query(
              'SELECT count(*) AS n FROM checkout.orders',
            )
          ).rows[0].n,
        ),
      ).toBe(ordersBefore + 1);
    });
  });

  it('FAIL with order_created and health_window_ok named when writes are disabled', async () => {
    await withSandbox(async (s) => {
      await (
        await s.inject('writes_disabled')
      ).done;
      s.reloadConfig();
      const result = await probeFor(s, 100).execute();
      expect(result.verdict).toBe('fail');
      const failing = result.invariants.filter((i) => !i.ok).map((i) => i.name);
      expect(failing).toContain('order_created');
      expect(failing).toContain('health_window_ok');
      expect(result.detail.orderError).toBe('writes_disabled');
      expect(
        (
          await s.pools.verifier.query(
            'SELECT count(*) AS n FROM checkout.orders WHERE probe_run_id IS NOT NULL',
          )
        ).rows[0].n,
      ).toBe('0');
    });
  });

  it('run(missionId) registers a normalized acceptance value without run id or secret', async () => {
    await withSandbox(async (s) => {
      let captured: unknown;
      const probe = probeFor(s, 0, async (missionId, result) => {
        captured = { missionId, value: acceptanceNormalizedValue(result) };
        return { id: 'receipt' } as never;
      });
      const receipt = await probe.run(
        '22222222-2222-4222-8222-222222222222' as MissionId,
      );
      expect(receipt).toEqual({ id: 'receipt' });
      expect(captured).toMatchObject({
        missionId: '22222222-2222-4222-8222-222222222222',
        value: { verdict: 'pass' },
      });
      const text = JSON.stringify(captured);
      expect(text).not.toContain(s.probeSecret);
      expect(text).not.toMatch(/probe-[0-9a-f-]{36}/);
      await expect(
        probeFor(s).run('22222222-2222-4222-8222-222222222222' as MissionId),
      ).rejects.toThrow(/registrar/);
    });
  });
});

type InventoryValue = {
  sku: string;
  authorityQuantity: number | null;
  apiQuantity: number | null;
  consistent: boolean;
};
const inventoryOf = async (s: Sandbox, sku: string) =>
  (await read(s, `checkout.inventory/${sku}`))
    .normalizedValue as InventoryValue;

describe('readers: F4 is diagnosable from read-only observables on a fresh seed', () => {
  it('after stale_replica, with no order ever placed, at least one SKU reads consistent:false while /health is ok', async () => {
    await withSandbox(async (s) => {
      const skus = await s.pools.verifier.query<{ sku: string }>(
        'SELECT sku FROM checkout.inventory ORDER BY sku',
      );
      for (const { sku } of skus.rows)
        expect((await inventoryOf(s, sku)).consistent).toBe(true);
      await (
        await s.inject('stale_replica')
      ).done;
      s.reloadConfig();
      expect((await s.request('/health')).body.status).toBe('ok');
      const values = await Promise.all(
        skus.rows.map(({ sku }) => inventoryOf(s, sku)),
      );
      const diverging = values.filter((v) => !v.consistent);
      expect(diverging.length).toBeGreaterThanOrEqual(10);
      expect(diverging.map((v) => v.sku)).toContain('SKU-0024');
      // the probe's own reservation line never diverges
      expect(values.find((v) => v.sku === 'PROBE-SKU')?.consistent).toBe(true);
    });
  });
});

describe('readers: inventory is read as a stable pair', () => {
  /** A fetch that commits one order the first time the inventory view is read. */
  const racing = (s: Sandbox, place: () => Promise<unknown>): typeof fetch => {
    let fired = false;
    return async (input, init) => {
      if (!fired && String(input).includes('/inventory/')) {
        fired = true;
        await place();
      }
      return s.fetch(input, init);
    };
  };
  const readerWith = (s: Sandbox, fetchImpl: typeof fetch) =>
    createSourceReaders({
      pg: s.pools.app,
      redis: s.redis.client,
      redisPrefix: s.redis.prefix,
      checkoutUrl: 'http://checkout.invalid',
      fetch: fetchImpl,
      now: s.clock.now,
    });

  it('a probe order committing between the authority read and the API read leaves the normalized value unchanged', async () => {
    await withSandbox(async (s) => {
      const baseline = await inventoryOf(s, 'PROBE-SKU');
      expect(baseline.consistent).toBe(true);
      const reader = readerWith(
        s,
        racing(s, () =>
          s.request('/orders', {
            body: { items: [{ sku: 'PROBE-SKU', quantity: 1 }] },
            headers: s.probeHeader('probe-run-race-0001'),
          }),
        ),
      );
      const raced = await reader.read(
        'checkout.inventory/PROBE-SKU' as SourceKey,
        scope,
      );
      expect(raced.normalizedValue).toEqual(baseline);
    });
  });

  it('a customer order between the two reads is a plain update, never a spurious inconsistency', async () => {
    await withSandbox(async (s) => {
      const before = await inventoryOf(s, 'SKU-0001');
      const reader = readerWith(
        s,
        racing(s, () =>
          s.request('/orders', {
            body: { items: [{ sku: 'SKU-0001', quantity: 2 }] },
          }),
        ),
      );
      const raced = (
        await reader.read('checkout.inventory/SKU-0001' as SourceKey, scope)
      ).normalizedValue as InventoryValue;
      expect(raced.consistent).toBe(true);
      expect(raced.authorityQuantity).toBe(before.authorityQuantity! - 2);
    });
  });

  it('probe orders racing the reader for real never change the normalized value', async () => {
    await withSandbox(async (s) => {
      const baseline = await inventoryOf(s, 'PROBE-SKU');
      for (let i = 0; i < 12; i += 1) {
        const [value] = await Promise.all([
          inventoryOf(s, 'PROBE-SKU'),
          s.request('/orders', {
            body: { items: [{ sku: 'PROBE-SKU', quantity: 1 }] },
            headers: s.probeHeader(
              `probe-run-real-${String(i).padStart(4, '0')}`,
            ),
          }),
        ]);
        expect(value).toEqual(baseline);
      }
    });
  });
});

describe('the acceptance probe does not move the normalized checkout.metrics (D2)', () => {
  const normalizedMetrics = async (s: Sandbox) =>
    (await read(s, 'checkout.metrics')).normalizedValue;
  const counters = async (s: Sandbox) => {
    const body = (await s.request('/metrics')).body;
    return {
      requests: body.requests,
      cache: body.cache,
      byClass: body.errors.byClass,
    };
  };

  it('on an idle checkout, even after the metrics window empties', async () => {
    await withSandbox(async (s) => {
      s.clock.advance(31_000);
      expect((await s.request('/health')).body.status).toBe('ok');
      const before = await normalizedMetrics(s);
      const rawBefore = await counters(s);
      expect((await probeFor(s).execute()).verdict).toBe('pass');
      s.clock.advance(31_000);
      expect((await s.request('/health')).body.status).toBe('ok');
      expect(await normalizedMetrics(s)).toEqual(before);
      expect(await counters(s)).toEqual(rawBefore);
    });
  });

  it('on a busy checkout the request and cache counters are identical before and after a probe run', async () => {
    await withSandbox(async (s) => {
      for (let i = 0; i < 14; i += 1)
        expect((await s.request('/products')).status).toBe(200);
      const before = await normalizedMetrics(s);
      const rawBefore = await counters(s);
      expect(rawBefore.requests.window).toBe(14);
      expect((await probeFor(s).execute()).verdict).toBe('pass');
      expect(await counters(s)).toEqual(rawBefore);
      expect(await normalizedMetrics(s)).toEqual(before);
    });
  });

  it('sparse traffic and an empty window normalize to the same value (below the minimum sample count)', async () => {
    await withSandbox(async (s) => {
      s.clock.advance(31_000);
      const idle = await normalizedMetrics(s);
      expect(await s.request('/products')).toMatchObject({ status: 200 });
      expect(await s.request('/products')).toMatchObject({ status: 200 });
      expect(await normalizedMetrics(s)).toEqual(idle);
    });
  });

  it('probe requests carrying a forged tag are rejected on every business route', async () => {
    await withSandbox(async (s) => {
      for (const path of ['/products', '/inventory/SKU-0001'])
        expect(
          (
            await s.request(path, {
              headers: {
                'x-nemodots-probe': 'probe-run-forged-0001.' + '0'.repeat(64),
              },
            })
          ).status,
        ).toBe(403);
    });
  });
});

describe('acceptance probe runs are serialized', () => {
  it('two overlapping runs on a healthy checkout both pass', async () => {
    await withSandbox(async (s) => {
      const [a, b] = await Promise.all([
        probeFor(s).execute(),
        probeFor(s).execute(),
      ]);
      expect(a.verdict).toBe('pass');
      expect(b.verdict).toBe('pass');
      const orders = await s.pools.verifier.query(
        'SELECT count(*) AS n FROM checkout.orders WHERE probe_run_id IS NOT NULL',
      );
      expect(orders.rows[0].n).toBe('2');
    });
  });

  it('a run waits for the cross-process advisory lock held by another probe', async () => {
    await withSandbox(async (s) => {
      const other = await s.pools.verifier.connect();
      try {
        await other.query('SELECT pg_advisory_lock(hashtext($1))', [
          PROBE_LOCK_KEY,
        ]);
        let finished = false;
        const run = probeFor(s)
          .execute()
          .then((result) => {
            finished = true;
            return result;
          });
        await new Promise((r) => setTimeout(r, 500));
        expect(finished).toBe(false);
        const orders = await s.pools.verifier.query(
          'SELECT count(*) AS n FROM checkout.orders WHERE probe_run_id IS NOT NULL',
        );
        expect(orders.rows[0].n).toBe('0');
        await other.query('SELECT pg_advisory_unlock(hashtext($1))', [
          PROBE_LOCK_KEY,
        ]);
        expect((await run).verdict).toBe('pass');
      } finally {
        other.release();
      }
    });
  });
});
