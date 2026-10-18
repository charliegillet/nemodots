import type pg from 'pg';
import type { MissionId, TaskId } from '../contracts/index.js';
import { TaskNotFoundError } from './errors.js';
import { toTask, type TaskRow } from './rows.js';
import type { Task } from '../contracts/index.js';

// Read-only task queries for the team tools.

export interface TaskStatusView {
  task: Task;
  outputUsable: boolean | null;
}

/** get_task_status: a task of the SAME mission only (model-supplied ids never select another mission). */
export async function getTaskStatus(
  db: pg.Pool | pg.PoolClient,
  missionId: MissionId,
  taskId: TaskId,
): Promise<TaskStatusView> {
  const { rows } = await db.query<TaskRow & { output_usable: boolean | null }>(
    `SELECT t.*, o.usable AS output_usable
       FROM coordinator.tasks t
       LEFT JOIN coordinator.task_outputs o ON o.id = t.output_id
      WHERE t.id = $1 AND t.mission_id = $2`,
    [taskId, missionId],
  );
  if (!rows[0]) throw new TaskNotFoundError(taskId);
  return { task: toTask(rows[0]), outputUsable: rows[0].output_usable };
}
