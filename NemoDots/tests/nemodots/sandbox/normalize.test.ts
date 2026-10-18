// Pure normalization (ARCHITECTURE 9.4), metrics windows, cache keys and the
// probe tag.
import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  parseCacheKey,
} from '../../../src/server/nemodots/sandbox/checkout-cache.js';
import {
  CheckoutMetrics,
  METRICS_WINDOW_MS,
} from '../../../src/server/nemodots/sandbox/checkout-metrics.js';
import {
  parseProbeHeader,
  probeHeaderValue,
} from '../../../src/server/nemodots/sandbox/probe-auth.js';
import {
  MIN_DECILE_SAMPLES,
  decile,
  normalizeHealth,
  normalizeMetrics,
  normalizeRedisKeys,
  orderCountBucket,
} from '../../../src/server/nemodots/sandbox/readers.js';

describe('buckets', () => {
  it('deciles are 0..9 and null without a denominator', () => {
    expect(decile(0, 0)).toBeNull();
    expect(decile(0, 10)).toBe(0);
    expect(decile(1, 10)).toBe(1);
    expect(decile(95, 100)).toBe(9);
    expect(decile(10, 10)).toBe(9);
    expect(decile(5, 10)).toBe(5);
  });

  it('order counts fall in the documented buckets', () => {
    expect([0, 1, 10, 11, 100, 101].map(orderCountBucket)).toEqual([
      '0',
      '1-10',
      '1-10',
      '11-100',
      '11-100',
      '>100',
    ]);
  });
});

describe('normalization drops volatile fields', () => {
  it('health keeps status, booleans and sorted error classes only', () => {
    const a = normalizeHealth({
      status: 'degraded',
      checks: {
        postgres: true,
        redis: true,
        config_parse: true,
        writes: false,
        cache: true,
        pool: true,
      },
      errors: ['writes_disabled', 'writes_disabled'],
      latencyMs: 12,
      generatedAt: 'now',
    });
    const b = normalizeHealth({
      status: 'degraded',
      checks: {
        postgres: true,
        redis: true,
        config_parse: true,
        writes: false,
        cache: true,
        pool: true,
      },
      errors: ['writes_disabled'],
      latencyMs: 900,
    });
    expect(a).toEqual(b);
    expect(a.status).toBe('degraded');
    expect(normalizeHealth(null).status).toBe('down');
    expect(normalizeHealth({ status: 'weird' }).status).toBe('down');
  });

  it('metrics keep the class set, expected/found schema and deciles, not counters', () => {
    const base = {
      windowMs: 30000,
      requests: { total: 1000, window: 20, windowServerErrors: 4 },
      cache: { hits: 700, misses: 300, windowHits: 17, windowMisses: 3 },
      errors: {
        byClass: { cache_decode_error: 4 },
        windowClasses: ['pool_timeout', 'cache_decode_error'],
      },
      cache_decode_error: { expectedSchema: 2, foundSchema: 1 },
    };
    const value = normalizeMetrics(base);
    expect(value).toEqual({
      errorClasses: ['cache_decode_error', 'pool_timeout'],
      cacheDecodeError: { expectedSchema: 2, foundSchema: 1 },
      cacheHitRatioDecile: 8,
      errorRateDecile: 2,
    });
    const other = normalizeMetrics({
      ...base,
      requests: { total: 5, window: 20, windowServerErrors: 4 },
      cache: { hits: 1, misses: 1, windowHits: 17, windowMisses: 3 },
    });
    expect(other).toEqual(value);
    expect(normalizeMetrics({}).cacheDecodeError).toBeNull();
  });

  it('ratio deciles are null below the minimum sample count, so idle and sparse traffic normalize alike', () => {
    expect(decile(1, 9, MIN_DECILE_SAMPLES)).toBeNull();
    expect(decile(0, 0, MIN_DECILE_SAMPLES)).toBeNull();
    expect(decile(9, MIN_DECILE_SAMPLES, MIN_DECILE_SAMPLES)).toBe(9);
    const sparse = (requests: number, hits: number, misses: number) =>
      normalizeMetrics({
        requests: { total: 99, window: requests, windowServerErrors: 0 },
        cache: { hits: 99, misses: 99, windowHits: hits, windowMisses: misses },
        errors: { windowClasses: [] },
        cache_decode_error: null,
      });
    const idle = sparse(0, 0, 0);
    expect(idle).toEqual({
      errorClasses: [],
      cacheDecodeError: null,
      cacheHitRatioDecile: null,
      errorRateDecile: null,
    });
    expect(sparse(3, 2, 1)).toEqual(idle);
    expect(sparse(MIN_DECILE_SAMPLES - 1, 9, 0)).toEqual(idle);
    expect(sparse(MIN_DECILE_SAMPLES, 10, 0)).toMatchObject({
      cacheHitRatioDecile: 9,
      errorRateDecile: 0,
    });
  });

  it('redis keys group by namespace:schema suffix and skip foreign keys', () => {
    const prefix = 'nemodots:ci:a1';
    const keys = [
      cacheKey(prefix, 'catalog-a', 1, 'products'),
      cacheKey(prefix, 'catalog-a', 1, 'canary'),
      cacheKey(prefix, 'catalog-a', 2, 'products'),
      `${prefix}:fence:cache`,
      `other:cache:catalog-a:v1:products`,
      `${prefix}:cache:bad_ns:v1:x`,
    ];
    expect(normalizeRedisKeys(keys, prefix, 'catalog-a')).toEqual({
      reachable: true,
      activeNamespace: 'catalog-a',
      keyCounts: { 'catalog-a:v1': 2, 'catalog-a:v2': 1 },
    });
  });
});

describe('cache keys', () => {
  it('round-trips, including names with colons and prefixes with colons', () => {
    const prefix = 'nemodots:test:abc123';
    const key = cacheKey(prefix, 'ns-1', 3, 'order:42');
    expect(key).toBe('nemodots:test:abc123:cache:ns-1:v3:order:42');
    expect(parseCacheKey(prefix, key)).toEqual({
      namespace: 'ns-1',
      schema: 3,
      name: 'order:42',
    });
    expect(
      parseCacheKey(prefix, 'nemodots:test:abc123:cache:ns-1:x'),
    ).toBeNull();
    expect(parseCacheKey('nemodots:test:zzz', key)).toBeNull();
  });
});

describe('rolling metrics', () => {
  it('error classes and decode details leave the window; cumulative counters stay', () => {
    let t = 1_000_000;
    const m = new CheckoutMetrics(() => t);
    m.recordRequest(500);
    m.recordError('cache_decode_error', { expectedSchema: 2, foundSchema: 1 });
    m.recordCache(false);
    let snap = m.snapshot();
    expect(snap.errors.windowClasses).toEqual(['cache_decode_error']);
    expect(snap.cache_decode_error).toEqual({
      expectedSchema: 2,
      foundSchema: 1,
    });
    t += METRICS_WINDOW_MS + 1;
    snap = m.snapshot();
    expect(snap.errors.windowClasses).toEqual([]);
    expect(snap.cache_decode_error).toBeNull();
    expect(snap.requests).toMatchObject({ total: 1, window: 0 });
    expect(snap.errors.byClass).toEqual({ cache_decode_error: 1 });
    expect(snap.cache).toMatchObject({ misses: 1, windowMisses: 0 });
  });

  it('reports the latest decode error', () => {
    const m = new CheckoutMetrics(() => 5);
    m.recordError('cache_decode_error', { expectedSchema: 2, foundSchema: 1 });
    m.recordError('cache_decode_error', {
      expectedSchema: 3,
      foundSchema: null,
    });
    expect(m.snapshot().cache_decode_error).toEqual({
      expectedSchema: 3,
      foundSchema: null,
    });
  });
});

describe('probe tag', () => {
  const secret = 'unit-test-secret';
  it('accepts only a matching HMAC and well-formed run id', () => {
    const header = probeHeaderValue(secret, 'probe-12345678');
    expect(parseProbeHeader(secret, header)).toEqual({
      kind: 'valid',
      runId: 'probe-12345678',
    });
    expect(parseProbeHeader('other-secret', header)).toEqual({
      kind: 'invalid',
    });
    expect(
      parseProbeHeader(
        secret,
        header.slice(0, -1) + (header.endsWith('0') ? '1' : '0'),
      ),
    ).toEqual({
      kind: 'invalid',
    });
    expect(parseProbeHeader(secret, 'nodot')).toEqual({ kind: 'invalid' });
    expect(parseProbeHeader(secret, `BAD ID.${'a'.repeat(64)}`)).toEqual({
      kind: 'invalid',
    });
    expect(parseProbeHeader(secret, undefined)).toEqual({ kind: 'absent' });
    expect(parseProbeHeader(secret, '')).toEqual({ kind: 'absent' });
    expect(() => probeHeaderValue(secret, 'x')).toThrow(RangeError);
  });
});
