// Model-call records: the fenced path stores snapshot + record + attempts +
// evidence/inheritance edges in one transaction and refuses stale support; the
// unfenced orphan path stores telemetry only (finding C16).
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ContextSnapshotSchema,
  ModelCallRecordSchema,
  sha256Hex,
  type ContextSnapshot,
  type InferenceAttempt,
  type ModelCallRecord,
  type ObservationReceipt,
  type Scope,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  ModelCallRecordError,
  SupportError,
  listEdges,
  readSetOf,
  recordModelCall,
  recordOrphanedAttempt,
  registerObservation,
  staleReads,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  FX,
  count,
  inTx,
  newScope,
  readMember,
  resetAuthority,
  seedConfig,
  sourceRef,
  updateConfig,
  useLedgerDb,
} from './fixtures.js';

const getDb = useLedgerDb();

beforeEach(async () => {
  await resetAuthority(getDb().admin);
});

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function attemptRow(
  n: number,
  patch: Partial<InferenceAttempt> = {},
): InferenceAttempt {
  return {
    n,
    startedAt: iso(-2000 + n),
    headersAt: iso(-1500 + n),
    firstContentAt: iso(-1400 + n),
    finishedAt: iso(-1000 + n),
    httpStatus: 200,
    usage: {
      promptTokens: 1200,
      completionTokens: 80,
      cachedTokens: null,
      reasoningTokens: 0,
    },
    finishReason: 'tool_calls',
    error: null,
    retryAfterMs: null,
    streamed: false,
    outcome: 'recorded',
    ...patch,
  };
}

interface World {
  scope: Scope;
  taskId: string;
  attemptId: string;
  member: ObservationReceipt;
  health: ObservationReceipt;
  inheritedOutputId: string;
}

async function world(): Promise<World> {
  const base = newScope();
  await seedConfig(getDb().app, { 'db.pool_max': 3 });
  const member = await inTx(getDb().app, async (client) => {
    const read = await readMember(client, 'db.pool_max');
    return registerObservation(
      client,
      {
        source: sourceRef(base, 'checkout.config/db.pool_max'),
        normalizedValue: read.normalizedValue,
        provenance: { kind: 'watcher' },
      },
      { ledger: FX, marker: null },
    );
  });
  const health = await inTx(getDb().app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(base, 'checkout.health'),
        normalizedValue: { status: 'degraded' },
        provenance: { kind: 'watcher' },
      },
      { ledger: FX, marker: null },
    ),
  );
  const inheritedOutputId = randomUUID();
  const outputTaskId = randomUUID();
  await getDb().admin.query(
    `INSERT INTO fx_coordinator.tasks (id, mission_id, status) VALUES ($1, $2, 'succeeded')`,
    [outputTaskId, base.missionId],
  );
  // The inherited output exists in the coordinator, is usable and rests on
  // the member receipt (what the context compiler lists as its dependency).
  await getDb().admin.query(
    `INSERT INTO fx_coordinator.task_outputs (id, task_id, usable, dependency_vector)
     VALUES ($1, $2, true, $3::jsonb)`,
    [
      inheritedOutputId,
      outputTaskId,
      JSON.stringify([
        {
          sourceKey: member.receipt.source.key,
          sourceRevision: member.receipt.sourceRevision,
          receiptId: member.receipt.id,
        },
      ]),
    ],
  );
  const recordingTaskId = randomUUID();
  const recordingAttemptId = randomUUID();
  await getDb().admin.query(
    `INSERT INTO fx_coordinator.task_attempts (id, task_id, mission_id, status) VALUES ($1, $2, $3, 'running')`,
    [recordingAttemptId, recordingTaskId, base.missionId],
  );
  return {
    scope: sourceRef(base, 'checkout.health').scope,
    taskId: recordingTaskId,
    attemptId: recordingAttemptId,
    member: member.receipt,
    health: health.receipt,
    inheritedOutputId,
  };
}

function build(
  w: World,
  patch: {
    modelCallId?: string;
    receipts?: ObservationReceipt[];
    inherit?: boolean;
  } = {},
) {
  const receipts = (patch.receipts ?? [w.member, w.health]).sort((a, b) =>
    a.source.key < b.source.key ? -1 : 1,
  );
  const vector = receipts.map((r) => ({
    sourceKey: r.source.key,
    sourceRevision: r.sourceRevision,
    receiptId: r.id,
  }));
  const snapshot: ContextSnapshot = {
    id: randomUUID() as never,
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: sha256Hex('prefix'),
    prefixLength: 100,
    contextDigest: sha256Hex(`context-${randomUUID()}`),
    contextLength: 400,
    toolSchemaHash: sha256Hex('tools'),
    injected: {
      receipts: receipts.map((r) => ({
        id: r.id,
        sourceKey: r.source.key,
        sourceRevision: r.sourceRevision,
        contentDigest: r.contentDigest,
      })),
      inheritedArtifacts:
        patch.inherit === false
          ? []
          : [
              {
                kind: 'task_output',
                id: w.inheritedOutputId,
                digest: sha256Hex('o1'),
                dependencyReceiptIds: [receipts[0].id],
              },
            ],
      runbooks: [],
      pageSnapshots: [],
      memories: [],
      invalidationEvents: [],
      historyItems: [],
    },
    dependencyVector: vector,
    volatile: { nowIso: iso() },
  } as ContextSnapshot;
  const record: ModelCallRecord = {
    id: (patch.modelCallId ?? randomUUID()) as never,
    scope: w.scope,
    taskId: w.taskId as never,
    attemptId: w.attemptId as never,
    role: 'worker',
    model: {
      requested: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      returned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    },
    provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
    contextSnapshotId: snapshot.id,
    attempts: [
      attemptRow(1, {
        httpStatus: 429,
        finishReason: 'error',
        retryAfterMs: 1000,
        error: {
          class: 'rate_limited',
          code: 'max_requests_limit',
          errorId: null,
        },
        usage: {
          promptTokens: null,
          completionTokens: null,
          cachedTokens: null,
          reasoningTokens: null,
        },
      }),
      attemptRow(2),
    ],
    outcome: 'tool_calls',
    outputDigest: sha256Hex('out'),
    outputDependencyVector: vector,
    toolCalls: [
      {
        toolCallId: 'call_1',
        name: 'observe_source',
        argumentsDigest: sha256Hex('{}'),
      },
    ],
    createdAt: iso(),
  } as ModelCallRecord;
  expect(ContextSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(ModelCallRecordSchema.safeParse(record).success).toBe(true);
  return { snapshot, record };
}

const tables = [
  'context_snapshots',
  'model_call_records',
  'inference_attempts',
] as const;
async function counts() {
  const result: Record<string, number> = {};
  for (const table of tables)
    result[table] = await count(
      getDb().app,
      `SELECT count(*) AS n FROM ledger.${table}`,
    );
  result.edges = await count(
    getDb().app,
    'SELECT count(*) AS n FROM ledger.dependency_edges',
  );
  return result;
}

describe('recordModelCall (fenced path)', () => {
  it('stores snapshot, record, tool calls, attempts and evidence + inheritance edges in one transaction', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    const before = await counts();
    const stored = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    );
    expect(stored).toEqual({
      created: true,
      inferenceAttempts: 2,
      edges: { inserted: 6, existing: 0 },
    });
    const after = await counts();
    expect(after.context_snapshots - before.context_snapshots).toBe(1);
    expect(after.model_call_records - before.model_call_records).toBe(1);
    expect(after.inference_attempts - before.inference_attempts).toBe(2);
    expect(after.edges - before.edges).toBe(6);

    const { rows } = await getDb().app.query(
      'SELECT tool_calls, outcome, provider_host, model_returned, output_dependency_vector FROM ledger.model_call_records WHERE id = $1',
      [record.id],
    );
    expect(rows[0].tool_calls).toEqual(record.toolCalls);
    expect(rows[0].output_dependency_vector).toEqual(
      record.outputDependencyVector,
    );
    expect(rows[0]).toMatchObject({
      outcome: 'tool_calls',
      provider_host: 'api.inference.crusoecloud.com',
    });

    const attempts = await getDb().app.query(
      'SELECT n, outcome, http_status, prompt_tokens, cached_tokens, error_class, finish_reason FROM ledger.inference_attempts WHERE model_call_id = $1 ORDER BY n',
      [record.id],
    );
    expect(attempts.rows).toEqual([
      {
        n: 1,
        outcome: 'recorded',
        http_status: 429,
        prompt_tokens: null,
        cached_tokens: null,
        error_class: 'rate_limited',
        finish_reason: 'error',
      },
      {
        n: 2,
        outcome: 'recorded',
        http_status: 200,
        prompt_tokens: 1200,
        cached_tokens: null,
        error_class: null,
        finish_reason: 'tool_calls',
      },
    ]);

    const edges = (
      await listEdges(getDb().app, { missionId: w.scope.missionId })
    )
      .map((e) => `${e.kind}:${e.from.kind}->${e.to.kind}`)
      .sort();
    expect(edges).toEqual([
      'evidence:receipt->attempt',
      'evidence:receipt->attempt',
      'evidence:receipt->model_call',
      'evidence:receipt->model_call',
      'inheritance:task_output->attempt',
      'inheritance:task_output->model_call',
    ]);
    expect((await readSetOf(getDb().app, w.attemptId)).sort()).toEqual(
      [w.member.id, w.health.id].sort(),
    );
  });

  it('a later change to a receipt in the vector puts the call, the attempt and the read set in the closure', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    );
    const change = await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: w.health.source,
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX },
      ),
    );
    expect(change.invalidation!.affected).toMatchObject({
      modelCallIds: [record.id],
      attemptIds: [w.attemptId],
    });
    expect(change.invalidation!.perMission).toHaveLength(1);
    expect(change.invalidation!.perMission[0].missionId).toBe(
      w.scope.missionId,
    );
    // the attempt's read set now reports the superseded receipt
    expect(await staleReads(getDb().app, w.attemptId, FX)).toEqual([
      {
        receiptId: w.health.id,
        sourceKey: 'checkout.health',
        reason: 'stale_version',
      },
    ]);
    // the unrelated controlled receipt is unaffected until the authority moves
    await inTx(getDb().app, (client) => updateConfig(client, 'db.pool_max', 9));
    expect(
      (await staleReads(getDb().app, w.attemptId, FX))
        .map((r) => r.reason)
        .sort(),
    ).toEqual(['stale_pending_observation', 'stale_version']);
  });

  it('is idempotent for an identical redelivery and refuses the same id with different content', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    );
    const again = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    );
    expect(again).toMatchObject({
      created: false,
      inferenceAttempts: 0,
      edges: { inserted: 0, existing: 6 },
    });
    const tampered = { ...record, outputDigest: sha256Hex('different') };
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(client, { record: tampered, snapshot }, FX),
      ),
    ).rejects.toMatchObject({ code: 'model_call_conflict' });
  });

  it('refuses a record that does not match its snapshot or loses vector entries', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    const other = build(w).snapshot;
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(client, { record, snapshot: other }, FX),
      ),
    ).rejects.toBeInstanceOf(ModelCallRecordError);
    const shrunk = {
      ...record,
      outputDependencyVector: record.outputDependencyVector.slice(1),
    };
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(client, { record: shrunk, snapshot }, FX),
      ),
    ).rejects.toThrow(/citations add, never remove/);
    const orphanedAttempt = {
      ...record,
      attempts: [attemptRow(1, { outcome: 'orphaned_fence' })],
    };
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(client, { record: orphanedAttempt, snapshot }, FX),
      ),
    ).rejects.toThrow(/recordOrphanedAttempt/);
    const forged = {
      ...record,
      outputDependencyVector: record.outputDependencyVector.map((entry, i) =>
        i === 0 ? { ...entry, sourceRevision: 99 } : entry,
      ),
      contextSnapshotId: snapshot.id,
    };
    const forgedSnapshot = {
      ...snapshot,
      dependencyVector: forged.outputDependencyVector,
    };
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(
          client,
          { record: forged as never, snapshot: forgedSnapshot as never },
          FX,
        ),
      ),
    ).rejects.toThrow(/does not match the stored receipt/);
  });

  it('refuses a publication resting on a superseded receipt and stores nothing (C13)', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: { ...w.health.source },
          normalizedValue: { status: 'ok' },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    const before = await counts();
    const error = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupportError);
    expect((error as SupportError).reason).toBe('stale_version');
    expect(await counts()).toEqual(before);
  });

  it('refuses an inherited output that is no longer usable and stores nothing', async () => {
    const w = await world();
    await getDb().admin.query(
      `UPDATE fx_coordinator.task_outputs SET usable = false, unusable_reason = 'invalidated:test' WHERE id = $1`,
      [w.inheritedOutputId],
    );
    const { snapshot, record } = build(w);
    const before = await counts();
    const error = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupportError);
    expect((error as SupportError).reason).toBe('stale_version');
    expect(await counts()).toEqual(before);
  });

  it('refuses an inherited output that rests on receipts the call does not cite, whatever the caller lists', async () => {
    const w = await world();
    const other = await inTx(getDb().app, (client) =>
      registerObservation(
        client,
        {
          source: sourceRef(newScope(), 'checkout.metrics'),
          normalizedValue: { errors: [] },
          provenance: { kind: 'watcher' },
        },
        { ledger: FX, marker: null },
      ),
    );
    await getDb().admin.query(
      `UPDATE fx_coordinator.task_outputs SET dependency_vector = $2::jsonb WHERE id = $1`,
      [
        w.inheritedOutputId,
        JSON.stringify([
          {
            sourceKey: 'checkout.metrics',
            sourceRevision: 1,
            receiptId: other.receipt.id,
          },
        ]),
      ],
    );
    const { snapshot, record } = build(w);
    const before = await counts();
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(client, { record, snapshot }, FX),
      ),
    ).rejects.toMatchObject({ code: 'model_call_invalid' });
    expect(await counts()).toEqual(before);
  });

  it('refuses an inherited output of another mission and stores nothing (F4)', async () => {
    const w = await world();
    const otherMission = randomUUID();
    const otherTask = randomUUID();
    await getDb().admin.query(
      `INSERT INTO fx_coordinator.tasks (id, mission_id, status) VALUES ($1, $2, 'succeeded')`,
      [otherTask, otherMission],
    );
    await getDb().admin.query(
      `UPDATE fx_coordinator.task_outputs SET task_id = $2 WHERE id = $1`,
      [w.inheritedOutputId, otherTask],
    );
    const { snapshot, record } = build(w);
    const before = await counts();
    const error = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupportError);
    expect((error as SupportError).reason).toBe('citation_out_of_scope');
    expect(await counts()).toEqual(before);
  });

  it('derives the recording mission from the attempt row: a record claiming a mission the attempt is not in is refused (F4)', async () => {
    const w = await world();
    await getDb().admin.query(
      'UPDATE fx_coordinator.task_attempts SET mission_id = $2 WHERE id = $1',
      [w.attemptId, randomUUID()],
    );
    const { snapshot, record } = build(w);
    const before = await counts();
    const error = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupportError);
    expect((error as SupportError).reason).toBe('citation_out_of_scope');
    expect(await counts()).toEqual(before);
  });

  it('refuses an inherited output that does not exist', async () => {
    const w = await world();
    await getDb().admin.query(
      'DELETE FROM fx_coordinator.task_outputs WHERE id = $1',
      [w.inheritedOutputId],
    );
    const { snapshot, record } = build(w);
    await expect(
      inTx(getDb().app, (client) =>
        recordModelCall(client, { record, snapshot }, FX),
      ),
    ).rejects.toMatchObject({ code: 'model_call_invalid' });
  });

  it('refuses a publication when the authority advanced before the watcher registered it (G3)', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    await inTx(getDb().app, (client) =>
      updateConfig(client, 'db.pool_max', 10),
    );
    const error = await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    ).catch((e: unknown) => e);
    expect((error as SupportError).reason).toBe('stale_pending_observation');
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.model_call_records WHERE id = $1',
        [record.id],
      ),
    ).toBe(0);
    expect(await staleReads(getDb().app, w.attemptId, FX)).toEqual([]); // nothing was recorded for the attempt
  });
});

describe('recordOrphanedAttempt (unfenced telemetry path, C16)', () => {
  it("stores only inference_attempts rows with outcome 'orphaned_fence': no record, snapshot, edges or nodes", async () => {
    const w = await world();
    const modelCallId = randomUUID() as never;
    const before = await counts();
    const nodesBefore = await count(
      getDb().app,
      'SELECT count(*) AS n FROM ledger.dependency_nodes',
    );
    const result = await inTx(getDb().app, (client) =>
      recordOrphanedAttempt(client, {
        modelCallId,
        scope: w.scope,
        taskId: w.taskId,
        attemptId: w.attemptId,
        role: 'worker',
        model: {
          requested: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
          returned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
        },
        provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
        attempts: [attemptRow(1, { finishReason: 'stop' })],
      }),
    );
    expect(result.inserted).toBe(1);
    const after = await counts();
    expect(after.inference_attempts - before.inference_attempts).toBe(1);
    expect(after.model_call_records).toBe(before.model_call_records);
    expect(after.context_snapshots).toBe(before.context_snapshots);
    expect(after.edges).toBe(before.edges);
    expect(
      await count(
        getDb().app,
        'SELECT count(*) AS n FROM ledger.dependency_nodes',
      ),
    ).toBe(nodesBefore);
    const { rows } = await getDb().app.query(
      'SELECT outcome, prompt_tokens, completion_tokens, mission_id FROM ledger.inference_attempts WHERE model_call_id = $1',
      [modelCallId],
    );
    expect(rows).toEqual([
      {
        outcome: 'orphaned_fence',
        prompt_tokens: 1200,
        completion_tokens: 80,
        mission_id: w.scope.missionId,
      },
    ]);

    // idempotent per (call, n)
    const again = await inTx(getDb().app, (client) =>
      recordOrphanedAttempt(client, {
        modelCallId,
        scope: w.scope,
        taskId: w.taskId,
        attemptId: w.attemptId,
        role: 'worker',
        model: { requested: 'm', returned: null },
        provider: { host: 'h', mode: 'live' },
        attempts: [attemptRow(1)],
      }),
    );
    expect(again.inserted).toBe(0);
  });

  it('forces the outcome and refuses a call that already has a fenced record', async () => {
    const w = await world();
    const { snapshot, record } = build(w);
    await inTx(getDb().app, (client) =>
      recordModelCall(client, { record, snapshot }, FX),
    );
    await expect(
      inTx(getDb().app, (client) =>
        recordOrphanedAttempt(client, {
          modelCallId: record.id,
          scope: w.scope,
          taskId: w.taskId,
          attemptId: w.attemptId,
          role: 'worker',
          model: { requested: 'm', returned: null },
          provider: { host: 'h', mode: 'live' },
          attempts: [attemptRow(7, { outcome: 'recorded' })],
        }),
      ),
    ).rejects.toMatchObject({ code: 'model_call_conflict' });
  });

  it('a cancelled orphan keeps null usage (unavailable is not zero)', async () => {
    const w = await world();
    const modelCallId = randomUUID() as never;
    await inTx(getDb().app, (client) =>
      recordOrphanedAttempt(client, {
        modelCallId,
        scope: w.scope,
        taskId: w.taskId,
        attemptId: w.attemptId,
        role: 'worker',
        model: { requested: 'm', returned: null },
        provider: { host: 'h', mode: 'live' },
        attempts: [
          attemptRow(1, {
            finishReason: 'cancelled',
            httpStatus: null,
            finishedAt: null,
            error: { class: 'cancelled', code: null, errorId: null },
            usage: {
              promptTokens: null,
              completionTokens: null,
              cachedTokens: null,
              reasoningTokens: null,
            },
          }),
        ],
      }),
    );
    const { rows } = await getDb().app.query(
      'SELECT prompt_tokens, cached_tokens, outcome FROM ledger.inference_attempts WHERE model_call_id = $1',
      [modelCallId],
    );
    expect(rows[0]).toEqual({
      prompt_tokens: null,
      cached_tokens: null,
      outcome: 'orphaned_fence',
    });
  });
});
