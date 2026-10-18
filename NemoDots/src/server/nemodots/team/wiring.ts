import type pg from 'pg';
import type {
  ActionAdmissionPort,
  DependencyEntry,
  PgClient,
  SourceKey,
  SourceReaderPort,
} from '../contracts/index.js';
import { createEventSink } from '../coordinator/events.js';
import { createIntentReader } from '../actions/queries.js';
import { createActionService } from '../actions/service.js';
import {
  addReadSet,
  delegate,
  markWaiting,
  publishFinding,
  recordModelCall,
  requestReplan,
  resumeFromWaiting,
  type PublishDeps,
} from '../coordinator/publish.js';
import { getTaskStatus } from '../coordinator/queries.js';
import type {
  CoordinatorConfig,
  LedgerWriterPort,
} from '../coordinator/types.js';
import { addEdges, type EdgeInput } from '../ledger/edges.js';
import {
  createSupportValidator,
  recordModelCall as ledgerRecordModelCall,
  recordOrphanedAttempt,
} from '../ledger/index.js';
import type { TeamCoordinator } from './types.js';

// Default wiring for callers that hold only a database pool (the gate-3 team
// executor driver, tests). The composition root (bootstrap) normally injects
// its own coordinator, actions and readers. Nothing here is a stand-in: each
// piece is the real implementation bound to the given pool.

/**
 * SourceReaderPort for the two controlled families only (configuration members
 * and the membership collection), straight from the authority tables. Every
 * other key is refused; observed sources need the checkout readers injected.
 */
export function createAuthorityReader(pool: pg.Pool): SourceReaderPort {
  return {
    async read(key: SourceKey) {
      if (key === 'checkout.config') {
        const { rows } = await pool.query<{ keys: string[]; version: string }>(
          `SELECT COALESCE((SELECT array_agg(key ORDER BY key) FROM checkout.config_entries), '{}') AS keys,
                  (SELECT version FROM checkout.config_collection WHERE singleton) AS version`,
        );
        const collectionVersion = Number(rows[0].version);
        const value = { keys: rows[0].keys, collectionVersion };
        return {
          normalizedValue: value,
          raw: value,
          revisionHint: collectionVersion,
        };
      }
      if (key.startsWith('checkout.config/')) {
        const member = key.slice('checkout.config/'.length);
        const { rows } = await pool.query<{ value: unknown; version: string }>(
          'SELECT value, version FROM checkout.config_entries WHERE key = $1',
          [member],
        );
        if (!rows[0]) {
          const [tombstone, collection] = await Promise.all([
            pool.query<{ version: string }>(
              'SELECT COALESCE(max(version), 0) AS version FROM checkout.config_versions WHERE key = $1',
              [member],
            ),
            pool.query<{ version: string }>(
              'SELECT version FROM checkout.config_collection WHERE singleton',
            ),
          ]);
          return {
            normalizedValue: null,
            raw: {
              exists: false,
              key: member,
              collectionRevision: Number(collection.rows[0]?.version ?? 0),
            },
            revisionHint: Number(tombstone.rows[0]?.version ?? 0),
          };
        }
        const version = Number(rows[0].version);
        const value = { key: member, value: rows[0].value, version };
        return { normalizedValue: value, raw: value, revisionHint: version };
      }
      throw new Error('no reader configured for this source');
    },
  };
}

/**
 * LedgerWriterPort over the ledger package: the model call and its snapshot
 * go through ledger.recordModelCall; outputs and delegated tasks get evidence
 * edges from every receipt of their dependency vector. Findings are leaves
 * with no graph node kind: their vector is stored on the row and guarded at
 * publication.
 */
export function createLedgerWriter(): LedgerWriterPort {
  return {
    async recordModelCall(client: PgClient, input) {
      await ledgerRecordModelCall(client, {
        record: input.record,
        snapshot: input.snapshot,
      });
    },
    async recordArtifact(client: PgClient, artifact) {
      if (artifact.kind === 'finding') return;
      const kind: 'task' | 'task_output' = artifact.kind;
      const to = {
        kind,
        id: artifact.id,
        missionId: artifact.missionId,
        taskId: artifact.taskId,
      } as const;
      const edges: EdgeInput[] = artifact.dependencyVector.map(
        (entry: DependencyEntry) => ({
          kind: 'evidence' as const,
          from: { kind: 'receipt' as const, id: entry.receiptId },
          to,
        }),
      );
      await addEdges(client, edges);
    },
  };
}

export function defaultCoordinatorConfig(
  env: Record<string, string | undefined>,
): CoordinatorConfig {
  const int = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  let host = 'unconfigured';
  try {
    if (env.OPENAI_BASE_URL) host = new URL(env.OPENAI_BASE_URL).host;
  } catch {
    // keep the placeholder; the config is inert for publication
  }
  const model = env.OPENAI_MODEL || 'unconfigured';
  return {
    ownerId: env.OWNER_ID || 'owner',
    spaceId: null,
    environment: 'dev',
    resource: 'checkout',
    mode: env.NEMODOTS_INFERENCE_MODE === 'live' ? 'live' : 'fixture',
    provider: { host, plannerModel: model, workerModel: model },
    budgets: {
      maxTasks: int('NEMODOTS_MAX_TASKS', 24),
      maxDepth: int('NEMODOTS_MAX_DEPTH', 3),
      maxBreadth: 4,
      maxTokens: 400_000,
      maxInferenceCalls: 200,
      maxWallClockMs: 600_000,
    },
    leaseMs: int('NEMODOTS_LEASE_MS', 30_000),
    taskDefaults: { maxAttempts: 3, maxIterations: 12, maxTokens: 120_000 },
    replanCap: 3,
  };
}

/** The coordinator publication functions bound to a pool (no outbox, no worker host). */
export function createPublishingCoordinator(
  pool: pg.Pool,
  options: {
    env?: Record<string, string | undefined>;
    clock?: () => Date;
    config?: CoordinatorConfig;
  } = {},
): TeamCoordinator {
  const deps: PublishDeps = {
    pool,
    config: options.config ?? defaultCoordinatorConfig(options.env ?? {}),
    events: createEventSink(),
    supportValidator: createSupportValidator(),
    ledger: createLedgerWriter(),
    recordOrphanedAttempt: async (info) => {
      const { record } = info;
      await recordOrphanedAttempt(pool, {
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
    clock: options.clock ?? (() => new Date()),
  };
  return {
    addReadSet: (context, entries) => addReadSet(deps, context, entries),
    delegate: (context, body) => delegate(deps, context, body),
    publishFinding: (context, body) => publishFinding(deps, context, body),
    requestReplan: (context, reason) => requestReplan(deps, context, reason),
    markWaiting: (context) => markWaiting(deps, context),
    resumeFromWaiting: (context) => resumeFromWaiting(deps, context),
    getTaskStatus: (missionId, taskId) =>
      getTaskStatus(pool, missionId, taskId),
    recordModelCall: (context, body) => recordModelCall(deps, context, body),
  };
}

export function createDefaultActions(
  pool: pg.Pool,
): Pick<ActionAdmissionPort, 'propose'> {
  const service = createActionService({ pool });
  return { propose: (input, ctx) => service.propose(input, ctx) };
}
