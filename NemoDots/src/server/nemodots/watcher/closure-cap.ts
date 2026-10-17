import type pg from 'pg';
import {
  LIVE_STATUSES,
  type Affected,
  type InvalidationEvent,
  type MissionId,
  type PgClient,
  type TaskId,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import {
  ClosureCapExceeded,
  coordinatorSchema,
  registerWithoutClosure,
  type CoarseInvalidation,
  type LedgerOptions,
  type RegisterObservationInput,
  type RegisterResult,
} from '../ledger/index.js';
import type { WatcherEvent, WatcherRecovery } from './types.js';

// The closure-cap path (ARCHITECTURE 5.2, finding C14). The ledger throws
// ClosureCapExceeded BEFORE it writes the new receipt, so the observation is
// not lost: the watcher
//   1. reads the coarse affected set (every live attempt and intent of the
//      missions that cite the superseded receipt), BEFORE pausing, because a
//      pause aborts the running attempts and would empty the set,
//   2. pauses those missions through the coordinator,
//   3. in a fresh transaction registers the receipt WITHOUT the closure; the
//      ledger records the coarse InvalidationEvent (reason closure_cap_exceeded,
//      closure.capped = true) and marks the coarse set,
//   4. hands the event to the coordinator (the caller does that after COMMIT).
// The source stays observable: the next change registers normally.

/**
 * The coarse invalidation for `missionIds`: affected = every running attempt,
 * its task and every live action intent; preserved = the mission's other tasks.
 * Read-only SQL on coordinator tables (the action_intents table belongs to the
 * actions package and may not exist yet).
 */
export async function buildCoarseInvalidation(
  client: PgClient,
  missionIds: readonly string[],
  nodes: number,
  options?: LedgerOptions,
): Promise<CoarseInvalidation> {
  const schema = coordinatorSchema(options);
  const ids = [...new Set(missionIds)].sort();
  const attempts = await client.query<{
    id: string;
    task_id: string;
    mission_id: string;
  }>(
    `SELECT id, task_id, mission_id FROM ${schema}.task_attempts
      WHERE mission_id = ANY($1::uuid[]) AND status = 'running' ORDER BY id`,
    [ids],
  );
  const tasks = await client.query<{ id: string; mission_id: string }>(
    `SELECT id, mission_id FROM ${schema}.tasks
      WHERE mission_id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  let intents: { id: string; mission_id: string }[] = [];
  const present = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${schema}.action_intents`],
  );
  if (present.rows[0]?.present)
    intents = (
      await client.query<{ id: string; mission_id: string }>(
        `SELECT id, mission_id FROM ${schema}.action_intents
          WHERE mission_id = ANY($1::uuid[]) AND status = ANY($2::text[]) ORDER BY id`,
        [ids, [...LIVE_STATUSES]],
      )
    ).rows;

  const perMission = ids.map((missionId) => {
    const missionAttempts = attempts.rows.filter(
      (row) => row.mission_id === missionId,
    );
    const affectedTasks = new Set(missionAttempts.map((row) => row.task_id));
    const affected: Affected = {
      modelCallIds: [],
      attemptIds: missionAttempts.map((row) => row.id),
      outputIds: [],
      actionIds: intents
        .filter((row) => row.mission_id === missionId)
        .map((row) => row.id),
      taskIds: [...affectedTasks].sort(),
    } as unknown as Affected;
    const preserved = tasks.rows
      .filter((row) => row.mission_id === missionId && !affectedTasks.has(row.id))
      .map((row) => row.id as TaskId);
    return {
      missionId: missionId as MissionId,
      affected,
      preserved: { taskIds: preserved },
    };
  });
  return { perMission, nodes };
}

export interface ClosureCapDeps {
  pool: pg.Pool;
  recovery: Pick<WatcherRecovery, 'pauseMission'>;
  ledger?: LedgerOptions;
  emit: (event: WatcherEvent) => void;
}

export interface ClosureCapResult {
  result: RegisterResult;
  event: InvalidationEvent | null;
}

/**
 * Runs the cap path for a registration that threw ClosureCapExceeded. The
 * `input` is the registration that was refused; it is registered unchanged.
 */
export async function registerAfterClosureCap(
  deps: ClosureCapDeps,
  cap: ClosureCapExceeded,
  input: RegisterObservationInput,
): Promise<ClosureCapResult> {
  deps.emit({
    type: 'closure_cap',
    sourceKey: cap.sourceKey,
    cap: cap.cap,
    missionIds: [...cap.missionIds],
  });
  const coarse = await withTransaction(
    deps.pool,
    (client) =>
      buildCoarseInvalidation(
        client,
        cap.missionIds,
        cap.limits.maxNodes,
        deps.ledger,
      ),
    { readOnly: true },
  );
  for (const missionId of cap.missionIds) {
    try {
      await deps.recovery.pauseMission(
        missionId as MissionId,
        'closure_cap_exceeded',
      );
    } catch (error) {
      // A mission that is already paused or finished has nothing left to pause.
      if ((error as { name?: string })?.name !== 'MissionStateError') throw error;
    }
  }
  const result = await withTransaction(deps.pool, (client) =>
    registerWithoutClosure(client, input, { ledger: deps.ledger, coarse }),
  );
  return { result, event: result.invalidation };
}
