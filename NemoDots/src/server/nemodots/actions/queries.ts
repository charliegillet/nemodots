// Read side of the action boundary: the coordinator's IntentReader, the rows of
// the mission snapshot and the action inspector. Read-only; no locks.
import type {
  ActionId,
  ActionIntent,
  Authorization,
  MissionId,
  PgClient,
  ResultReceipt,
} from '../contracts/index.js';
import type { IntentReader, IntentRecord } from '../coordinator/types.js';
import {
  mapAuthorization,
  mapIntentRow,
  mapResultReceipt,
  toIntent,
  type IntentDbRow,
} from './rows.js';

/** The IntentReader the coordinator takes (`deps.intents`). */
export function createIntentReader(): IntentReader {
  return {
    async find(client, actionId): Promise<IntentRecord | null> {
      const { rows } = await client.query<{
        id: string;
        mission_id: string;
        task_id: string;
        attempt_id: string;
        status: IntentRecord['status'];
      }>(
        `SELECT id, mission_id, task_id, attempt_id, status
           FROM coordinator.action_intents WHERE id = $1`,
        [actionId],
      );
      const row = rows[0];
      return row
        ? {
            id: row.id as ActionId,
            missionId: row.mission_id as MissionId,
            taskId: row.task_id as IntentRecord['taskId'],
            attemptId: row.attempt_id,
            status: row.status,
          }
        : null;
    },
    async statuses(client, actionIds) {
      if (actionIds.length === 0) return [];
      const { rows } = await client.query<{
        id: string;
        status: IntentRecord['status'];
      }>(
        'SELECT id, status FROM coordinator.action_intents WHERE id = ANY($1::uuid[])',
        [[...actionIds]],
      );
      return rows;
    },
    async committedEffects(client, missionId) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM coordinator.action_intents
          WHERE mission_id = $1
            AND status IN ('committed', 'dispatched', 'verified', 'outcome_unknown')
          ORDER BY committed_at, id`,
        [missionId],
      );
      return rows.map((row) => row.id as ActionId);
    },
  };
}

export async function getIntent(
  client: PgClient,
  actionId: string,
): Promise<ActionIntent | null> {
  const { rows } = await client.query<IntentDbRow>(
    `SELECT *, (dispatcher_lease_expires_at > clock_timestamp()) AS lease_valid
       FROM coordinator.action_intents WHERE id = $1`,
    [actionId],
  );
  return rows[0] ? toIntent(mapIntentRow(rows[0])) : null;
}

export async function listIntents(
  client: PgClient,
  missionId: string,
): Promise<ActionIntent[]> {
  const { rows } = await client.query<IntentDbRow>(
    `SELECT * FROM coordinator.action_intents WHERE mission_id = $1
      ORDER BY proposed_at, id`,
    [missionId],
  );
  return rows.map((row) => toIntent(mapIntentRow(row)));
}

export async function listAuthorizations(
  client: PgClient,
  scope: { missionId?: string; actionId?: string },
): Promise<Authorization[]> {
  const { rows } = scope.actionId
    ? await client.query(
        'SELECT * FROM coordinator.authorizations WHERE action_id = $1 ORDER BY seq',
        [scope.actionId],
      )
    : await client.query(
        `SELECT a.* FROM coordinator.authorizations a
           JOIN coordinator.action_intents i ON i.id = a.action_id
          WHERE i.mission_id = $1 ORDER BY a.seq`,
        [scope.missionId],
      );
  return rows.map((row) => mapAuthorization(row as never));
}

export async function listResults(
  client: PgClient,
  scope: { missionId?: string; actionId?: string },
): Promise<ResultReceipt[]> {
  const { rows } = scope.actionId
    ? await client.query(
        'SELECT * FROM coordinator.result_receipts WHERE action_id = $1 ORDER BY seq',
        [scope.actionId],
      )
    : await client.query(
        `SELECT r.* FROM coordinator.result_receipts r
           JOIN coordinator.action_intents i ON i.id = r.action_id
          WHERE i.mission_id = $1 ORDER BY r.seq`,
        [scope.missionId],
      );
  return rows.map((row) => mapResultReceipt(row as never));
}

/** The `actions`, `authorizations` and `results` parts of MissionSnapshot. */
export async function readActionSnapshot(client: PgClient, missionId: string) {
  return {
    actions: await listIntents(client, missionId),
    authorizations: await listAuthorizations(client, { missionId }),
    results: await listResults(client, { missionId }),
  };
}

export interface ActionInspection {
  intent: ActionIntent;
  authorizations: Authorization[];
  results: ResultReceipt[];
}

/** The action inspector: one intent with every decision and every result recorded for it. */
export async function inspectAction(
  client: PgClient,
  actionId: string,
): Promise<ActionInspection | null> {
  const intent = await getIntent(client, actionId);
  if (!intent) return null;
  return {
    intent,
    authorizations: await listAuthorizations(client, { actionId }),
    results: await listResults(client, { actionId }),
  };
}
