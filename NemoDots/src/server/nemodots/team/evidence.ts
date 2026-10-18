import type { ContextReceipt } from '../context/index.js';
import type { DependencyEntry } from '../contracts/index.js';
import type { ObservedReceipt } from './types.js';

/** An observation of this attempt, shaped for the context compiler. */
export function toContextReceipt(receipt: ObservedReceipt): ContextReceipt {
  return {
    id: receipt.receiptId,
    sourceRevision: receipt.sourceRevision,
    collectionRevision: receipt.collectionRevision,
    observedAt: receipt.observedAt,
    lastConfirmedAt: receipt.lastConfirmedAt,
    contentDigest: receipt.contentDigest as ContextReceipt['contentDigest'],
    normalizedValue: receipt.normalizedValue,
    status: receipt.status,
    trust: receipt.trust as ContextReceipt['trust'],
    negative: receipt.negative,
    source: { key: receipt.sourceKey },
  };
}

export function toEntry(receipt: ObservedReceipt): DependencyEntry {
  return {
    sourceKey: receipt.sourceKey,
    sourceRevision: receipt.sourceRevision,
    receiptId: receipt.receiptId,
  };
}
