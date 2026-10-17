// Composition of the REAL coordinator publication path over the REAL ledger,
// written by the verifier (no bootstrap.ts exists yet): the coordinator's
// publish.ts functions are called with the ledger's own SupportValidator and
// model-call/edge writers injected through the ports the coordinator defines.
// Attempts, tasks and missions are seeded as claimAttempt would have left
// them (setup only); the publication under test always goes through
// coordinator/publish.ts.
//
// Observed results are read with SQL by the tests, never from return values.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  allowedCapabilities,
  sha256Hex,
  type AttemptContext,
  type ContextSnapshot,
  type DependencyVector,
  type InferenceAttempt,
  type ModelCallRecord,
  type TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  compileContext,
  type CompileContextInput,
  type ContextReceipt,
} from '../../../../src/server/nemodots/context/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import type { PublishDeps } from '../../../../src/server/nemodots/coordinator/publish.js';
import { addEdges } from '../../../../src/server/nemodots/ledger/edges.js';
import {
  recordModelCall as ledgerRecordModelCall,
  recordOrphanedAttempt as ledgerRecordOrphanedAttempt,
} from '../../../../src/server/nemodots/ledger/model-calls.js';
import { createSupportValidator } from '../../../../src/server/nemodots/ledger/support.js';
import type { World } from './driver.js';
import { OWNER_ID } from './driver.js';

export const BUDGETS = {
  maxTasks: 24,
  maxDepth: 3,
  maxBreadth: 4,
  maxTokens: 200_000,
  maxInferenceCalls: 200,
  maxWallClockMs: 600_000,
};

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The ports the composition root will inject, bound to the real ledger. */
export function composeDeps(w: World): PublishDeps {
  return {
    pool: w.app,
    config: {
      ownerId: OWNER_ID,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
      mode: 'fixture',
      provider: {
        host: 'fixture.local',
        plannerModel: 'fx',
        workerModel: 'fx',
      },
      budgets: BUDGETS,
      leaseMs: 30_000,
      taskDefaults: { maxAttempts: 3, maxIterations: 8, maxTokens: 20_000 },
      replanCap: 3,
    },
    events: createEventSink(),
    // Harness self-check ONLY (ACC1_SELFCHECK_BYPASS_SUPPORT=1): proves the tests turn red when the final
    // version check is bypassed in the publication path while ledger/support.ts itself is untouched.
    supportValidator:
      process.env.ACC1_SELFCHECK_BYPASS_SUPPORT === '1'
        ? { assertCurrent: async () => [] }
        : createSupportValidator(),
    ledger: {
      async recordModelCall(client, input) {
        await ledgerRecordModelCall(client, {
          record: input.record,
          snapshot: input.snapshot,
        });
      },
      async recordArtifact(client, artifact) {
        // Evidence edges receipt -> artifact and attempt -> artifact. The graph has no node kind for findings.
        if (artifact.kind === 'finding') return;
        const to = {
          kind: artifact.kind,
          id: artifact.id,
          missionId: artifact.missionId,
          taskId: artifact.taskId,
        } as const;
        await addEdges(client, [
          ...artifact.dependencyVector.map((entry) => ({
            kind: 'evidence' as const,
            from: { kind: 'receipt' as const, id: entry.receiptId },
            to,
          })),
          {
            kind: 'evidence' as const,
            from: {
              kind: 'attempt' as const,
              id: artifact.attemptId,
              missionId: artifact.missionId,
              taskId: artifact.taskId,
            },
            to,
          },
        ]);
      },
    },
    async recordOrphanedAttempt(info) {
      const client = await w.app.connect();
      try {
        await client.query('BEGIN');
        await ledgerRecordOrphanedAttempt(client, {
          modelCallId: info.record.id,
          scope: info.record.scope,
          taskId: info.record.taskId,
          attemptId: info.record.attemptId,
          role: info.record.role,
          model: info.record.model,
          provider: info.record.provider,
          attempts: info.record.attempts,
        } as never);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    // coordinator.action_intents belongs to the actions wave; no intent is involved in a publication refusal.
    intents: {
      async find() {
        return null;
      },
      async statuses() {
        return [];
      },
      async committedEffects() {
        return [];
      },
    },
    clock: () => new Date(),
  };
}

// ----------------------------------------------------------------- seeding

export interface SeededAttempt {
  ctx: AttemptContext;
  missionId: string;
  taskId: string;
  attemptId: string;
  parentTaskId: string | null;
}

export async function seedMission(
  w: World,
  over: {
    id?: string;
    ownerId?: string;
    environment?: string;
    resource?: string;
    spaceId?: string | null;
  } = {},
): Promise<string> {
  const id = over.id ?? randomUUID();
  await w.admin.query(
    `INSERT INTO coordinator.missions (id, owner_id, space_id, environment, resource, goal, mode, status, generation, budgets, provider)
     VALUES ($1, $2, $3, $4, $5, 'acceptance goal', 'fixture', 'running', 0, $6::jsonb, $7::jsonb)`,
    [
      id,
      over.ownerId ?? OWNER_ID,
      over.spaceId ?? null,
      over.environment ?? 'test',
      over.resource ?? 'checkout',
      JSON.stringify(BUDGETS),
      JSON.stringify({
        host: 'fixture.local',
        plannerModel: 'fx',
        workerModel: 'fx',
      }),
    ],
  );
  return id;
}

async function nextOrdinal(w: World, missionId: string): Promise<number> {
  const r = await w.admin.query(
    'SELECT coalesce(max(ordinal), -1) + 1 AS n FROM coordinator.tasks WHERE mission_id = $1',
    [missionId],
  );
  return Number(r.rows[0].n);
}

export interface SeedTaskOptions {
  id?: string;
  role?: TaskRole;
  capabilities?: string[];
  status?: string;
  parentId?: string | null;
  depth?: number;
  prerequisites?: string[];
  fenceSeq?: number;
}

/** A task row as the coordinator would have left it (setup only). */
export async function seedTask(
  w: World,
  missionId: string,
  o: SeedTaskOptions = {},
): Promise<string> {
  const id = o.id ?? randomUUID();
  const role = o.role ?? 'investigator';
  const capabilities = o.capabilities ?? [...allowedCapabilities(role, null)];
  const parentId = o.parentId ?? null;
  await w.admin.query(
    `INSERT INTO coordinator.tasks (id, mission_id, parent_id, depth, ordinal, title, question, role, capabilities, status, generation,
                                    prerequisites, fence_seq, attempt_count, budget, justification)
     VALUES ($1, $2, $3, $4, $5, 'acc task', 'acc question', $6, $7::text[], $8, 0, $9::uuid[], $10, $11,
             '{"maxIterations":8,"maxTokens":20000,"maxChildren":4}'::jsonb, $12)`,
    [
      id,
      missionId,
      parentId,
      o.depth ?? (parentId ? 1 : 0),
      await nextOrdinal(w, missionId),
      role,
      capabilities,
      o.status ?? 'running',
      o.prerequisites ?? [],
      o.fenceSeq ?? 1,
      (o.fenceSeq ?? 1) > 0 ? 1 : 0,
      parentId ? 'acceptance justification' : null,
    ],
  );
  return id;
}

export async function seedAttemptRow(
  w: World,
  missionId: string,
  taskId: string,
  o: { n?: number; status?: string; token?: number; kind?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await w.admin.query(
    `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner, fencing_token, lease_expires_at, lease_renewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 'acc1-worker', $7, now() + interval '1 hour', now())`,
    [
      id,
      taskId,
      missionId,
      o.n ?? 1,
      o.kind ?? 'initial',
      o.status ?? 'running',
      o.token ?? 1,
    ],
  );
  return id;
}

/**
 * A running attempt with an unexpired lease, in a running mission. With
 * `child` the task is a delegated child of a waiting root, so an invalidation
 * of its attempt does not trigger the root-task replan path.
 */
export async function seedAttempt(
  w: World,
  o: {
    missionId?: string;
    role?: TaskRole;
    capabilities?: string[];
    child?: boolean;
  } = {},
): Promise<SeededAttempt> {
  const missionId = o.missionId ?? (await seedMission(w));
  let parentTaskId: string | null = null;
  const role = o.role ?? 'investigator';
  if (o.child !== false) {
    parentTaskId = await seedTask(w, missionId, {
      role: 'investigator',
      status: 'waiting',
      fenceSeq: 0,
    });
  }
  const taskId = await seedTask(w, missionId, {
    role,
    capabilities: o.capabilities,
    parentId: parentTaskId,
  });
  const attemptId = await seedAttemptRow(w, missionId, taskId);
  const caps = o.capabilities ?? [...allowedCapabilities(role, null)];
  return {
    ctx: {
      missionId,
      taskId,
      attemptId,
      fencingToken: 1,
      generation: 0,
      capabilities: caps,
      role,
    } as AttemptContext,
    missionId,
    taskId,
    attemptId,
    parentTaskId,
  };
}

// --------------------------------------------------------------- row counts

export const COUNTED_TABLES = [
  'coordinator.findings',
  'coordinator.task_outputs',
  'ledger.model_call_records',
  'ledger.context_snapshots',
  'ledger.inference_attempts',
  'ledger.dependency_edges',
] as const;

export async function counts(
  w: World,
  tables: readonly string[] = COUNTED_TABLES,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const r = await w.admin.query(`SELECT count(*)::int AS n FROM ${table}`);
    out[table] = r.rows[0].n;
  }
  return out;
}

export async function taskCount(w: World, missionId: string): Promise<number> {
  return (
    await w.admin.query(
      'SELECT count(*)::int AS n FROM coordinator.tasks WHERE mission_id = $1',
      [missionId],
    )
  ).rows[0].n;
}

export async function childrenOf(w: World, taskId: string): Promise<number> {
  return (
    await w.admin.query(
      'SELECT count(*)::int AS n FROM coordinator.tasks WHERE parent_id = $1',
      [taskId],
    )
  ).rows[0].n;
}

export async function attemptRow(w: World, attemptId: string): Promise<Row> {
  return (
    await w.admin.query(
      'SELECT * FROM coordinator.task_attempts WHERE id = $1',
      [attemptId],
    )
  ).rows[0];
}

export async function invalidationsOf(
  w: World,
  missionId: string,
): Promise<Row[]> {
  return (
    await w.admin.query(
      'SELECT * FROM coordinator.invalidations WHERE mission_id = $1 ORDER BY created_at',
      [missionId],
    )
  ).rows;
}

export async function recoveryOf(w: World, missionId: string): Promise<Row[]> {
  return (
    await w.admin.query(
      'SELECT * FROM coordinator.recovery_events WHERE mission_id = $1 ORDER BY created_at, id',
      [missionId],
    )
  ).rows;
}

// ----------------------------------------------------------- model calls

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export interface ReceiptRef {
  id: string;
  sourceKey: string;
  revision: number;
}

/** Receipts as stored in the ledger, in the shape the context compiler renders. */
export async function loadContextReceipts(
  w: World,
  ids: readonly string[],
): Promise<ContextReceipt[]> {
  const r = await w.admin.query(
    `SELECT r.id, s.key, r.source_revision, r.collection_revision, r.observed_at, r.content_digest, r.normalized_value, r.status, r.trust, r.negative,
            coalesce((SELECT max(c.confirmed_at) FROM ledger.receipt_confirmations c WHERE c.receipt_id = r.id), r.observed_at) AS last_confirmed
       FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id WHERE r.id = ANY($1::uuid[]) ORDER BY s.key, r.source_revision`,
    [ids],
  );
  return r.rows.map((x) => ({
    id: x.id,
    source: { key: x.key },
    sourceRevision: x.source_revision,
    collectionRevision: x.collection_revision,
    observedAt: new Date(x.observed_at).toISOString(),
    lastConfirmedAt: new Date(x.last_confirmed).toISOString(),
    contentDigest: x.content_digest,
    normalizedValue: x.normalized_value,
    status: x.status,
    trust: x.trust,
    negative: x.negative,
  })) as ContextReceipt[];
}

export function vectorOfRefs(refs: readonly ReceiptRef[]): DependencyVector {
  return refs
    .map((r) => ({
      sourceKey: r.sourceKey,
      sourceRevision: r.revision,
      receiptId: r.id,
    }))
    .sort((a, b) =>
      a.sourceKey < b.sourceKey
        ? -1
        : a.sourceKey > b.sourceKey
          ? 1
          : a.sourceRevision - b.sourceRevision ||
            (a.receiptId < b.receiptId ? -1 : 1),
    ) as DependencyVector;
}

function inferenceAttempt(n: number): InferenceAttempt {
  return {
    n,
    startedAt: iso(-2000),
    headersAt: iso(-1500),
    firstContentAt: iso(-1400),
    finishedAt: iso(-1000),
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
  } as InferenceAttempt;
}

/**
 * A model call whose context was compiled by the PRODUCTION compiler from
 * stored receipts. `readSet` receipts are premises read but not necessarily
 * injected; the vector of the call is the compiler's own.
 */
export async function modelCallFor(
  w: World,
  ctx: AttemptContext,
  input: {
    receipts: readonly string[];
    readSet?: readonly ReceiptRef[];
    extra?: Partial<CompileContextInput>;
  },
): Promise<{ record: ModelCallRecord; snapshot: ContextSnapshot }> {
  const receipts = await loadContextReceipts(w, input.receipts);
  const compiled = compileContext({
    snapshotId: randomUUID() as never,
    layout: 'cache_aware',
    nowIso: iso(),
    commonInstructions: 'You are an incident responder.',
    roleInstructions: 'Role: acceptance.',
    task: { title: 'acc task', question: 'acc question' },
    runbooks: [],
    receipts,
    inheritedArtifacts: [],
    pageSnapshots: [],
    memories: [],
    invalidations: [],
    history: [],
    readSetVector: input.readSet ? vectorOfRefs(input.readSet) : [],
    ...input.extra,
  } as CompileContextInput);
  const snapshot = compiled.snapshot;
  const record = {
    id: randomUUID(),
    scope: {
      ownerId: OWNER_ID,
      missionId: ctx.missionId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
    taskId: ctx.taskId,
    attemptId: ctx.attemptId,
    role: 'worker',
    model: {
      requested: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      returned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    },
    provider: { host: 'fixture.local', mode: 'fixture' },
    contextSnapshotId: snapshot.id,
    attempts: [inferenceAttempt(1)],
    outcome: 'tool_calls',
    outputDigest: sha256Hex(`out-${randomUUID()}`),
    outputDependencyVector: snapshot.dependencyVector,
    toolCalls: [
      {
        toolCallId: 'call_1',
        name: 'observe_source',
        argumentsDigest: sha256Hex('{}'),
      },
    ],
    createdAt: iso(),
  } as unknown as ModelCallRecord;
  return { record, snapshot };
}

export type { pg };
