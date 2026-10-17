// Typed errors of the ledger. Messages and details carry ids, keys and counts,
// never receipt contents (normalized values may include operational data).
import type { BlockReason, CheckedVector } from '../contracts/index.js';

export type LedgerErrorCode =
  | 'invalid_source_key'
  | 'invalid_observation'
  | 'too_large'
  | 'revision_mismatch'
  | 'stale_observation_rejected'
  | 'digest_mismatch'
  | 'source_conflict'
  | 'controlled_source_missing'
  | 'receipt_not_found'
  | 'receipt_conflict'
  | 'receipt_not_registrable'
  | 'closure_cap_exceeded'
  | 'edge_invalid'
  | 'edge_cycle'
  | 'model_call_invalid'
  | 'model_call_conflict'
  | 'unsafe_identifier';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The source key does not match any registered family (CONTRACTS section 1). */
export class InvalidSourceKeyError extends LedgerError {
  constructor(key: string) {
    super(
      'invalid_source_key',
      `source key is not in the registry (length ${key.length})`,
    );
  }
}

/** The observation is malformed (schema, canonical JSON, provenance). */
export class InvalidObservationError extends LedgerError {
  constructor(message: string) {
    super('invalid_observation', message);
  }
}

/** normalizedValue exceeds the 16 KiB canonical bound. */
export class ObservationTooLargeError extends LedgerError {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(
      'too_large',
      `normalizedValue is ${bytes} canonical bytes; the limit is ${maxBytes}`,
    );
  }
}

/** The claimed revision is ahead of (or otherwise disagrees with) what the ledger can assign. */
export class RevisionMismatchError extends LedgerError {
  constructor(
    readonly claimed: number,
    readonly expected: number,
  ) {
    super(
      'revision_mismatch',
      `claimed revision ${claimed} does not match revision ${expected}`,
    );
  }
}

/** (rev2 C8) An observation older than the authority's or the ledger's current revision. */
export class StaleObservationRejectedError extends LedgerError {
  constructor(
    readonly observed: number,
    readonly current: number,
  ) {
    super(
      'stale_observation_rejected',
      `observation at revision ${observed} is older than current revision ${current}`,
    );
  }
}

/** The claimed digest (or the digest of a re-observation at the same revision) disagrees. */
export class DigestMismatchError extends LedgerError {
  constructor(message: string) {
    super('digest_mismatch', message);
  }
}

export class SourceConflictError extends LedgerError {
  constructor(message: string) {
    super('source_conflict', message);
  }
}

/** A controlled member that the authority no longer has (key deleted). */
export class ControlledSourceMissingError extends LedgerError {
  constructor(readonly sourceKey: string) {
    super(
      'controlled_source_missing',
      `controlled source ${sourceKey} has no row in the authority`,
    );
  }
}

export class ReceiptNotFoundError extends LedgerError {
  constructor(readonly receiptId: string) {
    super('receipt_not_found', `receipt ${receiptId} does not exist`);
  }
}

/** A compare-and-set on (status, status_version) found the row changed. */
export class ReceiptConflictError extends LedgerError {
  constructor(message: string) {
    super('receipt_conflict', message);
  }
}

/** Same revision and digest re-observed while the head receipt is no longer supported. */
export class ReceiptNotRegistrableError extends LedgerError {
  constructor(message: string) {
    super('receipt_not_registrable', message);
  }
}

/**
 * The invalidation closure exceeded its depth or node cap. Thrown before the
 * new receipt was written (C14); the watcher pauses `missionIds` and calls
 * registerWithoutClosure in a fresh transaction.
 */
export class ClosureCapExceeded extends LedgerError {
  constructor(
    readonly cap: 'depth' | 'nodes',
    readonly limits: { maxDepth: number; maxNodes: number },
    readonly sourceKey: string,
    readonly oldReceiptId: string,
    readonly missionIds: string[],
  ) {
    super(
      'closure_cap_exceeded',
      `invalidation closure for ${sourceKey} exceeds the ${cap} cap (depth ${limits.maxDepth}, nodes ${limits.maxNodes})`,
    );
  }
}

export class EdgeError extends LedgerError {
  constructor(message: string, code: 'edge_invalid' | 'edge_cycle' = 'edge_invalid') {
    super(code, message);
  }
}

export class ModelCallRecordError extends LedgerError {
  constructor(
    code: 'model_call_invalid' | 'model_call_conflict',
    message: string,
  ) {
    super(code, message);
  }
}

/**
 * A publication or commit is not supported by current evidence. `reason` is
 * the BlockReason the caller records on its Authorization or InvalidationEvent;
 * `checkedVector` is what was examined (all receipts, not only the failing one).
 */
export class SupportError extends Error {
  readonly name = 'SupportError';
  constructor(
    readonly reason: BlockReason,
    readonly detail: string,
    readonly checkedVector: CheckedVector = [],
    readonly receiptId: string | null = null,
    readonly sourceKey: string | null = null,
  ) {
    super(`${reason}: ${detail}`);
  }
}

export function isSupportError(error: unknown): error is SupportError {
  return error instanceof SupportError;
}
