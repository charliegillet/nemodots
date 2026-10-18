// Composition root for NemoDots (W5.1). Ports are wired here and nowhere else.
//
//   const nemodots = createNemoDots(process.env, { workspace });
//   app.route('/api/nemodots', nemodots.router);   // inside createApp
//   await nemodots.start();                         // after the server listens
//   await nemodots.stop();                          // on shutdown
//
// Fail-closed rules:
//  - No role URL (env or .local/<instance>/stack/roles.env): the router answers
//    /health with the missing names and 503 for everything else. Upstream
//    OpenDots is unaffected.
//  - Live mode needs OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL. With any
//    missing, mode is `blocked`: no workers start and mission creation is 503.
//    There is no fallback provider and no default host.
//  - Pending or unknown migrations: start() throws and the router answers 503.
//  - PostgreSQL or Redis down: health reports it; the process keeps serving.
//
// Role URLs are read into this process only (never exported to children).
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type pg from 'pg';
import { createClient } from 'redis';
import {
  createActions,
  listAuthorizations,
  listIntents,
  listResultReceipts,
  type Actions,
} from './actions/index.js';
import {
  digest,
  sourceKeyFamily,
  type AttemptContext,
  type DependencyEntry,
  type HealthStatus,
  type MissionEvent,
  type MissionId,
  type ObservationReceipt,
  type PgClient,
  type ProviderMode,
  type Scope,
  type SourceKey,
  type SourceRef,
  type TaskId,
} from './contracts/index.js';
import {
  createCoordinator,
  createCoordinatorHandlers,
  createEventSink,
  createOutbox,
  ActionProposedPayloadSchema,
  type AttemptHandler,
  type Coordinator,
  type CoordinatorConfig,
  type ForeignSnapshot,
  type ForeignSnapshotReader,
  type LedgerWriterPort,
  type Outbox,
} from './coordinator/index.js';
import {
  NemoDotsEnvError,
  parseNemoDotsEnv,
  pgUrlEnvName,
  PG_ROLES,
  type NemoDotsConfig,
} from './config/env.js';
import { readRolesFile } from './config/roles-file.js';
import { createProbes, type ProbeSet } from './health.js';
import { createInferenceFromEnv } from './inference/index.js';
import { resolveMode, type ModeResolution } from './inference/mode.js';
import type { InferenceAdapter } from './inference/types.js';
import { discoverMigrations } from './db/migrate.js';
import { createRolePool } from './db/pool.js';
import {
  createIncidentPolicy,
  setActivePolicy,
  setInterceptionHooks,
  resetInterception,
  type PageRevisionEvent,
  type ProvenanceSink,
} from './interception/index.js';
import {
  currentReceipt,
  getInvalidationEvent,
  listConfirmations,
  listEvidence,
  recordModelCall,
  recordOrphanedAttempt,
  recordReadSet,
  registerObservation,
  createSupportValidator,
  addEdges,
  linkPublication,
  resolveMissionScope,
  type RegistrationLedgerOptions,
} from './ledger/index.js';
import {
  BadRequestError,
  evalsReportFromFile,
  nemodotsRoutes,
  createPgEventNotifier,
  type NemodotsRouteDeps,
} from './routes/index.js';
import { Injector } from './sandbox/injector.js';
import { listScenarios, loadScenario } from './sandbox/manifest.js';
import {
  acceptanceNormalizedValue,
  createProbe,
  type ProbeResult,
} from './sandbox/probe.js';
import { createSourceReaders } from './sandbox/readers.js';
import {
  createRunbookStore,
  createTeamHandler,
  type ChildOutput,
  type MissionTaskView,
  type SourceObserver,
  type TeamReads,
} from './team/index.js';
import {
  markMissionPhase,
  recordToolSpan,
  telemetrySummary,
  type MissionTimingPhase,
} from './telemetry/index.js';
import { createWatcher, ownerEdit, type Watcher } from './watcher/index.js';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

export type NemoDotsState =
  'unconfigured' | 'stopped' | 'starting' | 'running' | 'failed' | 'stopping';

export interface NemoDotsOptions {
  /** The authenticated owner of this OpenDots deployment. */
  workspace: { ownerId: string };
  appRoot?: string;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /**
   * The AttemptHandler the worker host runs. Defaults to the Nemotron team
   * (W4.1, `createTeamHandler`); tests may inject another.
   */
  handler?: AttemptHandler;
  /** Place the router under test without starting any background loop. */
  autoWorkers?: boolean;
}

export interface NemoDots {
  router: Hono;
  state(): NemoDotsState;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
}

export class MigrationsPendingError extends Error {
  constructor(
    readonly pending: string[],
    readonly unknown: string[],
  ) {
    super(
      `database migrations are not up to date (pending: ${pending.length}, unknown: ${unknown.length}); run npm run nemodots:migrate`,
    );
    this.name = 'MigrationsPendingError';
  }
}

// ---------------------------------------------------------------- environment

/**
 * A copy of `env` with the role URLs and the probe secret filled from the
 * instance's roles.env when the process environment lacks them. The copy is
 * never exported to child processes.
 */
export function resolveNemoDotsEnv(
  env: Record<string, string | undefined>,
  appRoot = APP_ROOT,
): Record<string, string | undefined> {
  const merged = { ...env };
  const needsFile =
    PG_ROLES.some((role) => !merged[pgUrlEnvName(role)]?.trim()) ||
    !merged.NEMODOTS_PROBE_SECRET?.trim();
  if (!needsFile) return merged;
  const instance = merged.NEMODOTS_INSTANCE?.trim() || 'dev';
  let file: Record<string, string>;
  try {
    file = readRolesFile(appRoot, instance);
  } catch {
    return merged; // no stack for this instance: the role URLs stay missing
  }
  for (const [name, value] of Object.entries(file))
    if (
      (name.startsWith('NEMODOTS_PG_URL_') ||
        name === 'NEMODOTS_PROBE_SECRET') &&
      !merged[name]?.trim()
    )
      merged[name] = value;
  return merged;
}

// ------------------------------------------------------------------- runtime

export interface Runtime {
  config: NemoDotsConfig;
  env: Record<string, string | undefined>;
  mode: ModeResolution;
  providerMode: ProviderMode;
  inference: InferenceAdapter | null;
  pools: {
    app: pg.Pool;
    verifier: pg.Pool;
    injector: pg.Pool;
    admin: pg.Pool | null;
  };
  redis: ReturnType<typeof createClient> | null;
  events: ReturnType<typeof createEventSink>;
  ledgerOptions: RegistrationLedgerOptions;
  actions: Actions;
  coordinator: Coordinator;
  outbox: Outbox;
  handler: AttemptHandler | null;
  probes: ProbeSet;
  close(): Promise<void>;
}

const CHECKOUT_ACCEPTANCE = 'checkout.acceptance' as SourceKey;

function sourceTypeOf(key: SourceKey): SourceRef['sourceType'] {
  const family = sourceKeyFamily(key);
  switch (family) {
    case 'checkout.config':
      return 'controlled_collection';
    case 'checkout.config/<key>':
      return 'controlled_config';
    case 'checkout.health':
    case 'checkout.metrics':
    case 'redis.stats':
      return 'observed_endpoint';
    case 'checkout.acceptance':
      return 'probe';
    case 'runbook/<id>':
      return 'runbook';
    case 'opendots.page/<pageId>':
      return 'page_snapshot';
    case 'opendots.memory/<memoryId>':
      return 'memory_snapshot';
    default:
      return 'observed_store';
  }
}

const refOf = (key: SourceKey, scope: Scope): SourceRef => {
  const sourceType = sourceTypeOf(key);
  return {
    key,
    sourceType,
    authority: sourceType.startsWith('controlled') ? 'controlled' : 'observed',
    scope,
  } as SourceRef;
};

async function inTx<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const EMPTY_TELEMETRY = {
  calls: 0,
  orphanedCalls: 0,
  tokens: {
    prompt: 0,
    completion: 0,
    cached: { available: false, total: null },
  },
  byModel: [],
  byRole: [],
  retries: 0,
  errors: 0,
  ttftMs: null,
  prefixGroups: [],
};

export function buildRuntime(
  rawEnv: Record<string, string | undefined>,
  options: NemoDotsOptions,
): Runtime {
  const env = resolveNemoDotsEnv(rawEnv, options.appRoot);
  const config = parseNemoDotsEnv(env);
  for (const role of ['app', 'verifier', 'injector'] as const)
    if (!config.pg.urls[role])
      throw new NemoDotsEnvError(
        [pgUrlEnvName(role)],
        `${pgUrlEnvName(role)} is not set.`,
      );
  if (!config.probe.secret)
    throw new NemoDotsEnvError(
      ['NEMODOTS_PROBE_SECRET'],
      'NEMODOTS_PROBE_SECRET is not set.',
    );
  const log = options.log ?? (() => {});
  const urls = config.pg.urls as Record<
    'app' | 'verifier' | 'injector',
    string
  > &
    Partial<Record<'admin', string>>;
  const pools = {
    app: createRolePool('app', urls.app),
    verifier: createRolePool('verifier', urls.verifier),
    injector: createRolePool('injector', urls.injector),
    admin: urls.admin ? createRolePool('admin', urls.admin, { max: 1 }) : null,
  };

  // ---- mode and inference (fail closed; no fallback provider)
  const mode = resolveMode(env);
  let inference: InferenceAdapter | null = null;
  if (mode.mode !== 'blocked')
    inference = createInferenceFromEnv({
      ...env,
      NEMODOTS_INFERENCE_MAX_IN_FLIGHT: String(config.inference.maxInFlight),
    });
  const providerMode: ProviderMode = mode.mode === 'live' ? 'live' : 'fixture';
  const providerHost = mode.mode === 'live' ? mode.host : 'fixture.invalid';
  const model =
    mode.mode === 'live' ? mode.model : env.OPENAI_MODEL?.trim() || 'fixture';

  // ---- redis (optional: effects fail with outcome_unknown when down)
  let redis: ReturnType<typeof createClient> | null = null;
  try {
    redis = createClient({
      url: config.redis.url,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 200, 2_000),
      },
    });
    redis.on('error', () => undefined); // surfaced through health, never printed
  } catch {
    redis = null;
  }

  const events = createEventSink();
  const ledgerOptions: RegistrationLedgerOptions = { events };
  const validator = createSupportValidator(ledgerOptions);
  const actions = createActions({
    pool: pools.app,
    validator,
    events,
    redis: redis as never,
    redisPrefix: config.redis.prefix,
    dispatchLeaseMs: config.dispatchLeaseMs,
  });

  const scopeOf = (missionId: string): Scope => ({
    ownerId: options.workspace.ownerId,
    missionId: missionId as MissionId,
    spaceId: null,
    environment: 'dev',
    resource: 'checkout',
  });

  // ---- coordinator
  const coordinatorConfig: CoordinatorConfig = {
    ownerId: options.workspace.ownerId,
    spaceId: null,
    environment: 'dev',
    resource: 'checkout',
    mode: providerMode,
    provider: {
      host: providerHost,
      plannerModel: config.inference.plannerModel ?? model,
      workerModel: config.inference.workerModel ?? model,
    },
    budgets: {
      maxTasks: config.maxTasks,
      maxDepth: config.maxDepth,
      maxBreadth: 4,
      maxTokens: 200_000,
      maxInferenceCalls: 200,
      maxWallClockMs: 600_000,
    },
    leaseMs: config.leaseMs,
    taskDefaults: { maxAttempts: 3, maxIterations: 12, maxTokens: 20_000 },
    replanCap: 3,
  };

  const ledgerWriter: LedgerWriterPort = {
    async recordModelCall(client, input) {
      await recordModelCall(client, {
        record: input.record,
        snapshot: input.snapshot,
      });
    },
    async recordArtifact(client, artifact) {
      const node = (kind: 'task_output' | 'task') => ({
        kind,
        id: artifact.id,
        missionId: artifact.missionId,
        taskId: kind === 'task' ? artifact.id : artifact.taskId,
      });
      // Findings are not graph nodes: they rest on the attempt, whose own
      // readset and model-call edges already carry the evidence.
      if (artifact.kind === 'finding') return;
      const target = node(artifact.kind);
      if (artifact.kind === 'task_output')
        await linkPublication(client, {
          missionId: artifact.missionId,
          taskId: artifact.taskId,
          attemptId: artifact.attemptId,
          modelCallIds: [],
          outputId: artifact.id,
        });
      await addEdges(
        client,
        artifact.dependencyVector.map((entry) => ({
          kind: 'evidence' as const,
          from: { kind: 'receipt' as const, id: entry.receiptId },
          to: target,
        })),
      );
    },
  };

  const snapshotReader: ForeignSnapshotReader = {
    async read(client, missionId): Promise<ForeignSnapshot> {
      const scope = scopeOf(missionId);
      const evidence = await listEvidence(client, {
        ownerId: scope.ownerId,
        environment: scope.environment,
        spaceId: scope.spaceId,
        resource: scope.resource,
        missionId,
        includeHistory: true,
      });
      const mine = evidence.filter((item) => item.consumers.length > 0);
      const confirmations = (
        await Promise.all(
          mine.map((item) => listConfirmations(client, item.receipt.id)),
        )
      ).flat();
      return {
        receipts: mine.map((item) => item.receipt),
        confirmations,
        actions: await listIntents(client, missionId),
        authorizations: await listAuthorizations(client, missionId),
        results: await listResultReceipts(client, missionId),
        probe: await currentReceipt(client, {
          ownerId: scope.ownerId,
          environment: scope.environment,
          spaceId: scope.spaceId,
          resource: scope.resource,
          key: CHECKOUT_ACCEPTANCE,
        }),
        telemetry: await telemetrySummary(client, missionId).catch(
          () => EMPTY_TELEMETRY as never,
        ),
      };
    },
  };

  // ---- probe (verifier role; registers the acceptance receipt in the ledger)
  const probe = createProbe({
    verifier: pools.verifier,
    checkoutUrl: config.checkout.url,
    probeSecret: config.probe.secret,
    windowMs: config.probe.windowMs,
    register: async (missionId, result: ProbeResult) =>
      inTx(pools.app, async (client) => {
        const scope = await resolveMissionScope(client, missionId);
        const registered = await registerObservation(
          client,
          {
            source: refOf(CHECKOUT_ACCEPTANCE, {
              ...scope,
              missionId,
            } as Scope),
            normalizedValue: acceptanceNormalizedValue(result),
            trust: 'probe',
            provenance: { kind: 'probe' },
          },
          { ledger: ledgerOptions },
        );
        return registered.receipt;
      }),
  });

  const providerHealthy = async () => {
    if (mode.mode !== 'live') return mode.mode === 'fixture';
    const state = await probes.provider();
    return state.reachable && state.modelListed;
  };

  const coordinator = createCoordinator({
    pool: pools.app,
    config: coordinatorConfig,
    supportValidator: validator,
    ledger: ledgerWriter,
    async recordOrphanedAttempt(info) {
      await inTx(pools.app, (client) =>
        recordOrphanedAttempt(client, {
          modelCallId: info.record.id,
          scope: info.record.scope,
          taskId: info.record.taskId,
          attemptId: info.record.attemptId,
          role: info.record.role,
          model: info.record.model,
          provider: info.record.provider,
          attempts: info.record.attempts,
        } as never),
      );
    },
    intents: actions.intents,
    actions,
    snapshotReader,
    probe,
    providerHealthy,
    events,
  });

  // ---- outbox: the coordinator's handlers plus the action boundary's
  const base = createCoordinatorHandlers(
    coordinator.deps,
    coordinator.recovery,
    {
      dispatcherId: 'nemodots-server',
    },
  );
  const dispatcher = `nemodots-${process.pid}`;
  const intentRow = async (actionId: string) => {
    const { rows } = await pools.app.query<{
      status: string;
      dispatch_fence: string | null;
    }>(
      'SELECT status, dispatch_fence FROM coordinator.action_intents WHERE id = $1',
      [actionId],
    );
    return rows[0] ?? null;
  };
  const outbox = createOutbox(coordinator.deps, {
    workerId: dispatcher,
    pollMs: 500,
    maintenance: async () => {
      await coordinator.runMaintenance();
      await actions.reclaimExpired(dispatcher);
      const stuck = await pools.app.query<{ id: string }>(
        `SELECT id FROM coordinator.action_intents
          WHERE status = 'outcome_unknown' ORDER BY proposed_at LIMIT 20`,
      );
      for (const row of stuck.rows) await actions.reconcile(row.id as never);
    },
    onError: (error) =>
      log('outbox_error', {
        message: error instanceof Error ? error.message : 'unknown',
      }),
    handlers: {
      ...base,
      // Admission waits minAgeMs (coordinator handler); an admitted intent is
      // then committed in its own G1 transaction and, for an external effect,
      // handed to the dispatch topic by the commit itself.
      'action.proposed': async (message, helpers) => {
        const deferred = await base['action.proposed'](message, helpers);
        if (deferred && 'deferUntil' in deferred) return deferred;
        const payload = ActionProposedPayloadSchema.parse(message.payload);
        const row = await intentRow(payload.actionId);
        if (row?.status === 'admitted' && row.dispatch_fence !== null)
          await actions.commit(payload.actionId, Number(row.dispatch_fence));
      },
      'action.dispatch': async (message) => {
        const { actionId } = message.payload as { actionId: string };
        const row = await intentRow(actionId);
        if (row?.status === 'committed' && row.dispatch_fence !== null)
          await actions.dispatch(
            actionId,
            Number(row.dispatch_fence),
            dispatcher,
          );
      },
    },
  });

  // ---- sources, observer, reads (the team's ports)
  const readers = createSourceReaders({
    pg: pools.app,
    redis: redis as never,
    redisPrefix: config.redis.prefix,
    checkoutUrl: config.checkout.url,
  });
  const observer: SourceObserver = {
    async observe(context: AttemptContext, input) {
      const key = input.sourceKey as SourceKey;
      const scope = scopeOf(context.missionId);
      const read = await readers.read(key, scope);
      return inTx(pools.app, async (client) => {
        const registered = await registerObservation(
          client,
          {
            source: refOf(key, scope),
            normalizedValue: read.normalizedValue,
            provenance: {
              kind: 'tool_call',
              toolCallId: input.toolCallId,
              modelCallId: input.modelCallId,
              attemptId: context.attemptId,
            } as never,
          },
          { ledger: ledgerOptions },
        );
        await recordReadSet(client, {
          missionId: context.missionId,
          taskId: context.taskId,
          attemptId: context.attemptId,
          receiptIds: [registered.receipt.id],
        });
        return registered.receipt as ObservationReceipt;
      });
    },
  };
  const q = <R extends Record<string, unknown>>(
    text: string,
    values: unknown[],
  ) => pools.app.query<R>(text, values);
  const reads: TeamReads = {
    scope: (context) => scopeOf(context.missionId),
    async outputsOf(context, taskIds): Promise<ChildOutput[]> {
      if (taskIds.length === 0) return [];
      const { rows } = await q(
        `SELECT t.id, t.role, t.status, o.id AS output_id, o.usable, o.content, o.digest,
                o.dependency_vector
           FROM coordinator.tasks t LEFT JOIN coordinator.task_outputs o ON o.id = t.output_id
          WHERE t.mission_id = $1 AND t.id = ANY($2::uuid[]) ORDER BY t.ordinal`,
        [context.missionId, [...taskIds]],
      );
      return rows.map((row) => ({
        taskId: row.id as TaskId,
        role: String(row.role),
        status: String(row.status),
        usable: row.output_id !== null && row.usable === true,
        text: String(
          (row.content as { summary?: string } | null)?.summary ?? '',
        ).slice(0, 3000),
        digest: (row.digest as string | null) ?? null,
        dependencyVector: (row.dependency_vector as DependencyEntry[]) ?? [],
      }));
    },
    async prerequisiteOutputs(context) {
      const { rows } = await q(
        `SELECT o.id, o.kind, o.usable, o.content, o.digest, o.dependency_vector
           FROM coordinator.tasks t
           JOIN coordinator.tasks p ON p.id = ANY (t.prerequisites)
           JOIN coordinator.task_outputs o ON o.id = p.output_id
          WHERE t.id = $1 AND o.kind <> 'plan'`,
        [context.taskId],
      );
      return rows.map((row) => ({
        kind: 'task_output' as const,
        id: String(row.id),
        digest: row.digest as string,
        text: String((row.content as { summary?: string })?.summary ?? ''),
        usable: row.usable === true,
        dependencyVector: (row.dependency_vector as DependencyEntry[]) ?? [],
      })) as never;
    },
    async invalidationSummaries(_context, invalidationEventId) {
      const event = await getInvalidationEvent(pools.app, invalidationEventId);
      if (!event) return [];
      return [
        {
          id: event.id,
          summary: `Source ${event.sourceKey} changed (${event.reason}); evidence read before this change is superseded. Re-read it before relying on it.`,
        },
      ] as never;
    },
    async missionTasks(context): Promise<MissionTaskView[]> {
      const { rows } = await q(
        `SELECT id, title, role, status, parent_id FROM coordinator.tasks
          WHERE mission_id = $1 ORDER BY ordinal`,
        [context.missionId],
      );
      return rows.map((row) => ({
        id: row.id as TaskId,
        title: String(row.title),
        role: String(row.role),
        status: String(row.status),
        parentId: (row.parent_id as TaskId | null) ?? null,
      }));
    },
  };

  const handler: AttemptHandler | null =
    options.handler ??
    (inference
      ? createTeamHandler({
          inference: Object.assign(inference, { mode: providerMode }),
          coordinator,
          observer,
          actions,
          reads,
          runbooks: createRunbookStore(),
          config: {
            model,
            provider: { host: providerHost, mode: providerMode },
          },
          onEvent: (event) => {
            if (event.kind === 'tool')
              log('tool', { name: event.name, ok: event.ok });
          },
        })
      : null);

  const probes = createProbes({
    provider:
      mode.mode === 'live'
        ? {
            target: {
              baseUrl: env.OPENAI_BASE_URL!.trim().replace(/\/+$/, ''),
              apiKey: env.OPENAI_API_KEY!.trim(),
              timeoutMs: 5_000,
            },
            model: mode.model,
          }
        : null,
    redis,
    checkoutUrl: config.checkout.url,
  });

  return {
    config,
    env,
    mode,
    providerMode,
    inference,
    pools,
    redis,
    events,
    ledgerOptions,
    actions,
    coordinator,
    outbox,
    handler,
    probes,
    async close() {
      await Promise.allSettled([
        redis?.isOpen ? redis.quit() : Promise.resolve(),
        pools.app.end(),
        pools.verifier.end(),
        pools.injector.end(),
        pools.admin?.end(),
      ]);
    },
  };
}

// -------------------------------------------------------------- unconfigured

function unconfiguredRouter(missing: string[]) {
  const router = new Hono();
  const body = {
    error: 'NemoDots is not configured.',
    missingEnv: missing,
  };
  router.get('/health', (c) =>
    c.json({
      mode: 'blocked',
      provider: {
        reachable: false,
        modelListed: false,
        model: null,
        host: null,
        checkedAt: null,
      },
      postgres: 'down',
      redis: 'down',
      checkout: { reachable: false, status: null },
      intelligence: 'blocked',
      missingEnv: missing,
      incidentDotIds: 0,
    } satisfies HealthStatus),
  );
  router.all('*', (c) => c.json(body, 503));
  return router;
}

// ------------------------------------------------------------ mission timing

const FIRST_ONLY = new Set<MissionTimingPhase>([
  'started',
  'first_model_call',
  'first_finding',
  'first_action',
]);

/** The phase mark a stored event implies, or null. Derived from the event only. */
export function phaseOfEvent(event: MissionEvent): MissionTimingPhase | null {
  const payload = event.payload as { kind: string; to?: string };
  switch (payload.kind) {
    case 'mission.created':
      return 'created';
    case 'mission.status':
      switch (payload.to) {
        case 'running':
          return 'started';
        case 'succeeded':
          return 'completed';
        case 'failed':
          return 'failed';
        case 'cancelled':
          return 'cancelled';
        default:
          return null;
      }
    case 'model_call.recorded':
      return 'first_model_call';
    case 'finding.published':
      return 'first_finding';
    case 'action.proposed':
      return 'first_action';
    case 'invalidation.recorded':
      return 'conflict_detected';
    case 'recovery.recorded':
      return 'recovery_started';
    case 'invalidation.resolved':
      return 'recovered';
    default:
      return null;
  }
}

// --------------------------------------------------------------- createNemoDots

export function createNemoDots(
  rawEnv: Record<string, string | undefined>,
  options: NemoDotsOptions,
): NemoDots {
  const log = options.log ?? (() => {});
  let runtime: Runtime;
  try {
    runtime = buildRuntime(rawEnv, options);
  } catch (error) {
    const missing =
      error instanceof NemoDotsEnvError
        ? error.names.filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
        : ['NEMODOTS_INSTANCE'];
    log('unconfigured', { missing });
    return {
      router: unconfiguredRouter(missing),
      state: () => 'unconfigured',
      start: async () => undefined,
      stop: async () => undefined,
      health: async () =>
        (await (
          await Promise.resolve(unconfiguredRouter(missing).request('/health'))
        ).json()) as HealthStatus,
    };
  }

  const rt = runtime;
  let state: NemoDotsState = 'stopped';
  let failure: string | null = null;
  let watcher: Watcher | null = null;
  let unsubscribeTiming: (() => void) | null = null;
  const hosts: ReturnType<Coordinator['createWorkerHost']>[] = [];
  const injector = new Injector({
    pool: rt.pools.injector,
    listenUrl: rt.config.pg.urls.injector!,
  });
  const ownerId = options.workspace.ownerId;

  // ---- interception: ledger-backed revalidation and the page-revision feed
  const latestMission = async (client: PgClient) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM coordinator.missions WHERE owner_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [ownerId],
    );
    return rows[0]?.id ?? null;
  };
  const registerPage = async (
    pageId: string,
    value: Record<string, unknown>,
    provenanceKind: 'watcher' | 'tool_call',
  ): Promise<DependencyEntry | null> => {
    try {
      return await inTx(rt.pools.app, async (client) => {
        const missionId = await latestMission(client);
        if (!missionId) return null;
        const scope = await resolveMissionScope(client, missionId);
        const key = `opendots.page/${pageId}` as SourceKey;
        if (!sourceKeyFamily(key)) return null;
        const registered = await registerObservation(
          client,
          {
            source: refOf(key, { ...scope, missionId } as Scope),
            normalizedValue: value,
            provenance: { kind: provenanceKind },
          },
          { ledger: rt.ledgerOptions },
        );
        return {
          sourceKey: key,
          sourceRevision: registered.receipt.sourceRevision,
          receiptId: registered.receipt.id,
        } as DependencyEntry;
      });
    } catch (error) {
      log('page_registration_failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    }
  };
  const installInterception = () => {
    setActivePolicy(
      createIncidentPolicy({
        env: rt.env,
        vectors: {
          async isCurrent(vector) {
            if (vector.length === 0) return true;
            const { rows } = await rt.pools.app.query<{
              id: string;
              status: string;
              source_revision: number;
              head: number;
            }>(
              `SELECT r.id, r.status, r.source_revision,
                      (SELECT max(h.source_revision) FROM ledger.observation_receipts h
                        WHERE h.source_id = r.source_id) AS head
                 FROM ledger.observation_receipts r WHERE r.id = ANY($1::uuid[])`,
              [vector.map((entry) => entry.receiptId)],
            );
            const byId = new Map(rows.map((row) => [row.id, row]));
            return vector.every((entry) => {
              const row = byId.get(entry.receiptId);
              return (
                !!row &&
                row.status === 'supported' &&
                Number(row.source_revision) === Number(row.head)
              );
            });
          },
        },
      }),
    );
    const sink: ProvenanceSink = {
      // Dot turns belong to no mission: their snapshots and calls are not
      // recorded as ModelCallRecords (they have no mission/task/attempt).
      identify: () => null,
      async registerToolResult(info) {
        if (info.toolName !== 'read_space_page') return [];
        const page = info.result as { id?: unknown; revision?: unknown } | null;
        if (
          !page ||
          typeof page.id !== 'string' ||
          typeof page.revision !== 'number'
        )
          return [];
        const entry = await registerPage(
          page.id,
          { pageId: page.id, revision: page.revision },
          'tool_call',
        );
        return entry ? [entry] : [];
      },
    };
    setInterceptionHooks({
      providerMode: rt.providerMode,
      sink,
      pageRevision: (event: PageRevisionEvent) => {
        // Eventual by design: the page store is SQLite, the ledger PostgreSQL.
        // The page revision CAS stays the authority for page content.
        void registerPage(
          event.pageId,
          {
            pageId: event.pageId,
            revision: event.revision,
            deleted: event.revision === null,
          },
          'watcher',
        );
      },
    });
  };

  // ---- routes
  const routeDeps: NemodotsRouteDeps = {
    ownerId,
    pool: rt.pools.app,
    control: rt.coordinator.control,
    events: rt.coordinator.events,
    notifier: createPgEventNotifier(rt.config.pg.urls.app!),
    mode: () => rt.mode,
    ownerEdit: (edit) => {
      if (!watcher) throw new Error('watcher is not running');
      return ownerEdit({ pool: rt.pools.app, watcher }, edit);
    },
    startInjector: async (scenarioClass) => {
      const known = listScenarios();
      let id = known.includes(scenarioClass) ? scenarioClass : null;
      if (!id)
        id =
          known.find((candidate) => {
            try {
              return loadScenario(candidate).class === scenarioClass;
            } catch {
              return false;
            }
          }) ?? null;
      if (!id) throw new BadRequestError('Unknown scenario.');
      const run = await injector.start(loadScenario(id), randomInt(1, 2 ** 31));
      return { runId: run.runId };
    },
    checkoutHealth: async () => {
      const response = await fetch(`${rt.config.checkout.url}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await response.json()) as Record<string, unknown>;
      const checks = (body.checks ?? {}) as Record<string, boolean>;
      return {
        status: body.status,
        postgres: checks.postgres === true,
        redis: checks.redis === true,
        config_parse: checks.config_parse === true,
        writes: checks.writes === true,
        errorClasses: Array.isArray(body.errors)
          ? body.errors.filter((e): e is string => typeof e === 'string')
          : [],
        sampledAt: new Date().toISOString(),
      };
    },
    telemetry: (missionId) => telemetrySummary(rt.pools.app, missionId),
    evalsReport: evalsReportFromFile(
      path.join(
        options.appRoot ?? APP_ROOT,
        'artifacts',
        'nemodots',
        'evals',
        'summary.json',
      ),
    ),
    health: {
      provider: rt.probes.provider,
      redis: rt.probes.redis,
      checkout: rt.probes.checkout,
      intelligenceConfigured: () =>
        Boolean(
          (
            rt.env.INTELLIGENCE_API_KEY ?? rt.env.CPK_INTELLIGENCE_API_KEY
          )?.trim(),
        ),
      incidentDotIds: () => rt.config.incidentDotIds.length,
    },
  };
  const routes = nemodotsRoutes(routeDeps);
  const router = new Hono();
  router.use('*', async (c, next) => {
    if (state === 'failed' && !c.req.path.endsWith('/health'))
      return c.json(
        { error: 'NemoDots is not available.', reason: failure },
        503,
      );
    await next();
  });
  router.route('/', routes);

  const health = async (): Promise<HealthStatus> => {
    const response = await routes.request('/health');
    return (await response.json()) as HealthStatus;
  };

  const checkMigrations = async () => {
    if (!rt.pools.admin) return; // no admin role here: nothing to compare against
    const files = await discoverMigrations();
    const present = await rt.pools.admin.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    const rows = present.rows[0]?.present
      ? (
          await rt.pools.admin.query<{ id: string }>(
            'SELECT id FROM public.schema_migrations',
          )
        ).rows
      : [];
    const applied = new Set(rows.map((row) => row.id));
    const known = new Set(files.map((file) => file.id));
    const pending = files
      .filter((file) => !applied.has(file.id))
      .map((f) => f.id);
    const unknown = [...applied].filter((id) => !known.has(id));
    if (pending.length || unknown.length)
      throw new MigrationsPendingError(pending, unknown);
  };

  return {
    router,
    state: () => state,
    health,
    async start() {
      if (state === 'running' || state === 'starting') return;
      state = 'starting';
      try {
        await checkMigrations();
        if (rt.redis && !rt.redis.isOpen)
          await rt.redis.connect().catch(() => undefined);
        installInterception();
        watcher = createWatcher({
          pool: rt.pools.app,
          reader: createSourceReaders({
            pg: rt.pools.app,
            redis: rt.redis as never,
            redisPrefix: rt.config.redis.prefix,
            checkoutUrl: rt.config.checkout.url,
          }),
          recovery: rt.coordinator.recovery,
          intents: rt.actions.selfWriteIntents,
          missions: rt.coordinator.control,
          intervalMs: rt.config.watchIntervalMs,
          ledger: rt.ledgerOptions,
          log: (entry) => log('watcher', { ...entry }),
        });
        watcher.start();
        await rt.outbox.start();
        // Mission phase marks for the timing split, from the stored events.
        // Notification-driven: a dropped notification loses a mark, never data.
        unsubscribeTiming = await routeDeps.notifier!.subscribe(
          ({ missionId, id }) => {
            void (async () => {
              const [event] = await rt.coordinator.events.replay(
                missionId as MissionId,
                id - 1,
                1,
              );
              const phase =
                event && event.id === id ? phaseOfEvent(event) : null;
              if (!phase) return;
              if (FIRST_ONLY.has(phase)) {
                const seen = await rt.pools.app.query(
                  'SELECT 1 FROM ledger.mission_timing WHERE mission_id = $1 AND phase = $2',
                  [missionId, phase],
                );
                if (seen.rows.length > 0) return;
              }
              await markMissionPhase(
                rt.pools.app,
                missionId,
                phase,
                new Date(event.at),
              );
            })().catch((error) =>
              log('timing_mark_failed', {
                message: error instanceof Error ? error.message : 'unknown',
              }),
            );
          },
        );
        if (
          options.autoWorkers !== false &&
          rt.handler &&
          rt.mode.mode !== 'blocked' &&
          rt.config.workers > 0
        ) {
          const host = rt.coordinator.createWorkerHost({
            workerId: `nemodots-${process.pid}-${randomUUID().slice(0, 8)}`,
            handler: rt.handler,
            concurrency: rt.config.workers,
            onError: (error) =>
              log('worker_error', {
                message: error instanceof Error ? error.message : 'unknown',
              }),
          });
          host.start();
          hosts.push(host);
        }
        state = 'running';
      } catch (error) {
        failure =
          error instanceof MigrationsPendingError
            ? 'migrations_pending'
            : 'start_failed';
        state = 'failed';
        // Do not leave half a system running behind a failed start.
        unsubscribeTiming?.();
        unsubscribeTiming = null;
        await Promise.allSettled([
          ...hosts.splice(0).map((host) => host.stop()),
          watcher?.stop(),
          rt.outbox.stop(),
        ]);
        resetInterception();
        throw error;
      }
    },
    async stop() {
      if (state === 'stopped' || state === 'unconfigured') return;
      state = 'stopping';
      unsubscribeTiming?.();
      unsubscribeTiming = null;
      await Promise.allSettled(hosts.splice(0).map((host) => host.stop()));
      await watcher?.stop().catch(() => undefined);
      await rt.outbox.stop().catch(() => undefined);
      await (routeDeps.notifier as { close?: () => Promise<void> })
        .close?.()
        .catch(() => undefined);
      resetInterception();
      await rt.close();
      state = 'stopped';
    },
  };
}

// Re-exported so callers (tests, worker-main) can reuse the telemetry hooks
// that record tool spans and mission phases.
export { markMissionPhase, recordToolSpan, digest };
