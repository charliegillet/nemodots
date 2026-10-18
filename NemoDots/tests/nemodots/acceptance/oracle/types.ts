// Types of the frozen deterministic oracle. Pure data, no behaviour.
// Oracle ids (e.g. 'A1', 'R.pool.r1') are symbolic; the acceptance driver
// maps each to the real UUID it created and never the reverse.
import type {
  ActionStatus,
  AttemptStatus,
  BlockReason,
  ConfigKey,
  ConfigValue,
  EdgeKind,
  FailureReason,
  InvalidationReason,
  RecoveryKind,
  TaskRole,
} from './spec-enums.js';

export type GraphNodeKind =
  | 'receipt'
  | 'model_call'
  | 'attempt'
  | 'task_output'
  | 'task'
  | 'action_intent';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  missionId: string;
  /** Creation order; evidence/inheritance edges must go from lower to higher. */
  seq: number;
  /** Owning task for attempts, model calls, outputs and intents. */
  taskId?: string;
  /** Receipts: source key and revision. */
  sourceKey?: string;
  revision?: number;
  /** Receipts: scope environment (CONTRACTS 1); default 'test'. */
  environment?: 'dev' | 'test' | 'eval';
  /** Tasks: role and parent. */
  role?: TaskRole;
  parentTaskId?: string | null;
  /** Intents: status at the moment of the change. */
  intentStatus?: ActionStatus;
  /** Attempts: status at the moment of the change. */
  attemptStatus?: AttemptStatus;
}

export interface GraphEdge {
  kind: EdgeKind;
  from: string;
  to: string;
}

export interface ReceiptChange {
  /** The receipt that stops being current. */
  oldReceipt: string;
  reason: InvalidationReason;
  /** Controlled member/collection change, or an observed digest change. */
  via:
    | 'member_value_change'
    | 'collection_insert'
    | 'collection_delete'
    | 'observed_digest_change';
}

export interface AffectedSets {
  modelCallIds: string[];
  attemptIds: string[];
  outputIds: string[];
  actionIds: string[];
  taskIds: string[];
}

export interface PerMissionExpectation {
  missionId: string;
  affected: AffectedSets;
  preservedTaskIds: string[];
}

export interface ClosureExpectation {
  /** Global affected set (union over changes for simultaneous cases). */
  affected: AffectedSets;
  /** Per mission; a mission absent from this list receives NO invalidation event. */
  perMission: PerMissionExpectation[];
  /** Intent statuses after the closure commits (only listed intents are checked). */
  intentStatusAfter: Record<
    string,
    { status: ActionStatus; blockReason?: BlockReason }
  >;
  /** Number of invalidation_events rows created by the change(s). */
  invalidationEvents: number;
  /** True when the expectation is conservative (no sufficiency representation in v1). */
  conservative: boolean;
  /** What a conventional DAG (scheduling-edge) restart would rerun; evaluation only. */
  dagRestartTaskIds?: string[];
  /** Receipts that must still be current (status supported, no supersession) afterwards. */
  receiptsStillCurrent?: string[];
}

export interface ClosureCase {
  id: string;
  title: string;
  /** TEST_PROMPT references, e.g. 'gate1.8'. */
  covers: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  changes: ReceiptChange[];
  /** Changes are registered concurrently behind a barrier. */
  concurrent: boolean;
  expected: ClosureExpectation;
}

export type RejectionCode =
  'scheduling_cycle' | 'edge_cycle' | 'edge_order' | 'closure_cap_exceeded';

export interface RejectionCase {
  id: string;
  title: string;
  covers: string[];
  operation:
    | { kind: 'plan'; dependsOn: number[][] }
    | {
        kind: 'delegate';
        existing: {
          id: string;
          parentTaskId: string | null;
          waitsOn: string[];
        }[];
        parentTaskId: string;
        childDependsOn: string[];
      }
    | {
        kind: 'edge';
        nodes: GraphNode[];
        existing: GraphEdge[];
        add: GraphEdge;
      }
    | {
        kind: 'generated';
        /** chain: R0 -> A1 -> O1 -> A2 -> ... ; fanout: R0 -> A1..An */
        shape: 'chain' | 'fanout';
        /** Number of attempt nodes generated. */
        size: number;
      };
  expected: {
    rejected: true;
    /** Any of these codes is an acceptable classification of the refusal. */
    acceptedCodes: RejectionCode[];
    /** Rows that must not exist after the rejection. */
    writesNothing: true;
    /** For closure caps: what the watcher path must do afterwards. */
    afterwards?: {
      missionsPaused: boolean;
      coarseEventCapped: boolean;
      receiptRegistered: boolean;
      recoveryKind: RecoveryKind;
    };
  };
}

export interface SelfWriteCase {
  id: string;
  title: string;
  covers: string[];
  /** Writes to one key in order; 'action' rows carry caused_by_action_id. */
  history: (
    | { by: 'action'; actionId: string; afterDigestMatches: boolean }
    | { by: 'injector' | 'owner' }
  )[];
  actingLineageTaskIds: string[];
  otherReaderTaskIds: string[];
  expected: {
    headSelfWrite: 'none' | 'verified' | 'mismatch';
    intentOutcome: Record<
      string,
      { status: ActionStatus; failureReason?: FailureReason }
    >;
    actingLineageInvalidated: boolean;
    otherReadersInvalidated: boolean;
    postconditionAttempts: number;
    /** Routing kinds recorded right after the watcher pass (during the postcondition gate). */
    recoveryKinds: RecoveryKind[];
    /** Upper bound on repair attempts created per affected task (no storm). */
    maxRepairAttemptsPerTask: number;
    /**
     * oracle-v3: number of `replan_scheduled` rows for the held replan's event
     * once the postcondition settles (the release). Verified self-writes only.
     */
    replansReleasedAfterPostcondition?: number;
    /** oracle-v3: the only root tasks whose invalidation may trigger the replan. */
    replanTriggerTaskIds?: string[];
  };
}

export type LedgerOp =
  | { op: 'seed_config'; key: ConfigKey; value: ConfigValue }
  | {
      op: 'advance_config';
      key: string;
      value: ConfigValue;
      actor: 'injector' | 'owner';
      insertIfMissing?: boolean;
      deleteKey?: boolean;
    }
  | {
      op: 'register';
      label: string;
      sourceKey: string;
      environment?: 'dev' | 'test' | 'eval';
      /** For observed sources: the normalized value to register. */
      normalizedValue?: unknown;
      /**
       * Tampering/late-delivery cases: claimed revision (relative, like relRevision)
       * or a digest that disagrees with the normalized value.
       */
      claimRevision?: number;
      claimDigestMismatch?: boolean;
      /** Size of a synthetic payload in canonical bytes (oversize cases). */
      syntheticBytes?: number;
    }
  | {
      op: 'register_concurrent';
      labels: [string, string];
      sourceKey: string;
      normalizedValue: unknown;
    }
  | { op: 'age_receipt'; label: string; ageMs: number }
  | {
      op: 'transition';
      label: string;
      to: 'contested' | 'retracted' | 'expired';
    }
  | {
      op: 'tamper_update';
      label: string;
      column: 'normalized_value' | 'content_digest' | 'source_revision';
    }
  | {
      op: 'assert_current';
      labels: string[];
      lockMode: 'share' | 'update';
      freshness?: Record<string, number>;
    }
  | { op: 'publish_finding'; label: string; citing: string[] }
  | { op: 'page_edit'; pageId: string };

export interface LedgerExpectation {
  /** Per op index: the outcome. */
  outcomes: Record<
    number,
    | {
        ok: true;
        /** Observed sources: absolute ledger-assigned revision. */
        revision?: number;
        /** Controlled sources: revision minus the authority version right after the case's seed ops. */
        relRevision?: number;
        newRevision?: boolean;
        confirmation?: boolean;
      }
    | { ok: false; error: string }
  >;
  /** Final facts checked at the end. Source keys are written '<environment>:<sourceKey>'. */
  final: {
    currentRevisionBySource?: Record<string, number>;
    currentRelRevisionBySource?: Record<string, number>;
    receiptStatus?: Record<
      string,
      'supported' | 'superseded' | 'contested' | 'retracted' | 'expired'
    >;
    receiptRowsBySource?: Record<string, number>;
    confirmationsByLabel?: Record<string, number>;
    distinctSources?: number;
    newObservationReceipts?: number;
    /** Authority version minus the version right after the case's seed_config ops. */
    configVersionDelta?: Record<string, number>;
    configValue?: Record<string, ConfigValue>;
    /** Number of new coordinator.findings rows, all with trust 'model_claim'. */
    modelClaimFindings?: number;
  };
}

export interface LedgerCase {
  id: string;
  title: string;
  covers: string[];
  ops: LedgerOp[];
  expected: LedgerExpectation;
}
