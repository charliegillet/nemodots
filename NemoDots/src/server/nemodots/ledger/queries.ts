// Read models over the ledger: evidence views with their consuming branches
// and lastConfirmedAt (UI "Evidence" view, snapshots), receipt history, and
// invalidation events projected per mission (finding I10). Read-only.
import type {
  Affected,
  Environment,
  InvalidationEvent,
  InvalidationReason,
  ObservationReceipt,
  PgClient,
  ReceiptConfirmation,
  ReceiptStatus,
  ReceiptTransition,
  TransitionReason,
  SelfWrite,
} from '../contracts/index.js';
import {
  RECEIPT_SELECT,
  type ReceiptDbRow,
  getReceiptRow,
  mapReceiptRow,
  toReceipt,
} from './receipt-store.js';

export async function getReceipt(
  client: PgClient,
  receiptId: string,
): Promise<ObservationReceipt> {
  return toReceipt(await getReceiptRow(client, receiptId));
}

/** The head (highest revision) receipt of a source, whatever its status. */
export async function currentReceipt(
  client: PgClient,
  identity: {
    ownerId: string;
    environment: Environment;
    resource: string;
    key: string;
  },
): Promise<ObservationReceipt | null> {
  const { rows } = await client.query(
    `${RECEIPT_SELECT}
      WHERE s.owner_id = $1 AND s.environment = $2 AND s.resource = $3 AND s.key = $4
      ORDER BY r.source_revision DESC LIMIT 1`,
    [identity.ownerId, identity.environment, identity.resource, identity.key],
  );
  return rows[0]
    ? toReceipt(mapReceiptRow(rows[0] as unknown as ReceiptDbRow))
    : null;
}

export async function listConfirmations(
  client: PgClient,
  receiptId: string,
): Promise<ReceiptConfirmation[]> {
  const { rows } = await client.query<{
    receipt_id: string;
    confirmed_at: Date;
    provenance_kind: 'watcher' | 'tool_call' | 'probe';
    attempt_id: string | null;
    model_call_id: string | null;
  }>(
    `SELECT receipt_id, confirmed_at, provenance_kind, attempt_id, model_call_id
       FROM ledger.receipt_confirmations WHERE receipt_id = $1 ORDER BY id`,
    [receiptId],
  );
  return rows.map(
    (row) =>
      ({
        receiptId: row.receipt_id,
        confirmedAt: row.confirmed_at.toISOString(),
        provenance: {
          kind: row.provenance_kind,
          attemptId: row.attempt_id,
          modelCallId: row.model_call_id,
        },
      }) as ReceiptConfirmation,
  );
}

export async function listTransitions(
  client: PgClient,
  receiptId: string,
): Promise<ReceiptTransition[]> {
  const { rows } = await client.query<{
    receipt_id: string;
    from_status: ReceiptStatus;
    to_status: ReceiptStatus;
    reason: TransitionReason;
    at: Date;
    event_id: string;
  }>(
    `SELECT receipt_id, from_status, to_status, reason, at, event_id
       FROM ledger.receipt_transitions WHERE receipt_id = $1 ORDER BY id`,
    [receiptId],
  );
  return rows.map(
    (row) =>
      ({
        receiptId: row.receipt_id,
        from: row.from_status,
        to: row.to_status,
        reason: row.reason,
        at: row.at.toISOString(),
        eventId: row.event_id,
      }) as ReceiptTransition,
  );
}

/** A branch (mission, task) that rests directly on a receipt. */
export interface ConsumingBranch {
  missionId: string;
  taskId: string | null;
  attemptIds: string[];
  modelCallIds: string[];
}

export interface EvidenceItem {
  receipt: ObservationReceipt;
  confirmations: number;
  consumers: ConsumingBranch[];
}

export interface EvidenceFilter {
  ownerId: string;
  environment: Environment;
  resource: string;
  /** Only branches of this mission are listed as consumers. */
  missionId?: string;
  /** Include superseded history (default: the head receipt of each source only). */
  includeHistory?: boolean;
}

/**
 * Evidence for the UI: receipts with lastConfirmedAt, the number of
 * confirmations, and the branches that consume each receipt directly (evidence
 * edges to attempts and model calls, grouped by mission and task).
 */
export async function listEvidence(
  client: PgClient,
  filter: EvidenceFilter,
): Promise<EvidenceItem[]> {
  const { rows } = await client.query(
    `${RECEIPT_SELECT}
      WHERE s.owner_id = $1 AND s.environment = $2 AND s.resource = $3
        AND ($4::boolean OR r.source_revision = (
              SELECT max(h.source_revision) FROM ledger.observation_receipts h
               WHERE h.source_id = r.source_id))
      ORDER BY s.key, r.source_revision`,
    [
      filter.ownerId,
      filter.environment,
      filter.resource,
      filter.includeHistory ?? false,
    ],
  );
  const receipts = rows.map((row) =>
    mapReceiptRow(row as unknown as ReceiptDbRow),
  );
  if (receipts.length === 0) return [];
  const ids = receipts.map((row) => row.id);
  const confirmations = await client.query<{ receipt_id: string; n: string }>(
    `SELECT receipt_id, count(*) AS n FROM ledger.receipt_confirmations
      WHERE receipt_id = ANY($1::uuid[]) GROUP BY receipt_id`,
    [ids],
  );
  const confirmed = new Map(
    confirmations.rows.map((row) => [row.receipt_id, Number(row.n)]),
  );
  const consumers = await client.query<{
    receipt_id: string;
    mission_id: string;
    task_id: string | null;
    kind: 'attempt' | 'model_call';
    id: string;
  }>(
    `SELECT e.from_id AS receipt_id, n.mission_id, n.task_id, n.kind, n.id
       FROM ledger.dependency_edges e
       JOIN ledger.dependency_nodes n ON n.kind = e.to_kind AND n.id = e.to_id
      WHERE e.from_kind = 'receipt' AND e.from_id = ANY($1::uuid[])
        AND e.kind = 'evidence' AND n.kind IN ('attempt', 'model_call')
        AND ($2::uuid IS NULL OR n.mission_id = $2)
      ORDER BY n.mission_id, n.task_id, n.kind, n.id`,
    [ids, filter.missionId ?? null],
  );
  const byReceipt = new Map<string, Map<string, ConsumingBranch>>();
  for (const row of consumers.rows) {
    const branches = byReceipt.get(row.receipt_id) ?? new Map();
    const key = `${row.mission_id}/${row.task_id ?? ''}`;
    const branch: ConsumingBranch = branches.get(key) ?? {
      missionId: row.mission_id,
      taskId: row.task_id,
      attemptIds: [],
      modelCallIds: [],
    };
    (row.kind === 'attempt' ? branch.attemptIds : branch.modelCallIds).push(
      row.id,
    );
    branches.set(key, branch);
    byReceipt.set(row.receipt_id, branches);
  }
  return receipts.map((row) => ({
    receipt: toReceipt(row),
    confirmations: confirmed.get(row.id) ?? 0,
    consumers: [...(byReceipt.get(row.id)?.values() ?? [])],
  }));
}

interface EventRow {
  id: string;
  source_key: string;
  old_receipt_id: string;
  new_receipt_id: string | null;
  reason: InvalidationReason;
  self_write: SelfWrite;
  graph_version: string;
  mission_ids: string[];
  affected: Affected;
  per_mission: InvalidationEvent['perMission'];
  closure: InvalidationEvent['closure'];
  resolved_at: Date | null;
  created_at: Date;
}

const toEvent = (row: EventRow): InvalidationEvent =>
  ({
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
  }) as InvalidationEvent;

/**
 * What a mission's stream and snapshot receive (finding I10): the global
 * `affected` set is replaced by that mission's subset and no other mission's
 * ids are present. Null when the mission is not part of the event.
 */
export function eventForMission(
  event: InvalidationEvent,
  missionId: string,
): InvalidationEvent | null {
  const entry = event.perMission.find((item) => item.missionId === missionId);
  if (!entry) return null;
  return {
    ...event,
    missionIds: [entry.missionId],
    affected: entry.affected,
    perMission: [entry],
  };
}

export async function getInvalidationEvent(
  client: PgClient,
  id: string,
): Promise<InvalidationEvent | null> {
  const { rows } = await client.query<EventRow>(
    'SELECT * FROM ledger.invalidation_events WHERE id = $1',
    [id],
  );
  return rows[0] ? toEvent(rows[0]) : null;
}

export async function listInvalidationEvents(
  client: PgClient,
  filter: { missionId?: string; unresolvedOnly?: boolean } = {},
): Promise<InvalidationEvent[]> {
  const { rows } = await client.query<EventRow>(
    `SELECT * FROM ledger.invalidation_events
      WHERE ($1::text IS NULL OR mission_ids ? $1)
        AND (NOT $2::boolean OR resolved_at IS NULL)
      ORDER BY created_at, id`,
    [filter.missionId ?? null, filter.unresolvedOnly ?? false],
  );
  const events = rows.map(toEvent);
  return filter.missionId
    ? events.flatMap((event) => eventForMission(event, filter.missionId!) ?? [])
    : events;
}

/** Sets resolved_at once; the coordinator calls it when openInvalidation() becomes false (D9). */
export async function markInvalidationResolved(
  client: PgClient,
  id: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE ledger.invalidation_events SET resolved_at = clock_timestamp()
      WHERE id = $1 AND resolved_at IS NULL`,
    [id],
  );
  return result.rowCount === 1;
}
