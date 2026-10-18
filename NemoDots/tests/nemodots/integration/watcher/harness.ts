// Shared fixture for the watcher integration suites. Everything below runs
// against real PostgreSQL (a fresh migrated nemodots_test_<hex> database), the
// real checkout API (in process), the real source readers, the real ledger and
// the real coordinator. The ONLY doubles are labelled:
//
//   recovery.onSelfWriteSettled  stands in for the actions package's
//                                settleFromHistory: it moves the committed
//                                intent to verified / failed(postcondition_mismatch)
//                                with SQL (the table is real) and then calls the
//                                REAL coordinator recovery.
//   StubValidator / no-op ledger writer / empty snapshot reader
//                                collaborators of the coordinator that the
//                                watcher never reaches.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  digest,
  type ActionId,
  type MissionId,
  type PgClient,
  type SourceKey,
  type SourceReaderPort,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  createCoordinator,
  type Coordinator,
  type IntentReader,
  type LedgerWriterPort,
} from '../../../../src/server/nemodots/coordinator/index.js';
import { recordReadSet } from '../../../../src/server/nemodots/ledger/index.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import {
  advanceConfig,
  configValueDigest,
  type ConfigScalar,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import {
  createSqlIntentSettlement,
  createWatcher,
  type IntentSettlementPort,
  type Watcher,
  type WatcherConfig,
  type WatcherEvent,
  type WatcherRecovery,
} from '../../../../src/server/nemodots/watcher/index.js';
import {
  DEFAULT_CONFIG,
  StubValidator,
  claimStart,
  emptyTelemetry,
  plannedMission,
  type Harness,
} from '../coordinator/harness.js';
import { withSandbox, type Sandbox } from '../sandbox/harness.js';

export const OWNER = 'owner';
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 5_000,
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

/** IntentReader (the coordinator's read side) over the real action_intents table. */
function sqlIntentReader(pool: pg.Pool): IntentReader {
  return {
    async find(client: PgClient, actionId: ActionId) {
      const { rows } = await client.query<{
        id: ActionId;
        mission_id: MissionId;
        task_id: string;
        attempt_id: string;
        status: string;
      }>(
        'SELECT id, mission_id, task_id, attempt_id, status FROM coordinator.action_intents WHERE id = $1',
        [actionId],
      );
      return rows[0]
        ? ({
            id: rows[0].id,
            missionId: rows[0].mission_id,
            taskId: rows[0].task_id,
            attemptId: rows[0].attempt_id,
            status: rows[0].status,
          } as never)
        : null;
    },
    async statuses(client: PgClient, ids: readonly string[]) {
      const { rows } = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM coordinator.action_intents WHERE id = ANY($1::uuid[])',
        [[...ids]],
      );
      return rows as never;
    },
    async committedEffects(client: PgClient, missionId: MissionId) {
      void pool;
      const { rows } = await client.query<{ id: ActionId }>(
        `SELECT id FROM coordinator.action_intents
          WHERE mission_id = $1 AND status IN ('committed', 'dispatched', 'verified')`,
        [missionId],
      );
      return rows.map((row) => row.id);
    },
  };
}

const noopLedgerWriter: LedgerWriterPort = {
  async recordModelCall() {},
  async recordArtifact() {},
};

export interface WatcherEnv {
  s: Sandbox;
  /** nemodots_app pool (the server's role). */
  app: pg.Pool;
  admin: pg.Pool;
  injector: pg.Pool;
  coordinator: Coordinator;
  readers: SourceReaderPort;
  intents: IntentSettlementPort;
  recovery: WatcherRecovery;
  /** Every settle call the watcher made, in order. */
  settled: { actionId: string; outcome: 'verified' | 'failed' }[];
  /** Every pauseMission call. */
  paused: string[];
  /** Every event the watchers of this env emitted. */
  events: WatcherEvent[];
  watcherConfig(overrides?: Partial<WatcherConfig>): WatcherConfig;
  /** A watcher over this database; stopped automatically when the env closes. */
  watcher(options?: {
    config?: Partial<WatcherConfig>;
    readers?: SourceReaderPort;
    recovery?: WatcherRecovery;
  }): Watcher;
}

export async function withWatcherEnv<T>(
  fn: (env: WatcherEnv) => Promise<T>,
): Promise<T> {
  return withSandbox(async (s) => {
    const app = s.pools.app;
    const admin = s.pools.admin;
    const coordinator = createCoordinator({
      pool: app,
      config: DEFAULT_CONFIG,
      supportValidator: new StubValidator(),
      ledger: noopLedgerWriter,
      async recordOrphanedAttempt() {},
      intents: sqlIntentReader(app),
      actions: {
        async admit() {
          return {} as never;
        },
        async cancelQueued() {
          return [];
        },
      },
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
          } as never;
        },
      },
      probe: null,
      providerHealthy: async () => true,
    });
    const readers = createSourceReaders({
      pg: app,
      redis: s.redis.client,
      redisPrefix: s.redis.prefix,
      checkoutUrl: 'http://checkout.invalid',
      fetch: s.fetch,
      now: s.clock.now,
      probeSecret: s.probeSecret,
    });
    const settled: WatcherEnv['settled'] = [];
    const paused: string[] = [];
    const events: WatcherEvent[] = [];
    const recovery: WatcherRecovery = {
      onInvalidation: (event) => coordinator.onInvalidation(event),
      async onSelfWriteSettled(actionId, outcome) {
        settled.push({ actionId, outcome });
        // test double for actions.settleFromHistory (the table is real)
        await admin.query(
          outcome === 'verified'
            ? `UPDATE coordinator.action_intents
                  SET status = 'verified', status_version = status_version + 1, verified_at = now()
                WHERE id = $1 AND status = 'committed'`
            : `UPDATE coordinator.action_intents
                  SET status = 'failed', status_version = status_version + 1, failed_at = now(),
                      failure_reason = 'postcondition_mismatch'
                WHERE id = $1 AND status = 'committed'`,
          [actionId],
        );
        await coordinator.onSelfWriteSettled(actionId, outcome);
      },
      async pauseMission(missionId) {
        paused.push(missionId);
        await coordinator.control.pause(missionId);
      },
    };
    const created: Watcher[] = [];
    const env: WatcherEnv = {
      s,
      app,
      admin,
      injector: s.pools.injector,
      coordinator,
      readers,
      intents: createSqlIntentSettlement({ pool: app }),
      recovery,
      settled,
      paused,
      events,
      watcherConfig: (overrides = {}) => ({
        ownerId: OWNER,
        environment: 'test',
        intervalMs: 60_000,
        ...overrides,
      }),
      watcher(options = {}) {
        const watcher = createWatcher({
          pool: app,
          listenUrl: s.db.urls.app,
          readers: options.readers ?? readers,
          recovery: options.recovery ?? recovery,
          intents: env.intents,
          config: env.watcherConfig(options.config),
          onEvent: (event) => events.push(event),
        });
        created.push(watcher);
        return watcher;
      },
    };
    try {
      return await fn(env);
    } finally {
      await Promise.allSettled(created.map((watcher) => watcher.stop()));
      await coordinator.outbox.stop();
    }
  });
}

// ------------------------------------------------------------ queries

export interface ReceiptSummary {
  id: string;
  revision: number;
  status: string;
  selfWrite: string;
  causedByActionId: string | null;
  provenanceKind: string;
  collectionRevision: number | null;
  normalizedValue: unknown;
  supersededBy: string | null;
  missionId: string;
}

export async function receiptsOf(
  env: Pick<WatcherEnv, 'admin'>,
  key: string,
): Promise<ReceiptSummary[]> {
  const { rows } = await env.admin.query(
    `SELECT r.id, r.source_revision, r.status, r.self_write, r.caused_by_action_id,
            r.provenance_kind, r.collection_revision, r.normalized_value,
            r.superseded_by, r.mission_id
       FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
      WHERE s.key = $1 AND s.owner_id = $2 ORDER BY r.source_revision`,
    [key, OWNER],
  );
  return rows.map((row) => ({
    id: row.id,
    revision: Number(row.source_revision),
    status: row.status,
    selfWrite: row.self_write,
    causedByActionId: row.caused_by_action_id,
    provenanceKind: row.provenance_kind,
    collectionRevision:
      row.collection_revision === null ? null : Number(row.collection_revision),
    normalizedValue: row.normalized_value,
    supersededBy: row.superseded_by,
    missionId: row.mission_id,
  }));
}

export async function headOf(
  env: Pick<WatcherEnv, 'admin'>,
  key: string,
): Promise<ReceiptSummary> {
  const all = await receiptsOf(env, key);
  const head = all.at(-1);
  if (!head) throw new Error(`no receipt for ${key}`);
  return head;
}

export async function confirmationCount(
  env: Pick<WatcherEnv, 'admin'>,
  key: string,
): Promise<number> {
  const { rows } = await env.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM ledger.receipt_confirmations c
       JOIN ledger.observation_receipts r ON r.id = c.receipt_id
       JOIN ledger.sources s ON s.id = r.source_id
      WHERE s.key = $1 AND s.owner_id = $2`,
    [key, OWNER],
  );
  return Number(rows[0].n);
}

export async function lastConfirmedAt(
  env: Pick<WatcherEnv, 'admin'>,
  receiptId: string,
): Promise<Date> {
  const { rows } = await env.admin.query<{ at: Date }>(
    `SELECT GREATEST(r.observed_at, COALESCE(max(c.confirmed_at), r.observed_at)) AS at
       FROM ledger.observation_receipts r
       LEFT JOIN ledger.receipt_confirmations c ON c.receipt_id = r.id
      WHERE r.id = $1 GROUP BY r.id`,
    [receiptId],
  );
  return rows[0].at;
}

export interface LedgerEvent {
  id: string;
  sourceKey: string;
  oldReceiptId: string;
  newReceiptId: string | null;
  reason: string;
  selfWrite: string;
  missionIds: string[];
  affected: Record<string, string[]>;
  perMission: {
    missionId: string;
    affected: Record<string, string[]>;
    preserved: { taskIds: string[] };
  }[];
  closure: { depth: number; nodes: number; capped: boolean };
}

export async function ledgerEvents(
  env: Pick<WatcherEnv, 'admin'>,
  sourceKey?: string,
): Promise<LedgerEvent[]> {
  const { rows } = await env.admin.query(
    `SELECT id, source_key, old_receipt_id, new_receipt_id, reason, self_write,
            mission_ids, affected, per_mission, closure
       FROM ledger.invalidation_events
      WHERE ($1::text IS NULL OR source_key = $1) ORDER BY created_at, id`,
    [sourceKey ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    sourceKey: row.source_key,
    oldReceiptId: row.old_receipt_id,
    newReceiptId: row.new_receipt_id,
    reason: row.reason,
    selfWrite: row.self_write,
    missionIds: row.mission_ids,
    affected: row.affected,
    perMission: row.per_mission,
    closure: row.closure,
  }));
}

export async function configState(
  env: Pick<WatcherEnv, 'admin'>,
  key: string,
): Promise<{ value: unknown; version: number }> {
  const { rows } = await env.admin.query(
    'SELECT value, version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  return { value: rows[0].value, version: Number(rows[0].version) };
}

export async function collectionVersion(
  env: Pick<WatcherEnv, 'admin'>,
): Promise<number> {
  const { rows } = await env.admin.query(
    'SELECT version FROM checkout.config_collection',
  );
  return Number(rows[0].version);
}

// ---------------------------------------------------------- writers

/** An injector write: nemodots_injector role, actor 'injector', no action marker. */
export async function injectorWrite(
  env: Pick<WatcherEnv, 'injector'>,
  key: string,
  value: ConfigScalar,
): Promise<number> {
  const client = await env.injector.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ version: string }>(
      'SELECT version FROM checkout.config_entries WHERE key = $1 FOR UPDATE',
      [key],
    );
    const result = await advanceConfig(client, {
      key,
      value,
      expectedVersion: Number(current.rows[0].version),
      causedBy: { actor: 'injector' },
    });
    await client.query('COMMIT');
    return result.versionAfter;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The commit of an action as the actions package performs it: advanceConfig on
 * the app role with the action id as the self-write marker. (The real commit
 * transaction also settles the intent row; these suites keep the intent
 * `committed` so the watcher's history walk is what settles it.)
 */
export async function actionCommit(
  env: Pick<WatcherEnv, 'app'>,
  input: { actionId: string; key: string; value: ConfigScalar },
): Promise<number> {
  const client = await env.app.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ version: string }>(
      'SELECT version FROM checkout.config_entries WHERE key = $1 FOR UPDATE',
      [input.key],
    );
    const result = await advanceConfig(client, {
      key: input.key,
      value: input.value,
      expectedVersion: Number(current.rows[0].version),
      causedBy: { actor: 'action', actionId: input.actionId },
    });
    await client.query('COMMIT');
    return result.versionAfter;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------- missions

export interface MissionAttempt {
  taskId: string;
  attemptId: string;
  context: Awaited<ReturnType<typeof claimStart>>['context'];
}

export interface FixtureMission {
  missionId: MissionId;
  attempts: MissionAttempt[];
}

/**
 * A running mission (real coordinator) whose tasks each have a running attempt
 * that READ the listed sources: their current head receipts are recorded as the
 * attempt's read set (evidence edges), exactly what the ledger's closure walks.
 * `reads[i]` are the source keys attempt i read; [] reads nothing.
 */
export async function missionReading(
  env: WatcherEnv,
  reads: string[][],
  role: 'investigator' | 'cache_specialist' = 'investigator',
): Promise<FixtureMission> {
  const harness = { coordinator: env.coordinator } as unknown as Harness;
  const planned = await plannedMission(
    harness,
    reads.map(() => ({ role })),
  );
  const attempts: MissionAttempt[] = [];
  for (const [i, taskId] of planned.taskIds.entries()) {
    const claimed = await claimStart(harness, {
      taskId,
      missionId: planned.missionId,
    });
    const receiptIds: string[] = [];
    for (const key of reads[i]) {
      const { rows } = await env.admin.query<{ id: string }>(
        `SELECT r.id FROM ledger.observation_receipts r
           JOIN ledger.sources s ON s.id = r.source_id
          WHERE s.key = $1 AND s.owner_id = $2 AND r.status = 'supported'
          ORDER BY r.source_revision DESC LIMIT 1`,
        [key, OWNER],
      );
      if (!rows[0]) throw new Error(`no current receipt for ${key}`);
      receiptIds.push(rows[0].id);
    }
    if (receiptIds.length > 0) {
      const client = await env.app.connect();
      try {
        await client.query('BEGIN');
        await recordReadSet(client, {
          missionId: planned.missionId,
          taskId,
          attemptId: claimed.context.attemptId,
          receiptIds,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    attempts.push({
      taskId,
      attemptId: claimed.context.attemptId,
      context: claimed.context,
    });
  }
  return { missionId: planned.missionId, attempts };
}

export async function attemptStatus(
  env: Pick<WatcherEnv, 'admin'>,
  attemptId: string,
): Promise<string> {
  const { rows } = await env.admin.query<{ status: string }>(
    'SELECT status FROM coordinator.task_attempts WHERE id = $1',
    [attemptId],
  );
  return rows[0].status;
}

export async function taskStatus(
  env: Pick<WatcherEnv, 'admin'>,
  taskId: string,
): Promise<string> {
  const { rows } = await env.admin.query<{ status: string }>(
    'SELECT status FROM coordinator.tasks WHERE id = $1',
    [taskId],
  );
  return rows[0].status;
}

export async function missionStatus(
  env: Pick<WatcherEnv, 'admin'>,
  missionId: string,
): Promise<string> {
  const { rows } = await env.admin.query<{ status: string }>(
    'SELECT status FROM coordinator.missions WHERE id = $1',
    [missionId],
  );
  return rows[0].status;
}

export async function recoveryKinds(
  env: Pick<WatcherEnv, 'admin'>,
  missionId: string,
): Promise<string[]> {
  const { rows } = await env.admin.query<{ kind: string }>(
    `SELECT kind FROM coordinator.recovery_events
      WHERE mission_id = $1 ORDER BY created_at, id`,
    [missionId],
  );
  return rows.map((row) => row.kind);
}

// ----------------------------------------------------------- intents

/**
 * A `committed` set_config intent as the actions package leaves it after the
 * commit transaction, bound to the attempt that proposed it. Inserted with SQL
 * (the real action_intents table, constraints and triggers apply).
 */
export async function insertCommittedIntent(
  env: Pick<WatcherEnv, 'admin'>,
  input: {
    mission: FixtureMission;
    attemptIndex: number;
    key: string;
    value: ConfigScalar;
    status?: 'committed' | 'proposed';
    actionId?: string;
  },
): Promise<string> {
  const id = input.actionId ?? randomUUID();
  const attempt = input.mission.attempts[input.attemptIndex];
  const payload = {
    key: input.key,
    value: input.value,
    expectedCurrentValueDigest: digest('placeholder'),
  };
  const committed = (input.status ?? 'committed') === 'committed';
  await env.admin.query(
    `INSERT INTO coordinator.action_intents
       (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
        author_fencing_token, generation, action, adapter, payload, payload_hash,
        target_resource, target_source_key, target_environment, actor_capability,
        dependency_vector, required_sources, expected_target_version, policy_version,
        idempotency_key, expires_at, rationale, status,
        dispatch_fence, dispatch_owner, dispatcher_lease_expires_at,
        committed_target_version, committed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 'set_config', 'checkout_config', $7::jsonb, $8,
             'checkout', $9, 'test', 'propose_config_change', '[]'::jsonb, ARRAY[]::text[], 1,
             'policy-v1', $10, now() + interval '1 hour', 'watcher integration test', $11,
             $12, $13, $14, $15, $16)`,
    [
      id,
      input.mission.missionId,
      attempt.taskId,
      attempt.attemptId,
      randomUUID(),
      `tool-${id.slice(0, 8)}`,
      JSON.stringify(payload),
      digest(payload),
      `checkout.config/${input.key}`,
      digest(['idempotency', id]),
      committed ? 'committed' : 'proposed',
      committed ? 1 : null,
      committed ? 'test-dispatcher' : null,
      committed ? new Date(Date.now() + 3_600_000) : null,
      committed ? 2 : null,
      committed ? new Date() : null,
    ],
  );
  return id;
}

export async function intentStatus(
  env: Pick<WatcherEnv, 'admin'>,
  actionId: string,
): Promise<{ status: string; failureReason: string | null }> {
  const { rows } = await env.admin.query(
    'SELECT status, failure_reason FROM coordinator.action_intents WHERE id = $1',
    [actionId],
  );
  return { status: rows[0].status, failureReason: rows[0].failure_reason };
}

export { configValueDigest, type SourceKey };
