// The admission transaction (ARCHITECTURE.md section 5.1, finding C4):
// `proposed -> admitted | blocked`, and re-admission of an `admitted` intent
// whose dispatcher lease expired.
//
//   BEGIN
//   intent FOR UPDATE           (duplicate deliveries serialise here)
//   mission FOR SHARE           (a cancel/pause waits; generation compared)
//   controlled rows FOR SHARE   (collection first, members in key order)
//   every G1 predicate          (evaluatePredicates; incl. freshness)
//   dispatch lease claim        (dispatch_fence = nextval, lease = now + lease)
//   Authorization(stage 'admission')   admitted | blocked
//   COMMIT
//
// `admitted` is durable. Between admission and commit any predicate may become
// false; the commit transaction re-runs all of them, so nothing here is relied
// on at commit time (a stale admission is detected, not trusted).
// No LLM, Redis or HTTP call happens inside the transaction.
import type { ActionIntent } from '../contracts/index.js';
import { EventBuffer, createEventSink } from '../coordinator/events.js';
import { withTransaction } from '../db/tx.js';
import { blockIntent, decidedEvent, lockMissionShared } from './decision.js';
import { ActionNotFoundError } from './errors.js';
import { evaluatePredicates } from './predicates.js';
import {
  claimAuthorizationWriter,
  insertAuthorization,
  loadIntent,
  mapIntentRow,
  toIntent,
  type IntentDbRow,
} from './rows.js';
import { barrier } from './test-hooks.js';
import { leaseMs, type ActionDeps } from './types.js';

export type AdmitDisposition =
  /** proposed (or re-admitted) -> admitted by this call */
  | 'admitted'
  /** blocked by this call */
  | 'blocked'
  /** nothing to do: already admitted under a live lease, or past admission */
  | 'unchanged';

export interface AdmitResult {
  intent: ActionIntent;
  disposition: AdmitDisposition;
}

export async function admitIntentDetailed(
  deps: ActionDeps,
  actionId: string,
  dispatcher: string,
): Promise<AdmitResult> {
  if (!dispatcher) throw new RangeError('a dispatcher id is required');
  const events = deps.events ?? createEventSink();
  // The non-locking read: it decides nothing, it only fails fast on an unknown id.
  const prelim = await loadIntent(deps.pool, actionId);
  if (!prelim) throw new ActionNotFoundError(actionId);
  await barrier('after_preliminary_read', { actionId, stage: 'admit' });

  return withTransaction(deps.pool, async (client): Promise<AdmitResult> => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    await barrier('before_lock', { actionId, stage: 'admit' });

    const row = await loadIntent(client, actionId, { lock: true });
    if (!row) throw new ActionNotFoundError(actionId);
    // Redelivery: already admitted under a live lease, or past admission.
    if (row.status === 'admitted' && row.leaseValid)
      return { intent: toIntent(row), disposition: 'unchanged' };
    if (row.status !== 'proposed' && row.status !== 'admitted')
      return { intent: toIntent(row), disposition: 'unchanged' };

    const mission = await lockMissionShared(client, row.missionId);
    if (!mission) throw new Error(`mission ${row.missionId} does not exist`);
    const verdict = await evaluatePredicates(client, row, mission, {
      lockMode: 'share',
      ledger: deps.ledger,
    });

    if (!verdict.ok) {
      const blocked = await blockIntent(client, buffer, row, {
        stage: 'admission',
        reason: verdict.reason!,
        detail: verdict.detail,
        checkedVector: verdict.checkedVector,
        targetLive: verdict.targetLive,
      });
      await buffer.flush(client);
      return { intent: toIntent(blocked), disposition: 'blocked' };
    }

    const claimed = await client.query<IntentDbRow>(
      `UPDATE coordinator.action_intents
          SET status = 'admitted', status_version = status_version + 1,
              dispatch_fence = nextval('coordinator.action_dispatch_seq'),
              dispatch_owner = $2,
              dispatcher_lease_expires_at =
                clock_timestamp() + $3 * interval '1 millisecond',
              admitted_at = COALESCE(admitted_at, clock_timestamp())
        WHERE id = $1 AND status = $4 AND status_version = $5
        RETURNING *`,
      [row.id, dispatcher, leaseMs(deps), row.status, row.statusVersion],
    );
    if (claimed.rows.length !== 1)
      throw new Error(`action ${row.id} changed while it was being admitted`);
    const admitted = mapIntentRow(claimed.rows[0]);
    const authorization = await insertAuthorization(client, {
      actionId: row.id,
      stage: 'admission',
      decision: 'admitted',
      blockReason: null,
      checkedVector: verdict.checkedVector,
      targetVersion: {
        expected: row.expectedTargetVersion,
        live: verdict.targetLive,
      },
      authorFence: { token: row.authorFencingToken, valid: true },
      dispatchFence: { token: admitted.dispatchFence!, valid: true },
      idempotencyBinding: 'new',
    });
    buffer.add(row.missionId, decidedEvent(authorization, null));
    await buffer.flush(client);
    return { intent: toIntent(admitted), disposition: 'admitted' };
  });
}

export async function admitIntent(
  deps: ActionDeps,
  actionId: string,
  dispatcher: string,
): Promise<ActionIntent> {
  return (await admitIntentDetailed(deps, actionId, dispatcher)).intent;
}
