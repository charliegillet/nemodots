import type {
  ActionId,
  BlockReason,
  FailureReason,
} from '../contracts/index.js';

// Typed errors of the action boundary. Anything that matched zero rows in a
// compare-and-set throws one of these; nothing was written when they surface.

export type DispatchFenceReason =
  | 'not_admitted'
  | 'fence_mismatch'
  | 'lease_expired'
  | 'lease_held'
  | 'intent_missing';

/**
 * The caller does not (or no longer) hold the dispatch lease of the intent:
 * its fence is stale, the lease expired, or the intent is not in the state the
 * statement needs. The intent stays claimable; nothing was written.
 */
export class DispatchFenceError extends Error {
  constructor(
    readonly actionId: ActionId | string,
    readonly reason: DispatchFenceReason,
    detail?: string,
  ) {
    super(
      `dispatch fence rejected action ${actionId}: ${reason}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'DispatchFenceError';
  }
}

export class ActionNotFoundError extends Error {
  constructor(readonly actionId: ActionId | string) {
    super(`action intent ${actionId} does not exist`);
    this.name = 'ActionNotFoundError';
  }
}

/**
 * A proposal that cannot even be stored as an intent (malformed arguments,
 * unknown emitting call). Nothing was written; the tool layer reports it to
 * the model as a tool error.
 */
export class ProposalRejectedError extends Error {
  constructor(
    readonly reason:
      | 'payload_invalid'
      | 'unknown_model_call'
      | 'unknown_tool_call'
      | 'model_call_mismatch',
    detail: string,
  ) {
    super(`proposal rejected: ${reason} (${detail})`);
    this.name = 'ProposalRejectedError';
  }
}

export class CompensationRefusedError extends Error {
  constructor(
    readonly actionId: ActionId | string,
    readonly reason:
      'irreversible' | 'not_committed' | 'version_moved' | 'no_before_value',
    detail?: string,
  ) {
    super(
      `compensation of ${actionId} refused: ${reason}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'CompensationRefusedError';
  }
}

export class EffectUnavailableError extends Error {
  constructor(message = 'the Redis effect is not available') {
    super(message);
    this.name = 'EffectUnavailableError';
  }
}

/** Internal: a predicate failed; carries the reason that is recorded. */
export class PredicateFailure extends Error {
  constructor(
    readonly reason: BlockReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'PredicateFailure';
  }
}

export type { FailureReason };
