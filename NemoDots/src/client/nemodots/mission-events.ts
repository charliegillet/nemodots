import type {
  ActionKind,
  ActionStatus,
  AttemptKind,
  AttemptStatus,
  AuthorizationDecision,
  AuthorizationStage,
  BlockReason,
  ConfigValue,
  EventKind,
  FailureReason,
  FindingConfidence,
  InvalidationReason,
  Mission,
  MissionEvent,
  MissionSnapshot,
  MissionStatus,
  ObservationReceipt,
  ReceiptStatus,
  RecoveryEvent,
  ScriptResult,
  SelfWrite,
  TaskRole,
  TaskStatus,
  TelemetrySummary,
  TrustClass,
} from '../../server/nemodots/contracts/index.js';

// Pure mission-event reducer (CONTRACTS section 8, rev2 C6/D4). No React and no
// I/O, tested like src/client/poll-notice.ts. Rules:
//  - events are deduplicated by an id set and may arrive out of order; every
//    status-bearing field remembers the id of the event that set it, so a late
//    lower id never overwrites a higher one;
//  - events for another mission are rejected;
//  - a storage snapshot is authoritative up to its lastEventId, newer retained
//    events are replayed on top of it;
//  - nodes are built from an explicit allow-list of fields, so stray payload
//    keys (control data, prompts) never reach the state or the views;
//  - every list is bounded.

const EVENT_KIND_TABLE: Record<EventKind, true> = {
  'mission.created': true,
  'mission.status': true,
  'task.created': true,
  'task.status': true,
  'attempt.started': true,
  'attempt.finished': true,
  'attempt.aborted': true,
  'model_call.recorded': true,
  'tool_call.recorded': true,
  'receipt.registered': true,
  'receipt.confirmed': true,
  'receipt.transition': true,
  'finding.published': true,
  'output.published': true,
  'action.proposed': true,
  'action.decided': true,
  'action.committed': true,
  'action.dispatched': true,
  'action.verified': true,
  'action.failed': true,
  'action.outcome_unknown': true,
  'invalidation.recorded': true,
  'invalidation.resolved': true,
  'recovery.recorded': true,
  'probe.recorded': true,
  'health.sampled': true,
  'telemetry.updated': true,
  heartbeat: true,
};

/**
 * Client mirror of the contract's EventKind enum (the client cannot import the
 * zod runtime). The Record type makes the compiler fail when a kind is added or
 * removed on the server without updating this table.
 */
export const EVENT_KINDS: ReadonlySet<string> = new Set(
  Object.keys(EVENT_KIND_TABLE),
);

export const LIMITS = Object.freeze({
  events: 500,
  seenIds: 4000,
  tasks: 300,
  attempts: 600,
  receipts: 600,
  findings: 200,
  outputs: 300,
  actions: 200,
  invalidations: 100,
  recoveries: 200,
});

export interface TaskNode {
  id: string;
  parentId: string | null;
  depth: number;
  ordinal: number | null;
  title: string;
  role: TaskRole | null;
  capabilities: string[];
  prerequisites: string[];
  justification: string | null;
  status: TaskStatus;
  statusEventId: number;
  /** false for a placeholder created by an event that arrived before task.created */
  known: boolean;
}

export interface AttemptNode {
  id: string;
  taskId: string;
  n: number;
  kind: AttemptKind | null;
  status: AttemptStatus;
  statusEventId: number;
  repairOf: { attemptId: string; invalidationEventId: string } | null;
  abortReason: string | null;
  readSetReceiptIds: string[];
  modelCallCount: number | null;
  known: boolean;
}

export interface ReceiptNode {
  id: string;
  sourceKey: string;
  sourceRevision: number | null;
  supersedes: string | null;
  trust: TrustClass | null;
  selfWrite: SelfWrite | null;
  provenanceKind: ObservationReceipt['provenance']['kind'] | null;
  contentDigest: string | null;
  status: ReceiptStatus;
  statusEventId: number;
  /** when the receipt was first observed; null when unknown */
  observedAt: string | null;
  /** latest confirmation; null when the ledger has not seen one */
  lastConfirmedAt: string | null;
  known: boolean;
}

export interface FindingNode {
  id: string;
  taskId: string;
  attemptId: string;
  /** model-asserted text; untrusted */
  claim: string;
  confidence: FindingConfidence;
  supportingReceiptIds: string[];
  usable: boolean;
}

export interface OutputNode {
  id: string;
  taskId: string;
  attemptId: string;
  kind: string;
  digest: string;
  usable: boolean | null;
}

export interface CheckedVectorRow {
  sourceKey: string;
  recordedRevision: number;
  liveRevision: number;
  receiptStatus: ReceiptStatus;
  lastConfirmedAt: string;
  freshnessOk: boolean;
}

export interface DecisionNode {
  stage: AuthorizationStage;
  decision: AuthorizationDecision;
  blockReason: BlockReason | null;
  blockDetail: string | null;
  checkedVector: CheckedVectorRow[];
  targetVersion: { expected: number; live: number };
  dispatchFence: { token: number; valid: boolean } | null;
  eventId: number;
}

export interface ActionNode {
  id: string;
  taskId: string | null;
  attemptId: string | null;
  action: ActionKind | null;
  targetSourceKey: string | null;
  payloadHash: string | null;
  expectedTargetVersion: number | null;
  /** present for set_config; the value the intent would write */
  configValue: ConfigValue | null;
  requiredSources: string[];
  dependencyReceiptIds: string[];
  admissionNotBefore: string | null;
  status: ActionStatus;
  statusEventId: number;
  decisions: Partial<Record<AuthorizationStage, DecisionNode>>;
  blockReason: BlockReason | null;
  blockDetail: string | null;
  committed: {
    targetVersionBefore: number;
    targetVersionAfter: number | null;
    afterDigest: string | null;
  } | null;
  dispatched: {
    scriptResult: ScriptResult | null;
    deletedCount: number | null;
  } | null;
  verified: {
    kind: 'history' | 'observation';
    receiptId: string | null;
    configVersion: number | null;
  } | null;
  failure: { reason: FailureReason; detail: string | null } | null;
  unknownDetail: string | null;
  known: boolean;
}

export interface InvalidationNode {
  id: string;
  sourceKey: string;
  oldReceiptId: string;
  newReceiptId: string | null;
  reason: InvalidationReason | null;
  selfWrite: SelfWrite | null;
  affected: {
    modelCallIds: string[];
    attemptIds: string[];
    outputIds: string[];
    actionIds: string[];
    taskIds: string[];
  };
  preservedTaskIds: string[];
  closure: { depth: number; nodes: number; capped: boolean } | null;
  recordedEventId: number | null;
  /** when the invalidation was recorded (event time or snapshot createdAt) */
  createdAt: string | null;
  resolvedAt: string | null;
  known: boolean;
}

export interface RecoveryNode {
  id: string;
  invalidationEventId: string;
  kind: RecoveryEvent['kind'];
  taskId: string | null;
  attemptId: string | null;
  newAttemptId: string | null;
  actionId: string | null;
  detail: string;
  createdAt: string;
  eventId: number | null;
}

export interface ProbeNode {
  receiptId: string;
  verdict: 'pass' | 'fail' | null;
  invariants: { name: string; ok: boolean }[];
  healthSamples: number | null;
  healthOk: number | null;
  eventId: number;
}

export interface HealthSampleNode {
  checkout: 'ok' | 'degraded' | 'down';
  providerReachable: boolean;
  postgres: 'ok' | 'down';
  redis: 'ok' | 'down';
  sampledAt: string;
  eventId: number;
}

export interface Counters {
  applied: number;
  duplicates: number;
  wrongMission: number;
  malformed: number;
  stale: number;
}

export interface MissionState {
  missionId: string;
  mission: Mission | null;
  /** latest status carried by a mission.status event (or the snapshot) */
  missionStatus: MissionStatus | null;
  missionStatusEventId: number;
  tasks: TaskNode[];
  attempts: AttemptNode[];
  receipts: ReceiptNode[];
  findings: FindingNode[];
  outputs: OutputNode[];
  actions: ActionNode[];
  invalidations: InvalidationNode[];
  recoveries: RecoveryNode[];
  probe: ProbeNode | null;
  health: HealthSampleNode | null;
  telemetry: TelemetrySummary | null;
  telemetryEventId: number;
  /** retained events, ascending by id; heartbeats are not stored */
  events: MissionEvent[];
  seenIds: ReadonlySet<number>;
  /** ids at or below this were evicted from seenIds and are rejected as stale */
  floorId: number;
  /** max of every accepted event id and the merged snapshot's lastEventId */
  lastEventId: number;
  /** lastEventId of the merged snapshot, 0 when none */
  snapshotEventId: number;
  lastHeartbeatAt: string | null;
  counters: Counters;
}

export type ApplyOutcome =
  'applied' | 'duplicate' | 'wrong_mission' | 'malformed' | 'stale';

export interface ApplyResult {
  state: MissionState;
  outcome: ApplyOutcome;
}

export function createMissionState(missionId: string): MissionState {
  return {
    missionId,
    mission: null,
    missionStatus: null,
    missionStatusEventId: 0,
    tasks: [],
    attempts: [],
    receipts: [],
    findings: [],
    outputs: [],
    actions: [],
    invalidations: [],
    recoveries: [],
    probe: null,
    health: null,
    telemetry: null,
    telemetryEventId: 0,
    events: [],
    seenIds: new Set(),
    floorId: 0,
    lastEventId: 0,
    snapshotEventId: 0,
    lastHeartbeatAt: null,
    counters: {
      applied: 0,
      duplicates: 0,
      wrongMission: 0,
      malformed: 0,
      stale: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// list helpers

type WithId = { id: string };

function bounded<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

function upsert<T extends WithId>(
  list: readonly T[],
  id: string,
  stub: (id: string) => T,
  patch: (item: T) => T,
  max: number,
): T[] {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return bounded([...list, patch(stub(id))], max);
  const next = list.slice();
  next[index] = patch(list[index]);
  return next;
}

const later = (a: string | null, b: string | null): string | null => {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
};

const ids = (list: readonly string[]): string[] => [...list];

// ---------------------------------------------------------------------------
// stubs (an event can arrive before the event that creates its entity)

const stubTask = (id: string): TaskNode => ({
  id,
  parentId: null,
  depth: 0,
  ordinal: null,
  title: `Task ${id.slice(0, 8)}`,
  role: null,
  capabilities: [],
  prerequisites: [],
  justification: null,
  status: 'pending',
  statusEventId: 0,
  known: false,
});

const stubAttempt = (id: string): AttemptNode => ({
  id,
  taskId: '',
  n: 0,
  kind: null,
  status: 'running',
  statusEventId: 0,
  repairOf: null,
  abortReason: null,
  readSetReceiptIds: [],
  modelCallCount: null,
  known: false,
});

const stubReceipt = (id: string): ReceiptNode => ({
  id,
  sourceKey: '',
  sourceRevision: null,
  supersedes: null,
  trust: null,
  selfWrite: null,
  provenanceKind: null,
  contentDigest: null,
  status: 'supported',
  statusEventId: 0,
  observedAt: null,
  lastConfirmedAt: null,
  known: false,
});

const stubAction = (id: string): ActionNode => ({
  id,
  taskId: null,
  attemptId: null,
  action: null,
  targetSourceKey: null,
  payloadHash: null,
  expectedTargetVersion: null,
  configValue: null,
  requiredSources: [],
  dependencyReceiptIds: [],
  admissionNotBefore: null,
  status: 'proposed',
  statusEventId: 0,
  decisions: {},
  blockReason: null,
  blockDetail: null,
  committed: null,
  dispatched: null,
  verified: null,
  failure: null,
  unknownDetail: null,
  known: false,
});

const stubInvalidation = (id: string): InvalidationNode => ({
  id,
  sourceKey: '',
  oldReceiptId: '',
  newReceiptId: null,
  reason: null,
  selfWrite: null,
  affected: {
    modelCallIds: [],
    attemptIds: [],
    outputIds: [],
    actionIds: [],
    taskIds: [],
  },
  preservedTaskIds: [],
  closure: null,
  recordedEventId: null,
  createdAt: null,
  resolvedAt: null,
  known: false,
});

const stubFinding = (id: string): FindingNode => ({
  id,
  taskId: '',
  attemptId: '',
  claim: '',
  confidence: 'low',
  supportingReceiptIds: [],
  usable: true,
});

const stubOutput = (id: string): OutputNode => ({
  id,
  taskId: '',
  attemptId: '',
  kind: '',
  digest: '',
  usable: null,
});

const stubRecovery = (id: string): RecoveryNode => ({
  id,
  invalidationEventId: '',
  kind: 'repair_scheduled',
  taskId: null,
  attemptId: null,
  newAttemptId: null,
  actionId: null,
  detail: '',
  createdAt: '',
  eventId: null,
});

// ---------------------------------------------------------------------------
// folding one event into the entity views

function setStatus<T extends { status: unknown; statusEventId: number }>(
  node: T,
  status: T['status'],
  eventId: number,
): T {
  return eventId <= node.statusEventId
    ? node
    : { ...node, status, statusEventId: eventId };
}

function copyVector(vector: readonly CheckedVectorRow[]): CheckedVectorRow[] {
  return vector.map((row) => ({
    sourceKey: row.sourceKey,
    recordedRevision: row.recordedRevision,
    liveRevision: row.liveRevision,
    receiptStatus: row.receiptStatus,
    lastConfirmedAt: row.lastConfirmedAt,
    freshnessOk: row.freshnessOk,
  }));
}

const STATUS_FOR_DECISION: Record<AuthorizationDecision, ActionStatus> = {
  admitted: 'admitted',
  committed: 'committed',
  blocked: 'blocked',
  dispatched: 'dispatched',
};

function foldEvent(state: MissionState, event: MissionEvent): MissionState {
  const p = event.payload;
  const eventId = event.id;
  switch (p.kind) {
    case 'mission.created': {
      const newer =
        state.missionStatus !== null && state.missionStatusEventId > eventId;
      const status = newer
        ? (state.missionStatus as MissionStatus)
        : p.mission.status;
      return {
        ...state,
        mission: { ...p.mission, status },
        missionStatus: status,
        missionStatusEventId: Math.max(state.missionStatusEventId, eventId),
      };
    }
    case 'mission.status': {
      if (eventId <= state.missionStatusEventId) return state;
      return {
        ...state,
        missionStatus: p.to,
        missionStatusEventId: eventId,
        mission: state.mission ? { ...state.mission, status: p.to } : null,
      };
    }
    case 'task.created':
      return {
        ...state,
        tasks: upsert(
          state.tasks,
          p.task.id,
          stubTask,
          (t) => ({
            ...t,
            parentId: p.task.parentId,
            depth: p.task.depth,
            title: p.task.title,
            role: p.task.role,
            capabilities: ids(p.task.capabilities),
            prerequisites: ids(p.task.prerequisites),
            justification: p.task.justification,
            known: true,
          }),
          LIMITS.tasks,
        ),
      };
    case 'task.status':
      return {
        ...state,
        tasks: upsert(
          state.tasks,
          p.taskId,
          stubTask,
          (t) => setStatus(t, p.to, eventId),
          LIMITS.tasks,
        ),
      };
    case 'attempt.started':
      return {
        ...state,
        attempts: upsert(
          state.attempts,
          p.attemptId,
          stubAttempt,
          (a) => ({
            ...a,
            taskId: p.taskId,
            n: p.n,
            kind: p.attemptKind,
            repairOf: p.repairOf
              ? {
                  attemptId: p.repairOf.attemptId,
                  invalidationEventId: p.repairOf.invalidationEventId,
                }
              : null,
            known: true,
          }),
          LIMITS.attempts,
        ),
      };
    case 'attempt.finished':
      return {
        ...state,
        attempts: upsert(
          state.attempts,
          p.attemptId,
          stubAttempt,
          (a) =>
            a.statusEventId >= eventId
              ? a
              : {
                  ...setStatus(a, p.status, eventId),
                  taskId: a.taskId || p.taskId,
                  readSetReceiptIds: ids(p.readSetReceiptIds),
                  modelCallCount: p.modelCallCount,
                },
          LIMITS.attempts,
        ),
      };
    case 'attempt.aborted':
      return {
        ...state,
        attempts: upsert(
          state.attempts,
          p.attemptId,
          stubAttempt,
          (a) =>
            a.statusEventId >= eventId
              ? a
              : {
                  ...setStatus(a, 'aborted', eventId),
                  taskId: a.taskId || p.taskId,
                  abortReason: p.abortReason,
                },
          LIMITS.attempts,
        ),
      };
    case 'receipt.registered':
      return {
        ...state,
        receipts: upsert(
          state.receipts,
          p.receiptId,
          stubReceipt,
          (r) => ({
            ...r,
            sourceKey: p.sourceKey,
            sourceRevision: p.sourceRevision,
            supersedes: p.supersedes,
            trust: p.trust,
            selfWrite: p.selfWrite,
            provenanceKind: p.provenanceKind,
            contentDigest: p.contentDigest,
            observedAt: r.observedAt ?? event.at,
            lastConfirmedAt: later(r.lastConfirmedAt, event.at),
            known: true,
          }),
          LIMITS.receipts,
        ),
      };
    case 'receipt.confirmed':
      return {
        ...state,
        receipts: upsert(
          state.receipts,
          p.receiptId,
          stubReceipt,
          (r) => ({
            ...r,
            sourceKey: r.sourceKey || p.sourceKey,
            lastConfirmedAt: later(r.lastConfirmedAt, p.confirmedAt),
          }),
          LIMITS.receipts,
        ),
      };
    case 'receipt.transition':
      return {
        ...state,
        receipts: upsert(
          state.receipts,
          p.receiptId,
          stubReceipt,
          (r) => setStatus(r, p.to, eventId),
          LIMITS.receipts,
        ),
      };
    case 'finding.published':
      return {
        ...state,
        findings: upsert(
          state.findings,
          p.findingId,
          stubFinding,
          (f) => ({
            ...f,
            taskId: p.taskId,
            attemptId: p.attemptId,
            claim: p.claim,
            confidence: p.confidence,
            supportingReceiptIds: ids(p.supportingReceiptIds),
          }),
          LIMITS.findings,
        ),
      };
    case 'output.published':
      return {
        ...state,
        outputs: upsert(
          state.outputs,
          p.outputId,
          stubOutput,
          (o) => ({
            ...o,
            taskId: p.taskId,
            attemptId: p.attemptId,
            kind: p.outputKind,
            digest: p.digest,
          }),
          LIMITS.outputs,
        ),
      };
    case 'action.proposed':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => ({
            ...a,
            taskId: p.taskId,
            attemptId: p.attemptId,
            action: p.action,
            targetSourceKey: p.target.sourceKey,
            payloadHash: p.payloadHash,
            expectedTargetVersion: p.expectedTargetVersion,
            requiredSources: ids(p.requiredSources),
            dependencyReceiptIds: p.dependencyVector.map(
              (entry) => entry.receiptId,
            ),
            admissionNotBefore: p.admissionNotBefore,
            known: true,
          }),
          LIMITS.actions,
        ),
      };
    case 'action.decided':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => {
            const previous = a.decisions[p.stage];
            const decisions =
              previous && previous.eventId >= eventId
                ? a.decisions
                : {
                    ...a.decisions,
                    [p.stage]: {
                      stage: p.stage,
                      decision: p.decision,
                      blockReason: p.blockReason,
                      blockDetail: p.blockDetail,
                      checkedVector: copyVector(p.checkedVector),
                      targetVersion: {
                        expected: p.targetVersion.expected,
                        live: p.targetVersion.live,
                      },
                      dispatchFence: p.dispatchFence
                        ? {
                            token: p.dispatchFence.token,
                            valid: p.dispatchFence.valid,
                          }
                        : null,
                      eventId,
                    } satisfies DecisionNode,
                  };
            const next = setStatus(a, STATUS_FOR_DECISION[p.decision], eventId);
            return {
              ...next,
              decisions,
              ...(next.statusEventId === eventId
                ? {
                    blockReason: p.blockReason,
                    blockDetail: p.blockDetail,
                  }
                : {}),
            };
          },
          LIMITS.actions,
        ),
      };
    case 'action.committed':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => ({
            ...setStatus(a, 'committed', eventId),
            committed: {
              targetVersionBefore: p.targetVersionBefore,
              targetVersionAfter: p.targetVersionAfter,
              afterDigest: p.afterDigest,
            },
          }),
          LIMITS.actions,
        ),
      };
    case 'action.dispatched':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => ({
            ...setStatus(a, 'dispatched', eventId),
            dispatched: {
              scriptResult: p.scriptResult,
              deletedCount: p.deletedCount,
            },
          }),
          LIMITS.actions,
        ),
      };
    case 'action.verified':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => ({
            ...setStatus(a, 'verified', eventId),
            verified: {
              kind: p.postcondition.kind,
              receiptId: p.postcondition.receiptId,
              configVersion: p.postcondition.configVersion,
            },
          }),
          LIMITS.actions,
        ),
      };
    case 'action.failed':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => ({
            ...setStatus(a, 'failed', eventId),
            failure: { reason: p.failureReason, detail: p.detail },
          }),
          LIMITS.actions,
        ),
      };
    case 'action.outcome_unknown':
      return {
        ...state,
        actions: upsert(
          state.actions,
          p.actionId,
          stubAction,
          (a) => ({
            ...setStatus(a, 'outcome_unknown', eventId),
            unknownDetail: p.detail,
          }),
          LIMITS.actions,
        ),
      };
    case 'invalidation.recorded':
      return {
        ...state,
        invalidations: upsert(
          state.invalidations,
          p.invalidationEventId,
          stubInvalidation,
          (i) => ({
            ...i,
            sourceKey: p.sourceKey,
            oldReceiptId: p.oldReceiptId,
            newReceiptId: p.newReceiptId,
            reason: p.reason,
            selfWrite: p.selfWrite,
            affected: {
              modelCallIds: ids(p.affected.modelCallIds),
              attemptIds: ids(p.affected.attemptIds),
              outputIds: ids(p.affected.outputIds),
              actionIds: ids(p.affected.actionIds),
              taskIds: ids(p.affected.taskIds),
            },
            preservedTaskIds: ids(p.preserved.taskIds),
            closure: {
              depth: p.closure.depth,
              nodes: p.closure.nodes,
              capped: p.closure.capped,
            },
            recordedEventId: eventId,
            createdAt: event.at,
            known: true,
          }),
          LIMITS.invalidations,
        ),
      };
    case 'invalidation.resolved':
      return {
        ...state,
        invalidations: upsert(
          state.invalidations,
          p.invalidationEventId,
          stubInvalidation,
          (i) => ({ ...i, resolvedAt: later(i.resolvedAt, p.resolvedAt) }),
          LIMITS.invalidations,
        ),
      };
    case 'recovery.recorded':
      return {
        ...state,
        recoveries: upsert(
          state.recoveries,
          p.recovery.id,
          stubRecovery,
          (r) => ({
            ...r,
            invalidationEventId: p.recovery.invalidationEventId,
            kind: p.recovery.kind,
            taskId: p.recovery.taskId,
            attemptId: p.recovery.attemptId,
            newAttemptId: p.recovery.newAttemptId,
            actionId: p.recovery.actionId,
            detail: p.recovery.detail,
            createdAt: p.recovery.createdAt,
            eventId,
          }),
          LIMITS.recoveries,
        ),
      };
    case 'probe.recorded':
      return state.probe && state.probe.eventId >= eventId
        ? state
        : {
            ...state,
            probe: {
              receiptId: p.receiptId,
              verdict: p.verdict,
              invariants: p.invariants.map((inv) => ({
                name: inv.name,
                ok: inv.ok,
              })),
              healthSamples: p.healthSamples,
              healthOk: p.healthOk,
              eventId,
            },
          };
    case 'health.sampled':
      return state.health && state.health.eventId >= eventId
        ? state
        : {
            ...state,
            health: {
              checkout: p.checkout.status,
              providerReachable: p.provider.reachable,
              postgres: p.postgres,
              redis: p.redis,
              sampledAt: event.at,
              eventId,
            },
          };
    case 'telemetry.updated':
      return eventId <= state.telemetryEventId
        ? state
        : { ...state, telemetry: p.summary, telemetryEventId: eventId };
    case 'model_call.recorded':
    case 'tool_call.recorded':
      return state;
    case 'heartbeat':
      return state;
    default:
      return state;
  }
}

/**
 * foldEvent over an event the server contract may have drifted from: a payload
 * missing the fields its kind needs throws inside foldEvent; that is reported
 * as null so the caller can count the event as malformed instead of crashing.
 */
function safeFold(
  state: MissionState,
  event: MissionEvent,
): MissionState | null {
  try {
    const next = foldEvent(state, event);
    return next ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// public reducer

function addSeen(
  seen: ReadonlySet<number>,
  id: number,
  floorId: number,
): { seenIds: ReadonlySet<number>; floorId: number } {
  const next = new Set(seen);
  next.add(id);
  if (next.size <= LIMITS.seenIds) return { seenIds: next, floorId };
  const sorted = [...next].sort((a, b) => a - b);
  const drop = sorted.slice(0, sorted.length - LIMITS.seenIds);
  for (const dropped of drop) next.delete(dropped);
  return { seenIds: next, floorId: Math.max(floorId, drop[drop.length - 1]) };
}

function insertEvent(events: MissionEvent[], event: MissionEvent) {
  const next = events.slice();
  let index = next.length;
  while (index > 0 && next[index - 1].id > event.id) index -= 1;
  next.splice(index, 0, event);
  return bounded(next, LIMITS.events);
}

function reject(
  state: MissionState,
  outcome: Exclude<ApplyOutcome, 'applied'>,
): ApplyResult {
  const counters = { ...state.counters };
  if (outcome === 'duplicate') counters.duplicates += 1;
  else if (outcome === 'wrong_mission') counters.wrongMission += 1;
  else if (outcome === 'malformed') counters.malformed += 1;
  else counters.stale += 1;
  return { state: { ...state, counters }, outcome };
}

/** Apply one durable event. Pure; duplicates and wrong-mission events return the outcome. */
export function applyMissionEvent(
  state: MissionState,
  event: MissionEvent,
): ApplyResult {
  if (event.missionId !== state.missionId)
    return reject(state, 'wrong_mission');
  if (
    !Number.isSafeInteger(event.id) ||
    event.id <= 0 ||
    !event.payload ||
    event.payload.kind !== event.kind ||
    !EVENT_KINDS.has(event.kind)
  )
    return reject(state, 'malformed');
  if (state.seenIds.has(event.id)) return reject(state, 'duplicate');
  if (event.id <= state.floorId) return reject(state, 'stale');
  const seen = addSeen(state.seenIds, event.id, state.floorId);
  let next: MissionState = {
    ...state,
    ...seen,
    lastEventId: Math.max(state.lastEventId, event.id),
    counters: { ...state.counters, applied: state.counters.applied + 1 },
  };
  if (event.kind === 'heartbeat')
    return {
      state: { ...next, lastHeartbeatAt: event.at },
      outcome: 'applied',
    };
  next = { ...next, events: insertEvent(next.events, event) };
  // A merged snapshot already reflects everything up to its lastEventId; the
  // event is kept for the timeline but not folded twice.
  if (event.id > state.snapshotEventId) {
    const folded = safeFold(next, event);
    if (!folded) return reject(state, 'malformed');
    next = folded;
  }
  return { state: next, outcome: 'applied' };
}

// ---------------------------------------------------------------------------
// snapshots

function probeFromReceipt(
  receipt: MissionSnapshot['probe'],
  eventId: number,
): ProbeNode | null {
  if (!receipt) return null;
  const value = receipt.normalizedValue as {
    verdict?: unknown;
    invariants?: unknown;
    healthSamples?: unknown;
    healthOk?: unknown;
  } | null;
  const invariants = Array.isArray(value?.invariants)
    ? (value.invariants as unknown[]).flatMap((item) => {
        const row = item as { name?: unknown; ok?: unknown } | null;
        return typeof row?.name === 'string' && typeof row.ok === 'boolean'
          ? [{ name: row.name, ok: row.ok }]
          : [];
      })
    : [];
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    receiptId: receipt.id,
    verdict:
      value?.verdict === 'pass' || value?.verdict === 'fail'
        ? value.verdict
        : null,
    invariants,
    healthSamples: count(value?.healthSamples),
    healthOk: count(value?.healthOk),
    eventId,
  };
}

function actionFromSnapshot(
  snapshot: MissionSnapshot,
  intent: MissionSnapshot['actions'][number],
): ActionNode {
  const at = snapshot.lastEventId;
  const decisions: Partial<Record<AuthorizationStage, DecisionNode>> = {};
  const authorizations = snapshot.authorizations
    .filter((auth) => auth.actionId === intent.id)
    .sort((x, y) => Date.parse(x.decidedAt) - Date.parse(y.decidedAt));
  for (const auth of authorizations) {
    decisions[auth.stage] = {
      stage: auth.stage,
      decision: auth.decision,
      blockReason: auth.blockReason,
      blockDetail: auth.decision === 'blocked' ? intent.blockDetail : null,
      checkedVector: copyVector(auth.checkedVector),
      targetVersion: {
        expected: auth.targetVersion.expected,
        live: auth.targetVersion.live,
      },
      dispatchFence: auth.dispatchFence
        ? { token: auth.dispatchFence.token, valid: auth.dispatchFence.valid }
        : null,
      eventId: at,
    };
  }
  const result = [...snapshot.results]
    .reverse()
    .find((item) => item.actionId === intent.id);
  const payload = intent.payload as { value?: ConfigValue };
  return {
    id: intent.id,
    taskId: intent.taskId,
    attemptId: intent.attemptId,
    action: intent.action,
    targetSourceKey: intent.target.sourceKey,
    payloadHash: intent.payloadHash,
    expectedTargetVersion: intent.expectedTargetVersion,
    configValue:
      intent.action === 'set_config' && payload.value !== undefined
        ? payload.value
        : null,
    requiredSources: ids(intent.requiredSources),
    dependencyReceiptIds: intent.dependencyVector.map(
      (entry) => entry.receiptId,
    ),
    admissionNotBefore: null,
    status: intent.status,
    statusEventId: at,
    decisions,
    blockReason: intent.blockReason,
    blockDetail: intent.blockDetail,
    committed: result?.controlPlane
      ? {
          targetVersionBefore: result.controlPlane.targetVersionBefore,
          targetVersionAfter: result.controlPlane.targetVersionAfter,
          afterDigest: result.controlPlane.afterDigest,
        }
      : null,
    dispatched: result?.externalEffect
      ? {
          scriptResult: result.externalEffect.scriptResult,
          deletedCount: result.externalEffect.deletedCount,
        }
      : null,
    verified: result?.postcondition
      ? {
          kind: result.postcondition.kind,
          receiptId: result.postcondition.receiptId,
          configVersion: result.postcondition.configVersion,
        }
      : null,
    failure: intent.failureReason
      ? { reason: intent.failureReason, detail: null }
      : null,
    unknownDetail: null,
    known: true,
  };
}

function viewsFromSnapshot(snapshot: MissionSnapshot): Partial<MissionState> {
  const at = snapshot.lastEventId;
  const confirmedBy = new Map<string, string>();
  for (const confirmation of snapshot.confirmations) {
    const current = confirmedBy.get(confirmation.receiptId) ?? null;
    confirmedBy.set(
      confirmation.receiptId,
      later(current, confirmation.confirmedAt) as string,
    );
  }
  return {
    mission: snapshot.mission,
    missionStatus: snapshot.mission.status,
    missionStatusEventId: at,
    tasks: bounded(
      [...snapshot.tasks]
        .sort((a, b) => a.depth - b.depth || a.ordinal - b.ordinal)
        .map((task): TaskNode => ({
          id: task.id,
          parentId: task.parentId,
          depth: task.depth,
          ordinal: task.ordinal,
          title: task.title,
          role: task.role,
          capabilities: ids(task.capabilities),
          prerequisites: ids(task.prerequisites),
          justification: task.justification,
          status: task.status,
          statusEventId: at,
          known: true,
        })),
      LIMITS.tasks,
    ),
    attempts: bounded(
      snapshot.attempts.map((attempt): AttemptNode => ({
        id: attempt.id,
        taskId: attempt.taskId,
        n: attempt.n,
        kind: attempt.kind,
        status: attempt.status,
        statusEventId: at,
        repairOf: attempt.repairOf
          ? {
              attemptId: attempt.repairOf.attemptId,
              invalidationEventId: attempt.repairOf.invalidationEventId,
            }
          : null,
        abortReason: attempt.abortReason,
        readSetReceiptIds: ids(attempt.readSetReceiptIds),
        modelCallCount: attempt.modelCallIds.length,
        known: true,
      })),
      LIMITS.attempts,
    ),
    receipts: bounded(
      snapshot.receipts.map((receipt): ReceiptNode => ({
        id: receipt.id,
        sourceKey: receipt.source.key,
        sourceRevision: receipt.sourceRevision,
        supersedes: receipt.supersedes,
        trust: receipt.trust,
        selfWrite: receipt.provenance.selfWrite,
        provenanceKind: receipt.provenance.kind,
        contentDigest: receipt.contentDigest,
        status: receipt.status,
        statusEventId: at,
        observedAt: receipt.observedAt,
        lastConfirmedAt: later(
          receipt.lastConfirmedAt,
          confirmedBy.get(receipt.id) ?? null,
        ),
        known: true,
      })),
      LIMITS.receipts,
    ),
    findings: bounded(
      snapshot.findings.map((finding): FindingNode => ({
        id: finding.id,
        taskId: finding.taskId,
        attemptId: finding.attemptId,
        claim: finding.claim,
        confidence: finding.confidence,
        supportingReceiptIds: ids(finding.supportingReceiptIds),
        usable: finding.usable,
      })),
      LIMITS.findings,
    ),
    outputs: bounded(
      snapshot.outputs.map((output): OutputNode => ({
        id: output.id,
        taskId: output.taskId,
        attemptId: output.attemptId,
        kind: output.kind,
        digest: output.digest,
        usable: output.usable,
      })),
      LIMITS.outputs,
    ),
    actions: bounded(
      snapshot.actions.map((intent) => actionFromSnapshot(snapshot, intent)),
      LIMITS.actions,
    ),
    invalidations: bounded(
      snapshot.invalidations.map((event): InvalidationNode => {
        const own =
          event.perMission.find(
            (entry) => entry.missionId === snapshot.mission.id,
          ) ?? null;
        const affected = own?.affected ?? event.affected;
        return {
          id: event.id,
          sourceKey: event.sourceKey,
          oldReceiptId: event.oldReceiptId,
          newReceiptId: event.newReceiptId,
          reason: event.reason,
          selfWrite: event.selfWrite,
          affected: {
            modelCallIds: ids(affected.modelCallIds),
            attemptIds: ids(affected.attemptIds),
            outputIds: ids(affected.outputIds),
            actionIds: ids(affected.actionIds),
            taskIds: ids(affected.taskIds),
          },
          preservedTaskIds: ids(own?.preserved.taskIds ?? []),
          closure: {
            depth: event.closure.depth,
            nodes: event.closure.nodes,
            capped: event.closure.capped,
          },
          recordedEventId: at,
          createdAt: event.createdAt,
          resolvedAt: event.resolvedAt,
          known: true,
        };
      }),
      LIMITS.invalidations,
    ),
    recoveries: bounded(
      snapshot.recoveries.map((recovery): RecoveryNode => ({
        id: recovery.id,
        invalidationEventId: recovery.invalidationEventId,
        kind: recovery.kind,
        taskId: recovery.taskId,
        attemptId: recovery.attemptId,
        newAttemptId: recovery.newAttemptId,
        actionId: recovery.actionId,
        detail: recovery.detail,
        createdAt: recovery.createdAt,
        eventId: at,
      })),
      LIMITS.recoveries,
    ),
    probe: probeFromReceipt(snapshot.probe, at),
    telemetry: snapshot.telemetry,
    telemetryEventId: at,
  };
}

/**
 * Merge a storage snapshot: it is authoritative up to its lastEventId; retained
 * events with a higher id are replayed on top. An older snapshot than the one
 * already merged is ignored.
 */
export function mergeMissionSnapshot(
  state: MissionState,
  snapshot: MissionSnapshot,
): ApplyResult {
  if (snapshot.mission.id !== state.missionId)
    return reject(state, 'wrong_mission');
  if (snapshot.lastEventId < state.snapshotEventId)
    return reject(state, 'stale');
  let next: MissionState = {
    ...state,
    ...viewsFromSnapshot(snapshot),
    snapshotEventId: snapshot.lastEventId,
    lastEventId: Math.max(state.lastEventId, snapshot.lastEventId),
  };
  for (const event of state.events)
    if (event.id > snapshot.lastEventId) next = safeFold(next, event) ?? next;
  return { state: next, outcome: 'applied' };
}

export type MissionAction =
  | { type: 'event'; event: MissionEvent }
  | { type: 'events'; events: readonly MissionEvent[] }
  | { type: 'snapshot'; snapshot: MissionSnapshot }
  | { type: 'reset'; missionId: string };

/** `useReducer`-compatible wrapper. */
export function missionReducer(
  state: MissionState,
  action: MissionAction,
): MissionState {
  switch (action.type) {
    case 'event':
      return applyMissionEvent(state, action.event).state;
    case 'events':
      return action.events.reduce(
        (current, event) => applyMissionEvent(current, event).state,
        state,
      );
    case 'snapshot':
      return mergeMissionSnapshot(state, action.snapshot).state;
    case 'reset':
      return createMissionState(action.missionId);
  }
}

// ---------------------------------------------------------------------------
// selectors

export function selectMissionStatus(state: MissionState): MissionStatus | null {
  return state.mission?.status ?? null;
}

export interface DependencyEndpoint {
  kind: 'task' | 'receipt' | 'action';
  id: string;
  label: string;
}
export interface DependencyEdgeView {
  id: string;
  /** scheduling: task ordering; evidence: a receipt a task or action relied on */
  kind: 'scheduling' | 'evidence';
  from: DependencyEndpoint;
  to: DependencyEndpoint;
}

/** Scheduling edges (task prerequisites) and evidence edges (read sets and action vectors). */
export function selectDependencyEdges(
  state: MissionState,
): DependencyEdgeView[] {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const receipts = new Map(state.receipts.map((r) => [r.id, r]));
  const task = (id: string): DependencyEndpoint => ({
    kind: 'task',
    id,
    label: tasks.get(id)?.title ?? `Task ${id.slice(0, 8)}`,
  });
  const receipt = (id: string): DependencyEndpoint => {
    const node = receipts.get(id);
    return {
      kind: 'receipt',
      id,
      label:
        node && node.sourceKey
          ? `${node.sourceKey} rev ${node.sourceRevision ?? '?'}`
          : `Receipt ${id.slice(0, 8)}`,
    };
  };
  const edges: DependencyEdgeView[] = [];
  const seen = new Set<string>();
  const add = (
    kind: DependencyEdgeView['kind'],
    from: DependencyEndpoint,
    to: DependencyEndpoint,
  ) => {
    const id = `${kind}:${from.kind}:${from.id}>${to.kind}:${to.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, kind, from, to });
  };
  for (const node of state.tasks)
    for (const prerequisite of node.prerequisites)
      add('scheduling', task(prerequisite), task(node.id));
  for (const attempt of state.attempts)
    if (attempt.taskId)
      for (const receiptId of attempt.readSetReceiptIds)
        add('evidence', receipt(receiptId), task(attempt.taskId));
  for (const action of state.actions) {
    const target: DependencyEndpoint = {
      kind: 'action',
      id: action.id,
      label: `${action.action ?? 'action'} ${action.id.slice(0, 8)}`,
    };
    for (const receiptId of action.dependencyReceiptIds)
      add('evidence', receipt(receiptId), target);
  }
  return edges;
}
