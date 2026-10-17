import type pg from 'pg';
import type { MissionId, MissionSnapshot } from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { lastEventId } from './events.js';
import { MissionNotFoundError } from './errors.js';
import {
  toAttempt,
  toFinding,
  toInvalidation,
  toMission,
  toOutput,
  toRecovery,
  toTask,
  type AttemptRow,
  type FindingRow,
  type InvalidationRow,
  type MissionRow,
  type OutputRow,
  type RecoveryRow,
  type TaskRow,
} from './rows.js';
import type { CoordinatorDeps } from './types.js';

// GET /missions/:id (CONTRACTS.md section 9). Read-only SQL in one
// REPEATABLE READ transaction, so the arrays and lastEventId describe the same
// instant. The coordinator's own tables are read here; receipts, confirmations,
// actions, authorizations, results, probe and telemetry belong to other
// packages and come through the injected ForeignSnapshotReader.
//
// `invalidations` are the coordinator's mission-scoped copies: every event
// carries only this mission's subset of affected/preserved (rev2 I10), with
// resolvedAt set by the coordinator once the invalidation closed (D9).

export async function buildSnapshot(
  deps: Pick<CoordinatorDeps, 'pool' | 'snapshotReader'>,
  missionId: MissionId,
): Promise<MissionSnapshot> {
  return withTransaction(
    deps.pool,
    async (client: pg.PoolClient) => {
      const missionRow = (
        await client.query<MissionRow>(
          `SELECT * FROM coordinator.missions WHERE id = $1`,
          [missionId],
        )
      ).rows[0];
      if (!missionRow) throw new MissionNotFoundError(missionId);
      const [tasks, attempts, outputs, findings, recoveries, invalidations] =
        await Promise.all([
          client.query<TaskRow>(
            `SELECT * FROM coordinator.tasks WHERE mission_id = $1 ORDER BY ordinal`,
            [missionId],
          ),
          client.query<AttemptRow>(
            `SELECT * FROM coordinator.task_attempts WHERE mission_id = $1 ORDER BY started_at, n`,
            [missionId],
          ),
          client.query<OutputRow>(
            `SELECT * FROM coordinator.task_outputs WHERE mission_id = $1 ORDER BY published_at`,
            [missionId],
          ),
          client.query<FindingRow>(
            `SELECT * FROM coordinator.findings WHERE mission_id = $1 ORDER BY created_at`,
            [missionId],
          ),
          client.query<RecoveryRow>(
            `SELECT * FROM coordinator.recovery_events WHERE mission_id = $1 ORDER BY created_at, id`,
            [missionId],
          ),
          client.query<InvalidationRow>(
            `SELECT * FROM coordinator.invalidations WHERE mission_id = $1 ORDER BY created_at, event_id`,
            [missionId],
          ),
        ]);
      const foreign = await deps.snapshotReader.read(client, missionId);
      return {
        mission: toMission(missionRow),
        tasks: tasks.rows.map(toTask),
        attempts: attempts.rows.map(toAttempt),
        outputs: outputs.rows.map(toOutput),
        findings: findings.rows.map(toFinding),
        ...foreign,
        invalidations: invalidations.rows.map(toInvalidation),
        recoveries: recoveries.rows.map(toRecovery),
        lastEventId: await lastEventId(client, missionId),
      } satisfies MissionSnapshot;
    },
    { isolation: 'repeatable read', readOnly: true },
  );
}
