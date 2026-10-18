import type pg from 'pg';
import type { z } from 'zod';
import type {
  ActionAdmissionPort,
  ActionId,
  ActionStatus,
  AttemptContext,
  ContextSnapshot,
  DependencyVector,
  Environment,
  EventSinkPort,
  MissionBudgetsSchema,
  MissionId,
  MissionSnapshot,
  ModelCallRecord,
  PgClient,
  ProbePort,
  ProviderMode,
  SupportValidator,
  TaskId,
  TaskOutputId,
} from '../contracts/index.js';
import type { FenceReason } from './errors.js';

// Collaborators the coordinator depends on. Everything owned by another
// package (ledger, actions, probe, telemetry) is reached through a port that
// the composition root injects; the coordinator imports none of those packages.

export type MissionBudgets = z.infer<typeof MissionBudgetsSchema>;
export type Db = pg.Pool;

export interface CoordinatorConfig {
  ownerId: string;
  spaceId: string | null;
  environment: Environment;
  resource: string;
  /** Server-resolved mode; a request may only equal it or omit it (I11). */
  mode: ProviderMode;
  provider: { host: string; plannerModel: string; workerModel: string };
  /** Defaults for MissionBudgets (NEMODOTS_MAX_TASKS / NEMODOTS_MAX_DEPTH, breadth 4). */
  budgets: MissionBudgets;
  /** Authoring lease length (NEMODOTS_LEASE_MS, default 30 000). */
  leaseMs: number;
  taskDefaults: {
    maxAttempts: number;
    maxIterations: number;
    maxTokens: number;
  };
  /** request_replan / root-invalidation replans per mission (default 3). */
  replanCap: number;
}

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_REPLAN_CAP = 3;

/** Evidence/inheritance edge writes and the model-call store belong to the ledger. */
export interface LedgerWriterPort {
  /**
   * Store the ModelCallRecord, its ContextSnapshot and the evidence/inheritance
   * edges the call implies. Runs inside the publication transaction, after the
   * fence and SupportValidator checks, so a rejected publication writes nothing.
   */
  recordModelCall(
    client: PgClient,
    input: {
      record: ModelCallRecord;
      snapshot: ContextSnapshot;
      context: AttemptContext;
    },
  ): Promise<void>;
  /**
   * Evidence (receipt -> artifact) and inheritance edges of a published
   * output, finding or delegated task. Same transaction as the publication.
   * Plan tasks are never passed here: the plan is a scheduling artifact (D1).
   */
  recordArtifact(
    client: PgClient,
    artifact: {
      kind: 'task_output' | 'finding' | 'task';
      id: string;
      missionId: MissionId;
      taskId: TaskId;
      attemptId: string;
      dependencyVector: DependencyVector;
    },
  ): Promise<void>;
}

/**
 * C16: a model call completed on the provider while the author's fence was
 * lost. The telemetry owner stores it unfenced with outcome `orphaned_fence`
 * (every InferenceAttempt in `record.attempts` already carries that outcome).
 */
export interface OrphanedAttemptInfo {
  context: AttemptContext;
  record: ModelCallRecord;
  fenceReason: FenceReason;
}
export type RecordOrphanedAttempt = (
  info: OrphanedAttemptInfo,
) => Promise<void>;

export interface IntentRecord {
  id: ActionId;
  missionId: MissionId;
  taskId: TaskId;
  attemptId: string;
  status: ActionStatus;
}

/** Read-only view of `coordinator.action_intents` (written by the actions package). */
export interface IntentReader {
  find(client: PgClient, actionId: ActionId): Promise<IntentRecord | null>;
  statuses(
    client: PgClient,
    actionIds: readonly string[],
  ): Promise<{ id: string; status: ActionStatus }[]>;
  /** Intents of the mission whose effect was already committed (cancel record, C12). */
  committedEffects(client: PgClient, missionId: MissionId): Promise<ActionId[]>;
  /**
   * Intents of the mission still in a live status (proposed, admitted,
   * committed, dispatched, outcome_unknown): work that has not settled yet.
   * The mission evaluation waits for them before it asks for acceptance. Every
   * production reader provides it; a reader without it reports none.
   */
  liveIntents?(client: PgClient, missionId: MissionId): Promise<ActionId[]>;
}

/** The parts of MissionSnapshot owned by the ledger, actions, probe and telemetry packages. */
export type ForeignSnapshot = Pick<
  MissionSnapshot,
  | 'receipts'
  | 'confirmations'
  | 'actions'
  | 'authorizations'
  | 'results'
  | 'probe'
  | 'telemetry'
>;
export interface ForeignSnapshotReader {
  read(client: PgClient, missionId: MissionId): Promise<ForeignSnapshot>;
}

export interface CoordinatorDeps {
  pool: Db;
  config: CoordinatorConfig;
  supportValidator: SupportValidator;
  ledger: LedgerWriterPort;
  recordOrphanedAttempt: RecordOrphanedAttempt;
  intents: IntentReader;
  actions: Pick<ActionAdmissionPort, 'admit' | 'cancelQueued'>;
  snapshotReader: ForeignSnapshotReader;
  /** Acceptance probe; null when the composition root has none (accept() then refuses). */
  probe: ProbePort | null;
  /** Injected provider health (inference reachability); start() consults it. */
  providerHealthy: () => Promise<boolean>;
  events: EventSinkPort;
  /** Wall clock for scheduling decisions made in JS (admission not-before). */
  clock: () => Date;
  /**
   * The recovery options this coordinator runs with (set by createCoordinator).
   * Publication-rejection recovery and mission creation read the scope rule
   * from here so every arm applies one rule everywhere.
   */
  recoveryOptions?: import('./recovery.js').RecoveryOptions;
  /**
   * Recovery scope rules by name (finding D8). `selective` is built in and
   * cannot be replaced. A mission's rule is fixed at creation by the server
   * (`control.create(request, { recoveryScopeRule })`), never by a client.
   */
  recoveryScopeRules?: Record<
    string,
    import('../contracts/index.js').RecoveryScopeRule
  >;
}

/** What a worker handler sees: the server-built identity plus attempt facts. */
export interface ClaimedAttempt {
  context: AttemptContext;
  attempt: {
    n: number;
    kind: 'initial' | 'retry' | 'repair' | 'replan' | 'postcondition';
    leaseExpiresAt: string;
    inheritedDependencyVector: DependencyVector;
    repairOf: { attemptId: string; invalidationEventId: string } | null;
  };
  task: {
    title: string;
    question: string;
    parentId: TaskId | null;
    depth: number;
    maxIterations: number;
    maxTokens: number;
    maxChildren: number;
  };
  mission: { goal: string; constraints: string[] };
  leaseMs: number;
}

export type OutputInput = {
  kind: 'finding' | 'handoff' | 'plan' | 'verification';
  content: unknown;
  dependencyVector: DependencyVector;
};

export type PublishedOutput = {
  outputId: TaskOutputId;
  digest: string;
};
