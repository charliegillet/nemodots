// Integration world for the action boundary: a fresh migrated database with
// the REAL ledger (registerObservation, recordModelCall), the REAL version
// authority (advanceConfig), real PostgreSQL row locks and, for flush tests, a
// real Redis prefix. Missions, tasks and attempts are inserted directly (they
// are the coordinator's rows; only their columns matter for the fences).
//
// Roles: everything the server does uses the `app` pool; configuration is
// seeded and externally changed with the `injector` pool (the only role that
// may insert keys, and one that must not be able to set the self-write marker).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach } from 'vitest';
import {
  sha256Hex,
  type ActionIntent,
  type AttemptContext,
  type Capability,
  type ContextSnapshot,
  type ModelCallRecord,
  type ObservationReceipt,
  type ProposeInput,
  type ReceiptId,
  type SourceRef,
  type TaskRole,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  createActionService,
  clearBarriers,
  type ActionDeps,
  type ActionService,
  type RedisEffectClient,
} from '../../../../src/server/nemodots/actions/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  recordModelCall,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  advanceConfigUnconditionally,
  configValueDigest,
  type ConfigScalar,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis, type TestRedis } from '../../helpers/test-redis.js';

process.env.NEMODOTS_TEST_HOOKS = '1';
afterEach(() => clearBarriers());

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const OWNER = 'owner-actions';

export interface World {
  db: TestDatabase;
  app: pg.Pool;
  admin: pg.Pool;
  injector: pg.Pool;
  redis: TestRedis | null;
  deps: ActionDeps;
  service: ActionService;
  missionId: string;
}

export interface WorldOptions {
  redis?: boolean;
  dispatchLeaseMs?: number;
  /** Mission admission.minAgeMs. */
  minAgeMs?: number;
  /** Replaces the Redis client the service uses (counting or failing wrappers). */
  wrapRedis?: (client: RedisEffectClient) => RedisEffectClient;
  redisTimeoutMs?: number;
  seed?: Record<string, ConfigScalar> | false;
}

export const BASELINE: Record<string, ConfigScalar> = {
  'cache.namespace': 'catalog-a',
  'cache.schema_version': 1,
  'db.pool_max': 10,
  'db.statement_timeout_ms': 5000,
  'routing.inventory_source': 'primary',
  'orders.write_enabled': true,
  'ui.banner_text': 'hello',
};

export async function withWorld<T>(
  fn: (world: World) => Promise<T>,
  options: WorldOptions = {},
): Promise<T> {
  const run = async (redis: TestRedis | null) =>
    withTestDatabase(async (db) => {
      const app = createRolePool('app', db.urls.app, { max: 8 });
      const admin = createRolePool('admin', db.urls.admin);
      const injector = createRolePool('injector', db.urls.injector);
      try {
        const client = redis?.client as unknown as
          RedisEffectClient | undefined;
        const deps: ActionDeps = {
          pool: app,
          redis: client
            ? options.wrapRedis
              ? options.wrapRedis(client)
              : client
            : null,
          redisPrefix: redis?.prefix ?? 'nemodots:test:none0000',
          dispatchLeaseMs: options.dispatchLeaseMs,
          redisTimeoutMs: options.redisTimeoutMs,
        };
        const missionId = randomUUID();
        const world: World = {
          db,
          app,
          admin,
          injector,
          redis,
          deps,
          service: createActionService(deps),
          missionId,
        };
        if (options.seed !== false)
          await seedConfig(world, options.seed ?? BASELINE);
        await createMission(world, missionId, options.minAgeMs ?? 0);
        return await fn(world);
      } finally {
        await Promise.all([app.end(), admin.end(), injector.end()]);
      }
    });
  return options.redis ? withTestRedis((redis) => run(redis)) : run(null);
}

// --- configuration ---------------------------------------------------------------

export async function seedConfig(
  world: World,
  entries: Record<string, ConfigScalar>,
) {
  await withTransaction(world.injector, async (client) => {
    for (const [key, value] of Object.entries(entries))
      await advanceConfigUnconditionally(client, {
        key,
        value,
        insertIfMissing: true,
        causedBy: { actor: 'seed' },
      });
  });
}

/** An external writer (injector) changes a key without telling the ledger. */
export async function externalChange(
  world: World,
  key: string,
  value: ConfigScalar,
): Promise<number> {
  const result = await withTransaction(world.injector, (client) =>
    advanceConfigUnconditionally(client, {
      key,
      value,
      causedBy: { actor: 'injector' },
    }),
  );
  return result.versionAfter;
}

export interface ConfigState {
  value: unknown;
  version: number;
  causedBy: string | null;
  actor: string;
}

export async function configState(
  world: World,
  key: string,
): Promise<ConfigState> {
  const { rows } = await world.admin.query<{
    value: unknown;
    version: string;
    caused_by_action_id: string | null;
    caused_by_actor: string;
  }>(
    'SELECT value, version, caused_by_action_id, caused_by_actor FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  return {
    value: rows[0].value,
    version: Number(rows[0].version),
    causedBy: rows[0].caused_by_action_id,
    actor: rows[0].caused_by_actor,
  };
}

export async function historyRows(world: World, key: string) {
  const { rows } = await world.admin.query<{
    version: string;
    value: unknown;
    before_digest: string | null;
    after_digest: string | null;
    caused_by_action_id: string | null;
    caused_by_actor: string;
  }>('SELECT * FROM checkout.config_versions WHERE key = $1 ORDER BY version', [
    key,
  ]);
  return rows.map((row) => ({ ...row, version: Number(row.version) }));
}

// --- missions, tasks, attempts ---------------------------------------------------------

async function createMission(
  world: World,
  missionId: string,
  minAgeMs: number,
) {
  await world.admin.query(
    `INSERT INTO coordinator.missions
       (id, owner_id, environment, resource, goal, mode, status, budgets,
        admission_min_age_ms, provider, started_at)
     VALUES ($1, $2, 'test', 'checkout', 'restore the checkout', 'fixture', 'running',
             '{"maxTasks":24,"maxDepth":3,"maxBreadth":4,"maxTokens":200000,"maxInferenceCalls":200,"maxWallClockMs":600000}'::jsonb,
             $3, '{"host":"fixture.invalid","plannerModel":"p","workerModel":"w"}'::jsonb, now())`,
    [missionId, OWNER, minAgeMs],
  );
}

let ordinal = 0;

export interface Attempt {
  missionId: string;
  taskId: string;
  attemptId: string;
  fencingToken: number;
  context: AttemptContext;
}

export async function createAttempt(
  world: World,
  options: {
    role?: TaskRole;
    capabilities?: Capability[];
    missionId?: string;
    fencingToken?: number;
    leaseMs?: number;
  } = {},
): Promise<Attempt> {
  const role = options.role ?? 'database_specialist';
  const capabilities =
    options.capabilities ??
    ['observe', 'propose_config_change', 'propose_cache_flush'].filter(
      (capability) =>
        role === 'cache_specialist'
          ? true
          : capability !== 'propose_cache_flush',
    );
  const missionId = options.missionId ?? world.missionId;
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const fencingToken = options.fencingToken ?? 1;
  ordinal += 1;
  await world.admin.query(
    `INSERT INTO coordinator.tasks
       (id, mission_id, depth, ordinal, title, question, role, capabilities, status,
        generation, fence_seq, attempt_count, budget)
     VALUES ($1, $2, 0, $3, 'repair', 'what is wrong?', $4, $5::text[], 'running',
             0, $6, 1, '{"maxIterations":12,"maxTokens":20000,"maxChildren":4}'::jsonb)`,
    [taskId, missionId, ordinal, role, capabilities, fencingToken],
  );
  await world.admin.query(
    `INSERT INTO coordinator.task_attempts
       (id, task_id, mission_id, n, kind, status, generation, lease_owner,
        fencing_token, lease_expires_at, lease_renewed_at)
     VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'test-worker', $4,
             clock_timestamp() + $5 * interval '1 millisecond', clock_timestamp())`,
    [attemptId, taskId, missionId, fencingToken, options.leaseMs ?? 60_000],
  );
  return {
    missionId,
    taskId,
    attemptId,
    fencingToken,
    context: {
      missionId,
      taskId,
      attemptId,
      fencingToken,
      generation: 0,
      capabilities,
      role,
    } as AttemptContext,
  };
}

export async function expireAuthorLease(world: World, attempt: Attempt) {
  await world.admin.query(
    `UPDATE coordinator.task_attempts SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`,
    [attempt.attemptId],
  );
}

export async function expireDispatcherLease(world: World, actionId: string) {
  await world.admin.query(
    `UPDATE coordinator.action_intents
        SET dispatcher_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`,
    [actionId],
  );
}

// --- receipts ----------------------------------------------------------------------------

export function sourceRef(key: string): SourceRef {
  const controlled = key.startsWith('checkout.config');
  return {
    key,
    sourceType:
      key === 'checkout.config'
        ? 'controlled_collection'
        : controlled
          ? 'controlled_config'
          : 'observed_endpoint',
    authority: controlled ? 'controlled' : 'observed',
    scope: {
      ownerId: OWNER,
      missionId: randomUUID(),
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
  } as unknown as SourceRef;
}

/** What a watcher registers for a member: the authority's current row. */
export async function memberReceipt(
  world: World,
  key: string,
  options: { closure?: boolean } = {},
): Promise<ObservationReceipt> {
  return withTransaction(world.app, async (client) => {
    const { rows } = await client.query<{ value: unknown; version: string }>(
      'SELECT value, version FROM checkout.config_entries WHERE key = $1',
      [key],
    );
    const result = await registerObservation(
      client,
      {
        source: sourceRef(`checkout.config/${key}`),
        normalizedValue: {
          key,
          value: rows[0].value,
          version: Number(rows[0].version),
        },
        provenance: { kind: 'watcher' },
      },
      options.closure === false ? { marker: null } : undefined,
    );
    return result.receipt;
  });
}

/** Registers or (same value) confirms an observed source. */
export async function observed(
  world: World,
  key: 'checkout.health' | 'redis.stats' | 'checkout.metrics',
  value: unknown = { status: 'degraded' },
  observedAt?: Date,
  options: { closure?: boolean } = {},
): Promise<ObservationReceipt> {
  return withTransaction(world.app, async (client) => {
    const result = await registerObservation(
      client,
      {
        source: sourceRef(key),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
        observedAt: observedAt ?? null,
      },
      options.closure === false ? { marker: null } : undefined,
    );
    return result.receipt;
  });
}

// --- model calls ----------------------------------------------------------------------------

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export async function emitModelCall(
  world: World,
  attempt: Attempt,
  receipts: ObservationReceipt[],
  toolCallId = `call_${randomUUID().slice(0, 8)}`,
): Promise<{ modelCallId: string; toolCallId: string }> {
  const ordered = [...receipts].sort((a, b) =>
    a.source.key < b.source.key ? -1 : a.source.key > b.source.key ? 1 : 0,
  );
  const vector = ordered.map((receipt) => ({
    sourceKey: receipt.source.key,
    sourceRevision: receipt.sourceRevision,
    receiptId: receipt.id,
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
      receipts: ordered.map((receipt) => ({
        id: receipt.id,
        sourceKey: receipt.source.key,
        sourceRevision: receipt.sourceRevision,
        contentDigest: receipt.contentDigest,
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
      ownerId: OWNER,
      missionId: attempt.missionId,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
    },
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
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
        argumentsDigest: sha256Hex('{}'),
      },
    ],
    createdAt: iso(),
  } as unknown as ModelCallRecord;
  await withTransaction(world.app, (client) =>
    recordModelCall(client, { record, snapshot }),
  );
  return { modelCallId, toolCallId };
}

// --- the standard scenario ----------------------------------------------------------------------

export interface Scenario {
  attempt: Attempt;
  member: ObservationReceipt;
  health: ObservationReceipt;
  modelCallId: string;
  toolCallId: string;
}

/**
 * A database specialist attempt that read db.pool_max and the (degraded)
 * health, with the model call that emitted its proposal recorded.
 */
export async function scenario(
  world: World,
  options: {
    key?: string;
    attempt?: Attempt;
    health?: ObservationReceipt;
    healthAgeMs?: number;
    toolCallId?: string;
  } = {},
): Promise<Scenario> {
  const key = options.key ?? 'db.pool_max';
  const attempt = options.attempt ?? (await createAttempt(world));
  const member = await memberReceipt(world, key);
  const health =
    options.health ??
    (await observed(
      world,
      'checkout.health',
      { status: 'degraded', checks: { postgres: true } },
      options.healthAgeMs !== undefined
        ? new Date(Date.now() - options.healthAgeMs)
        : undefined,
    ));
  const { modelCallId, toolCallId } = await emitModelCall(
    world,
    attempt,
    [member, health],
    options.toolCallId,
  );
  return { attempt, member, health, modelCallId, toolCallId };
}

export function setConfigInput(
  world: World,
  state: ConfigState | { value: unknown },
  patch: {
    key?: string;
    value?: ConfigScalar;
    digest?: string;
    cite?: ReceiptId[];
    rationale?: string;
  } = {},
): ProposeInput {
  return {
    action: 'set_config',
    payload: {
      key: (patch.key ?? 'db.pool_max') as never,
      value: patch.value ?? 20,
      expectedCurrentValueDigest:
        patch.digest ??
        valueDigest((state as { value: ConfigScalar }).value as ConfigScalar),
    },
    supportingReceiptIds: patch.cite ?? [],
    rationale: patch.rationale ?? 'raise the pool',
  } as ProposeInput;
}

export const valueDigest = (value: ConfigScalar) => configValueDigest(value);

export function proposeCtx(s: Scenario) {
  return {
    ...s.attempt.context,
    modelCallId: s.modelCallId,
    toolCallId: s.toolCallId,
  } as AttemptContext & { modelCallId: never; toolCallId: string };
}

/** Proposes the standard db.pool_max change from the scenario's emitting call. */
export async function proposePool(
  world: World,
  s: Scenario,
  value: ConfigScalar = 20,
  cite: ReceiptId[] = [],
): Promise<ActionIntent> {
  const state = await configState(world, 'db.pool_max');
  return world.service.propose(
    setConfigInput(world, state, { value, cite }),
    proposeCtx(s),
  );
}

// --- inspection ----------------------------------------------------------------------------

export async function intentRow(world: World, actionId: string) {
  const { rows } = await world.admin.query<Record<string, unknown>>(
    'SELECT * FROM coordinator.action_intents WHERE id = $1',
    [actionId],
  );
  return rows[0];
}

export async function authorizations(world: World, actionId: string) {
  const { rows } = await world.admin.query<{
    stage: string;
    decision: string;
    block_reason: string | null;
    target_expected: string;
    target_live: string;
    dispatch_fence_token: string | null;
    dispatch_fence_valid: boolean | null;
    idempotency_binding: string;
    checked_vector: { sourceKey: string; freshnessOk: boolean }[];
  }>(
    'SELECT * FROM coordinator.authorizations WHERE action_id = $1 ORDER BY seq',
    [actionId],
  );
  return rows;
}

export async function results(world: World, actionId: string) {
  const { rows } = await world.admin.query<{
    id: string;
    outcome: string;
    control_plane: Record<string, unknown> | null;
    external_effect: Record<string, unknown> | null;
    postcondition: Record<string, unknown> | null;
  }>(
    'SELECT * FROM coordinator.result_receipts WHERE action_id = $1 ORDER BY seq',
    [actionId],
  );
  return rows;
}

export async function countRows(
  world: World,
  table: string,
  where = 'true',
  params: unknown[] = [],
) {
  const { rows } = await world.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0].n);
}

export async function waitsOnLock(
  world: World,
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await world.admin.query(
      'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted',
      [pid],
    );
    if (rows.length > 0) return true;
    await sleep(25);
  }
  return false;
}

/** Waits until at least `count` backends wait for a lock in this database. */
export async function waitForLockWaiters(
  world: World,
  count: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await world.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (Number(rows[0].n) >= count) return true;
    await sleep(25);
  }
  return false;
}

/** A full pipeline step: admit (as `dispatcher`) and commit under its fence. */
export async function admitAndCommit(
  world: World,
  actionId: string,
  dispatcher = 'dispatcher-a',
) {
  const admitted = await world.service.admit(actionId as never, dispatcher);
  if (admitted.status !== 'admitted') return { admitted, committed: admitted };
  const committed = await world.service.commit(
    actionId as never,
    admitted.dispatch!.fence,
  );
  return { admitted, committed };
}

export { randomUUID };

/**
 * Runs `fn` with the binding-immutability trigger switched off, to model a row
 * altered behind the application's back (defence in depth: admission and
 * commit must still refuse it).
 */
export async function tampering<T>(world: World, fn: () => Promise<T>) {
  await world.admin.query(
    'ALTER TABLE coordinator.action_intents DISABLE TRIGGER action_intents_guard',
  );
  try {
    return await fn();
  } finally {
    await world.admin.query(
      'ALTER TABLE coordinator.action_intents ENABLE TRIGGER action_intents_guard',
    );
  }
}
