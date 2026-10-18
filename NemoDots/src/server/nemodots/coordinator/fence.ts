import type pg from 'pg';
import { isMutated } from '../config/mutation.js';
import type { AttemptContext, TaskStatus } from '../contracts/index.js';
import { FenceError } from './errors.js';
import type { AttemptRow, MissionRow, TaskRow } from './rows.js';

// ARCHITECTURE.md section 6 / findings C12: the fenced prefix of every
// publication transaction.
//
//   1. look the attempt up (plain read) to confirm the identity in the context;
//   2. SELECT ... FROM missions WHERE id = $m FOR SHARE (or FOR UPDATE for the
//      caps-bearing plan/delegate paths), so a cancel/pause waits for us;
//   3. SELECT the attempt FOR UPDATE and check
//      attempt.fencing_token = ctx token, task.fence_seq = ctx token,
//      status = 'running', generation = ctx generation, lease unexpired,
//      mission running at the same generation;
//   4. SELECT the task FOR UPDATE.
//
// Lock order everywhere in the coordinator: mission -> attempt -> task.
// Any mismatch throws FenceError and nothing has been written.

export interface FencedAttempt {
  mission: MissionRow;
  attempt: AttemptRow;
  task: TaskRow;
}

export interface FenceOptions {
  missionLock?: 'share' | 'update';
  /** Accepted task statuses (default running or waiting). */
  taskStatuses?: readonly TaskStatus[];
  /** Skip the lease-expiry check (used by failAttempt/abortAttempt cleanup). */
  ignoreLease?: boolean;
}

export async function lockFencedAttempt(
  client: pg.PoolClient,
  context: AttemptContext,
  options: FenceOptions = {},
): Promise<FencedAttempt> {
  const lookup = await client.query<{ mission_id: string; task_id: string }>(
    `SELECT mission_id, task_id FROM coordinator.task_attempts WHERE id = $1`,
    [context.attemptId],
  );
  const found = lookup.rows[0];
  if (
    !found ||
    found.mission_id !== context.missionId ||
    found.task_id !== context.taskId
  )
    throw new FenceError(context.attemptId, 'attempt_missing');

  const lockClause =
    options.missionLock === 'update' ? 'FOR UPDATE' : 'FOR SHARE';
  const missionResult = await client.query<MissionRow>(
    `SELECT * FROM coordinator.missions WHERE id = $1 ${lockClause}`,
    [context.missionId],
  );
  const mission = missionResult.rows[0];
  if (!mission) throw new FenceError(context.attemptId, 'attempt_missing');

  const attemptResult = await client.query<AttemptRow & { lease_ok: boolean }>(
    `SELECT a.*, a.lease_expires_at > clock_timestamp() AS lease_ok
       FROM coordinator.task_attempts a WHERE a.id = $1 FOR UPDATE`,
    [context.attemptId],
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) throw new FenceError(context.attemptId, 'attempt_missing');

  const taskResult = await client.query<TaskRow>(
    `SELECT * FROM coordinator.tasks WHERE id = $1 FOR UPDATE`,
    [context.taskId],
  );
  const task = taskResult.rows[0];
  if (!task) throw new FenceError(context.attemptId, 'attempt_missing');

  if (mission.generation !== context.generation)
    throw new FenceError(
      context.attemptId,
      'generation_mismatch',
      `mission generation ${mission.generation}, context ${context.generation}`,
    );
  if (attempt.generation !== context.generation)
    throw new FenceError(context.attemptId, 'generation_mismatch');
  if (mission.status !== 'running')
    throw new FenceError(
      context.attemptId,
      'mission_not_running',
      `mission is ${mission.status}`,
    );
  if (attempt.status !== 'running' && !isMutated('ignore_fencing'))
    throw new FenceError(
      context.attemptId,
      'attempt_not_running',
      `attempt is ${attempt.status}`,
    );
  // MUTATION ignore_fencing: a stale token, an expired lease and a finished
  // attempt still publish.
  const ignoreFencing = isMutated('ignore_fencing');
  if (
    !ignoreFencing &&
    (attempt.fencing_token !== context.fencingToken ||
      task.fence_seq !== context.fencingToken)
  )
    throw new FenceError(
      context.attemptId,
      'token_mismatch',
      `token ${context.fencingToken}, attempt ${attempt.fencing_token}, task ${task.fence_seq}`,
    );
  if (!ignoreFencing && !options.ignoreLease && !attemptResult.rows[0].lease_ok)
    throw new FenceError(context.attemptId, 'lease_expired');
  const accepted = options.taskStatuses ?? ['running', 'waiting'];
  if (!accepted.includes(task.status as TaskStatus))
    throw new FenceError(
      context.attemptId,
      'task_state',
      `task is ${task.status}`,
    );
  return { mission, attempt, task };
}
