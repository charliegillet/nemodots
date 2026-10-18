// Telemetry against a real migrated database: attempts stored by the ledger
// (fenced and orphaned), tool spans and mission timing, the summary checked
// against totals computed by hand, and the JSONL export checked for secrets.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  sha256Hex,
  type ContextSnapshot,
  type InferenceAttempt,
  type ModelCallRecord,
  type ModelRole,
  type Scope,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import {
  recordModelCall,
  recordOrphanedAttempt,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  exportTelemetryJsonl,
  listMissionTiming,
  listToolSpans,
  markMissionPhase,
  recordToolSpan,
  splitTiming,
  telemetrySummary,
  TelemetryRedactionError,
} from '../../../../src/server/nemodots/telemetry/index.js';
import { withTestDatabase } from '../../helpers/test-db.js';

let app: pg.Pool;
let admin: pg.Pool;
let finish: () => void;
let running: Promise<void>;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'nemodots-telemetry-'));
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
  await rm(dir, { recursive: true, force: true });
}, 60_000);

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

const seededMissions = new Set<string>();
/** A real mission, task and running attempt: the ledger derives the mission from the attempt. */
async function seedAttempt(missionId: string) {
  if (!seededMissions.has(missionId)) {
    await admin.query(
      `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
       VALUES ($1, 'owner', 'test', 'checkout', 'telemetry test', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
      [missionId],
    );
    seededMissions.add(missionId);
  }
  const taskId = randomUUID();
  const attemptId = randomUUID();
  await admin.query(
    `INSERT INTO coordinator.tasks (id, mission_id, depth, ordinal, title, question, role, status, generation, budget)
     SELECT $1, $2, 0, COALESCE(MAX(ordinal) + 1, 0), 't', 'q', 'investigator', 'running', 0, '{}'::jsonb
       FROM coordinator.tasks WHERE mission_id = $2`,
    [taskId, missionId],
  );
  await admin.query(
    `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner,
                                            fencing_token, lease_expires_at, lease_renewed_at)
     VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'w', 1, now() + interval '1 hour', now())`,
    [attemptId, taskId, missionId],
  );
  return { taskId, attemptId };
}

function scopeOf(missionId: string): Scope {
  return {
    ownerId: 'owner',
    missionId: missionId as never,
    spaceId: null,
    environment: 'test',
    resource: 'checkout',
  };
}

function attempt(
  n: number,
  patch: Partial<InferenceAttempt> & {
    tokens?: [number | null, number | null, number | null];
    startMs?: number;
    ttftMs?: number | null;
  } = {},
): InferenceAttempt {
  const {
    tokens = [1000, 100, null],
    startMs = 0,
    ttftMs = 400,
    ...rest
  } = patch;
  return {
    n,
    startedAt: at(startMs),
    headersAt: at(startMs + 100),
    firstContentAt: ttftMs === null ? null : at(startMs + ttftMs),
    finishedAt: at(startMs + 1000),
    httpStatus: 200,
    usage: {
      promptTokens: tokens[0],
      completionTokens: tokens[1],
      cachedTokens: tokens[2],
      reasoningTokens: null,
    },
    finishReason: 'stop',
    error: null,
    retryAfterMs: null,
    streamed: true,
    outcome: 'recorded',
    ...rest,
  };
}

async function fenced(
  missionId: string,
  role: ModelRole,
  model: string,
  attempts: InferenceAttempt[],
  prefix: string,
) {
  const snapshot = {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: sha256Hex(prefix),
    prefixLength: 10,
    contextDigest: sha256Hex(`ctx-${randomUUID()}`),
    contextLength: 40,
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
  const { taskId, attemptId } = await seedAttempt(missionId);
  const record = {
    id: randomUUID(),
    scope: scopeOf(missionId),
    taskId,
    attemptId,
    role,
    model: { requested: model, returned: model },
    provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
    contextSnapshotId: snapshot.id,
    attempts,
    outcome: 'completed',
    outputDigest: sha256Hex('out'),
    outputDependencyVector: [],
    toolCalls: [],
    createdAt: at(2000),
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

describe('telemetry over stored attempts', () => {
  const missionId = randomUUID();
  const otherMission = randomUUID();
  const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
  const LIGHT = 'nvidia/Nemotron-3.5-Lightning-30B-A3B';

  beforeAll(async () => {
    // Call 1: planner on Super, 1000/100 tokens, 600 cached, TTFT 400 ms.
    await fenced(
      missionId,
      'planner',
      SUPER,
      [attempt(1, { tokens: [1000, 100, 600] })],
      'prefix-a',
    );
    // Call 2: worker on Super; first attempt rate limited, the retry succeeds
    // (cached not reported), TTFT 1000 ms.
    await fenced(
      missionId,
      'worker',
      SUPER,
      [
        attempt(1, {
          httpStatus: 429,
          finishReason: 'error',
          error: {
            class: 'rate_limited',
            code: 'rate_limit_error',
            errorId: 'e1',
          },
          tokens: [null, null, null],
          ttftMs: null,
        }),
        attempt(2, { tokens: [2000, 200, null], startMs: 3000, ttftMs: 1000 }),
      ],
      'prefix-a',
    );
    // Call 3: worker on Lightning, 500/50 tokens, cached reported as 0, TTFT 200 ms.
    await fenced(
      missionId,
      'worker',
      LIGHT,
      [attempt(1, { tokens: [500, 50, 0], ttftMs: 200 })],
      'prefix-b',
    );
    // Another mission, to prove the filter.
    await fenced(
      otherMission,
      'worker',
      SUPER,
      [attempt(1, { tokens: [7, 7, 7] })],
      'prefix-z',
    );
    // An orphaned call (fence lost) in the mission: counted separately.
    const orphan = await seedAttempt(missionId);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await recordOrphanedAttempt(client, {
        modelCallId: randomUUID() as never,
        scope: scopeOf(missionId),
        taskId: orphan.taskId as never,
        attemptId: orphan.attemptId as never,
        role: 'worker',
        model: { requested: SUPER, returned: SUPER },
        provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
        attempts: [
          attempt(1, { tokens: [9999, 999, 9999], outcome: 'orphaned_fence' }),
        ],
      } as never);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }, 60_000);

  it('the summary equals totals computed by hand', async () => {
    const summary = await telemetrySummary(app, missionId);
    expect(summary.calls).toBe(3);
    expect(summary.orphanedCalls).toBe(1);
    // 1000 + 2000 + 500 prompt, 100 + 200 + 50 completion; the 429 attempt has no usage
    expect(summary.tokens.prompt).toBe(3500);
    expect(summary.tokens.completion).toBe(350);
    // cached: 600 (call 1) + 0 (call 3); call 2 did not report it
    expect(summary.tokens.cached).toEqual({ available: true, total: 600 });
    expect(summary.retries).toBe(1);
    expect(summary.errors).toBe(1);
    // TTFT of the three successful attempts: 200, 400, 1000. p95 sits at
    // position 1.9 of the sorted values: 400 + 0.9 * (1000 - 400) = 940.
    expect(summary.ttftMs?.p50).toBe(400);
    expect(summary.ttftMs?.p95).toBeCloseTo(940, 6);
    // sorted by model name (code-unit order)
    expect(summary.byModel).toEqual([
      {
        model: SUPER,
        calls: 2,
        promptTokens: 3000,
        completionTokens: 300,
        cachedTokens: 600,
      },
      {
        model: LIGHT,
        calls: 1,
        promptTokens: 500,
        completionTokens: 50,
        cachedTokens: 0,
      },
    ]);
    expect(summary.byRole).toEqual([
      { role: 'planner', calls: 1, promptTokens: 1000, completionTokens: 100 },
      { role: 'worker', calls: 2, promptTokens: 2500, completionTokens: 250 },
    ]);
    expect(
      Object.fromEntries(summary.prefixGroups.map((g) => [g.calls, g])),
    ).toMatchObject({
      2: { prefixDigest: sha256Hex('prefix-a') },
      1: { prefixDigest: sha256Hex('prefix-b') },
    });
  });

  it('is scoped to the mission, and unscoped covers every mission', async () => {
    const other = await telemetrySummary(app, otherMission);
    expect(other).toMatchObject({ calls: 1, orphanedCalls: 0 });
    expect(other.tokens.prompt).toBe(7);
    const all = await telemetrySummary(app);
    expect(all.calls).toBe(4);
    expect(await telemetrySummary(app, randomUUID())).toMatchObject({
      calls: 0,
      ttftMs: null,
      tokens: { cached: { available: false, total: null } },
    });
  });

  it('stores tool spans as digests, idempotently, append-only', async () => {
    const attemptId = randomUUID();
    const span = {
      missionId,
      taskId: randomUUID(),
      attemptId,
      toolCallId: 'call_1',
      toolName: 'observe_source',
      startedAt: at(0),
      finishedAt: at(250),
      outcome: 'ok' as const,
      argumentsDigest: sha256Hex('{"key":"checkout.health"}'),
      resultDigest: sha256Hex('result'),
    };
    const first = await recordToolSpan(app, span);
    expect(first.inserted).toBe(true);
    expect((await recordToolSpan(app, span)).inserted).toBe(false);
    const stored = await listToolSpans(app, missionId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      toolName: 'observe_source',
      outcome: 'ok',
      argumentsDigest: span.argumentsDigest,
    });
    await expect(
      app.query(`UPDATE ledger.tool_spans SET outcome = 'error'`),
    ).rejects.toThrow(/append-only/);
    await expect(app.query('DELETE FROM ledger.tool_spans')).rejects.toThrow(
      /append-only/,
    );
  });

  it('records mission phase marks with repeat counters and splits the timing', async () => {
    const mission = randomUUID();
    const marks = [
      ['started', 0],
      ['conflict_detected', 5000],
      ['recovery_started', 6000],
      ['recovered', 16000],
      ['recovery_started', 17000],
      ['completed', 20000],
    ] as const;
    for (const [phase, ms] of marks)
      await markMissionPhase(app, mission, phase, new Date(T0 + ms));
    const stored = await listMissionTiming(app, mission);
    expect(
      stored.filter((m) => m.phase === 'recovery_started').map((m) => m.n),
    ).toEqual([1, 2]);
    expect(splitTiming(stored)).toEqual({
      detectionToRecoveryStartMs: 1000,
      recoveryMs: 10000,
      completionMs: 20000,
    });
    await expect(
      app.query(`UPDATE ledger.mission_timing SET at = now()`),
    ).rejects.toThrow(/append-only/);
    await expect(
      markMissionPhase(app, mission, 'nonsense' as never),
    ).rejects.toThrow();
  });

  it('exports JSONL with no secret material and one line per stored row', async () => {
    const secret = process.env.OPENAI_API_KEY;
    const result = await exportTelemetryJsonl(app, {
      missionId,
      root: dir,
      secrets: [secret, process.env.CRUSOE_API_KEY],
    });
    expect(result.path).toBe(
      path.join(
        dir,
        'artifacts',
        'nemodots',
        'telemetry',
        `telemetry-${missionId}.jsonl`,
      ),
    );
    const text = await readFile(result.path, 'utf8');
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(result.lines);
    const kinds = lines.map((line) => line.kind);
    // 5 attempts for the mission (1 + 2 + 1 recorded, 1 orphaned) + 1 span + the marks of this mission (none)
    expect(kinds.filter((k) => k === 'inference_attempt')).toHaveLength(5);
    expect(kinds.filter((k) => k === 'tool_span')).toHaveLength(1);
    expect(
      lines.filter(
        (l) => l.kind === 'inference_attempt' && l.outcome === 'orphaned_fence',
      ),
    ).toHaveLength(1);
    // the stored null stays null in the export
    expect(
      lines.find(
        (l) => l.kind === 'inference_attempt' && l.usage.cachedTokens === null,
      ),
    ).toBeDefined();
    // the grep the acceptance names: nothing key-shaped, no bearer, no key prefix
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/Bearer/i);
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    if (secret && secret.length >= 6) expect(text).not.toContain(secret);
    expect(text).not.toContain(secret?.slice(0, 6) ?? '\u0000\u0000');
  });

  it('refuses to write an export that would contain a secret and leaves no file', async () => {
    const poisoned = randomUUID();
    await recordToolSpan(app, {
      missionId: poisoned,
      taskId: randomUUID(),
      attemptId: randomUUID(),
      toolCallId: 'c',
      toolName: 'sk-abcdefghijklmnop', // a key-shaped value smuggled into a name
      startedAt: at(0),
      finishedAt: at(1),
      outcome: 'ok',
      argumentsDigest: sha256Hex('a'),
    });
    await expect(
      exportTelemetryJsonl(app, { missionId: poisoned, root: dir }),
    ).rejects.toThrow(TelemetryRedactionError);
    await expect(
      readFile(
        path.join(
          dir,
          'artifacts',
          'nemodots',
          'telemetry',
          `telemetry-${poisoned}.jsonl`,
        ),
      ),
    ).rejects.toThrow(/ENOENT/);
  });
});
