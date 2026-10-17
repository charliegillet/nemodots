// The version authority of the controlled sources (ARCHITECTURE.md section 5.1,
// steps 4-10). `advanceConfig` is the ONLY writer of checkout.config_entries:
// the injector, the owner manual edit (W3 watcher) and the action commit (W3
// actions) all call it, so the lock protocol exists exactly once.
//
//   4. insert/delete of a key: SELECT ... FROM config_collection FOR UPDATE
//      FIRST (the collection row is always locked before member rows)
//   5. SELECT ... FROM config_entries WHERE key = $1 FOR UPDATE
//   7. UPDATE config_entries ... WHERE key = $1 AND version = $expected
//      (compare-and-set; a mismatch is `stale_version`, nothing is written)
//   8. INSERT config_versions (with before/after digests); on a membership
//      change (insert/delete) bump config_collection.version. A VALUE UPDATE
//      NEVER TOUCHES config_collection (finding C1/D1)
//  10. pg_notify('nemodots_source_changed', ...) (delivered on COMMIT)
//
// Steps 1-3 and 6 (intent lock, mission share-lock, G1 predicates) belong to
// the action commit transaction, which calls `lockConfigRows` for the
// dependency vector (collection first, then member keys in sorted order) and
// then `advanceConfig` for the target. PostgreSQL row locks are re-entrant
// within one transaction, so `advanceConfig` re-acquiring locks the caller
// already holds is a no-op and cannot deadlock against the caller's order.
//
// `advanceConfig` runs INSIDE a transaction owned by the caller (BEGIN/COMMIT
// on `client`). `advanceConfigTx` opens one for writers that have no other
// work (injector, seed, owner edit).
//
// Version continuity: a key's version only ever grows. A delete writes a
// config_versions row (value NULL) at version+1 and a later re-insert
// continues from the highest recorded version, so a receipt for an old
// revision can never collide with a new one.
import type pg from 'pg';
import { digest } from '../contracts/digest.js';
import { CONFIG_MEMBER_KEY_PATTERN } from '../contracts/ids.js';
import type { PgClient } from '../contracts/ports.js';
import { withTransaction, type TransactionOptions } from '../db/tx.js';

export const SOURCE_CHANGED_CHANNEL = 'nemodots_source_changed';

export const CONFIG_ACTORS = ['action', 'injector', 'owner', 'seed'] as const;
export type ConfigActor = (typeof CONFIG_ACTORS)[number];

export type ConfigScalar = string | number | boolean;

export interface CausedBy {
  actor: ConfigActor;
  /**
   * Only honoured when the connection's role is nemodots_app: the
   * BEFORE INSERT/UPDATE trigger nulls it for every other role (I14).
   */
  actionId?: string | null;
}

export interface AdvanceConfigInput {
  key: string;
  /** Ignored (and must be omitted) with deleteKey. */
  value?: ConfigScalar;
  /**
   * The version the caller read. 0 means "the key does not exist" (insert).
   * Ignored when `unconditional` is set.
   */
  expectedVersion: number;
  /**
   * Injector/seed writers that write regardless of the current version: the
   * expected version is read UNDER the member row lock taken by the single
   * lock sequence below (collection first), never before it. Actions and the
   * owner edit never set this; their CAS is the point.
   */
  unconditional?: boolean;
  causedBy: CausedBy;
  /** Insert the key when it does not exist (expectedVersion must be 0). */
  insertIfMissing?: boolean;
  /** Delete the key (expectedVersion must equal its current version). */
  deleteKey?: boolean;
}

export interface AdvanceConfigResult {
  key: string;
  versionBefore: number;
  /** The member's new version; for a delete, the version recorded in config_versions. */
  versionAfter: number;
  /** null when the key did not exist before (insert). */
  beforeDigest: string | null;
  /** null when the key was deleted. */
  afterDigest: string | null;
  membershipChanged: boolean;
  /** The collection version after this write (null when it was not locked). */
  collectionVersion: number | null;
  operation: 'update' | 'insert' | 'delete';
}

export type ConfigVersionErrorCode =
  'stale_version' | 'missing_key' | 'invalid_key' | 'invalid_input';

export class ConfigVersionError extends Error {
  constructor(
    readonly code: ConfigVersionErrorCode,
    readonly key: string,
    message: string,
    readonly expectedVersion: number | null = null,
    /** The version found under lock (0 = key absent), when known. */
    readonly currentVersion: number | null = null,
  ) {
    super(message);
    this.name = 'ConfigVersionError';
  }
}

export function isStaleVersion(error: unknown): error is ConfigVersionError {
  return error instanceof ConfigVersionError && error.code === 'stale_version';
}

/** sha256 of the canonical JSON of a config value (the before/after digest). */
export function configValueDigest(value: ConfigScalar): string {
  return digest(value);
}

const num = (value: unknown) => Number(value);

function assertKey(key: string) {
  if (!CONFIG_MEMBER_KEY_PATTERN.test(key))
    throw new ConfigVersionError(
      'invalid_key',
      key,
      'config key does not match the member key pattern',
    );
}

function assertScalar(
  key: string,
  value: unknown,
): asserts value is ConfigScalar {
  const ok =
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
  if (!ok)
    throw new ConfigVersionError(
      'invalid_input',
      key,
      'config value must be a string, boolean or finite number',
    );
}

export interface LockedRows {
  collectionVersion: number | null;
  /** key -> version (absent keys are omitted) */
  versions: Map<string, number>;
}

/**
 * Steps 4-5 for callers that lock a whole dependency vector: the collection
 * row first (when requested), then the member rows in sorted key order.
 * `FOR UPDATE` by default; `FOR SHARE` for G2 publications.
 */
export async function lockConfigRows(
  client: PgClient,
  opts: {
    keys: readonly string[];
    collection?: boolean;
    mode?: 'update' | 'share';
  },
): Promise<LockedRows> {
  const mode = opts.mode === 'share' ? 'FOR SHARE' : 'FOR UPDATE';
  let collectionVersion: number | null = null;
  if (opts.collection) {
    const collection = await client.query<{ version: string }>(
      `SELECT version FROM checkout.config_collection WHERE singleton ${mode}`,
    );
    collectionVersion = num(collection.rows[0]?.version);
  }
  const keys = [...new Set(opts.keys)].sort();
  for (const key of keys) assertKey(key);
  const versions = new Map<string, number>();
  if (keys.length) {
    const rows = await client.query<{ key: string; version: string }>(
      `SELECT key, version FROM checkout.config_entries
        WHERE key = ANY($1::text[]) ORDER BY key ${mode}`,
      [keys],
    );
    for (const row of rows.rows) versions.set(row.key, num(row.version));
  }
  return { collectionVersion, versions };
}

export async function advanceConfig(
  client: PgClient,
  input: AdvanceConfigInput,
): Promise<AdvanceConfigResult> {
  const { key, causedBy } = input;
  assertKey(key);
  if (
    !input.unconditional &&
    (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)
  )
    throw new ConfigVersionError(
      'invalid_input',
      key,
      'expectedVersion must be a non-negative integer',
    );
  if (!(CONFIG_ACTORS as readonly string[]).includes(causedBy.actor))
    throw new ConfigVersionError('invalid_input', key, 'unknown actor');
  if (input.deleteKey && (input.insertIfMissing || input.value !== undefined))
    throw new ConfigVersionError(
      'invalid_input',
      key,
      'deleteKey excludes insertIfMissing and value',
    );
  if (!input.deleteKey) assertScalar(key, input.value);

  // Step 4: the collection row is locked first, and only when the key is
  // inserted or deleted.
  let collectionVersion: number | null = null;
  let collectionLocked = false;
  const lockCollection = async () => {
    const collection = await client.query<{ version: string }>(
      'SELECT version FROM checkout.config_collection WHERE singleton FOR UPDATE',
    );
    collectionLocked = true;
    collectionVersion = num(collection.rows[0]?.version);
  };
  if (input.deleteKey) await lockCollection();
  else if (input.insertIfMissing) {
    const peek = await client.query(
      'SELECT 1 FROM checkout.config_entries WHERE key = $1',
      [key],
    );
    if (!peek.rows.length) await lockCollection();
  }

  // Step 5: the member row.
  const selectMember = () =>
    client.query<{ version: string; value: ConfigScalar }>(
      'SELECT version, value FROM checkout.config_entries WHERE key = $1 FOR UPDATE',
      [key],
    );
  let member = await selectMember();
  const actionId = causedBy.actionId ?? null;
  // An unconditional write advances from whatever version it finds under lock.
  const expectedOf = (found: boolean) =>
    input.unconditional
      ? found
        ? num(member.rows[0].version)
        : 0
      : input.expectedVersion;

  if (!member.rows.length) {
    const expectedVersion = expectedOf(false);
    if (!input.insertIfMissing)
      throw new ConfigVersionError(
        'missing_key',
        key,
        'config key does not exist',
        expectedVersion,
        0,
      );
    if (expectedVersion !== 0)
      throw new ConfigVersionError(
        'stale_version',
        key,
        'key does not exist but a version was expected',
        expectedVersion,
        0,
      );
    if (!collectionLocked) {
      // The peek saw a row that a concurrent delete then removed: the lock on
      // the collection is taken now (never while holding the member row, which
      // does not exist) and membership is checked AGAIN. A competing inserter
      // that was queued behind the same delete may have created the key in the
      // meantime; that is a lost compare-and-set, not an internal error.
      await lockCollection();
      member = await selectMember();
      if (member.rows.length)
        throw new ConfigVersionError(
          'stale_version',
          key,
          'key was created concurrently',
          expectedVersion,
          num(member.rows[0].version),
        );
    }
    const next = await client.query<{ next: string }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM checkout.config_versions WHERE key = $1',
      [key],
    );
    const versionAfter = num(next.rows[0].next);
    const value = input.value as ConfigScalar;
    const afterDigest = configValueDigest(value);
    await client.query(
      `INSERT INTO checkout.config_entries
         (key, value, version, caused_by_action_id, caused_by_actor, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, now())`,
      [key, JSON.stringify(value), versionAfter, actionId, causedBy.actor],
    );
    await insertHistory(client, {
      key,
      version: versionAfter,
      value,
      beforeDigest: null,
      afterDigest,
      actionId,
      actor: causedBy.actor,
    });
    collectionVersion = await bumpCollection(client);
    await notify(client, key, versionAfter, true, collectionVersion);
    return {
      key,
      versionBefore: 0,
      versionAfter,
      beforeDigest: null,
      afterDigest,
      membershipChanged: true,
      collectionVersion,
      operation: 'insert',
    };
  }

  const current = num(member.rows[0].version);
  const expectedVersion = expectedOf(true);
  const beforeDigest = configValueDigest(member.rows[0].value);
  if (current !== expectedVersion)
    throw new ConfigVersionError(
      'stale_version',
      key,
      'config version changed',
      expectedVersion,
      current,
    );

  if (input.deleteKey) {
    const versionAfter = current + 1;
    const deleted = await client.query(
      'DELETE FROM checkout.config_entries WHERE key = $1 AND version = $2',
      [key, expectedVersion],
    );
    if (deleted.rowCount !== 1)
      throw new ConfigVersionError(
        'stale_version',
        key,
        'config version changed',
        expectedVersion,
        null,
      );
    await insertHistory(client, {
      key,
      version: versionAfter,
      value: null,
      beforeDigest,
      afterDigest: null,
      actionId,
      actor: causedBy.actor,
    });
    collectionVersion = await bumpCollection(client);
    await notify(client, key, versionAfter, true, collectionVersion);
    return {
      key,
      versionBefore: current,
      versionAfter,
      beforeDigest,
      afterDigest: null,
      membershipChanged: true,
      collectionVersion,
      operation: 'delete',
    };
  }

  // Step 7: compare-and-set. A value update never touches config_collection.
  const value = input.value as ConfigScalar;
  const afterDigest = configValueDigest(value);
  const versionAfter = current + 1;
  const updated = await client.query(
    `UPDATE checkout.config_entries
        SET value = $2::jsonb, version = version + 1,
            caused_by_action_id = $3, caused_by_actor = $4, updated_at = now()
      WHERE key = $1 AND version = $5`,
    [key, JSON.stringify(value), actionId, causedBy.actor, expectedVersion],
  );
  if (updated.rowCount !== 1)
    throw new ConfigVersionError(
      'stale_version',
      key,
      'config version changed',
      expectedVersion,
      null,
    );
  await insertHistory(client, {
    key,
    version: versionAfter,
    value,
    beforeDigest,
    afterDigest,
    actionId,
    actor: causedBy.actor,
  });
  await notify(client, key, versionAfter, false, collectionVersion);
  return {
    key,
    versionBefore: current,
    versionAfter,
    beforeDigest,
    afterDigest,
    membershipChanged: false,
    collectionVersion,
    operation: 'update',
  };
}

async function insertHistory(
  client: PgClient,
  row: {
    key: string;
    version: number;
    value: ConfigScalar | null;
    beforeDigest: string | null;
    afterDigest: string | null;
    actionId: string | null;
    actor: ConfigActor;
  },
) {
  await client.query(
    `INSERT INTO checkout.config_versions
       (key, version, value, before_digest, after_digest,
        caused_by_action_id, caused_by_actor, at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, now())`,
    [
      row.key,
      row.version,
      row.value === null ? null : JSON.stringify(row.value),
      row.beforeDigest,
      row.afterDigest,
      row.actionId,
      row.actor,
    ],
  );
}

async function bumpCollection(client: PgClient) {
  const bumped = await client.query<{ version: string }>(
    `UPDATE checkout.config_collection SET version = version + 1
      WHERE singleton RETURNING version`,
  );
  return num(bumped.rows[0].version);
}

/** Step 10. The payload names the changed source; it never carries values or actors. */
async function notify(
  client: PgClient,
  key: string,
  version: number,
  membershipChanged: boolean,
  collectionVersion: number | null,
) {
  await client.query('SELECT pg_notify($1, $2)', [
    SOURCE_CHANGED_CHANNEL,
    JSON.stringify({
      key: `checkout.config/${key}`,
      version,
      membershipChanged,
      collectionVersion: membershipChanged ? collectionVersion : null,
    }),
  ]);
}

/**
 * `advanceConfig` in its own transaction (deadlock/serialization retry
 * included). For writers with nothing else to commit atomically.
 */
export function advanceConfigTx(
  pool: { connect(): Promise<pg.PoolClient> },
  input: AdvanceConfigInput,
  options?: TransactionOptions,
): Promise<AdvanceConfigResult> {
  return withTransaction(
    pool,
    (client) => advanceConfig(client, input),
    options,
  );
}

/**
 * For the injector and the seed, which write a value regardless of what the
 * current version is. The lock sequence is the one in `advanceConfig`
 * (collection first when the key is inserted or deleted); the expected
 * version is read under the member lock. Never used by actions or the owner
 * edit, whose CAS is the point.
 */
export function advanceConfigUnconditionally(
  client: PgClient,
  input: Omit<AdvanceConfigInput, 'expectedVersion' | 'unconditional'>,
): Promise<AdvanceConfigResult> {
  return advanceConfig(client, {
    ...input,
    expectedVersion: 0,
    unconditional: true,
  });
}

export function advanceConfigUnconditionallyTx(
  pool: { connect(): Promise<pg.PoolClient> },
  input: Parameters<typeof advanceConfigUnconditionally>[1],
  options?: TransactionOptions,
): Promise<AdvanceConfigResult> {
  return withTransaction(
    pool,
    (client) => advanceConfigUnconditionally(client, input),
    options,
  );
}
