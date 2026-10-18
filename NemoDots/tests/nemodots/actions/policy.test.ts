// Network-free tests of the action policy: required sources, value domains,
// the strict proposal schema, key derivation and the citation scope helper.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ProposeInputSchema,
  digest,
  type DependencyVector,
  type ReceiptId,
  type SourceKey,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  ADAPTER_POLICY,
  checkBinding,
  citationsOutsideScope,
  expectedTargetVersionFrom,
  freshnessFor,
  idempotencyKeyOf,
  intentVector,
  missingRequiredSources,
  parsePayload,
  payloadHashOf,
  requiredSourcesFor,
  type StoredBinding,
} from '../../../src/server/nemodots/actions/policy.js';
import { InvalidProposalError } from '../../../src/server/nemodots/actions/errors.js';
import { proposeIntent } from '../../../src/server/nemodots/actions/propose.js';

const id = () => randomUUID() as ReceiptId;
const entry = (
  sourceKey: string,
  sourceRevision: number,
  receiptId = id(),
) => ({
  sourceKey: sourceKey as SourceKey,
  sourceRevision,
  receiptId,
});
const sorted = (entries: ReturnType<typeof entry>[]): DependencyVector =>
  intentVector([], entries);

const valueDigest = digest(3);
const setConfig = (value: unknown = 8, key = 'db.pool_max') => ({
  key,
  value,
  expectedCurrentValueDigest: valueDigest,
});

function binding(
  vector: DependencyVector,
  patch: Partial<StoredBinding> = {},
  payload: unknown = setConfig(),
): StoredBinding {
  const parsed = parsePayload('set_config', payload);
  const expected = parsed
    ? (expectedTargetVersionFrom('set_config', parsed.payload, vector) ?? 0)
    : 0;
  const base = {
    action: 'set_config',
    adapter: 'checkout_config',
    payload,
    payloadHash: '',
    targetSourceKey: 'checkout.config/db.pool_max',
    targetEnvironment: 'test' as const,
    actorCapability: 'propose_config_change',
    dependencyVector: vector,
    requiredSources: ['checkout.config/db.pool_max', 'checkout.health'],
    expectedTargetVersion: expected,
    policyVersion: 'policy-v1',
    ...patch,
  } satisfies StoredBinding;
  if (parsed && !patch.payloadHash)
    base.payloadHash = payloadHashOf({
      action: 'set_config',
      payload: parsed.payload,
      environment: base.targetEnvironment,
      expectedTargetVersion: base.expectedTargetVersion,
      dependencyVector: base.dependencyVector,
    });
  return base;
}

describe('required sources are server-derived', () => {
  it('set_config needs the target member and checkout.health', () => {
    expect(requiredSourcesFor('set_config', setConfig() as never)).toEqual([
      'checkout.config/db.pool_max',
      'checkout.health',
    ]);
  });

  it('flush_cache_namespace needs cache.namespace and redis.stats', () => {
    expect(
      requiredSourcesFor('flush_cache_namespace', {
        namespace: 'catalog-a',
        reason: 'stale blobs',
      }),
    ).toEqual(['checkout.config/cache.namespace', 'redis.stats']);
  });

  it('a missing required source is missing_required_source', () => {
    const vector = sorted([entry('checkout.config/db.pool_max', 2)]);
    expect(checkBinding(binding(vector))?.reason).toBe(
      'missing_required_source',
    );
    expect(
      missingRequiredSources('set_config', setConfig() as never, vector),
    ).toEqual(['checkout.health']);
  });

  it('a valid receipt of an irrelevant source is not accepted', () => {
    const vector = sorted([
      entry('checkout.config/db.statement_timeout_ms', 4),
      entry('checkout.metrics', 9),
      entry('checkout.health', 3),
    ]);
    const verdict = checkBinding(binding(vector));
    expect(verdict?.reason).toBe('missing_required_source');
    expect(verdict?.detail).toContain('checkout.config/db.pool_max');
  });

  it('a complete vector passes the static policy', () => {
    const vector = sorted([
      entry('checkout.config/db.pool_max', 2),
      entry('checkout.health', 3),
    ]);
    expect(checkBinding(binding(vector))).toBeNull();
  });

  it('maxAgeMs is the policy-v1 table, not the proposal', () => {
    expect(freshnessFor('set_config')).toEqual({ 'checkout.health': 120000 });
    expect(freshnessFor('flush_cache_namespace')).toEqual({
      'redis.stats': 120000,
    });
    expect(ADAPTER_POLICY.flush_cache_namespace.externalEffect).toBe(true);
    expect(ADAPTER_POLICY.set_config.externalEffect).toBe(false);
  });
});

describe('value domains', () => {
  const vector = sorted([
    entry('checkout.config/db.pool_max', 2),
    entry('checkout.health', 3),
  ]);
  it.each([
    ['db.pool_max', 0],
    ['db.pool_max', 21],
    ['db.pool_max', 3.5],
    ['db.pool_max', '8'],
    ['cache.schema_version', 10],
    ['routing.inventory_source', 'replica'],
    ['orders.write_enabled', 'true'],
    ['cache.namespace', 'Catalog_A'],
    ['db.statement_timeout_ms', 10],
    ['ui.banner_text', 'x'.repeat(201)],
  ])('%s = %j is payload_invalid', (key, value) => {
    const payload = setConfig(value, key);
    const verdict = checkBinding(
      binding(vector, { targetSourceKey: `checkout.config/${key}` }, payload),
    );
    expect(verdict?.reason).toBe('payload_invalid');
  });

  it('a flush namespace outside the pattern is payload_invalid', () => {
    const flush = sorted([
      entry('checkout.config/cache.namespace', 2),
      entry('redis.stats', 1),
    ]);
    const payload = { namespace: 'bad namespace!', reason: 'x' };
    const hash = payloadHashOf({
      action: 'flush_cache_namespace',
      payload,
      environment: 'test',
      expectedTargetVersion: 2,
      dependencyVector: flush,
    });
    expect(
      checkBinding({
        action: 'flush_cache_namespace',
        adapter: 'redis_cache',
        payload,
        payloadHash: hash,
        targetSourceKey: 'checkout.config/cache.namespace',
        targetEnvironment: 'test',
        actorCapability: 'propose_cache_flush',
        dependencyVector: flush,
        requiredSources: ['checkout.config/cache.namespace', 'redis.stats'],
        expectedTargetVersion: 2,
        policyVersion: 'policy-v1',
      })?.reason,
    ).toBe('payload_invalid');
  });
});

describe('the binding detects tampering after the fact', () => {
  const vector = sorted([
    entry('checkout.config/db.pool_max', 2),
    entry('checkout.health', 3),
  ]);
  it('a changed value, vector, environment or expected version breaks the hash', () => {
    const ok = binding(vector);
    expect(checkBinding(ok)).toBeNull();
    expect(checkBinding({ ...ok, payload: setConfig(9) })?.reason).toBe(
      'payload_invalid',
    );
    expect(checkBinding({ ...ok, targetEnvironment: 'eval' })?.reason).toBe(
      'payload_invalid',
    );
    expect(checkBinding({ ...ok, expectedTargetVersion: 99 })?.reason).toBe(
      'payload_invalid',
    );
    expect(
      checkBinding({
        ...ok,
        dependencyVector: sorted([...vector, entry('checkout.metrics', 1)]),
      })?.reason,
    ).toBe('payload_invalid');
  });
  it('a different policy version or capability is refused', () => {
    const ok = binding(vector);
    expect(checkBinding({ ...ok, policyVersion: 'policy-v0' })?.reason).toBe(
      'policy_version_mismatch',
    );
    expect(
      checkBinding({ ...ok, actorCapability: 'propose_cache_flush' })?.reason,
    ).toBe('capability_denied');
  });
  it('easier required sources than the server derives are refused', () => {
    const ok = binding(vector);
    expect(
      checkBinding({ ...ok, requiredSources: ['checkout.config/db.pool_max'] })
        ?.reason,
    ).toBe('payload_invalid');
  });
});

describe('the proposal schema is strict', () => {
  it('rejects an unknown ActionKind', () => {
    const result = ProposeInputSchema.safeParse({
      action: 'drop_database',
      payload: { namespace: 'x', reason: 'y' },
      supportingReceiptIds: [],
      rationale: 'because',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a forged causedByActionId (and any extra field) in the payload', () => {
    const forged = {
      action: 'set_config',
      payload: { ...setConfig(), causedByActionId: randomUUID() },
      supportingReceiptIds: [],
      rationale: 'because',
    };
    expect(ProposeInputSchema.safeParse(forged).success).toBe(false);
    expect(parsePayload('set_config', forged.payload)).toBeNull();
    expect(
      ProposeInputSchema.safeParse({
        action: 'set_config',
        payload: setConfig(),
        supportingReceiptIds: [],
        rationale: 'because',
        expectedTargetVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('proposeIntent throws InvalidProposalError before touching the database', async () => {
    await expect(
      proposeIntent(
        { pool: {} as never },
        { action: 'rm_rf', payload: {} } as never,
        {
          missionId: randomUUID(),
          taskId: randomUUID(),
          attemptId: randomUUID(),
          fencingToken: 1,
          generation: 0,
          capabilities: ['propose_config_change'],
          role: 'database_specialist',
          modelCallId: randomUUID(),
          toolCallId: 'call_1',
        } as never,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });
});

describe('idempotency key derivation (rev2 C5)', () => {
  const base = {
    missionId: randomUUID() as never,
    taskId: randomUUID() as never,
    attemptId: randomUUID() as never,
    action: 'set_config' as const,
    expectedTargetVersion: 4,
    toolCallId: 'call_abc',
  };
  it('is deterministic and derived from the tool call id', () => {
    expect(idempotencyKeyOf(base)).toBe(idempotencyKeyOf({ ...base }));
    expect(idempotencyKeyOf({ ...base, toolCallId: 'call_other' })).not.toBe(
      idempotencyKeyOf(base),
    );
    expect(idempotencyKeyOf({ ...base, expectedTargetVersion: 5 })).not.toBe(
      idempotencyKeyOf(base),
    );
    expect(
      idempotencyKeyOf({ ...base, action: 'flush_cache_namespace' }),
    ).not.toBe(idempotencyKeyOf(base));
  });
  it('does not contain the payload: the hash is bound beside it', () => {
    const a = payloadHashOf({
      action: 'set_config',
      payload: parsePayload('set_config', setConfig(8))!.payload,
      environment: 'test',
      expectedTargetVersion: 4,
      dependencyVector: [],
    });
    const b = payloadHashOf({
      action: 'set_config',
      payload: parsePayload('set_config', setConfig(9))!.payload,
      environment: 'test',
      expectedTargetVersion: 4,
      dependencyVector: [],
    });
    expect(a).not.toBe(b);
    expect(idempotencyKeyOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('requires a tool call id', () => {
    expect(() => idempotencyKeyOf({ ...base, toolCallId: '' })).toThrow();
  });
});

describe('expected target version', () => {
  it('is the highest revision of the target source in the vector', () => {
    const vector = sorted([
      entry('checkout.config/db.pool_max', 2),
      entry('checkout.config/db.pool_max', 5),
      entry('checkout.config/db.statement_timeout_ms', 9),
    ]);
    expect(
      expectedTargetVersionFrom('set_config', setConfig() as never, vector),
    ).toBe(5);
  });
  it('is null without a target receipt, and cache.namespace for a flush (C11)', () => {
    const vector = sorted([entry('redis.stats', 3)]);
    expect(
      expectedTargetVersionFrom('set_config', setConfig() as never, vector),
    ).toBeNull();
    expect(
      expectedTargetVersionFrom(
        'flush_cache_namespace',
        { namespace: 'a', reason: 'b' },
        sorted([entry('checkout.config/cache.namespace', 7)]),
      ),
    ).toBe(7);
  });
});

describe('citation scope helper (I8)', () => {
  const inSnapshot = id();
  const inReadSet = id();
  const inherited = id();
  const foreign = id();
  const scope = {
    snapshot: {
      dependencyVector: sorted([entry('checkout.health', 1, inSnapshot)]),
    },
    attempt: {
      readSetReceiptIds: [inReadSet],
      inheritedDependencyVector: sorted([
        entry('checkout.metrics', 2, inherited),
      ]),
    },
  };
  it('accepts snapshot, readset and inherited receipts only', () => {
    expect(
      citationsOutsideScope([inSnapshot, inReadSet, inherited], scope),
    ).toEqual([]);
    expect(citationsOutsideScope([inSnapshot, foreign], scope)).toEqual([
      foreign,
    ]);
  });
  it('the intent vector is the snapshot vector plus in-scope citations, sorted', () => {
    const cited = [entry('checkout.config/db.pool_max', 2)];
    const vector = intentVector(scope.snapshot.dependencyVector, cited);
    expect(vector.map((e) => e.sourceKey)).toEqual([
      'checkout.config/db.pool_max',
      'checkout.health',
    ]);
    // Citations add, never remove.
    expect(vector.map((e) => e.receiptId)).toContain(inSnapshot);
  });
});
