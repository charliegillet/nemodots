// Hand-written valid sample objects for the contract schemas. Ids are fixed
// UUIDv4 literals so digests are reproducible.
import { digest } from '../../../src/server/nemodots/contracts/index.js';

export const ids = {
  mission: '6f1c1f9e-3c39-4a0c-9d37-6a3f0d0a1001',
  mission2: '6f1c1f9e-3c39-4a0c-9d37-6a3f0d0a1002',
  task: '0b7e2d64-5f1a-4c3e-8a6b-1c2d3e4f2001',
  task2: '0b7e2d64-5f1a-4c3e-8a6b-1c2d3e4f2002',
  attempt: '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b3001',
  attempt2: '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b3002',
  attempt3: '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b3003',
  receipt: 'c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d4001',
  receipt2: 'c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d4002',
  modelCall: 'd4c3b2a1-0f9e-4d8c-a7b6-5a4b3c2d5001',
  snapshot: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f6001',
  output: 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a7001',
  action: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b8001',
  action2: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b8002',
  authorization: 'b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c9001',
  result: 'c9d0e1f2-a3b4-4c5d-8e6f-7a8b9c0d0001',
  finding: 'd0e1f2a3-b4c5-4d6e-9f7a-8b9c0d1e1001',
  recovery: 'e1f2a3b4-c5d6-4e7f-8a8b-9c0d1e2f2001',
  edge: 'f2a3b4c5-d6e7-4f8a-9b9c-0d1e2f3a3001',
} as const;

export const T0 = '2026-10-17T18:00:00.000Z';
export const T1 = '2026-10-17T18:00:05.000Z';
export const D = digest('fixture');
export const invalidationId = digest(['fixture-invalidation']);

export const scope = () => ({
  ownerId: 'owner',
  missionId: ids.mission,
  spaceId: null,
  environment: 'test',
  resource: 'checkout',
});

export const vector = () => [
  {
    sourceKey: 'checkout.config/cache.namespace',
    sourceRevision: 3,
    receiptId: ids.receipt,
  },
  { sourceKey: 'checkout.health', sourceRevision: 7, receiptId: ids.receipt2 },
];

export const receipt = () => ({
  id: ids.receipt,
  source: {
    key: 'checkout.config/cache.namespace',
    sourceType: 'controlled_config',
    authority: 'controlled',
    scope: scope(),
  },
  sourceRevision: 3,
  collectionRevision: 1,
  observedAt: T0,
  lastConfirmedAt: T1,
  contentDigest: D,
  normalizedValue: { key: 'cache.namespace', value: 'orders-a', version: 3 },
  rawRef: null,
  status: 'supported',
  statusVersion: 0,
  supersedes: null,
  supersededBy: null,
  trust: 'controlled_authority',
  provenance: {
    kind: 'watcher',
    toolCallId: null,
    modelCallId: null,
    attemptId: null,
    causedByActionId: null,
    selfWrite: 'none',
  },
  negative: null,
  expiresAt: null,
});

export const collectionReceipt = () => ({
  ...receipt(),
  source: {
    key: 'checkout.config',
    sourceType: 'controlled_collection',
    authority: 'controlled',
    scope: scope(),
  },
  collectionRevision: null,
  normalizedValue: {
    keys: ['cache.namespace', 'db.pool_max'],
    collectionVersion: 1,
  },
});

export const confirmation = () => ({
  receiptId: ids.receipt,
  confirmedAt: T1,
  provenance: { kind: 'watcher', attemptId: null, modelCallId: null },
});

export const receiptTransition = () => ({
  receiptId: ids.receipt,
  from: 'supported',
  to: 'superseded',
  reason: 'newer_observation',
  at: T1,
  eventId: '42',
});

export const usage = () => ({
  promptTokens: 1200,
  completionTokens: 80,
  cachedTokens: null,
  reasoningTokens: null,
});

export const inferenceAttempt = () => ({
  n: 1,
  startedAt: T0,
  headersAt: T0,
  firstContentAt: T0,
  finishedAt: T1,
  httpStatus: 200,
  usage: usage(),
  finishReason: 'tool_calls',
  error: null,
  retryAfterMs: null,
  streamed: true,
  outcome: 'recorded',
});

export const contextSnapshot = () => ({
  id: ids.snapshot,
  contextSchemaVersion: 'v1',
  layout: 'cache_aware',
  prefixDigest: D,
  prefixLength: 100,
  contextDigest: D,
  contextLength: 400,
  toolSchemaHash: D,
  injected: {
    receipts: [
      {
        id: ids.receipt,
        sourceKey: 'checkout.config/cache.namespace',
        sourceRevision: 3,
        contentDigest: D,
      },
    ],
    inheritedArtifacts: [
      {
        kind: 'handoff',
        id: ids.output,
        digest: D,
        dependencyReceiptIds: [ids.receipt2],
      },
    ],
    runbooks: [{ id: 'cache-recovery', digest: D }],
    pageSnapshots: [],
    memories: [],
    invalidationEvents: [invalidationId],
    historyItems: [
      { role: 'tool', digest: D, dependencyReceiptIds: [ids.receipt] },
    ],
  },
  dependencyVector: vector(),
  volatile: { nowIso: T0 },
});

export const modelCall = () => ({
  id: ids.modelCall,
  scope: scope(),
  taskId: ids.task,
  attemptId: ids.attempt,
  role: 'worker',
  model: {
    requested: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    returned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  },
  provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
  contextSnapshotId: ids.snapshot,
  attempts: [inferenceAttempt()],
  outcome: 'tool_calls',
  outputDigest: D,
  outputDependencyVector: vector(),
  toolCalls: [
    { toolCallId: 'call_1', name: 'propose_action', argumentsDigest: D },
  ],
  createdAt: T1,
});

export const mission = () => ({
  id: ids.mission,
  scope: scope(),
  goal: 'Restore checkout',
  constraints: ['no data loss'],
  mode: 'live',
  status: 'running',
  transitionVersion: 2,
  generation: 0,
  budgets: {
    maxTasks: 24,
    maxDepth: 3,
    maxBreadth: 4,
    maxTokens: 400000,
    maxInferenceCalls: 120,
    maxWallClockMs: 900000,
  },
  admission: { minAgeMs: 3000 },
  provider: {
    host: 'api.inference.crusoecloud.com',
    plannerModel: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    workerModel: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  },
  acceptanceReceiptId: null,
  failureReason: null,
  cancellation: null,
  createdAt: T0,
  startedAt: T0,
  finishedAt: null,
});

export const task = () => ({
  id: ids.task,
  missionId: ids.mission,
  parentId: null,
  depth: 0,
  ordinal: 0,
  title: 'Investigate checkout errors',
  question: 'Why do orders fail?',
  role: 'investigator',
  capabilities: ['observe', 'delegate', 'publish_finding'],
  status: 'running',
  transitionVersion: 3,
  generation: 0,
  prerequisites: [],
  fenceSeq: 1,
  attemptCount: 1,
  maxAttempts: 3,
  budget: { maxIterations: 12, maxTokens: 60000, maxChildren: 4 },
  outputId: null,
  createdByModelCallId: ids.modelCall,
  justification: null,
  createdAt: T0,
  finishedAt: null,
});

export const lease = () => ({
  owner: 'worker-1',
  fencingToken: 1,
  expiresAt: T1,
  renewedAt: T0,
});

export const attempt = () => ({
  id: ids.attempt,
  taskId: ids.task,
  missionId: ids.mission,
  n: 1,
  kind: 'initial',
  status: 'running',
  generation: 0,
  lease: lease(),
  readSetReceiptIds: [ids.receipt],
  modelCallIds: [ids.modelCall],
  inheritedDependencyVector: [],
  repairOf: null,
  abortReason: null,
  startedAt: T0,
  finishedAt: null,
});

export const taskOutput = () => ({
  id: ids.output,
  taskId: ids.task,
  attemptId: ids.attempt,
  kind: 'handoff',
  content: { summary: 'namespace stale' },
  digest: D,
  dependencyVector: vector(),
  usable: true,
  unusableReason: null,
  publishedAt: T1,
});

export const edge = () => ({
  id: ids.edge,
  missionId: ids.mission,
  kind: 'evidence',
  from: { kind: 'receipt', id: ids.receipt },
  to: { kind: 'model_call', id: ids.modelCall },
  createdAt: T1,
});

export const plan = () => ({
  tasks: [
    {
      title: 'Check cache',
      question: 'Is the cache namespace stale?',
      role: 'investigator',
      capabilities: ['observe', 'delegate'],
      dependsOn: [],
    },
    {
      title: 'Check database',
      question: 'Is the pool starved?',
      role: 'investigator',
      capabilities: ['observe'],
      dependsOn: [0],
    },
  ],
});

export const intent = () => ({
  id: ids.action,
  missionId: ids.mission,
  taskId: ids.task,
  attemptId: ids.attempt,
  modelCallId: ids.modelCall,
  toolCallId: 'call_1',
  authorFencingToken: 1,
  generation: 0,
  action: 'set_config',
  adapter: 'checkout_config',
  payload: {
    key: 'cache.namespace',
    value: 'orders-b',
    expectedCurrentValueDigest: D,
  },
  payloadHash: D,
  target: {
    resource: 'checkout',
    sourceKey: 'checkout.config/cache.namespace',
    environment: 'test',
  },
  actorCapability: 'propose_config_change',
  dependencyVector: vector(),
  requiredSources: ['checkout.config/cache.namespace', 'checkout.health'],
  expectedTargetVersion: 3,
  policyVersion: 'policy-v1',
  idempotencyKey: D,
  expiresAt: T1,
  rationale: 'namespace points at stale blobs',
  status: 'proposed',
  statusVersion: 0,
  blockReason: null,
  blockDetail: null,
  failureReason: null,
  dispatch: null,
  proposedAt: T0,
  admittedAt: null,
  committedAt: null,
  dispatchedAt: null,
  verifiedAt: null,
  failedAt: null,
});

export const checkedVector = () => [
  {
    sourceKey: 'checkout.health',
    recordedRevision: 7,
    liveRevision: 7,
    receiptStatus: 'supported',
    lastConfirmedAt: T1,
    freshnessOk: true,
  },
];

export const authorization = () => ({
  id: ids.authorization,
  actionId: ids.action,
  stage: 'admission',
  decidedAt: T1,
  decision: 'admitted',
  blockReason: null,
  checkedVector: checkedVector(),
  targetVersion: { expected: 3, live: 3 },
  authorFence: { token: 1, valid: true },
  dispatchFence: { token: 5, valid: true },
  policyVersion: 'policy-v1',
  idempotencyBinding: 'new',
});

export const resultReceipt = () => ({
  id: ids.result,
  actionId: ids.action,
  idempotencyKey: D,
  payloadHash: D,
  outcome: 'dispatched',
  controlPlane: null,
  externalEffect: {
    attemptedAt: T0,
    acknowledgedAt: T1,
    scriptResult: 'applied',
    deletedCount: 12,
    markerPresent: true,
    fenceBefore: 2,
    fenceAfter: 3,
  },
  postcondition: {
    kind: 'observation',
    receiptId: ids.receipt2,
    configVersion: null,
  },
  recordedAt: T1,
});

export const finding = () => ({
  id: ids.finding,
  missionId: ids.mission,
  taskId: ids.task,
  attemptId: ids.attempt,
  claim: 'The cache namespace is stale.',
  supportingReceiptIds: [ids.receipt],
  confidence: 'medium',
  trust: 'model_claim',
  usable: true,
  dependencyVector: vector(),
  createdAt: T1,
});

export const affected = () => ({
  modelCallIds: [ids.modelCall],
  attemptIds: [ids.attempt],
  outputIds: [],
  actionIds: [ids.action],
  taskIds: [ids.task],
});

export const invalidation = () => ({
  id: invalidationId,
  missionIds: [ids.mission],
  sourceKey: 'checkout.config/cache.namespace',
  oldReceiptId: ids.receipt,
  newReceiptId: ids.receipt2,
  reason: 'newer_observation',
  selfWrite: 'none',
  graphVersion: 9,
  affected: affected(),
  perMission: [
    {
      missionId: ids.mission,
      affected: affected(),
      preserved: { taskIds: [ids.task2] },
    },
  ],
  closure: { depth: 2, nodes: 4, capped: false },
  resolvedAt: null,
  createdAt: T1,
});

export const recovery = () => ({
  id: ids.recovery,
  invalidationEventId: invalidationId,
  missionId: ids.mission,
  kind: 'repair_scheduled',
  taskId: ids.task,
  attemptId: ids.attempt,
  newAttemptId: ids.attempt2,
  actionId: null,
  detail: 'repair with fresh reads',
  createdAt: T1,
});

export const telemetry = () => ({
  calls: 3,
  orphanedCalls: 0,
  tokens: {
    prompt: 3000,
    completion: 200,
    cached: { available: false, total: null },
  },
  byModel: [
    {
      model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      calls: 3,
      promptTokens: 3000,
      completionTokens: 200,
      cachedTokens: null,
    },
  ],
  byRole: [
    { role: 'worker', calls: 3, promptTokens: 3000, completionTokens: 200 },
  ],
  retries: 0,
  errors: 0,
  ttftMs: { p50: 420, p95: 900 },
  prefixGroups: [{ prefixDigest: D, calls: 3 }],
});

export const health = () => ({
  mode: 'live',
  provider: {
    reachable: true,
    modelListed: true,
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    host: 'api.inference.crusoecloud.com',
    checkedAt: T0,
  },
  postgres: 'ok',
  redis: 'ok',
  checkout: { reachable: true, status: 'ok' },
  intelligence: 'configured',
  missingEnv: [],
  incidentDotIds: 0,
});

export const snapshotDto = () => ({
  mission: mission(),
  tasks: [task()],
  attempts: [attempt()],
  outputs: [taskOutput()],
  findings: [finding()],
  receipts: [receipt()],
  confirmations: [confirmation()],
  actions: [intent()],
  authorizations: [authorization()],
  results: [resultReceipt()],
  invalidations: [invalidation()],
  recoveries: [recovery()],
  probe: null,
  telemetry: telemetry(),
  lastEventId: 17,
});

/** One valid payload per EventKind. */
export const eventPayloads = (): Record<string, Record<string, unknown>> => ({
  'mission.created': { kind: 'mission.created', mission: mission() },
  'mission.status': {
    kind: 'mission.status',
    from: 'created',
    to: 'running',
    reason: null,
  },
  'task.created': {
    kind: 'task.created',
    task: {
      id: ids.task,
      parentId: null,
      depth: 0,
      title: 'Investigate',
      role: 'investigator',
      capabilities: ['observe'],
      prerequisites: [],
      justification: null,
      createdByModelCallId: ids.modelCall,
    },
  },
  'task.status': {
    kind: 'task.status',
    taskId: ids.task,
    from: 'runnable',
    to: 'leased',
    reason: null,
  },
  'attempt.started': {
    kind: 'attempt.started',
    attemptId: ids.attempt2,
    taskId: ids.task,
    n: 2,
    attemptKind: 'repair',
    repairOf: { attemptId: ids.attempt, invalidationEventId: invalidationId },
    inheritedVectorSize: 2,
  },
  'attempt.finished': {
    kind: 'attempt.finished',
    attemptId: ids.attempt,
    taskId: ids.task,
    status: 'published',
    readSetReceiptIds: [ids.receipt],
    modelCallCount: 2,
  },
  'attempt.aborted': {
    kind: 'attempt.aborted',
    attemptId: ids.attempt,
    taskId: ids.task,
    abortReason: 'readset_invalidated',
  },
  'model_call.recorded': {
    kind: 'model_call.recorded',
    modelCallId: ids.modelCall,
    attemptId: ids.attempt,
    taskId: ids.task,
    role: 'worker',
    model: { requested: 'm', returned: null },
    provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
    outcome: 'completed',
    prefixDigest: D,
    contextDigest: D,
    usage: usage(),
    attempts: 1,
    dependencyVectorSize: 2,
  },
  'tool_call.recorded': {
    kind: 'tool_call.recorded',
    attemptId: ids.attempt,
    toolCallId: 'call_1',
    name: 'observe_source',
    durationMs: 12,
    ok: true,
    receiptId: ids.receipt,
  },
  'receipt.registered': {
    kind: 'receipt.registered',
    receiptId: ids.receipt2,
    sourceKey: 'checkout.health',
    sourceRevision: 8,
    supersedes: ids.receipt,
    trust: 'observed_tool',
    selfWrite: 'none',
    provenanceKind: 'watcher',
    contentDigest: D,
  },
  'receipt.confirmed': {
    kind: 'receipt.confirmed',
    receiptId: ids.receipt,
    sourceKey: 'checkout.health',
    confirmedAt: T1,
  },
  'receipt.transition': {
    kind: 'receipt.transition',
    receiptId: ids.receipt,
    from: 'supported',
    to: 'superseded',
    reason: 'newer_observation',
  },
  'finding.published': {
    kind: 'finding.published',
    findingId: ids.finding,
    taskId: ids.task,
    attemptId: ids.attempt,
    claim: 'stale namespace',
    confidence: 'high',
    supportingReceiptIds: [ids.receipt],
  },
  'output.published': {
    kind: 'output.published',
    outputId: ids.output,
    taskId: ids.task,
    attemptId: ids.attempt,
    outputKind: 'handoff',
    digest: D,
    dependencyVectorSize: 2,
  },
  'action.proposed': {
    kind: 'action.proposed',
    actionId: ids.action,
    taskId: ids.task,
    attemptId: ids.attempt,
    action: 'set_config',
    target: {
      resource: 'checkout',
      sourceKey: 'checkout.config/cache.namespace',
      environment: 'test',
    },
    payloadHash: D,
    expectedTargetVersion: 3,
    dependencyVector: vector(),
    requiredSources: ['checkout.config/cache.namespace', 'checkout.health'],
    admissionNotBefore: T1,
  },
  'action.decided': {
    kind: 'action.decided',
    actionId: ids.action,
    stage: 'commit',
    decision: 'blocked',
    blockReason: 'stale_version',
    blockDetail: 'cache.namespace advanced 3 -> 4',
    checkedVector: checkedVector(),
    targetVersion: { expected: 3, live: 4 },
    dispatchFence: { token: 5, valid: true },
  },
  'action.committed': {
    kind: 'action.committed',
    actionId: ids.action,
    targetVersionBefore: 3,
    targetVersionAfter: 4,
    causedByActionId: ids.action,
    afterDigest: D,
  },
  'action.dispatched': {
    kind: 'action.dispatched',
    actionId: ids.action,
    scriptResult: 'applied',
    deletedCount: 12,
  },
  'action.verified': {
    kind: 'action.verified',
    actionId: ids.action,
    postcondition: { kind: 'history', receiptId: null, configVersion: 4 },
  },
  'action.failed': {
    kind: 'action.failed',
    actionId: ids.action,
    failureReason: 'postcondition_mismatch',
    detail: null,
  },
  'action.outcome_unknown': {
    kind: 'action.outcome_unknown',
    actionId: ids.action,
    detail: 'redis timeout after effect',
  },
  'invalidation.recorded': {
    kind: 'invalidation.recorded',
    invalidationEventId: invalidationId,
    sourceKey: 'checkout.config/cache.namespace',
    oldReceiptId: ids.receipt,
    newReceiptId: ids.receipt2,
    reason: 'newer_observation',
    selfWrite: 'none',
    affected: affected(),
    preserved: { taskIds: [ids.task2] },
    closure: { depth: 2, nodes: 4, capped: false },
  },
  'invalidation.resolved': {
    kind: 'invalidation.resolved',
    invalidationEventId: invalidationId,
    resolvedAt: T1,
  },
  'recovery.recorded': { kind: 'recovery.recorded', recovery: recovery() },
  'probe.recorded': {
    kind: 'probe.recorded',
    receiptId: ids.receipt,
    verdict: 'pass',
    invariants: [{ name: 'inventory_decremented', ok: true }],
    healthSamples: 10,
    healthOk: 10,
  },
  'health.sampled': {
    kind: 'health.sampled',
    checkout: { status: 'degraded' },
    provider: { reachable: true },
    postgres: 'ok',
    redis: 'ok',
  },
  'telemetry.updated': { kind: 'telemetry.updated', summary: telemetry() },
  heartbeat: { kind: 'heartbeat' },
});
