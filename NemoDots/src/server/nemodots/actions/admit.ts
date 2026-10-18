// Admission transaction (ARCHITECTURE 5.1 "Admission transaction",
// finding C4): proposed -> admitted | blocked, and the re-admission of an
// admitted intent whose dispatcher lease expired (reclaim).
//
//   1. preliminary read (no lock), hook after_preliminary_read
//   2. BEGIN; intent FOR UPDATE; mission FOR SHARE            (coordinator rows)
//   3. controlled config rows FOR SHARE (collection first, members by key)
//   4. every predicate (predicates.ts), the ledger rows via assertCurrent
//   5. admitted: claim the dispatch lease (fence = nextval) + Authorization
//      blocked : Authorization(blocked, reason) + intent blocked
//   6. events; COMMIT
// `admitted` is durable. Between admission and commit the predicates may
// become false; the commit transaction detects exactly that.
import { isMutated } from '../config/mutation.js';
import type {
  ActionId,
  ActionIntent,
  EventPayload,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import type { ActionsDeps } from './deps.js';
import { decidedEvent, flushEvents } from './emit.js';
import { ActionNotFoundError } from './errors.js';
import { evaluate, lockMissionThenIntent } from './predicates.js';
import {
  findIntentRow,
  insertAuthorization,
  plainRead,
  toIntent,
  transition,
  type AuthorizationInput,
} from './rows.js';
import { hook } from './test-hooks.js';

export async function admit(
  deps: ActionsDeps,
  actionId: ActionId | string,
  dispatcher: string,
): Promise<ActionIntent> {
  const preliminary = await plainRead(deps.pool, (client) =>
    findIntentRow(client, actionId),
  );
  if (!preliminary) throw new ActionNotFoundError(actionId);
  await hook('after_preliminary_read', { actionId });

  return withTransaction(deps.pool, async (client, attempt) => {
    await hook('before_lock', { actionId, attempt });
    const { intent, mission } = await lockMissionThenIntent(client, actionId);

    const reclaim =
      intent.status === 'admitted' &&
      intent.dispatcher_lease_expires_at !== null &&
      // MUTATION ignore_fencing: a live lease is re-claimed too.
      (isMutated('ignore_fencing') ||
        (
          await client.query<{ expired: boolean }>(
            'SELECT $1::timestamptz <= clock_timestamp() AS expired',
            [intent.dispatcher_lease_expires_at],
          )
        ).rows[0].expired);
    // Anything but a fresh proposal or an expired admission is a duplicate
    // delivery: the stored decision is returned and nothing is written.
    if (intent.status !== 'proposed' && !reclaim) return toIntent(intent);

    const evaluation = await evaluate(
      client,
      deps.validator,
      intent,
      mission,
      'share',
    );
    const base = {
      actionId: intent.id,
      stage: 'admission' as const,
      checkedVector: evaluation.checked,
      targetVersion: evaluation.targetVersion,
      authorFence: { token: intent.author_fencing_token, valid: true },
      idempotencyBinding: 'same_payload' as const,
    };
    const events: EventPayload[] = [];
    let updated;
    if (!evaluation.ok) {
      const authorization: AuthorizationInput = {
        ...base,
        decision: 'blocked',
        blockReason: evaluation.reason,
        dispatchFence: null,
      };
      await insertAuthorization(client, authorization);
      updated = await transition(client, intent.id, intent.status, 'blocked', {
        blockReason: evaluation.reason!,
        blockDetail: evaluation.detail,
      });
      events.push(decidedEvent(authorization, evaluation.detail));
    } else {
      // The dispatch lease: a fresh fence from the sequence, owner, expiry.
      const lease = await client.query<{ fence: number }>(
        "SELECT nextval('coordinator.action_dispatch_seq')::int AS fence",
      );
      const fence = lease.rows[0].fence;
      const authorization: AuthorizationInput = {
        ...base,
        decision: 'admitted',
        blockReason: null,
        dispatchFence: { token: fence, valid: true },
      };
      await insertAuthorization(client, authorization);
      // The row is locked FOR UPDATE and `reclaim` was computed from the
      // database clock inside this transaction, so no second lease test is
      // needed (now() would be the transaction start and could still show
      // the lease as live).
      updated = reclaim
        ? (
            await client.query(
              `UPDATE coordinator.action_intents
                  SET dispatch_fence = $2, dispatch_owner = $3,
                      dispatcher_lease_expires_at = clock_timestamp() + ($4 || ' milliseconds')::interval,
                      status_version = status_version + 1
                WHERE id = $1 AND status = 'admitted'
                RETURNING *`,
              [intent.id, fence, dispatcher, String(deps.dispatchLeaseMs)],
            )
          ).rows[0]
        : await transition(client, intent.id, 'proposed', 'admitted', {
            set: [
              ['dispatch_fence', fence],
              ['dispatch_owner', dispatcher],
            ],
            setIntervalMs: [
              ['dispatcher_lease_expires_at', deps.dispatchLeaseMs],
            ],
          });
      if (!updated) throw new ActionNotFoundError(actionId);
      events.push(decidedEvent(authorization, null));
    }
    await flushEvents(client, deps, intent.mission_id, events);
    return toIntent(updated);
  });
}
