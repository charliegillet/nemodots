// The commit transaction (ARCHITECTURE.md section 5.1 steps 1-10, guarantee G1).
//
//   1. BEGIN
//   2. intent FOR UPDATE. committed | dispatched | verified (or any intent with
//      a stored `committed` result): return the stored ResultReceipt and write
//      NOTHING, no Authorization (duplicate delivery, C2). Not admitted, a
//      dispatch fence different from the caller's, or an expired dispatcher
//      lease: DispatchFenceError, nothing written, the intent stays claimable.
//   3. mission FOR SHARE, generation compared (C12).
//   4-5. collection row first (when the vector has it), then member rows in key
//      order, FOR UPDATE: the vector's member keys and the target.
//   6. every G1 predicate re-run against the locked rows (evaluatePredicates).
//      A failure writes Authorization(blocked), moves admitted -> blocked,
//      COMMITs the decision and returns the blocked intent.
//   7-8. set_config: sandbox/version-authority.ts::advanceConfig (the only
//      writer of config_entries) with causedBy {actor: 'action', actionId}:
//      value, version + 1 and the config_versions row (before/after digests).
//      flush_cache_namespace has no control-plane write; the effect is
//      dispatched later (dispatch.ts).
//   9. result receipt, Authorization(commit), intent admitted -> committed
//      (CAS on status and dispatch fence), outbox hint, events.
//   10. advanceConfig's pg_notify('nemodots_source_changed') is delivered on COMMIT.
//
// Nothing in the transaction touches the LLM, Redis or HTTP. 40001/40P01 are
// retried by withTransaction (bounded). The barrier after_lock_before_commit
// sits after the last write and before COMMIT, with every lock still held.
import type {
  ActionIntent,
  ResultReceipt,
  SetConfigPayload,
} from '../contracts/index.js';
import { EventBuffer, createEventSink } from '../coordinator/events.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import { withTransaction } from '../db/tx.js';
import {
  ConfigVersionError,
  advanceConfig,
} from '../sandbox/version-authority.js';
import { blockIntent, decidedEvent, lockMissionShared } from './decision.js';
import { ActionNotFoundError, DispatchFenceError } from './errors.js';
import { evaluatePredicates } from './predicates.js';
import { parsePayload } from './policy.js';
import {
  claimAuthorizationWriter,
  getResultReceipt,
  insertAuthorization,
  insertResultReceipt,
  loadIntent,
  mapIntentRow,
  toIntent,
  type IntentDbRow,
} from './rows.js';
import { barrier } from './test-hooks.js';
import type { ActionDeps } from './types.js';

export type CommitDisposition =
  /** this call performed the commit */
  | 'committed'
  /** duplicate delivery: the stored receipt was returned, nothing was written */
  | 'duplicate'
  /** this call blocked the intent at commit */
  | 'blocked'
  /** the intent is already blocked / failed / cancelled (nothing written) */
  | 'terminal';

export interface CommitResult {
  intent: ActionIntent;
  /** The `committed` ResultReceipt (identical for every caller of one action). */
  receipt: ResultReceipt | null;
  disposition: CommitDisposition;
}

const COMMITTED_OR_LATER = new Set([
  'committed',
  'dispatched',
  'verified',
  'outcome_unknown',
]);

export async function commitIntentDetailed(
  deps: ActionDeps,
  actionId: string,
  dispatchFence: number,
): Promise<CommitResult> {
  const events = deps.events ?? createEventSink();
  // The non-locking read decides nothing.
  const prelim = await loadIntent(deps.pool, actionId);
  if (!prelim) throw new ActionNotFoundError(actionId);
  await barrier('after_preliminary_read', { actionId, stage: 'commit' });

  const result = await withTransaction(
    deps.pool,
    async (client): Promise<CommitResult> => {
      const buffer = new EventBuffer(events);
      await claimAuthorizationWriter(client);
      await barrier('before_lock', { actionId, stage: 'commit' });

      // Step 2.
      const row = await loadIntent(client, actionId, { lock: true });
      if (!row) throw new ActionNotFoundError(actionId);
      const stored = await getResultReceipt(client, actionId, 'committed');
      if (stored || COMMITTED_OR_LATER.has(row.status))
        return {
          intent: toIntent(row),
          receipt: stored,
          disposition: 'duplicate',
        };
      if (
        row.status === 'blocked' ||
        row.status === 'failed' ||
        row.status === 'cancelled'
      )
        return {
          intent: toIntent(row),
          receipt: null,
          disposition: 'terminal',
        };
      if (row.status !== 'admitted')
        throw new DispatchFenceError(actionId, 'not_admitted', row.status);
      if (row.dispatchFence !== dispatchFence)
        throw new DispatchFenceError(
          actionId,
          'fence_mismatch',
          row.status,
          `caller fence ${dispatchFence}, stored ${row.dispatchFence}`,
        );
      if (!row.leaseValid)
        throw new DispatchFenceError(actionId, 'lease_expired', row.status);

      // Step 3.
      const mission = await lockMissionShared(client, row.missionId);
      if (!mission) throw new Error(`mission ${row.missionId} does not exist`);

      // Steps 4-6.
      const verdict = await evaluatePredicates(client, row, mission, {
        lockMode: 'update',
        ledger: deps.ledger,
      });
      const block = async (
        reason: NonNullable<typeof verdict.reason>,
        detail: string | null,
      ): Promise<CommitResult> => {
        const blocked = await blockIntent(client, buffer, row, {
          stage: 'commit',
          reason,
          detail,
          checkedVector: verdict.checkedVector,
          targetLive: verdict.targetLive,
        });
        await buffer.flush(client);
        return {
          intent: toIntent(blocked),
          receipt: null,
          disposition: 'blocked',
        };
      };
      if (!verdict.ok) return block(verdict.reason!, verdict.detail);

      // Steps 7-8.
      let controlPlane: ResultReceipt['controlPlane'] = null;
      let committedVersion = verdict.targetLive;
      if (row.action === 'set_config') {
        const payload = parsePayload(row.action, row.payload)!
          .payload as SetConfigPayload;
        try {
          const advanced = await advanceConfig(client, {
            key: payload.key,
            value: payload.value,
            expectedVersion: row.expectedTargetVersion,
            causedBy: { actor: 'action', actionId: row.id },
          });
          controlPlane = {
            targetVersionBefore: advanced.versionBefore,
            targetVersionAfter: advanced.versionAfter,
            causedByActionId: row.id,
            beforeDigest: advanced.beforeDigest!,
            afterDigest: advanced.afterDigest!,
          };
          committedVersion = advanced.versionAfter;
        } catch (error) {
          // Not reachable under the locks held above; if the authority still
          // refuses, the commit is blocked rather than half done (the JS
          // error precedes every write of advanceConfig).
          if (error instanceof ConfigVersionError)
            return block(
              'stale_version',
              `the authority refused: ${error.code}`,
            );
          throw error;
        }
      }

      // Step 9.
      const committed = await client.query<IntentDbRow>(
        `UPDATE coordinator.action_intents
            SET status = 'committed', status_version = status_version + 1,
                committed_at = clock_timestamp(), committed_target_version = $3
          WHERE id = $1 AND status = 'admitted' AND dispatch_fence = $2
          RETURNING *`,
        [row.id, dispatchFence, committedVersion],
      );
      if (committed.rows.length !== 1)
        throw new DispatchFenceError(actionId, 'fence_mismatch', row.status);
      const receipt = await insertResultReceipt(client, {
        intent: row,
        outcome: 'committed',
        controlPlane,
      });
      const authorization = await insertAuthorization(client, {
        actionId: row.id,
        stage: 'commit',
        decision: 'committed',
        blockReason: null,
        checkedVector: verdict.checkedVector,
        targetVersion: {
          expected: row.expectedTargetVersion,
          live: verdict.targetLive,
        },
        authorFence: { token: row.authorFencingToken, valid: true },
        dispatchFence: { token: dispatchFence, valid: true },
        idempotencyBinding: 'new',
      });
      await enqueueOutbox(client, {
        missionId: row.missionId,
        topic: 'mission.evaluate',
        payload: { missionId: row.missionId },
        dedupeKey: `action:${row.id}:committed`,
      });
      buffer.add(row.missionId, decidedEvent(authorization, null));
      if (controlPlane)
        buffer.add(row.missionId, {
          kind: 'action.committed',
          actionId: row.id,
          targetVersionBefore: controlPlane.targetVersionBefore,
          targetVersionAfter: controlPlane.targetVersionAfter!,
          causedByActionId: row.id,
          afterDigest: controlPlane.afterDigest,
        });
      // Every lock is still held and every state row written; only the event
      // append (which takes the global events lock) and COMMIT follow.
      await barrier('after_lock_before_commit', { actionId, stage: 'commit' });
      await buffer.flush(client);
      return {
        intent: toIntent(mapIntentRow(committed.rows[0])),
        receipt,
        disposition: 'committed',
      };
    },
    { maxAttempts: 5 },
  );

  if (result.disposition === 'committed')
    await barrier('after_commit_before_dispatch', {
      actionId,
      stage: 'commit',
    });
  return result;
}

export async function commitIntent(
  deps: ActionDeps,
  actionId: string,
  dispatchFence: number,
): Promise<ActionIntent> {
  return (await commitIntentDetailed(deps, actionId, dispatchFence)).intent;
}
