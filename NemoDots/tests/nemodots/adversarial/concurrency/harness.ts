// W5.2 concurrency adversary fixture. Written independently of the builders'
// harnesses: a fresh migrated database per test (helpers/test-db.ts), the seeded
// checkout authority, a Redis prefix, and the REAL actions, ledger, coordinator
// and version-authority code. The only rows written by hand are the mission /
// task / attempt triple an intent hangs off; "other writers" use their own
// roles (the injector writes with the nemodots_injector role).
//
// Expectations in the suites come from ARCHITECTURE.md sections 4-8 and
// CONTRACTS.md, never from these helpers.
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
  type ModelCallRecord,
  type ObservationReceipt,
  type SourceRef,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  createSupportValidator,
  recordModelCall,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import {
  advanceConfigUnconditionallyTx,
  type ConfigScalar,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis, type TestRedis } from '../../helpers/test-redis.js';

process.env.NEMODOTS_TEST_HOOKS = '1';

export const LEDGER = { events: createEventSink() };

/** Every retryable SQLSTATE a wrapped pool's statements raised (40P01, 40001). */
export interface Conflicts {
  deadlocks: number;
  serialization: number;
}

/**
 * Wraps a pool so that every statement error with SQLSTATE 40P01 / 40001 is
 * counted. withTransaction retries both silently, so this is the only way to
 * see that a deadlock happened at all.
 */
function instrument(pool: pg.Pool, conflicts: Conflicts): pg.Pool {
  const record = (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    if (code === '40P01') conflicts.deadlocks += 1;
    if (code === '40001') conflicts.serialization += 1;
  };
  // Every pooled client is created through the pool's 'connect' event; both
  // the promise and the callback form of client.query are wrapped.
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        const callback = last as (error: unknown, ...rest: unknown[]) => void;
        return query(
          ...args.slice(0, -1),
          (error: unknown, ...rest: unknown[]) => {
            if (error) record(error);
            callback(error, ...rest);
          },
        );
      }
      const result = query(...args);
      if (result && typeof (result as Promise<unknown>).then === 'function')
        return (result as Promise<unknown>).catch((error: unknown) => {
          record(error);
          throw error;
        });
      return result;
    };
  });
  return pool;
}

export interface CountingRedis extends EffectRedis {
  evalCalls: number;
  /** The next eval runs the script and then throws (a lost acknowledgement). */
  loseNextResponse: boolean;
  /** The next eval throws before reaching Redis. */
  failNext: boolean;
}

export interface Env {
  db: TestDatabase;
  redis: TestRedis;
  admin: pg.Pool;
  app: pg.Pool;
  injector: pg.Pool;
  actions: Actions;
  effectRedis: CountingRedis;
  prefix: string;
  conflicts: Conflicts;
  dispatchLeaseMs: number;
}

export interface EnvOptions {
  dispatchLeaseMs?: number;
  /** default_transaction_isolation of the app pool (all actions/ledger/coordinator transactions). */
  isolation?: 'read committed' | 'serializable';
}

export async function withEnv<T>(
  fn: (env: Env) => Promise<T>,
  options: EnvOptions = {},
): Promise<T> {
  return withTestDatabase(async (db) =>
    withTestRedis(async (redis) => {
      const conflicts: Conflicts = { deadlocks: 0, serialization: 0 };
      const admin = new pg.Pool({ connectionString: db.urls.admin, max: 4 });
      const app = instrument(
        new pg.Pool({
          connectionString: db.urls.app,
          max: 12,
          options:
            options.isolation === 'serializable'
              ? '-c default_transaction_isolation=serializable'
              : undefined,
        }),
        conflicts,
      );
      const injector = instrument(
        new pg.Pool({ connectionString: db.urls.injector, max: 4 }),
        conflicts,
      );
      for (const pool of [admin, app, injector]) pool.on('error', () => {});
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
              throw new Error('redis acknowledgement lost');
            }
            return reply;
          },
          get: (key) => redis.client.get(key),
        };
        const dispatchLeaseMs = options.dispatchLeaseMs ?? 30_000;
        const actions = createActions({
          pool: app,
          validator: createSupportValidator(),
          events: createEventSink(),
          redis: effectRedis,
          redisPrefix: redis.prefix,
          dispatchLeaseMs,
        });
        return await fn({
          db,
          redis,
          admin,
          app,
          injector,
          actions,
          effectRedis,
          prefix: redis.prefix,
          conflicts,
          dispatchLeaseMs,
        });
      } finally {
        await Promise.all([admin.end(), app.end(), injector.end()]);
      }
    }),
  );
}

// ------------------------------------------------------------------- world

export interface World {
  ownerId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
  spaceId: string | null;
  ctx: AttemptContext;
}

const CAPABILITIES = [
  'observe',
  'delegate',
  'publish_finding',
  'propose_config_change',
  'propose_cache_flush',
];

/** A running mission with one running task and attempt (fence 1, generation 0). */
export async function createWorld(
  env: Env,
  options: { ownerId?: string; spaceId?: string | null } = {},
): Promise<World> {
  const ownerId = options.ownerId ?? `owner-${randomUUID()}`;
  const spaceId = options.spaceId ?? null;
  const missionId = randomUUID();
  const taskId = randomUUID();
  const attemptId = randomUUID();
  await env.admin.query(
    `INSERT INTO coordinator.missions
       (id, owner_id, space_id, environment, resource, goal, mode, status, generation, budgets, provider, admission_min_age_ms)
     VALUES ($1, $2, $3, 'test', 'checkout', 'restore checkout', 'fixture', 'running', 0, '{}'::jsonb, '{}'::jsonb, 0)`,
    [missionId, ownerId, spaceId],
  );
  await env.admin.query(
    `INSERT INTO coordinator.tasks
       (id, mission_id, depth, ordinal, title, question, role, capabilities, status, generation, fence_seq, budget)
     VALUES ($1, $2, 0, 0, 'fix it', 'what is wrong', 'cache_specialist', $3::text[], 'running', 0, 1, '{}'::jsonb)`,
    [taskId, missionId, CAPABILITIES],
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
    spaceId,
    ctx: {
      missionId,
      taskId,
      attemptId,
      fencingToken: 1,
      generation: 0,
      capabilities: [...CAPABILITIES],
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
      spaceId: world.spaceId,
      environment: 'test',
      resource: 'checkout',
    },
  } as unknown as SourceRef;
}

export async function liveConfig(env: Env, key: string) {
  const { rows } = await env.admin.query<{ value: unknown; version: string }>(
    'SELECT value, version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  return rows[0]
    ? { value: rows[0].value as ConfigScalar, version: Number(rows[0].version) }
    : null;
}

/** Registers the live authority row of a member (the watcher's job). */
export async function observeMember(
  env: Env,
  world: World,
  key: string,
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
      { ledger: LEDGER },
    ),
  );
  return result.receipt;
}

export async function observeObserved(
  env: Env,
  world: World,
  key: string,
  value: unknown,
) {
  return withTransaction(env.app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(world, key),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
      },
      { ledger: LEDGER },
    ),
  );
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export interface EmittedCall {
  modelCallId: string;
  toolCallId: string;
}

/**
 * Records the model call (snapshot = `receipts`) that emitted one
 * `propose_action` tool call whose arguments digest is `argumentsDigest`.
 */
export async function emitCall(
  env: Env,
  world: World,
  receipts: readonly ObservationReceipt[],
  options: { toolCallId?: string; argumentsDigest?: string } = {},
): Promise<EmittedCall> {
  const toolCallId = options.toolCallId ?? `call_${randomUUID().slice(0, 8)}`;
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
      spaceId: world.spaceId,
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
    attempts: [
      {
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
      },
    ],
    outcome: 'tool_calls',
    outputDigest: sha256Hex('out'),
    outputDependencyVector: vector,
    toolCalls: [
      {
        toolCallId,
        name: 'propose_action',
        argumentsDigest: options.argumentsDigest ?? sha256Hex('{}'),
      },
    ],
    createdAt: iso(),
  } as unknown as ModelCallRecord;
  await withTransaction(env.app, (client) =>
    recordModelCall(client, { record, snapshot }),
  );
  return { modelCallId, toolCallId };
}

export function setConfigInput(
  key: string,
  value: ConfigScalar,
  currentValue: unknown,
  cite: readonly string[],
) {
  return {
    action: 'set_config',
    payload: { key, value, expectedCurrentValueDigest: digest(currentValue) },
    supportingReceiptIds: [...cite],
    rationale: 'adversarial reproduction',
  };
}

export interface SetConfigScenario {
  world: World;
  member: ObservationReceipt;
  health: ObservationReceipt;
  call: EmittedCall;
  input: ReturnType<typeof setConfigInput>;
  intent: ActionIntent;
}

/** World + member and health receipts + emitting call + a proposed set_config. */
export async function proposeSetConfig(
  env: Env,
  options: {
    key?: string;
    value?: ConfigScalar;
    world?: World;
    extraReceipts?: ObservationReceipt[];
  } = {},
): Promise<SetConfigScenario> {
  const world = options.world ?? (await createWorld(env));
  const key = options.key ?? 'db.pool_max';
  const member = await observeMember(env, world, key);
  const health = (
    await observeObserved(env, world, 'checkout.health', { status: 'ok' })
  ).receipt;
  const current = await liveConfig(env, key);
  const input = setConfigInput(key, options.value ?? 20, current!.value, [
    member.id,
  ]);
  const call = await emitCall(
    env,
    world,
    [member, health, ...(options.extraReceipts ?? [])],
    { argumentsDigest: digest(input) },
  );
  const intent = await env.actions.propose(
    input as never,
    { ...world.ctx, ...call } as never,
  );
  return { world, member, health, call, input, intent };
}

export async function proposeFlush(
  env: Env,
  options: { world?: World; namespace?: string } = {},
) {
  const world = options.world ?? (await createWorld(env));
  const member = await observeMember(env, world, 'cache.namespace');
  const stats = (
    await observeObserved(env, world, 'redis.stats', {
      namespaces: { 'catalog-a:v1': 3 },
    })
  ).receipt;
  const input = {
    action: 'flush_cache_namespace',
    payload: {
      namespace: options.namespace ?? 'catalog-a',
      reason: 'entries under the wrong schema',
    },
    supportingReceiptIds: [member.id],
    rationale: 'adversarial reproduction',
  };
  const call = await emitCall(env, world, [member, stats], {
    argumentsDigest: digest(input),
  });
  const intent = await env.actions.propose(
    input as never,
    { ...world.ctx, ...call } as never,
  );
  return { world, member, stats, call, input, intent };
}

/** An injector write with the injector role: no ledger involvement. */
export function injectConfig(env: Env, key: string, value: ConfigScalar) {
  return advanceConfigUnconditionallyTx(env.injector, {
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
  return rows[0] as Record<string, unknown> & {
    status: string;
    block_reason: string | null;
    failure_reason: string | null;
    dispatch_fence: number | null;
  };
}

export async function authorizations(env: Env, actionId: string) {
  const { rows } = await env.admin.query<{
    stage: string;
    decision: string;
    block_reason: string | null;
  }>(
    'SELECT stage, decision, block_reason FROM coordinator.authorizations WHERE action_id = $1 ORDER BY decided_at, id',
    [actionId],
  );
  return rows;
}

export async function configVersions(env: Env, key: string) {
  const { rows } = await env.admin.query(
    `SELECT version, value, caused_by_action_id, caused_by_actor
       FROM checkout.config_versions WHERE key = $1 ORDER BY version`,
    [key],
  );
  return rows.map((row) => ({ ...row, version: Number(row.version) })) as {
    version: number;
    value: unknown;
    caused_by_action_id: string | null;
    caused_by_actor: string;
  }[];
}

export async function count(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
) {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

/**
 * Resolves once `n` backends of this test database wait on a lock. This is
 * the barrier condition for "transaction B is now blocked behind A"; it polls
 * pg_locks, it never assumes that time passing means progress.
 */
export async function waitForLockWaiters(
  env: Env,
  n = 1,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await env.admin.query<{ n: string }>(
      `SELECT count(DISTINCT l.pid) AS n
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (Number(rows[0].n) >= n) return;
    if (Date.now() > deadline)
      throw new Error(`fewer than ${n} backend(s) ever waited for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once the database clock is strictly past `instant`. */
export async function waitForDbClockPast(env: Env, instant: Date) {
  for (;;) {
    const { rows } = await env.admin.query<{ past: boolean }>(
      'SELECT clock_timestamp() > $1::timestamptz AS past',
      [instant],
    );
    if (rows[0].past) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Settles `promise` into a tagged result so a test can assert on errors. */
export async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}
