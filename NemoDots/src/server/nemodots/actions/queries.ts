// Read side and the queue operations of the action boundary.
import type {
  ActionId,
  ActionIntent,
  Authorization,
  MissionId,
  PgClient,
  ResultReceipt,
} from '../contracts/index.js';
import type { IntentReader } from '../coordinator/types.js';
import { withTransaction } from '../db/tx.js';
import type { ActionsDeps } from './deps.js';
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
  };
}

/**
 * Cancels the queued intents (proposed | admitted) of a mission generation
 * older than `generation` (the cancel bumped it). Committed effects stay.
 */
export async function cancelQueued(
  deps: ActionsDeps,
  missionId: MissionId | string,
  generation: number,
): Promise<ActionId[]> {
  return withTransaction(deps.pool, async (client) => {
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
