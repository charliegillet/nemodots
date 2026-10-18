// Independent world for the concurrency devil's advocate (W5).
//
// Expected outcomes in this directory come from ARCHITECTURE.md sections 4-6
// and 14 and CONTRACTS.md, never from the implementation's own helpers: every
// assertion reads PostgreSQL / Redis with raw SQL and raw commands written
// here. The only production code driven is the public surface under test
// (action service, ledger registration, version authority, coordinator
// publication, watcher) plus the barriers of actions/test-hooks.ts.
//
// The only doubles are labelled:
//   - missions, tasks and attempts are inserted with SQL (they are the
//     coordinator's rows; only the columns the fences read matter);
//   - the coordinator used by C9/C12 is the real one, wired to the real ledger
//     validator and a ledger writer that stores edges with the ledger's own
//     functions (no production composition root exists yet);
//   - the watcher's SourceReaderPort reads the real authority rows.
//
// Every pool is instrumented: a 40P01 (deadlock) or 40001 (serialization
// failure) raised by PostgreSQL is recorded BEFORE withTransaction retries it,
// so a retried deadlock cannot hide.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach } from 'vitest';
import {
  createActionService,
  clearBarriers,
  setBarrier,
  type ActionDeps,
  type ActionService,
  type BarrierContext,
  type BarrierName,
  type RedisEffectClient,
} from '../../../../src/server/nemodots/actions/index.js';
import { createIntentReader } from '../../../../src/server/nemodots/actions/index.js';
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
  createCoordinator,
  type Coordinator,
  type LedgerWriterPort,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  addEdges,
  recordModelCall,
  registerObservation,
  supportValidator,
  type RegisterOptions,
  type RegisterResult,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  advanceConfigUnconditionally,
  configValueDigest,
  type ConfigScalar,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { barrier as latchBarrier, latch, type Latch } from '../../helpers/barrier.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis, type TestRedis } from '../../helpers/test-redis.js';

// The barriers are inert without this; the harness never runs in a live run.
process.env.NEMODOTS_TEST_HOOKS = '1';
afterEach(() => clearBarriers());

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const OWNER = 'owner-adversary';

/** Polls `probe` until it returns something truthy. */
export async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 8_000,
  stepMs = 15,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

// --- instrumented pools -----------------------------------------------------------

export interface SqlFailure {
  code: string;
  message: string;
  pool: string;
}

function instrument(pool: pg.Pool, name: string, sink: SqlFailure[]) {
  const connect = pool.connect.bind(pool) as (
    cb?: unknown,
  ) => Promise<pg.PoolClient>;
  const patched = new WeakSet<object>();
  (pool as unknown as { connect: unknown }).connect = async (cb?: unknown) => {
    if (cb) return connect(cb);
    const client = await connect();
    if (!patched.has(client)) {
      patched.add(client);
      const query = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (
        ...args: unknown[]
      ) => {
        try {
          return await query(...args);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === '40P01' || code === '40001')
            sink.push({
              code,
              message: (error as Error).message,
              pool: name,
            });
          throw error;
        }
      };
    }
    return client;
  };
  return pool;
}

// --- the world -------------------------------------------------------------------------

export interface World {
  db: TestDatabase;
  /** nemodots_app: what the server process uses. */
  app: pg.Pool;
  /** nemodots_admin: setup and oracle reads only. */
  admin: pg.Pool;
  /** nemodots_injector: the fault injector / external writer. */
  injector: pg.Pool;
  redis: TestRedis | null;
  deps: ActionDeps;
  service: ActionService;
  missionId: string;
  /** Every 40P01 / 40001 any instrumented pool saw (before retries). */
  failures: SqlFailure[];
  deadlocks(): SqlFailure[];
  coordinator(): Coordinator;
}

export interface WorldOptions {
  redis?: boolean;
  dispatchLeaseMs?: number;
  minAgeMs?: number;
  wrapRedis?: (client: RedisEffectClient) => RedisEffectClient;
  redisTimeoutMs?: number;
  seed?: Record<string, ConfigScalar> | false;
  appPoolMax?: number;
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
      const failures: SqlFailure[] = [];
      const app = instrument(
        createRolePool('app', db.urls.app, { max: options.appPoolMax ?? 8 }),
        'app',
        failures,
      );
      const admin = createRolePool('admin', db.urls.admin);
      const injector = instrument(
        createRolePool('injector', db.urls.injector),
        'injector',
        failures,
      );
      let coordinator: Coordinator | null = null;
      try {
        const client = redis?.client as unknown as RedisEffectClient | undefined;
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
        const service = createActionService(deps);
        const world: World = {
          db,
          app,
          admin,
          injector,
          redis,
          deps,
          service,
          missionId,
          failures,
          deadlocks: () => failures.filter((item) => item.code === '40P01'),
          coordinator() {
            coordinator ??= buildCoordinator(world);
            return coordinator;
          },
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

// --- coordinator (C9, C12) ------------------------------------------------------------------

const emptyTelemetry = {
  calls: 0,
  orphanedCalls: 0,
  tokens: { prompt: 0, completion: 0, cached: { available: false, total: null } },
  byModel: [],
  byRole: [],
  retries: 0,
  errors: 0,
  ttftMs: null,
  prefixGroups: [],
};

function buildCoordinator(world: World): Coordinator {
  const writer: LedgerWriterPort = {
    async recordModelCall(client, input) {
      await recordModelCall(client, {
        record: input.record,
        snapshot: input.snapshot,
      });
    },
    async recordArtifact(client, artifact) {
      // Evidence edges receipt -> artifact, the shape CONTRACTS section 4 gives.
      await addEdges(
        client,
        artifact.dependencyVector.map((entry) => ({
          kind: 'evidence' as const,
          from: { kind: 'receipt' as const, id: entry.receiptId },
          to: {
            kind: artifact.kind,
            id: artifact.id,
            missionId: artifact.missionId,
            taskId: artifact.taskId,
          },
        })),
      );
    },
  };
  return createCoordinator({
    pool: world.app,
    config: {
      ownerId: OWNER,
      spaceId: null,
      environment: 'test',
      resource: 'checkout',
      mode: 'fixture',
      provider: { host: 'fixture.invalid', plannerModel: 'p', workerModel: 'w' },
      budgets: {
        maxTasks: 24,
        maxDepth: 3,
        maxBreadth: 4,
        maxTokens: 200_000,
        maxInferenceCalls: 200,
        maxWallClockMs: 600_000,
      },
      leaseMs: 30_000,
      taskDefaults: { maxAttempts: 3, maxIterations: 12, maxTokens: 20_000 },
      replanCap: 3,
    },
    supportValidator,
    ledger: writer,
    recordOrphanedAttempt: async () => {},
    intents: createIntentReader(),
    actions: world.service.coordinatorPort('adversary'),
    snapshotReader: {
      async read() {
        return {
          receipts: [],
          confirmations: [],
          actions: [],
          authorizations: [],
          results: [],
          probe: null,
          telemetry: emptyTelemetry,
        };
      },
    },
    probe: null,
    providerHealthy: async () => true,
  });
}

// --- configuration (the oracle reads these with raw SQL) --------------------------------------

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

/** An external writer (the injector role) changes a key; returns the new version. */
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

export async function collectionVersion(world: World): Promise<number> {
  const { rows } = await world.admin.query<{ version: string }>(
    'SELECT version FROM checkout.config_collection WHERE singleton',
  );
  return Number(rows[0].version);
}

export async function historyRows(world: World, key: string) {
  const { rows } = await world.admin.query<{
    version: string;
    value: unknown;
    before_digest: string | null;
    after_digest: string | null;
    caused_by_action_id: string | null;
    caused_by_actor: string;
  }>(
    'SELECT * FROM checkout.config_versions WHERE key = $1 ORDER BY version',
    [key],
  );
  return rows.map((row) => ({ ...row, version: Number(row.version) }));
}

/** History rows written by an action, across all keys. */
export async function actionHistory(world: World, actionId: string) {
  const { rows } = await world.admin.query<{
    key: string;
    version: string;
    after_digest: string | null;
  }>(
    'SELECT key, version, after_digest FROM checkout.config_versions WHERE caused_by_action_id = $1 ORDER BY key, version',
    [actionId],
  );
  return rows.map((row) => ({ ...row, version: Number(row.version) }));
}

export const valueDigest = (value: ConfigScalar) => configValueDigest(value);

// --- missions, tasks, attempts ---------------------------------------------------------------------

export async function createMission(
  world: World,
  missionId: string,
  minAgeMs = 0,
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
        role === 'cache_specialist' ? true : capability !== 'propose_cache_flush',
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

/** Moves the dispatcher lease of an admitted intent into the past. */
export async function expireDispatcherLease(world: World, actionId: string) {
  await world.admin.query(
    `UPDATE coordinator.action_intents
        SET dispatcher_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`,
    [actionId],
  );
}

// --- receipts (the watcher's registrations, through the real ledger) ----------------------------

export function sourceRef(key: string, missionId = randomUUID()): SourceRef {
  const controlled = key.startsWith('checkout.config');
  return {
    key,
    sourceType:
      key === 'checkout.config'
        ? 'controlled_collection'
        : controlled
          ? 'controlled_config'
          : key === 'redis.stats'
            ? 'observed_store'
            : 'observed_endpoint',
    authority: controlled ? 'controlled' : 'observed',
    scope: {
      ownerId: OWNER,
      missionId,
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
  return (await registerMember(world, key, options)).receipt;
}

export async function registerMember(
  world: World,
  key: string,
  options: { closure?: boolean } = {},
): Promise<RegisterResult> {
  return withTransaction(world.app, async (client) => {
    const { rows } = await client.query<{ value: unknown; version: string }>(
      'SELECT value, version FROM checkout.config_entries WHERE key = $1',
      [key],
    );
    return registerObservation(
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
  });
}

/** The collection receipt: sorted key list + collection version. */
export async function collectionReceipt(world: World): Promise<ObservationReceipt> {
  return withTransaction(world.app, async (client) => {
    const keys = await client.query<{ key: string }>(
      'SELECT key FROM checkout.config_entries ORDER BY key',
    );
    const version = await client.query<{ version: string }>(
      'SELECT version FROM checkout.config_collection WHERE singleton',
    );
    const result = await registerObservation(client, {
      source: sourceRef('checkout.config'),
      normalizedValue: {
        keys: keys.rows.map((row) => row.key),
        collectionVersion: Number(version.rows[0].version),
      },
      provenance: { kind: 'watcher' },
    });
    return result.receipt;
  });
}

export type ObservedKey = 'checkout.health' | 'redis.stats' | 'checkout.metrics';

/** Registers (or, with an unchanged value, confirms) an observed source. */
export async function observed(
  world: World,
  key: ObservedKey,
  value: unknown = { status: 'degraded', checks: { postgres: true } },
  observedAt?: Date,
  options: RegisterOptions & { missionId?: string } = {},
): Promise<ObservationReceipt> {
  return (await registerObserved(world, key, value, observedAt, options)).receipt;
}

export async function registerObserved(
  world: World,
  key: ObservedKey,
  value: unknown,
  observedAt?: Date,
  options: RegisterOptions & { missionId?: string } = {},
): Promise<RegisterResult> {
  const { missionId, ...register } = options;
  return withTransaction(world.app, (client) =>
    registerObservation(
      client,
      {
        source: sourceRef(key, missionId),
        normalizedValue: value,
        provenance: { kind: 'watcher' },
        observedAt: observedAt ?? null,
      },
      register,
    ),
  );
}

// --- model calls ----------------------------------------------------------------------------------------

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export interface EmittedCall {
  modelCallId: string;
  toolCallId: string;
  vector: { sourceKey: string; sourceRevision: number; receiptId: string }[];
}

/**
 * Records a model call whose context snapshot carried `receipts` (its
 * dependency vector) and that emitted `propose_action` tool calls with the
 * given ids.
 */
export async function emitModelCall(
  world: World,
  attempt: Attempt,
  receipts: ObservationReceipt[],
  toolCallIds: string | string[] = `call_${randomUUID().slice(0, 8)}`,
): Promise<EmittedCall> {
  const ids = Array.isArray(toolCallIds) ? toolCallIds : [toolCallIds];
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
    toolCalls: ids.map((toolCallId) => ({
      toolCallId,
      name: 'propose_action',
      argumentsDigest: sha256Hex('{}'),
    })),
    createdAt: iso(),
  } as unknown as ModelCallRecord;
  await withTransaction(world.app, (client) =>
    recordModelCall(client, { record, snapshot }),
  );
  return { modelCallId, toolCallId: ids[0], vector };
}

// --- the standard scenario ------------------------------------------------------------------------------

export interface Scenario {
  attempt: Attempt;
  member: ObservationReceipt;
  health: ObservationReceipt;
  modelCallId: string;
  toolCallId: string;
}

/** An attempt that read `key` (default db.pool_max) and the degraded health. */
export async function scenario(
  world: World,
  options: {
    key?: string;
    attempt?: Attempt;
    health?: ObservationReceipt;
    healthAgeMs?: number;
    toolCallId?: string;
    extra?: ObservationReceipt[];
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
  const call = await emitModelCall(
    world,
    attempt,
    [member, health, ...(options.extra ?? [])],
    options.toolCallId,
  );
  return {
    attempt,
    member,
    health,
    modelCallId: call.modelCallId,
    toolCallId: call.toolCallId,
  };
}

export function setConfigInput(
  value: ConfigScalar,
  currentValue: ConfigScalar,
  patch: { key?: string; cite?: ReceiptId[]; digest?: string } = {},
): ProposeInput {
  return {
    action: 'set_config',
    payload: {
      key: (patch.key ?? 'db.pool_max') as never,
      value,
      expectedCurrentValueDigest: patch.digest ?? valueDigest(currentValue),
    },
    supportingReceiptIds: patch.cite ?? [],
    rationale: 'adversary proposal',
  } as ProposeInput;
}

export function proposeCtx(s: {
  attempt: Attempt;
  modelCallId: string;
  toolCallId: string;
}) {
  return {
    ...s.attempt.context,
    modelCallId: s.modelCallId,
    toolCallId: s.toolCallId,
  } as never;
}

/** Proposes db.pool_max := value from the scenario's emitting call. */
export async function proposePool(
  world: World,
  s: Scenario,
  value: ConfigScalar = 20,
  cite: ReceiptId[] = [],
): Promise<ActionIntent> {
  const state = await configState(world, 'db.pool_max');
  return world.service.propose(
    setConfigInput(value, state.value as ConfigScalar, { cite }),
    proposeCtx(s),
  );
}

// --- inspection ----------------------------------------------------------------------------------------------------

export async function intentRow(world: World, actionId: string) {
  const { rows } = await world.admin.query<Record<string, unknown>>(
    'SELECT * FROM coordinator.action_intents WHERE id = $1',
    [actionId],
  );
  return rows[0];
}

export async function intentStatus(world: World, actionId: string) {
  const row = await intentRow(world, actionId);
  return {
    status: row.status as string,
    blockReason: row.block_reason as string | null,
    failureReason: row.failure_reason as string | null,
    fence: row.dispatch_fence === null ? null : Number(row.dispatch_fence),
  };
}

export async function authorizations(world: World, actionId: string) {
  const { rows } = await world.admin.query<{
    stage: string;
    decision: string;
    block_reason: string | null;
    dispatch_fence_token: string | null;
  }>(
    'SELECT stage, decision, block_reason, dispatch_fence_token FROM coordinator.authorizations WHERE action_id = $1 ORDER BY seq',
    [actionId],
  );
  return rows;
}

export async function resultOutcomes(world: World, actionId: string) {
  const { rows } = await world.admin.query<{ outcome: string }>(
    'SELECT outcome FROM coordinator.result_receipts WHERE action_id = $1 ORDER BY seq',
    [actionId],
  );
  return rows.map((row) => row.outcome);
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

/** Backends of this database currently waiting for a lock (excluding the oracle pool). */
export async function lockWaiters(world: World): Promise<number> {
  const { rows } = await world.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()`,
  );
  return Number(rows[0].n);
}

/** Waits until at least `count` backends wait for a lock. */
export async function waitForLockWaiters(world: World, count = 1) {
  await until(
    async () => (await lockWaiters(world)) >= count,
    `${count} lock waiter(s)`,
  );
}

/** A full pipeline step: admit as `dispatcher`, then commit under the fence it was given. */
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

// --- barriers -----------------------------------------------------------------------------------------------------------

export interface Parked {
  /** Resolves when a caller reached the barrier. */
  arrived: Promise<BarrierContext>;
  release(): void;
  remove(): void;
}

/**
 * Parks the FIRST caller that reaches `name` (and passes `only`) until
 * `release()`; later callers run through.
 */
export function park(
  name: BarrierName,
  only?: (context: BarrierContext) => boolean,
): Parked {
  const reached: Latch<BarrierContext> = latch<BarrierContext>();
  const gate = latch();
  const remove = setBarrier(name, async (context) => {
    if (reached.isOpen) return;
    if (only && !only(context)) return;
    reached.open(context);
    await gate.promise;
  });
  return {
    arrived: reached.promise,
    release: () => gate.open(undefined),
    remove,
  };
}

export { latchBarrier, latch, randomUUID };

// --- flush_cache_namespace --------------------------------------------------------------------------------------

export interface FlushScenario {
  attempt: Attempt;
  member: ObservationReceipt;
  stats: ObservationReceipt;
  modelCallId: string;
  toolCallId: string;
}

export async function flushScenario(
  world: World,
  options: { attempt?: Attempt; toolCallId?: string } = {},
): Promise<FlushScenario> {
  const attempt =
    options.attempt ?? (await createAttempt(world, { role: 'cache_specialist' }));
  const member = await memberReceipt(world, 'cache.namespace');
  const stats = await observed(world, 'redis.stats', {
    activeNamespace: 'catalog-a',
    keys: { 'catalog-a:v2': 3 },
  });
  const call = await emitModelCall(
    world,
    attempt,
    [member, stats],
    options.toolCallId,
  );
  return {
    attempt,
    member,
    stats,
    modelCallId: call.modelCallId,
    toolCallId: call.toolCallId,
  };
}

export async function proposeFlush(
  world: World,
  s: FlushScenario,
  namespace = 'catalog-a',
): Promise<ActionIntent> {
  return world.service.propose(
    {
      action: 'flush_cache_namespace',
      payload: { namespace, reason: 'blobs carry the wrong schema' },
      supportingReceiptIds: [],
      rationale: 'flush the namespace',
    } as ProposeInput,
    proposeCtx(s),
  );
}

export async function seedCache(
  world: World,
  namespace: string,
  names: string[],
  schema = 2,
) {
  const redis = world.redis!;
  for (const name of names)
    await redis.client.set(
      `${redis.prefix}:cache:${namespace}:v${schema}:${name}`,
      JSON.stringify({ name }),
    );
}

export async function cacheKeys(world: World, namespace: string) {
  const redis = world.redis!;
  const keys: string[] = [];
  for await (const batch of redis.client.scanIterator({
    MATCH: `${redis.prefix}:cache:${namespace}:*`,
    COUNT: 100,
  }))
    keys.push(...batch);
  return keys.sort();
}

export async function redisValue(world: World, suffix: string) {
  return world.redis!.client.get(`${world.redis!.prefix}:${suffix}`);
}

/** A Redis wrapper that counts how often the effect script ran. */
export function countingRedis(counter: { scripts: number }) {
  return (client: RedisEffectClient): RedisEffectClient => ({
    eval(script, options) {
      counter.scripts += 1;
      return client.eval(script, options);
    },
    get: (key) => client.get(key),
    set: (key, value, options) => client.set(key, value, options),
  });
}
