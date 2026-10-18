import type {
  AbortReason,
  ActionId,
  AttemptId,
  AttemptKind,
  AttemptStatus,
  Capability,
  DependencyVector,
  Environment,
  Finding,
  FindingConfidence,
  FindingId,
  InvalidationEvent,
  InvalidationEventId,
  Mission,
  MissionId,
  MissionStatus,
  ModelCallId,
  ProviderMode,
  ReceiptId,
  RecoveryEvent,
  RecoveryEventId,
  RecoveryKind,
  Task,
  TaskAttempt,
  TaskId,
  TaskOutput,
  TaskOutputId,
  TaskOutputKind,
  TaskRole,
  TaskStatus,
} from '../contracts/index.js';
import type { MissionBudgets } from './types.js';

// Row types for the coordinator tables (0003_coordinator) and their mappers
// to the contract DTOs. Timestamps leave node-postgres as Date; DTOs carry
// ISO strings.

export const iso = (value: Date) => value.toISOString();
export const isoOrNull = (value: Date | null) => (value ? iso(value) : null);

export interface MissionRow {
  id: string;
  owner_id: string;
  space_id: string | null;
  environment: string;
  resource: string;
  goal: string;
  constraints: string[];
  mode: string;
  status: string;
  transition_version: number;
  generation: number;
  budgets: MissionBudgets;
  admission_min_age_ms: number;
  provider: { host: string; plannerModel: string; workerModel: string };
  acceptance_receipt_id: string | null;
  failure_reason: string | null;
  cancellation: Mission['cancellation'];
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export function toMission(row: MissionRow): Mission {
  return {
    id: row.id as MissionId,
    scope: {
      ownerId: row.owner_id,
      missionId: row.id as MissionId,
      spaceId: row.space_id,
      environment: row.environment as Environment,
      resource: row.resource,
    },
    goal: row.goal,
    constraints: row.constraints,
    mode: row.mode as ProviderMode,
    status: row.status as MissionStatus,
    transitionVersion: row.transition_version,
    generation: row.generation,
    budgets: row.budgets,
    admission: { minAgeMs: row.admission_min_age_ms },
    provider: row.provider,
    acceptanceReceiptId: row.acceptance_receipt_id as ReceiptId | null,
    failureReason: row.failure_reason,
    cancellation: row.cancellation,
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export type TaskRepair = {
  kind: 'repair' | 'replan' | 'postcondition';
  repairOf: { attemptId: string; invalidationEventId: string } | null;
  reason: string;
};

export interface TaskRow {
  id: string;
  mission_id: string;
  parent_id: string | null;
  depth: number;
  ordinal: number;
  title: string;
  question: string;
  role: string;
  capabilities: string[];
  status: string;
  transition_version: number;
  generation: number;
  prerequisites: string[];
  fence_seq: number;
  attempt_count: number;
  max_attempts: number;
  budget: Task['budget'];
  output_id: string | null;
  created_by_model_call_id: string | null;
  justification: string | null;
  inherited_dependency_vector: DependencyVector;
  repair: TaskRepair | null;
  dedupe_key: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id as TaskId,
    missionId: row.mission_id as MissionId,
    parentId: row.parent_id as TaskId | null,
    depth: row.depth,
    ordinal: row.ordinal,
    title: row.title,
    question: row.question,
    role: row.role as TaskRole,
    capabilities: row.capabilities as Capability[],
    status: row.status as TaskStatus,
    transitionVersion: row.transition_version,
    generation: row.generation,
    prerequisites: row.prerequisites as TaskId[],
    fenceSeq: row.fence_seq,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    budget: row.budget,
    outputId: row.output_id as TaskOutputId | null,
    createdByModelCallId: row.created_by_model_call_id as ModelCallId | null,
    justification: row.justification,
    createdAt: iso(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export interface AttemptRow {
  id: string;
  task_id: string;
  mission_id: string;
  n: number;
  kind: string;
  status: string;
  generation: number;
  lease_owner: string;
  fencing_token: number;
  lease_expires_at: Date;
  lease_renewed_at: Date;
  read_set_receipt_ids: string[];
  read_set_vector: DependencyVector;
  model_call_ids: string[];
  inherited_dependency_vector: DependencyVector;
  repair_of: { attemptId: string; invalidationEventId: string } | null;
  abort_reason: string | null;
  failure_reason: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export function toAttempt(row: AttemptRow): TaskAttempt {
  return {
    id: row.id as AttemptId,
    taskId: row.task_id as TaskId,
    missionId: row.mission_id as MissionId,
    n: row.n,
    kind: row.kind as AttemptKind,
    status: row.status as AttemptStatus,
    generation: row.generation,
    lease: {
      owner: row.lease_owner,
      fencingToken: row.fencing_token,
      expiresAt: iso(row.lease_expires_at),
      renewedAt: iso(row.lease_renewed_at),
    },
    readSetReceiptIds: row.read_set_receipt_ids as ReceiptId[],
    modelCallIds: row.model_call_ids as ModelCallId[],
    inheritedDependencyVector: row.inherited_dependency_vector,
    repairOf: row.repair_of
      ? {
          attemptId: row.repair_of.attemptId as AttemptId,
          invalidationEventId: row.repair_of
            .invalidationEventId as InvalidationEventId,
        }
      : null,
    abortReason: row.abort_reason as AbortReason | null,
    startedAt: iso(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export interface OutputRow {
  id: string;
  task_id: string;
  attempt_id: string;
  mission_id: string;
  kind: string;
  content: unknown;
  digest: string;
  dependency_vector: DependencyVector;
  usable: boolean;
  unusable_reason: string | null;
  published_at: Date;
}

export function toOutput(row: OutputRow): TaskOutput {
  return {
    id: row.id as TaskOutputId,
    taskId: row.task_id as TaskId,
    attemptId: row.attempt_id as AttemptId,
    kind: row.kind as TaskOutputKind,
    content: row.content,
    digest: row.digest,
    dependencyVector: row.dependency_vector,
    usable: row.usable,
    unusableReason: row.unusable_reason,
    publishedAt: iso(row.published_at),
  };
}

export interface FindingRow {
  id: string;
  mission_id: string;
  task_id: string;
  attempt_id: string;
  claim: string;
  supporting_receipt_ids: string[];
  confidence: string;
  usable: boolean;
  dependency_vector: DependencyVector;
  created_at: Date;
}

export function toFinding(row: FindingRow): Finding {
  return {
    id: row.id as FindingId,
    missionId: row.mission_id as MissionId,
    taskId: row.task_id as TaskId,
    attemptId: row.attempt_id as AttemptId,
    claim: row.claim,
    supportingReceiptIds: row.supporting_receipt_ids as ReceiptId[],
    confidence: row.confidence as FindingConfidence,
    trust: 'model_claim',
    usable: row.usable,
    dependencyVector: row.dependency_vector,
    createdAt: iso(row.created_at),
  };
}

export interface RecoveryRow {
  id: string;
  invalidation_event_id: string;
  mission_id: string;
  kind: string;
  task_id: string | null;
  attempt_id: string | null;
  new_attempt_id: string | null;
  action_id: string | null;
  detail: string;
  created_at: Date;
}

export function toRecovery(row: RecoveryRow): RecoveryEvent {
  return {
    id: row.id as RecoveryEventId,
    invalidationEventId: row.invalidation_event_id as InvalidationEventId,
    missionId: row.mission_id as MissionId,
    kind: row.kind as RecoveryKind,
    taskId: row.task_id as TaskId | null,
    attemptId: row.attempt_id as AttemptId | null,
    newAttemptId: row.new_attempt_id as AttemptId | null,
    actionId: row.action_id as ActionId | null,
    detail: row.detail,
    createdAt: iso(row.created_at),
  };
}

export interface InvalidationRow {
  event_id: string;
  mission_id: string;
  event: Omit<InvalidationEvent, 'resolvedAt'> & {
    resolvedAt?: string | null;
  };
  source_key: string;
  reason: string;
  self_write: string;
  gate_task_id: string | null;
  created_at: Date;
  processed_at: Date | null;
  resolved_at: Date | null;
}

/** The mission-scoped InvalidationEvent as stored, with resolvedAt from the row. */
export function toInvalidation(row: InvalidationRow): InvalidationEvent {
  return {
    ...row.event,
    resolvedAt: isoOrNull(row.resolved_at),
  } as InvalidationEvent;
}
