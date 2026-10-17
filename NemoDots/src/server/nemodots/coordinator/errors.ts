import type {
  AttemptId,
  MissionId,
  ReceiptId,
  SourceKey,
  TaskId,
} from '../contracts/index.js';

// Typed coordinator errors. Every CAS UPDATE that matches zero rows throws one
// of these instead of returning a flag, so callers cannot ignore a lost race.

export type FenceReason =
  | 'attempt_missing'
  | 'attempt_not_running'
  | 'token_mismatch'
  | 'generation_mismatch'
  | 'lease_expired'
  | 'mission_not_running'
  | 'task_state';

/**
 * A fenced statement found that the caller no longer owns the attempt: the
 * lease was taken over (token mismatch), the attempt left `running` (aborted,
 * expired, invalidated), the mission generation moved (cancel) or the mission
 * is not running. Nothing was written.
 */
export class FenceError extends Error {
  /** Set when recording orphaned inference telemetry itself failed (C16). */
  orphanRecordError?: unknown;
  constructor(
    readonly attemptId: AttemptId | string,
    readonly reason: FenceReason,
    detail?: string,
  ) {
    super(
      `fence rejected attempt ${attemptId}: ${reason}${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'FenceError';
  }
}

/**
 * Raised by a SupportValidator when a publication rests on evidence that is no
 * longer current. The ledger throws its own class with `name === 'SupportError'`
 * (it may not import the coordinator); `isSupportError` matches by shape so
 * either class is recognised. `reason` is the ledger's machine code
 * (`stale_version`, `receipt_not_supported`, `evidence_too_old`, ...).
 */
export class SupportError extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
    readonly receiptId?: ReceiptId | string,
    readonly sourceKey?: SourceKey | string,
  ) {
    super(`support rejected: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'SupportError';
  }
}

export type SupportErrorShape = Error & {
  reason: string;
  detail?: string;
  receiptId?: string;
  sourceKey?: string;
};

export function isSupportError(error: unknown): error is SupportErrorShape {
  return (
    error instanceof Error &&
    error.name === 'SupportError' &&
    typeof (error as { reason?: unknown }).reason === 'string'
  );
}

/** A compare-and-set UPDATE matched no row: someone else moved the entity first. */
export class CasConflictError extends Error {
  constructor(
    readonly entity: 'mission' | 'task' | 'attempt' | 'outbox' | 'invalidation',
    readonly id: string,
    readonly expected: string,
  ) {
    super(`${entity} ${id} is no longer ${expected}`);
    this.name = 'CasConflictError';
  }
}

export class MissionNotFoundError extends Error {
  constructor(readonly missionId: MissionId | string) {
    super(`mission ${missionId} does not exist`);
    this.name = 'MissionNotFoundError';
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: TaskId | string) {
    super(`task ${taskId} does not exist in this mission`);
    this.name = 'TaskNotFoundError';
  }
}

/** The requested mission lifecycle step is not allowed from the current status. */
export class MissionStateError extends Error {
  constructor(
    readonly missionId: MissionId | string,
    readonly status: string,
    readonly requested: string,
  ) {
    super(`mission ${missionId} is ${status}: cannot ${requested}`);
    this.name = 'MissionStateError';
  }
}

export class ModeMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly server: string,
  ) {
    super(
      `mission mode ${requested} does not match the server-resolved mode ${server}`,
    );
    this.name = 'ModeMismatchError';
  }
}

/** A plan or delegation was refused; `issues` lists every violated rule. */
export class PlanRejectedError extends Error {
  constructor(readonly issues: string[]) {
    super(`plan rejected: ${issues.join('; ')}`);
    this.name = 'PlanRejectedError';
  }
}

export class DelegationRejectedError extends Error {
  constructor(readonly issues: string[]) {
    super(`delegation rejected: ${issues.join('; ')}`);
    this.name = 'DelegationRejectedError';
  }
}

export class CitationOutOfScopeError extends Error {
  constructor(readonly receiptIds: string[]) {
    super(
      `citations outside the attempt's scope (snapshot vector, readset, inherited vector): ${receiptIds.join(', ')}`,
    );
    this.name = 'CitationOutOfScopeError';
  }
}

export class CapabilityDeniedError extends Error {
  constructor(
    readonly capability: string,
    readonly role: string,
  ) {
    super(`capability ${capability} is not granted to this ${role} task`);
    this.name = 'CapabilityDeniedError';
  }
}

/** succeeded was requested while an invalidation is still open (D9). */
export class OpenInvalidationsError extends Error {
  constructor(
    readonly missionId: MissionId | string,
    readonly eventIds: string[],
  ) {
    super(
      `mission ${missionId} has ${eventIds.length} open invalidation(s); it cannot succeed`,
    );
    this.name = 'OpenInvalidationsError';
  }
}

export class AcceptanceRejectedError extends Error {
  constructor(
    readonly missionId: MissionId | string,
    readonly why: string,
  ) {
    super(`acceptance rejected for mission ${missionId}: ${why}`);
    this.name = 'AcceptanceRejectedError';
  }
}

/** Thrown by operations that need a collaborator the composition root did not provide. */
export class CoordinatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorConfigError';
  }
}
