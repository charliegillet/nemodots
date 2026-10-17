// Contract-shaped synthetic missions for the rendering rows ("fulfilled
// snapshot" rows). Every value is chosen here, in the test, and every object is
// parsed with the shared contract schemas, so the UI is tested against exactly
// the shapes the server may send but with known, independent expected values.
// These rows exercise the client only; the live rows exercise the product.
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import {
  MissionEventSchema,
  MissionSnapshotSchema,
  invalidationEventId,
  type MissionEvent,
  type MissionSnapshot,
  type MissionStatus,
  type TelemetrySummary,
} from '../../../../../src/server/nemodots/contracts/index.js';

export const sha = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const iso = (offsetSeconds: number) =>
  new Date(Date.UTC(2026, 9, 17, 12, 0, 0) + offsetSeconds * 1000).toISOString();

export interface ScenarioOptions {
  status?: MissionStatus;
  /** probe verdict; 'pass' is implied for a succeeded mission */
  probe?: 'pass' | 'fail' | null;
  telemetry?: 'unavailable' | 'available';
  /** a cancelled mission lists these committed effects */
  cancelledWithEffects?: boolean;
}

export const TITLES = {
  root: 'Diagnose checkout failures',
  cache: 'Inspect the cache namespace',
  verify: 'Verify the order flow',
  late: 'Late-arriving reconciliation task',
} as const;

export const JUSTIFICATION =
  'The cache keys need a specialist who may propose a namespace change.';
export const FAILURE_REASON =
  'Acceptance probe failed: the health_stays_ok invariant did not hold for 3 of 12 samples.';

export interface Scenario {
  snapshot: MissionSnapshot;
  /** events with ids 1..snapshot.lastEventId, in commit order */
  events: MissionEvent[];
  /** events with ids above the snapshot cursor, in commit order */
  late: MissionEvent[];
  ids: Record<string, string>;
  /** server-side recovery details in server order */
  recoveryDetails: string[];
  /** independently counted dependency edges */
  expectedEdges: { scheduling: number; evidence: number };
}

export function buildScenario(options: ScenarioOptions = {}): Scenario {
  const status = options.status ?? 'running';
  const probeVerdict =
    status === 'succeeded' ? 'pass' : (options.probe ?? null);
  const missionId = randomUUID();
  const scope = () => ({
    ownerId: 'acc7-owner',
    missionId,
    spaceId: null,
    environment: 'dev',
    resource: 'checkout',
  });
  const id = () => randomUUID();
  const ids = {
    mission: missionId,
    t1: id(),
    t2: id(),
    t3: id(),
    t4: id(),
    a1: id(),
    a2: id(),
    a2r: id(),
    r1: id(),
    r2: id(),
    r3: id(),
    r4: id(),
    r5: id(),
    f1: id(),
    act1: id(),
    act2: id(),
    mc: id(),
  };
  const CACHE = 'checkout.config/cache.namespace';

  const receipt = (o: {
    id: string;
    key: string;
    type: string;
    authority: 'controlled' | 'observed';
    revision: number;
    status: string;
    trust: string;
    kind: string;
    at: number;
    supersedes?: string | null;
    supersededBy?: string | null;
    value?: unknown;
  }) => ({
    id: o.id,
    source: {
      key: o.key,
      sourceType: o.type,
      authority: o.authority,
      scope: scope(),
    },
    sourceRevision: o.revision,
    collectionRevision: null,
    observedAt: iso(o.at),
    lastConfirmedAt: iso(o.at + 5),
    contentDigest: sha(`content:${o.id}`),
    normalizedValue: o.value ?? { value: `${o.key}@${o.revision}` },
    rawRef: null,
    status: o.status,
    statusVersion: 1,
    supersedes: o.supersedes ?? null,
    supersededBy: o.supersededBy ?? null,
    trust: o.trust,
    provenance: {
      kind: o.kind,
      toolCallId: null,
      modelCallId: null,
      attemptId: null,
      causedByActionId: null,
      selfWrite: 'none',
    },
    negative: null,
    expiresAt: null,
  });

  const r1 = receipt({
    id: ids.r1,
    key: 'checkout.health',
    type: 'observed_endpoint',
    authority: 'observed',
    revision: 7,
    status: 'supported',
    trust: 'observed_tool',
    kind: 'tool_call',
    at: 20,
  });
  const r2 = receipt({
    id: ids.r2,
    key: CACHE,
    type: 'controlled_config',
    authority: 'controlled',
    revision: 31,
    status: 'superseded',
    trust: 'controlled_authority',
    kind: 'watcher',
    at: 30,
    supersededBy: ids.r3,
  });
  const r3 = receipt({
    id: ids.r3,
    key: CACHE,
    type: 'controlled_config',
    authority: 'controlled',
    revision: 32,
    status: 'supported',
    trust: 'controlled_authority',
    kind: 'watcher',
    at: 60,
    supersedes: ids.r2,
  });
  const r4 = receipt({
    id: ids.r4,
    key: 'checkout.acceptance',
    type: 'probe',
    authority: 'observed',
    revision: 5,
    status: 'supported',
    trust: 'probe',
    kind: 'probe',
    at: 200,
    value: { verdict: probeVerdict ?? 'pass' },
  });
  const receipts = [r1, r2, r3, ...(probeVerdict ? [r4] : [])];

  const task = (o: {
    id: string;
    parent: string | null;
    title: string;
    role: string;
    caps: string[];
    status: string;
    prereq?: string[];
    just?: string | null;
    at: number;
  }) => ({
    id: o.id,
    missionId,
    parentId: o.parent,
    depth: o.parent ? 1 : 0,
    ordinal: 0,
    title: o.title,
    question: `Question for ${o.title}`,
    role: o.role,
    capabilities: o.caps,
    status: o.status,
    transitionVersion: 1,
    generation: 0,
    prerequisites: o.prereq ?? [],
    fenceSeq: 1,
    attemptCount: 1,
    maxAttempts: 3,
    budget: { maxIterations: 6, maxTokens: 20000, maxChildren: 3 },
    outputId: null,
    createdByModelCallId: null,
    justification: o.just ?? null,
    createdAt: iso(o.at),
    finishedAt: null,
  });
  const tasks = [
    task({
      id: ids.t1,
      parent: null,
      title: TITLES.root,
      role: 'investigator',
      caps: ['observe', 'delegate', 'publish_finding'],
      status: 'succeeded',
      at: 10,
    }),
    task({
      id: ids.t2,
      parent: ids.t1,
      title: TITLES.cache,
      role: 'cache_specialist',
      caps: ['observe', 'publish_finding', 'propose_config_change'],
      status: 'repairing',
      just: JUSTIFICATION,
      at: 12,
    }),
    task({
      id: ids.t3,
      parent: ids.t1,
      title: TITLES.verify,
      role: 'verifier',
      caps: ['observe', 'publish_finding'],
      status: 'waiting',
      prereq: [ids.t1, ids.t2],
      just: 'An independent check must confirm a fresh order succeeds.',
      at: 14,
    }),
  ];

  const lease = (at: number) => ({
    owner: 'worker-1',
    fencingToken: 1,
    expiresAt: iso(at + 60),
    renewedAt: iso(at),
  });
  const attempt = (o: {
    id: string;
    taskId: string;
    n: number;
    kind: string;
    status: string;
    readSet: string[];
    repairOf?: unknown;
    abort?: string | null;
    at: number;
  }) => ({
    id: o.id,
    taskId: o.taskId,
    missionId,
    n: o.n,
    kind: o.kind,
    status: o.status,
    generation: 0,
    lease: lease(o.at),
    readSetReceiptIds: o.readSet,
    modelCallIds: [],
    inheritedDependencyVector: [],
    repairOf: o.repairOf ?? null,
    abortReason: o.abort ?? null,
    startedAt: iso(o.at),
    finishedAt: o.status === 'running' ? null : iso(o.at + 20),
  });

  const entry = (key: string, revision: number, receiptId: string) => ({
    sourceKey: key,
    sourceRevision: revision,
    receiptId,
  });
  const inv = invalidationEventId(
    CACHE as never,
    ids.r2 as never,
    ids.r3 as never,
    'newer_observation',
  );
  const attempts = [
    attempt({
      id: ids.a1,
      taskId: ids.t1,
      n: 1,
      kind: 'initial',
      status: 'published',
      readSet: [ids.r1],
      at: 18,
    }),
    attempt({
      id: ids.a2,
      taskId: ids.t2,
      n: 1,
      kind: 'initial',
      status: 'aborted',
      readSet: [ids.r2],
      abort: 'readset_invalidated',
      at: 40,
    }),
    attempt({
      id: ids.a2r,
      taskId: ids.t2,
      n: 2,
      kind: 'repair',
      status: 'running',
      readSet: [ids.r3],
      repairOf: { attemptId: ids.a2, invalidationEventId: inv },
      at: 70,
    }),
  ];

  const finding = {
    id: ids.f1,
    missionId,
    taskId: ids.t2,
    attemptId: ids.a2r,
    claim: 'The cache namespace was changed while the repair was in flight.',
    supportingReceiptIds: [ids.r3],
    confidence: 'medium',
    trust: 'model_claim',
    usable: true,
    dependencyVector: [entry(CACHE, 32, ids.r3)],
    createdAt: iso(120),
  };

  const intent = (o: {
    id: string;
    key: 'cache.namespace' | 'db.pool_max';
    value: string | number;
    status: string;
    vector: unknown[];
    blockReason?: string | null;
    blockDetail?: string | null;
    hashSeed: string;
    expectedVersion: number;
    dispatch: boolean;
    at: number;
  }) => ({
    id: o.id,
    missionId,
    taskId: ids.t2,
    attemptId: ids.a2r,
    modelCallId: ids.mc,
    toolCallId: `call-${o.hashSeed}`,
    authorFencingToken: 3,
    generation: 0,
    action: 'set_config',
    adapter: 'checkout_config',
    payload: {
      key: o.key,
      value: o.value,
      expectedCurrentValueDigest: sha(`current:${o.hashSeed}`),
    },
    payloadHash: sha(`payload:${o.hashSeed}`),
    target: {
      resource: 'checkout',
      sourceKey: `checkout.config/${o.key}`,
      environment: 'dev',
    },
    actorCapability: 'propose_config_change',
    dependencyVector: o.vector,
    requiredSources: [CACHE],
    expectedTargetVersion: o.expectedVersion,
    policyVersion: 'policy-v1',
    idempotencyKey: sha(`idem:${o.hashSeed}`),
    expiresAt: iso(o.at + 600),
    rationale: `Rationale ${o.hashSeed}`,
    status: o.status,
    statusVersion: 1,
    blockReason: o.blockReason ?? null,
    blockDetail: o.blockDetail ?? null,
    failureReason: null,
    dispatch: o.dispatch
      ? { fence: 17, owner: 'dispatcher-1', leaseExpiresAt: iso(o.at + 120) }
      : null,
    proposedAt: iso(o.at),
    admittedAt: o.dispatch ? iso(o.at + 1) : null,
    committedAt: o.dispatch ? iso(o.at + 2) : null,
    dispatchedAt: o.dispatch ? iso(o.at + 3) : null,
    verifiedAt: o.status === 'verified' ? iso(o.at + 4) : null,
    failedAt: null,
  });
  const act1 = intent({
    id: ids.act1,
    key: 'cache.namespace',
    value: 'checkout-v2',
    status: 'verified',
    vector: [entry(CACHE, 32, ids.r3), entry('checkout.health', 7, ids.r1)],
    hashSeed: 'one',
    expectedVersion: 41,
    dispatch: true,
    at: 80,
  });
  const act2 = intent({
    id: ids.act2,
    key: 'db.pool_max',
    value: 40,
    status: 'blocked',
    vector: [entry(CACHE, 31, ids.r2)],
    blockReason: 'stale_version',
    blockDetail:
      'The receipt for checkout.config/cache.namespace revision 31 is superseded by revision 32.',
    hashSeed: 'two',
    expectedVersion: 41,
    dispatch: false,
    at: 100,
  });

  const checked = (
    rec: number,
    live: number,
    receiptStatus: string,
    ok: boolean,
    key = CACHE,
  ) => ({
    sourceKey: key,
    recordedRevision: rec,
    liveRevision: live,
    receiptStatus,
    lastConfirmedAt: iso(85),
    freshnessOk: ok,
  });
  const auth = (o: {
    action: string;
    stage: 'admission' | 'commit' | 'dispatch';
    decision: string;
    block?: string | null;
    expected: number;
    live: number;
    vector: unknown[];
    fence?: number | null;
    at: number;
  }) => ({
    id: id(),
    actionId: o.action,
    stage: o.stage,
    decidedAt: iso(o.at),
    decision: o.decision,
    blockReason: o.block ?? null,
    checkedVector: o.vector,
    targetVersion: { expected: o.expected, live: o.live },
    authorFence: { token: 3, valid: true },
    dispatchFence:
      o.fence === null || o.fence === undefined
        ? null
        : { token: o.fence, valid: true },
    policyVersion: 'policy-v1',
    idempotencyBinding: 'new',
  });
  const vec1 = [
    checked(32, 32, 'supported', true),
    checked(7, 7, 'supported', true, 'checkout.health'),
  ];
  const authorizations = [
    auth({
      action: ids.act1,
      stage: 'admission',
      decision: 'admitted',
      expected: 41,
      live: 41,
      vector: vec1,
      at: 81,
    }),
    auth({
      action: ids.act1,
      stage: 'commit',
      decision: 'committed',
      expected: 41,
      live: 41,
      vector: vec1,
      at: 82,
    }),
    auth({
      action: ids.act1,
      stage: 'dispatch',
      decision: 'dispatched',
      expected: 42,
      live: 42,
      vector: vec1,
      fence: 17,
      at: 83,
    }),
    auth({
      action: ids.act2,
      stage: 'admission',
      decision: 'blocked',
      block: 'stale_version',
      expected: 41,
      live: 43,
      vector: [checked(31, 32, 'superseded', false)],
      at: 101,
    }),
  ];
  const results = [
    {
      id: id(),
      actionId: ids.act1,
      idempotencyKey: sha('idem:one'),
      payloadHash: sha('payload:one'),
      outcome: 'verified',
      controlPlane: {
        targetVersionBefore: 41,
        targetVersionAfter: 42,
        causedByActionId: ids.act1,
        beforeDigest: sha('before'),
        afterDigest: sha('after'),
      },
      externalEffect: {
        attemptedAt: iso(83),
        acknowledgedAt: iso(84),
        scriptResult: 'applied',
        deletedCount: 12,
        markerPresent: true,
        fenceBefore: 16,
        fenceAfter: 17,
      },
      postcondition: { kind: 'history', receiptId: ids.r3, configVersion: 42 },
      recordedAt: iso(85),
    },
  ];

  const recoveryDetails = [
    'rec-1 repair scheduled for the cache branch',
    'rec-2 stale pool write blocked',
    'rec-3 second stale write blocked',
    'rec-4 verification branch preserved',
    'rec-5 invalidation resolved by the repair',
  ];
  const recovery = (
    n: number,
    kind: string,
    extra: Record<string, unknown>,
    at: number,
  ) => ({
    id: id(),
    invalidationEventId: inv,
    missionId,
    kind,
    taskId: null,
    attemptId: null,
    newAttemptId: null,
    actionId: null,
    detail: recoveryDetails[n - 1],
    createdAt: iso(at),
    ...extra,
  });
  const recoveries = [
    recovery(
      1,
      'repair_scheduled',
      { taskId: ids.t2, attemptId: ids.a2, newAttemptId: ids.a2r },
      65,
    ),
    recovery(2, 'intent_blocked', { actionId: ids.act2 }, 102),
    recovery(3, 'intent_blocked', { actionId: ids.act2 }, 103),
    recovery(4, 'branch_preserved', { taskId: ids.t3 }, 104),
    recovery(5, 'invalidation_resolved', {}, 150),
  ];
  const affected = {
    modelCallIds: [],
    attemptIds: [ids.a2],
    outputIds: [],
    actionIds: [ids.act2],
    taskIds: [ids.t2],
  };
  const invalidation = {
    id: inv,
    missionIds: [missionId],
    sourceKey: CACHE,
    oldReceiptId: ids.r2,
    newReceiptId: ids.r3,
    reason: 'newer_observation',
    selfWrite: 'none',
    graphVersion: 5,
    affected,
    perMission: [
      { missionId, affected, preserved: { taskIds: [ids.t3] } },
    ],
    closure: { depth: 2, nodes: 5, capped: false },
    resolvedAt: iso(150),
    createdAt: iso(62),
  };

  const telemetry: TelemetrySummary =
    options.telemetry === 'available'
      ? {
          calls: 14,
          orphanedCalls: 1,
          tokens: {
            prompt: 12840,
            completion: 3150,
            cached: { available: true, total: 9000 },
          },
          byModel: [
            {
              model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
              calls: 14,
              promptTokens: 12840,
              completionTokens: 3150,
              cachedTokens: 9000,
            },
          ],
          byRole: [
            { role: 'worker', calls: 14, promptTokens: 12840, completionTokens: 3150 },
          ],
          retries: 2,
          errors: 1,
          ttftMs: { p50: 412, p95: 1180 },
          prefixGroups: [],
        }
      : {
          calls: 14,
          orphanedCalls: 1,
          tokens: {
            prompt: 12840,
            completion: 3150,
            cached: { available: false, total: null },
          },
          byModel: [
            {
              model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
              calls: 14,
              promptTokens: 12840,
              completionTokens: 3150,
              cachedTokens: null,
            },
          ],
          byRole: [
            { role: 'worker', calls: 14, promptTokens: 12840, completionTokens: 3150 },
          ],
          retries: 2,
          errors: 1,
          ttftMs: null,
          prefixGroups: [],
        };

  // ---- events (ids in commit order)
  let next = 0;
  const make = (kind: string, payload: Record<string, unknown>, at: number) =>
    MissionEventSchema.parse({
      id: (next += 1),
      missionId,
      kind,
      at: iso(at),
      payload: { kind, ...payload },
    });
  const mission = {
    id: missionId,
    scope: scope(),
    goal: 'Investigate the checkout service and restore normal operation.',
    constraints: [],
    mode: 'fixture',
    status,
    transitionVersion: 4,
    generation: 0,
    budgets: {
      maxTasks: 12,
      maxDepth: 3,
      maxBreadth: 4,
      maxTokens: 200000,
      maxInferenceCalls: 60,
      maxWallClockMs: 900000,
    },
    admission: { minAgeMs: 0 },
    provider: {
      host: 'api.inference.crusoecloud.com',
      plannerModel: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      workerModel: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    },
    acceptanceReceiptId: status === 'succeeded' ? ids.r4 : null,
    failureReason: status === 'failed' ? FAILURE_REASON : null,
    cancellation:
      status === 'cancelled'
        ? {
            requestedAt: iso(160),
            abortedAttemptIds: [ids.a2r],
            cancelledIntentIds: [ids.act2],
            committedEffects: options.cancelledWithEffects ? [ids.act1] : [],
          }
        : null,
    createdAt: iso(0),
    startedAt: iso(5),
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status)
      ? iso(210)
      : null,
  };
  const taskPick = (t: ReturnType<typeof task>) => ({
    id: t.id,
    parentId: t.parentId,
    depth: t.depth,
    title: t.title,
    role: t.role,
    capabilities: t.capabilities,
    prerequisites: t.prerequisites,
    justification: t.justification,
    createdByModelCallId: null,
  });
  const dv = (rows: ReturnType<typeof entry>[]) => rows;
  const events: MissionEvent[] = [
    make('mission.created', { mission }, 0),
    make('mission.status', { from: 'created', to: 'running', reason: null }, 5),
    ...tasks.map((t) => make('task.created', { task: taskPick(t) }, t.depth + 10)),
    make(
      'receipt.registered',
      {
        receiptId: ids.r3,
        sourceKey: CACHE,
        sourceRevision: 32,
        supersedes: ids.r2,
        trust: 'controlled_authority',
        selfWrite: 'none',
        provenanceKind: 'watcher',
        contentDigest: r3.contentDigest,
      },
      60,
    ),
    make(
      'invalidation.recorded',
      {
        invalidationEventId: inv,
        sourceKey: CACHE,
        oldReceiptId: ids.r2,
        newReceiptId: ids.r3,
        reason: 'newer_observation',
        selfWrite: 'none',
        affected,
        preserved: { taskIds: [ids.t3] },
        closure: { depth: 2, nodes: 5, capped: false },
      },
      62,
    ),
    make(
      'attempt.started',
      {
        attemptId: ids.a2r,
        taskId: ids.t2,
        n: 2,
        attemptKind: 'repair',
        repairOf: { attemptId: ids.a2, invalidationEventId: inv },
        inheritedVectorSize: 1,
      },
      64,
    ),
    make('recovery.recorded', { recovery: recoveries[0] }, 65),
    make(
      'action.proposed',
      {
        actionId: ids.act1,
        taskId: ids.t2,
        attemptId: ids.a2r,
        action: 'set_config',
        target: act1.target,
        payloadHash: act1.payloadHash,
        expectedTargetVersion: 41,
        dependencyVector: dv(act1.dependencyVector as never),
        requiredSources: [CACHE],
        admissionNotBefore: iso(80),
      },
      80,
    ),
    ...authorizations.slice(0, 3).map((a, i) =>
      make(
        'action.decided',
        {
          actionId: ids.act1,
          stage: a.stage,
          decision: a.decision,
          blockReason: null,
          blockDetail: null,
          checkedVector: a.checkedVector,
          targetVersion: a.targetVersion,
          dispatchFence: a.dispatchFence,
        },
        81 + i,
      ),
    ),
    make(
      'action.committed',
      {
        actionId: ids.act1,
        targetVersionBefore: 41,
        targetVersionAfter: 42,
        causedByActionId: ids.act1,
        afterDigest: sha('after'),
      },
      82,
    ),
    make(
      'action.dispatched',
      { actionId: ids.act1, scriptResult: 'applied', deletedCount: 12 },
      84,
    ),
    make(
      'action.verified',
      {
        actionId: ids.act1,
        postcondition: { kind: 'history', receiptId: ids.r3, configVersion: 42 },
      },
      85,
    ),
    make(
      'action.proposed',
      {
        actionId: ids.act2,
        taskId: ids.t2,
        attemptId: ids.a2r,
        action: 'set_config',
        target: act2.target,
        payloadHash: act2.payloadHash,
        expectedTargetVersion: 41,
        dependencyVector: dv(act2.dependencyVector as never),
        requiredSources: [CACHE],
        admissionNotBefore: iso(100),
      },
      100,
    ),
    make(
      'action.decided',
      {
        actionId: ids.act2,
        stage: 'admission',
        decision: 'blocked',
        blockReason: 'stale_version',
        blockDetail: act2.blockDetail,
        checkedVector: authorizations[3]!.checkedVector,
        targetVersion: { expected: 41, live: 43 },
        dispatchFence: null,
      },
      101,
    ),
    make('recovery.recorded', { recovery: recoveries[1] }, 102),
    make('recovery.recorded', { recovery: recoveries[2] }, 103),
    make('recovery.recorded', { recovery: recoveries[3] }, 104),
    make(
      'invalidation.resolved',
      { invalidationEventId: inv, resolvedAt: iso(150) },
      150,
    ),
    make('recovery.recorded', { recovery: recoveries[4] }, 151),
    make(
      'finding.published',
      {
        findingId: ids.f1,
        taskId: ids.t2,
        attemptId: ids.a2r,
        claim: finding.claim,
        confidence: 'medium',
        supportingReceiptIds: [ids.r3],
      },
      120,
    ),
  ];
  if (probeVerdict)
    events.push(
      make(
        'probe.recorded',
        {
          receiptId: ids.r4,
          verdict: probeVerdict,
          invariants: [
            { name: 'fresh_order_succeeds', ok: true },
            { name: 'inventory_consistent', ok: true },
            { name: 'health_stays_ok', ok: probeVerdict === 'pass' },
          ],
          healthSamples: 12,
          healthOk: probeVerdict === 'pass' ? 12 : 9,
        },
        200,
      ),
    );
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled')
    events.push(
      make(
        'mission.status',
        {
          from: 'running',
          to: status,
          reason: status === 'failed' ? FAILURE_REASON : null,
        },
        210,
      ),
    );
  const lastEventId = events.length;

  // ---- late events (ids above the snapshot cursor)
  const lateTask = task({
    id: ids.t4,
    parent: null,
    title: TITLES.late,
    role: 'investigator',
    caps: ['observe', 'publish_finding'],
    status: 'pending',
    at: 300,
  });
  const late = [
    make('task.created', { task: taskPick(lateTask) }, 300),
    make(
      'receipt.registered',
      {
        receiptId: ids.r5,
        sourceKey: 'checkout.metrics',
        sourceRevision: 9,
        supersedes: null,
        trust: 'observed_tool',
        selfWrite: 'none',
        provenanceKind: 'tool_call',
        contentDigest: sha('metrics'),
      },
      301,
    ),
    make(
      'recovery.recorded',
      {
        recovery: {
          id: id(),
          invalidationEventId: inv,
          missionId,
          kind: 'repair_coalesced',
          taskId: null,
          attemptId: null,
          newAttemptId: null,
          actionId: null,
          detail: 'rec-6 late recovery reported after the snapshot',
          createdAt: iso(302),
        },
      },
      302,
    ),
  ];

  const probeReceipt = probeVerdict ? r4 : null;
  const snapshot = MissionSnapshotSchema.parse({
    mission,
    tasks,
    attempts,
    outputs: [],
    findings: [finding],
    receipts,
    confirmations: [],
    actions: [act1, act2],
    authorizations,
    results,
    invalidations: [invalidation],
    recoveries,
    probe: probeReceipt,
    telemetry,
    lastEventId,
  });

  // Independent edge count: scheduling = sum of prerequisites; evidence =
  // distinct (receipt, task) read-set pairs plus (receipt, action) vector pairs.
  const evidencePairs = new Set<string>();
  for (const a of attempts)
    for (const r of a.readSetReceiptIds) evidencePairs.add(`${r}>${a.taskId}`);
  for (const act of [act1, act2])
    for (const e of act.dependencyVector as { receiptId: string }[])
      evidencePairs.add(`${e.receiptId}>${act.id}`);
  return {
    snapshot,
    events,
    late,
    ids,
    recoveryDetails,
    expectedEdges: {
      scheduling: tasks.reduce((n, t) => n + t.prerequisites.length, 0),
      evidence: evidencePairs.size,
    },
  };
}

export const frames = (list: readonly MissionEvent[]) =>
  list.map((e) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/**
 * Serves a synthetic mission to the page: the snapshot, the event stream and
 * the per-mission read routes. Install BEFORE navigating to the mission page.
 */
export async function serveScenario(
  page: Page,
  scenario: Scenario,
  options: {
    stream?: readonly MissionEvent[];
    snapshot?: unknown;
    telemetry?: TelemetrySummary;
  } = {},
) {
  const { snapshot } = scenario;
  const id = snapshot.mission.id;
  const json = (value: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
  const path = (suffix: string) =>
    new RegExp(`/api/nemodots/missions/${id}${suffix}(?:\\?.*)?$`);
  const telemetry = options.telemetry ?? snapshot.telemetry;
  await page.route(path(''), (route) =>
    route.request().method() === 'GET'
      ? route.fulfill(json(options.snapshot ?? snapshot))
      : route.continue(),
  );
  await page.route(path('/events'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: frames(options.stream ?? scenario.events) || ': idle\n\n',
    }),
  );
  await page.route(path('/tasks'), (r) => r.fulfill(json(snapshot.tasks)));
  await page.route(path('/evidence'), (r) =>
    r.fulfill(json(snapshot.receipts)),
  );
  await page.route(path('/actions'), (r) => r.fulfill(json(snapshot.actions)));
  await page.route(path('/recovery'), (r) =>
    r.fulfill(json(snapshot.recoveries)),
  );
  await page.route(path('/telemetry'), (r) => r.fulfill(json(telemetry)));
  await page.route(/\/api\/nemodots\/telemetry\/summary(?:\?.*)?$/, (r) =>
    r.fulfill(json(telemetry)),
  );
}

export const shortId = (value: string) => value.slice(0, 8);
