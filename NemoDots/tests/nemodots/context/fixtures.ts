import {
  digest,
  type ContextSnapshotId,
  type DependencyEntry,
  type InvalidationEventId,
  type ReceiptId,
  type SourceKey,
} from '../../../src/server/nemodots/contracts/index.js';
import type { CompileContextInput } from '../../../src/server/nemodots/context/compile.js';
import type { ContextReceipt } from '../../../src/server/nemodots/context/types.js';

export const NOW = '2026-10-17T18:00:00.000Z';
export const LATER = '2026-10-17T18:05:00.000Z';

const rid = (n: number) =>
  `c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d40${String(n).padStart(2, '0')}` as ReceiptId;

export function receipt(
  n: number,
  key: string,
  revision: number,
  value: unknown,
  overrides: Partial<ContextReceipt> = {},
): ContextReceipt {
  return {
    id: rid(n),
    source: { key: key as SourceKey },
    sourceRevision: revision,
    collectionRevision: null,
    observedAt: NOW,
    lastConfirmedAt: NOW,
    contentDigest: digest(value),
    normalizedValue: value,
    status: 'supported',
    trust: 'controlled_authority',
    negative: null,
    ...overrides,
  };
}

export const entry = (r: ContextReceipt): DependencyEntry => ({
  sourceKey: r.source.key,
  sourceRevision: r.sourceRevision,
  receiptId: r.id,
});

export const cacheReceipt = () =>
  receipt(1, 'checkout.config/cache.namespace', 3, {
    key: 'cache.namespace',
    value: 'a',
    version: 3,
  });
export const poolReceipt = () =>
  receipt(2, 'checkout.config/db.pool_size', 5, {
    key: 'db.pool_size',
    value: 4,
    version: 5,
  });
export const healthReceipt = () =>
  receipt(
    3,
    'checkout.health',
    9,
    { status: 'degraded' },
    { trust: 'observed_tool' },
  );

export function baseInput(
  overrides: Partial<CompileContextInput> = {},
): CompileContextInput {
  return {
    snapshotId: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f6001' as ContextSnapshotId,
    layout: 'cache_aware',
    nowIso: NOW,
    commonInstructions: 'You are a member of an incident response team.',
    roleInstructions: 'Role: investigator. Observe, then delegate repairs.',
    task: { title: 'Find the cause', question: 'Why do checkouts fail?' },
    runbooks: [
      { id: 'cache', title: 'Cache semantics', text: 'Namespaces scope keys.' },
      {
        id: 'pool',
        title: 'Pool sizing',
        text: 'Pool size bounds concurrency.',
      },
    ],
    receipts: [cacheReceipt(), poolReceipt(), healthReceipt()],
    inheritedArtifacts: [],
    pageSnapshots: [],
    memories: [],
    invalidations: [],
    history: [],
    ...overrides,
  };
}

export const invalidationId = digest(['inv']) as InvalidationEventId;
