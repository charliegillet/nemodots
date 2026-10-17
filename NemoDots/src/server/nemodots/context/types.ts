import type {
  ObservationReceipt,
  ReceiptId,
  SourceKey,
} from '../contracts/index.js';

// Shared input/record shapes of the context compiler. Pure data: no I/O.

/**
 * The part of an ObservationReceipt the compiler renders. A full
 * ObservationReceipt is assignable, but only these fields are ever read:
 * provenance (including injector actors) and rawRef never reach the model.
 */
export type ContextReceipt = Pick<
  ObservationReceipt,
  | 'id'
  | 'sourceRevision'
  | 'collectionRevision'
  | 'observedAt'
  | 'lastConfirmedAt'
  | 'contentDigest'
  | 'normalizedValue'
  | 'status'
  | 'trust'
  | 'negative'
> & { source: { key: SourceKey } };

/** A per-item byte cap that cut an injected item; recorded, never silent. */
export type TruncationRecord = {
  item: string;
  originalBytes: number;
  keptBytes: number;
  /** sha256 of the full (redacted) text, so the cut item stays identifiable. */
  originalDigest: string;
};

export type ScopeDropReason =
  'not_in_scope' | 'not_current' | 'over_limit' | 'unusable';

export type ScopeDrop = {
  id: string;
  key: string;
  reason: ScopeDropReason;
};

export type { ReceiptId };
