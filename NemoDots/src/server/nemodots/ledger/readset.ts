// Read sets: the receipts an attempt rests on, kept as evidence edges
// receipt -> attempt (CONTRACTS.md section 4, TaskAttempt.readSetReceiptIds).
// recordModelCall adds the edges of a call's whole vector; recordReadSet adds
// receipts a tool read without a model call yet (observe_source results).
import type { BlockReason, PgClient, ReceiptId } from '../contracts/index.js';
import { addEdges, type AddEdgesResult } from './edges.js';
import type { LedgerOptions } from './options.js';
import { getReceiptRows } from './receipt-store.js';
import { liveVersion } from './sources.js';

export async function recordReadSet(
  client: PgClient,
  input: {
    missionId: string;
    taskId: string;
    attemptId: string;
    receiptIds: readonly string[];
  },
): Promise<AddEdgesResult> {
  const attempt = {
    kind: 'attempt' as const,
    id: input.attemptId,
    missionId: input.missionId,
    taskId: input.taskId,
  };
  return addEdges(
    client,
    [...new Set(input.receiptIds)].map((id) => ({
      kind: 'evidence' as const,
      from: { kind: 'receipt' as const, id },
      to: attempt,
    })),
  );
}

/** Receipt ids recorded as read by an attempt (sorted). */
export async function readSetOf(
  client: PgClient,
  attemptId: string,
): Promise<ReceiptId[]> {
  const { rows } = await client.query<{ from_id: ReceiptId }>(
    `SELECT from_id FROM ledger.dependency_edges
      WHERE to_kind = 'attempt' AND to_id = $1 AND from_kind = 'receipt' AND kind = 'evidence'
      ORDER BY from_id`,
    [attemptId],
  );
  return rows.map((row) => row.from_id);
}

export interface StaleRead {
  receiptId: ReceiptId;
  sourceKey: string;
  reason: Extract<
    BlockReason,
    'stale_version' | 'stale_pending_observation' | 'receipt_not_supported'
  >;
}

/**
 * Non-locking check used by the worker's abort loop: which receipts of the
 * attempt's read set are no longer current (status, or a controlled source
 * whose live version moved)? An empty array means nothing is known to be stale
 * (observed sources can change unobserved, ARCHITECTURE section 4).
 */
export async function staleReads(
  client: PgClient,
  attemptId: string,
  options?: LedgerOptions,
): Promise<StaleRead[]> {
  const ids = await readSetOf(client, attemptId);
  const rows = await getReceiptRows(client, ids);
  const controlled = [...rows.values()]
    .filter((row) => row.authority === 'controlled')
    .map((row) => row.sourceKey);
  const live =
    controlled.length > 0
      ? await liveVersion(client, controlled, 'none', options)
      : new Map<string, number | null>();
  const stale: StaleRead[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) continue;
    if (row.status === 'superseded')
      stale.push({ receiptId: id, sourceKey: row.sourceKey, reason: 'stale_version' });
    else if (row.status !== 'supported')
      stale.push({
        receiptId: id,
        sourceKey: row.sourceKey,
        reason: 'receipt_not_supported',
      });
    else if (
      row.authority === 'controlled' &&
      live.get(row.sourceKey) !== row.sourceRevision
    )
      stale.push({
        receiptId: id,
        sourceKey: row.sourceKey,
        reason: 'stale_pending_observation',
      });
  }
  return stale;
}
