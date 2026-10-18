import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import type pg from 'pg';
import { createClient } from 'redis';
import {
  createActionService,
  createIntentReader,
  readActionSnapshot,
  type ActionService,
} from './actions/index.js';
import {
  NemoDotsEnvError,
  parseNemoDotsEnv,
  pgUrl,
  resolveInference,
  type NemoDotsConfig,
  type ResolvedInference,
} from './config/env.js';
import type {
  DependencyEntry,
  HealthStatus,
  MissionId,
  ObservationReceipt,
  PgClient,
  SourceRef,
  SourceReaderPort,
} from './contracts/index.js';
import { createCoordinator, type Coordinator } from './coordinator/index.js';
import type {
  CoordinatorConfig,
  ForeignSnapshotReader,
} from './coordinator/types.js';
import { createEventSink } from './coordinator/events.js';
import { migrate } from './db/migrate.js';
import { createRolePool } from './db/pool.js';
import { withTransaction } from './db/tx.js';
import {
  createUnavailableRouter,
  stateNotice,
  type MigrationState,
  type NemoDotsState,
  type RuntimeHealth,
} from './health.js';
import { createInferenceFromEnv } from './inference/index.js';
import {
  createApprovalRevalidator,
  createToolPolicy,
  pageDigest,
  parseIncidentDotIds,
  setActivePolicy,
  setInterceptionRuntime,
} from './interception/index.js';
import {
  RECEIPT_SELECT,
  addEdges,
  createSupportValidator,
  mapReceiptRow,
  recordModelCall as recordLedgerModelCall,
  recordOrphanedAttempt,
  registerObservation,
  toReceipt,
  type ReceiptDbRow,
} from './ledger/index.js';
import { isSupportError } from './coordinator/errors.js';
import { RouteError } from './routes/errors.js';
import {
  createInjectorTrigger,
  nemodotsRoutes,
  type InjectorTrigger,
} from './routes/index.js';
import { createProbe, acceptanceNormalizedValue } from './sandbox/probe.js';
import { Injector, type ScenarioRun } from './sandbox/injector.js';
import { createSourceReaders } from './sandbox/readers.js';
import { completeEnv } from './sandbox/runtime-env.js';
import { summarizeTelemetry } from './telemetry/index.js';
import {
  RECOMMENDED_TEAM_BUDGETS,
  createLedgerObserver,
  createPgTeamReader,
  createTeamWorkerHost,
  type TeamInference,
} from './team/index.js';
import type { ObservationPort, TeamReader } from './team/types.js';
import {
  WATCHER_MISSION_ID,
  createOwnerEdit,
  createSqlIntentSettlement,
  createWatcher,
  type Watcher,
  type WatcherEvent,
  type WatcherRecovery,
} from './watcher/index.js';
import type { WorkerHost } from './coordinator/worker-host.js';
import type { WorkspaceStore } from '../workspace.js';

// The composition root (ARCHITECTURE.md section 2). Every port is wired to its
// implementation here and nowhere else:
//
//   RecoveryPort            coordinator.recovery (watcher and actions call it)
//   SupportValidator        ledger createSupportValidator()
//   EventSinkPort           coordinator createEventSink()
//   ActionAdmissionPort     actions createActionService() (admission, commit,
//                           dispatch, reconcile, reclaim)
//   InferencePort           inference createInferenceFromEnv() or the injected
//                           adapter; NEVER a fallback provider
//   ProbePort               sandbox createProbe() (the only holder of the
//                           verifier pool besides nothing else)
//   SourceReaderPort        sandbox createSourceReaders()
//   recordOrphanedAttempt   ledger recordOrphanedAttempt()
//   setActivePolicy         interception, only for listed incident Dots
//
// createNemoDots() only constructs: pools, clients and routers are lazy, so a
// process without the stack still boots and /api/nemodots/health says so.
// start() checks the database, refuses to run on pending migrations, then
// starts the outbox (admission, mission evaluation, acceptance, the reaper),
// the source watcher, the worker hosts and the action sweep.

type Env = Record<string, string | undefined>;
type Redis = ReturnType<typeof createClient>;

export class MigrationsPendingError extends Error {
  constructor(
    readonly pending: string[],
    readonly unknown: string[],
  ) {
    super(
      `NemoDots refuses to start: ${pending.length} pending and ${unknown.length} unknown migration(s). Run npm run nemodots:migrate.`,
    );
    this.name = 'MigrationsPendingError';
  }
}

export interface NemoDotsDeps {
  /** The OpenDots workspace: its owner id, and its page store for the revision hook. */
  workspace?: Pick<WorkspaceStore, 'ownerId' | 'pages'>;
  /** Replaces the adapter built from the environment (tests, the verifier). */
  inference?: TeamInference;
  /** Process-level log; receives short, secret-free lines. */
  log?: (line: string) => void;
  /** Root of the checkout (default: the working directory). */
  appRoot?: string;
}

export interface NemoDots {
  /** Mounted by createApp at /api/nemodots. */
  router: Hono;
  start(): Promise<void>;
  /** Idempotent. Stops workers, the watcher and the outbox, then closes every pool. */
  stop(): Promise<void>;
  /** The HealthStatus contract, exactly as GET /api/nemodots/health serves it. */
  health(): Promise<HealthStatus>;
  /** What is running in this process. */
  runtime(): Promise<RuntimeHealth>;
  readonly state: NemoDotsState;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The env with roles.env and instance ports filled in, but only when an instance was named. */
export function resolveNemoDotsEnv(env: Env, appRoot: string): Env {
  return env.NEMODOTS_INSTANCE?.trim() ? completeEnv(env, appRoot) : env;
}

const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'NEMODOTS_PROBE_SECRET',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
  'OWNER_TOKEN',
] as const;

/** Every string that must never reach a log line or a response. */
export function secretsOf(env: Env): string[] {
  const values = [
    ...SECRET_ENV_NAMES.map((name) => env[name]?.trim()),
    ...Object.entries(env)
      .filter(([name]) => name.startsWith('NEMODOTS_PG_URL_'))
      .map(([, value]) => value?.trim()),
  ];
  return values.filter((v): v is string => !!v && v.length >= 8);
}

export function redactor(secrets: readonly string[]) {
  return (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  };
}

interface ProviderState {
  verified: boolean | null;
  checkedAt: string | null;
}

// ------------------------------------------------------------------ core

export interface CoreOptions {
  /** 'server' hosts the probe, injector and watcher inputs; 'worker' only attempts. */
  role: 'server' | 'worker';
  deps?: NemoDotsDeps;
  log: (line: string) => void;
}

/**
 * Everything both the server and `worker-main` need, over the same worker host
 * and team handler (finding I9). Nothing here starts a loop.
 */
export interface Core {
  config: NemoDotsConfig;
  env: Env;
  ownerId: string;
  resolved: ResolvedInference;
  mode: 'live' | 'fixture' | 'blocked';
  models: { planner: string; worker: string };
  inference: TeamInference | null;
  pools: {
    /** coordinator, routes, team tools, outbox */
    app: pg.Pool;
    /** actions, watcher, interception: a second pool so a long acceptance run cannot starve them */
    background: pg.Pool;
    injector: pg.Pool | null;
    verifier: pg.Pool | null;
  };
  redis: { effects: Redis; stats: Redis };
  readers: SourceReaderPort;
  reader: TeamReader;
  observer: ObservationPort;
  actions: ActionService;
  coordinator: Coordinator;
  hosts: WorkerHost[];
  provider: ProviderState;
  verifyProvider(): Promise<boolean>;
  /** Starts the Redis connections; resolves when ready or after `waitMs`. */
  connectRedis(waitMs?: number): Promise<void>;
  close(): Promise<void>;
  redact(text: string): string;
}

function selectModels(env: Env, resolved: ResolvedInference) {
  if (resolved.mode === 'live')
    return {
      planner: resolved.provider.plannerModel,
      worker: resolved.provider.workerModel,
    };
  const fallback = env.OPENAI_MODEL?.trim() || 'unconfigured';
  return {
    planner: env.NEMODOTS_PLANNER_MODEL?.trim() || fallback,
    worker: env.NEMODOTS_WORKER_MODEL?.trim() || fallback,
  };
}

function createSnapshotReader(): ForeignSnapshotReader {
  const MAX_RECEIPTS = 400;
  const MAX_CONFIRMATIONS = 300;
  return {
    async read(client, missionId) {
      const ids = await client.query<{ id: string }>(
        `SELECT DISTINCT id FROM (
           SELECT e.from_id AS id FROM ledger.dependency_edges e
            WHERE e.from_kind = 'receipt' AND e.mission_id = $1
           UNION
           SELECT r.id FROM ledger.observation_receipts r WHERE r.mission_id = $1
           UNION
           SELECT v.old_receipt_id FROM ledger.invalidation_events v
            WHERE v.mission_ids ? $1::text
           UNION
           SELECT v.new_receipt_id FROM ledger.invalidation_events v
            WHERE v.mission_ids ? $1::text AND v.new_receipt_id IS NOT NULL
         ) x`,
        [missionId],
      );
      const receiptRows =
        ids.rows.length === 0
          ? []
          : (
              await client.query<ReceiptDbRow>(
                `${RECEIPT_SELECT} WHERE r.id = ANY($1::uuid[])
                  ORDER BY r.observed_at DESC, r.id LIMIT ${MAX_RECEIPTS}`,
                [ids.rows.map((row) => row.id)],
              )
            ).rows;
      const receipts: ObservationReceipt[] = receiptRows
        .map((row) => toReceipt(mapReceiptRow(row)))
        .reverse();
      const confirmationRows =
        receipts.length === 0
          ? []
          : (
              await client.query<{
                receipt_id: string;
                confirmed_at: Date;
                provenance_kind: 'watcher' | 'tool_call' | 'probe';
                attempt_id: string | null;
                model_call_id: string | null;
              }>(
                `SELECT receipt_id, confirmed_at, provenance_kind, attempt_id, model_call_id
                   FROM ledger.receipt_confirmations
                  WHERE receipt_id = ANY($1::uuid[])
                  ORDER BY id DESC LIMIT ${MAX_CONFIRMATIONS}`,
                [receipts.map((receipt) => receipt.id)],
              )
            ).rows;
      const confirmations = confirmationRows.reverse().map((row) => ({
        receiptId: row.receipt_id,
        confirmedAt: row.confirmed_at.toISOString(),
        provenance: {
          kind: row.provenance_kind,
          attemptId: row.attempt_id,
          modelCallId: row.model_call_id,
        },
      }));
      const probeRow = (
        await client.query<ReceiptDbRow>(
          `${RECEIPT_SELECT}
            WHERE s.key = 'checkout.acceptance' AND r.mission_id = $1
            ORDER BY r.source_revision DESC LIMIT 1`,
          [missionId],
        )
      ).rows[0];
      const foreign = await readActionSnapshot(client, missionId);
      return {
        receipts,
        confirmations,
        actions: foreign.actions,
        authorizations: foreign.authorizations,
        results: foreign.results,
        probe: probeRow ? toReceipt(mapReceiptRow(probeRow)) : null,
        telemetry: await summarizeTelemetry(client, missionId),
      } as unknown as Awaited<ReturnType<ForeignSnapshotReader['read']>>;
    },
  };
}

export function createCore(
  rawEnv: Env,
  config: NemoDotsConfig,
  options: CoreOptions,
): Core {
  const { deps = {}, log, role } = options;
  const env = rawEnv;
  const redact = redactor(secretsOf(env));
  const resolved = resolveInference(env);
  const ownerId =
    deps.workspace?.ownerId ?? (env.OWNER_ID?.trim() || 'opendots-owner');
  const injected = deps.inference ?? null;
  const models = selectModels(env, resolved);

  let inference: TeamInference | null = injected;
  if (!inference && resolved.mode !== 'blocked') {
    try {
      inference = createInferenceFromEnv(env) as TeamInference;
    } catch (error) {
      log(
        `inference adapter unavailable: ${redact(error instanceof Error ? error.name : 'error')}`,
      );
    }
  }
  const mode: Core['mode'] =
    resolved.mode === 'blocked' ? 'blocked' : resolved.mode;
  const providerMode: 'live' | 'fixture' =
    mode === 'blocked' ? (inference?.mode ?? 'fixture') : mode;

  const poolError = (poolRole: string, error: Error) =>
    log(`pg pool (${poolRole}): ${redact(error.message).slice(0, 160)}`);
  const app = createRolePool('app', pgUrl(config, 'app'), {
    onError: (_r, error) => poolError('app', error),
  });
  const background = createRolePool('app', pgUrl(config, 'app'), {
    applicationName: 'nemodots-app-background',
    onError: (_r, error) => poolError('background', error),
  });
  const injectorPool =
    role === 'server' && config.pg.urls.injector
      ? createRolePool('injector', config.pg.urls.injector, {
          onError: (_r, error) => poolError('injector', error),
        })
      : null;
  const verifierPool =
    role === 'server' && config.pg.urls.verifier
      ? createRolePool('verifier', config.pg.urls.verifier, {
          onError: (_r, error) => poolError('verifier', error),
        })
      : null;

  const makeRedis = (offlineQueue: boolean): Redis => {
    const client = createClient({
      url: config.redis.url,
      disableOfflineQueue: !offlineQueue,
    });
    client.on('error', () => {
      // Reconnection is automatic; the state shows in health, not in a log flood.
    });
    return client;
  };
  // The effect client must fail fast: a flush queued during an outage and
  // delivered after reconnect could apply late (W3.1 finding R2-1).
  const effects = makeRedis(false);
  const stats = makeRedis(true);

  const readers = createSourceReaders({
    pg: background,
    redis: stats as never,
    redisPrefix: config.redis.prefix,
    checkoutUrl: config.checkout.url,
    probeSecret: config.probe.secret,
  });
  const reader = createPgTeamReader(app);
  const events = createEventSink();
  const observer = createLedgerObserver({
    pool: app,
    readers,
    reader,
    events,
  });

  const workerBase = `${role}-${process.pid}-${randomUUID().slice(0, 6)}`;
  // `recovery` is the coordinator's; it is assigned once the coordinator exists
  // (the coordinator needs the action port, the action service needs recovery).
  let coordinatorRecovery: Coordinator['recovery'] | null = null;
  const actions = createActionService({
    pool: background,
    redis: effects as never,
    redisPrefix: config.redis.prefix,
    dispatchLeaseMs: config.dispatchLeaseMs,
    events,
    recovery: {
      onInvalidation: (event) =>
        coordinatorRecovery
          ? coordinatorRecovery.onInvalidation(event)
          : Promise.resolve(),
      onSelfWriteSettled: (actionId, outcome) =>
        coordinatorRecovery
          ? coordinatorRecovery.onSelfWriteSettled(actionId, outcome)
          : Promise.resolve(),
    },
  });

  const provider: ProviderState = { verified: null, checkedAt: null };
  let verifyCache: { at: number; ok: boolean } | null = null;
  async function verifyProvider(): Promise<boolean> {
    if (!inference) return false;
    if (mode === 'fixture' || inference.mode === 'fixture') {
      provider.verified = true;
      provider.checkedAt = new Date().toISOString();
      return true;
    }
    if (verifyCache && Date.now() - verifyCache.at < 10_000)
      return verifyCache.ok;
    let ok = false;
    try {
      const listed = await inference.listModels();
      ok = [models.planner, models.worker].every((model) =>
        listed.includes(model),
      );
      if (!ok && 'verifyModel' in inference) {
        const adapter = inference as unknown as {
          verifyModel(model: string): Promise<boolean>;
        };
        ok = (
          await Promise.all(
            [...new Set([models.planner, models.worker])].map((model) =>
              adapter.verifyModel(model),
            ),
          )
        ).every(Boolean);
      }
    } catch {
      ok = false;
    }
    verifyCache = { at: Date.now(), ok };
    provider.verified = ok;
    provider.checkedAt = new Date().toISOString();
    return ok;
  }

  const coordinatorConfig: CoordinatorConfig = {
    ownerId,
    spaceId: null,
    environment: 'dev',
    resource: 'checkout',
    mode: providerMode,
    provider: {
      host:
        inference?.host() ??
        (resolved.mode === 'live' ? resolved.provider.host : 'unconfigured'),
      plannerModel: models.planner,
      workerModel: models.worker,
    },
    budgets: {
      maxTasks: config.maxTasks,
      maxDepth: config.maxDepth,
      maxBreadth: 4,
      maxTokens: RECOMMENDED_TEAM_BUDGETS.missionMaxTokens,
      maxInferenceCalls: 300,
      maxWallClockMs: 1_800_000,
    },
    leaseMs: config.leaseMs,
    taskDefaults: {
      maxAttempts: 3,
      maxIterations: 12,
      maxTokens: RECOMMENDED_TEAM_BUDGETS.taskMaxTokens,
    },
    replanCap: 3,
  };

  const probe =
    verifierPool && config.probe.secret
      ? createProbe({
          verifier: verifierPool,
          checkoutUrl: config.checkout.url,
          probeSecret: config.probe.secret,
          windowMs: config.probe.windowMs,
          register: async (missionId: MissionId, result) => {
            const facts = await reader.mission(missionId);
            const source: SourceRef = {
              key: 'checkout.acceptance' as SourceRef['key'],
              sourceType: 'probe',
              authority: 'observed',
              scope: facts.scope,
            };
            // Each run is its own observation: the mission id and the sample
            // time keep a repeated verdict from being folded into another
            // mission's receipt (acceptance requires a receipt of THIS mission).
            const registered = await withTransaction(background, (client) =>
              registerObservation(client, {
                source,
                normalizedValue: {
                  ...acceptanceNormalizedValue(result),
                  missionId,
                  probedAt: new Date().toISOString(),
                },
                provenance: { kind: 'probe' },
              }),
            );
            if (registered.invalidation)
              await coordinator.onInvalidation(registered.invalidation);
            return registered.receipt;
          },
        })
      : null;

  const coordinator: Coordinator = createCoordinator(
    {
      pool: app,
      config: coordinatorConfig,
      supportValidator: createSupportValidator(),
      ledger: {
        async recordModelCall(client: PgClient, input) {
          await recordLedgerModelCall(client, {
            record: input.record,
            snapshot: input.snapshot,
          });
        },
        async recordArtifact(client: PgClient, artifact) {
          if (artifact.kind === 'finding') return;
          const to = {
            kind: artifact.kind,
            id: artifact.id,
            missionId: artifact.missionId,
            taskId: artifact.taskId,
          } as const;
          await addEdges(
            client,
            artifact.dependencyVector.map((entry: DependencyEntry) => ({
              kind: 'evidence' as const,
              from: { kind: 'receipt' as const, id: entry.receiptId },
              to,
            })),
          );
        },
      },
      async recordOrphanedAttempt({ record }) {
        await recordOrphanedAttempt(background, {
          modelCallId: record.id,
          scope: record.scope,
          taskId: record.taskId,
          attemptId: record.attemptId,
          role: record.role,
          model: record.model,
          provider: record.provider,
          attempts: record.attempts,
        });
      },
      intents: createIntentReader(),
      actions: actions.coordinatorPort(`${workerBase}-dispatch`),
      snapshotReader: createSnapshotReader(),
      probe,
      providerHealthy: verifyProvider,
      events,
    },
    {
      workerId: `${workerBase}-dispatch`,
      outbox: {
        pollMs: 500,
        batchSize: 4,
        onError: (error, message) =>
          log(
            `outbox${message ? ` ${message.topic}#${message.id}` : ''}: ${redact(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 200)}`,
          ),
      },
    },
  );
  coordinatorRecovery = coordinator.recovery;

  const hosts: WorkerHost[] = [];
  if (inference) {
    for (let i = 0; i < config.workers; i += 1)
      hosts.push(
        createTeamWorkerHost(coordinator, {
          inference,
          reader,
          observer,
          models,
          actions,
          workerId: `${workerBase}-w${i + 1}`,
          concurrency: 1,
          configuredBudgets: {
            taskMaxTokens: coordinatorConfig.taskDefaults.maxTokens,
            missionMaxTokens: coordinatorConfig.budgets.maxTokens,
          },
          onError: (error) =>
            log(
              `worker error: ${redact(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 200)}`,
            ),
        }),
      );
  }
  // Host-level errors (claim failures, heartbeat failures) are reported by
  // the host's own onError; the handler's go through the team's.

  let closed = false;
  return {
    config,
    env,
    ownerId,
    resolved,
    mode,
    models,
    inference,
    pools: { app, background, injector: injectorPool, verifier: verifierPool },
    redis: { effects, stats },
    readers,
    reader,
    observer,
    actions,
    coordinator,
    hosts,
    provider,
    verifyProvider,
    async connectRedis(waitMs = 2_000) {
      const connects = [effects, stats].map((client) =>
        client.isOpen
          ? Promise.resolve()
          : client.connect().then(
              () => undefined,
              () => undefined,
            ),
      );
      await withTimeout(Promise.all(connects), waitMs);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of [effects, stats]) {
        try {
          if (client.isOpen) client.destroy();
        } catch {
          // already closed
        }
      }
      await Promise.allSettled(
        [
          app,
          background,
          ...(injectorPool ? [injectorPool] : []),
          ...(verifierPool ? [verifierPool] : []),
        ].map((pool) => pool.end()),
      );
    },
    redact,
  };
}

/** The migrations check shared by the server and worker-main. */
export async function checkMigrations(
  config: NemoDotsConfig,
): Promise<MigrationState> {
  const admin = config.pg.urls.admin;
  if (!admin) return 'unverified';
  const result = await migrate({ connectionString: admin, check: true });
  if (result.pending.length > 0 || result.unknown.length > 0)
    throw new MigrationsPendingError(result.pending, result.unknown);
  return 'ok';
}

// ----------------------------------------------------------------- server

export function createNemoDots(
  rawEnv: Env = process.env,
  deps: NemoDotsDeps = {},
): NemoDots {
  const appRoot = deps.appRoot ?? process.cwd();
  const logLine =
    deps.log ?? ((line: string) => console.log(`[nemodots] ${line}`));
  let env: Env;
  let config: NemoDotsConfig;
  try {
    env = resolveNemoDotsEnv(rawEnv, appRoot);
    config = parseNemoDotsEnv(env);
    if (!config.pg.urls.app)
      return unavailable(
        env,
        logLine,
        'unconfigured',
        'NEMODOTS_PG_URL_APP is not set',
      );
  } catch (error) {
    if (error instanceof NemoDotsEnvError) {
      logLine(`configuration error in ${error.names.join(', ')}`);
      return unavailable(
        rawEnv,
        logLine,
        'misconfigured',
        `${error.names.join(', ')} is unusable`,
      );
    }
    throw error;
  }

  const log = (line: string) => logLine(line);
  const core = createCore(env, config, { role: 'server', deps, log });
  const { coordinator, pools, redis } = core;
  const incidentIds = parseIncidentDotIds(env.NEMODOTS_INCIDENT_DOT_IDS);

  let state: NemoDotsState = 'created';
  let detail: string | null = null;
  let migrations: MigrationState = 'unchecked';
  let retryTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let sweeping = false;
  let outboxRunning = false;
  let hostsRunning = false;
  let interceptionOn = false;
  let stopped = false;
  let starting: Promise<void> | null = null;
  const runs = new Set<ScenarioRun>();
  let restorePageHook: (() => void) | null = null;

  // ------------------------------------------------------------- watcher
  const watcherRecovery: WatcherRecovery = {
    onInvalidation: (event) => coordinator.onInvalidation(event),
    async onSelfWriteSettled(actionId, outcome) {
      // settleFromHistory tells coordinator.recovery itself (idempotently).
      await core.actions.settleFromHistory(actionId, outcome);
    },
    async pauseMission(missionId) {
      try {
        await coordinator.control.pause(missionId);
      } catch (error) {
        // "not pausable": the mission already left running.
        const name = error instanceof Error ? error.name : '';
        if (name !== 'MissionStateError' && name !== 'IllegalTransitionError')
          throw error;
      }
    },
  };
  const watcher: Watcher = createWatcher({
    pool: pools.background,
    listenUrl: config.pg.urls.app,
    readers: core.readers,
    recovery: watcherRecovery,
    intents: createSqlIntentSettlement({ pool: pools.background }),
    config: {
      ownerId: core.ownerId,
      environment: 'dev',
      resource: 'checkout',
      intervalMs: config.watchIntervalMs,
    },
    onEvent: (event: WatcherEvent) => {
      if (event.type === 'error')
        log(
          `watcher ${event.where}: ${core.redact(event.message).slice(0, 200)}`,
        );
    },
  });

  // ------------------------------------------------------------ injector
  const injector = pools.injector
    ? new Injector({
        pool: pools.injector,
        listenUrl: config.pg.urls.injector!,
      })
    : null;
  const injectorTrigger: InjectorTrigger = injector
    ? createInjectorTrigger({
        injector: {
          async start(manifest, seed) {
            const run = await injector.start(manifest, seed);
            runs.add(run);
            void run.done.then(
              () => runs.delete(run),
              () => runs.delete(run),
            );
            return { runId: run.runId };
          },
        },
      })
    : {
        async run() {
          throw new RouteError(
            503,
            'The scenario injector is not configured (NEMODOTS_PG_URL_INJECTOR).',
          );
        },
      };

  // -------------------------------------------------------------- router
  const routes = nemodotsRoutes({
    pool: pools.app,
    control: coordinator.control,
    ownerId: core.ownerId,
    coordinatorOwnerId: core.ownerId,
    env,
    listModels: core.inference ? () => core.inference!.listModels() : undefined,
    pingRedis: async () => {
      if (!redis.stats.isReady) return false;
      return (await redis.stats.ping()) === 'PONG';
    },
    checkout: { baseUrl: config.checkout.url },
    ownerEdit: createOwnerEdit({ pool: pools.background, watcher }),
    injector: injectorTrigger,
    listenUrl: config.pg.urls.app,
    evalsReportPath: path.join(appRoot, 'evals/nemodots/results/report.json'),
    incidentDotIds: () => incidentIds.length,
    secrets: secretsOf(env),
    onError: ({ name, route }) => log(`route ${route}: ${name}`),
  });

  async function runtime(): Promise<RuntimeHealth> {
    const redisOk = redis.stats.isReady
      ? (await withTimeout(redis.stats.ping(), 1_000)) === 'PONG'
      : false;
    return {
      state,
      detail,
      migrations,
      workers: { configured: config.workers, running: hostsRunning },
      outbox: outboxRunning,
      watcher: {
        running: state === 'running',
        leader: watcher.isLeader(),
        stats: watcher.stats(),
      },
      probe:
        core.pools.verifier && config.probe.secret
          ? 'configured'
          : 'unconfigured',
      injector: injector ? 'configured' : 'unconfigured',
      redis: redisOk ? 'ok' : 'down',
      actionsSweep: sweepTimer !== null,
      interception: interceptionOn,
      provider: {
        mode: core.mode,
        model: core.mode === 'blocked' ? null : core.models.worker,
        host: core.inference?.host() ?? null,
        verified: core.provider.verified,
        checkedAt: core.provider.checkedAt,
      },
    };
  }

  const router = new Hono();
  router.use('*', async (c, next) => {
    const path_ = c.req.path;
    if (path_.endsWith('/health') || path_.endsWith('/runtime')) return next();
    const notice = stateNotice(state);
    if (notice) return c.json({ error: notice }, 503);
    return next();
  });
  router.get('/runtime', async (c) => c.json(await runtime()));
  router.route('/', routes);

  const healthRequest = async (): Promise<HealthStatus> => {
    const response = await routes.request('/health');
    return (await response.json()) as HealthStatus;
  };

  // --------------------------------------------------------- interception
  function installInterception() {
    if (incidentIds.length === 0 || interceptionOn) return;
    const supportValidator = createSupportValidator();
    const isIncident = (dotId: string) => incidentIds.includes(dotId);
    setActivePolicy(
      createToolPolicy({
        incidentDotIds: () => incidentIds,
        revalidateApproval: createApprovalRevalidator({
          isIncidentDot: isIncident,
          async checkCurrent(receiptIds) {
            try {
              await withTransaction(pools.background, (client) =>
                supportValidator.assertCurrent(client, receiptIds as never, {
                  lockMode: 'share',
                }),
              );
              return { ok: true };
            } catch (error) {
              if (isSupportError(error))
                return {
                  ok: false,
                  receiptId: error.receiptId ?? undefined,
                  detail: error.reason,
                };
              throw error;
            }
          },
        }),
      }),
    );
    setInterceptionRuntime({
      providerMode: core.mode === 'blocked' ? 'fixture' : core.mode,
      async recordModelCall({ record, snapshot }) {
        await withTransaction(pools.background, (client) =>
          recordLedgerModelCall(client, { record, snapshot }),
        );
      },
      async resolveReceipt(query) {
        if (query.shape !== 'page' && query.shape !== undefined) return null;
        if (query.sourceRevision === null) return null;
        const { rows } = await pools.background.query<{
          id: string;
          source_revision: number;
        }>(
          `SELECT r.id, r.source_revision
             FROM ledger.observation_receipts r
             JOIN ledger.sources s ON s.id = r.source_id
            WHERE s.key = $1 AND s.owner_id = $2
              AND r.normalized_value->>'revision' = $3
              AND r.status = 'supported'
            ORDER BY r.source_revision DESC LIMIT 1`,
          [query.sourceKey, core.ownerId, String(query.sourceRevision)],
        );
        if (!rows[0]) return null;
        return {
          receiptId: rows[0].id,
          sourceKey: query.sourceKey,
          sourceRevision: Number(rows[0].source_revision),
        } as DependencyEntry;
      },
      onError: (error, where) =>
        log(
          `interception ${where}: ${core
            .redact(error instanceof Error ? error.message : String(error))
            .slice(0, 200)}`,
        ),
    });

    const pages = deps.workspace?.pages;
    if (pages) {
      const previous = pages.onRevision;
      let queue: Promise<void> = Promise.resolve();
      pages.onRevision = (event) => {
        previous?.(event);
        const page = event.page;
        if (!page) return;
        queue = queue.then(async () => {
          try {
            const registered = await withTransaction(
              pools.background,
              (client) =>
                registerObservation(client, {
                  source: {
                    key: `opendots.page/${page.id}` as SourceRef['key'],
                    sourceType: 'page_snapshot',
                    authority: 'observed',
                    scope: {
                      ownerId: core.ownerId,
                      missionId: WATCHER_MISSION_ID,
                      spaceId: page.spaceId,
                      environment: 'dev',
                      resource: 'checkout',
                    },
                  },
                  normalizedValue: {
                    pageId: page.id,
                    spaceId: page.spaceId,
                    revision: page.revision,
                    title: page.title,
                    contentDigest: pageDigest(page),
                  },
                  provenance: { kind: 'watcher' },
                }),
            );
            if (registered.invalidation)
              await coordinator.onInvalidation(registered.invalidation);
          } catch (error) {
            log(
              `page revision not recorded: ${core
                .redact(error instanceof Error ? error.message : String(error))
                .slice(0, 160)}`,
            );
          }
        });
      };
      restorePageHook = () => {
        pages.onRevision = previous;
      };
    }
    interceptionOn = true;
  }

  function uninstallInterception() {
    if (!interceptionOn) return;
    setActivePolicy(null);
    setInterceptionRuntime(null);
    restorePageHook?.();
    restorePageHook = null;
    interceptionOn = false;
  }

  // --------------------------------------------------------------- start
  async function init(): Promise<void> {
    const reachable = await withTimeout(pools.app.query('SELECT 1'), 5_000);
    if (!reachable) throw new Error('PostgreSQL is unreachable');
    migrations = await checkMigrations(config);

    installInterception();
    // Redis and the provider are verified, never required to start: health
    // and the mission routes report them honestly.
    await core.connectRedis();
    if (core.inference) {
      const ok = await withTimeout(core.verifyProvider(), 10_000);
      log(
        `provider ${core.inference.host()} model ${core.models.worker}: ${
          ok ? 'verified' : 'NOT verified'
        }`,
      );
    }

    await coordinator.outbox.start();
    outboxRunning = true;
    await watcher.start();
    for (const host of core.hosts) host.start();
    hostsRunning = core.hosts.length > 0;
    const sweepEvery = Math.max(2_000, Math.floor(config.dispatchLeaseMs / 3));
    sweepTimer = setInterval(() => {
      if (sweeping || stopped) return;
      sweeping = true;
      core.actions
        .sweep(`${coordinator.workerId}-sweep`)
        .then((report) => {
          for (const failure of report.errors)
            log(
              `action sweep ${failure.actionId}: ${core.redact(failure.error).slice(0, 160)}`,
            );
        })
        .catch((error: unknown) =>
          log(
            `action sweep: ${core
              .redact(error instanceof Error ? error.message : String(error))
              .slice(0, 160)}`,
          ),
        )
        .finally(() => {
          sweeping = false;
        });
    }, sweepEvery);
    sweepTimer.unref?.();
    state = 'running';
    detail = null;
    log(
      `running: mode ${core.mode}, ${core.hosts.length} worker(s), instance ${config.instance}`,
    );
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      void attempt();
    }, 3_000);
    retryTimer.unref?.();
  }

  async function attempt(): Promise<void> {
    try {
      await init();
    } catch (error) {
      if (error instanceof MigrationsPendingError) {
        state = 'migrations_pending';
        detail = `${error.pending.length} pending, ${error.unknown.length} unknown`;
        migrations = 'pending';
        log(error.message);
        throw error;
      }
      if (state !== 'degraded')
        log(
          `waiting for PostgreSQL (${core
            .redact(error instanceof Error ? error.message : String(error))
            .slice(0, 120)})`,
        );
      state = 'degraded';
      detail = 'PostgreSQL unreachable';
      scheduleRetry();
    }
  }

  return {
    router,
    get state() {
      return state;
    },
    async start() {
      if (stopped) throw new Error('NemoDots has been stopped.');
      if (state === 'running') return;
      starting ??= (async () => {
        state = 'starting';
        try {
          await attempt();
        } finally {
          starting = null;
        }
      })();
      await starting;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      const step = async (name: string, work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          log(
            `stop ${name}: ${core
              .redact(error instanceof Error ? error.message : String(error))
              .slice(0, 160)}`,
          );
        }
      };
      await step('injector', async () => {
        await Promise.all([...runs].map((run) => run.cancel()));
        runs.clear();
      });
      await step('workers', () =>
        Promise.all(core.hosts.map((host) => host.stop())),
      );
      hostsRunning = false;
      await step('watcher', () => watcher.stop());
      await step('outbox', () => coordinator.outbox.stop());
      outboxRunning = false;
      uninstallInterception();
      await step('pools', () => core.close());
      state = 'stopped';
    },
    health: healthRequest,
    runtime,
  };
}

/** NemoDots for a process in which it cannot be composed: only /health answers. */
function unavailable(
  env: Env,
  log: (line: string) => void,
  state: 'unconfigured' | 'misconfigured',
  reason: string,
): NemoDots {
  const router = createUnavailableRouter({ env, state, reason });
  if (state === 'misconfigured') log(`not composed: ${reason}`);
  return {
    router,
    get state() {
      return state;
    },
    async start() {},
    async stop() {},
    async health() {
      const response = await router.request('/health');
      return (await response.json()) as HealthStatus;
    },
    async runtime() {
      const response = await router.request('/runtime');
      return (await response.json()) as RuntimeHealth;
    },
  };
}

export type { RuntimeHealth, NemoDotsState, MigrationState };
