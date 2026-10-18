// settleFromHistory: the watcher's entry into the action boundary
// (ARCHITECTURE.md section 5.4, finding C7).
//
// set_config has no dispatch hop: its effect IS the row update, so `committed`
// already means applied, and verification arrives from the watcher walking
// checkout.config_versions. For every history row that carries a
// caused_by_action_id the watcher calls this function:
//
//   verified  committed -> verified, postcondition kind 'history' with the
//             config version of the row. The history is re-read here: the row
//             must exist for this action and its after-digest must equal the
//             digest the commit recorded, so a wrong claim cannot verify.
//   failed    committed -> failed(postcondition_mismatch |
//             superseded_before_verification).
//
// Repeats are idempotent (the same settlement returns the stored intent); a
// contradicting repeat is refused. When a RecoveryPort is wired, it is told
// about the settlement every time this runs, so a crash between the
// transition and the notification is repaired by the watcher's retry
// (RecoveryPort.onSelfWriteSettled is idempotent per action and outcome).
import type { ActionId, ActionIntent, ReceiptId } from '../contracts/index.js';
import { EventBuffer, createEventSink } from '../coordinator/events.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import { withTransaction } from '../db/tx.js';
import { ActionNotFoundError, SettleRefusedError } from './errors.js';
import {
  claimAuthorizationWriter,
  getResultReceipt,
  insertResultReceipt,
  loadIntent,
  mapIntentRow,
  toIntent,
  type IntentDbRow,
} from './rows.js';
import { configKeyOf } from './policy.js';
import type { ActionDeps } from './types.js';

export type SettleOutcome =
  | 'verified'
  | 'failed'
  | {
      outcome: 'verified';
      /** The config version of the history row (default: the row of this action). */
      configVersion?: number;
      receiptId?: ReceiptId | null;
    }
  | {
      outcome: 'failed';
      reason?: 'postcondition_mismatch' | 'superseded_before_verification';
    };

interface Normalized {
  outcome: 'verified' | 'failed';
  configVersion: number | null;
  receiptId: ReceiptId | null;
  reason: 'postcondition_mismatch' | 'superseded_before_verification';
}

function normalize(outcome: SettleOutcome): Normalized {
  if (typeof outcome === 'string')
    return {
      outcome,
      configVersion: null,
      receiptId: null,
      reason: 'postcondition_mismatch',
    };
  return {
    outcome: outcome.outcome,
    configVersion:
      outcome.outcome === 'verified' ? (outcome.configVersion ?? null) : null,
    receiptId:
      outcome.outcome === 'verified' ? (outcome.receiptId ?? null) : null,
    reason:
      outcome.outcome === 'failed'
        ? (outcome.reason ?? 'postcondition_mismatch')
        : 'postcondition_mismatch',
  };
}

export async function settleFromHistory(
  deps: ActionDeps,
  actionId: ActionId | string,
  outcome: SettleOutcome,
): Promise<ActionIntent> {
  const wanted = normalize(outcome);
  const events = deps.events ?? createEventSink();
  const intent = await withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    const row = await loadIntent(client, actionId, { lock: true });
    if (!row) throw new ActionNotFoundError(actionId);
    if (row.action !== 'set_config')
      throw new SettleRefusedError(
        actionId,
        'only set_config is settled from the history; flushes are reconciled',
      );
    if (row.status === 'verified' || row.status === 'failed') {
      const sameDirection =
        (row.status === 'verified') === (wanted.outcome === 'verified');
      if (!sameDirection)
        throw new SettleRefusedError(
          actionId,
          `already ${row.status}, cannot settle as ${wanted.outcome}`,
        );
      return toIntent(row);
    }
    if (row.status !== 'committed')
      throw new SettleRefusedError(
        actionId,
        `status is ${row.status}, only a committed set_config is settled`,
      );
    const committed = await getResultReceipt(client, actionId, 'committed');
    const controlPlane = committed?.controlPlane;
    if (!controlPlane)
      throw new SettleRefusedError(
        actionId,
        'no committed control-plane receipt',
      );

    let updated: IntentDbRow;
    if (wanted.outcome === 'verified') {
      const history = await client.query<{
        version: string;
        after_digest: string | null;
      }>(
        `SELECT version, after_digest FROM checkout.config_versions
          WHERE key = $1 AND caused_by_action_id = $2`,
        [configKeyOf(row.targetSourceKey), row.id],
      );
      const found = history.rows[0];
      if (!found)
        throw new SettleRefusedError(
          actionId,
          'checkout.config_versions has no row caused by this action',
        );
      if (found.after_digest !== controlPlane.afterDigest)
        throw new SettleRefusedError(
          actionId,
          'the history row does not carry the digest this action committed',
        );
      const version = Number(found.version);
      if (wanted.configVersion !== null && wanted.configVersion !== version)
        throw new SettleRefusedError(
          actionId,
          `the history row of this action is version ${version}, not ${wanted.configVersion}`,
        );
      const result = await client.query<IntentDbRow>(
        `UPDATE coordinator.action_intents
            SET status = 'verified', status_version = status_version + 1,
                verified_at = clock_timestamp()
          WHERE id = $1 AND status = 'committed' RETURNING *`,
        [row.id],
      );
      updated = result.rows[0];
      const postcondition = {
        kind: 'history' as const,
        receiptId: wanted.receiptId,
        configVersion: version,
      };
      await insertResultReceipt(client, {
        intent: row,
        outcome: 'verified',
        controlPlane,
        postcondition,
      });
      buffer.add(row.missionId, {
        kind: 'action.verified',
        actionId: row.id,
        postcondition,
      });
    } else {
      const result = await client.query<IntentDbRow>(
        `UPDATE coordinator.action_intents
            SET status = 'failed', status_version = status_version + 1,
                failure_reason = $2, failed_at = clock_timestamp()
          WHERE id = $1 AND status = 'committed' RETURNING *`,
        [row.id, wanted.reason],
      );
      updated = result.rows[0];
      await insertResultReceipt(client, {
        intent: row,
        outcome: 'failed',
        controlPlane,
      });
      buffer.add(row.missionId, {
        kind: 'action.failed',
        actionId: row.id,
        failureReason: wanted.reason,
        detail:
          wanted.reason === 'postcondition_mismatch'
            ? 'the config history does not match what the action committed'
            : 'a later change superseded the action before it was verified',
      });
    }
    await enqueueOutbox(client, {
      missionId: row.missionId,
      topic: 'mission.evaluate',
      payload: { missionId: row.missionId },
      dedupeKey: `action:${row.id}:settled`,
    });
    await buffer.flush(client);
    return toIntent(mapIntentRow(updated));
  });
  await deps.recovery?.onSelfWriteSettled(
    intent.id,
    intent.status === 'verified' ? 'verified' : 'failed',
  );
  return intent;
}

/** The function the watcher calls: bound to the pool and the RecoveryPort. */
export function createSelfWriteSettler(deps: ActionDeps) {
  return (actionId: ActionId | string, outcome: SettleOutcome) =>
    settleFromHistory(deps, actionId, outcome);
}
