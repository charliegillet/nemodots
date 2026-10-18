import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  REQUIRED_CONFIG_KEYS,
  isConfigKey,
  parseCheckoutSettings,
  validateConfigValue,
} from '../../../src/server/nemodots/sandbox/config-schema.js';
import { HEALTHY_BASELINE } from '../../../src/server/nemodots/sandbox/seed.js';

describe('config domains', () => {
  it.each([
    ['cache.namespace', 'catalog-a', true],
    ['cache.namespace', 'Bad_Name', false],
    ['cache.namespace', '', false],
    ['cache.namespace', 'a'.repeat(33), false],
    ['cache.schema_version', 1, true],
    ['cache.schema_version', 9, true],
    ['cache.schema_version', 0, false],
    ['cache.schema_version', 10, false],
    ['cache.schema_version', 1.5, false],
    ['cache.schema_version', '1', false],
    ['db.pool_max', 20, true],
    ['db.pool_max', 21, false],
    ['db.statement_timeout_ms', 50, true],
    ['db.statement_timeout_ms', 49, false],
    ['db.statement_timeout_ms', 30000, true],
    ['db.statement_timeout_ms', 30001, false],
    ['routing.inventory_source', 'primary', true],
    ['routing.inventory_source', 'replica_stale', true],
    ['routing.inventory_source', 'replica', false],
    ['orders.write_enabled', false, true],
    ['orders.write_enabled', 'false', false],
    ['ui.banner_text', 'x'.repeat(200), true],
    ['ui.banner_text', 'x'.repeat(201), false],
    ['ui.banner_text', 5, false],
  ])('%s = %j -> %s', (key, value, ok) => {
    expect(validateConfigValue(key, value).ok).toBe(ok);
  });

  it('rejects unknown keys', () => {
    expect(isConfigKey('cache.namespace')).toBe(true);
    expect(isConfigKey('made.up')).toBe(false);
    expect(validateConfigValue('made.up', 1)).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('the seed baseline is valid for every key the checkout knows', () => {
    expect(Object.keys(HEALTHY_BASELINE).sort()).toEqual(
      [...CONFIG_KEYS].sort(),
    );
    for (const [key, value] of Object.entries(HEALTHY_BASELINE))
      expect(validateConfigValue(key, value).ok).toBe(true);
  });
});

describe('parseCheckoutSettings', () => {
  const rows = () => new Map<string, unknown>(Object.entries(HEALTHY_BASELINE));

  it('parses the baseline', () => {
    const parsed = parseCheckoutSettings(rows());
    expect(parsed).toEqual({
      ok: true,
      settings: {
        cacheNamespace: 'catalog-a',
        cacheSchemaVersion: 1,
        dbPoolMax: 10,
        dbStatementTimeoutMs: 5000,
        inventorySource: 'primary',
        ordersWriteEnabled: true,
        bannerText: 'Free shipping on orders over $50',
      },
    });
  });

  it('names missing and invalid keys, never their values', () => {
    const map = rows();
    map.delete('db.pool_max');
    map.set('cache.schema_version', 99);
    map.set('ui.banner_text', 'y'.repeat(300));
    const parsed = parseCheckoutSettings(map);
    expect(parsed).toEqual({
      ok: false,
      invalidKeys: ['cache.schema_version', 'db.pool_max', 'ui.banner_text'],
    });
    expect(JSON.stringify(parsed)).not.toContain('yyy');
  });

  it('the banner is optional', () => {
    const map = rows();
    map.delete('ui.banner_text');
    expect(REQUIRED_CONFIG_KEYS).not.toContain('ui.banner_text');
    const parsed = parseCheckoutSettings(map);
    expect(parsed.ok && parsed.settings.bannerText).toBeNull();
  });
});
