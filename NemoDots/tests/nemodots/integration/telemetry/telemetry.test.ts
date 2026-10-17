// Telemetry on real PostgreSQL: attempts (fenced, retried, cancelled,
// orphaned) are stored through the ledger's own paths, then the summary, the
// timing rollup, the cost estimate and the JSONL export are compared with
// totals computed by hand from the rows inserted here.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TelemetrySummarySchema,
  sha256Hex,
  type ContextSnapshot,
  type InferenceAttempt,
  type ModelCallRecord,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { recordModelCall } from '../../../../src/server/nemodots/ledger/index.js';
import {
  estimateMissionCost,
  exportMissionTelemetry,
  getMissionTiming,
  recordOrphanedInference,
  recordToolSpan,
  storeMissionPricing,
  summarizeTelemetry,
  summarizeTelemetryDetailed,
  TelemetryError,
} from '../../../../src/server/nemodots/telemetry/index.js';
import { withTestDatabase } from '../../helpers/test-db.js';

const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const LIGHT = 'nvidia/Nemotron-3.5-Lightning-30B-A3B';
const HOST = 'api.inference.crusoecloud.com';
const BASE = Date.parse('2026-10-17T10:00:00.000Z');
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
const PREFIX_A = sha256Hex('prefix-a');
const PREFIX_B = sha256Hex('prefix-b');

let app: pg.Pool;
let admin: pg.Pool;
let finish: () => void;
let running: Promise<void>;

beforeAll(async () => {
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<void>((resolve, reject) => {
    running = withTestDatabase(async (db) => {
      app = createRolePool('app', db.urls.app);
      admin = createRolePool('admin', db.urls.admin);
      try {
        resolve();
        await done;
      } finally {
        await Promise.all([app.end(), admin.end()]);
      }
    }).catch(reject);
  });
  await ready;
}, 60_000);
afterAll(async () => {
  finish?.();
  await running;
}, 60_000);

function attempt(
  n: number,
  patch: Partial<InferenceAttempt>,
): InferenceAttempt {
  return {
    n,
    startedAt: at(0),
    headersAt: at(100),
    firstContentAt: at(200),
    finishedAt: at(1000),
    httpStatus: 200,
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      cachedTokens: null,
      reasoningTokens: 0,
    },
    finishReason: 'stop',
    error: null,
    retryAfterMs: null,
    streamed: true,
    outcome: 'recorded',
    ...patch,
  };
}

const nullUsage = {
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
};

function scopeOf(missionId: string) {
  return {
    ownerId: `owner-${randomUUID()}`,
    missionId,
    environment: 'test',
    resource: 'checkout',
  } as const;
}

async function storeCall(
  missionId: string,
  options: {
    role: ModelCallRecord['role'];
    model: string;
    prefix: string;
    attempts: InferenceAttempt[];
  },
) {
  const taskId = randomUUID();
  const snapshot = {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: options.prefix,
    prefixLength: 100,
    contextDigest: sha256Hex(`ctx-${randomUUID()}`),
    contextLength: 300,
    toolSchemaHash: sha256Hex('tools'),
    injected: {
      receipts: [],
      inheritedArtifacts: [],
      runbooks: [],
      pageSnapshots: [],
      memories: [],
      invalidationEvents: [],
      historyItems: [],
    },
    dependencyVector: [],
    volatile: { nowIso: at(0) },
  } as unknown as ContextSnapshot;
  const record = {
    id: randomUUID(),
    scope: scopeOf(missionId),
    taskId,
    attemptId: randomUUID(),
    role: options.role,
    model: { requested: options.model, returned: options.model },
    provider: { host: HOST, mode: 'live' },
    contextSnapshotId: snapshot.id,
    attempts: options.attempts,
    outcome: 'completed',
    outputDigest: sha256Hex('out'),
    outputDependencyVector: [],
    toolCalls: [],
    createdAt: at(0),
  } as unknown as ModelCallRecord;
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await recordModelCall(client, { record, snapshot });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return record;
}

async function inTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mission M:
 *  call 1  Super / worker / prefix A: attempt 1 rate_limited (null usage),
 *          attempt 2 ok 1000 prompt, 100 completion, 800 cached, ttft 200.
 *  call 2  Super / planner / prefix A: ok 500 / 50, cached 0, ttft 400.
 *  call 3  Lightning / repair / prefix B: ok 300 / 30, cached unavailable, ttft 100.
 *  call 4  Super / worker / prefix B: cancelled, null usage, no content.
 *  orphan  Super / worker: 200 / 20, cached 100, ttft 300, finished after 900 ms.
 * Spans: tool 150 ms ok, tool 250 ms error, setup 400 ms ok.
 */
async function seedMission() {
  const missionId = randomUUID();
  await storeCall(missionId, {
    role: 'worker',
    model: SUPER,
    prefix: PREFIX_A,
    attempts: [
      attempt(1, {
        httpStatus: 429,
        usage: nullUsage,
        firstContentAt: null,
        finishReason: 'error',
        error: {
          class: 'rate_limited',
          code: 'max_requests_limit',
          errorId: null,
        },
        retryAfterMs: 1000,
        finishedAt: at(300),
      }),
      attempt(2, {
        startedAt: at(1300),
        headersAt: at(1400),
        firstContentAt: at(1500),
        finishedAt: at(2300),
        usage: {
          promptTokens: 1000,
          completionTokens: 100,
          cachedTokens: 800,
          reasoningTokens: 10,
        },
      }),
    ],
  });
  await storeCall(missionId, {
    role: 'planner',
    model: SUPER,
    prefix: PREFIX_A,
    attempts: [
      attempt(1, {
        firstContentAt: at(400),
        usage: {
          promptTokens: 500,
          completionTokens: 50,
          cachedTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ],
  });
  await storeCall(missionId, {
    role: 'repair',
    model: LIGHT,
    prefix: PREFIX_B,
    attempts: [
      attempt(1, {
        firstContentAt: at(100),
        usage: {
          promptTokens: 300,
          completionTokens: 30,
          cachedTokens: null,
          reasoningTokens: 0,
        },
      }),
    ],
  });
  await storeCall(missionId, {
    role: 'worker',
    model: SUPER,
    prefix: PREFIX_B,
    attempts: [
      attempt(1, {
        firstContentAt: null,
        finishedAt: at(500),
        httpStatus: null,
        usage: nullUsage,
        finishReason: 'cancelled',
        error: { class: 'cancelled', code: null, errorId: null },
      }),
    ],
  });
  const orphanCall = randomUUID();
  await inTx((client) =>
    recordOrphanedInference(client, {
      modelCallId: orphanCall as never,
      scope: scopeOf(missionId) as never,
      taskId: randomUUID(),
      attemptId: randomUUID(),
      role: 'worker',
      model: { requested: SUPER, returned: SUPER },
      provider: { host: HOST, mode: 'live' },
      attempts: [
        attempt(1, {
          firstContentAt: at(300),
          finishedAt: at(900),
          usage: {
            promptTokens: 200,
            completionTokens: 20,
            cachedTokens: 100,
            reasoningTokens: 0,
          },
        }),
      ],
    }),
  );
  const spanBase = { missionId, toolName: 'observe_source' };
  await inTx(async (client) => {
    await recordToolSpan(client, {
      ...spanBase,
      startedAt: at(0),
      finishedAt: at(150),
      outcome: 'ok',
    });
    await recordToolSpan(client, {
      ...spanBase,
      toolName: 'propose_action',
      startedAt: at(200),
      finishedAt: at(450),
      outcome: 'error',
      errorClass: 'conflict',
    });
    await recordToolSpan(client, {
      ...spanBase,
      toolName: 'seed_context',
      bucket: 'setup',
      startedAt: at(0),
      finishedAt: at(400),
      outcome: 'ok',
    });
  });
  return { missionId, orphanCall };
}

describe('telemetry on PostgreSQL', () => {
  it('summarizes a mission exactly as hand-computed from the stored rows', async () => {
    const { missionId } = await seedMission();
    const { summary, detail } = await summarizeTelemetryDetailed(
      app,
      missionId,
    );
    expect(TelemetrySummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.calls).toBe(4); // calls 1-4 have fenced records
    expect(summary.orphanedCalls).toBe(1);
    // billed tokens include the orphaned attempt: 1000+500+300+200, 100+50+30+20
    expect(summary.tokens.prompt).toBe(2000);
    expect(summary.tokens.completion).toBe(200);
    expect(summary.tokens.cached).toEqual({ available: true, total: 900 });
    expect(summary.retries).toBe(1);
    expect(summary.errors).toBe(1); // rate_limited; the cancelled attempt is not an error
    // ttft samples: 200 (call1 n2), 400, 100, 300 -> sorted 100 200 300 400
    expect(summary.ttftMs).toEqual({ p50: 200, p95: 400 });
    expect(summary.byModel).toEqual([
      {
        model: SUPER,
        calls: 3,
        promptTokens: 1700,
        completionTokens: 170,
        cachedTokens: 900,
      },
      {
        model: LIGHT,
        calls: 1,
        promptTokens: 300,
        completionTokens: 30,
        cachedTokens: null,
      },
    ]);
    expect(summary.byRole).toEqual([
      { role: 'planner', calls: 1, promptTokens: 500, completionTokens: 50 },
      { role: 'repair', calls: 1, promptTokens: 300, completionTokens: 30 },
      { role: 'worker', calls: 2, promptTokens: 1200, completionTokens: 120 },
    ]);
    expect(summary.prefixGroups).toEqual(
      [
        { prefixDigest: PREFIX_A, calls: 2 },
        { prefixDigest: PREFIX_B, calls: 2 },
      ].sort((a, b) => (a.prefixDigest < b.prefixDigest ? -1 : 1)),
    );
    expect(detail.cached).toEqual({
      attemptsWithUsage: 4,
      reported: 3,
      unavailable: 1,
    });
    expect(detail.orphaned).toEqual({
      calls: 1,
      attempts: 1,
      promptTokens: 200,
      completionTokens: 20,
      cachedTokens: 100,
    });
  });

  it('keeps missions apart and the global summary equals the sum', async () => {
    const a = await seedMission();
    const b = await seedMission();
    const one = await summarizeTelemetry(app, a.missionId);
    const two = await summarizeTelemetry(app, b.missionId);
    expect(one).toEqual(two);
    const all = await summarizeTelemetry(app, null);
    expect(all.calls).toBeGreaterThanOrEqual(8);
    expect(all.orphanedCalls).toBeGreaterThanOrEqual(2);
  });

  it('is empty-safe for an unknown mission', async () => {
    const summary = await summarizeTelemetry(app, randomUUID());
    expect(summary.calls).toBe(0);
    expect(summary.ttftMs).toBeNull();
    expect(summary.tokens.cached).toEqual({ available: false, total: null });
  });

  it('rolls timing up into setup, inference and tool buckets and is idempotent', async () => {
    const { missionId, orphanCall } = await seedMission();
    const timing = await getMissionTiming(app, missionId);
    // inference: finished attempts 300 + 1000 + 1000 + 1000 + 500 + 900 (orphan)
    expect(timing.inferenceMs).toBe(4700);
    expect(timing.spans.inference).toBe(6);
    expect(timing.toolMs).toBe(400);
    expect(timing.spans.tool).toBe(2);
    expect(timing.setupMs).toBe(400);
    // redelivering the orphaned attempt changes nothing
    const again = await inTx((client) =>
      recordOrphanedInference(client, {
        modelCallId: orphanCall as never,
        scope: scopeOf(missionId) as never,
        taskId: randomUUID(),
        attemptId: randomUUID(),
        role: 'worker',
        model: { requested: SUPER, returned: SUPER },
        provider: { host: HOST, mode: 'live' },
        attempts: [attempt(1, { finishedAt: at(900) })],
      }),
    );
    expect(again.inserted).toBe(0);
    expect(await getMissionTiming(app, missionId)).toEqual(timing);
  });

  it('stores a tool span once per id and refuses a conflicting redelivery', async () => {
    const missionId = randomUUID();
    const id = randomUUID();
    const input = {
      id,
      missionId,
      toolName: 'read_runbook',
      startedAt: at(0),
      finishedAt: at(80),
      outcome: 'ok' as const,
      argsDigest: sha256Hex('args'),
    };
    const first = await inTx((c) => recordToolSpan(c, input));
    const second = await inTx((c) => recordToolSpan(c, input));
    expect([first.created, second.created]).toEqual([true, false]);
    await expect(
      inTx((c) => recordToolSpan(c, { ...input, finishedAt: at(90) })),
    ).rejects.toThrow(TelemetryError);
    expect((await getMissionTiming(app, missionId)).toolMs).toBe(80);
  });

  it('keeps spans and pricing append-only', async () => {
    const missionId = randomUUID();
    await inTx((c) =>
      recordToolSpan(c, {
        missionId,
        toolName: 'x',
        startedAt: at(0),
        finishedAt: at(1),
        outcome: 'ok',
      }),
    );
    await expect(
      app.query(
        'UPDATE ledger.tool_spans SET duration_ms = 0 WHERE mission_id = $1',
        [missionId],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      app.query('DELETE FROM ledger.tool_spans WHERE mission_id = $1', [
        missionId,
      ]),
    ).rejects.toThrow(/append-only/);
    await storeMissionPricing(app, {
      missionId,
      models: [SUPER],
      prices: [
        {
          model: SUPER,
          inputPerMillion: 0.3,
          outputPerMillion: 2.4,
          cachedPerMillion: 0.15,
        },
      ],
      source: 'GET /v1/models',
      fetchedAt: at(0),
    });
    await expect(
      app.query(
        'UPDATE ledger.mission_pricing SET input_per_million = 0 WHERE mission_id = $1',
        [missionId],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('estimates cost from stored prices, null where a model has none', async () => {
    const { missionId } = await seedMission();
    const before = await estimateMissionCost(app, missionId);
    expect(before.totalUsd).toBeNull();
    expect(before.unpricedModels).toBe(2);
    await storeMissionPricing(app, {
      missionId,
      models: [SUPER, LIGHT],
      prices: [
        {
          model: SUPER,
          inputPerMillion: 0.3,
          outputPerMillion: 2.4,
          cachedPerMillion: 0.15,
        },
        // LIGHT not listed by the provider: stored with null prices
      ],
      source: 'GET /v1/models',
      fetchedAt: at(0),
    });
    const cost = await estimateMissionCost(app, missionId);
    const superCost = cost.byModel.find((m) => m.model === SUPER);
    // SUPER: prompt 1700, cached 900, completion 170
    // (800*0.30 + 900*0.15 + 170*2.40) / 1e6
    expect(superCost?.cost.usd).toBeCloseTo(
      (800 * 0.3 + 900 * 0.15 + 170 * 2.4) / 1e6,
      12,
    );
    expect(superCost?.cost.cachedAssumedUncached).toBe(false);
    const lightCost = cost.byModel.find((m) => m.model === LIGHT);
    expect(lightCost?.cost.usd).toBeNull();
    expect(cost.totalUsd).toBeNull();
    expect(cost.unpricedModels).toBe(1);
  });
});

describe('JSONL export', () => {
  it('writes one parseable line per stored row, with no secrets, and matches the summary', async () => {
    const { missionId } = await seedMission();
    await storeMissionPricing(app, {
      missionId,
      models: [SUPER],
      prices: [
        {
          model: SUPER,
          inputPerMillion: 0.3,
          outputPerMillion: 2.4,
          cachedPerMillion: 0.15,
        },
      ],
      source: 'GET /v1/models',
      fetchedAt: at(0),
    });
    const root = await mkdtemp(path.join(os.tmpdir(), 'nemodots-telemetry-'));
    try {
      const result = await exportMissionTelemetry(app, missionId, {
        rootDir: root,
      });
      expect(result.path).toBe(
        path.join(root, 'artifacts/nemodots/telemetry', `${missionId}.jsonl`),
      );
      const text = await readFile(result.path, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const lines = text
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as { type: string });
      expect(lines).toHaveLength(result.lines);
      const count = (type: string) =>
        lines.filter((l) => l.type === type).length;
      expect(count('mission')).toBe(1);
      expect(count('inference_attempt')).toBe(6); // 2 + 1 + 1 + 1 + orphan
      expect(count('tool_span')).toBe(3);
      expect(count('pricing')).toBe(1);
      const summaryLine = lines.find(
        (l) => l.type === 'summary',
      ) as unknown as {
        summary: unknown;
      };
      expect(summaryLine.summary).toEqual(
        await summarizeTelemetry(app, missionId),
      );
      const orphaned = lines.filter(
        (l) =>
          l.type === 'inference_attempt' &&
          (l as unknown as { outcome: string }).outcome === 'orphaned_fence',
      );
      expect(orphaned).toHaveLength(1);

      // the acceptance grep: no key material of any shape
      expect(text).not.toContain('sk-');
      expect(text).not.toContain('Bearer');
      for (const name of [
        'OPENAI_API_KEY',
        'CRUSOE_API_KEY',
        'CPK_INTELLIGENCE_API_KEY',
      ]) {
        const value = process.env[name];
        if (value && value.length >= 8) {
          expect(text).not.toContain(value.slice(0, 8));
        }
      }
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to write anything when the redaction check finds a secret', async () => {
    const { missionId } = await seedMission();
    const root = await mkdtemp(path.join(os.tmpdir(), 'nemodots-telemetry-'));
    try {
      await expect(
        // the provider host is present in every attempt line, so this "secret" is found
        exportMissionTelemetry(app, missionId, {
          rootDir: root,
          secrets: [HOST],
        }),
      ).rejects.toMatchObject({ code: 'redaction_failed' });
      await expect(readdir(path.join(root, 'artifacts'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a mission id that is not a uuid', async () => {
    await expect(
      exportMissionTelemetry(app, '../../etc/passwd'),
    ).rejects.toMatchObject({
      code: 'export_invalid',
    });
  });
});
