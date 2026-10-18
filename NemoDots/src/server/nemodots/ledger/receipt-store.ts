// Row-level access to receipts, transitions and confirmations. No policy lives
// here: registration rules are in receipts.ts, closure in invalidation.ts.
// Receipt rows are immutable (a trigger refuses everything but a legal
// status transition), so every change goes through the compare-and-set in
// transitionRow().
import { randomUUID } from 'node:crypto';
import {
  assertTransition,
  type ActionId,
  type AttemptId,
  type Digest,
  type Environment,
  type ModelCallId,
  type ObservationReceipt,
  type PgClient,
  type ReceiptId,
  type ReceiptStatus,
  type SelfWrite,
  type SourceAuthority,
  type SourceKey,
  type SourceType,
  type TransitionReason,
  type TrustClass,
  type MissionId,
} from '../contracts/index.js';
import { ReceiptConflictError, ReceiptNotFoundError } from './errors.js';

export interface ReceiptRow {
  id: ReceiptId;
  sourceId: string;
  ownerId: string;
  environment: Environment;
  resource: string;
  sourceKey: SourceKey;
  sourceType: SourceType;
  authority: SourceAuthority;
  sourceRevision: number;
  collectionRevision: number | null;
  missionId: MissionId;
  spaceId: string | null;
  observedAt: Date;
  lastConfirmedAt: Date;
  contentDigest: Digest;
  normalizedValue: unknown;
  rawRef: ObservationReceipt['rawRef'];
  status: ReceiptStatus;
  statusVersion: number;
  supersedes: ReceiptId | null;
  supersededBy: ReceiptId | null;
  trust: Exclude<TrustClass, 'model_claim'>;
  provenance: ObservationReceipt['provenance'];
  negative: ObservationReceipt['negative'];
  expiresAt: Date | null;
}

export interface ReceiptDbRow {
  id: ReceiptId;
  source_id: string;
  owner_id: string;
  environment: Environment;
  resource: string;
  source_key: SourceKey;
  source_type: SourceType;
  authority: SourceAuthority;
  source_revision: number;
  collection_revision: number | null;
  mission_id: MissionId;
  space_id: string | null;
  observed_at: Date;
  last_confirmed_at: Date;
  content_digest: Digest;
  normalized_value: unknown;
  raw_ref: ObservationReceipt['rawRef'];
  status: ReceiptStatus;
  status_version: number;
  supersedes: ReceiptId | null;
  superseded_by: ReceiptId | null;
  trust: Exclude<TrustClass, 'model_claim'>;
  provenance_kind: ObservationReceipt['provenance']['kind'];
  tool_call_id: string | null;
  model_call_id: ModelCallId | null;
  attempt_id: AttemptId | null;
  caused_by_action_id: ActionId | null;
  self_write: SelfWrite;
  negative: ObservationReceipt['negative'];
  expires_at: Date | null;
}

/** lastConfirmedAt = max(observed_at, latest confirmation) (rev2 I2/D3). */
export const RECEIPT_SELECT = `
  SELECT r.id, r.source_id, s.owner_id, s.environment, s.resource, s.key AS source_key,
         s.source_type, s.authority, r.source_revision, r.collection_revision,
         r.mission_id, s.space_id AS space_id, r.observed_at,
         GREATEST(r.observed_at,
                  COALESCE((SELECT max(c.confirmed_at) FROM ledger.receipt_confirmations c
                             WHERE c.receipt_id = r.id), r.observed_at)) AS last_confirmed_at,
         r.content_digest, r.normalized_value, r.raw_ref, r.status, r.status_version,
         r.supersedes, r.superseded_by, r.trust, r.provenance_kind, r.tool_call_id,
         r.model_call_id, r.attempt_id, r.caused_by_action_id, r.self_write,
         r.negative, r.expires_at
    FROM ledger.observation_receipts r
    JOIN ledger.sources s ON s.id = r.source_id`;

export function mapReceiptRow(row: ReceiptDbRow): ReceiptRow {
  return {
    id: row.id,
    sourceId: row.source_id,
    ownerId: row.owner_id,
    environment: row.environment,
    resource: row.resource,
    sourceKey: row.source_key,
    sourceType: row.source_type,
    authority: row.authority,
    sourceRevision: Number(row.source_revision),
    collectionRevision:
      row.collection_revision === null ? null : Number(row.collection_revision),
    missionId: row.mission_id,
    spaceId: row.space_id,
    observedAt: row.observed_at,
    lastConfirmedAt: row.last_confirmed_at,
    contentDigest: row.content_digest,
    normalizedValue: row.normalized_value,
    rawRef: row.raw_ref,
    status: row.status,
    statusVersion: Number(row.status_version),
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    trust: row.trust,
    provenance: {
      kind: row.provenance_kind,
      toolCallId: row.tool_call_id,
      modelCallId: row.model_call_id,
      attemptId: row.attempt_id,
      causedByActionId: row.caused_by_action_id,
      selfWrite: row.self_write,
    },
    negative: row.negative,
    expiresAt: row.expires_at,
  };
}

/** The contract DTO (ISO strings). */
export function toReceipt(row: ReceiptRow): ObservationReceipt {
  return {
    id: row.id,
    source: {
      key: row.sourceKey,
      sourceType: row.sourceType,
      authority: row.authority,
      scope: {
        ownerId: row.ownerId,
        missionId: row.missionId,
        spaceId: row.spaceId,
        environment: row.environment,
        resource: row.resource,
      },
    },
    sourceRevision: row.sourceRevision,
    collectionRevision: row.collectionRevision,
    observedAt: row.observedAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    contentDigest: row.contentDigest,
    normalizedValue: row.normalizedValue,
    rawRef: row.rawRef,
    status: row.status,
    statusVersion: row.statusVersion,
    supersedes: row.supersedes,
    supersededBy: row.supersededBy,
    trust: row.trust,
    provenance: row.provenance,
    negative: row.negative,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

export async function getReceiptRow(
  client: PgClient,
  receiptId: string,
): Promise<ReceiptRow> {
  const { rows } = await client.query<ReceiptDbRow>(
    `${RECEIPT_SELECT} WHERE r.id = $1`,
    [receiptId],
  );
  if (!rows[0]) throw new ReceiptNotFoundError(receiptId);
  return mapReceiptRow(rows[0]);
}

export async function getReceiptRows(
  client: PgClient,
  receiptIds: readonly string[],
): Promise<Map<string, ReceiptRow>> {
  if (receiptIds.length === 0) return new Map();
  const { rows } = await client.query<ReceiptDbRow>(
    `${RECEIPT_SELECT} WHERE r.id = ANY($1::uuid[])`,
    [[...new Set(receiptIds)]],
  );
  return new Map(rows.map((row) => [row.id, mapReceiptRow(row)]));
}

/**
 * Locks receipt rows FOR SHARE in id order. A status change (supersession,
 * retraction, expiry) UPDATEs the row and so conflicts with this lock: a
 * publication that holds it either commits its edges before the retirement
 * reads the graph, or waits and then sees the new status [C9/C13, ARCHITECTURE
 * 5.1 step 6].
 */
export async function lockReceiptsShared(
  client: PgClient,
  receiptIds: readonly string[],
): Promise<void> {
  if (receiptIds.length === 0) return;
  await client.query(
    'SELECT id FROM ledger.observation_receipts WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE',
    [[...new Set(receiptIds)]],
  );
}

/**
 * Takes the lock the status UPDATE would take (FOR NO KEY UPDATE) before the
 * closure reads the graph, so a publication that holds the row FOR SHARE has
 * committed its edges by the time the closure runs.
 */
export async function lockReceiptForTransition(
  client: PgClient,
  receiptId: string,
): Promise<void> {
  await client.query(
    'SELECT id FROM ledger.observation_receipts WHERE id = $1 FOR NO KEY UPDATE',
    [receiptId],
  );
}

/** The highest-revision receipt of a source (its head), whatever its status. */
export async function headReceipt(
  client: PgClient,
  sourceId: string,
): Promise<ReceiptRow | null> {
  const { rows } = await client.query<ReceiptDbRow>(
    `${RECEIPT_SELECT} WHERE r.source_id = $1 ORDER BY r.source_revision DESC LIMIT 1`,
    [sourceId],
  );
  return rows[0] ? mapReceiptRow(rows[0]) : null;
}

export interface ReceiptDraft {
  id?: ReceiptId;
  sourceId: string;
  sourceRevision: number;
  collectionRevision: number | null;
  missionId: MissionId;
  spaceId: string | null;
  observedAt: Date | null;
  contentDigest: Digest;
  normalizedValue: unknown;
  rawRef: ObservationReceipt['rawRef'];
  supersedes: ReceiptId | null;
  trust: Exclude<TrustClass, 'model_claim'>;
  provenance: ObservationReceipt['provenance'];
  negative: ObservationReceipt['negative'];
  expiresAt: Date | null;
}

/** Inserts a `supported` receipt, its revision row and its graph node. */
export async function insertReceipt(
  client: PgClient,
  draft: ReceiptDraft,
): Promise<ReceiptRow> {
  const id = (draft.id ?? randomUUID()) as ReceiptId;
  await client.query(
    `INSERT INTO ledger.observation_receipts
       (id, source_id, source_revision, collection_revision, mission_id, space_id,
        observed_at, content_digest, normalized_value, raw_ref, status, status_version,
        supersedes, trust, provenance_kind, tool_call_id, model_call_id, attempt_id,
        caused_by_action_id, self_write, negative, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, clock_timestamp()), $8,
             $9::jsonb, $10::jsonb, 'supported', 0, $11, $12, $13, $14, $15, $16, $17,
             $18, $19::jsonb, $20)`,
    [
      id,
      draft.sourceId,
      draft.sourceRevision,
      draft.collectionRevision,
      draft.missionId,
      draft.spaceId,
      draft.observedAt,
      draft.contentDigest,
      JSON.stringify(draft.normalizedValue),
      draft.rawRef === null ? null : JSON.stringify(draft.rawRef),
      draft.supersedes,
      draft.trust,
      draft.provenance.kind,
      draft.provenance.toolCallId,
      draft.provenance.modelCallId,
      draft.provenance.attemptId,
      draft.provenance.causedByActionId,
      draft.provenance.selfWrite,
      draft.negative === null ? null : JSON.stringify(draft.negative),
      draft.expiresAt,
    ],
  );
  await client.query(
    `INSERT INTO ledger.source_revisions (source_id, source_revision, receipt_id, content_digest, caused_by_action_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      draft.sourceId,
      draft.sourceRevision,
      id,
      draft.contentDigest,
      draft.provenance.causedByActionId,
    ],
  );
  await client.query(
    `INSERT INTO ledger.dependency_nodes (kind, id) VALUES ('receipt', $1)
     ON CONFLICT (kind, id) DO NOTHING`,
    [id],
  );
  return getReceiptRow(client, id);
}

/**
 * Compare-and-set status change on (status, status_version) plus the
 * receipt_transitions row. The legal-transition table is checked here and
 * again by the table trigger.
 */
export async function transitionRow(
  client: PgClient,
  receipt: Pick<ReceiptRow, 'id' | 'status' | 'statusVersion'>,
  to: ReceiptStatus,
  reason: TransitionReason,
  eventId: string,
  supersededBy: ReceiptId | null = null,
): Promise<void> {
  assertTransition('receipt', receipt.status, to);
  const updated = await client.query(
    `UPDATE ledger.observation_receipts
        SET status = $3, status_version = status_version + 1, superseded_by = $4
      WHERE id = $1 AND status = $2 AND status_version = $5`,
    [receipt.id, receipt.status, to, supersededBy, receipt.statusVersion],
  );
  if (updated.rowCount !== 1)
    throw new ReceiptConflictError(
      `receipt ${receipt.id} changed concurrently (expected ${receipt.status}@${receipt.statusVersion})`,
    );
  await client.query(
    `INSERT INTO ledger.receipt_transitions (receipt_id, from_status, to_status, reason, event_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [receipt.id, receipt.status, to, reason, eventId],
  );
}

export interface ConfirmationInput {
  kind: 'watcher' | 'tool_call' | 'probe';
  attemptId: AttemptId | null;
  modelCallId: ModelCallId | null;
}

/** Appends a freshness confirmation and returns its timestamp. */
export async function appendConfirmation(
  client: PgClient,
  receiptId: string,
  input: ConfirmationInput,
): Promise<Date> {
  const { rows } = await client.query<{ confirmed_at: Date }>(
    `INSERT INTO ledger.receipt_confirmations (receipt_id, provenance_kind, attempt_id, model_call_id)
     VALUES ($1, $2, $3, $4) RETURNING confirmed_at`,
    [receiptId, input.kind, input.attemptId, input.modelCallId],
  );
  return rows[0].confirmed_at;
}
