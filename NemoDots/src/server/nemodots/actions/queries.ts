// Read side and the queue operations of the action boundary.
import {
  LIVE_STATUSES,
  type ActionId,
  type ActionIntent,
  type Authorization,
  type MissionId,
  type PgClient,
  type ResultReceipt,
} from '../contracts/index.js';
import type { IntentReader } from '../coordinator/types.js';
import { withTransaction } from '../db/tx.js';
import type { ActionsDeps } from './deps.js';
import { failNotRunning } from './not-running.js';
import { lockMissionShared } from './predicates.js';
import {
  findResultReceipt,
  toIntent,
  transition,
  type IntentRow,
} from './rows.js';

export async function listIntents(
  client: PgClient,
  missionId: MissionId | string,
): Promise<ActionIntent[]> {
  const { rows } = await client.query<IntentRow>(
    'SELECT * FROM coordinator.action_intents WHERE mission_id = $1 ORDER BY proposed_at, id',
    [missionId],
  );
  return rows.map(toIntent);
}

export async function listAuthorizations(
  client: PgClient,
  missionId: MissionId | string,
): Promise<Authorization[]> {
  const { rows } = await client.query<{
    id: string;
    action_id: string;
    stage: string;
    decided_at: Date;
    decision: string;
    block_reason: string | null;
    checked_vector: unknown;
    target_version: unknown;
    author_fence: unknown;
    dispatch_fence: unknown;
    policy_version: string;
    idempotency_binding: string;
  }>(
    `SELECT a.* FROM coordinator.authorizations a
       JOIN coordinator.action_intents i ON i.id = a.action_id
      WHERE i.mission_id = $1 ORDER BY a.decided_at, a.id`,
    [missionId],
  );
  return rows.map(
    (row) =>
      ({
        id: row.id,
        actionId: row.action_id,
        stage: row.stage,
        decidedAt: row.decided_at.toISOString(),
        decision: row.decision,
        blockReason: row.block_reason,
        checkedVector: row.checked_vector,
        targetVersion: row.target_version,
        authorFence: row.author_fence,
        dispatchFence: row.dispatch_fence,
        policyVersion: row.policy_version,
        idempotencyBinding: row.idempotency_binding,
      }) as unknown as Authorization,
  );
}

export async function listResultReceipts(
  client: PgClient,
  missionId: MissionId | string,
): Promise<ResultReceipt[]> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM coordinator.action_intents WHERE mission_id = $1 ORDER BY id',
    [missionId],
  );
  const receipts: ResultReceipt[] = [];
  for (const row of rows) {
    const receipt = await findResultReceipt(client, row.id);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

/** The coordinator's read-only view of the intents (IntentReader). */
export function createIntentReader(): IntentReader {
  return {
    async find(client, actionId) {
      const { rows } = await client.query<IntentRow>(
        'SELECT * FROM coordinator.action_intents WHERE id = $1',
        [actionId],
      );
      const row = rows[0];
      return row
        ? {
            id: row.id as ActionId,
            missionId: row.mission_id as MissionId,
            taskId: row.task_id as never,
            attemptId: row.attempt_id,
            status: row.status,
          }
        : null;
    },
    async statuses(client, actionIds) {
      if (actionIds.length === 0) return [];
      const { rows } = await client.query<{ id: string; status: never }>(
        'SELECT id, status FROM coordinator.action_intents WHERE id = ANY($1::uuid[])',
        [actionIds],
      );
      return rows;
    },
    async committedEffects(client, missionId) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM coordinator.action_intents
          WHERE mission_id = $1
            AND status IN ('committed', 'dispatched', 'verified', 'outcome_unknown')
          ORDER BY id`,
        [missionId],
      );
      return rows.map((row) => row.id as ActionId);
    },
    async liveIntents(client, missionId) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM coordinator.action_intents
          WHERE mission_id = $1 AND status = ANY($2::text[])
          ORDER BY id`,
        [missionId, [...LIVE_STATUSES]],
      );
      return rows.map((row) => row.id as ActionId);
    },
  };
}

/**
 * Cancels the queued intents (proposed | admitted) of a mission generation
 * older than `generation` (the cancel bumped it) and settles the committed but
 * never-dispatched flushes: they end failed(effect_not_applied) with the
 * explicit reason mission_not_running and no Redis command is issued. The
 * returned ids are the CANCELLED queue entries only; settled committed effects
 * are listed in the mission's cancellation.committedEffects (the coordinator
 * computes that list before this runs) and stay distinguishable by their
 * receipt (outcome failed, no external effect). A flush that was already
 * claimed for dispatch is in flight and is left to its dispatcher: dispatched
 * effects stay as they are, with no rollback.
 */
export async function cancelQueued(
  deps: ActionsDeps,
  missionId: MissionId | string,
  generation: number,
): Promise<ActionId[]> {
  return withTransaction(deps.pool, async (client) => {
    // mission first (FOR SHARE), then the intents: the common lock order
    await lockMissionShared(client, missionId as string);
    const { rows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM coordinator.action_intents
        WHERE mission_id = $1 AND generation < $2 AND status IN ('proposed', 'admitted')
        ORDER BY id FOR UPDATE`,
      [missionId, generation],
    );
    const cancelled: ActionId[] = [];
    for (const row of rows) {
      await transition(
        client,
        row.id,
        row.status as 'proposed' | 'admitted',
        'cancelled',
      );
      cancelled.push(row.id as ActionId);
    }
    const undispatched = await client.query<IntentRow>(
      `SELECT i.* FROM coordinator.action_intents i
        WHERE i.mission_id = $1 AND i.status = 'committed'
          AND i.action = 'flush_cache_namespace'
          AND NOT EXISTS (SELECT 1 FROM coordinator.authorizations a
                           WHERE a.action_id = i.id AND a.stage = 'dispatch')
        ORDER BY i.id FOR UPDATE`,
      [missionId],
    );
    for (const row of undispatched.rows)
      await failNotRunning(
        client,
        deps,
        row,
        row.dispatch_fence ?? 0,
        'the mission was cancelled before the effect was dispatched',
      );
    return cancelled;
  });
}

/** Admitted intents whose dispatcher lease expired (candidates for reclaim). */
export async function findReclaimable(
  client: PgClient,
  limit = 50,
): Promise<ActionId[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM coordinator.action_intents
      WHERE status = 'admitted' AND dispatcher_lease_expires_at <= clock_timestamp()
      ORDER BY dispatcher_lease_expires_at LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id as ActionId);
}
