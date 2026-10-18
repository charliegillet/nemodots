// Closure cap path (ARCHITECTURE 5.2, finding C14). ClosureCapExceeded is
// thrown BEFORE the receipt is written. The watcher then (1) pauses the
// affected missions, (2) registers the receipt without a closure in a fresh
// transaction, recording a coarse InvalidationEvent whose affected set is every
// non-terminal attempt and live intent of those missions, and (3) hands the
// event to the coordinator, which records mission_paused_closure_cap. The
// source stays observable.
import type pg from 'pg';
import type { Affected, MissionId } from '../contracts/index.js';
import { LIVE_STATUSES } from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import {
  ClosureCapExceeded,
  registerObservation,
  registerWithoutClosure,
  type CoarseInvalidation,
  type RegisterObservationInput,
  type RegisterOptions,
  type RegisterResult,
} from '../ledger/index.js';
import type { MissionPauser, WatcherLogEntry } from './types.js';

export interface CapDeps {
  pool: pg.Pool;
  missions?: MissionPauser;
  register: Pick<RegisterOptions, 'ledger' | 'limits'>;
  log: (entry: WatcherLogEntry) => void;
}

const emptyAffected = (): Affected => ({
  modelCallIds: [],
  attemptIds: [],
  outputIds: [],
  actionIds: [],
  taskIds: [],
});

/** Every non-terminal attempt and live intent of the missions (the coarse affected set). */
export async function buildCoarse(
  pool: pg.Pool,
  missionIds: readonly string[],
  nodes?: number,
): Promise<CoarseInvalidation> {
  const unique = [...new Set(missionIds)].sort();
  const attempts = await pool.query<{ id: string; mission_id: string }>(
    `SELECT id, mission_id FROM coordinator.task_attempts
      WHERE mission_id = ANY($1::uuid[]) AND status = 'running' ORDER BY id`,
    [unique],
  );
  // action_intents belongs to the actions package; absent until its migration.
  const hasIntents = (
    await pool.query<{ t: string | null }>(
      `SELECT to_regclass('coordinator.action_intents')::text AS t`,
    )
  ).rows[0]?.t;
  const intents = hasIntents
    ? await pool.query<{ id: string; mission_id: string }>(
        `SELECT id, mission_id FROM coordinator.action_intents
          WHERE mission_id = ANY($1::uuid[]) AND status = ANY($2::text[])
          ORDER BY id`,
        [unique, [...LIVE_STATUSES]],
      )
    : { rows: [] as { id: string; mission_id: string }[] };
  return {
    nodes,
    perMission: unique.map((missionId) => {
      const affected = emptyAffected();
      affected.attemptIds = attempts.rows
        .filter((row) => row.mission_id === missionId)
        .map((row) => row.id) as Affected['attemptIds'];
      affected.actionIds = intents.rows
        .filter((row) => row.mission_id === missionId)
        .map((row) => row.id) as Affected['actionIds'];
      return {
        missionId: missionId as MissionId,
        affected,
        preserved: { taskIds: [] },
      };
    }),
  };
}

/** registerObservation in its own transaction, with the cap fallback. */
export async function registerWithCapFallback(
  deps: CapDeps,
  input: RegisterObservationInput,
): Promise<RegisterResult> {
  try {
    return await withTransaction(deps.pool, (client) =>
      registerObservation(client, input, deps.register),
    );
  } catch (error) {
    if (!(error instanceof ClosureCapExceeded)) throw error;
    deps.log({
      event: 'closure_cap_exceeded',
      sourceKey: error.sourceKey,
      detail: `${error.cap} cap, ${error.missionIds.length} mission(s)`,
    });
    // The coarse set is read BEFORE pausing: pausing aborts the running
    // attempts that the event must still list.
    const coarse = await buildCoarse(deps.pool, error.missionIds);
    for (const missionId of error.missionIds) {
      try {
        await deps.missions?.pause(missionId as MissionId);
      } catch (pauseError) {
        // Already paused or finished: nothing left to pause.
        if ((pauseError as Error).name !== 'MissionStateError')
          deps.log({
            event: 'source_error',
            sourceKey: error.sourceKey,
            detail: `pause failed: ${(pauseError as Error).name}`,
          });
      }
    }
    return withTransaction(deps.pool, (client) =>
      registerWithoutClosure(client, input, { ...deps.register, coarse }),
    );
  }
}
