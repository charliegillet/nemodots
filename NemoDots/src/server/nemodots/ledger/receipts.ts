// Receipt registration and status changes (ARCHITECTURE.md section 5.2,
// CONTRACTS.md section 2). registerObservation never computes a self-write
// classification: provenance.causedByActionId / selfWrite arrive from the
// watcher and are stored as given.
//
// Every function needs a client inside an open transaction (BEGIN ...
// COMMIT) owned by the caller; the sources row lock and the controlled-row
// FOR SHARE lock live exactly as long as that transaction.
import {
  assertTransition,
  CollectionValueSchema,
  canonicalByteLength,
  digest,
  invalidationEventId,
  NORMALIZED_VALUE_MAX_BYTES,
  SOURCE_KEY_PATTERN,
  SourceRefSchema,
  type AttemptId,
  type Digest,
  type InvalidationEvent,
  type InvalidationReason,
  type ModelCallId,
  type ObservationReceipt,
  type PgClient,
  type ReceiptId,
  type ReceiptStatus,
  type SourceRef,
  type TransitionReason,
  type TrustClass,
  type Affected,
} from '../contracts/index.js';
import {
  ControlledSourceMissingError,
  DigestMismatchError,
  InvalidObservationError,
  InvalidSourceKeyError,
  ObservationTooLargeError,
  ReceiptNotRegistrableError,
  RevisionMismatchError,
  StaleObservationRejectedError,
} from './errors.js';
import type { ClosureLimits } from './closure.js';
import { requireEventSink, type RegistrationLedgerOptions } from './options.js';
import { verifiedSelfWriteAction } from './lineage.js';
import { runWithClosureLocks, unionAffected } from './prelock.js';
import {
  appendConfirmation,
  getReceiptRow,
  headReceipt,
  toReceipt,
  transitionRow,
  type ConfirmationInput,
  type ReceiptDraft,
  type ReceiptRow,
} from './receipt-store.js';
import {
  COLLECTION_SOURCE_KEY,
  configMemberKey,
  ensureSource,
  liveMember,
  liveMemberKeys,
  liveVersion,
  lockSource,
  type SourceRow,
} from './sources.js';
import {
  invalidateRetired,
  loadClosure,
  supersedeAndInvalidate,
  supersedeWithoutClosure,
  type ClosureMarker,
  type CoarseInvalidation,
  type MarkSummary,
} from './supersession.js';

type ReceiptTrust = Exclude<TrustClass, 'model_claim'>;
type Provenance = ObservationReceipt['provenance'];

export interface RegisterObservationInput {
  source: SourceRef;
  /** Typed, bounded (<= 16 KiB canonical) value; its digest is the receipt's contentDigest. */
  normalizedValue: unknown;
  /** Defaults from the source type; controlled sources are always controlled_authority. */
  trust?: ReceiptTrust;
  provenance: {
    kind: Provenance['kind'];
    toolCallId?: string | null;
    modelCallId?: ModelCallId | null;
    attemptId?: AttemptId | null;
    /** Server-authored (watcher); stored, never derived here. */
    causedByActionId?: Provenance['causedByActionId'];
    selfWrite?: Provenance['selfWrite'];
  };
  /** When the source was sampled (default: now, database clock). */
  observedAt?: Date | string | null;
  rawRef?: ObservationReceipt['rawRef'];
  /** Members: the collection version the value was read under; must equal the live one. */
  collectionRevision?: number | null;
  /** Membership predicate (collection receipts only); its collectionRevision must be the live one. */
  negative?: ObservationReceipt['negative'];
  expiresAt?: Date | string | null;
  /**
   * What the caller believes it is registering. A revision or digest that
   * disagrees with the authority/ledger is rejected (revision_mismatch,
   * stale_observation_rejected, digest_mismatch).
   */
  claimed?: { sourceRevision?: number; contentDigest?: string };
  /** Overrides the derived InvalidationEvent.reason (e.g. conflicting_observation). */
  invalidationReason?: Extract<
    InvalidationReason,
    | 'newer_observation'
    | 'conflicting_observation'
    | 'self_write_mismatch'
    | 'collection_changed'
  >;
}

export interface RegisterOptions {
  /** Required: `events` is the sink for the per-mission invalidation events. */
  ledger: RegistrationLedgerOptions;
  limits?: ClosureLimits;
  /** null skips marks on the coordinator's rows; default marks them. */
  marker?: ClosureMarker | null;
  /** 'skip' is the watcher's cap path; see registerWithoutClosure(). */
  closure?: 'run' | 'skip';
  coarse?: CoarseInvalidation;
  /**
   * Test seam for the C8 race: invoked after ensureSource and a non-locking
   * read of the head receipt, before the sources row is locked. Never set in
   * production.
   */
  hooks?: {
    afterPreliminaryRead?: (context: {
      sourceId: string;
      head: ReceiptRow | null;
    }) => Promise<void>;
  };
}

export interface RegisterResult {
  /** The current receipt after the call (the new one, or the existing one that was confirmed). */
  receipt: ObservationReceipt;
  newRevision: boolean;
  /** Set when the call appended a freshness confirmation instead of minting a revision. */
  confirmation: { confirmedAt: string } | null;
  supersededReceiptId: ReceiptId | null;
  invalidation: InvalidationEvent | null;
  marks: MarkSummary | null;
}

interface Prepared {
  ref: SourceRef;
  value: unknown;
  digest: Digest;
  trust: ReceiptTrust;
  provenance: Provenance;
  observedAt: Date | null;
  expiresAt: Date | null;
}

const DEFAULT_TRUST: Record<SourceRef['sourceType'], ReceiptTrust> = {
  controlled_config: 'controlled_authority',
  controlled_collection: 'controlled_authority',
  observed_endpoint: 'observed_tool',
  observed_store: 'observed_tool',
  probe: 'probe',
  runbook: 'runbook',
  page_snapshot: 'page_snapshot',
  memory_snapshot: 'memory_snapshot',
};

function toDate(value: Date | string | null | undefined, field: string) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new InvalidObservationError(`${field} is not a valid time`);
  return date;
}

/** Pure validation: nothing is written for a malformed observation. */
function prepare(input: RegisterObservationInput): Prepared {
  const key = (input.source as { key?: unknown } | null)?.key;
  if (typeof key !== 'string' || !SOURCE_KEY_PATTERN.test(key))
    throw new InvalidSourceKeyError(typeof key === 'string' ? key : '');
  const parsed = SourceRefSchema.safeParse(input.source);
  if (!parsed.success)
    throw new InvalidObservationError(
      `source reference is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  const ref = parsed.data;

  let bytes: number;
  try {
    bytes = canonicalByteLength(input.normalizedValue);
  } catch (error) {
    throw new InvalidObservationError(
      `normalizedValue is not canonical JSON: ${(error as Error).message}`,
    );
  }
  if (bytes > NORMALIZED_VALUE_MAX_BYTES)
    throw new ObservationTooLargeError(bytes, NORMALIZED_VALUE_MAX_BYTES);
  if (JSON.stringify(input.normalizedValue).includes('\\u0000'))
    throw new InvalidObservationError(
      'normalizedValue contains a NUL character',
    );
  const valueDigest = digest(input.normalizedValue);
  if (
    input.claimed?.contentDigest !== undefined &&
    input.claimed.contentDigest !== valueDigest
  )
    throw new DigestMismatchError(
      'claimed contentDigest does not match the digest of normalizedValue',
    );

  if (ref.sourceType === 'controlled_collection') {
    const collection = CollectionValueSchema.safeParse(input.normalizedValue);
    if (!collection.success)
      throw new InvalidObservationError(
        'collection value must be { keys: sorted unique string[], collectionVersion }',
      );
  }
  if (ref.sourceType === 'controlled_config') {
    const memberKey = configMemberKey(ref.key);
    const value = input.normalizedValue as Record<string, unknown> | null;
    const keys =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value).sort()
        : [];
    if (
      keys.join(',') !== 'key,value,version' ||
      value === null ||
      value.key !== memberKey ||
      !Number.isInteger(value.version) ||
      (value.version as number) < 1
    )
      throw new InvalidObservationError(
        `a config member value must be exactly { key: "${memberKey}", value, version }`,
      );
  }
  if (input.negative && ref.sourceType !== 'controlled_collection')
    throw new InvalidObservationError(
      'a negative membership predicate belongs on the checkout.config collection receipt',
    );

  const trust = input.trust ?? DEFAULT_TRUST[ref.sourceType];
  if (ref.authority === 'controlled' && trust !== 'controlled_authority')
    throw new InvalidObservationError(
      'controlled sources are registered with trust controlled_authority',
    );
  if (ref.authority === 'observed' && trust === 'controlled_authority')
    throw new InvalidObservationError(
      'only controlled sources carry trust controlled_authority',
    );

  const selfWrite = input.provenance.selfWrite ?? 'none';
  const causedByActionId = input.provenance.causedByActionId ?? null;
  if (selfWrite !== 'none' && causedByActionId === null)
    throw new InvalidObservationError(
      'selfWrite verified/mismatch requires causedByActionId',
    );
  return {
    ref,
    value: input.normalizedValue,
    digest: valueDigest,
    trust,
    provenance: {
      kind: input.provenance.kind,
      toolCallId: input.provenance.toolCallId ?? null,
      modelCallId: input.provenance.modelCallId ?? null,
      attemptId: input.provenance.attemptId ?? null,
      causedByActionId,
      selfWrite,
    },
    observedAt: toDate(input.observedAt, 'observedAt'),
    expiresAt: toDate(input.expiresAt, 'expiresAt'),
  };
}

/** Claimed revisions: older than the assignable one is stale, newer is a mismatch. */
function checkClaim(claimed: number | undefined, expected: number) {
  if (claimed === undefined || claimed === expected) return;
  if (claimed < expected)
    throw new StaleObservationRejectedError(claimed, expected);
  throw new RevisionMismatchError(claimed, expected);
}

interface ControlledReading {
  revision: number;
  collectionRevision: number | null;
}

/**
 * Reads the authority's version for a controlled source under FOR SHARE (the
 * row cannot advance until this transaction ends) and checks the observation
 * against it.
 */
async function readControlled(
  client: PgClient,
  prepared: Prepared,
  input: RegisterObservationInput,
  options: RegisterOptions,
): Promise<ControlledReading> {
  const key = prepared.ref.key;
  const isCollection = key === COLLECTION_SOURCE_KEY;
  const lookup = isCollection ? [key] : [COLLECTION_SOURCE_KEY, key];
  const live = await liveVersion(client, lookup, 'share', options.ledger);
  const revision = live.get(key);
  if (revision === null || revision === undefined)
    throw new ControlledSourceMissingError(key);
  const collectionRevision = isCollection
    ? null
    : (live.get(COLLECTION_SOURCE_KEY) ?? null);
  if (!isCollection) {
    if (collectionRevision === null)
      throw new ControlledSourceMissingError(COLLECTION_SOURCE_KEY);
    // The value must describe the locked authority row: version and content.
    checkClaim(input.claimed?.sourceRevision, revision);
    const embedded = prepared.value as { value: unknown; version: number };
    if (embedded.version < revision)
      throw new StaleObservationRejectedError(embedded.version, revision);
    if (embedded.version > revision)
      throw new RevisionMismatchError(embedded.version, revision);
    const row = await liveMember(
      client,
      configMemberKey(key) as string,
      options.ledger,
    );
    if (!row || digest(row.value) !== digest(embedded.value))
      throw new DigestMismatchError(
        `the value of ${key} at version ${revision} differs from the authority row`,
      );
    if (
      input.collectionRevision !== undefined &&
      input.collectionRevision !== null &&
      input.collectionRevision !== collectionRevision
    )
      throw new StaleObservationRejectedError(
        input.collectionRevision,
        collectionRevision,
      );
  } else {
    const value = CollectionValueSchema.parse(prepared.value);
    if (value.collectionVersion < revision)
      throw new StaleObservationRejectedError(
        value.collectionVersion,
        revision,
      );
    if (value.collectionVersion > revision)
      throw new RevisionMismatchError(value.collectionVersion, revision);
    const keys = await liveMemberKeys(client, options.ledger);
    if (
      keys.length !== value.keys.length ||
      keys.some((member, i) => member !== value.keys[i])
    )
      throw new DigestMismatchError(
        'collection keys disagree with the authority at the live version',
      );
    if (input.negative && input.negative.collectionRevision !== revision)
      throw new StaleObservationRejectedError(
        input.negative.collectionRevision,
        revision,
      );
  }
  checkClaim(input.claimed?.sourceRevision, revision);
  return { revision, collectionRevision };
}

function confirmationInput(provenance: Provenance): ConfirmationInput {
  return {
    kind:
      provenance.kind === 'tool_call' || provenance.kind === 'probe'
        ? provenance.kind
        : 'watcher',
    attemptId: provenance.attemptId,
    modelCallId: provenance.modelCallId,
  };
}

function derivedReason(
  prepared: Prepared,
  input: RegisterObservationInput,
): Extract<
  InvalidationReason,
  | 'newer_observation'
  | 'conflicting_observation'
  | 'self_write_mismatch'
  | 'collection_changed'
> {
  if (input.invalidationReason) return input.invalidationReason;
  if (prepared.provenance.selfWrite === 'mismatch')
    return 'self_write_mismatch';
  if (prepared.ref.sourceType === 'controlled_collection')
    return 'collection_changed';
  return 'newer_observation';
}

/**
 * ARCHITECTURE 5.2 steps 1-5 in the caller's transaction:
 *   1. ensureSource, then the sources row FOR UPDATE (serializes concurrent
 *      registrations of one source, C8);
 *   2. controlled: revision = the authority's version read FOR SHARE here; a
 *      lower revision than the head's or than the live version is refused,
 *      A->B->A always mints a new revision. Observed: same digest as a
 *      supported head -> a receipt_confirmations row and the head returned, no
 *      revision minted (I2/D3); different digest -> revision head + 1;
 *   3. new receipt `supported`, prior head superseded (transition row + CAS);
 *   4. the closure over evidence + inheritance edges, marks and the
 *      InvalidationEvent. ClosureCapExceeded is thrown before step 3 writes.
 */
export async function registerObservation(
  client: PgClient,
  input: RegisterObservationInput,
  options: RegisterOptions,
): Promise<RegisterResult> {
  requireEventSink(options?.ledger);
  const prepared = prepare(input);
  if (prepared.observedAt) await checkObservedAt(client, prepared.observedAt);
  const source = await ensureSource(client, prepared.ref);
  if (options.hooks?.afterPreliminaryRead) {
    const head = await headReceipt(client, source.id);
    await options.hooks.afterPreliminaryRead({ sourceId: source.id, head });
  }
  const skip = options.closure === 'skip';
  // Coordinator rows the step will mark are locked BEFORE any ledger lock
  // (prelock.ts); the closure is re-read under the ledger locks and verified.
  return runWithClosureLocks(
    client,
    {
      enabled: options.marker !== null,
      ledger: options.ledger,
      preview: async () => {
        const head = await headReceipt(client, source.id);
        if (
          !head ||
          (head.status !== 'supported' && head.status !== 'contested')
        )
          return null;
        // A same-value re-observation confirms the head and marks nothing.
        if (
          head.status === 'supported' &&
          head.contentDigest === prepared.digest
        )
          return null;
        if (skip)
          return options.coarse
            ? unionAffected(options.coarse.perMission.map((m) => m.affected))
            : null;
        return (
          await loadClosure(
            client,
            { receiptId: head.id, sourceKey: source.key },
            options.limits,
            options.ledger,
          )
        ).affected;
      },
    },
    (locked) =>
      registerLocked(client, input, options, prepared, source, locked),
  );
}

/** Registration clock skew tolerated for observedAt (database clock). */
const OBSERVED_AT_SKEW_MS = 5_000;

async function checkObservedAt(client: PgClient, observedAt: Date) {
  const { rows } = await client.query<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  );
  if (observedAt.getTime() > rows[0].now.getTime() + OBSERVED_AT_SKEW_MS)
    throw new InvalidObservationError(
      'observedAt is later than the database clock plus the allowed skew',
    );
}

async function registerLocked(
  client: PgClient,
  input: RegisterObservationInput,
  options: RegisterOptions,
  prepared: Prepared,
  source: SourceRow,
  locked: Affected,
): Promise<RegisterResult> {
  await lockSource(client, source.id);

  const head = await headReceipt(client, source.id);
  let revision: number;
  let collectionRevision: number | null = null;
  let confirmHead = false;

  if (source.authority === 'controlled') {
    const reading = await readControlled(client, prepared, input, options);
    revision = reading.revision;
    collectionRevision = reading.collectionRevision;
    if (head && head.sourceRevision > revision)
      throw new StaleObservationRejectedError(revision, head.sourceRevision);
    if (head && head.sourceRevision === revision) {
      if (head.contentDigest !== prepared.digest)
        throw new DigestMismatchError(
          `revision ${revision} of ${source.key} was registered with a different value`,
        );
      if (head.status !== 'supported')
        throw new ReceiptNotRegistrableError(
          `receipt ${head.id} for ${source.key}@${revision} is ${head.status}; the authority has not advanced`,
        );
      confirmHead = true;
    }
  } else {
    const sameValue =
      head !== null &&
      head.status === 'supported' &&
      head.contentDigest === prepared.digest;
    revision = sameValue
      ? head.sourceRevision
      : (head?.sourceRevision ?? 0) + 1;
    checkClaim(input.claimed?.sourceRevision, revision);
    confirmHead = sameValue;
  }

  if (confirmHead && head) {
    const confirmedAt = await appendConfirmation(
      client,
      head.id,
      confirmationInput(prepared.provenance),
    );
    const current = await getReceiptRow(client, head.id);
    return {
      receipt: toReceipt(current),
      newRevision: false,
      confirmation: { confirmedAt: confirmedAt.toISOString() },
      supersededReceiptId: null,
      invalidation: null,
      marks: null,
    };
  }

  const draft: ReceiptDraft = {
    sourceId: source.id,
    sourceRevision: revision,
    collectionRevision,
    missionId: prepared.ref.scope.missionId,
    spaceId: prepared.ref.scope.spaceId,
    observedAt: prepared.observedAt,
    contentDigest: prepared.digest,
    normalizedValue: prepared.value,
    rawRef: input.rawRef ?? null,
    supersedes: null,
    trust: prepared.trust,
    provenance: prepared.provenance,
    negative: input.negative ?? null,
    expiresAt: prepared.expiresAt,
  };
  const reason = derivedReason(prepared, input);
  const transitionReason: TransitionReason =
    reason === 'conflicting_observation'
      ? 'conflicting_observation'
      : 'newer_observation';
  const base = {
    prior: head,
    draft,
    reason,
    transitionReason,
    sourceKey: source.key,
    ledger: options.ledger,
    marker: options.marker,
  };
  const result =
    options.closure === 'skip'
      ? await supersedeWithoutClosure(client, {
          ...base,
          coarse: options.coarse,
        })
      : await supersedeAndInvalidate(client, {
          ...base,
          limits: options.limits,
          locked: options.marker === null ? undefined : locked,
          excuseActionId: await verifiedSelfWriteAction(
            client,
            {
              sourceKey: source.key,
              revision,
              selfWrite: prepared.provenance.selfWrite,
              causedByActionId: prepared.provenance.causedByActionId,
            },
            options.ledger,
          ),
        });
  return {
    receipt: toReceipt(result.receipt),
    newRevision: true,
    confirmation: null,
    supersededReceiptId: result.supersededReceiptId,
    invalidation: result.event,
    marks: result.marks,
  };
}

export interface TransitionReceiptInput {
  receiptId: string;
  to: Exclude<ReceiptStatus, 'superseded'>;
  reason: TransitionReason;
}

export interface TransitionReceiptResult {
  receipt: ObservationReceipt;
  invalidation: InvalidationEvent | null;
  marks: MarkSummary | null;
}

/**
 * Status change without a replacement: contest, retract, expire, or resolve a
 * contest back to supported. Locks the sources row first (like a
 * registration), applies the CAS + transition row, and for retraction and
 * expiry runs the closure (event reason retraction / expiry, newReceiptId
 * null). A contest only blocks dependents at assertCurrent; it does not
 * invalidate them because it is reversible.
 */
export async function transitionReceipt(
  client: PgClient,
  input: TransitionReceiptInput,
  options: Pick<RegisterOptions, 'ledger' | 'limits' | 'marker'>,
): Promise<TransitionReceiptResult> {
  requireEventSink(options?.ledger);
  const probe = await getReceiptRow(client, input.receiptId);
  const retiring = input.to === 'retracted' || input.to === 'expired';
  const invalidationReason = input.to === 'retracted' ? 'retraction' : 'expiry';
  return runWithClosureLocks(
    client,
    {
      enabled: retiring && options.marker !== null,
      ledger: options.ledger,
      preview: async () => {
        const sourceKey = (await getSourceKey(
          client,
          probe.sourceId,
        )) as string;
        return (
          await loadClosure(
            client,
            { receiptId: probe.id, sourceKey },
            options.limits,
            options.ledger,
          )
        ).affected;
      },
    },
    async (locked) => {
      const source: SourceRow = await lockSource(client, probe.sourceId);
      const receipt = await getReceiptRow(client, input.receiptId);
      assertTransition('receipt', receipt.status, input.to);

      const eventId = retiring
        ? invalidationEventId(source.key, receipt.id, null, invalidationReason)
        : `transition:${receipt.id}:${receipt.statusVersion + 1}`;
      await transitionRow(client, receipt, input.to, input.reason, eventId);

      let invalidation: InvalidationEvent | null = null;
      let marks: MarkSummary | null = null;
      if (retiring) {
        const retired = await invalidateRetired(client, {
          receipt,
          sourceKey: source.key,
          reason: invalidationReason,
          limits: options.limits,
          marker: options.marker,
          ledger: options.ledger,
          locked: options.marker === null ? undefined : locked,
        });
        invalidation = retired.event;
        marks = retired.marks;
      }
      return {
        receipt: toReceipt(await getReceiptRow(client, receipt.id)),
        invalidation,
        marks,
      };
    },
  );
}

async function getSourceKey(client: PgClient, sourceId: string) {
  const { rows } = await client.query<{ key: string }>(
    'SELECT key FROM ledger.sources WHERE id = $1',
    [sourceId],
  );
  return rows[0]?.key;
}
