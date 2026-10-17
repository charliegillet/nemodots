import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as C from '../../../src/server/nemodots/contracts/index.js';
import * as F from './fixtures.js';

type Case = [name: string, schema: z.ZodType, sample: () => unknown];

const cases: Case[] = [
  ['Scope', C.ScopeSchema, F.scope],
  ['ObservationReceipt', C.ObservationReceiptSchema, F.receipt],
  [
    'ObservationReceipt (collection)',
    C.ObservationReceiptSchema,
    F.collectionReceipt,
  ],
  ['ReceiptConfirmation', C.ReceiptConfirmationSchema, F.confirmation],
  ['ReceiptTransition', C.ReceiptTransitionSchema, F.receiptTransition],
  ['ContextSnapshot', C.ContextSnapshotSchema, F.contextSnapshot],
  ['InferenceAttempt', C.InferenceAttemptSchema, F.inferenceAttempt],
  ['ModelCallRecord', C.ModelCallRecordSchema, F.modelCall],
  ['Mission', C.MissionSchema, F.mission],
  ['Task', C.TaskSchema, F.task],
  ['TaskAttempt', C.TaskAttemptSchema, F.attempt],
  ['Lease', C.LeaseSchema, F.lease],
  ['TaskOutput', C.TaskOutputSchema, F.taskOutput],
  ['DependencyEdge', C.DependencyEdgeSchema, F.edge],
  ['Plan', C.PlanSchema, F.plan],
  ['ActionIntent', C.ActionIntentSchema, F.intent],
  ['Authorization', C.AuthorizationSchema, F.authorization],
  ['ResultReceipt', C.ResultReceiptSchema, F.resultReceipt],
  ['Finding', C.FindingSchema, F.finding],
  ['InvalidationEvent', C.InvalidationEventSchema, F.invalidation],
  ['RecoveryEvent', C.RecoveryEventSchema, F.recovery],
  ['TelemetrySummary', C.TelemetrySummarySchema, F.telemetry],
  ['HealthStatus', C.HealthStatusSchema, F.health],
  ['MissionSnapshot', C.MissionSnapshotSchema, F.snapshotDto],
];

// Fields typed `unknown` by the contract (bounded, digested values).
const OPAQUE = new Set(['normalizedValue', 'content', 'summary']);

/** Every path to a plain object inside the sample, excluding opaque fields. */
function objectPaths(
  value: unknown,
  path: (string | number)[] = [],
): (string | number)[][] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => objectPaths(item, [...path, i]));
  if (value === null || typeof value !== 'object') return [];
  const out = [path];
  for (const [key, item] of Object.entries(value))
    if (!OPAQUE.has(key)) out.push(...objectPaths(item, [...path, key]));
  return out;
}

function withExtraKey(sample: unknown, path: (string | number)[], key: string) {
  const copy = structuredClone(sample) as Record<string | number, unknown>;
  let target: Record<string | number, unknown> = copy;
  for (const step of path)
    target = target[step] as Record<string | number, unknown>;
  target[key] = 'x';
  return copy;
}

describe('contract schemas', () => {
  it.each(cases)('%s accepts its valid sample', (_name, schema, sample) => {
    const result = schema.safeParse(sample());
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it.each(cases)(
    '%s rejects an unknown key at every object level',
    (_name, schema, sample) => {
      const paths = objectPaths(sample());
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        const result = schema.safeParse(
          withExtraKey(sample(), path, 'control'),
        );
        expect(
          result.success,
          `extra key accepted at ${path.join('.') || '<root>'}`,
        ).toBe(false);
      }
    },
  );

  it('CONTRACT_VERSION is v1', () => {
    expect(C.CONTRACT_VERSION).toBe('v1');
  });
});

describe('invariants', () => {
  it('ids must be UUIDv4 and are not interchangeable with arbitrary strings', () => {
    expect(C.MissionIdSchema.safeParse(F.ids.mission).success).toBe(true);
    expect(C.MissionIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(
      C.MissionIdSchema.safeParse('6f1c1f9e-3c39-1a0c-9d37-6a3f0d0a1001')
        .success,
    ).toBe(false);
  });

  it('timestamps are ISO-8601 UTC', () => {
    expect(C.IsoTimeSchema.safeParse('2026-10-17T18:00:00.000Z').success).toBe(
      true,
    );
    expect(C.IsoTimeSchema.safeParse('2026-10-17T18:00:00+02:00').success).toBe(
      false,
    );
  });

  it('cachedTokens null means unavailable and is distinct from 0', () => {
    const unavailable = C.UsageSchema.parse(F.usage());
    expect(unavailable.cachedTokens).toBeNull();
    expect(
      C.UsageSchema.parse({ ...F.usage(), cachedTokens: 0 }).cachedTokens,
    ).toBe(0);
    expect(
      C.UsageSchema.safeParse({ ...F.usage(), cachedTokens: undefined })
        .success,
    ).toBe(false);
  });

  it('a cancelled inference attempt records usage as null', () => {
    const cancelled = { ...F.inferenceAttempt(), finishReason: 'cancelled' };
    expect(C.InferenceAttemptSchema.safeParse(cancelled).success).toBe(false);
    const nulls = {
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    };
    expect(
      C.InferenceAttemptSchema.safeParse({ ...cancelled, usage: nulls })
        .success,
    ).toBe(true);
    expect(
      C.InferenceAttemptSchema.safeParse({
        ...F.inferenceAttempt(),
        outcome: 'orphaned_fence',
      }).success,
    ).toBe(true);
  });

  it('dependency vectors must be sorted by sourceKey and unique', () => {
    const [a, b] = F.vector();
    expect(C.DependencyVectorSchema.safeParse([a, b]).success).toBe(true);
    expect(C.DependencyVectorSchema.safeParse([b, a]).success).toBe(false);
    expect(C.DependencyVectorSchema.safeParse([a, a]).success).toBe(false);
  });

  it('unionDependencyVectors is a sorted conservative union', () => {
    const [a, b] = C.DependencyVectorSchema.parse(F.vector());
    const union = C.unionDependencyVectors([b], [a, b], []);
    expect(union).toEqual([a, b]);
    expect(C.DependencyVectorSchema.safeParse(union).success).toBe(true);
    expect(() =>
      C.unionDependencyVectors(
        [a],
        [{ ...a, sourceRevision: a.sourceRevision + 1 }],
      ),
    ).toThrow(RangeError);
  });

  it('ContextSnapshot vector must cover every injected receipt', () => {
    const snapshot = F.contextSnapshot();
    snapshot.dependencyVector = snapshot.dependencyVector.slice(0, 1);
    expect(C.ContextSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('Finding.trust is always model_claim; receipts never carry model_claim', () => {
    expect(
      C.FindingSchema.safeParse({ ...F.finding(), trust: 'probe' }).success,
    ).toBe(false);
    expect(
      C.ObservationReceiptSchema.safeParse({
        ...F.receipt(),
        trust: 'model_claim',
      }).success,
    ).toBe(false);
  });

  it('collection normalizedValue is { keys: sorted string[], collectionVersion }', () => {
    const unsorted = F.collectionReceipt();
    unsorted.normalizedValue = {
      keys: ['db.pool_max', 'cache.namespace'],
      collectionVersion: 1,
    };
    expect(C.ObservationReceiptSchema.safeParse(unsorted).success).toBe(false);
    const withValues = F.collectionReceipt();
    withValues.normalizedValue = {
      keys: ['cache.namespace'],
      collectionVersion: 1,
      values: {},
    } as never;
    expect(C.ObservationReceiptSchema.safeParse(withValues).success).toBe(
      false,
    );
  });

  it('normalizedValue is bounded to 16 KiB canonical', () => {
    const big = F.receipt();
    big.normalizedValue = { blob: 'x'.repeat(16 * 1024) } as never;
    expect(C.ObservationReceiptSchema.safeParse(big).success).toBe(false);
  });

  it('lastConfirmedAt cannot precede observedAt', () => {
    expect(
      C.ObservationReceiptSchema.safeParse({
        ...F.receipt(),
        lastConfirmedAt: '2026-10-17T17:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('source types are consistent with authority and key family', () => {
    const r = F.receipt();
    expect(
      C.SourceRefSchema.safeParse({ ...r.source, authority: 'observed' })
        .success,
    ).toBe(false);
    expect(
      C.SourceRefSchema.safeParse({ ...r.source, key: 'checkout.health' })
        .success,
    ).toBe(false);
  });

  it('Task capabilities stay within ROLE_CAPABILITIES[role]; delegated tasks need a justification', () => {
    expect(
      C.TaskSchema.safeParse({
        ...F.task(),
        capabilities: ['observe', 'propose_config_change'],
      }).success,
    ).toBe(false);
    const child = { ...F.task(), parentId: F.ids.task2, depth: 1 };
    expect(C.TaskSchema.safeParse(child).success).toBe(false);
    expect(
      C.TaskSchema.safeParse({ ...child, justification: 'needs a specialist' })
        .success,
    ).toBe(true);
  });

  it('Mission.admission.minAgeMs is 0..60000', () => {
    for (const minAgeMs of [-1, 60001, 1.5])
      expect(
        C.MissionSchema.safeParse({ ...F.mission(), admission: { minAgeMs } })
          .success,
      ).toBe(false);
    for (const minAgeMs of [0, 60000])
      expect(
        C.MissionSchema.safeParse({ ...F.mission(), admission: { minAgeMs } })
          .success,
      ).toBe(true);
  });

  it('PlanSchema accepts 2..6 tasks only', () => {
    const one = { tasks: F.plan().tasks.slice(0, 1) };
    const seven = { tasks: Array.from({ length: 7 }, () => F.plan().tasks[0]) };
    expect(C.PlanSchema.safeParse(one).success).toBe(false);
    expect(C.PlanSchema.safeParse(seven).success).toBe(false);
  });

  it('ActionIntent binds action, adapter, payload and target', () => {
    expect(
      C.ActionIntentSchema.safeParse({ ...F.intent(), adapter: 'redis_cache' })
        .success,
    ).toBe(false);
    expect(
      C.ActionIntentSchema.safeParse({
        ...F.intent(),
        target: {
          ...F.intent().target,
          sourceKey: 'checkout.config/db.pool_max',
        },
      }).success,
    ).toBe(false);
    expect(
      C.ActionIntentSchema.safeParse({
        ...F.intent(),
        payload: { namespace: 'x', reason: 'y' },
      }).success,
    ).toBe(false);
    expect(
      C.ActionIntentSchema.safeParse({ ...F.intent(), status: 'blocked' })
        .success,
    ).toBe(false);
    expect(
      C.ActionIntentSchema.safeParse({
        ...F.intent(),
        status: 'blocked',
        blockReason: 'evidence_too_old',
      }).success,
    ).toBe(true);
    expect(
      C.ActionIntentSchema.safeParse({ ...F.intent(), status: 'admitted' })
        .success,
    ).toBe(false);
  });

  it('Authorization stage and decision agree', () => {
    expect(
      C.AuthorizationSchema.safeParse({
        ...F.authorization(),
        decision: 'committed',
      }).success,
    ).toBe(false);
    expect(
      C.AuthorizationSchema.safeParse({
        ...F.authorization(),
        decision: 'blocked',
        blockReason: 'citation_out_of_scope',
      }).success,
    ).toBe(true);
    expect(
      C.AuthorizationSchema.safeParse({
        ...F.authorization(),
        decision: 'blocked',
      }).success,
    ).toBe(false);
  });

  it('ProposeInput is discriminated by action', () => {
    const ok = {
      action: 'flush_cache_namespace',
      payload: { namespace: 'orders-a', reason: 'stale blobs' },
      supportingReceiptIds: [F.ids.receipt],
      rationale: 'flush',
    };
    expect(C.ProposeInputSchema.safeParse(ok).success).toBe(true);
    expect(
      C.ProposeInputSchema.safeParse({ ...ok, action: 'set_config' }).success,
    ).toBe(false);
    expect(
      C.ProposeInputSchema.safeParse({ ...ok, missionId: F.ids.mission })
        .success,
    ).toBe(false);
  });

  it('MissionEvent kind must equal payload.kind', () => {
    const event = {
      id: 1,
      missionId: F.ids.mission,
      kind: 'heartbeat',
      at: F.T0,
      payload: { kind: 'heartbeat' },
    };
    expect(C.MissionEventSchema.safeParse(event).success).toBe(true);
    expect(
      C.MissionEventSchema.safeParse({ ...event, kind: 'mission.status' })
        .success,
    ).toBe(false);
  });
});
