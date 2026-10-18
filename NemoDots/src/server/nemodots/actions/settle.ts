// Settlement of a committed set_config from the version history (ARCHITECTURE
// 5.4, finding C7). The watcher walks config_versions rows r+1..r+n and calls
// this for every row carrying a caused_by_action_id; the postcondition is the
// recorded after-digest of the commit, compared with what the history shows.
import type {
  ActionId,
  ActionIntent,
  EventPayload,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import type { ActionsDeps } from './deps.js';
import { flushEvents } from './emit.js';
import {
  findResultReceipt,
  getIntentRow,
  toIntent,
  transition,
  updateResultReceipt,
} from './rows.js';

/** committed -> verified when the observed after-digest is the committed one, else failed(postcondition_mismatch). */
export async function settleFromHistory(
  deps: ActionsDeps,
  actionId: ActionId | string,
  observed: { afterDigest: string | null; configVersion: number },
): Promise<ActionIntent> {
  return withTransaction(deps.pool, async (client) => {
    const row = await getIntentRow(client, actionId, 'update');
    if (row.status !== 'committed' && row.status !== 'outcome_unknown')
      return toIntent(row);
    const receipt = await findResultReceipt(client, row.id);
    const expected = receipt?.controlPlane?.afterDigest ?? null;
    const events: EventPayload[] = [];
    let updated;
    if (expected !== null && expected === observed.afterDigest) {
      const postcondition = {
        kind: 'history' as const,
        receiptId: null,
        configVersion: observed.configVersion,
      };
      updated = await transition(client, row.id, row.status, 'verified');
      await updateResultReceipt(client, row.id, {
        outcome: 'verified',
        postcondition,
      });
      events.push({
        kind: 'action.verified',
        actionId: row.id,
        postcondition,
      } as unknown as EventPayload);
    } else {
      updated = await transition(client, row.id, row.status, 'failed', {
        failureReason: 'postcondition_mismatch',
      });
      await updateResultReceipt(client, row.id, { outcome: 'failed' });
      events.push({
        kind: 'action.failed',
        actionId: row.id,
        failureReason: 'postcondition_mismatch',
        detail:
          'the after-digest in the version history is not the committed one',
      } as unknown as EventPayload);
    }
    await flushEvents(client, deps, row.mission_id, events);
    return toIntent(updated);
  });
}

/** The history never showed this commit's own row: failed(superseded_before_verification). */
export async function settleSuperseded(
  deps: ActionsDeps,
  actionId: ActionId | string,
): Promise<ActionIntent> {
  return withTransaction(deps.pool, async (client) => {
    const row = await getIntentRow(client, actionId, 'update');
    if (row.status !== 'committed') return toIntent(row);
    const updated = await transition(client, row.id, 'committed', 'failed', {
      failureReason: 'superseded_before_verification',
    });
    await updateResultReceipt(client, row.id, { outcome: 'failed' });
    await flushEvents(client, deps, row.mission_id, [
      {
        kind: 'action.failed',
        actionId: row.id,
        failureReason: 'superseded_before_verification',
        detail: null,
      } as unknown as EventPayload,
    ]);
    return toIntent(updated);
  });
}

/** The history showed a different after-digest: committed -> failed(postcondition_mismatch). */
export async function settleMismatch(
  deps: ActionsDeps,
  actionId: ActionId | string,
): Promise<ActionIntent> {
  return withTransaction(deps.pool, async (client) => {
    const row = await getIntentRow(client, actionId, 'update');
    if (row.status !== 'committed' && row.status !== 'outcome_unknown')
      return toIntent(row);
    const updated = await transition(client, row.id, row.status, 'failed', {
      failureReason: 'postcondition_mismatch',
    });
    await updateResultReceipt(client, row.id, { outcome: 'failed' });
    await flushEvents(client, deps, row.mission_id, [
      {
        kind: 'action.failed',
        actionId: row.id,
        failureReason: 'postcondition_mismatch',
        detail:
          'the after-digest in the version history is not the committed one',
      } as unknown as EventPayload,
    ]);
    return toIntent(updated);
  });
}
