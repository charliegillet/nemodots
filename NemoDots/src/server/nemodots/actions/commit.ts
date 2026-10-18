// Commit transaction (G1, ARCHITECTURE 4 and 5.1 steps 1-10, finding C4).
//
//   preliminary read of the intent (no lock)          hook after_preliminary_read
//   BEGIN                                              hook before_lock
//   2. intent FOR UPDATE. A receipt already exists (committed / dispatched /
//      verified / ...): return it and WRITE NOTHING (C2, duplicate delivery).
//      Not admitted, stale fence or expired dispatcher lease: DispatchFenceError.
//   3. mission FOR SHARE, generation and status
//   4-5. collection row (when the vector holds it) then member rows in key
//      order FOR UPDATE
//   6. EVERY admission predicate again, ledger rows via assertCurrent('update')
//      -> blocked: Authorization(blocked) + intent blocked, COMMIT, return
//   7-8. advanceConfig(causedBy {action, actionId}): CAS on the version, the
//      config_versions row with before/after digests
//   9. result_receipts, intent admitted -> committed (CAS on the fence), the
//      commit Authorization, outbox, events                hook after_lock_before_commit
//   10. COMMIT (advanceConfig issued pg_notify('nemodots_source_changed'))
//
// A flush mutates nothing in PostgreSQL: the commit records the desired state
// and the target version the dispatch CAS will check (C11).
import type {
  ActionId,
  ActionIntent,
  EventPayload,
  ResultReceipt,
  SetConfigPayload,
} from '../contracts/index.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import { withTransaction } from '../db/tx.js';
import { advanceConfig, isStaleVersion } from '../sandbox/version-authority.js';
import type { ActionsDeps } from './deps.js';
import { decidedEvent, flushEvents } from './emit.js';
import { ActionNotFoundError, DispatchFenceError } from './errors.js';
import { evaluate, lockMissionThenIntent } from './predicates.js';
import { isExternalEffect } from './policy.js';
import {
  findIntentRow,
  findResultReceipt,
  insertAuthorization,
  insertResultReceipt,
  plainRead,
  toIntent,
  transition,
  type AuthorizationInput,
} from './rows.js';
import { hook } from './test-hooks.js';

export interface CommitResult {
  intent: ActionIntent;
  /** null when the intent was blocked. */
  receipt: ResultReceipt | null;
  /** true when this call was a duplicate delivery and wrote nothing. */
  replayed: boolean;
}

export const ACTION_DISPATCH_TOPIC = 'action.dispatch';

export async function commit(
  deps: ActionsDeps,
  actionId: ActionId | string,
  dispatchFence: number,
): Promise<CommitResult> {
  const preliminary = await plainRead(deps.pool, (client) =>
    findIntentRow(client, actionId),
  );
  if (!preliminary) throw new ActionNotFoundError(actionId);
  await hook('after_preliminary_read', { actionId });

  const result = await withTransaction(deps.pool, async (client, attempt) => {
    await hook('before_lock', { actionId, attempt });
    const { intent, mission } = await lockMissionThenIntent(client, actionId);

    // C2: duplicate delivery returns the stored receipt and writes nothing.
    const stored = await findResultReceipt(client, intent.id);
    if (stored)
      return { intent: toIntent(intent), receipt: stored, replayed: true };

    // A blocked intent has no receipt: the stored decision is the answer.
    if (intent.status === 'blocked')
      return { intent: toIntent(intent), receipt: null, replayed: true };
    if (intent.status !== 'admitted')
      throw new DispatchFenceError(
        intent.id,
        'not_admitted',
        `intent is ${intent.status}`,
      );
    if (intent.dispatch_fence !== dispatchFence)
      throw new DispatchFenceError(
        intent.id,
        'fence_mismatch',
        `fence ${dispatchFence}, stored ${intent.dispatch_fence}`,
      );
    const lease = await client.query<{ expired: boolean }>(
      'SELECT $1::timestamptz <= clock_timestamp() AS expired',
      [intent.dispatcher_lease_expires_at],
    );
    if (lease.rows[0].expired)
      throw new DispatchFenceError(intent.id, 'lease_expired');

    const evaluation = await evaluate(
      client,
      deps.validator,
      intent,
      mission,
      'update',
    );
    const base = {
      actionId: intent.id,
      stage: 'commit' as const,
      checkedVector: evaluation.checked,
      targetVersion: evaluation.targetVersion,
      authorFence: { token: intent.author_fencing_token, valid: true },
      dispatchFence: { token: dispatchFence, valid: true },
      idempotencyBinding: 'same_payload' as const,
    };
    const events: EventPayload[] = [];

    const block = async (
      reason: NonNullable<typeof evaluation.reason>,
      detail: string,
    ) => {
      const authorization: AuthorizationInput = {
        ...base,
        decision: 'blocked',
        blockReason: reason,
      };
      await insertAuthorization(client, authorization);
      const updated = await transition(
        client,
        intent.id,
        'admitted',
        'blocked',
        {
          blockReason: reason,
          blockDetail: detail,
          dispatchFence,
        },
      );
      events.push(decidedEvent(authorization, detail));
      await flushEvents(client, deps, intent.mission_id, events);
      return { intent: toIntent(updated), receipt: null, replayed: false };
    };

    if (!evaluation.ok) return block(evaluation.reason!, evaluation.detail!);

    let controlPlane: ResultReceipt['controlPlane'] = null;
    let committedTargetVersion = evaluation.targetVersion.live;
    if (intent.action === 'set_config') {
      const payload = intent.payload as unknown as SetConfigPayload;
      let advanced;
      try {
        advanced = await advanceConfig(client, {
          key: payload.key,
          value: payload.value,
          expectedVersion: intent.expected_target_version,
          causedBy: { actor: 'action', actionId: intent.id },
        });
      } catch (error) {
        if (isStaleVersion(error))
          return block('stale_version', 'the target version moved');
        throw error;
      }
      committedTargetVersion = advanced.versionAfter;
      controlPlane = {
        targetVersionBefore: advanced.versionBefore,
        targetVersionAfter: advanced.versionAfter,
        causedByActionId: intent.id as ActionId,
        beforeDigest: advanced.beforeDigest as string,
        afterDigest: advanced.afterDigest as string,
      };
    }

    const receipt = await insertResultReceipt(client, {
      actionId: intent.id,
      idempotencyKey: intent.idempotency_key,
      payloadHash: intent.payload_hash,
      outcome: 'committed',
      controlPlane,
    });
    const updated = await transition(
      client,
      intent.id,
      'admitted',
      'committed',
      {
        dispatchFence,
        set: [['committed_target_version', committedTargetVersion]],
      },
    );
    const authorization: AuthorizationInput = {
      ...base,
      decision: 'committed',
      blockReason: null,
    };
    await insertAuthorization(client, authorization);
    events.push(decidedEvent(authorization, null));
    if (controlPlane)
      events.push({
        kind: 'action.committed',
        actionId: intent.id,
        targetVersionBefore: controlPlane.targetVersionBefore,
        targetVersionAfter: controlPlane.targetVersionAfter,
        causedByActionId: intent.id,
        afterDigest: controlPlane.afterDigest,
      } as unknown as EventPayload);
    await enqueueOutbox(client, {
      missionId: intent.mission_id,
      topic: isExternalEffect(intent.action as 'set_config')
        ? ACTION_DISPATCH_TOPIC
        : 'action.committed',
      payload: { actionId: intent.id, missionId: intent.mission_id },
      dedupeKey: `action.committed:${intent.id}`,
    });
    await hook('after_lock_before_commit', { actionId, attempt });
    await flushEvents(client, deps, intent.mission_id, events);
    return { intent: toIntent(updated), receipt, replayed: false };
  });

  if (!result.replayed && result.intent.status === 'committed')
    await hook('after_commit_before_dispatch', { actionId });
  return result;
}
