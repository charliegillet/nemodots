// Self-write classification from the config_versions HISTORY (ARCHITECTURE
// 5.4, finding C7). When the watcher meets head version r+n while the ledger's
// current receipt is r, it reads rows r+1..r+n in order. Every row carrying a
// server-authored caused_by_action_id settles that intent through the actions
// package (after_digest == expected -> verified, else failed(postcondition_
// mismatch)) and the coordinator is told. The receipt the watcher registers
// takes its `selfWrite` from the LAST row only: a later injector or owner write
// makes the head `none`, so the full invalidation reaches the acting lineage.
import type {
  ActionId,
  PgClient,
  RecoveryPort,
  SelfWrite,
  SourceKey,
} from '../contracts/index.js';
import type { SelfWriteIntentPort, WatcherLogEntry } from './types.js';

export interface HistoryRow {
  version: number;
  actionId: string | null;
  afterDigest: string | null;
}

/** Rows (fromExclusive, toInclusive] of one key. Never selects the writer's actor. */
export async function readHistory(
  client: PgClient,
  member: string,
  fromExclusive: number,
  toInclusive: number,
): Promise<HistoryRow[]> {
  const { rows } = await client.query<{
    version: string | number;
    caused_by_action_id: string | null;
    after_digest: string | null;
  }>(
    `SELECT version, caused_by_action_id, after_digest
       FROM checkout.config_versions
      WHERE key = $1 AND version > $2 AND version <= $3
      ORDER BY version`,
    [member, fromExclusive, toInclusive],
  );
  return rows.map((row) => ({
    version: Number(row.version),
    actionId: row.caused_by_action_id,
    afterDigest: row.after_digest,
  }));
}

export interface SelfWriteClassification {
  selfWrite: SelfWrite;
  causedByActionId: ActionId | null;
  /** Every action settled by this walk, in history order. */
  settled: { actionId: ActionId; outcome: 'verified' | 'failed' }[];
}

export interface ClassifyDeps {
  intents?: SelfWriteIntentPort;
  recovery: RecoveryPort;
  log: (entry: WatcherLogEntry) => void;
}

export const NO_SELF_WRITE: SelfWriteClassification = Object.freeze({
  selfWrite: 'none',
  causedByActionId: null,
  settled: [],
}) as SelfWriteClassification;

/**
 * Settles every action row of the walk and derives the head's classification.
 * Settlement runs BEFORE the receipt is registered and is idempotent, so a
 * crash in between replays the same walk (the ledger still lags the head).
 */
export async function classifyHistory(
  deps: ClassifyDeps,
  sourceKey: SourceKey,
  rows: readonly HistoryRow[],
): Promise<SelfWriteClassification> {
  if (!deps.intents || rows.length === 0) return NO_SELF_WRITE;
  const settled: SelfWriteClassification['settled'] = [];
  let last: SelfWriteClassification = NO_SELF_WRITE;
  for (const row of rows) {
    last = { ...NO_SELF_WRITE, settled };
    if (!row.actionId) continue;
    const actionId = row.actionId as ActionId;
    const intent = await deps.intents.find(actionId);
    if (!intent) {
      // Cannot happen by construction (every commit writes the intent first);
      // fail closed: unknown rows excuse nothing.
      deps.log({
        event: 'unknown_action',
        sourceKey,
        revision: row.version,
      });
      continue;
    }
    const matches =
      intent.sourceKey === sourceKey &&
      intent.expectedAfterDigest !== null &&
      row.afterDigest === intent.expectedAfterDigest;
    const outcome = matches ? 'verified' : 'failed';
    await deps.intents.settleFromHistory({
      actionId,
      outcome,
      reason: matches ? null : 'postcondition_mismatch',
      sourceKey,
      version: row.version,
      afterDigest: row.afterDigest,
    });
    await deps.recovery.onSelfWriteSettled(actionId, outcome);
    settled.push({ actionId, outcome });
    last = {
      selfWrite: matches ? 'verified' : 'mismatch',
      causedByActionId: actionId,
      settled,
    };
  }
  return { ...last, settled };
}
