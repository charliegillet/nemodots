// Unit tests for the precondition checks with stubbed readers: what counts as a
// visible symptom, how the poll and the deadline behave, and what the warm-up
// verifies.
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VIEW_SETTLE_MS,
  runSetup,
  verifyVisible,
  type PreconditionDeps,
} from '../../../src/server/nemodots/sandbox/preconditions.js';
import type { Preconditions } from '../../../src/server/nemodots/sandbox/manifest.js';

type Values = Record<string, unknown | (() => unknown)>;

function deps(values: Values, extra: Partial<PreconditionDeps> = {}) {
  const clock = { at: 0 };
  const sleeps: number[] = [];
  const reads: string[] = [];
  const built: PreconditionDeps = {
    checkoutUrl: 'http://checkout.invalid',
    read: async (key) => {
      reads.push(key);
      const value = values[key];
      if (value === undefined) throw new Error(`no reader for ${key}`);
      return {
        normalizedValue: typeof value === 'function' ? value() : value,
      };
    },
    fetch: async () => new Response('{}', { status: 200 }),
    now: () => clock.at,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.at += ms;
    },
    pollMs: 250,
    ...extra,
  };
  return { built, sleeps, reads, clock };
}

const healthOk = {
  status: 'ok',
  checks: { writes: true, cache: true, pool: true },
  errors: [],
};
const declare = (
  visible: Preconditions['visible'],
  withinMs = 1_000,
): Preconditions => ({ visible, withinMs });

describe('verifyVisible', () => {
  it('pauses for the configuration cache before the first look', async () => {
    const d = deps({ 'checkout.health': healthOk });
    await verifyVisible(declare(['healthy']), d.built);
    expect(d.sleeps[0]).toBe(CONFIG_VIEW_SETTLE_MS);
    expect(d.sleeps).toHaveLength(1);
  });

  it('healthy needs status ok', async () => {
    const ok = deps({ 'checkout.health': healthOk });
    expect((await verifyVisible(declare(['healthy']), ok.built))[0].seen).toBe(
      true,
    );
    const bad = deps({
      'checkout.health': { ...healthOk, status: 'degraded' },
    });
    expect((await verifyVisible(declare(['healthy']), bad.built))[0].seen).toBe(
      false,
    );
  });

  it('cache_decode_error needs the health error AND the metrics decode record', async () => {
    const both = deps({
      'checkout.health': { ...healthOk, errors: ['cache_decode_error'] },
      'checkout.metrics': {
        errorClasses: ['cache_decode_error'],
        cacheDecodeError: { expectedSchema: 2, foundSchema: 1 },
      },
    });
    expect(
      (await verifyVisible(declare(['cache_decode_error']), both.built))[0]
        .seen,
    ).toBe(true);
    // health alone is not enough: a reader would not see the schemas
    const healthOnly = deps({
      'checkout.health': { ...healthOk, errors: ['cache_decode_error'] },
      'checkout.metrics': { errorClasses: [], cacheDecodeError: null },
    });
    const result = await verifyVisible(
      declare(['cache_decode_error']),
      healthOnly.built,
    );
    expect(result[0].seen).toBe(false);
    expect(result[0].detail).toContain('metrics does not report it');
  });

  it('pool_exhausted and writes_disabled read the health errors and checks', async () => {
    const pool = deps({
      'checkout.health': {
        status: 'degraded',
        checks: { pool: false },
        errors: ['pool_exhausted'],
      },
    });
    expect(
      (await verifyVisible(declare(['pool_exhausted']), pool.built))[0].seen,
    ).toBe(true);
    const writes = deps({
      'checkout.health': {
        status: 'degraded',
        checks: { writes: false },
        errors: ['writes_disabled'],
      },
    });
    expect(
      (await verifyVisible(declare(['writes_disabled']), writes.built))[0].seen,
    ).toBe(true);
    const neither = deps({ 'checkout.health': healthOk });
    const result = await verifyVisible(
      declare(['pool_exhausted', 'writes_disabled']),
      neither.built,
    );
    expect(result.map((r) => r.seen)).toEqual([false, false]);
  });

  it('inventory_inconsistent inspects SKUs in order and stops at the first disagreement', async () => {
    const d = deps({
      'checkout.inventory/SKU-0024': { consistent: true },
      'checkout.inventory/SKU-0001': { consistent: false },
      'checkout.inventory/SKU-0002': { consistent: false },
    });
    const result = await verifyVisible(
      declare(['inventory_inconsistent']),
      d.built,
    );
    expect(result[0]).toMatchObject({ seen: true });
    expect(result[0].detail).toContain('SKU-0001');
    expect(d.reads).toEqual([
      'checkout.inventory/SKU-0024',
      'checkout.inventory/SKU-0001',
    ]);
  });

  it('polls until the symptom appears, then returns', async () => {
    let calls = 0;
    const d = deps({
      'checkout.health': () => ({
        ...healthOk,
        errors: ++calls < 3 ? [] : ['pool_exhausted'],
      }),
    });
    const result = await verifyVisible(
      declare(['pool_exhausted'], 10_000),
      d.built,
    );
    expect(result[0].seen).toBe(true);
    expect(calls).toBe(3);
    // settle, then two poll sleeps
    expect(d.sleeps).toEqual([CONFIG_VIEW_SETTLE_MS, 250, 250]);
  });

  it('gives up at the deadline and reports what the readers showed', async () => {
    const d = deps({ 'checkout.health': healthOk });
    const result = await verifyVisible(
      declare(['pool_exhausted'], 1_000),
      d.built,
    );
    expect(result[0]).toMatchObject({ symptom: 'pool_exhausted', seen: false });
    expect(result[0].detail).toContain('health ok');
    expect(d.clock.at).toBeGreaterThanOrEqual(1_000);
  });

  it('all declared symptoms must be seen in the same sweep', async () => {
    // sweep 1 shows only the pool, every later sweep only the disabled writes
    const d = deps({});
    const health = () =>
      d.sleeps.length <= 1
        ? {
            status: 'degraded',
            checks: { pool: false, writes: true },
            errors: ['pool_exhausted'],
          }
        : {
            status: 'degraded',
            checks: { pool: true, writes: false },
            errors: ['writes_disabled'],
          };
    const sweeping = deps({ 'checkout.health': health });
    sweeping.built.sleep = async (ms) => {
      d.sleeps.push(ms);
      sweeping.clock.at += ms;
    };
    const result = await verifyVisible(
      declare(['pool_exhausted', 'writes_disabled'], 800),
      sweeping.built,
    );
    expect(result.map((r) => r.seen)).toEqual([false, true]);
  });

  it('a failing reader is a missing symptom, not an exception', async () => {
    const d = deps({});
    const result = await verifyVisible(declare(['healthy'], 500), d.built);
    expect(result[0].seen).toBe(false);
    expect(result[0].detail).toContain('reader failed');
  });

  it('stops polling when asked to', async () => {
    const d = deps({ 'checkout.health': healthOk });
    let stop = false;
    d.built.sleep = async () => {
      stop = true;
    };
    const result = await verifyVisible(
      declare(['pool_exhausted'], 60_000),
      d.built,
      () => stop,
    );
    expect(result[0].seen).toBe(false);
  });
});

describe('runSetup warm_cache', () => {
  const warm: Preconditions = {
    setup: [{ kind: 'warm_cache' }],
    visible: ['healthy'],
  };
  const stats = (count: number, reachable = true) => ({
    'redis.stats': {
      reachable,
      activeNamespace: 'catalog-a',
      keyCounts: count ? { 'catalog-a:v1': count } : {},
    },
    'checkout.config/cache.schema_version': { key: 'x', value: 1, version: 1 },
  });

  it('is ok when entries exist under the namespace and the current schema', async () => {
    const d = deps(stats(2));
    const [result] = await runSetup(warm, d.built);
    expect(result).toMatchObject({ kind: 'warm_cache', ok: true });
    expect(result.detail).toContain('2 cache entries under catalog-a:v1');
  });

  it('fails when the cache holds nothing for the current schema', async () => {
    const [result] = await runSetup(warm, deps(stats(0)).built);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('0 cache entries');
  });

  it('fails when redis.stats is unreachable', async () => {
    const [result] = await runSetup(warm, deps(stats(1, false)).built);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unreachable');
  });

  it('fails when the catalogue read does not answer 200', async () => {
    const d = deps(stats(2), {
      fetch: async () => new Response('{}', { status: 500 }),
    });
    expect((await runSetup(warm, d.built))[0].ok).toBe(false);
  });

  it('runs nothing when no setup is declared', async () => {
    const d = deps({});
    expect(await runSetup({ visible: ['healthy'] }, d.built)).toEqual([]);
    expect(d.reads).toEqual([]);
  });
});
