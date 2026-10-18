import { randomUUID } from 'node:crypto';
import { isMutated } from '../config/mutation.js';
import type pg from 'pg';
import {
  type AttemptContext,
  type AttemptId,
  type AttemptKind,
  type AttemptStatus,
  type Capability,
  type DependencyVector,
  type MissionId,
  type TaskId,
  type TaskRole,
} from '../contracts/index.js';
import { finishAttempt } from './attempts.js';
import { FenceError } from './errors.js';
import { EventBuffer } from './events.js';
import { lockFencedAttempt } from './fence.js';
import {
  iso,
  type AttemptRow,
  type MissionRow,
  type TaskRepair,
  type TaskRow,
} from './rows.js';
import {
  enqueueMissionEvaluate,
  failedAttemptCount,
  requeueTask,
  transitionTask,
  type TxCtx,
} from './tasks.js';
import { withTransaction } from '../db/tx.js';
import { resolveClosedInvalidations, releaseGate } from './recovery.js';
import type { ClaimedAttempt, CoordinatorDeps } from './types.js';

// ARCHITECTURE.md section 6: authoring leases and fencing tokens.
//   claimAttempt  CAS runnable -> leased, fence_seq + 1 = the fencing token
//   startAttempt  leased -> running
//   heartbeat     renews only while the token is current and the lease unexpired
//   reapExpired   expired running attempt -> `expired`, fence bump, task requeued
// Lock order everywhere: mission (share) -> attempt -> task.

type LeaseDeps = Pick<
  CoordinatorDeps,
  'pool' | 'config' | 'events' | 'intents'
>;

export interface ClaimOptions {
  workerId: string;
  /** Restrict to one mission (tests, targeted workers). */
  missionId?: MissionId;
  /** Restrict to one task (targeted workers, tests). */
  taskId?: TaskId;
  /** Restrict to roles the worker can handle. */
  roles?: readonly TaskRole[];
  leaseMs?: number;
}

export function attemptContextOf(
  task: Pick<TaskRow, 'mission_id' | 'id' | 'role' | 'capabilities'>,
  attemptId: string,
  fencingToken: number,
  generation: number,
): AttemptContext {
  return {
    missionId: task.mission_id as MissionId,
    taskId: task.id as TaskId,
    attemptId: attemptId as AttemptId,
    fencingToken,
    generation,
    capabilities: task.capabilities as Capability[],
    role: task.role as TaskRole,
  };
}

/**
 * Claims the next runnable task of a running mission. Missions are share-locked
 * first (so pause/cancel, which take FOR UPDATE, cannot interleave with a
 * claim), then one task is taken with FOR UPDATE SKIP LOCKED: concurrent
 * claimers never receive the same task. Returns null when nothing is runnable.
 */
export async function claimAttempt(
  deps: LeaseDeps,
  options: ClaimOptions,
): Promise<ClaimedAttempt | null> {
  const leaseMs = options.leaseMs ?? deps.config.leaseMs;
  const roles = options.roles ? [...options.roles] : null;
  return withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const missions = (
      await client.query<MissionRow>(
        `SELECT m.* FROM coordinator.missions m
          WHERE m.status = 'running'
            AND ($1::uuid IS NULL OR m.id = $1)
            AND EXISTS (
              SELECT 1 FROM coordinator.tasks t
               WHERE t.mission_id = m.id AND t.status = 'runnable'
                 AND ($2::text[] IS NULL OR t.role = ANY ($2::text[]))
                 AND ($3::uuid IS NULL OR t.id = $3))
          ORDER BY m.created_at, m.id
            FOR SHARE OF m`,
        [options.missionId ?? null, roles, options.taskId ?? null],
      )
    ).rows;
    if (missions.length === 0) return null;
    const task = (
      await client.query<TaskRow>(
        `SELECT * FROM coordinator.tasks
          WHERE mission_id = ANY ($1::uuid[]) AND status = 'runnable'
            AND ($2::text[] IS NULL OR role = ANY ($2::text[]))
            AND ($3::uuid IS NULL OR id = $3)
          ORDER BY created_at, ordinal
          LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        [missions.map((mission) => mission.id), roles, options.taskId ?? null],
      )
    ).rows[0];
    if (!task) return null;
    const mission = missions.find((item) => item.id === task.mission_id)!;

    const prior = await client.query<{ n: number }>(
      `SELECT COALESCE(max(n), 0) AS n FROM coordinator.task_attempts WHERE task_id = $1`,
      [task.id],
    );
    const n = prior.rows[0].n + 1;
    const spec: TaskRepair | null =
      task.repair && (task.repair.kind !== 'repair' || task.repair.repairOf)
        ? task.repair
        : null;
    const kind: AttemptKind = spec ? spec.kind : n === 1 ? 'initial' : 'retry';
    const inherited: DependencyVector = spec
      ? []
      : task.inherited_dependency_vector;

    const leased = await transitionTask(tx, task, 'leased', {
      reason: kind,
      repair: null,
      bumpFence: true,
      chargeAttempt: true,
    });
    const attemptId = randomUUID();
    const { rows } = await client.query<AttemptRow>(
      `INSERT INTO coordinator.task_attempts (
         id, task_id, mission_id, n, kind, status, generation, lease_owner,
         fencing_token, lease_expires_at, lease_renewed_at,
         inherited_dependency_vector, repair_of)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8,
         now() + $9 * interval '1 millisecond', now(), $10::jsonb, $11::jsonb)
       RETURNING *`,
      [
        attemptId,
        task.id,
        task.mission_id,
        n,
        kind,
        mission.generation,
        options.workerId,
        leased.fence_seq,
        leaseMs,
        JSON.stringify(inherited),
        spec?.repairOf ? JSON.stringify(spec.repairOf) : null,
      ],
    );
    const attempt = rows[0];
    tx.events.add(task.mission_id, {
      kind: 'attempt.started',
      attemptId: attempt.id as AttemptId,
      taskId: task.id as TaskId,
      n,
      attemptKind: kind,
      repairOf: spec?.repairOf
        ? {
            attemptId: spec.repairOf.attemptId as AttemptId,
            invalidationEventId: spec.repairOf.invalidationEventId as never,
          }
        : null,
      inheritedVectorSize: inherited.length,
    });
    await tx.events.flush(client);
    return {
      context: attemptContextOf(
        task,
        attempt.id,
        leased.fence_seq,
        mission.generation,
      ),
      attempt: {
        n,
        kind,
        leaseExpiresAt: iso(attempt.lease_expires_at),
        inheritedDependencyVector: inherited,
        repairOf: spec?.repairOf ?? null,
      },
      task: {
        title: task.title,
        question: task.question,
        parentId: task.parent_id as TaskId | null,
        depth: task.depth,
        maxIterations: task.budget.maxIterations,
        maxTokens: task.budget.maxTokens,
        maxChildren: task.budget.maxChildren,
      },
      mission: { goal: mission.goal, constraints: mission.constraints },
      leaseMs,
    };
  });
}

/** leased -> running; fenced like a publication. */
export async function startAttempt(
  deps: Pick<CoordinatorDeps, 'pool' | 'events'>,
  context: AttemptContext,
): Promise<void> {
  await withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const fenced = await lockFencedAttempt(client, context, {
      taskStatuses: ['leased'],
    });
    await transitionTask(tx, fenced.task, 'running', {
      reason: 'attempt_started',
    });
    await tx.events.flush(client);
  });
}

/**
 * Fenced heartbeat: renews the lease only while the attempt is running, the
 * token is the task's current token and the lease has not expired. Anything
 * else throws FenceError (a stale token never revives a taken-over attempt).
 */
export async function heartbeat(
  deps: Pick<CoordinatorDeps, 'pool' | 'config'>,
  context: AttemptContext,
  leaseMs: number = deps.config.leaseMs,
): Promise<{ leaseExpiresAt: string }> {
  const { rows } = await deps.pool.query<{ lease_expires_at: Date }>(
    `UPDATE coordinator.task_attempts a
        SET lease_expires_at = now() + $3 * interval '1 millisecond',
            lease_renewed_at = now()
       FROM coordinator.tasks t
      WHERE a.id = $1 AND t.id = a.task_id
        AND ($4::boolean OR (a.fencing_token = $2 AND a.status = 'running'
             AND a.lease_expires_at > clock_timestamp() AND t.fence_seq = $2))
      RETURNING a.lease_expires_at`,
    // MUTATION ignore_fencing ($4): any token renews any lease.
    [
      context.attemptId,
      context.fencingToken,
      leaseMs,
      isMutated('ignore_fencing'),
    ],
  );
  if (rows.length === 1)
    return { leaseExpiresAt: iso(rows[0].lease_expires_at) };
  const state = await readAttemptState(deps.pool, context.attemptId);
  if (!state) throw new FenceError(context.attemptId, 'attempt_missing');
  if (state.attemptStatus !== 'running')
    throw new FenceError(
      context.attemptId,
      'attempt_not_running',
      state.attemptStatus,
    );
  if (
    state.attemptToken !== context.fencingToken ||
    state.taskFence !== context.fencingToken
  )
    throw new FenceError(context.attemptId, 'token_mismatch');
  throw new FenceError(context.attemptId, 'lease_expired');
}

export interface AttemptState {
  attemptStatus: AttemptStatus;
  abortReason: string | null;
  attemptToken: number;
  attemptGeneration: number;
  taskFence: number;
  leaseExpired: boolean;
  missionStatus: string;
  missionGeneration: number;
}

/** One cheap read for the worker host's 250 ms abort check. */
export async function readAttemptState(
  db: pg.Pool | pg.PoolClient,
  attemptId: string,
): Promise<AttemptState | null> {
  const { rows } = await db.query<{
    status: AttemptStatus;
    abort_reason: string | null;
    fencing_token: number;
    attempt_generation: number;
    fence_seq: number;
    lease_expired: boolean;
    mission_status: string;
    mission_generation: number;
  }>(
    `SELECT a.status, a.abort_reason, a.fencing_token,
            a.generation AS attempt_generation, t.fence_seq,
            a.lease_expires_at <= clock_timestamp() AS lease_expired,
            m.status AS mission_status, m.generation AS mission_generation
       FROM coordinator.task_attempts a
       JOIN coordinator.tasks t ON t.id = a.task_id
       JOIN coordinator.missions m ON m.id = a.mission_id
      WHERE a.id = $1`,
    [attemptId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    attemptStatus: row.status,
    abortReason: row.abort_reason,
    attemptToken: row.fencing_token,
    attemptGeneration: row.attempt_generation,
    taskFence: row.fence_seq,
    leaseExpired: row.lease_expired,
    missionStatus: row.mission_status,
    missionGeneration: row.mission_generation,
  };
}

export interface ReapedAttempt {
  attemptId: AttemptId;
  taskId: TaskId;
  missionId: MissionId;
  task: 'requeued' | 'failed' | 'unchanged';
}

/** The repair spec a requeued task keeps when its attempt was a repair/replan/postcondition. */
export function carryRepair(
  attempt: Pick<AttemptRow, 'kind' | 'repair_of'>,
  reason: string,
): TaskRepair | undefined {
  if (
    attempt.kind === 'repair' ||
    attempt.kind === 'replan' ||
    attempt.kind === 'postcondition'
  )
    return { kind: attempt.kind, repairOf: attempt.repair_of, reason };
  return undefined;
}

/**
 * Takes over attempts whose lease expired: the attempt becomes `expired`, the
 * task's fence_seq is bumped (the old token is dead for every fenced
 * statement) and the task is requeued, or failed when the worker's failures
 * (failed + expired attempts) reached maxAttempts. The old worker's next
 * publication throws FenceError and writes nothing.
 */
export async function reapExpired(
  deps: LeaseDeps,
  options: { limit?: number } = {},
): Promise<ReapedAttempt[]> {
  const candidates = await deps.pool.query<{ id: string; mission_id: string }>(
    `SELECT id, mission_id FROM coordinator.task_attempts
      WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
      ORDER BY lease_expires_at LIMIT $1`,
    [options.limit ?? 50],
  );
  const reaped: ReapedAttempt[] = [];
  for (const candidate of candidates.rows) {
    const result = await withTransaction(deps.pool, async (client) => {
      const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
      const mission = (
        await client.query<MissionRow>(
          `SELECT * FROM coordinator.missions WHERE id = $1 FOR SHARE`,
          [candidate.mission_id],
        )
      ).rows[0];
      const attempt = (
        await client.query<AttemptRow>(
          `SELECT * FROM coordinator.task_attempts
            WHERE id = $1 AND status = 'running'
              AND lease_expires_at <= clock_timestamp()
              FOR UPDATE SKIP LOCKED`,
          [candidate.id],
        )
      ).rows[0];
      if (!mission || !attempt) return null;
      const task = (
        await client.query<TaskRow>(
          `SELECT * FROM coordinator.tasks WHERE id = $1 FOR UPDATE`,
          [attempt.task_id],
        )
      ).rows[0];
      await finishAttempt(tx, attempt, 'expired', {
        abortReason: 'lease_lost',
        failureReason: 'lease expired',
      });
      let outcome: ReapedAttempt['task'] = 'unchanged';
      if (
        mission.status === 'running' &&
        ['leased', 'running', 'waiting'].includes(task.status)
      ) {
        const failures = await failedAttemptCount(client, task.id);
        if (
          failures >= task.max_attempts &&
          (task.status === 'running' || task.status === 'waiting')
        ) {
          await transitionTask(tx, task, 'failed', {
            reason: 'attempts_exhausted',
            bumpFence: true,
          });
          await enqueueMissionEvaluate(client, mission.id);
          if (task.role === 'postcondition')
            await releaseGate(tx, mission.id, task.id);
          await resolveClosedInvalidations(tx, deps, mission.id);
          outcome = 'failed';
        } else {
          await requeueTask(tx, task, {
            reason: 'lease_expired',
            bumpFence: true,
            repair: carryRepair(attempt, 'retry after lease expiry'),
          });
          outcome = 'requeued';
        }
      }
      await tx.events.flush(client);
      return {
        attemptId: attempt.id as AttemptId,
        taskId: task.id as TaskId,
        missionId: mission.id as MissionId,
        task: outcome,
      } satisfies ReapedAttempt;
    });
    if (result) reaped.push(result);
  }
  return reaped;
}
