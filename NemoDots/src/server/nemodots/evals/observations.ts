// What the runner records about one trial, as plain data. The oracle
// (scoring.ts) consumes only these records and the scenario manifest, so it can
// be tested on synthetic observations and never touches the database, the
// ledger's closure code or the coordinator.
export interface ObsTask {
  id: string;
  parentId: string | null;
  role: string;
  status: string;
  prerequisites: string[];
  outputId: string | null;
  /** null when the task has no output */
  outputUsable: boolean | null;
  attemptCount: number;
}

export interface ObsAttempt {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  /** the invalidation event a repair attempt answers, if any */
  repairOfEventId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ObsNode {
  kind: string;
  id: string;
  missionId: string | null;
  taskId: string | null;
}

export interface ObsEdge {
  kind: 'evidence' | 'inheritance' | 'scheduling';
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  createdAt: string;
}

export interface ObsAffected {
  modelCallIds: string[];
  attemptIds: string[];
  outputIds: string[];
  actionIds: string[];
  taskIds: string[];
}

export interface ObsInvalidation {
  id: string;
  sourceKey: string;
  reason: string;
  selfWrite: 'none' | 'verified' | 'mismatch';
  oldReceiptId: string;
  newReceiptId: string | null;
  createdAt: string;
  /** this mission's subset */
  affected: ObsAffected;
  capped: boolean;
}

export interface ObsIntent {
  id: string;
  taskId: string;
  attemptId: string;
  action: 'set_config' | 'flush_cache_namespace';
  /** key/value for set_config, namespace for a flush */
  target: { key: string; value: string | number | boolean | null };
  status: string;
  blockReason: string | null;
  failureReason: string | null;
  expectedTargetVersion: number;
  idempotencyKey: string;
  payloadHash: string;
  proposedAt: string;
  admittedAt: string | null;
  committedAt: string | null;
  verifiedAt: string | null;
}

export interface ObsCheckedEntry {
  sourceKey: string;
  recordedRevision: number;
  liveRevision: number;
  receiptStatus: string;
  freshnessOk: boolean;
}

export interface ObsAuthorization {
  actionId: string;
  stage: 'admission' | 'commit' | 'dispatch';
  decision: string;
  blockReason: string | null;
  decidedAt: string;
  checkedVector: ObsCheckedEntry[];
  authorFenceValid: boolean;
  dispatchFenceValid: boolean | null;
}

export interface ObsResult {
  actionId: string;
  outcome: string;
  scriptResult: string | null;
}

/** One row of the version authority's history (checkout.config_versions). */
export interface ObsConfigRow {
  key: string;
  version: number;
  /** null for a delete */
  value: string | number | boolean | null;
  causedByActionId: string | null;
  /** 'injector' | 'seed' | 'owner' | 'action' (verifier role only) */
  actor: string;
  at: string;
}

export interface ObsTelemetry {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** null = no provider reported it (not 0) */
  cachedTokens: number | null;
  retries: number;
  errors: number;
  /** model calls whose recorded provider differs from the configured host, or fixture-mode */
  providerMismatches: number;
  fixtureCalls: number;
}

export interface ObsTiming {
  /** mission start -> first model request started */
  setupMs: number | null;
  /** sum of inference attempt durations (inference-seconds, not wall time) */
  inferenceMs: number | null;
  /** sum of tool span durations */
  toolMs: number | null;
  /** conflict detected -> recovered, from the mission timing marks */
  recoveryMs: number | null;
  /** mission start -> end */
  completionMs: number | null;
}

export interface ObsIndependentCheck {
  /** a fresh probe run by the harness after the mission ended */
  probe: 'pass' | 'fail' | 'unavailable';
  failedInvariants: string[];
  healthOk: boolean | null;
}

/** What the database says the mission actually ran under (not what was requested). */
export interface ObsArm {
  /** coordinator.missions.recovery_scope_rule */
  recoveryScopeRule: string | null;
  /** distinct context layouts of the mission's recorded model calls */
  contextLayouts: string[];
}

export interface Observations {
  missionId: string;
  missionStatus: string;
  startedAt: string;
  endedAt: string | null;
  tasks: ObsTask[];
  attempts: ObsAttempt[];
  nodes: ObsNode[];
  edges: ObsEdge[];
  invalidations: ObsInvalidation[];
  intents: ObsIntent[];
  authorizations: ObsAuthorization[];
  results: ObsResult[];
  configHistory: ObsConfigRow[];
  telemetry: ObsTelemetry;
  timing: ObsTiming;
  independent: ObsIndependentCheck;
  arm: ObsArm;
}
