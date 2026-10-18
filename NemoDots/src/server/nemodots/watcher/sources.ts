import { z } from 'zod';
import {
  CONFIG_MEMBER_KEY_PATTERN,
  SOURCE_KEY_PATTERNS,
  type Environment,
  type MissionId,
  type PgClient,
  type Scope,
  type SourceAuthority,
  type SourceKey,
  type SourceRef,
  type SourceType,
} from '../contracts/index.js';
import { checkoutSchema, type LedgerOptions } from '../ledger/index.js';
import { WATCHER_MISSION_ID, type WatcherConfig } from './types.js';

// Which sources the watcher follows and how it names them (ARCHITECTURE 9.4).

export const COLLECTION_KEY = 'checkout.config' as SourceKey;
const MEMBER_PREFIX = 'checkout.config/';

/** `checkout.config/<key>` -> `<key>`, null otherwise. */
export function memberKeyOf(sourceKey: string): string | null {
  return sourceKey.startsWith(MEMBER_PREFIX)
    ? sourceKey.slice(MEMBER_PREFIX.length)
    : null;
}

export const memberSourceKey = (key: string) =>
  `${MEMBER_PREFIX}${key}` as SourceKey;

/** Observed sources read on every poll when the config names none. */
export const DEFAULT_OBSERVED_SOURCES: readonly SourceKey[] = Object.freeze([
  'checkout.health',
  'checkout.metrics',
  'checkout.orders.recent',
  'redis.stats',
] as SourceKey[]);

/**
 * The ledger refuses a source key registered with two different types, so every
 * writer of these sources (the watcher and `observe_source`) must agree. The
 * HTTP views of the checkout are endpoints, datastore views are stores.
 * The watcher prefers the type already stored in the ledger when a source
 * exists; this table only decides for sources it registers first.
 */
export function observedSourceType(
  key: string,
): Extract<SourceType, 'observed_endpoint' | 'observed_store'> {
  return key === 'checkout.orders.recent' || key === 'redis.stats'
    ? 'observed_store'
    : 'observed_endpoint';
}

const READABLE_OBSERVED: readonly RegExp[] = [
  SOURCE_KEY_PATTERNS['checkout.health'],
  SOURCE_KEY_PATTERNS['checkout.metrics'],
  SOURCE_KEY_PATTERNS['checkout.orders.recent'],
  SOURCE_KEY_PATTERNS['redis.stats'],
  SOURCE_KEY_PATTERNS['checkout.inventory/<sku>'],
];

/** Observed families the checkout readers serve (so the watcher can poll them). */
export function isReadableObserved(key: string): boolean {
  return READABLE_OBSERVED.some((pattern) => pattern.test(key));
}

export interface WatchScope {
  ownerId: string;
  environment: Environment;
  resource: string;
  spaceId: string | null;
  missionId: MissionId;
}

export function resolveScope(config: WatcherConfig): WatchScope {
  return {
    ownerId: config.ownerId,
    environment: config.environment,
    resource: config.resource ?? 'checkout',
    spaceId: config.spaceId ?? null,
    missionId: config.missionId ?? WATCHER_MISSION_ID,
  };
}

export const toScope = (scope: WatchScope): Scope => ({ ...scope });

export function controlledRef(scope: WatchScope, key: string): SourceRef {
  const collection = key === COLLECTION_KEY;
  return {
    key: key as SourceKey,
    sourceType: collection ? 'controlled_collection' : 'controlled_config',
    authority: 'controlled',
    scope: toScope(scope),
  };
}

export function observedRef(
  scope: WatchScope,
  key: string,
  storedType?: SourceType,
): SourceRef {
  const type =
    storedType === 'observed_endpoint' || storedType === 'observed_store'
      ? storedType
      : observedSourceType(key);
  return {
    key: key as SourceKey,
    sourceType: type,
    authority: 'observed',
    scope: toScope(scope),
  };
}

export interface HeadRow {
  key: string;
  sourceType: SourceType;
  authority: SourceAuthority;
  /** null while the source has no receipt yet. */
  revision: number | null;
  status: string | null;
  receiptId: string | null;
}

/** Every source of the scope with its head receipt (highest revision, any status). */
export async function loadHeads(
  client: PgClient,
  scope: WatchScope,
): Promise<Map<string, HeadRow>> {
  const { rows } = await client.query<{
    key: string;
    source_type: SourceType;
    authority: SourceAuthority;
    source_revision: number | null;
    status: string | null;
    id: string | null;
  }>(
    `SELECT s.key, s.source_type, s.authority, h.source_revision, h.status, h.id
       FROM ledger.sources s
       LEFT JOIN LATERAL (
         SELECT r.id, r.source_revision, r.status FROM ledger.observation_receipts r
          WHERE r.source_id = s.id ORDER BY r.source_revision DESC LIMIT 1) h ON true
      WHERE s.owner_id = $1 AND s.environment = $2 AND s.resource = $3`,
    [scope.ownerId, scope.environment, scope.resource],
  );
  return new Map(
    rows.map((row) => [
      row.key,
      {
        key: row.key,
        sourceType: row.source_type,
        authority: row.authority,
        revision:
          row.source_revision === null ? null : Number(row.source_revision),
        status: row.status,
        receiptId: row.id,
      },
    ]),
  );
}

/** The head receipt of one source (null when it has none), whatever its status. */
export async function loadHead(
  client: PgClient,
  scope: WatchScope,
  key: string,
): Promise<{ revision: number; status: string; receiptId: string } | null> {
  const { rows } = await client.query<{
    source_revision: number;
    status: string;
    id: string;
  }>(
    `SELECT r.source_revision, r.status, r.id
       FROM ledger.observation_receipts r
       JOIN ledger.sources s ON s.id = r.source_id
      WHERE s.owner_id = $1 AND s.environment = $2 AND s.resource = $3 AND s.key = $4
      ORDER BY r.source_revision DESC LIMIT 1`,
    [scope.ownerId, scope.environment, scope.resource, key],
  );
  return rows[0]
    ? {
        revision: Number(rows[0].source_revision),
        status: rows[0].status,
        receiptId: rows[0].id,
      }
    : null;
}

export interface Authority {
  collectionVersion: number;
  /** member key -> live version */
  members: Map<string, number>;
}

/** Live versions straight from the authority tables (no locks; a hint to decide what to read). */
export async function loadAuthority(
  client: PgClient,
  options?: LedgerOptions,
): Promise<Authority> {
  const schema = checkoutSchema(options);
  const [members, collection] = await Promise.all([
    client.query<{ key: string; version: string }>(
      `SELECT key, version FROM ${schema}.config_entries ORDER BY key`,
    ),
    client.query<{ version: string }>(
      `SELECT version FROM ${schema}.config_collection`,
    ),
  ]);
  return {
    collectionVersion: Number(collection.rows[0]?.version ?? 0),
    members: new Map(members.rows.map((row) => [row.key, Number(row.version)])),
  };
}

/** NOTIFY payload of nemodots_source_changed: names the source, never values or actors. */
const SourceChangedSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  membershipChanged: z.boolean().optional(),
});

export interface SourceChanged {
  key: string;
  membershipChanged: boolean;
}

/**
 * Parses a notification payload. A malformed one returns null: NOTIFY is a
 * delivery hint, the caller falls back to a full poll (never trusts the
 * payload for a value or a version).
 */
export function parseSourceChanged(payload: string): SourceChanged | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = SourceChangedSchema.safeParse(json);
  if (!parsed.success) return null;
  const key = parsed.data.key;
  const member = memberKeyOf(key);
  if (
    key !== COLLECTION_KEY &&
    (member === null || !CONFIG_MEMBER_KEY_PATTERN.test(member))
  )
    return null;
  return { key, membershipChanged: parsed.data.membershipChanged === true };
}
