import {
  InvalidationEventSchema,
  type InvalidationEvent,
  type MissionId,
  type PgClient,
  type SelfWrite,
  type SourceKey,
  type SourceType,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import {
  ClosureCapExceeded,
  ControlledSourceMissingError,
  DigestMismatchError,
  RevisionMismatchError,
  StaleObservationRejectedError,
  coordinatorSchema,
  registerObservation,
  transitionReceipt,
  type RegisterObservationInput,
  type RegisterResult,
} from '../ledger/index.js';
import { registerAfterClosureCap } from './closure-cap.js';
import {
  applySettlements,
  createSettlementCheck,
  sweepSettlements,
  walkHistory,
  type Classification,
} from './self-write.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import {
  COLLECTION_KEY,
  DEFAULT_OBSERVED_SOURCES,
  controlledRef,
  isReadableObserved,
  loadAuthority,
  loadHead,
  loadHeads,
  memberKeyOf,
  memberSourceKey,
  observedRef,
  parseSourceChanged,
  resolveScope,
  toScope,
  type Authority,
  type HeadRow,
} from './sources.js';
import {
  SOURCE_CHANGED_CHANNEL,
  type CycleReport,
  type ObserveOptions,
  type ObserveOutcome,
  type ProvenanceKind,
  type WatcherDeps,
  type WatcherEvent,
} from './types.js';

// The source watcher (ARCHITECTURE 5.2, 5.4, 9.4; findings C7, C8, C14, I2/D2).
//
//   controlled sources  compare the authority's live version with the ledger's
//                       newest receipt and register what changed. The value is
//                       read through SourceReaderPort, never inferred, and the
//                       ledger re-checks it against the authority row under
//                       FOR SHARE. The history walk (self-write.ts) classifies
//                       the change.
//   observed sources    read on every poll and passed to registerObservation:
//                       an unchanged normalized digest becomes a confirmation
//                       (lastConfirmedAt advances, no revision is minted), a
//                       changed digest a new revision (I2/D2).
//   after COMMIT        the InvalidationEvent goes to RecoveryPort.onInvalidation.
//                       An event the process never delivered (crash between
//                       COMMIT and delivery) is found again by redeliverPending.
//
// Everything runs under one mutex, so a poll, a notification batch and an
// owner edit never interleave. Transactions contain SQL only; every read
// through SourceReaderPort happens before the transaction opens.

/** Re-reads after a lost race with a concurrent writer, per source and trigger. */
const MAX_RACE_ATTEMPTS = 3;
/** Concurrent reads of observed sources per poll. */
const READ_CONCURRENCY = 6;
const MAX_REDELIVER = 20;
const MAX_REPORTED_STALE = 1_000;

export interface WatcherStats {
  cycles: number;
  registered: number;
  confirmed: number;
  staleRejected: number;
  errors: number;
}

export interface ExclusiveOps {
  observe(
    keys: readonly string[],
    options?: ObserveOptions,
  ): Promise<ObserveOutcome[]>;
}

export interface Watcher {
  /** Joins the single-instance election; resolves once the first attempt finished. */
  start(): Promise<void>;
  /** Waits for the work in flight, releases the lock, stops LISTEN. */
  stop(): Promise<void>;
  isLeader(): boolean;
  /** One full poll now (does not require leadership; tests and tools call it). */
  runCycle(): Promise<CycleReport>;
  /** Immediate observation of specific sources (controlled or observed). */
  observe(
    keys: readonly string[],
    options?: ObserveOptions,
  ): Promise<ObserveOutcome[]>;
  /** Runs `fn` while no poll or notification batch runs (owner manual edit). */
  withExclusive<T>(fn: (ops: ExclusiveOps) => Promise<T>): Promise<T>;
  stats(): WatcherStats;
  readonly lockName: string;
}

const NONE: Classification = {
  selfWrite: 'none',
  causedByActionId: null,
  settlements: [],
  gap: false,
};

/**
 * An observed sample older than what the ledger holds for the source. Thrown
 * inside the registration transaction, so everything the registration wrote
 * (receipt, marks, event) is rolled back.
 */
class StaleSampleError extends Error {
  constructor(readonly sourceKey: string) {
    super(`the sample of ${sourceKey} is older than the ledger head`);
    this.name = 'StaleSampleError';
  }
}

/**
 * Runs inside the registration transaction, after registerObservation. The
 * transaction holds the sources row lock until COMMIT, so the check cannot race
 * another registration: when the receipt this registration superseded (or one
 * of its confirmations) was observed AFTER the watcher's sample was taken, the
 * sample is stale and must not become the current receipt.
 */
async function assertSampleNotStale(
  client: PgClient,
  sourceKey: string,
  result: RegisterResult,
  sampledAt: Date,
) {
  if (!result.newRevision || !result.supersededReceiptId) return;
  const { rows } = await client.query<{ newest: Date }>(
    `SELECT GREATEST(r.observed_at, COALESCE(max(c.confirmed_at), r.observed_at)) AS newest
       FROM ledger.observation_receipts r
       LEFT JOIN ledger.receipt_confirmations c ON c.receipt_id = r.id
      WHERE r.id = $1 GROUP BY r.id`,
    [result.supersededReceiptId],
  );
  const newest = rows[0]?.newest;
  if (newest && newest.getTime() > sampledAt.getTime())
    throw new StaleSampleError(sourceKey);
}

const messageOf = (error: unknown) =>
  (error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
  ).slice(0, 300);

export function createWatcher(deps: WatcherDeps): Watcher {
  const scope = resolveScope(deps.config);
  const ledger = deps.config.ledger;
  const limits = deps.config.closureLimits;
  const intervalMs = deps.config.intervalMs ?? 2_000;
  const clock = deps.clock ?? (() => new Date());
  const lockName =
    deps.config.lockName ??
    `nemodots.watcher:${scope.ownerId}:${scope.environment}:${scope.resource}`;
  const defaultObserved =
    deps.config.observedSources ?? DEFAULT_OBSERVED_SOURCES;
  const followRegistered = deps.config.followRegisteredSources !== false;
  const counters: WatcherStats = {
    cycles: 0,
    registered: 0,
    confirmed: 0,
    staleRejected: 0,
    errors: 0,
  };
  const reportedStale = new Set<string>();
  const settlementCheck = createSettlementCheck(deps.intents);

  function emit(event: WatcherEvent) {
    if (event.type === 'registered') counters.registered += 1;
    else if (event.type === 'confirmed') counters.confirmed += 1;
    else if (event.type === 'stale_observation_rejected')
      counters.staleRejected += 1;
    else if (event.type === 'error') counters.errors += 1;
    if (deps.onEvent) {
      try {
        deps.onEvent(event);
      } catch {
        // an observer must never break the watcher
      }
    } else if (event.type === 'error') {
      console.error(`nemodots watcher: ${event.where}: ${event.message}`);
    }
  }

  // ------------------------------------------------------------- mutex

  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(() => fn());
    chain = run.catch(() => undefined);
    return run;
  }

  // ----------------------------------------------------- registration

  const outcome = (
    sourceKey: string,
    kind: ObserveOutcome['outcome'],
    extra: Partial<ObserveOutcome> = {},
  ): ObserveOutcome => ({
    sourceKey,
    outcome: kind,
    revision: null,
    selfWrite: null,
    invalidationId: null,
    closureCapped: false,
    ...extra,
  });

  /** Hands the event to the coordinator after COMMIT. Failures are redelivered by the next poll. */
  async function deliver(event: InvalidationEvent | null) {
    if (!event) return null;
    if (event.perMission.length === 0) return event.id;
    try {
      await deps.recovery.onInvalidation(event);
    } catch (error) {
      emit({
        type: 'error',
        where: 'onInvalidation',
        message: messageOf(error),
      });
    }
    return event.id;
  }

  /**
   * `afterRegister` runs in the registration transaction; throwing from it
   * rolls the registration back (used for the stale-sample check).
   */
  async function register(
    input: RegisterObservationInput,
    afterRegister?: (client: PgClient, result: RegisterResult) => Promise<void>,
  ) {
    try {
      const result = await withTransaction(deps.pool, async (client) => {
        const registered = await registerObservation(client, input, {
          ledger,
          limits,
        });
        await afterRegister?.(client, registered);
        return registered;
      });
      return { result, capped: false };
    } catch (error) {
      if (!(error instanceof ClosureCapExceeded)) throw error;
      const capped = await registerAfterClosureCap(
        { pool: deps.pool, recovery: deps.recovery, ledger, emit },
        error,
        input,
        afterRegister,
      );
      return { result: capped.result, capped: true };
    }
  }

  async function finishRegistration(
    sourceKey: string,
    result: RegisterResult,
    capped: boolean,
    selfWrite: SelfWrite,
  ): Promise<ObserveOutcome> {
    const invalidationId = await deliver(result.invalidation);
    if (result.newRevision) {
      emit({
        type: 'registered',
        sourceKey,
        revision: result.receipt.sourceRevision,
        selfWrite,
        invalidationId,
      });
      return outcome(sourceKey, 'registered', {
        revision: result.receipt.sourceRevision,
        selfWrite,
        invalidationId,
        closureCapped: capped,
      });
    }
    emit({
      type: 'confirmed',
      sourceKey,
      revision: result.receipt.sourceRevision,
    });
    return outcome(sourceKey, 'confirmed', {
      revision: result.receipt.sourceRevision,
    });
  }

  function reportStale(sourceKey: string, observed: number, current: number) {
    const id = `${sourceKey}:${observed}:${current}`;
    if (reportedStale.has(id)) return;
    if (reportedStale.size >= MAX_REPORTED_STALE) reportedStale.clear();
    reportedStale.add(id);
    emit({ type: 'stale_observation_rejected', sourceKey, observed, current });
  }

  // ----------------------------------------------------- controlled

  /** A member the authority no longer has: its receipt is retracted (source_removed). */
  async function retireMember(sourceKey: string): Promise<ObserveOutcome> {
    const head = await loadHead(deps.pool, scope, sourceKey);
    if (!head || (head.status !== 'supported' && head.status !== 'contested'))
      return outcome(sourceKey, 'removed');
    try {
      const retired = await withTransaction(deps.pool, (client) =>
        transitionReceipt(
          client,
          {
            receiptId: head.receiptId,
            to: 'retracted',
            reason: 'source_removed',
          },
          { ledger, limits },
        ),
      );
      const invalidationId = await deliver(retired.invalidation);
      emit({ type: 'member_removed', sourceKey, invalidationId });
      return outcome(sourceKey, 'removed', { invalidationId });
    } catch (error) {
      if (!(error instanceof ClosureCapExceeded)) throw error;
      // The retraction cannot compute its closure. Nothing was written; stop
      // the missions that rest on the receipt (the authority row is gone, so
      // G1/G2 already refuse it) and leave the receipt for the next poll.
      emit({
        type: 'closure_cap',
        sourceKey,
        cap: error.cap,
        missionIds: [...error.missionIds],
      });
      for (const missionId of error.missionIds)
        await deps.recovery
          .pauseMission(missionId as MissionId, 'closure_cap_exceeded')
          .catch((pauseError: unknown) => {
            if ((pauseError as { name?: string })?.name !== 'MissionStateError')
              throw pauseError;
          });
      return outcome(sourceKey, 'failed', { closureCapped: true });
    }
  }

  async function observeControlled(
    sourceKey: string,
    kind: ProvenanceKind,
  ): Promise<ObserveOutcome> {
    const member = memberKeyOf(sourceKey);
    const ref = controlledRef(scope, sourceKey);
    let last: ObserveOutcome = outcome(sourceKey, 'rejected');
    for (let attempt = 1; attempt <= MAX_RACE_ATTEMPTS; attempt += 1) {
      const sampledAt = clock();
      const read = await deps.readers.read(
        sourceKey as SourceKey,
        toScope(scope),
      );
      if (member !== null && read.normalizedValue === null)
        return retireMember(sourceKey);
      const revision = read.revisionHint;
      if (revision === null)
        throw new Error(
          `reader returned no revision for controlled ${sourceKey}`,
        );
      const head = await loadHead(deps.pool, scope, sourceKey);
      if (head && head.revision === revision) {
        if (head.status === 'supported')
          return outcome(sourceKey, 'unchanged', { revision });
        // retracted/expired by hand: only the authority advancing replaces it
        return outcome(sourceKey, 'skipped', { revision });
      }

      let classification = NONE;
      if (member !== null) {
        classification = await walkHistory(deps.pool, deps.intents, {
          key: member,
          ledgerRevision: head?.revision ?? 0,
          headVersion: revision,
          ledger,
        });
        if (classification.gap)
          emit({
            type: 'history_gap',
            sourceKey,
            ledgerRevision: head?.revision ?? 0,
            headVersion: revision,
          });
      }
      try {
        const { result, capped } = await register({
          source: ref,
          normalizedValue: read.normalizedValue,
          provenance: {
            kind,
            causedByActionId: classification.causedByActionId,
            selfWrite: classification.selfWrite,
          },
          observedAt: sampledAt,
          claimed: { sourceRevision: revision },
        });
        const registered = await finishRegistration(
          sourceKey,
          result,
          capped,
          classification.selfWrite,
        );
        // The head receipt exists (and its event reached the coordinator)
        // before the intents are settled: a settlement can then never schedule
        // work against a head the ledger does not hold yet. A crash between
        // the COMMIT above and these calls is repaired by sweepSettlements()
        // on the next poll, which settles every committed intent whose row the
        // ledger has moved past.
        await applySettlements(
          deps.recovery,
          classification.settlements,
          emit,
          settlementCheck,
        );
        return registered;
      } catch (error) {
        if (error instanceof StaleObservationRejectedError) {
          reportStale(sourceKey, error.observed, error.current);
          last = outcome(sourceKey, 'rejected', { revision });
          continue;
        }
        if (
          error instanceof RevisionMismatchError ||
          error instanceof DigestMismatchError
        ) {
          last = outcome(sourceKey, 'rejected', { revision });
          continue;
        }
        if (error instanceof ControlledSourceMissingError && member !== null)
          return retireMember(sourceKey);
        throw error;
      }
    }
    return last;
  }

  async function syncControlled(
    heads: ReadonlyMap<string, HeadRow>,
    authority: Authority,
    only: ReadonlySet<string> | null,
  ): Promise<ObserveOutcome[]> {
    const toRegister: string[] = [];
    const consider = (key: string, live: number) => {
      if (only && !only.has(key)) return;
      const head = heads.get(key);
      if (!head || head.revision === null || head.revision < live)
        toRegister.push(key);
    };
    consider(COLLECTION_KEY, authority.collectionVersion);
    for (const [key, version] of authority.members)
      consider(memberSourceKey(key), version);
    const retire: string[] = [];
    for (const head of heads.values()) {
      const member = memberKeyOf(head.key);
      if (
        head.sourceType !== 'controlled_config' ||
        member === null ||
        authority.members.has(member) ||
        (only && !only.has(head.key)) ||
        (head.status !== 'supported' && head.status !== 'contested')
      )
        continue;
      retire.push(head.key);
    }
    const outcomes: ObserveOutcome[] = [];
    const guarded = async (key: string, fn: () => Promise<ObserveOutcome>) => {
      try {
        outcomes.push(await fn());
      } catch (error) {
        emit({
          type: 'error',
          where: `controlled ${key}`,
          message: messageOf(error),
        });
        outcomes.push(outcome(key, 'failed'));
      }
    };
    for (const key of toRegister)
      await guarded(key, () => observeControlled(key, 'watcher'));
    for (const key of retire) await guarded(key, () => retireMember(key));
    return outcomes;
  }

  // ------------------------------------------------------- observed

  function observedPlan(heads: ReadonlyMap<string, HeadRow>) {
    const plan = new Map<string, SourceType | undefined>();
    for (const key of defaultObserved)
      plan.set(key, heads.get(key)?.sourceType);
    if (followRegistered)
      for (const head of heads.values())
        if (head.authority === 'observed' && isReadableObserved(head.key))
          plan.set(head.key, head.sourceType);
    return [...plan.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, type]) => ({ key, type }));
  }

  type Sample = {
    key: string;
    type?: SourceType;
    at: Date;
    read?: Awaited<ReturnType<WatcherDeps['readers']['read']>>;
    error?: unknown;
  };

  async function sampleObserved(source: {
    key: string;
    type?: SourceType;
  }): Promise<Sample> {
    const at = clock();
    try {
      return {
        ...source,
        at,
        read: await deps.readers.read(source.key as SourceKey, toScope(scope)),
      };
    } catch (error) {
      return { ...source, at, error };
    }
  }

  /**
   * Registers one sample. The ledger orders observed revisions by arrival, so a
   * sample that a tool or probe overtook (it registered or confirmed a later
   * reading while this one was being read) is rolled back and read again; the
   * stale value never becomes the current receipt.
   */
  async function registerSample(first: Sample): Promise<ObserveOutcome> {
    let item = first;
    for (let attempt = 1; ; attempt += 1) {
      if (!item.read) {
        emit({
          type: 'error',
          where: `read ${item.key}`,
          message: messageOf(item.error),
        });
        return outcome(item.key, 'failed');
      }
      try {
        const { result, capped } = await register(
          {
            source: observedRef(scope, item.key, item.type),
            normalizedValue: item.read.normalizedValue,
            provenance: { kind: 'watcher' },
            observedAt: item.at,
          },
          (client, registered) =>
            assertSampleNotStale(client, item.key, registered, item.at),
        );
        return await finishRegistration(item.key, result, capped, 'none');
      } catch (error) {
        if (error instanceof StaleSampleError) {
          emit({
            type: 'stale_sample_discarded',
            sourceKey: item.key,
            attempt,
          });
          if (attempt >= MAX_RACE_ATTEMPTS)
            return outcome(item.key, 'rejected');
          item = await sampleObserved({ key: item.key, type: item.type });
          continue;
        }
        emit({
          type: 'error',
          where: `observe ${item.key}`,
          message: messageOf(error),
        });
        return outcome(item.key, 'failed');
      }
    }
  }

  async function observeObserved(
    sources: readonly { key: string; type?: SourceType }[],
  ): Promise<ObserveOutcome[]> {
    const sampled: Sample[] = [];
    for (let i = 0; i < sources.length; i += READ_CONCURRENCY)
      sampled.push(
        ...(await Promise.all(
          sources.slice(i, i + READ_CONCURRENCY).map(sampleObserved),
        )),
      );
    const outcomes: ObserveOutcome[] = [];
    for (const item of sampled) outcomes.push(await registerSample(item));
    return outcomes;
  }

  // ------------------------------------------------ redelivery sweep

  /**
   * Ledger events naming an existing mission that has no coordinator copy: the
   * process died between the registration's COMMIT and onInvalidation (or the
   * call failed). The coordinator keeps such a mission from settling until the
   * event is delivered (fail closed), so the watcher delivers it again.
   */
  async function redeliverPending(): Promise<string[]> {
    const schema = coordinatorSchema(ledger);
    const { rows } = await deps.pool.query<{
      id: string;
      source_key: string;
      old_receipt_id: string;
      new_receipt_id: string | null;
      reason: string;
      self_write: string;
      graph_version: string;
      mission_ids: string[];
      affected: unknown;
      per_mission: unknown;
      closure: unknown;
      resolved_at: Date | null;
      created_at: Date;
    }>(
      `SELECT e.id, e.source_key, e.old_receipt_id, e.new_receipt_id, e.reason,
              e.self_write, e.graph_version, e.mission_ids, e.affected,
              e.per_mission, e.closure, e.resolved_at, e.created_at
         FROM ledger.invalidation_events e
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(e.mission_ids) AS m(id)
            JOIN ${schema}.missions mi ON mi.id = m.id::uuid
           WHERE NOT EXISTS (
             SELECT 1 FROM ${schema}.invalidations i
              WHERE i.event_id = e.id AND i.mission_id = mi.id))
        ORDER BY e.created_at, e.id
        LIMIT ${MAX_REDELIVER}`,
    );
    const delivered: string[] = [];
    for (const row of rows) {
      const parsed = InvalidationEventSchema.safeParse({
        id: row.id,
        missionIds: row.mission_ids,
        sourceKey: row.source_key,
        oldReceiptId: row.old_receipt_id,
        newReceiptId: row.new_receipt_id,
        reason: row.reason,
        selfWrite: row.self_write,
        graphVersion: Number(row.graph_version),
        affected: row.affected,
        perMission: row.per_mission,
        closure: row.closure,
        resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
      });
      if (!parsed.success) {
        emit({
          type: 'error',
          where: 'redeliver',
          message: `ledger event ${row.id} does not parse`,
        });
        continue;
      }
      try {
        await deps.recovery.onInvalidation(parsed.data);
        delivered.push(row.id);
        emit({ type: 'redelivered', invalidationId: row.id });
      } catch (error) {
        emit({ type: 'error', where: 'redeliver', message: messageOf(error) });
      }
    }
    return delivered;
  }

  // --------------------------------------------------------- cycles

  async function fullCycle(): Promise<CycleReport> {
    counters.cycles += 1;
    const outcomes: ObserveOutcome[] = [];
    let heads = await loadHeads(deps.pool, scope);
    const authority = await loadAuthority(deps.pool, ledger);
    outcomes.push(...(await syncControlled(heads, authority, null)));
    outcomes.push(...(await observeObserved(observedPlan(heads))));

    heads = await loadHeads(deps.pool, scope);
    let settled: CycleReport['settled'] = [];
    try {
      settled = await sweepSettlements(deps.pool, {
        intents: deps.intents,
        recovery: deps.recovery,
        heads,
        ledger,
        emit,
        check: settlementCheck,
      });
    } catch (error) {
      emit({ type: 'error', where: 'sweep', message: messageOf(error) });
    }
    let redelivered: string[] = [];
    try {
      redelivered = await redeliverPending();
    } catch (error) {
      emit({ type: 'error', where: 'redeliver', message: messageOf(error) });
    }
    return { outcomes, settled, redelivered };
  }

  async function notificationCycle(payloads: readonly string[]) {
    const keys = new Set<string>();
    let unparsed = false;
    for (const payload of payloads) {
      const parsed = parseSourceChanged(payload);
      if (!parsed) {
        unparsed = true;
        continue;
      }
      keys.add(parsed.key);
      if (parsed.membershipChanged) keys.add(COLLECTION_KEY);
    }
    const heads = await loadHeads(deps.pool, scope);
    const authority = await loadAuthority(deps.pool, ledger);
    await syncControlled(heads, authority, unparsed ? null : keys);
  }

  async function observeLocked(
    keys: readonly string[],
    options: ObserveOptions = {},
  ): Promise<ObserveOutcome[]> {
    const kind = options.kind ?? 'watcher';
    const outcomes: ObserveOutcome[] = [];
    const observed: { key: string; type?: SourceType }[] = [];
    const heads = await loadHeads(deps.pool, scope);
    for (const key of keys) {
      if (key === COLLECTION_KEY || memberKeyOf(key) !== null) {
        try {
          outcomes.push(await observeControlled(key, kind));
        } catch (error) {
          emit({
            type: 'error',
            where: `controlled ${key}`,
            message: messageOf(error),
          });
          outcomes.push(outcome(key, 'failed'));
        }
      } else if (isReadableObserved(key))
        observed.push({ key, type: heads.get(key)?.sourceType });
      else outcomes.push(outcome(key, 'skipped'));
    }
    if (observed.length > 0)
      outcomes.push(...(await observeObserved(observed)));
    return outcomes;
  }

  // ------------------------------------------------------ lifecycle

  let scheduler: Scheduler | null = null;

  return {
    lockName,
    async start() {
      if (scheduler) return;
      const connectionString =
        deps.listenUrl ??
        (deps.pool.options as { connectionString?: string }).connectionString;
      if (!connectionString)
        throw new Error(
          'the watcher needs listenUrl or a pool with a connection string',
        );
      scheduler = createScheduler({
        connectionString,
        applicationName: 'nemodots-watcher',
        lockName,
        channel: SOURCE_CHANGED_CHANNEL,
        intervalMs,
        work: (batch) =>
          exclusive(async () => {
            if (batch.full) await fullCycle();
            else await notificationCycle(batch.notifications);
          }),
        onLeadership: (leader) => emit({ type: 'leadership', leader }),
        onError: (where, error) =>
          emit({ type: 'error', where, message: messageOf(error) }),
      });
      await scheduler.start();
    },
    async stop() {
      const current = scheduler;
      scheduler = null;
      await current?.stop();
      await chain;
    },
    isLeader: () => scheduler?.isLeader() ?? false,
    runCycle: () => exclusive(() => fullCycle()),
    observe: (keys, options) => exclusive(() => observeLocked(keys, options)),
    withExclusive: (fn) => exclusive(() => fn({ observe: observeLocked })),
    stats: () => ({ ...counters }),
  };
}
