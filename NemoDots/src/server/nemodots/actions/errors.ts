// Typed errors of the action boundary. Messages carry ids, keys and counts,
// never payload values (a config value may be operational data).
import type { ActionStatus, BlockReason } from '../contracts/index.js';

export type ActionErrorCode =
  | 'action_not_found'
  | 'invalid_proposal'
  | 'dispatch_fence'
  | 'compensation_refused'
  | 'settle_refused'
  | 'effect_unavailable';

export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ActionNotFoundError extends ActionError {
  constructor(readonly actionId: string) {
    super('action_not_found', `action intent ${actionId} does not exist`);
  }
}

/**
 * The proposal is not a well-typed ActionIntent at all (unknown ActionKind,
 * extra or forged fields, malformed ids). Nothing was written. A well-typed
 * proposal that the policy refuses (value domain, missing source, scope)
 * becomes a `blocked` intent instead, so the model receives the reason.
 */
export class InvalidProposalError extends ActionError {
  readonly reason: BlockReason = 'payload_invalid';
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super('invalid_proposal', message);
  }
}

export type DispatchFenceReason =
  | 'not_admitted'
  | 'fence_mismatch'
  | 'lease_expired';

/**
 * The caller is not the current dispatcher of an admitted intent: its fence is
 * stale, its lease expired, or the intent is not admitted. Thrown from the
 * commit transaction step 2, before anything is written; the intent stays
 * claimable by a re-claiming dispatcher (ARCHITECTURE 5.1, finding C4).
 */
export class DispatchFenceError extends ActionError {
  constructor(
    readonly actionId: string,
    readonly reason: DispatchFenceReason,
    readonly status: ActionStatus,
    detail?: string,
  ) {
    super(
      'dispatch_fence',
      `dispatch fence rejected action ${actionId}: ${reason} (status ${status})${detail ? `: ${detail}` : ''}`,
    );
  }
}

export class CompensationRefusedError extends ActionError {
  constructor(
    readonly actionId: string,
    readonly why:
      | 'not_reversible'
      | 'not_committed'
      | 'version_moved'
      | 'no_prior_value'
      | 'already_compensated'
      | 'evidence_missing',
    detail: string,
  ) {
    super('compensation_refused', `cannot compensate ${actionId}: ${detail}`);
  }
}

export class SettleRefusedError extends ActionError {
  constructor(
    readonly actionId: string,
    detail: string,
  ) {
    super('settle_refused', `cannot settle ${actionId}: ${detail}`);
  }
}

export class EffectUnavailableError extends ActionError {
  constructor(message: string) {
    super('effect_unavailable', message);
  }
}
