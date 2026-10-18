// Fixture for the action-boundary integration suites: a fresh migrated test
// database (all of 0001-0005), the seeded checkout authority, a real Redis
// prefix and the REAL ledger, coordinator tables and sandbox version
// authority. Nothing here replaces the code under test; the only rows written
// by hand are the mission / task / attempt triple an action needs to hang off
// (the coordinator package owns their lifecycle) and the writes of the
// "other writers" the races need (injector, owner).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  createActions,
  type Actions,
  type EffectRedis,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  digest,
  sha256Hex,
  type ActionIntent,
  type AttemptContext,
  type ContextSnapshot,
  type InferenceAttempt,
  type ModelCallRecord,
  type ObservationReceipt,
  type SourceRef,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  recordModelCall,
  registerObservation,
  createSupportValidator,
} from '../../../../src/server/nemodots/ledger/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import {
  advanceConfigUnconditionallyTx,
  type ConfigScalar,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis, type TestRedis } from '../../helpers/test-redis.js';

process.env.NEMODOTS_TEST_HOOKS = '1';

const LEDGER = { events: createEventSink() };

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface CountingRedis extends EffectRedis {
  /** Redis commands issued by SCAN/UNLINK inside the script cannot be seen from the client; the script's own result counts them. */
  evalCalls: number;
  /** When set, the next eval performs the script and then throws (a lost response). */
  loseNextResponse: boolean;
  /** When set, eval throws before reaching Redis. */
  failNext: boolean;
}

export interface Env {
  db: TestDatabase;
  redis: TestRedis;
  admin: pg.Pool;
  app: pg.Pool;
  actions: Actions;
  effectRedis: CountingRedis;
  prefix: string;
  config: { dispatchLeaseMs: number };
}

export interface EnvOptions {
  dispatchLeaseMs?: number;
  noRedis?: boolean;
}

export async function withEnv<T>(
  fn: (env: Env) => Promise<T>,
  options: EnvOptions = {},
): Promise<T> {
  return withTestDatabase(async (db) =>
    withTestRedis(async (redis) => {
      const admin = new pg.Pool({ connectionString: db.urls.admin, max: 4 });
      const app = new pg.Pool({ connectionString: db.urls.app, max: 8 });
      for (const pool of [admin, app]) pool.on('error', () => {});
      try {
        await seedCheckout(admin);
        const effectRedis: CountingRedis = {
          evalCalls: 0,
          loseNextResponse: false,
          failNext: false,
          async eval(script, opts) {
            effectRedis.evalCalls += 1;
            if (effectRedis.failNext) {
              effectRedis.failNext = false;
              throw new Error('redis connection refused');
            }
            const reply = await redis.client.eval(script, {
              keys: opts.keys,
              arguments: opts.arguments,
            });
            if (effectRedis.loseNextResponse) {
              effectRedis.loseNextResponse = false;
              throw new Error('redis response lost (timeout)');
            }
            return reply;
          },
          async get(key) {
            return redis.client.get(key);
          },
        };
        const config = { dispatchLeaseMs: options.dispatchLeaseMs ?? 30_000 };
        const actions = createActions({
          pool: app,
          validator: createSupportValidator(),
          events: createEventSink(),
          redis: options.noRedis ? null : effectRedis,
          redisPrefix: redis.prefix,
          dispatchLeaseMs: config.dispatchLeaseMs,
        });
        return await fn({
          db,
          redis,
          admin,
          app,
          actions,
          effectRedis,
          prefix: redis.prefix,
          config,
        });
      } finally {
        await Promise.all([admin.end(), app.end()]);
      }
    }),
  );
}

// ------------------------------------------------------------------ worlds

export interface World {
  ownerId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
  ctx: AttemptContext;
}

const ALL_CAPABILITIES = [
  'observe',
  'delegate',
  'publish_finding',
  'propose_config_change',
  'propose_cache_flush',
] as const;

export async function createWorld(
  env: Env,
  options: {
    capabilities?: readonly string[];
    admissionMinAgeMs?: number;
  } = {},
): Promise<World> {
  const ownerId = `owner-${randomUUID()}`;
  const missionId = randomUUID();
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const capabilities = options.capabilities ?? ALL_CAPABILITIES;
  await env.admin.query(
    `INSERT INTO coordinator.missions
       (id, owner_id, environment, resource, goal, mode, status, generation, budgets, provider, admission_min_age_ms)
     VALUES ($1, $2, 'test', 'checkout', 'restore checkout', 'fixture', 'running', 0, '{}'::jsonb, '{}'::jsonb, $3)`,
    [missionId, ownerId, options.admissionMinAgeMs ?? 0],
  );
  await env.admin.query(
    `INSERT INTO coordinator.tasks
       (id, mission_id, depth, ordinal, title, question, role, capabilities, status, generation, fence_seq, budget)
     VALUES ($1, $2, 0, 0, 'fix it', 'what is wrong', 'cache_specialist', $3::text[], 'running', 0, 1, '{}'::jsonb)`,
    [taskId, missionId, [...capabilities]],
  );
  await env.admin.query(
    `INSERT INTO coordinator.task_attempts
       (id, task_id, mission_id, n, kind, status, generation, lease_owner, fencing_token, lease_expires_at, lease_renewed_at)
     VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'worker', 1, now() + interval '1 hour', now())`,
    [attemptId, taskId, missionId],
  );
  return {
    ownerId,
    missionId,
    taskId,
    attemptId,
    ctx: {
      missionId,
      taskId,
      attemptId,
      fencingToken: 1,
      generation: 0,
      capabilities: [...capabilities],
      role: 'cache_specialist',
    } as unknown as AttemptContext,
  };
}

export function sourceRef(world: World, key: string): SourceRef {
  const sourceType =
    key === 'checkout.config'
      ? 'controlled_collection'
      : key.startsWith('checkout.config/')
        ? 'controlled_config'
        : 'observed_endpoint';
  return {
    key,
    sourceType,
    authority: sourceType === 'observed_endpoint' ? 'observed' : 'controlled',
    scope: {
      ownerId: world.ownerId,
      missionId: world.missionId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
  } as unknown as SourceRef;
}

/** The live authority row of a config key. */
export async function liveConfig(env: Env, key: string) {
  const { rows } = await env.admin.query<{ value: unknown; version: string }>(
    'SELECT value, version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  return rows[0]
    ? { value: rows[0].value as ConfigScalar, version: Number(rows[0].version) }
    : null;
}

/**
 * The watcher's job for a controlled member: read the authority row and
 * register it. `marker: null` skips the closure's marks on coordinator rows
 * (used where a test wants the commit predicates, not the closure, to be the
 * thing that rejects).
 */
export async function observeMember(
  env: Env,
  world: World,
  key: string,
  options: { marker?: null } = {},
): Promise<ObservationReceipt> {
  const row = await liveConfig(env, key);
  if (!row) throw new Error(`no config row ${key}`);
  const result = await withTransaction(env.app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(world, `checkout.config/${key}`),
        normalizedValue: { key, value: row.value, version: row.version },
        provenance: { kind: 'watcher' },
      },
      options.marker === null
        ? { marker: null, ledger: LEDGER }
        : { ledger: LEDGER },
    ),
  );
  return result.receipt;
}

export async function observeObserved(
  env: Env,
  world: World,
  key: string,
  value: unknown,
  options: { marker?: null; observedAt?: Date } = {},
): Promise<ObservationReceipt> {
  const result = await withTransaction(env.app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(world, key),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
        observedAt: options.observedAt,
      },
      options.marker === null
        ? { marker: null, ledger: LEDGER }
        : { ledger: LEDGER },
    ),
  );
  return result.receipt;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function inferenceAttempt(): InferenceAttempt {
  return {
    n: 1,
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
  };
}

/** Records the model call that emits `toolCallId` and reads `receipts` (its snapshot vector). */
export async function emitCall(
  env: Env,
  world: World,
  receipts: readonly ObservationReceipt[],
  toolCallId = `call_${randomUUID().slice(0, 8)}`,
): Promise<{ modelCallId: string; toolCallId: string }> {
  const sorted = [...receipts].sort((a, b) =>
    a.source.key < b.source.key ? -1 : a.source.key > b.source.key ? 1 : 0,
  );
  const vector = sorted.map((r) => ({
    sourceKey: r.source.key,
    sourceRevision: r.sourceRevision,
    receiptId: r.id,
  }));
  const snapshot = {
    id: randomUUID(),
    contextSchemaVersion: 'v1',
    layout: 'cache_aware',
    prefixDigest: sha256Hex('prefix'),
    prefixLength: 100,
    contextDigest: sha256Hex(`context-${randomUUID()}`),
    contextLength: 400,
    toolSchemaHash: sha256Hex('tools'),
    injected: {
      receipts: sorted.map((r) => ({
        id: r.id,
        sourceKey: r.source.key,
        sourceRevision: r.sourceRevision,
        contentDigest: r.contentDigest,
      })),
      inheritedArtifacts: [],
      runbooks: [],
      pageSnapshots: [],
      memories: [],
      invalidationEvents: [],
      historyItems: [],
    },
    dependencyVector: vector,
    volatile: { nowIso: iso() },
  } as unknown as ContextSnapshot;
  const modelCallId = randomUUID();
  const record = {
    id: modelCallId,
    scope: {
      ownerId: world.ownerId,
      missionId: world.missionId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
    taskId: world.taskId,
    attemptId: world.attemptId,
    role: 'worker',
    model: {
      requested: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      returned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    },
    provider: { host: 'api.inference.crusoecloud.com', mode: 'live' },
    contextSnapshotId: snapshot.id,
    attempts: [inferenceAttempt()],
    outcome: 'tool_calls',
    outputDigest: sha256Hex('out'),
    outputDependencyVector: vector,
    toolCalls: [
      {
        toolCallId,
        name: 'propose_action',
        argumentsDigest: sha256Hex('{}'),
      },
    ],
    createdAt: iso(),
  } as unknown as ModelCallRecord;
  await withTransaction(env.app, (client) =>
    recordModelCall(client, { record, snapshot }),
  );
  return { modelCallId, toolCallId };
}

export interface Scenario {
  world: World;
  member: ObservationReceipt;
  health: ObservationReceipt;
  call: { modelCallId: string; toolCallId: string };
  /** set_config payload bound to the value read at observation time */
  payload: {
    key: string;
    value: ConfigScalar;
    expectedCurrentValueDigest: string;
  };
  intent: ActionIntent;
}

/** world + receipts + emitting call + a proposed set_config intent. */
export async function proposeSetConfig(
  env: Env,
  options: {
    key?: string;
    value?: ConfigScalar;
    world?: World;
    toolCallId?: string;
    cite?: boolean;
  } = {},
): Promise<Scenario> {
  const world = options.world ?? (await createWorld(env));
  const key = options.key ?? 'db.pool_max';
  const value = options.value ?? 20;
  const member = await observeMember(env, world, key);
  const health = await observeObserved(env, world, 'checkout.health', {
    status: 'ok',
  });
  const call = await emitCall(env, world, [member, health], options.toolCallId);
  const current = await liveConfig(env, key);
  const payload = {
    key,
    value,
    expectedCurrentValueDigest: digest(current!.value),
  };
  const intent = await env.actions.propose(
    {
      action: 'set_config',
      payload,
      supportingReceiptIds: options.cite === false ? [] : [member.id],
      rationale: 'pool starvation: raise the connection pool',
    } as never,
    { ...world.ctx, ...call } as never,
  );
  return { world, member, health, call, payload, intent };
}

/** An injector-style write: advances a key without any ledger involvement. */
export async function injectConfig(env: Env, key: string, value: ConfigScalar) {
  return advanceConfigUnconditionallyTx(env.admin, {
    key,
    value,
    causedBy: { actor: 'injector' },
  });
}

export async function intentRow(env: Env, id: string) {
  const { rows } = await env.admin.query(
    'SELECT * FROM coordinator.action_intents WHERE id = $1',
    [id],
  );
  return rows[0];
}

export async function authorizations(env: Env, actionId: string) {
  const { rows } = await env.admin.query(
    'SELECT * FROM coordinator.authorizations WHERE action_id = $1 ORDER BY decided_at, id',
    [actionId],
  );
  return rows as {
    stage: string;
    decision: string;
    block_reason: string | null;
    idempotency_binding: string;
  }[];
}

export async function receiptsOf(env: Env, actionId: string) {
  const { rows } = await env.admin.query(
    'SELECT * FROM coordinator.result_receipts WHERE action_id = $1',
    [actionId],
  );
  return rows;
}

export async function configVersions(env: Env, key: string) {
  const { rows } = await env.admin.query(
    'SELECT version, value, caused_by_action_id, caused_by_actor, before_digest, after_digest FROM checkout.config_versions WHERE key = $1 ORDER BY version',
    [key],
  );
  return rows.map((row) => ({ ...row, version: Number(row.version) }));
}

export async function count(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
) {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

/** Resolves once some backend waits on a lock (pg_locks is visible to every role). */
export async function waitForLockWaiter(pool: pg.Pool, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      'SELECT 1 FROM pg_locks WHERE NOT granted LIMIT 1',
    );
    if (waiting.rows.length) return;
    await sleep(15);
  }
  throw new Error('no backend ever waited for a lock');
}

/** Admit then return the fence. */
export async function admitIntent(env: Env, sc: Scenario, dispatcher = 'd1') {
  const admitted = await env.actions.admit(sc.intent.id, dispatcher);
  return { admitted, fence: admitted.dispatch?.fence as number };
}

/** A flush scenario: namespace member + redis.stats receipts, a proposed flush. */
export async function proposeFlush(
  env: Env,
  options: { world?: World; namespace?: string; toolCallId?: string } = {},
) {
  const world = options.world ?? (await createWorld(env));
  const member = await observeMember(env, world, 'cache.namespace');
  const stats = await observeObserved(env, world, 'redis.stats', {
    namespaces: { 'catalog-a:v1': 3 },
  });
  const call = await emitCall(env, world, [member, stats], options.toolCallId);
  const intent = await env.actions.propose(
    {
      action: 'flush_cache_namespace',
      payload: {
        namespace: options.namespace ?? 'catalog-a',
        reason: 'entries under the wrong schema',
      },
      supportingReceiptIds: [member.id],
      rationale: 'flush the poisoned namespace',
    } as never,
    { ...world.ctx, ...call } as never,
  );
  return { world, member, stats, call, intent };
}

/** Seeds cache keys under the harness prefix and returns their names. */
export async function seedCacheKeys(
  env: Env,
  namespace: string,
  count: number,
  schema = 1,
) {
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = `${env.prefix}:cache:${namespace}:v${schema}:item-${i}`;
    await env.redis.client.set(key, JSON.stringify({ i }));
    keys.push(key);
  }
  return keys;
}

export async function scanCount(env: Env, namespace: string) {
  let found = 0;
  for await (const batch of env.redis.client.scanIterator({
    MATCH: `${env.prefix}:cache:${namespace}:*`,
    COUNT: 200,
  }))
    found += Array.isArray(batch) ? batch.length : 1;
  return found;
}
