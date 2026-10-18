// The source watcher (W3.2). Every NEMODOTS_WATCH_INTERVAL_MS, and immediately
// on a nemodots_source_changed notification, the leader instance walks the
// sources the ledger already knows:
//   controlled  compare the authority version with the ledger's head receipt;
//               when it advanced, classify the config_versions history
//               (self-write.ts), settle the actions it names and register the
//               head value under the authority's own revision;
//   observed    read through the SourceReaderPort and call registerObservation
//               EVERY poll: an unchanged normalized value becomes a confirmation
//               (lastConfirmedAt advances, I2/D2), a changed one a new revision.
// It never registers a revision it did not read from the authority, never holds
// a ledger lock of its own (registerObservation takes coordinator rows first),
// and delivers each resulting InvalidationEvent to the RecoveryPort after the
// registration committed. Undelivered events are redelivered on later passes.
import type {
  ObservationReceipt,
  Scope,
  SourceKey,
  SourceRef,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import {
  COLLECTION_SOURCE_KEY,
  ControlledSourceMissingError,
  ClosureUnstableError,
  DigestMismatchError,
  RevisionMismatchError,
  StaleObservationRejectedError,
  configMemberKey,
  getInvalidationEvent,
  transitionReceipt,
  type RegisterObservationInput,
  type RegisterOptions,
  type RegisterResult,
} from '../ledger/index.js';
import { registerWithCapFallback } from './closure-cap.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import {
  classifyHistory,
  NO_SELF_WRITE,
  readHistory,
  type SelfWriteClassification,
} from './self-write.js';
import {
  emptyStats,
  type PassStats,
  type WatcherDeps,
  type WatcherLogEntry,
} from './types.js';

type Outcome = 'registered' | 'confirmed' | 'unchanged' | 'retracted';

interface WatchedSource {
  sourceId: string;
  ownerId: string;
  environment: SourceRef['scope']['environment'];
  resource: string;
  key: SourceKey;
  sourceType: SourceRef['sourceType'];
  authority: SourceRef['authority'];
  headId: string;
  headRevision: number;
  headStatus: ObservationReceipt['status'];
  missionId: string;
  spaceId: string | null;
}

const OBSERVED_TYPES = ['observed_endpoint', 'observed_store'] as const;
/** The acceptance probe registers checkout.acceptance itself. */
const NOT_POLLED = new Set<string>(['checkout.acceptance']);
const MAX_ATTEMPTS = 4;
const REDELIVERY_WINDOW = "interval '10 minutes'";

export interface Watcher {
  /** One leader-gated pass over every watched source. Null when not the leader. */
  tick(): Promise<PassStats | null>;
  /** A pass regardless of leadership (owner edits, tests). */
  pass(filter?: { keys?: readonly string[] }): Promise<PassStats>;
  /** Observes the named sources immediately (manual edits). */
  observe(keys: readonly string[]): Promise<PassStats>;
  start(): void;
  stop(): Promise<void>;
  isLeader(): boolean;
}

export function createWatcher(deps: WatcherDeps): Watcher {
  const log = (entry: WatcherLogEntry) => deps.log?.(entry);
  const registerOptions: Pick<RegisterOptions, 'ledger' | 'limits'> = {
    ledger: deps.ledger,
    limits: deps.limits,
  };
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const pending = new Set<string>();

  // Passes never overlap in one process; across processes the registry row lock
  // serializes registrations and the leader lock keeps one instance active.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const scheduler: Scheduler = createScheduler({
    pool: deps.pool,
    lockName: deps.lockName,
    onNotification: (payload) => {
      if (!running) return;
      let key: string | null = null;
      let membership = false;
      try {
        const parsed = JSON.parse(payload) as {
          key?: unknown;
          membershipChanged?: unknown;
        };
        if (typeof parsed.key === 'string') key = parsed.key;
        membership = parsed.membershipChanged === true;
      } catch {
        // malformed payload: the periodic pass still covers it
      }
      if (!key) return;
      pending.add(key);
      if (membership) pending.add(COLLECTION_SOURCE_KEY);
      void drainNotifications();
    },
    onLeaderChange: (leader) =>
      log({ event: leader ? 'leader_acquired' : 'leader_lost' }),
  });

  async function drainNotifications() {
    if (pending.size === 0) return;
    const keys = [...pending];
    pending.clear();
    await observeKeys(keys).catch(() => undefined);
  }

  // ------------------------------------------------------------------ listing

  async function listSources(
    keys?: readonly string[],
  ): Promise<WatchedSource[]> {
    const { rows } = await deps.pool.query<{
      id: string;
      owner_id: string;
      environment: SourceRef['scope']['environment'];
      resource: string;
      key: SourceKey;
      source_type: SourceRef['sourceType'];
      authority: SourceRef['authority'];
      receipt_id: string;
      source_revision: number;
      status: ObservationReceipt['status'];
      mission_id: string;
      space_id: string | null;
    }>(
      `SELECT s.id, s.owner_id, s.environment, s.resource, s.key, s.source_type, s.authority,
              h.id AS receipt_id, h.source_revision, h.status, h.mission_id, h.space_id
         FROM ledger.sources s
         JOIN LATERAL (SELECT r.id, r.source_revision, r.status, r.mission_id, r.space_id
                         FROM ledger.observation_receipts r
                        WHERE r.source_id = s.id
                        ORDER BY r.source_revision DESC LIMIT 1) h ON true
        WHERE (s.authority = 'controlled' OR s.source_type = ANY($1::text[]))
          AND ($2::text[] IS NULL OR s.key = ANY($2::text[]))
        ORDER BY s.key, s.id`,
      [[...OBSERVED_TYPES], keys ? [...keys] : null],
    );
    return rows
      .filter((row) => !NOT_POLLED.has(row.key))
      .map((row) => ({
        sourceId: row.id,
        ownerId: row.owner_id,
        environment: row.environment,
        resource: row.resource,
        key: row.key,
        sourceType: row.source_type,
        authority: row.authority,
        headId: row.receipt_id,
        headRevision: Number(row.source_revision),
        headStatus: row.status,
        missionId: row.mission_id,
        spaceId: row.space_id,
      }));
  }

  const refOf = (source: WatchedSource): SourceRef =>
    ({
      key: source.key,
      sourceType: source.sourceType,
      authority: source.authority,
      scope: {
        ownerId: source.ownerId,
        missionId: source.missionId,
        spaceId: source.spaceId,
        environment: source.environment,
        resource: source.resource,
      },
    }) as SourceRef;

  // -------------------------------------------------------------- registration

  async function register(
    source: WatchedSource,
    input: RegisterObservationInput,
  ): Promise<RegisterResult> {
    await deps.hooks?.beforeRegister?.({ sourceKey: source.key });
    const result = await registerWithCapFallback(
      {
        pool: deps.pool,
        missions: deps.missions,
        register: registerOptions,
        log,
      },
      input,
    );
    if (result.invalidation) await deliver(result.invalidation);
    return result;
  }

  async function deliver(event: NonNullable<RegisterResult['invalidation']>) {
    try {
      await deps.recovery.onInvalidation(event);
    } catch {
      // The event is durable in the ledger; redeliver() retries it.
      log({
        event: 'invalidation_delivery_failed',
        sourceKey: event.sourceKey,
      });
    }
  }

  /** At-least-once delivery: events the coordinator has not recorded yet. */
  async function redeliver(): Promise<number> {
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT e.id FROM ledger.invalidation_events e
        WHERE e.created_at > now() - ${REDELIVERY_WINDOW}
          AND jsonb_array_length(e.mission_ids) > 0
          AND NOT EXISTS (SELECT 1 FROM coordinator.invalidations c WHERE c.event_id = e.id)
        ORDER BY e.created_at LIMIT 50`,
    );
    let delivered = 0;
    for (const row of rows) {
      const event = await getInvalidationEvent(deps.pool, row.id);
      if (!event) continue;
      try {
        await deps.recovery.onInvalidation(event);
        log({ event: 'invalidation_redelivered', sourceKey: event.sourceKey });
        delivered += 1;
      } catch {
        log({
          event: 'invalidation_delivery_failed',
          sourceKey: event.sourceKey,
        });
      }
    }
    return delivered;
  }

  // ---------------------------------------------------------------- controlled

  async function syncController(source: WatchedSource): Promise<Outcome> {
    const isCollection = source.key === COLLECTION_SOURCE_KEY;
    const member = configMemberKey(source.key);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const head = (await listSources([source.key])).find(
        (item) => item.sourceId === source.sourceId,
      );
      if (!head) return 'unchanged';
      const live = await readAuthority(isCollection, member);
      if (live === null) {
        // The member was deleted: its receipt is retired, dependents invalidated.
        if (head.headStatus !== 'supported' && head.headStatus !== 'contested')
          return 'unchanged';
        await withTransaction(deps.pool, (client) =>
          transitionReceipt(
            client,
            {
              receiptId: head.headId,
              to: 'retracted',
              reason: 'source_removed',
            },
            registerOptions,
          ),
        );
        log({ event: 'retracted', sourceKey: source.key });
        return 'retracted';
      }
      if (head.headStatus === 'supported' && head.headRevision === live.version)
        return 'unchanged';
      if (head.headRevision > live.version) {
        log({
          event: 'stale_observation_rejected',
          sourceKey: source.key,
          revision: live.version,
          detail: `ledger is at ${head.headRevision}`,
        });
        return 'unchanged';
      }

      let classification: SelfWriteClassification = NO_SELF_WRITE;
      if (member) {
        const rows = await readHistory(
          deps.pool,
          member,
          head.headRevision,
          live.version,
        );
        // Settlement is idempotent, so a retry after the authority moved
        // simply walks the (longer) window again.
        classification = await classifyHistory(
          { intents: deps.intents, recovery: deps.recovery, log },
          source.key,
          rows,
        );
      }

      const value = await readValue(isCollection, member, live.version);
      if (value === null) continue; // moved under us: read again
      let result: RegisterResult;
      try {
        result = await register(head, {
          source: refOf(head),
          normalizedValue: value,
          provenance: {
            kind: 'watcher',
            causedByActionId: classification.causedByActionId,
            selfWrite: classification.selfWrite,
          },
        });
      } catch (error) {
        if (
          error instanceof StaleObservationRejectedError ||
          error instanceof RevisionMismatchError ||
          error instanceof DigestMismatchError
        ) {
          log({
            event:
              error instanceof StaleObservationRejectedError
                ? 'stale_observation_rejected'
                : 'authority_moved',
            sourceKey: source.key,
            revision: live.version,
          });
          continue;
        }
        if (error instanceof ControlledSourceMissingError) continue;
        throw error;
      }
      log({
        event: result.newRevision ? 'registered' : 'confirmed',
        sourceKey: source.key,
        revision: result.receipt.sourceRevision,
      });
      return result.newRevision ? 'registered' : 'confirmed';
    }
    return 'unchanged';
  }

  async function readAuthority(
    isCollection: boolean,
    member: string | null,
  ): Promise<{ version: number } | null> {
    if (isCollection) {
      const { rows } = await deps.pool.query<{ version: string }>(
        'SELECT version FROM checkout.config_collection',
      );
      return rows[0] ? { version: Number(rows[0].version) } : null;
    }
    const { rows } = await deps.pool.query<{ version: string }>(
      'SELECT version FROM checkout.config_entries WHERE key = $1',
      [member],
    );
    return rows[0] ? { version: Number(rows[0].version) } : null;
  }

  /** The authority's value at exactly `version`, or null when it moved. */
  async function readValue(
    isCollection: boolean,
    member: string | null,
    version: number,
  ): Promise<unknown | null> {
    if (isCollection) {
      const collection = await deps.pool.query<{ version: string }>(
        'SELECT version FROM checkout.config_collection',
      );
      const keys = await deps.pool.query<{ key: string }>(
        'SELECT key FROM checkout.config_entries ORDER BY key',
      );
      const current = Number(collection.rows[0]?.version);
      if (current !== version) return null;
      return {
        keys: keys.rows.map((row) => row.key).sort(),
        collectionVersion: current,
      };
    }
    const { rows } = await deps.pool.query<{ value: unknown; version: string }>(
      'SELECT value, version FROM checkout.config_entries WHERE key = $1',
      [member],
    );
    if (!rows[0] || Number(rows[0].version) !== version) return null;
    return { key: member, value: rows[0].value, version };
  }

  // ------------------------------------------------------------------ observed

  async function syncObserved(source: WatchedSource): Promise<Outcome> {
    const scope: Scope = refOf(source).scope;
    let read: Awaited<ReturnType<WatcherDeps['reader']['read']>>;
    try {
      read = await deps.reader.read(source.key, scope);
    } catch (error) {
      log({
        event: 'read_failed',
        sourceKey: source.key,
        detail: (error as Error).name,
      });
      return 'unchanged';
    }
    const result = await register(source, {
      source: refOf(source),
      normalizedValue: read.normalizedValue,
      provenance: { kind: 'watcher' },
    });
    log({
      event: result.newRevision ? 'registered' : 'confirmed',
      sourceKey: source.key,
      revision: result.receipt.sourceRevision,
    });
    return result.newRevision ? 'registered' : 'confirmed';
  }

  // -------------------------------------------------------------------- passes

  async function runPass(keys?: readonly string[]): Promise<PassStats> {
    const stats = emptyStats();
    const sources = await listSources(keys);
    stats.sources = sources.length;
    for (const source of sources) {
      try {
        const outcome =
          source.authority === 'controlled'
            ? await syncController(source)
            : await syncObserved(source);
        stats[outcome] += 1;
      } catch (error) {
        stats.errors += 1;
        log({
          event:
            error instanceof ClosureUnstableError
              ? 'closure_unstable'
              : 'source_error',
          sourceKey: source.key,
          detail: (error as Error).name,
        });
      }
    }
    stats.redelivered = await redeliver().catch(() => 0);
    return stats;
  }

  const observeKeys = (keys: readonly string[]) =>
    exclusive(() => runPass(keys));

  return {
    pass: (filter) => exclusive(() => runPass(filter?.keys)),
    observe: observeKeys,
    async tick() {
      if (!(await scheduler.ensureLeader())) return null;
      return exclusive(() => runPass());
    },
    start() {
      if (running) return;
      running = true;
      const loop = async () => {
        if (!running) return;
        try {
          await this.tick();
        } catch {
          // a failed pass is retried on the next tick
        }
        if (running) timer = setTimeout(loop, deps.intervalMs);
      };
      void loop();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await chain.catch(() => undefined);
      await scheduler.release();
    },
    isLeader: () => scheduler.isLeader(),
  };
}
