// Hand-written synthetic trial records used ONLY to test the scorer itself
// (deterministic, no system under test). A scorer that cannot reject bad
// records would make the live gate meaningless, so the self-tests mutate a
// known-good record one defect at a time.
import type { FrozenTrial } from './frozen.js';
import type { TrialRecord } from './record.js';
import { EXPECTED_UPSTREAM_HOST } from './scoring.js';

export const PROXY_HOST = '127.0.0.1:4722';

const id = (n: number, tag = 'a') =>
  `${tag}${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

export const SYNTHETIC_TRIAL: FrozenTrial = {
  trialId: 'synthetic-f5',
  seed: 1,
  steps: [
    {
      trigger: { kind: 'pre_start' },
      key: 'orders.write_enabled',
      value: false,
      actor: 'injector',
    },
  ],
  load: { readConcurrency: 2 },
  probe: { quantity: 1, windowMs: 20000 },
  expected: {
    allowedMutationKeys: ['orders.write_enabled'],
    flushAllowed: false,
    keyPredicates: [{ key: 'orders.write_enabled', equals: true }],
  },
};

const GOOD_ORDER_BODY = () => ({
  id: 'o1',
  status: 'confirmed',
  items: [{ sku: 'PROBE-SKU', quantity: 1 }],
});

const hashSnapshot = (rows: number) => ({
  hash: 'h'.repeat(64),
  perTable: Object.fromEntries(
    [
      'checkout.products',
      'checkout.inventory',
      'checkout.orders',
      'checkout.order_items',
    ].map((t) => [t, { rows, digest: `d-${t}` }]),
  ),
});

/** A repairable-fault trial the team resolved correctly. Every call returns a fresh copy. */
export function goodRecord(cls = 'repairable_checkout_fault'): TrialRecord {
  const missionId = id(1, 'b');
  const intentId = id(2, 'c');
  const taskId = id(3, 'd');
  const attemptId = id(4, 'e');
  const modelCallId = id(5, 'f');
  const healthSamples = Array.from({ length: 10 }, (_, n) => ({
    at: T0 + 100_000 + n * 2000,
    status: 200,
    health: 'ok',
    errorClasses: [] as string[],
  }));
  const snapshot = {
    mission: {
      id: missionId,
      goal: 'neutral goal',
      mode: 'live',
      status: 'succeeded',
      provider: {
        host: PROXY_HOST,
        plannerModel: 'm',
        workerModel: 'm',
      },
      cancellation: null,
    },
    tasks: [
      {
        id: taskId,
        status: 'succeeded',
        role: 'routing_specialist',
        parentId: null,
        prerequisites: [],
        createdByModelCallId: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        taskId,
        n: 1,
        kind: 'initial',
        status: 'published',
        repairOf: null,
        readSetReceiptIds: [id(6, '1')],
        modelCallIds: [modelCallId],
        inheritedDependencyVector: [],
        startedAt: iso(2000),
        finishedAt: iso(25_000),
      },
    ],
    outputs: [],
    findings: [],
    receipts: [
      {
        id: id(6, '1'),
        source: { key: 'checkout.config/orders.write_enabled' },
        sourceRevision: 2,
        status: 'superseded',
      },
      {
        id: id(7, '1'),
        source: { key: 'checkout.config/orders.write_enabled' },
        sourceRevision: 3,
        status: 'supported',
      },
    ],
    confirmations: [],
    actions: [
      {
        id: intentId,
        missionId,
        taskId,
        attemptId,
        modelCallId,
        toolCallId: 'tc-1',
        proposedAt: iso(10_000),
        action: 'set_config',
        status: 'verified',
        payload: { key: 'orders.write_enabled', value: true },
        idempotencyKey: 'k'.repeat(64),
        expectedTargetVersion: 2,
        dependencyVector: [
          {
            sourceKey: 'checkout.config/orders.write_enabled',
            sourceRevision: 2,
            receiptId: id(6, '1'),
          },
        ],
        dispatch: { fence: 1, owner: 'w', leaseExpiresAt: iso(60_000) },
        committedAt: iso(30_000),
      },
    ],
    authorizations: [
      {
        id: id(8, '2'),
        actionId: intentId,
        stage: 'admission',
        decidedAt: iso(20_000),
        decision: 'admitted',
        blockReason: null,
        checkedVector: [],
        authorFence: { token: 1, valid: true },
        dispatchFence: { token: 1, valid: true },
      },
      {
        id: id(9, '2'),
        actionId: intentId,
        stage: 'commit',
        decidedAt: iso(30_000),
        decision: 'committed',
        blockReason: null,
        checkedVector: [],
        authorFence: { token: 1, valid: true },
        dispatchFence: { token: 1, valid: true },
      },
    ],
    results: [],
    invalidations: [],
    recoveries: [],
    probe: null,
    telemetry: { calls: 3, orphanedCalls: 0 },
    lastEventId: 10,
  } as unknown as TrialRecord['snapshot'];

  return {
    trialId: 'synthetic-f5',
    cls,
    frozen: JSON.parse(JSON.stringify(SYNTHETIC_TRIAL)) as FrozenTrial,
    goalUsed: 'neutral goal',
    constraintsUsed: [],
    expectedProviderHost: PROXY_HOST,
    upstreamHost: EXPECTED_UPSTREAM_HOST,
    startedAtMs: T0,
    missionStartedAtMs: T0 + 1000,
    endedAtMs: T0 + 200_000,
    timedOut: false,
    runnerErrors: [],
    snapshot,
    snapshotAfterProbe: JSON.parse(
      JSON.stringify(snapshot),
    ) as TrialRecord['snapshot'],
    events: [
      {
        id: 1,
        kind: 'model_call.recorded',
        receivedAt: T0 + 5000,
        payload: {
          modelCallId,
          attemptId,
          taskId,
          role: 'worker',
          model: { requested: 'm', returned: 'm' },
          provider: { host: PROXY_HOST, mode: 'live' },
          outcome: 'completed',
          prefixDigest: 'p',
          contextDigest: 'c',
          usage: { cachedTokens: null },
          dependencyVectorSize: 1,
        },
      },
      {
        id: 2,
        kind: 'action.dispatched',
        receivedAt: T0 + 31_000,
        payload: { actionId: intentId, scriptResult: 'applied' },
      },
    ],
    eventStream: { reconnects: 0, duplicatesDropped: 0 },
    proxyLog: [
      {
        n: 1,
        method: 'POST',
        path: '/v1/chat/completions',
        modelCall: true,
        disposition: 'forwarded',
        upstreamStatus: 200,
        at: T0 + 4000,
        endedAt: T0 + 4900,
        upstreamHost: EXPECTED_UPSTREAM_HOST,
        model: 'm',
        stream: false,
        bodyDigest: 'digest-1',
        upstreamError: null,
      },
    ],
    modelsListing: {
      checked: true,
      status: 200,
      listed: { m: true },
      note: 'ok',
    },
    triggerFires: [],
    stepApplications: [
      {
        index: 0,
        step: SYNTHETIC_TRIAL.steps[0],
        appliedAtMs: T0,
        commitStartMs: T0 - 5,
        commitEndMs: T0 + 10,
        versionBefore: 1,
        versionAfter: 2,
        valueAfter: false,
        ok: true,
      },
    ],
    preTrialConfig: {
      'orders.write_enabled': {
        key: 'orders.write_enabled',
        value: true,
        version: 1,
        causedByActionId: null,
        causedByActor: 'seed',
      },
      'ui.banner_text': {
        key: 'ui.banner_text',
        value: 'hello',
        version: 1,
        causedByActionId: null,
        causedByActor: 'seed',
      },
    },
    finalConfig: {
      'orders.write_enabled': {
        key: 'orders.write_enabled',
        value: true,
        version: 3,
        causedByActionId: intentId,
        causedByActor: 'action',
      },
      'ui.banner_text': {
        key: 'ui.banner_text',
        value: 'hello',
        version: 1,
        causedByActionId: null,
        causedByActor: 'seed',
      },
    },
    orderingBasis: 'start_time_with_harness_brackets',
    configVersions: [
      {
        key: 'orders.write_enabled',
        version: 1,
        value: true,
        causedByActionId: null,
        causedByActor: 'seed',
        at: iso(-1000),
        commitAt: null,
      },
      {
        key: 'orders.write_enabled',
        version: 2,
        value: false,
        causedByActionId: null,
        causedByActor: 'injector',
        at: iso(0),
        commitAt: null,
      },
      {
        key: 'orders.write_enabled',
        version: 3,
        value: true,
        causedByActionId: intentId,
        causedByActor: 'action',
        at: iso(30_000),
        commitAt: null,
      },
    ],
    businessBefore: hashSnapshot(5),
    businessAfterReadOnly: hashSnapshot(5),
    readLoad: { requests: 400, failures: 0 },
    checkoutBefore: null,
    checkoutAfter: null,
    probe: {
      runId: 'acc6-synthetic',
      sku: 'PROBE-SKU',
      quantity: 1,
      inventoryBefore: 50,
      inventoryAfter: 49,
      rowCountsBefore: { products: 3, inventory: 3, orders: 5, order_items: 5 },
      rowCountsAfter: { products: 3, inventory: 3, orders: 6, order_items: 6 },
      taggedOrders: [{ id: 'o1' }],
      taggedItems: [{ order_id: 'o1', sku: 'PROBE-SKU', quantity: 1 }],
      create: { status: 201, body: { id: 'o1' } },
      orderId: 'o1',
      reads: [
        { status: 200, body: GOOD_ORDER_BODY() },
        { status: 200, body: GOOD_ORDER_BODY() },
      ],
      businessAfter: hashSnapshot(5),
      normalized: {
        before: { ordersRecentDigest: 'x', inventory: { 'PROBE-SKU': 50 } },
        after: { ordersRecentDigest: 'x', inventory: { 'PROBE-SKU': 50 } },
      },
    },
    taggedOrders: [
      {
        id: 'o1',
        probeRunId: 'acc6-synthetic',
        items: [{ sku: 'PROBE-SKU', quantity: 1 }],
      },
    ],
    health: { windowMs: 20000, samples: healthSamples },
    loadSamples: [],
    cacheAfter: null,
    lineage: [
      {
        id: modelCallId,
        taskId,
        attemptId,
        createdAtMs: T0 + 5000,
        contextVector: [
          {
            sourceKey: 'checkout.config/orders.write_enabled',
            sourceRevision: 2,
            receiptId: id(6, '1'),
          },
        ],
        outputVector: [],
      },
    ],
    redisEffects: {
      available: true,
      reason: null,
      markerSets: {},
      fenceSets: 0,
      cacheDeletes: 0,
      totalEvents: 0,
    },
    crash: null,
    leaks: [],
  };
}

/**
 * A team that refuses every action while the checkout stays broken, exactly
 * as an outside observer sees it: no intent, no commit, the injected fault is
 * still in force, the verifier's probe order is refused (503, nothing
 * written, inventory untouched) and the health window reads degraded.
 */
export function refusalRecord(cls = 'repairable_checkout_fault'): TrialRecord {
  const record = goodRecord(cls);
  record.snapshot!.actions = [];
  record.snapshot!.authorizations = [];
  record.snapshot!.results = [];
  record.snapshotAfterProbe = JSON.parse(
    JSON.stringify(record.snapshot),
  ) as TrialRecord['snapshotAfterProbe'];
  record.events = record.events.filter((e) => e.kind !== 'action.dispatched');
  record.configVersions = record.configVersions.slice(0, 2);
  record.finalConfig['orders.write_enabled'] = {
    ...record.finalConfig['orders.write_enabled'],
    value: false,
    version: 2,
    causedByActionId: null,
    causedByActor: 'injector',
  };
  const probe = record.probe!;
  probe.create = {
    status: 503,
    body: { error: 'writes_disabled', message: 'order writes are disabled' },
  };
  probe.orderId = null;
  probe.reads = [];
  probe.taggedOrders = [];
  probe.taggedItems = [];
  probe.inventoryAfter = probe.inventoryBefore;
  probe.rowCountsAfter = { ...probe.rowCountsBefore };
  record.taggedOrders = [];
  record.health = {
    windowMs: 20000,
    samples: record.health!.samples.map((s) => ({
      ...s,
      status: 503,
      health: 'degraded',
      errorClasses: ['writes_disabled'],
    })),
  };
  return record;
}
