// SupportValidator (CONTRACTS.md section 10; guarantees G1-G3, ARCHITECTURE.md
// section 4). assertCurrent runs on the caller's client inside the caller's
// transaction and ALWAYS locks the rows that decide currency; only the lock
// mode differs (rev2 C9):
//   'share'  G2 publications: a concurrent advanceConfig (FOR UPDATE) waits
//            until the publication commits;
//   'update' G1 commits: the same rows FOR UPDATE.
// Lock order: the collection row, then member rows in key order (the order of
// every writer, ARCHITECTURE 5.1), then the registry rows of observed sources.
// Reads happen after the locks, so a statement that waited sees the writer's
// committed result (READ COMMITTED).
import type {
  BlockReason,
  CheckedVector,
  PgClient,
  ReceiptId,
  SupportValidator,
} from '../contracts/index.js';
import { SupportError } from './errors.js';
import type { LedgerOptions } from './options.js';
import { getReceiptRows, type ReceiptRow } from './receipt-store.js';
import { liveVersion, lockSourcesShared } from './sources.js';

export interface AssertCurrentOptions {
  lockMode: 'share' | 'update';
  /** maxAgeMs per source key, checked against lastConfirmedAt. */
  freshness?: { [sourceKey: string]: number };
}

type Verdict = { reason: BlockReason; detail: string } | null;

function judge(
  row: ReceiptRow,
  live: number | null | undefined,
  nowMs: number,
  freshnessOk: boolean,
): Verdict {
  if (row.status === 'superseded')
    return {
      reason: 'stale_version',
      detail: `receipt ${row.id} (${row.sourceKey}@${row.sourceRevision}) was superseded`,
    };
  if (row.status !== 'supported')
    return {
      reason: 'receipt_not_supported',
      detail: `receipt ${row.id} (${row.sourceKey}) is ${row.status}`,
    };
  if (row.expiresAt && row.expiresAt.getTime() <= nowMs)
    return {
      reason: 'expired',
      detail: `receipt ${row.id} (${row.sourceKey}) passed its expiry`,
    };
  if (row.authority === 'controlled') {
    if (live === null || live === undefined)
      return {
        reason: 'stale_pending_observation',
        detail: `${row.sourceKey} no longer exists in the authority; the removal is not yet observed`,
      };
    if (live !== row.sourceRevision)
      return {
        reason:
          live > row.sourceRevision
            ? 'stale_pending_observation'
            : 'stale_version',
        detail: `${row.sourceKey} is at version ${live}, receipt ${row.id} records ${row.sourceRevision}`,
      };
  }
  if (!freshnessOk)
    return {
      reason: 'evidence_too_old',
      detail: `receipt ${row.id} (${row.sourceKey}) was last confirmed ${row.lastConfirmedAt.toISOString()}`,
    };
  return null;
}

/**
 * Throws SupportError(BlockReason) unless every receipt is `supported`, its
 * recorded revision equals the live version (controlled sources) and its
 * freshness (max(observed_at, last confirmation)) is within the policy age.
 * Returns the examined vector. The error carries the same vector.
 */
export async function assertCurrent(
  client: PgClient,
  receiptIds: readonly ReceiptId[],
  opts: AssertCurrentOptions,
  options?: LedgerOptions,
): Promise<CheckedVector> {
  const ids = [...new Set(receiptIds)];
  if (ids.length === 0) return [];

  // 1. Which sources decide currency?
  const first = await getReceiptRows(client, ids);
  const missing = ids.find((id) => !first.has(id));
  if (missing)
    throw new SupportError(
      'receipt_not_supported',
      `receipt ${missing} does not exist`,
      [],
      missing,
    );
  const controlledKeys = new Set<string>();
  const observedSourceIds = new Set<string>();
  for (const row of first.values()) {
    if (row.authority === 'controlled') controlledKeys.add(row.sourceKey);
    else observedSourceIds.add(row.sourceId);
  }

  // 2. Lock them: controlled rows always (collection first, members by key).
  const live =
    controlledKeys.size > 0
      ? await liveVersion(client, [...controlledKeys], opts.lockMode, options)
      : new Map<string, number | null>();
  await lockSourcesShared(client, [...observedSourceIds]);

  // 3. Read the verdict inputs after the locks.
  const rows = await getReceiptRows(client, ids);
  const heads = await observedHeads(client, [...observedSourceIds]);
  const { rows: clock } = await client.query<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  );
  const now = clock[0].now;

  const checked: CheckedVector = [];
  let failure: { verdict: NonNullable<Verdict>; row: ReceiptRow } | null = null;
  for (const id of ids) {
    const row = rows.get(id);
    if (!row)
      throw new SupportError(
        'receipt_not_supported',
        `receipt ${id} does not exist`,
        checked,
        id,
      );
    const maxAge = opts.freshness?.[row.sourceKey];
    const freshnessOk =
      maxAge === undefined ||
      row.lastConfirmedAt.getTime() >= now.getTime() - maxAge;
    const liveRevision =
      row.authority === 'controlled'
        ? (live.get(row.sourceKey) ?? 0)
        : (heads.get(row.sourceId) ?? row.sourceRevision);
    checked.push({
      sourceKey: row.sourceKey,
      recordedRevision: row.sourceRevision,
      liveRevision,
      receiptStatus: row.status,
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
      freshnessOk,
    });
    if (!failure) {
      const verdict = judge(
        row,
        live.get(row.sourceKey),
        now.getTime(),
        freshnessOk,
      );
      if (verdict) failure = { verdict, row };
    }
  }
  if (failure)
    throw new SupportError(
      failure.verdict.reason,
      failure.verdict.detail,
      checked,
      failure.row.id,
      failure.row.sourceKey,
    );
  return checked;
}

async function observedHeads(
  client: PgClient,
  sourceIds: readonly string[],
): Promise<Map<string, number>> {
  if (sourceIds.length === 0) return new Map();
  const { rows } = await client.query<{ source_id: string; revision: number }>(
    `SELECT source_id, max(source_revision) AS revision
       FROM ledger.observation_receipts
      WHERE source_id = ANY($1::uuid[]) GROUP BY source_id`,
    [sourceIds],
  );
  return new Map(rows.map((row) => [row.source_id, Number(row.revision)]));
}

/** The SupportValidator port bound to this implementation. */
export function createSupportValidator(
  options?: LedgerOptions,
): SupportValidator {
  return {
    assertCurrent: (client, receiptIds, opts) =>
      assertCurrent(client, receiptIds, opts, options),
  };
}

export const supportValidator: SupportValidator = createSupportValidator();
