import { describe, expect, it } from 'vitest';
import type { SourceKey } from '../../../src/server/nemodots/contracts/index.js';
import {
  COLLECTION_KEY,
  DEFAULT_OBSERVED_SOURCES,
  controlledRef,
  isReadableObserved,
  memberKeyOf,
  memberSourceKey,
  observedRef,
  observedSourceType,
  parseSourceChanged,
  resolveScope,
} from '../../../src/server/nemodots/watcher/sources.js';
import { WATCHER_MISSION_ID } from '../../../src/server/nemodots/watcher/types.js';
import { SourceRefSchema } from '../../../src/server/nemodots/contracts/index.js';

describe('source naming', () => {
  it('maps member keys both ways and rejects other families', () => {
    expect(memberKeyOf('checkout.config/db.pool_max')).toBe('db.pool_max');
    expect(memberKeyOf('checkout.config')).toBeNull();
    expect(memberKeyOf('checkout.health')).toBeNull();
    expect(memberSourceKey('db.pool_max')).toBe('checkout.config/db.pool_max');
  });

  it('types observed sources: HTTP views are endpoints, datastore views are stores', () => {
    expect(observedSourceType('checkout.health')).toBe('observed_endpoint');
    expect(observedSourceType('checkout.metrics')).toBe('observed_endpoint');
    expect(observedSourceType('checkout.inventory/SKU-0001')).toBe(
      'observed_endpoint',
    );
    expect(observedSourceType('checkout.orders.recent')).toBe('observed_store');
    expect(observedSourceType('redis.stats')).toBe('observed_store');
  });

  it('follows exactly the families the checkout readers serve', () => {
    for (const key of [
      'checkout.health',
      'checkout.metrics',
      'checkout.orders.recent',
      'redis.stats',
      'checkout.inventory/SKU-0001',
    ])
      expect(isReadableObserved(key), key).toBe(true);
    for (const key of [
      'checkout.acceptance',
      'checkout.config',
      'checkout.config/db.pool_max',
      'runbook/cache',
      'opendots.page/abc',
    ])
      expect(isReadableObserved(key), key).toBe(false);
  });

  it('builds source references that satisfy the contract schema', () => {
    const scope = resolveScope({ ownerId: 'owner', environment: 'test' });
    expect(scope.missionId).toBe(WATCHER_MISSION_ID);
    expect(scope.resource).toBe('checkout');
    const refs = [
      controlledRef(scope, COLLECTION_KEY),
      controlledRef(scope, 'checkout.config/ui.banner_text'),
      ...DEFAULT_OBSERVED_SOURCES.map((key) => observedRef(scope, key)),
      observedRef(scope, 'checkout.health', 'observed_store'),
    ];
    for (const ref of refs)
      expect(SourceRefSchema.safeParse(ref).success, ref.key).toBe(true);
    // the type already stored in the ledger wins over the default table
    expect(
      observedRef(scope, 'checkout.health', 'observed_store').sourceType,
    ).toBe('observed_store');
    expect(
      observedRef(scope, 'checkout.health', 'controlled_config').sourceType,
    ).toBe('observed_endpoint');
  });
});

describe('parseSourceChanged', () => {
  it('accepts the payload written by the version authority', () => {
    expect(
      parseSourceChanged(
        JSON.stringify({
          key: 'checkout.config/cache.namespace',
          version: 3,
          membershipChanged: false,
          collectionVersion: null,
        }),
      ),
    ).toEqual({
      key: 'checkout.config/cache.namespace',
      membershipChanged: false,
    });
    expect(
      parseSourceChanged(
        JSON.stringify({
          key: 'checkout.config/new.key',
          version: 1,
          membershipChanged: true,
          collectionVersion: 4,
        }),
      ),
    ).toEqual({ key: 'checkout.config/new.key', membershipChanged: true });
  });

  it('treats anything else as a hint to poll fully', () => {
    for (const payload of [
      '',
      'not json',
      '[]',
      '{}',
      JSON.stringify({ key: 'checkout.health' }),
      JSON.stringify({ key: 7 }),
      JSON.stringify({ key: 'checkout.config/' }),
      JSON.stringify({ key: 'checkout.config/../x' }),
    ])
      expect(parseSourceChanged(payload), payload).toBeNull();
  });

  it('keeps the brand type usable', () => {
    const key = 'checkout.config' as SourceKey;
    expect(key).toBe(COLLECTION_KEY);
  });
});
