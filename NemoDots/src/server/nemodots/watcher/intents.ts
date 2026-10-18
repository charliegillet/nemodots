import type { PgClient } from '../contracts/index.js';
import { SetConfigPayloadSchema, type ActionId } from '../contracts/index.js';
import { coordinatorSchema, type LedgerOptions } from '../ledger/index.js';
import { configValueDigest } from '../sandbox/version-authority.js';
import type { ExpectedWrite, IntentSettlementPort } from './types.js';

// IntentSettlementPort over `coordinator.action_intents` (migration 0005), read
// only. The actions package owns the table and settles intents; the watcher
// needs two facts per set_config intent: which value it meant to write (its
// digest is what the history row's after_digest must equal) and whether it still
// waits for settlement (`committed`). A payload that does not parse as a
// set_config payload is not a self-write the watcher recognises.

interface IntentRow {
  id: ActionId;
  status: string;
  payload: unknown;
}

function toExpected(row: IntentRow): ExpectedWrite | null {
  const payload = SetConfigPayloadSchema.safeParse(row.payload);
  if (!payload.success) return null;
  return {
    actionId: row.id,
    key: payload.data.key,
    afterDigest: configValueDigest(payload.data.value),
    settled: row.status !== 'committed',
  };
}

export function createSqlIntentSettlement(deps: {
  /** nemodots_app pool (SELECT on coordinator.action_intents). */
  pool: { query: PgClient['query'] };
  ledger?: LedgerOptions;
}): IntentSettlementPort {
  const schema = coordinatorSchema(deps.ledger);
  return {
    async expectedWrites(actionIds) {
      const found = new Map<string, ExpectedWrite>();
      if (actionIds.length === 0) return found;
      const { rows } = await deps.pool.query<IntentRow>(
        `SELECT id, status, payload FROM ${schema}.action_intents
          WHERE id = ANY($1::uuid[]) AND action = 'set_config'`,
        [[...new Set(actionIds)]],
      );
      for (const row of rows) {
        const expected = toExpected(row);
        if (expected) found.set(row.id, expected);
      }
      return found;
    },
    async awaitingSettlement() {
      const { rows } = await deps.pool.query<IntentRow>(
        `SELECT id, status, payload FROM ${schema}.action_intents
          WHERE action = 'set_config' AND status = 'committed' ORDER BY committed_at, id`,
      );
      return rows.flatMap((row) => {
        const expected = toExpected(row);
        return expected ? [expected] : [];
      });
    },
  };
}
