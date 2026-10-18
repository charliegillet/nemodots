import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';
import { D } from './fixtures.js';

describe('ROLE_CAPABILITIES (D5)', () => {
  it('matches CONTRACTS section 4 exactly', () => {
    const expected: Record<string, string[]> = {
      planner: [],
      investigator: [
        'observe',
        'delegate',
        'publish_finding',
        'request_replan',
      ],
      cache_specialist: [
        'observe',
        'delegate',
        'publish_finding',
        'propose_config_change',
        'propose_cache_flush',
      ],
      database_specialist: [
        'observe',
        'delegate',
        'publish_finding',
        'propose_config_change',
      ],
      routing_specialist: [
        'observe',
        'delegate',
        'publish_finding',
        'propose_config_change',
      ],
      verifier: ['observe', 'publish_finding'],
      postcondition: ['observe', 'publish_finding'],
    };
    const actual = Object.fromEntries(
      Object.entries(C.ROLE_CAPABILITIES).map(([role, caps]) => [
        role,
        [...caps].sort(),
      ]),
    );
    expect(actual).toEqual(
      Object.fromEntries(
        Object.entries(expected).map(([r, c]) => [r, [...c].sort()]),
      ),
    );
    expect(Object.keys(C.ROLE_CAPABILITIES).sort()).toEqual(
      [...C.TaskRoleSchema.options].sort(),
    );
  });

  it('investigator cannot propose anything; verifier cannot delegate', () => {
    const investigator = C.ROLE_CAPABILITIES.investigator as readonly string[];
    expect(investigator.some((c) => c.startsWith('propose_'))).toBe(false);
    expect(C.ROLE_CAPABILITIES.verifier as readonly string[]).not.toContain(
      'delegate',
    );
    expect(
      C.ROLE_CAPABILITIES.postcondition as readonly string[],
    ).not.toContain('delegate');
  });

  it('only the cache specialist may propose a cache flush', () => {
    const flushers = Object.entries(C.ROLE_CAPABILITIES)
      .filter(([, caps]) =>
        (caps as readonly string[]).includes('propose_cache_flush'),
      )
      .map(([role]) => role);
    expect(flushers).toEqual(['cache_specialist']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(C.ROLE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(C.ROLE_CAPABILITIES.investigator)).toBe(true);
  });

  it.each([
    [
      'investigator',
      [
        'investigator',
        'cache_specialist',
        'database_specialist',
        'routing_specialist',
        'verifier',
      ],
    ],
    ['cache_specialist', ['verifier']],
    ['database_specialist', ['verifier']],
    ['routing_specialist', ['verifier']],
    ['verifier', []],
    ['postcondition', []],
    ['planner', []],
  ] as const)('%s may delegate to %j', (role, roles) => {
    expect([...C.delegableRoles(role)].sort()).toEqual([...roles].sort());
  });

  it('child capabilities are the role defaults intersected with the parent', () => {
    // rev3 D5: a specialist delegated by a parent holding `delegate` keeps its
    // role's propose_* capabilities; everything else stays within the parent.
    expect(
      C.allowedCapabilities('cache_specialist', [
        'observe',
        'delegate',
        'publish_finding',
      ]),
    ).toEqual([
      'observe',
      'delegate',
      'publish_finding',
      'propose_config_change',
      'propose_cache_flush',
    ]);
    expect(
      C.allowedCapabilities('database_specialist', ['observe', 'delegate']),
    ).toEqual(['observe', 'delegate', 'propose_config_change']);
    // No `delegate` on the parent: no grant.
    expect(
      C.allowedCapabilities('routing_specialist', [
        'observe',
        'publish_finding',
      ]),
    ).toEqual(['observe', 'publish_finding']);
    // The grant applies to specialists only.
    expect(
      C.allowedCapabilities('investigator', ['observe', 'delegate']),
    ).toEqual(['observe', 'delegate']);
    expect(C.allowedCapabilities('verifier', ['observe', 'delegate'])).toEqual([
      'observe',
    ]);
    expect(C.allowedCapabilities('verifier', null)).toEqual([
      'observe',
      'publish_finding',
    ]);
    expect(
      C.capabilitiesWithinRole('investigator', ['propose_config_change']),
    ).toBe(false);
  });
});

describe('ADAPTER_POLICY policy-v1', () => {
  it('set_config requires the member key and health with a 120 s health window', () => {
    const p = C.ADAPTER_POLICY.set_config;
    expect(C.ADAPTER_POLICY.version).toBe('policy-v1');
    expect(
      p.requiredSources({
        key: 'db.pool_max',
        value: 10,
        expectedCurrentValueDigest: D,
      }),
    ).toEqual(['checkout.config/db.pool_max', 'checkout.health']);
    expect(p.maxAgeMs).toEqual({ 'checkout.health': 120000 });
    expect(p.capability).toBe('propose_config_change');
    expect(p.adapter).toBe('checkout_config');
    expect(p.externalEffect).toBe(false);
  });

  it('flush_cache_namespace requires cache.namespace and redis.stats with a 120 s stats window', () => {
    const p = C.ADAPTER_POLICY.flush_cache_namespace;
    expect(
      p.requiredSources({ namespace: 'orders-a', reason: 'stale' }),
    ).toEqual(['checkout.config/cache.namespace', 'redis.stats']);
    expect(p.maxAgeMs).toEqual({ 'redis.stats': 120000 });
    expect(p.capability).toBe('propose_cache_flush');
    expect(p.adapter).toBe('redis_cache');
    expect(p.externalEffect).toBe(true);
  });

  it('required sources are valid source keys and come back sorted', () => {
    const sources = C.requiredSourcesFor('set_config', {
      key: 'ui.banner_text',
      value: 'hi',
      expectedCurrentValueDigest: D,
    });
    expect(sources).toEqual([...sources].sort());
    for (const key of sources)
      expect(C.SourceKeySchema.safeParse(key).success).toBe(true);
  });

  it('the policy is frozen', () => {
    expect(Object.isFrozen(C.ADAPTER_POLICY)).toBe(true);
    expect(Object.isFrozen(C.ADAPTER_POLICY.set_config.maxAgeMs)).toBe(true);
  });

  it('every action maps to its adapter', () => {
    expect(C.ACTION_ADAPTER).toEqual({
      set_config: 'checkout_config',
      flush_cache_namespace: 'redis_cache',
    });
  });

  it('intent expiry is 10 minutes', () => {
    expect(C.INTENT_TTL_MS).toBe(600000);
  });
});

describe('value domains (ARCHITECTURE 9.2)', () => {
  it.each([
    ['cache.namespace', 'orders-v2', true],
    ['cache.namespace', 'Orders', false],
    ['cache.namespace', 'a'.repeat(33), false],
    ['cache.namespace', '', false],
    ['cache.schema_version', 1, true],
    ['cache.schema_version', 9, true],
    ['cache.schema_version', 0, false],
    ['cache.schema_version', 10, false],
    ['cache.schema_version', 2.5, false],
    ['cache.schema_version', '3', false],
    ['db.pool_max', 1, true],
    ['db.pool_max', 20, true],
    ['db.pool_max', 21, false],
    ['db.statement_timeout_ms', 50, true],
    ['db.statement_timeout_ms', 30000, true],
    ['db.statement_timeout_ms', 49, false],
    ['db.statement_timeout_ms', 30001, false],
    ['routing.inventory_source', 'primary', true],
    ['routing.inventory_source', 'replica_stale', true],
    ['routing.inventory_source', 'replica', false],
    ['orders.write_enabled', true, true],
    ['orders.write_enabled', 'true', false],
    ['ui.banner_text', 'x'.repeat(200), true],
    ['ui.banner_text', 'x'.repeat(201), false],
    ['ui.banner_text', 5, false],
  ] as const)('%s = %j -> %s', (key, value, ok) => {
    expect(C.configValueInDomain(key, value)).toBe(ok);
    expect(
      C.ADAPTER_POLICY.set_config.validatePayload({
        key,
        value,
        expectedCurrentValueDigest: D,
      }),
    ).toBe(ok);
  });

  it('flush namespace uses the cache.namespace domain', () => {
    const v = C.ADAPTER_POLICY.flush_cache_namespace.validatePayload;
    expect(v({ namespace: 'orders-a', reason: 'r' })).toBe(true);
    expect(v({ namespace: 'orders:*', reason: 'r' })).toBe(false);
  });
});
