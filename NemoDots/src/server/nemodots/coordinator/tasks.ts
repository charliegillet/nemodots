import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  assertTransition,
  canTransition,
  type Capability,
  type DependencyVector,
  type MissionId,
  type ModelCallId,
  type TaskId,
  type TaskRole,
  type TaskStatus,
} from '../contracts/index.js';
import { CasConflictError } from './errors.js';
import type { EventBuffer } from './events.js';
import type { TaskRepair, TaskRow } from './rows.js';

// Task persistence and the task state machine (ARCHITECTURE.md 7.2). Every
// status change is a CAS UPDATE on (id, status, transition_version) that
// first checks contracts/transitions.ts and throws CasConflictError when the
// row moved. Functions here run inside a caller-owned transaction; the caller
// holds the mission row lock (FOR SHARE or FOR UPDATE) already.

export interface TxCtx {
  client: pg.PoolClient;
  events: EventBuffer;
}

const TERMINAL: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * Serialises changes to one mission's task graph: task insertion (ordinal and
 * the "one open postcondition task" rule) and dependency promotion. Mission row
 * locks cannot do this alone: publications and recovery hold FOR SHARE, which
 * is shared, and READ COMMITTED snapshots cannot see a sibling publication's
 * uncommitted `succeeded`. Whoever takes this lock second runs its next
 * statement after the first committed, so its snapshot includes that commit.
 * Lock order: mission -> invalidation row -> attempt -> task -> task-graph lock.
 */
export async function lockTaskGraph(
  client: pg.PoolClient,
  missionId: MissionId | string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `nemodots_task_graph:${missionId}`,
  ]);
}

export interface NewTask {
  /** Pre-assigned id (plans reference tasks of the same plan before they exist). */
  id?: string;
  missionId: MissionId;
  parentId: TaskId | null;
  depth: number;
  title: string;
  question: string;
  role: TaskRole;
  capabilities: readonly Capability[];
  prerequisites: readonly TaskId[];
  generation: number;
  budget: { maxIterations: number; maxTokens: number; maxChildren: number };
  maxAttempts: number;
  createdByModelCallId: ModelCallId | null;
  justification: string | null;
  inheritedDependencyVector?: DependencyVector;
  repair?: TaskRepair | null;
  dedupeKey?: string | null;
}

/**
 * Inserts a `pending` task with the next mission-wide ordinal (taken under the
 * mission's task-graph lock, so ordinals never collide whatever mission row
 * lock the caller holds) and emits task.created. Promote it with
 * promoteRunnable.
 */
export async function insertTask(tx: TxCtx, task: NewTask): Promise<TaskRow> {
  const id = task.id ?? randomUUID();
  await lockTaskGraph(tx.client, task.missionId);
  const { rows } = await tx.client.query<TaskRow>(
    `INSERT INTO coordinator.tasks (
       id, mission_id, parent_id, depth, ordinal, title, question, role,
       capabilities, status, generation, prerequisites, max_attempts, budget,
       created_by_model_call_id, justification, inherited_dependency_vector,
       repair, dedupe_key)
     VALUES ($1, $2, $3, $4,
       (SELECT COALESCE(max(ordinal) + 1, 0) FROM coordinator.tasks WHERE mission_id = $2),
       $5, $6, $7, $8::text[], 'pending', $9, $10::uuid[], $11, $12::jsonb,
       $13, $14, $15::jsonb, $16::jsonb, $17)
     RETURNING *`,
    [
      id,
      task.missionId,
      task.parentId,
      task.depth,
      task.title,
      task.question,
      task.role,
      [...task.capabilities],
      task.generation,
      [...task.prerequisites],
      task.maxAttempts,
      JSON.stringify(task.budget),
      task.createdByModelCallId,
      task.justification,
      JSON.stringify(task.inheritedDependencyVector ?? []),
      task.repair ? JSON.stringify(task.repair) : null,
      task.dedupeKey ?? null,
    ],
  );
  const row = rows[0];
  tx.events.add(task.missionId, {
    kind: 'task.created',
    task: {
      id: row.id as TaskId,
      parentId: row.parent_id as TaskId | null,
      depth: row.depth,
      title: row.title,
      role: row.role as TaskRole,
      capabilities: row.capabilities as Capability[],
      prerequisites: row.prerequisites as TaskId[],
      justification: row.justification,
      createdByModelCallId: row.created_by_model_call_id as ModelCallId | null,
    },
  });
  return row;
}

export interface TaskTransitionOptions {
  reason: string | null;
  /** undefined = leave unchanged, null = clear */
  repair?: TaskRepair | null;
  bumpFence?: boolean;
  /** Count this claim in attempt_count (claim only). */
  chargeAttempt?: boolean;
  outputId?: string;
}

/**
 * CAS `task.status`: from the status of the row we hold to `to`, bumping
 * transition_version. finished_at is stamped on terminal statuses and cleared
 * when a succeeded task is invalidated.
 */
export async function transitionTask(
  tx: TxCtx,
  task: TaskRow,
  to: TaskStatus,
  options: TaskTransitionOptions,
): Promise<TaskRow> {
  const from = task.status as TaskStatus;
  assertTransition('task', from, to);
  const sets = [
    'status = $3',
    'transition_version = transition_version + 1',
    `finished_at = CASE WHEN $3 IN ('succeeded','failed','cancelled') THEN now()
                        WHEN $2 = 'succeeded' THEN NULL ELSE finished_at END`,
  ];
  const values: unknown[] = [task.id, from, to];
  if (options.repair !== undefined) {
    values.push(options.repair ? JSON.stringify(options.repair) : null);
    sets.push(`repair = $${values.length}::jsonb`);
  }
  if (options.bumpFence) sets.push('fence_seq = fence_seq + 1');
  if (options.chargeAttempt) sets.push('attempt_count = attempt_count + 1');
  if (options.outputId) {
    values.push(options.outputId);
    sets.push(`output_id = $${values.length}`);
  }
  values.push(task.transition_version);
  const { rows } = await tx.client.query<TaskRow>(
    `UPDATE coordinator.tasks SET ${sets.join(', ')}
      WHERE id = $1 AND status = $2 AND transition_version = $${values.length}
      RETURNING *`,
    values,
  );
  if (rows.length === 0) throw new CasConflictError('task', task.id, from);
  tx.events.add(task.mission_id, {
    kind: 'task.status',
    taskId: task.id as TaskId,
    from,
    to,
    reason: options.reason,
  });
  return rows[0];
}

/**
 * Settles the dependency edges of a mission's pending tasks, under the task
 * graph lock:
 *  - pending -> runnable when every prerequisite succeeded;
 *  - pending -> cancelled (reason `prerequisite_failed`) when a prerequisite
 *    ended failed or cancelled, repeated until no more cascade, so a task that
 *    can never become runnable does not stay pending forever.
 * Every completing or failing publication calls it, and evaluateMission and the
 * maintenance sweep call it again, so a promotion that raced a sibling's commit
 * is never lost. Returns the ids promoted to runnable.
 */
export async function promoteRunnable(
  tx: TxCtx,
  missionId: MissionId | string,
): Promise<string[]> {
  await lockTaskGraph(tx.client, missionId);
  const promoted: string[] = [];
  for (let round = 0; round < 64; round += 1) {
    const { rows } = await tx.client.query<{ id: string }>(
      `UPDATE coordinator.tasks t
          SET status = 'runnable', transition_version = t.transition_version + 1
        WHERE t.id IN (
          SELECT c.id FROM coordinator.tasks c
           WHERE c.mission_id = $1 AND c.status = 'pending'
             AND NOT EXISTS (
               SELECT 1 FROM coordinator.tasks p
                WHERE p.id = ANY (c.prerequisites) AND p.status <> 'succeeded')
           ORDER BY c.id
             FOR UPDATE)
        RETURNING t.id`,
      [missionId],
    );
    for (const row of rows)
      tx.events.add(missionId, {
        kind: 'task.status',
        taskId: row.id as TaskId,
        from: 'pending',
        to: 'runnable',
        reason: 'prerequisites_succeeded',
      });
    promoted.push(...rows.map((row) => row.id));
    const cancelled = await tx.client.query<{ id: string }>(
      `UPDATE coordinator.tasks t
          SET status = 'cancelled', transition_version = t.transition_version + 1,
              finished_at = now()
        WHERE t.id IN (
          SELECT c.id FROM coordinator.tasks c
           WHERE c.mission_id = $1 AND c.status = 'pending'
             AND EXISTS (
               SELECT 1 FROM coordinator.tasks p
                WHERE p.id = ANY (c.prerequisites)
                  AND p.status IN ('failed', 'cancelled'))
           ORDER BY c.id
             FOR UPDATE)
        RETURNING t.id`,
      [missionId],
    );
    for (const row of cancelled.rows)
      tx.events.add(missionId, {
        kind: 'task.status',
        taskId: row.id as TaskId,
        from: 'pending',
        to: 'cancelled',
        reason: 'prerequisite_failed',
      });
    if (cancelled.rows.length === 0) break;
  }
  return promoted;
}

export interface RequeueOptions {
  reason: string;
  repair?: TaskRepair | null;
  bumpFence?: boolean;
  /** Stop after `invalidated` (repairs coalesced behind a postcondition). */
  holdInvalidated?: boolean;
}

/**
 * Returns an in-flight task to the runnable pool. `leased -> runnable` is a
 * single legal edge. `running`/`waiting -> runnable` is not in
 * contracts/transitions.ts (pending a lead ruling), so the task goes through
 * the legal recovery path `invalidated -> repairing -> runnable`; if the
 * contract later gains the direct edge this uses it. Tasks in other states are
 * returned unchanged.
 */
export async function requeueTask(
  tx: TxCtx,
  task: TaskRow,
  options: RequeueOptions,
): Promise<TaskRow> {
  const status = task.status as TaskStatus;
  const repair = options.repair;
  if (status === 'leased' || status === 'repairing') {
    return transitionTask(tx, task, 'runnable', {
      reason: options.reason,
      repair,
      bumpFence: options.bumpFence,
    });
  }
  if (status === 'running' || status === 'waiting') {
    if (!options.holdInvalidated && canTransition('task', status, 'runnable'))
      return transitionTask(tx, task, 'runnable', {
        reason: options.reason,
        repair,
        bumpFence: options.bumpFence,
      });
    const invalidated = await transitionTask(tx, task, 'invalidated', {
      reason: options.reason,
      repair,
      bumpFence: options.bumpFence,
    });
    return options.holdInvalidated
      ? invalidated
      : requeueTask(tx, invalidated, { ...options, bumpFence: false });
  }
  if (status === 'succeeded') {
    const invalidated = await transitionTask(tx, task, 'invalidated', {
      reason: options.reason,
      repair,
    });
    return options.holdInvalidated
      ? invalidated
      : requeueTask(tx, invalidated, options);
  }
  if (status === 'invalidated') {
    if (options.holdInvalidated) return task;
    const repairing = await transitionTask(tx, task, 'repairing', {
      reason: options.reason,
      repair,
    });
    return transitionTask(tx, repairing, 'runnable', {
      reason: options.reason,
    });
  }
  return task;
}

export async function lockTasks(
  client: pg.PoolClient,
  ids: readonly string[],
): Promise<TaskRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<TaskRow>(
    `SELECT * FROM coordinator.tasks WHERE id = ANY ($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...ids]],
  );
  return rows;
}

export async function getTask(
  client: pg.PoolClient | pg.Pool,
  taskId: string,
  options: { lock?: boolean } = {},
): Promise<TaskRow | null> {
  const { rows } = await client.query<TaskRow>(
    `SELECT * FROM coordinator.tasks WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [taskId],
  );
  return rows[0] ?? null;
}

export const isTerminalTask = (status: string) =>
  (TERMINAL as readonly string[]).includes(status);

/** Number of attempts that count against maxAttempts: the worker's failures. */
export async function failedAttemptCount(
  client: pg.PoolClient,
  taskId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM coordinator.task_attempts
      WHERE task_id = $1 AND status IN ('failed', 'expired')`,
    [taskId],
  );
  return Number(rows[0].n);
}

/** Enqueue a mission re-evaluation (completion / failure) after a task settles. */
export async function enqueueMissionEvaluate(
  client: pg.PoolClient,
  missionId: MissionId | string,
): Promise<void> {
  await client.query(
    `INSERT INTO coordinator.outbox (mission_id, topic, payload)
     VALUES ($1, 'mission.evaluate', $2::jsonb)`,
    [missionId, JSON.stringify({ missionId })],
  );
}
