// Re-claiming (ARCHITECTURE.md section 5.1/6, finding C4). A dispatcher that
// dies between admission and commit leaves an `admitted` intent whose lease
// expires. Any dispatcher may then re-admit it: the admission transaction runs
// again (every predicate, a new dispatch fence, a new lease, a new
// Authorization), and the old dispatcher's commit fails with DispatchFenceError
// at step 2. This module finds such work; the transition is admit.ts.
import type pg from 'pg';
import { admitIntentDetailed, type AdmitResult } from './admit.js';
import type { ActionDeps } from './types.js';

export interface StuckWork {
  /** admitted, dispatcher lease expired: re-admit, commit, dispatch */
  reclaimable: string[];
  /** committed flush with no live dispatcher lease: dispatch */
  undispatched: string[];
  /** dispatched | outcome_unknown flush: reconcile */
  unsettled: string[];
}

/**
 * Finds intents that need a dispatcher: expired admission leases, committed
 * flushes nobody is dispatching, and effects whose outcome is not recorded.
 * `settleAfterMs` keeps the sweep away from work another process is doing right now.
 */
export async function findStuckWork(
  pool: Pick<pg.Pool, 'query'>,
  options: { limit?: number; settleAfterMs?: number } = {},
): Promise<StuckWork> {
  const limit = options.limit ?? 50;
  const settleAfter = options.settleAfterMs ?? 2_000;
  const ids = async (sql: string, params: unknown[]) =>
    (await pool.query<{ id: string }>(sql, params)).rows.map((row) => row.id);
  return {
    reclaimable: await ids(
      `SELECT id FROM coordinator.action_intents
        WHERE status = 'admitted' AND dispatcher_lease_expires_at <= clock_timestamp()
        ORDER BY dispatcher_lease_expires_at LIMIT $1`,
      [limit],
    ),
    undispatched: await ids(
      `SELECT id FROM coordinator.action_intents
        WHERE status = 'committed' AND adapter = 'redis_cache'
          AND dispatcher_lease_expires_at <= clock_timestamp()
          AND committed_at <= clock_timestamp() - $2 * interval '1 millisecond'
        ORDER BY committed_at LIMIT $1`,
      [limit, settleAfter],
    ),
    unsettled: await ids(
      `SELECT id FROM coordinator.action_intents
        WHERE status IN ('dispatched', 'outcome_unknown') AND adapter = 'redis_cache'
          AND COALESCE(dispatched_at, committed_at)
              <= clock_timestamp() - $2 * interval '1 millisecond'
        ORDER BY committed_at LIMIT $1`,
      [limit, settleAfter],
    ),
  };
}

/** Re-admits an admitted intent whose lease expired (no-op while the lease is live). */
export function reclaimAdmitted(
  deps: ActionDeps,
  actionId: string,
  dispatcher: string,
): Promise<AdmitResult> {
  return admitIntentDetailed(deps, actionId, dispatcher);
}
