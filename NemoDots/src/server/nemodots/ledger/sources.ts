// Sources registry and controlled live versions (ARCHITECTURE.md sections 3
// and 5.2). The registry row is the lock that serializes registration and
// closure of one source [C8]; controlled versions are read from the authority
// tables only and never copied into the ledger.
import { randomUUID } from 'node:crypto';
import {
  type PgClient,
  type SourceKey,
  type SourceRef,
  type SourceType,
  type SourceAuthority,
  type Environment,
} from '../contracts/index.js';
import { SourceConflictError } from './errors.js';
import { checkoutSchema, type LedgerOptions } from './options.js';

export interface SourceRow {
  id: string;
  ownerId: string;
  environment: Environment;
  resource: string;
  key: SourceKey;
  sourceType: SourceType;
  authority: SourceAuthority;
}

interface SourceDbRow {
  id: string;
  owner_id: string;
  environment: Environment;
  resource: string;
  key: SourceKey;
  source_type: SourceType;
  authority: SourceAuthority;
}

const SOURCE_COLUMNS =
  'id, owner_id, environment, resource, key, source_type, authority';

const toSourceRow = (row: SourceDbRow): SourceRow => ({
  id: row.id,
  ownerId: row.owner_id,
  environment: row.environment,
  resource: row.resource,
  key: row.key,
  sourceType: row.source_type,
  authority: row.authority,
});

/**
 * Registers the source if it is new (ON CONFLICT DO NOTHING) and returns the
 * row. A source key registered earlier with a different type is a conflict.
 */
export async function ensureSource(
  client: PgClient,
  ref: Pick<SourceRef, 'key' | 'sourceType' | 'authority'> & {
    scope: Pick<SourceRef['scope'], 'ownerId' | 'environment' | 'resource'>;
  },
): Promise<SourceRow> {
  await client.query(
    `INSERT INTO ledger.sources (id, owner_id, environment, resource, key, source_type, authority)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_id, environment, resource, key) DO NOTHING`,
    [
      randomUUID(),
      ref.scope.ownerId,
      ref.scope.environment,
      ref.scope.resource,
      ref.key,
      ref.sourceType,
      ref.authority,
    ],
  );
  const { rows } = await client.query<SourceDbRow>(
    `SELECT ${SOURCE_COLUMNS} FROM ledger.sources
      WHERE owner_id = $1 AND environment = $2 AND resource = $3 AND key = $4`,
    [ref.scope.ownerId, ref.scope.environment, ref.scope.resource, ref.key],
  );
  const source = toSourceRow(rows[0]);
  if (source.sourceType !== ref.sourceType || source.authority !== ref.authority)
    throw new SourceConflictError(
      `source ${ref.key} is registered as ${source.sourceType}/${source.authority}, not ${ref.sourceType}/${ref.authority}`,
    );
  return source;
}

/** Locks the registry row FOR UPDATE; registrations and closures of the source serialize here. */
export async function lockSource(
  client: PgClient,
  sourceId: string,
): Promise<SourceRow> {
  const { rows } = await client.query<SourceDbRow>(
    `SELECT ${SOURCE_COLUMNS} FROM ledger.sources WHERE id = $1 FOR UPDATE`,
    [sourceId],
  );
  if (!rows[0]) throw new SourceConflictError(`source ${sourceId} does not exist`);
  return toSourceRow(rows[0]);
}

/**
 * Locks the registry rows of several sources FOR SHARE in id order. Writers of
 * an observed source (registration, closure) take FOR UPDATE on the same row,
 * so a publication holding this lock either commits its edges before the
 * closure reads the graph or sees the superseded receipt afterwards [C13].
 */
export async function lockSourcesShared(
  client: PgClient,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  await client.query(
    'SELECT id FROM ledger.sources WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE',
    [[...new Set(sourceIds)]],
  );
}

export async function findSourceByKey(
  client: PgClient,
  identity: { ownerId: string; environment: Environment; resource: string; key: string },
): Promise<SourceRow | null> {
  const { rows } = await client.query<SourceDbRow>(
    `SELECT ${SOURCE_COLUMNS} FROM ledger.sources
      WHERE owner_id = $1 AND environment = $2 AND resource = $3 AND key = $4`,
    [identity.ownerId, identity.environment, identity.resource, identity.key],
  );
  return rows[0] ? toSourceRow(rows[0]) : null;
}

export const COLLECTION_SOURCE_KEY = 'checkout.config';
const MEMBER_PREFIX = 'checkout.config/';

export function isCollectionKey(key: string): boolean {
  return key === COLLECTION_SOURCE_KEY;
}

/** `checkout.config/<key>` -> `<key>`; null for anything else. */
export function configMemberKey(sourceKey: string): string | null {
  return sourceKey.startsWith(MEMBER_PREFIX)
    ? sourceKey.slice(MEMBER_PREFIX.length)
    : null;
}

export type LiveLockMode = 'share' | 'update' | 'none';

const LOCK_CLAUSE: Record<LiveLockMode, string> = {
  share: ' FOR SHARE',
  update: ' FOR UPDATE',
  none: '',
};

/**
 * Live versions of controlled sources, keyed by source key. The collection row
 * (`checkout.config`) is locked first and member rows in key order, the lock
 * order of every writer (ARCHITECTURE 5.1), so overlapping lockers cannot
 * deadlock. A member with no row maps to null (the key was deleted).
 * `lockMode` 'share' is for registration and G2 publications, 'update' for G1
 * commits; 'none' reads without locking.
 */
export async function liveVersion(
  client: PgClient,
  keys: readonly string[],
  lockMode: LiveLockMode,
  options?: LedgerOptions,
): Promise<Map<string, number | null>> {
  const schema = checkoutSchema(options);
  const lock = LOCK_CLAUSE[lockMode];
  const result = new Map<string, number | null>();
  const members: string[] = [];
  let wantsCollection = false;
  for (const key of keys) {
    if (isCollectionKey(key)) wantsCollection = true;
    else if (configMemberKey(key) !== null) members.push(configMemberKey(key)!);
    else throw new SourceConflictError(`${key} is not a controlled source key`);
  }
  if (wantsCollection) {
    const { rows } = await client.query<{ version: number }>(
      `SELECT version FROM ${schema}.config_collection${lock}`,
    );
    result.set(COLLECTION_SOURCE_KEY, rows[0] ? Number(rows[0].version) : null);
  }
  if (members.length > 0) {
    const sorted = [...new Set(members)].sort();
    const { rows } = await client.query<{ key: string; version: number }>(
      `SELECT key, version FROM ${schema}.config_entries
        WHERE key = ANY($1::text[]) ORDER BY key${lock}`,
      [sorted],
    );
    const found = new Map(rows.map((row) => [row.key, Number(row.version)]));
    for (const member of sorted)
      result.set(`${MEMBER_PREFIX}${member}`, found.get(member) ?? null);
  }
  return result;
}

/** Sorted member keys currently in the authority (for collection observations). */
export async function liveMemberKeys(
  client: PgClient,
  options?: LedgerOptions,
): Promise<string[]> {
  const schema = checkoutSchema(options);
  const { rows } = await client.query<{ key: string }>(
    `SELECT key FROM ${schema}.config_entries ORDER BY key`,
  );
  return rows.map((row) => row.key).sort();
}
