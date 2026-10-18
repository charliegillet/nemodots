import type pg from 'pg';
import {
  assertTransition,
  type AbortReason,
  type AttemptId,
  type AttemptStatus,
  type ReceiptId,
  type TaskId,
} from '../contracts/index.js';
import { CasConflictError } from './errors.js';
import type { AttemptRow } from './rows.js';
import type { TxCtx } from './tasks.js';

// The attempt state machine (ARCHITECTURE.md 7.3): running -> published |
// failed | aborted | expired | invalidated, always a CAS on (id, status).

export interface AttemptTerminalOptions {
  abortReason?: AbortReason | null;
  failureReason?: string | null;
}

/**
 * Moves a `running` attempt to a terminal status and emits attempt.finished
 * (plus attempt.aborted for `aborted`). Status first: callers write this
 * before any abort signal fires, so a late publication is rejected by the
 * fence check and not by timing.
 */
export async function finishAttempt(
  tx: TxCtx,
  attempt: Pick<AttemptRow, 'id' | 'task_id' | 'mission_id'>,
  to: Exclude<AttemptStatus, 'running'>,
  options: AttemptTerminalOptions = {},
): Promise<AttemptRow> {
  assertTransition('attempt', 'running', to);
  const { rows } = await tx.client.query<AttemptRow>(
    `UPDATE coordinator.task_attempts
        SET status = $2, abort_reason = $3, failure_reason = $4,
            finished_at = now()
      WHERE id = $1 AND status = 'running'
      RETURNING *`,
    [
      attempt.id,
      to,
      options.abortReason ?? null,
      options.failureReason ?? null,
    ],
  );
  if (rows.length === 0)
    throw new CasConflictError('attempt', attempt.id, 'running');
  const row = rows[0];
  if (to === 'aborted' && options.abortReason)
    tx.events.add(row.mission_id, {
      kind: 'attempt.aborted',
      attemptId: row.id as AttemptId,
      taskId: row.task_id as TaskId,
      abortReason: options.abortReason,
    });
  tx.events.add(row.mission_id, {
    kind: 'attempt.finished',
    attemptId: row.id as AttemptId,
    taskId: row.task_id as TaskId,
    status: to,
    readSetReceiptIds: row.read_set_receipt_ids as ReceiptId[],
    modelCallCount: row.model_call_ids.length,
  });
  return row;
}

export async function lockAttempts(
  client: pg.PoolClient,
  ids: readonly string[],
  missionId: string,
): Promise<AttemptRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<AttemptRow>(
    `SELECT * FROM coordinator.task_attempts
      WHERE id = ANY ($1::uuid[]) AND mission_id = $2
      ORDER BY id FOR UPDATE`,
    [[...ids], missionId],
  );
  return rows;
}

/** Locks every running attempt of the mission (pause/cancel/fail sweeps). */
export async function lockRunningAttempts(
  client: pg.PoolClient,
  missionId: string,
): Promise<AttemptRow[]> {
  const { rows } = await client.query<AttemptRow>(
    `SELECT * FROM coordinator.task_attempts
      WHERE mission_id = $1 AND status = 'running'
      ORDER BY id FOR UPDATE`,
    [missionId],
  );
  return rows;
}

/** Locks the running attempts of the given tasks of the mission (replan supersession). */
export async function lockRunningAttemptsOfTasks(
  client: pg.PoolClient,
  missionId: string,
  taskIds: readonly string[],
): Promise<AttemptRow[]> {
  if (taskIds.length === 0) return [];
  const { rows } = await client.query<AttemptRow>(
    `SELECT * FROM coordinator.task_attempts
      WHERE mission_id = $1 AND task_id = ANY ($2::uuid[]) AND status = 'running'
      ORDER BY id FOR UPDATE`,
    [missionId, [...taskIds]],
  );
  return rows;
}
