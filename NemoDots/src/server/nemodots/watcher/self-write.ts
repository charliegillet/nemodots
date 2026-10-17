import type {
  ActionId,
  PgClient,
  SelfWrite,
} from '../contracts/index.js';
import { checkoutSchema, type LedgerOptions } from '../ledger/index.js';
import {
  memberSourceKey,
  type HeadRow,
} from './sources.js';
import type {
  ExpectedWrite,
  IntentSettlementPort,
  WatcherEvent,
  WatcherRecovery,
} from './types.js';

// Self-write classification against the config_versions HISTORY (ARCHITECTURE
// 5.4, finding C7). When the watcher observes head version r+n of a key while
// the ledger's newest receipt is r, it reads the rows r+1..r+n in order. Every
// row that carries a caused_by_action_id settles that intent
// (`after_digest == expected` -> verified, otherwise failed); the receipt it
// registers carries the classification of the LAST row. A later injector or
// owner write therefore cannot hide an earlier action's row, and an action's row
// cannot make a later foreign write look like a self-write.
//
// Only the columns needed for this decision are selected. The actor column is
// never read: injector and owner writes are told apart from actions by the
// absence of caused_by_action_id (which the database nulls for every role but
// nemodots_app), so no actor name can reach a receipt, an event or a log.

export interface HistoryRow {
  version: number;
  afterDigest: string | null;
  causedByActionId: ActionId | null;
}

export async function readHistory(
  client: PgClient,
  key: string,
  afterVersion: number,
  upToVersion: number,
  options?: LedgerOptions,
): Promise<HistoryRow[]> {
  const schema = checkoutSchema(options);
  const { rows } = await client.query<{
    version: string;
    after_digest: string | null;
    caused_by_action_id: ActionId | null;
  }>(
    `SELECT version, after_digest, caused_by_action_id
       FROM ${schema}.config_versions
      WHERE key = $1 AND version > $2 AND version <= $3
      ORDER BY version`,
    [key, afterVersion, upToVersion],
  );
  return rows.map((row) => ({
    version: Number(row.version),
    afterDigest: row.after_digest,
    causedByActionId: row.caused_by_action_id,
  }));
}

export interface Settlement {
  actionId: ActionId;
  /** Version of the history row that carried the action. */
  version: number;
  outcome: 'verified' | 'failed';
  /** The intent already left `committed`; nothing to call. */
  alreadySettled: boolean;
}

export interface Classification {
  /** Classification of the LAST row (what the head receipt carries). */
  selfWrite: SelfWrite;
  causedByActionId: ActionId | null;
  /** In history order. */
  settlements: Settlement[];
  /** The history is missing a version in r+1..r+n; classification fails closed to `none`. */
  gap: boolean;
}

function outcomeOf(
  key: string,
  row: HistoryRow,
  expected: ExpectedWrite,
): 'verified' | 'failed' {
  return expected.key === key &&
    row.afterDigest !== null &&
    row.afterDigest === expected.afterDigest
    ? 'verified'
    : 'failed';
}

/**
 * Pure classification of the history rows (r, head]. `expected` holds what the
 * actions package knows about the intents named by the rows; an action id it
 * does not know is not a recognised self-write (full invalidation, nothing to
 * settle).
 */
export function classifyHistory(input: {
  key: string;
  ledgerRevision: number;
  headVersion: number;
  rows: readonly HistoryRow[];
  expected: ReadonlyMap<string, ExpectedWrite>;
}): Classification {
  const { key, ledgerRevision, headVersion, rows, expected } = input;
  const gap =
    headVersion > ledgerRevision &&
    (rows.length !== headVersion - ledgerRevision ||
      rows.some((row, i) => row.version !== ledgerRevision + 1 + i));
  const settlements: Settlement[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.causedByActionId) continue;
    const known = expected.get(row.causedByActionId);
    if (!known || seen.has(row.causedByActionId)) continue;
    seen.add(row.causedByActionId);
    settlements.push({
      actionId: row.causedByActionId,
      version: row.version,
      outcome: outcomeOf(key, row, known),
      alreadySettled: known.settled,
    });
  }
  const last = rows.at(-1);
  if (gap || !last || last.version !== headVersion || !last.causedByActionId)
    return { selfWrite: 'none', causedByActionId: null, settlements, gap };
  const lastSettlement = settlements.find(
    (item) => item.actionId === last.causedByActionId,
  );
  if (!lastSettlement)
    return { selfWrite: 'none', causedByActionId: null, settlements, gap };
  return {
    selfWrite: lastSettlement.outcome === 'verified' ? 'verified' : 'mismatch',
    causedByActionId: last.causedByActionId,
    settlements,
    gap,
  };
}

/**
 * Reads the history range and classifies it. `ledgerRevision` is the newest
 * receipt revision of the source in the ledger (0 when there is none).
 */
export async function walkHistory(
  client: PgClient,
  intents: IntentSettlementPort,
  input: {
    key: string;
    ledgerRevision: number;
    headVersion: number;
    ledger?: LedgerOptions;
  },
): Promise<Classification> {
  if (input.headVersion <= input.ledgerRevision)
    return { selfWrite: 'none', causedByActionId: null, settlements: [], gap: false };
  const rows = await readHistory(
    client,
    input.key,
    input.ledgerRevision,
    input.headVersion,
    input.ledger,
  );
  const ids = [
    ...new Set(
      rows.flatMap((row) => (row.causedByActionId ? [row.causedByActionId] : [])),
    ),
  ];
  const expected = ids.length
    ? await intents.expectedWrites(ids)
    : new Map<string, ExpectedWrite>();
  return classifyHistory({
    key: input.key,
    ledgerRevision: input.ledgerRevision,
    headVersion: input.headVersion,
    rows,
    expected,
  });
}

type Emit = (event: WatcherEvent) => void;

/**
 * Calls RecoveryPort.onSelfWriteSettled for every settlement that is not
 * recorded yet. The port is idempotent per action (a second call for a settled
 * intent is a no-op), so a retry after a crash is safe. A failing call is
 * reported and left for sweepSettlements(), which finds every committed intent
 * that is still unsettled.
 */
export async function applySettlements(
  recovery: Pick<WatcherRecovery, 'onSelfWriteSettled'>,
  settlements: readonly Settlement[],
  emit: Emit,
): Promise<{ actionId: string; outcome: 'verified' | 'failed' }[]> {
  const done: { actionId: string; outcome: 'verified' | 'failed' }[] = [];
  for (const settlement of settlements) {
    if (settlement.alreadySettled) continue;
    try {
      await recovery.onSelfWriteSettled(settlement.actionId, settlement.outcome);
      done.push({ actionId: settlement.actionId, outcome: settlement.outcome });
      emit({
        type: 'self_write_settled',
        actionId: settlement.actionId,
        outcome: settlement.outcome,
      });
    } catch (error) {
      emit({
        type: 'error',
        where: 'onSelfWriteSettled',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return done;
}

/**
 * Settles committed intents the history walk did not (the ledger's receipt had
 * already moved past their row: a tool registered the revision first, or a
 * settlement call failed earlier). A row whose version is still ABOVE the
 * ledger's newest revision is left to the walk, so the walk's receipt can carry
 * the classification.
 */
export async function sweepSettlements(
  client: PgClient,
  deps: {
    intents: IntentSettlementPort;
    recovery: Pick<WatcherRecovery, 'onSelfWriteSettled'>;
    heads: ReadonlyMap<string, HeadRow>;
    ledger?: LedgerOptions;
    emit: Emit;
  },
): Promise<{ actionId: string; outcome: 'verified' | 'failed' }[]> {
  const awaiting = await deps.intents.awaitingSettlement();
  if (awaiting.length === 0) return [];
  const schema = checkoutSchema(deps.ledger);
  const settlements: Settlement[] = [];
  for (const write of awaiting) {
    const { rows } = await client.query<{
      version: string;
      after_digest: string | null;
    }>(
      `SELECT version, after_digest FROM ${schema}.config_versions
        WHERE key = $1 AND caused_by_action_id = $2
        ORDER BY version DESC LIMIT 1`,
      [write.key, write.actionId],
    );
    const row = rows[0];
    if (!row) continue;
    const version = Number(row.version);
    const ledgerRevision =
      deps.heads.get(memberSourceKey(write.key))?.revision ?? 0;
    if (version > ledgerRevision) continue;
    settlements.push({
      actionId: write.actionId,
      version,
      outcome:
        row.after_digest !== null && row.after_digest === write.afterDigest
          ? 'verified'
          : 'failed',
      alreadySettled: false,
    });
  }
  return applySettlements(deps.recovery, settlements, deps.emit);
}
