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
  DEAD_ATTEMPT_STATUSES,
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
//   1. reads the coarse affected set BEFORE pausing, because a pause aborts the
//      running attempts and would empty the set. It holds every running
//      attempt and live intent of the missions that cite the superseded receipt
//      and, found through a bounded walk of the evidence/inheritance edges from
//      that receipt (COARSE_WALK_DEPTH), the attempts, model calls, outputs,
//      intents and tasks of those missions that rest on it, published ones
//      included. A task is `preserved` only when nothing of it was reached.
//   2. pauses those missions through the coordinator,
//   3. in a fresh transaction registers the receipt WITHOUT the closure; the
//      ledger records the coarse InvalidationEvent (reason closure_cap_exceeded,
//      closure.capped = true) and marks the coarse set,
//   4. hands the event to the coordinator (the caller does that after COMMIT).
// The source stays observable: the next change registers normally.

/**
 * How far from the superseded receipt the coarse walk follows edges. The walk
 * is bounded because the real closure is what blew the cap; three hops reach
 * receipt -> attempt -> published output -> a child attempt that inherited it.
 * KNOWN LIMIT: a dependent further away than this is not named in the coarse
 * event. It is not unsafe: the missions are paused, and G1/G2 refuse any
 * publication or commit that cites the superseded receipt (its live version is
 * newer), so such a dependent can only be repaired, never trusted.
 */
export const COARSE_WALK_DEPTH = 3;
const COARSE_WALK_ROWS = 5_000;

interface ReachedRow {
  kind: string;
  id: string;
  mission_id: string;
  task_id: string | null;
}

/**
 * The coarse invalidation for `missionIds`: affected = every running attempt,
 * every live action intent, and what the bounded edge walk from the superseded
 * receipt reaches inside these missions (attempts that already published, their
 * outputs, model calls, intents) together with the tasks of those attempts;
 * preserved = the mission's other tasks. Read-only SQL on coordinator and
 * ledger tables (the action_intents table belongs to the actions package and
 * may not exist yet).
 */
export async function buildCoarseInvalidation(
  client: PgClient,
  missionIds: readonly string[],
  nodes: number,
  options?: LedgerOptions,
  oldReceiptId?: string,
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

  const reached = oldReceiptId
    ? (
        await client.query<ReachedRow>(
          `WITH RECURSIVE reach(kind, id, depth) AS (
             SELECT e.to_kind, e.to_id, 1
               FROM ledger.dependency_edges e
              WHERE e.from_kind = 'receipt' AND e.from_id = $1
                AND e.kind IN ('evidence', 'inheritance')
             UNION
             SELECT e.to_kind, e.to_id, r.depth + 1
               FROM reach r
               JOIN ledger.dependency_edges e
                 ON e.from_kind = r.kind AND e.from_id = r.id
                AND e.kind IN ('evidence', 'inheritance')
              WHERE r.depth < $2)
           SELECT DISTINCT r.kind, r.id, n.mission_id, n.task_id
             FROM reach r
             JOIN ledger.dependency_nodes n ON n.kind = r.kind AND n.id = r.id
            WHERE n.mission_id = ANY($3::uuid[])
            ORDER BY r.kind, r.id
            LIMIT ${COARSE_WALK_ROWS}`,
          [oldReceiptId, COARSE_WALK_DEPTH, ids],
        )
      ).rows
    : [];
  // R2 of the closure rules: an attempt that already ended without being its
  // task's result no longer describes the task. Published and running attempts
  // do.
  const reachedAttemptIds = reached
    .filter((row) => row.kind === 'attempt')
    .map((row) => row.id);
  const deadAttempts = new Set<string>(
    reachedAttemptIds.length
      ? (
          await client.query<{ id: string }>(
            `SELECT id FROM ${schema}.task_attempts
              WHERE id = ANY($1::uuid[])
                AND status = ANY($2::text[])`,
            [reachedAttemptIds, [...DEAD_ATTEMPT_STATUSES]],
          )
        ).rows.map((row) => row.id)
      : [],
  );

  const perMission = ids.map((missionId) => {
    const missionAttempts = attempts.rows.filter(
      (row) => row.mission_id === missionId,
    );
    const mine = reached.filter((row) => row.mission_id === missionId);
    const affectedTasks = new Set(missionAttempts.map((row) => row.task_id));
    const attemptIds = new Set(missionAttempts.map((row) => row.id));
    const modelCallIds = new Set<string>();
    const outputIds = new Set<string>();
    const actionIds = new Set(
      intents.filter((row) => row.mission_id === missionId).map((row) => row.id),
    );
    for (const row of mine) {
      if (row.kind === 'attempt') {
        attemptIds.add(row.id);
        if (row.task_id && !deadAttempts.has(row.id))
          affectedTasks.add(row.task_id);
      } else if (row.kind === 'model_call') modelCallIds.add(row.id);
      else if (row.kind === 'task_output') outputIds.add(row.id);
      else if (row.kind === 'action_intent') actionIds.add(row.id);
      else if (row.kind === 'task') affectedTasks.add(row.id);
    }
    const sorted = (set: Set<string>) =>
      [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const affected: Affected = {
      modelCallIds: sorted(modelCallIds),
      attemptIds: sorted(attemptIds),
      outputIds: sorted(outputIds),
      actionIds: sorted(actionIds),
      taskIds: sorted(affectedTasks),
    } as unknown as Affected;
    const preserved = tasks.rows
      .filter(
        (row) => row.mission_id === missionId && !affectedTasks.has(row.id),
      )
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
  afterRegister?: (client: PgClient, result: RegisterResult) => Promise<void>,
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
        cap.oldReceiptId,
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
      if ((error as { name?: string })?.name !== 'MissionStateError')
        throw error;
    }
  }
  const result = await withTransaction(deps.pool, async (client) => {
    const registered = await registerWithoutClosure(client, input, {
      ledger: deps.ledger,
      coarse,
    });
    await afterRegister?.(client, registered);
    return registered;
  });
  return { result, event: result.invalidation };
}
