// Shared fixture for the watcher integration suites: the coordinator harness
// (real coordinator, real 0001-0004 migrations, app-role pool) plus the seeded
// checkout authority, an injector-role pool, a settable SourceReaderPort and
// labelled port doubles for the actions package:
//
//   IntentBook   SelfWriteIntentPort over the coordinator harness's FakeIntents;
//                records every settleFromHistory call. The real implementation
//                belongs to the actions package.
//   spyRecovery  RecoveryPort that records and then delegates to the REAL
//                coordinator recovery; can be told to fail once.
//   FakeReader   SourceReaderPort returning values the test sets; counts reads.
//
// Everything the watcher does to PostgreSQL (ledger, coordinator, checkout
// authority) is real.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  ActionId,
  InvalidationEvent,
  MissionId,
  ReceiptId,
  RecoveryPort,
  Scope,
  SourceKey,
  SourceReaderPort,
  TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import {
  addEdges,
  registerObservation,
  type RegisterResult,
} from '../../../../src/server/nemodots/ledger/index.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import {
  advanceConfigUnconditionallyTx,
  type AdvanceConfigResult,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import {
  createWatcher,
  type SelfWriteIntentPort,
  type SettleFromHistoryInput,
  type Watcher,
  type WatcherDeps,
  type WatcherLogEntry,
} from '../../../../src/server/nemodots/watcher/index.js';
import {
  attemptRow,
  claimStart,
  plannedMission,
  recoveryKinds,
  sleep,
  taskRow,
  until,
  withHarness,
  type Harness,
} from '../coordinator/harness.js';
import { sourceRef } from '../ledger/fixtures.js';

export {
  attemptRow,
  claimStart,
  plannedMission,
  recoveryKinds,
  sleep,
  taskRow,
  until,
};
export type { Harness };

export class FakeReader implements SourceReaderPort {
  values = new Map<string, unknown>();
  reads = 0;
  failing = false;
  async read(key: SourceKey, _scope: Scope) {
    this.reads += 1;
    if (this.failing) throw new Error('reader unavailable');
    if (!this.values.has(key)) throw new Error(`no value for ${key}`);
    return {
      normalizedValue: this.values.get(key),
      raw: null,
      revisionHint: null,
    };
  }
}

export class IntentBook implements SelfWriteIntentPort {
  expected = new Map<
    string,
    { sourceKey: SourceKey; expectedAfterDigest: string | null }
  >();
  settled: SettleFromHistoryInput[] = [];
  constructor(private readonly h: Harness) {}
  add(
    id: ActionId,
    missionId: MissionId,
    taskId: TaskId,
    attemptId: string,
    sourceKey: SourceKey,
    expectedAfterDigest: string | null,
  ) {
    this.expected.set(id, { sourceKey, expectedAfterDigest });
    this.h.intents.add({
      id,
      missionId,
      taskId,
      attemptId,
      status: 'committed',
    });
  }
  async find(actionId: ActionId) {
    const known = this.expected.get(actionId);
    const intent = this.h.intents.intents.get(actionId);
    if (!known || !intent) return null;
    return {
      id: actionId,
      sourceKey: known.sourceKey,
      status: intent.status,
      expectedAfterDigest: known.expectedAfterDigest,
    };
  }
  async settleFromHistory(input: SettleFromHistoryInput) {
    this.settled.push(input);
    this.h.intents.setStatus(
      input.actionId,
      input.outcome === 'verified' ? 'verified' : 'failed',
    );
  }
}

export interface RecoverySpy extends RecoveryPort {
  invalidations: InvalidationEvent[];
  settlements: { actionId: ActionId; outcome: 'verified' | 'failed' }[];
  /** Number of upcoming onInvalidation calls to reject. */
  failNext: number;
}

export interface WatcherEnv {
  h: Harness;
  reader: FakeReader;
  intents: IntentBook;
  recovery: RecoverySpy;
  logs: WatcherLogEntry[];
  /** nemodots_injector pool (the role the sandbox injector writes with). */
  injector: pg.Pool;
  make(overrides?: Partial<WatcherDeps>): Watcher;
  scope(missionId: string): Scope;
  /** An agent's first read of a controlled member: registers its receipt. */
  observeMember(missionId: string, key: string): Promise<RegisterResult>;
  observeCollection(missionId: string): Promise<RegisterResult>;
  observeEndpoint(
    missionId: string,
    key: string,
    value: unknown,
  ): Promise<RegisterResult>;
  /** evidence edge receipt -> attempt (what a read-set records). */
  link(receiptId: string, attempt: AttemptRef): Promise<void>;
  /** Injector-style write (no expected version, injector role). */
  inject(
    key: string,
    value: string | number | boolean,
  ): Promise<AdvanceConfigResult>;
  /** Registered watchers, stopped on exit. */
  watchers: Watcher[];
}

export interface AttemptRef {
  attemptId: string;
  taskId: string;
  missionId: string;
}

export async function withWatcherEnv<T>(
  fn: (env: WatcherEnv) => Promise<T>,
): Promise<T> {
  return withHarness(async (h) => {
    await seedCheckout(h.admin);
    const injector = createRolePool('injector', h.db.urls.injector, { max: 4 });
    const reader = new FakeReader();
    const intents = new IntentBook(h);
    const logs: WatcherLogEntry[] = [];
    const watchers: Watcher[] = [];
    const recovery: RecoverySpy = {
      invalidations: [],
      settlements: [],
      failNext: 0,
      async onInvalidation(event) {
        if (recovery.failNext > 0) {
          recovery.failNext -= 1;
          throw new Error('recovery unavailable');
        }
        recovery.invalidations.push(event);
        await h.coordinator.onInvalidation(event);
      },
      async onSelfWriteSettled(actionId, outcome) {
        recovery.settlements.push({ actionId, outcome });
        await h.coordinator.onSelfWriteSettled(actionId, outcome);
      },
    };
    const scope = (missionId: string): Scope => ({
      ownerId: h.config.ownerId,
      missionId: missionId as MissionId,
      spaceId: null,
      environment: 'test',
      resource: h.config.resource,
    });
    const refFor = (missionId: string, key: string) =>
      sourceRef(
        {
          ownerId: h.config.ownerId,
          missionId,
          environment: 'test',
          resource: h.config.resource,
        } as never,
        key,
      );
    const inTx = async <R>(work: (client: pg.PoolClient) => Promise<R>) => {
      const client = await h.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    const env: WatcherEnv = {
      h,
      reader,
      intents,
      recovery,
      logs,
      injector,
      watchers,
      scope,
      make(overrides = {}) {
        const watcher = createWatcher({
          pool: h.pool,
          reader,
          recovery,
          intents,
          missions: h.coordinator.control,
          intervalMs: 60_000,
          log: (entry) => logs.push(entry),
          ...overrides,
        });
        watchers.push(watcher);
        return watcher;
      },
      async observeMember(missionId, key) {
        return inTx(async (client) => {
          const { rows } = await client.query<{
            value: unknown;
            version: string;
          }>(
            'SELECT value, version FROM checkout.config_entries WHERE key = $1',
            [key],
          );
          return registerObservation(client, {
            source: refFor(missionId, `checkout.config/${key}`),
            normalizedValue: {
              key,
              value: rows[0].value,
              version: Number(rows[0].version),
            },
            provenance: { kind: 'tool_call' },
          });
        });
      },
      async observeCollection(missionId) {
        return inTx(async (client) => {
          const keys = await client.query<{ key: string }>(
            'SELECT key FROM checkout.config_entries ORDER BY key',
          );
          const version = await client.query<{ version: string }>(
            'SELECT version FROM checkout.config_collection',
          );
          return registerObservation(client, {
            source: refFor(missionId, 'checkout.config'),
            normalizedValue: {
              keys: keys.rows.map((row) => row.key).sort(),
              collectionVersion: Number(version.rows[0].version),
            },
            provenance: { kind: 'tool_call' },
          });
        });
      },
      async observeEndpoint(missionId, key, value) {
        reader.values.set(key, value);
        return inTx((client) =>
          registerObservation(client, {
            source: refFor(missionId, key),
            normalizedValue: value,
            provenance: { kind: 'tool_call' },
          }),
        );
      },
      async link(receiptId, attempt) {
        await inTx((client) =>
          addEdges(client, [
            {
              kind: 'evidence',
              from: { kind: 'receipt', id: receiptId },
              to: {
                kind: 'attempt',
                id: attempt.attemptId,
                missionId: attempt.missionId,
                taskId: attempt.taskId,
              },
            },
          ]),
        );
      },
      inject: (key, value) =>
        advanceConfigUnconditionallyTx(injector, {
          key,
          value,
          causedBy: { actor: 'injector' },
        }),
    };
    try {
      return await fn(env);
    } finally {
      for (const watcher of watchers) await watcher.stop().catch(() => {});
      await injector.end();
    }
  });
}

/** Receipt rows of one source, by revision. */
export async function receiptsOf(h: Harness, key: string) {
  const { rows } = await h.admin.query<{
    id: ReceiptId;
    source_revision: number;
    status: string;
    self_write: string;
    caused_by_action_id: string | null;
    provenance_kind: string;
  }>(
    `SELECT r.id, r.source_revision, r.status, r.self_write, r.caused_by_action_id, r.provenance_kind
       FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
      WHERE s.key = $1 ORDER BY r.source_revision`,
    [key],
  );
  return rows;
}

export async function confirmationCount(h: Harness, receiptId: string) {
  const { rows } = await h.admin.query<{ n: string }>(
    'SELECT count(*) AS n FROM ledger.receipt_confirmations WHERE receipt_id = $1',
    [receiptId],
  );
  return Number(rows[0].n);
}

export const newId = () => randomUUID();
