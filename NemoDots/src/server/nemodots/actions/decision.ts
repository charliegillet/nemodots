// Helpers shared by the admission, commit and dispatch transactions: the
// mission share lock, the blocked/failed transitions with their Authorization
// and event, and the compare-and-set UPDATE shape. Every function runs on the
// caller's transaction client; none does I/O other than SQL.
import type {
  ActionId,
  AuthorizationStage,
  BlockReason,
  CheckedVector,
  EventPayload,
  FailureReason,
  MissionId,
  PgClient,
} from '../contracts/index.js';
import type { EventBuffer } from '../coordinator/events.js';
import type { MissionFacts } from './predicates.js';
import {
  insertAuthorization,
  mapIntentRow,
  type IntentDbRow,
  type IntentRow,
} from './rows.js';

/** Mission row FOR SHARE: a cancel/pause (FOR UPDATE) waits for this transaction (C12). */
export async function lockMissionShared(
  client: PgClient,
  missionId: MissionId,
): Promise<MissionFacts | null> {
  const { rows } = await client.query<{ status: string; generation: number }>(
    'SELECT status, generation FROM coordinator.missions WHERE id = $1 FOR SHARE',
    [missionId],
  );
  return rows[0] ?? null;
}

export interface BlockInput {
  stage: AuthorizationStage;
  reason: BlockReason;
  detail: string | null;
  checkedVector: CheckedVector;
  targetLive: number;
}

/** proposed|admitted -> blocked, with its Authorization and `action.decided` event. */
export async function blockIntent(
  client: PgClient,
  buffer: EventBuffer,
  row: IntentRow,
  input: BlockInput,
): Promise<IntentRow> {
  const updated = await client.query<IntentDbRow>(
    `UPDATE coordinator.action_intents
        SET status = 'blocked', status_version = status_version + 1,
            block_reason = $3, block_detail = $4
      WHERE id = $1 AND status = $2 AND status_version = $5
      RETURNING *`,
    [row.id, row.status, input.reason, input.detail, row.statusVersion],
  );
  if (updated.rows.length !== 1)
    throw new Error(`action ${row.id} changed while it was being blocked`);
  const dispatchFence =
    row.dispatchFence === null
      ? null
      : { token: row.dispatchFence, valid: row.leaseValid };
  const authorization = await insertAuthorization(client, {
    actionId: row.id,
    stage: input.stage,
    decision: 'blocked',
    blockReason: input.reason,
    blockDetail: input.detail,
    checkedVector: input.checkedVector,
    targetVersion: {
      expected: row.expectedTargetVersion,
      live: input.targetLive,
    },
    authorFence: { token: row.authorFencingToken, valid: true },
    dispatchFence,
    idempotencyBinding: 'new',
  });
  buffer.add(row.missionId, decidedEvent(authorization, input.detail));
  return mapIntentRow(updated.rows[0]);
}

export function decidedEvent(
  authorization: {
    actionId: ActionId;
    stage: AuthorizationStage;
    decision: 'admitted' | 'committed' | 'blocked' | 'dispatched';
    blockReason: BlockReason | null;
    checkedVector: CheckedVector;
    targetVersion: { expected: number; live: number };
    dispatchFence: { token: number; valid: boolean } | null;
  },
  detail: string | null,
): EventPayload {
  return {
    kind: 'action.decided',
    actionId: authorization.actionId,
    stage: authorization.stage,
    decision: authorization.decision,
    blockReason: authorization.blockReason,
    blockDetail: detail,
    checkedVector: authorization.checkedVector,
    targetVersion: authorization.targetVersion,
    dispatchFence: authorization.dispatchFence,
  };
}

/** committed|dispatched|outcome_unknown -> failed(reason). Caller supplies the CAS predicate. */
export async function failIntent(
  client: PgClient,
  row: Pick<IntentRow, 'id' | 'status' | 'statusVersion'>,
  reason: FailureReason,
  extraWhere: { sql: string; params: unknown[] } = { sql: '', params: [] },
): Promise<IntentRow | null> {
  const { rows } = await client.query<IntentDbRow>(
    `UPDATE coordinator.action_intents
        SET status = 'failed', status_version = status_version + 1,
            failure_reason = $3, failed_at = clock_timestamp()
      WHERE id = $1 AND status = $2 AND status_version = $4 ${extraWhere.sql}
      RETURNING *`,
    [row.id, row.status, reason, row.statusVersion, ...extraWhere.params],
  );
  return rows[0] ? mapIntentRow(rows[0]) : null;
}
