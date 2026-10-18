// Pure rules of the action boundary (no database).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  citationInScope,
  expectedTargetVersionOf,
  idempotencyKeyOf,
  intentVector,
  memberKeysOf,
  missingRequiredSources,
  payloadHashOf,
  payloadInDomain,
} from '../../../src/server/nemodots/actions/policy.js';
import {
  clearHooks,
  hook,
  setHook,
} from '../../../src/server/nemodots/actions/test-hooks.js';
import {
  digest,
  ProposeInputSchema,
  type DependencyEntry,
} from '../../../src/server/nemodots/contracts/index.js';

const entry = (
  sourceKey: string,
  sourceRevision = 1,
  receiptId: string = randomUUID(),
): DependencyEntry => ({ sourceKey, sourceRevision, receiptId }) as never;

const setConfig = (key: string, value: unknown) => ({
  key,
  value,
  expectedCurrentValueDigest: digest(1),
});

describe('required sources', () => {
  it('a vector without the target member source is missing it', () => {
    const payload = setConfig('db.pool_max', 6) as never;
    expect(
      missingRequiredSources('set_config', payload, [entry('checkout.health')]),
    ).toEqual(['checkout.config/db.pool_max']);
  });

  it('an irrelevant valid receipt does not satisfy a required source', () => {
    const payload = setConfig('db.pool_max', 6) as never;
    expect(
      missingRequiredSources('set_config', payload, [
        entry('checkout.config/cache.ttl'),
        entry('checkout.metrics'),
      ]),
    ).toEqual(['checkout.config/db.pool_max', 'checkout.health']);
  });

  it('a flush requires the namespace member and redis.stats', () => {
    const payload = { namespace: 'blue', reason: 'stale schema' } as never;
    expect(
      missingRequiredSources('flush_cache_namespace', payload, [
        entry('checkout.config/cache.namespace'),
      ]),
    ).toEqual(['redis.stats']);
    expect(
      missingRequiredSources('flush_cache_namespace', payload, [
        entry('checkout.config/cache.namespace'),
        entry('redis.stats'),
      ]),
    ).toEqual([]);
  });
});

describe('payload domain and strictness', () => {
  it.each([
    ['db.pool_max', 0, false],
    ['db.pool_max', 21, false],
    ['db.pool_max', 6, true],
    ['db.pool_max', 6.5, false],
    ['cache.schema_version', 10, false],
    ['routing.inventory_source', 'elsewhere', false],
    ['routing.inventory_source', 'primary', true],
    ['orders.write_enabled', 'yes', false],
    ['orders.write_enabled', true, true],
    ['cache.namespace', 'Has Spaces', false],
    ['cache.namespace', 'green-2', true],
    ['db.statement_timeout_ms', 10, false],
  ])('%s = %j in domain: %s', (key, value, ok) => {
    expect(payloadInDomain('set_config', setConfig(key, value) as never)).toBe(
      ok,
    );
  });

  it('a flush namespace must match the pattern', () => {
    expect(
      payloadInDomain('flush_cache_namespace', {
        namespace: 'a/b',
        reason: 'x',
      } as never),
    ).toBe(false);
  });

  it('an unknown ActionKind is rejected by the schema', () => {
    const parsed = ProposeInputSchema.safeParse({
      action: 'restart_service',
      payload: { service: 'checkout' },
      supportingReceiptIds: [],
      rationale: 'why',
    });
    expect(parsed.success).toBe(false);
  });

  it('a forged causedByActionId in the payload is rejected by the strict schema', () => {
    const parsed = ProposeInputSchema.safeParse({
      action: 'set_config',
      payload: {
        ...setConfig('db.pool_max', 6),
        causedByActionId: randomUUID(),
      },
      supportingReceiptIds: [],
      rationale: 'why',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('idempotency key and payload hash (C5)', () => {
  const base = {
    missionId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    action: 'set_config' as const,
    expectedTargetVersion: 3,
    toolCallId: 'call_1',
  };

  it('is derived from the tool call id: same call same key, new call new key', () => {
    expect(idempotencyKeyOf(base)).toBe(idempotencyKeyOf({ ...base }));
    expect(idempotencyKeyOf(base)).not.toBe(
      idempotencyKeyOf({ ...base, toolCallId: 'call_2' }),
    );
    expect(idempotencyKeyOf(base)).not.toBe(
      idempotencyKeyOf({ ...base, expectedTargetVersion: 4 }),
    );
    expect(idempotencyKeyOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the payload; the payload hash does', () => {
    const a = setConfig('db.pool_max', 6) as never;
    const b = setConfig('db.pool_max', 7) as never;
    expect(payloadHashOf('set_config', a, [])).not.toBe(
      payloadHashOf('set_config', b, []),
    );
    expect(payloadHashOf('set_config', a, [])).toBe(
      payloadHashOf('set_config', a, []),
    );
  });

  it('the hash covers the citations, order-insensitively', () => {
    const payload = setConfig('db.pool_max', 6) as never;
    const x = randomUUID();
    const y = randomUUID();
    expect(payloadHashOf('set_config', payload, [x, y])).toBe(
      payloadHashOf('set_config', payload, [y, x]),
    );
    expect(payloadHashOf('set_config', payload, [x])).not.toBe(
      payloadHashOf('set_config', payload, [x, y]),
    );
  });
});

describe('citation scope (I8) and the intent vector (C10)', () => {
  it('accepts snapshot, read set and inherited receipts, rejects anything else', () => {
    const inSnapshot = entry('checkout.health');
    const inherited = entry('redis.stats');
    const readSet = randomUUID();
    const foreign = randomUUID();
    const result = citationInScope(
      [inSnapshot.receiptId, inherited.receiptId, readSet, foreign],
      {
        snapshotVector: [inSnapshot],
        readSetReceiptIds: [readSet],
        inheritedVector: [inherited],
      },
    );
    expect(result.inScope.sort()).toEqual(
      [inSnapshot.receiptId, inherited.receiptId, readSet].sort(),
    );
    expect(result.outOfScope).toEqual([foreign]);
  });

  it('the vector is the snapshot vector united with the cited entries, sorted and de-duplicated', () => {
    const health = entry('checkout.health');
    const member = entry('checkout.config/db.pool_max');
    const vector = intentVector([health], [member, health]);
    expect(vector.map((e) => e.sourceKey)).toEqual([
      'checkout.config/db.pool_max',
      'checkout.health',
    ]);
  });

  it('expectedTargetVersion comes from the target receipt; 0 when absent', () => {
    const payload = setConfig('db.pool_max', 6) as never;
    expect(
      expectedTargetVersionOf('set_config', payload, [
        entry('checkout.config/db.pool_max', 4),
        entry('checkout.health', 9),
      ]),
    ).toBe(4);
    expect(
      expectedTargetVersionOf('set_config', payload, [
        entry('checkout.health'),
      ]),
    ).toBe(0);
    expect(
      expectedTargetVersionOf(
        'flush_cache_namespace',
        { namespace: 'blue', reason: 'r' } as never,
        [entry('checkout.config/cache.namespace', 7)],
      ),
    ).toBe(7);
  });

  it('lock keys: collection flag and sorted member keys including the target', () => {
    expect(
      memberKeysOf(
        [
          entry('checkout.config'),
          entry('checkout.config/b.k'),
          entry('checkout.health'),
        ],
        'checkout.config/a.k',
      ),
    ).toEqual({ keys: ['a.k', 'b.k'], collection: true });
  });
});

describe('test hooks', () => {
  it('cannot be registered unless NEMODOTS_TEST_HOOKS=1, and are no-ops then', async () => {
    const saved = process.env.NEMODOTS_TEST_HOOKS;
    try {
      delete process.env.NEMODOTS_TEST_HOOKS;
      expect(() => setHook('before_lock', () => {})).toThrow();
      await hook('before_lock', { actionId: 'x' });
      process.env.NEMODOTS_TEST_HOOKS = '1';
      let seen = 0;
      const off = setHook('before_lock', () => {
        seen += 1;
      });
      await hook('before_lock', { actionId: 'x' });
      off();
      await hook('before_lock', { actionId: 'x' });
      expect(seen).toBe(1);
    } finally {
      clearHooks();
      if (saved === undefined) delete process.env.NEMODOTS_TEST_HOOKS;
      else process.env.NEMODOTS_TEST_HOOKS = saved;
    }
  });
});
