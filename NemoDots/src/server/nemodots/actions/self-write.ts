// Production adapter of the watcher's SelfWriteIntentPort (watcher/types.ts):
// what the history walk needs to know about an intent (`find`) and the
// idempotent settlement it triggers (`settleFromHistory`). Backed by
// settle.ts; every method is safe under replay of the walk.
import type { ActionId, SourceKey } from '../contracts/index.js';
import type {
  SelfWriteIntent,
  SelfWriteIntentPort,
  SettleFromHistoryInput,
} from '../watcher/types.js';
import type { ActionsDeps } from './deps.js';
import { findResultReceipt, plainRead, findIntentRow } from './rows.js';
import { settleFromHistory, settleMismatch } from './settle.js';

export function createSelfWriteIntents(deps: ActionsDeps): SelfWriteIntentPort {
  return {
    async find(actionId: ActionId): Promise<SelfWriteIntent | null> {
      return plainRead(deps.pool, async (client) => {
        const row = await findIntentRow(client, actionId);
        // only set_config produces a configuration self-write
        if (!row || row.action !== 'set_config') return null;
        const receipt = await findResultReceipt(client, row.id);
        return {
          id: row.id as ActionId,
          sourceKey: (row.target as { sourceKey: string })
            .sourceKey as SourceKey,
          status: row.status,
          expectedAfterDigest: receipt?.controlPlane?.afterDigest ?? null,
        };
      });
    },
    async settleFromHistory(input: SettleFromHistoryInput): Promise<void> {
      if (input.outcome === 'verified')
        await settleFromHistory(deps, input.actionId, {
          afterDigest: input.afterDigest,
          configVersion: input.version,
        });
      else await settleMismatch(deps, input.actionId);
    },
  };
}
