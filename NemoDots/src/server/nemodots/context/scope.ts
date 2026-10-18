import {
  canonicalByteLength,
  type DependencyEntry,
  type ReceiptId,
  type SourceKey,
} from '../contracts/index.js';
import type { ContextReceipt, ScopeDrop } from './types.js';
import { DEFAULT_ITEM_CAP_BYTES } from './untrusted.js';

// Scoped evidence selection (ARCHITECTURE.md section 11): a task sees only
// its own readset, the receipts its inherited vector names, and the current
// receipts of keys it explicitly requested. Everything else is dropped and the
// drop is recorded. Selection is deterministic for any input order.

export type ScopeInput = {
  /** Receipts the caller could load; anything outside the scope is dropped. */
  candidates: readonly ContextReceipt[];
  readSetReceiptIds: readonly ReceiptId[];
  inheritedVector: readonly DependencyEntry[];
  requestedKeys: readonly SourceKey[];
  maxReceipts: number;
  /** Total budget of rendered value bytes (each item counted up to the item cap). */
  maxBytes?: number;
  itemCapBytes?: number;
};

export type ScopeResult = {
  receipts: ContextReceipt[];
  dropped: ScopeDrop[];
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function selectReceiptsForTask(input: ScopeInput): ScopeResult {
  const readSet = new Set<string>(input.readSetReceiptIds);
  const inherited = new Set<string>(
    input.inheritedVector.map((entry) => entry.receiptId),
  );
  const requested = new Set<string>(input.requestedKeys);
  const cap = input.itemCapBytes ?? DEFAULT_ITEM_CAP_BYTES;

  const dropped: ScopeDrop[] = [];
  const kept = new Map<string, { receipt: ContextReceipt; priority: number }>();

  for (const receipt of input.candidates) {
    const key = receipt.source.key;
    const priority = requested.has(key)
      ? 0
      : readSet.has(receipt.id)
        ? 1
        : inherited.has(receipt.id)
          ? 2
          : null;
    if (priority === null) {
      dropped.push({ id: receipt.id, key, reason: 'not_in_scope' });
      continue;
    }
    // Stale premises must not re-enter a context as current support.
    if (receipt.status !== 'supported') {
      dropped.push({ id: receipt.id, key, reason: 'not_current' });
      continue;
    }
    const existing = kept.get(receipt.id);
    if (!existing || priority < existing.priority)
      kept.set(receipt.id, { receipt, priority });
  }

  const ordered = [...kept.values()].sort(
    (a, b) =>
      a.priority - b.priority ||
      cmp(a.receipt.source.key, b.receipt.source.key) ||
      a.receipt.sourceRevision - b.receipt.sourceRevision ||
      cmp(a.receipt.id, b.receipt.id),
  );

  const selected: ContextReceipt[] = [];
  let bytes = 0;
  for (const { receipt } of ordered) {
    const size = Math.min(canonicalByteLength(receipt.normalizedValue), cap);
    if (
      selected.length >= input.maxReceipts ||
      (input.maxBytes !== undefined && bytes + size > input.maxBytes)
    ) {
      dropped.push({
        id: receipt.id,
        key: receipt.source.key,
        reason: 'over_limit',
      });
      continue;
    }
    selected.push(receipt);
    bytes += size;
  }

  selected.sort(
    (a, b) =>
      cmp(a.source.key, b.source.key) ||
      a.sourceRevision - b.sourceRevision ||
      cmp(a.id, b.id),
  );
  dropped.sort(
    (a, b) => cmp(a.reason, b.reason) || cmp(a.key, b.key) || cmp(a.id, b.id),
  );
  return { receipts: selected, dropped };
}

/** Unusable (invalidated) outputs never re-enter a context; the rest are capped deterministically. */
export function selectInheritedArtifacts<
  T extends { kind: string; id: string; usable: boolean },
>(
  artifacts: readonly T[],
  maxArtifacts: number,
): { artifacts: T[]; dropped: ScopeDrop[] } {
  const dropped: ScopeDrop[] = [];
  const usable: T[] = [];
  for (const artifact of artifacts) {
    if (artifact.usable) usable.push(artifact);
    else
      dropped.push({ id: artifact.id, key: artifact.kind, reason: 'unusable' });
  }
  usable.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id));
  for (const artifact of usable.slice(maxArtifacts))
    dropped.push({ id: artifact.id, key: artifact.kind, reason: 'over_limit' });
  return { artifacts: usable.slice(0, maxArtifacts), dropped };
}
