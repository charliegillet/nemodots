import type {
  AttemptContext,
  Capability,
  DependencyVector,
  InvalidationEvent,
  MissionId,
  ModelCallId,
  ObservationReceipt,
  ProviderMode,
  ReceiptId,
  ReceiptStatus,
  Scope,
  SourceKey,
  TaskId,
  TaskOutputKind,
  TaskRole,
  TrustClass,
  InferencePort,
} from '../contracts/index.js';
import type { ContextReceipt } from '../context/index.js';
import type { Coordinator, MissionBudgets } from '../coordinator/index.js';
import type { DelegationFacts } from '../coordinator/plan-validation.js';

// Ports of the Nemotron team (ARCHITECTURE.md section 11). Production
// implementations over PostgreSQL live in ./pg-reader.ts and ./observer.ts;
// unit tests inject labelled in-memory implementations. The team never reaches
// the checkout, the sandbox or `control.*` directly: sources are read through
// SourceReaderPort (behind the observer) and everything else through these.

/** The coordinator functions the team calls (a structural slice of Coordinator). */
export type ToolCoordinator = Pick<
  Coordinator,
  | 'addReadSet'
  | 'delegate'
  | 'publishFinding'
  | 'requestReplan'
  | 'markWaiting'
  | 'resumeFromWaiting'
  | 'getTaskStatus'
>;

/** What the worker loop and the planner additionally need to record model calls. */
export type TeamCoordinator = ToolCoordinator &
  Pick<Coordinator, 'recordModelCall'>;

/** InferencePort plus the provider mode stamped on every ModelCallRecord. */
export type TeamInference = InferencePort & {
  readonly mode: ProviderMode;
};

/** A receipt as returned by observe_source (and the planner/repair prefetch). */
export interface ObservedReceipt {
  receiptId: ReceiptId;
  sourceKey: SourceKey;
  sourceRevision: number;
  collectionRevision: number | null;
  observedAt: string;
  lastConfirmedAt: string;
  contentDigest: string;
  normalizedValue: unknown;
  negative: ObservationReceipt['negative'];
  status: ReceiptStatus;
  trust: TrustClass;
  /** False when an unchanged observed value was only confirmed (no new revision). */
  newRevision: boolean;
}

export interface ObservationPort {
  /**
   * Reads the source and registers or confirms its receipt (one transaction,
   * the sources row locked), records the evidence edge receipt -> attempt and
   * a tool_call.recorded event. Scope comes from the AttemptContext, never
   * from the caller.
   */
  observe(input: {
    context: AttemptContext;
    sourceKey: SourceKey;
    toolCallId: string;
    modelCallId: ModelCallId | null;
  }): Promise<ObservedReceipt>;
}

export interface MissionFacts {
  scope: Scope;
  goal: string;
  constraints: string[];
  budgets: MissionBudgets;
  provider: { host: string; plannerModel: string; workerModel: string };
}

export interface TaskOutputView {
  id: string;
  taskId: TaskId;
  taskTitle: string;
  role: TaskRole;
  kind: TaskOutputKind;
  content: unknown;
  digest: string;
  usable: boolean;
  dependencyVector: DependencyVector;
}

export interface PlanOverviewTask {
  id: TaskId;
  parentId: TaskId | null;
  depth: number;
  title: string;
  role: TaskRole;
  status: string;
  outputUsable: boolean | null;
  attemptCount: number;
}

/** Read-only views the team needs. Mission-scoped: ids from the model never select another mission. */
export interface TeamReader {
  mission(missionId: MissionId): Promise<MissionFacts>;
  /** Receipts by id, shaped for the context compiler. Unknown ids are omitted. */
  receipts(ids: readonly string[]): Promise<ContextReceipt[]>;
  /**
   * The snapshot dependency vector of a model call, only if the call belongs to
   * this attempt (same mission, task and attempt). Null otherwise (C10/I8).
   */
  snapshotVector(
    modelCallId: string,
    context: AttemptContext,
  ): Promise<DependencyVector | null>;
  invalidation(
    eventId: string,
    missionId: MissionId,
  ): Promise<InvalidationEvent | null>;
  /** The readset vector recorded on a (previous) attempt of this mission. */
  readSetOf(
    attemptId: string,
    missionId: MissionId,
  ): Promise<DependencyVector | null>;
  taskOutputs(
    missionId: MissionId,
    outputIds: readonly string[],
  ): Promise<TaskOutputView[]>;
  /** Outputs of the succeeded scheduling prerequisites of a task. */
  prerequisiteOutputs(
    missionId: MissionId,
    taskId: TaskId,
  ): Promise<TaskOutputView[]>;
  /** The facts the pure delegation rules need, read for the context's own task. */
  delegationFacts(context: AttemptContext): Promise<DelegationFacts>;
  planOverview(missionId: MissionId): Promise<PlanOverviewTask[]>;
  /** Inference calls and tokens already spent by the mission (recorded + orphaned). */
  missionUsage(
    missionId: MissionId,
  ): Promise<{ calls: number; tokens: number }>;
}

/** Runbook texts by catalogue id. The catalogue map is the only way in (finding I13). */
export interface RunbookLibrary {
  list(): { id: string; title: string }[];
  /** Throws UnknownRunbookError for anything outside the catalogue. */
  read(id: unknown): { id: string; title: string; text: string };
  /** Every runbook, for the stable context prefix. */
  all(): { id: string; title: string; text: string }[];
}

export const CAPABILITY_FOR_TOOL = Object.freeze({
  observe_source: 'observe',
  list_runbooks: 'observe',
  read_runbook: 'observe',
  get_task_status: 'observe',
  wait_for_children: 'delegate',
  delegate_task: 'delegate',
  publish_finding: 'publish_finding',
  request_replan: 'request_replan',
} as const satisfies Record<string, Capability>);
