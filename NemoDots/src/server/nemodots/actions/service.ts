// The action boundary as one service: ActionAdmissionPort (CONTRACTS section 10)
// plus the state-driven pipeline the coordinator's outbox handler drives and
// the sweep that recovers stuck work.
//
//   admit      pure admission (proposed -> admitted | blocked; re-admission)
//   commit     commit transaction under the caller's dispatch fence
//   dispatch   claimDispatch + the Redis effect (flush only); the fence must be
//              the one stored on the intent, so a stale dispatcher is refused
//   reconcile  marker read, never a second effect
//   process    admit -> commit -> dispatch (or reconcile), whatever state the
//              intent is in: the outbox message `action.proposed` is delivered
//              at least once, and every step is a compare-and-set
//   sweep      finds admitted intents with expired leases, committed flushes
//              nobody dispatches, and unsettled effects, and processes them
import type {
  ActionAdmissionPort,
  ActionId,
  ActionIntent,
  MissionId,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { admitIntent, admitIntentDetailed } from './admit.js';
import { commitIntentDetailed, commitIntent } from './commit.js';
import { compensateIntent, type CompensationInput } from './compensate.js';
import { dispatchIntent, dispatchIntentDetailed } from './dispatch.js';
import {
  ActionNotFoundError,
  DispatchFenceError,
  EffectUnavailableError,
} from './errors.js';
import { proposeIntent, type ProposeContext } from './propose.js';
import { reconcileIntent, reconcileIntentDetailed } from './reconcile.js';
import { findStuckWork } from './reclaim.js';
import { loadIntent, toIntent } from './rows.js';
import { settleFromHistory, type SettleOutcome } from './settle.js';
import type { ActionDeps } from './types.js';

export interface SweepReport {
  processed: string[];
  errors: { actionId: string; error: string }[];
}

export interface ActionService extends ActionAdmissionPort {
  deps: ActionDeps;
  /** State-driven pipeline for one intent. */
  process(
    actionId: ActionId | string,
    dispatcher: string,
  ): Promise<ActionIntent>;
  sweep(
    dispatcher: string,
    options?: { limit?: number; settleAfterMs?: number },
  ): Promise<SweepReport>;
  compensate(
    actionId: ActionId | string,
    input: CompensationInput,
  ): Promise<ActionIntent>;
  /** For the watcher: committed set_config -> verified | failed. */
  settleFromHistory(
    actionId: ActionId | string,
    outcome: SettleOutcome,
  ): Promise<ActionIntent>;
  /** The slice the coordinator takes as `deps.actions`: admit runs the pipeline. */
  coordinatorPort(
    dispatcher?: string,
  ): Pick<ActionAdmissionPort, 'admit' | 'cancelQueued'>;
}

export function createActionService(deps: ActionDeps): ActionService {
  const reload = async (actionId: string) => {
    const row = await loadIntent(deps.pool, actionId);
    if (!row) throw new ActionNotFoundError(actionId);
    return toIntent(row);
  };

  async function process(
    actionId: ActionId | string,
    dispatcher: string,
  ): Promise<ActionIntent> {
    const row = await loadIntent(deps.pool, actionId);
    if (!row) throw new ActionNotFoundError(actionId);
    if (row.status === 'dispatched' || row.status === 'outcome_unknown')
      return row.adapter === 'redis_cache' && deps.redis
        ? reconcileIntent(deps, actionId)
        : toIntent(row);
    if (row.status === 'committed') {
      if (row.adapter !== 'redis_cache' || !deps.redis) return toIntent(row);
      return dispatchAndSettle(actionId, dispatcher);
    }
    if (row.status !== 'proposed' && row.status !== 'admitted')
      return toIntent(row);

    const admitted = await admitIntentDetailed(deps, actionId, dispatcher);
    const intent = admitted.intent;
    // Only the dispatcher holding the current lease goes on.
    if (
      intent.status !== 'admitted' ||
      intent.dispatch === null ||
      intent.dispatch.owner !== dispatcher
    )
      return intent;
    let committed;
    try {
      committed = await commitIntentDetailed(
        deps,
        actionId,
        intent.dispatch.fence,
      );
    } catch (error) {
      // Another dispatcher re-claimed the intent: its commit stands.
      if (error instanceof DispatchFenceError) return reload(actionId);
      throw error;
    }
    if (committed.disposition !== 'committed') return committed.intent;
    if (committed.intent.adapter === 'redis_cache' && deps.redis)
      return dispatchAndSettle(actionId, dispatcher);
    return committed.intent;
  }

  /**
   * Dispatch; when an earlier dispatcher may already have run the effect the
   * intent was moved to outcome_unknown instead of being claimed again, and
   * reconcile (marker, stored receipts, epoch) settles it. The script is never
   * called a second time.
   */
  async function dispatchAndSettle(
    actionId: string,
    dispatcher: string,
  ): Promise<ActionIntent> {
    const dispatched = await dispatchIntentDetailed(deps, actionId, dispatcher);
    if (dispatched.priorAttempt) return reconcileIntent(deps, actionId);
    return dispatched.intent;
  }

  return {
    deps,
    propose: (input, ctx) => proposeIntent(deps, input, ctx as ProposeContext),
    admit: (actionId, dispatcher) => admitIntent(deps, actionId, dispatcher),
    commit: (actionId, dispatchFence) =>
      commitIntent(deps, actionId, dispatchFence),
    async dispatch(actionId, dispatchFence) {
      const row = await loadIntent(deps.pool, actionId);
      if (!row) throw new ActionNotFoundError(actionId);
      if (row.status === 'committed' && row.dispatchFence !== dispatchFence)
        throw new DispatchFenceError(
          actionId,
          'fence_mismatch',
          row.status,
          `caller fence ${dispatchFence}, stored ${row.dispatchFence}`,
        );
      return dispatchIntent(deps, actionId, row.dispatchOwner ?? 'dispatcher');
    },
    reconcile: (actionId) => reconcileIntent(deps, actionId),
    async cancelQueued(missionId: MissionId, generation: number) {
      return withTransaction(deps.pool, async (client) => {
        await client.query(
          'SELECT id FROM coordinator.missions WHERE id = $1 FOR SHARE',
          [missionId],
        );
        await client.query(
          `SELECT id FROM coordinator.action_intents
            WHERE mission_id = $1 AND status IN ('proposed', 'admitted')
            ORDER BY id FOR UPDATE`,
          [missionId],
        );
        const { rows } = await client.query<{ id: string }>(
          `UPDATE coordinator.action_intents
              SET status = 'cancelled', status_version = status_version + 1
            WHERE mission_id = $1 AND status IN ('proposed', 'admitted')
              AND generation < $2
            RETURNING id`,
          [missionId, generation],
        );
        return rows.map((row) => row.id as ActionId).sort();
      });
    },
    process,
    async sweep(dispatcher, options) {
      const work = await findStuckWork(deps.pool, options);
      const report: SweepReport = { processed: [], errors: [] };
      const ids = [
        ...new Set([
          ...work.reclaimable,
          ...work.undispatched,
          ...work.unsettled,
        ]),
      ];
      for (const id of ids) {
        try {
          await process(id, dispatcher);
          report.processed.push(id);
        } catch (error) {
          // No Redis client: the effect waits for a process that has one.
          if (error instanceof EffectUnavailableError) continue;
          report.errors.push({
            actionId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return report;
    },
    compensate: (actionId, input) => compensateIntent(deps, actionId, input),
    settleFromHistory: (actionId, outcome) =>
      settleFromHistory(deps, actionId, outcome),
    coordinatorPort(dispatcher = 'coordinator') {
      return {
        admit: (actionId, who) => process(actionId, who || dispatcher),
        cancelQueued: (missionId, generation) =>
          this.cancelQueued(missionId, generation),
      };
    },
  };
}

export {
  commitIntentDetailed,
  dispatchIntentDetailed,
  reconcileIntentDetailed,
};
