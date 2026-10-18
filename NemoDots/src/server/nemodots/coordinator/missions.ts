import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  CreateMissionRequestSchema,
  assertTransition,
  canTransition,
  digest,
  type AttemptId,
  type CreateMissionRequest,
  type Mission,
  type MissionId,
  type MissionStatus,
  type ObservationReceipt,
  type ReceiptId,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { finishAttempt, lockRunningAttempts } from './attempts.js';
import {
  AcceptanceRejectedError,
  CasConflictError,
  CoordinatorConfigError,
  MissionNotFoundError,
  MissionStateError,
  ModeMismatchError,
  OpenInvalidationsError,
} from './errors.js';
import { EventBuffer } from './events.js';
import { carryRepair } from './leases.js';
import {
  evaluateOpen,
  releaseOrphanedHolds,
  resolveScopeRule,
  scheduleReplan,
  settleStuckInvalidations,
} from './recovery.js';
import {
  toMission,
  type AttemptRow,
  type MissionRow,
  type TaskRow,
} from './rows.js';
import {
  enqueueMissionEvaluate,
  insertTask,
  lockTasks,
  promoteRunnable,
  requeueTask,
  transitionTask,
  type TxCtx,
} from './tasks.js';
import type { CoordinatorDeps } from './types.js';

// ARCHITECTURE.md 7.1: mission lifecycle. Every transition is a CAS UPDATE on
// (id, status, transition_version) after contracts/transitions.ts allows it.
//
// Pause and cancel take FOR UPDATE on the mission row. Publications hold FOR
// SHARE on it, so the exclusive lock waits for every in-flight publication and
// commit to finish and then rejects the next one (status first: attempts are
// marked aborted before any worker is signalled; cancel also bumps the
// generation, so a late fenced statement fails its generation check) (C12).

type MissionDeps = Pick<
  CoordinatorDeps,
  | 'pool'
  | 'config'
  | 'events'
  | 'intents'
  | 'actions'
  | 'providerHealthy'
  | 'probe'
>;

const MISSION_TERMINAL: readonly MissionStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export async function getMissionRow(
  db: pg.Pool | pg.PoolClient,
  missionId: string,
  options: { lock?: 'update' | 'share' } = {},
): Promise<MissionRow | null> {
  const lock =
    options.lock === 'update'
      ? ' FOR UPDATE'
      : options.lock === 'share'
        ? ' FOR SHARE'
        : '';
  const { rows } = await db.query<MissionRow>(
    `SELECT * FROM coordinator.missions WHERE id = $1${lock}`,
    [missionId],
  );
  return rows[0] ?? null;
}

async function lockMission(client: pg.PoolClient, missionId: string) {
  const mission = await getMissionRow(client, missionId, { lock: 'update' });
  if (!mission) throw new MissionNotFoundError(missionId);
  return mission;
}

export async function getMission(
  deps: Pick<MissionDeps, 'pool'>,
  missionId: MissionId,
): Promise<Mission> {
  const row = await getMissionRow(deps.pool, missionId);
  if (!row) throw new MissionNotFoundError(missionId);
  return toMission(row);
}

export interface MissionTransitionOptions {
  reason: string | null;
  failureReason?: string;
  acceptanceReceiptId?: string;
  generationBump?: boolean;
  cancellation?: Mission['cancellation'];
}

/** CAS on (id, status, transition_version). */
export async function transitionMission(
  tx: TxCtx,
  mission: MissionRow,
  to: MissionStatus,
  options: MissionTransitionOptions,
): Promise<MissionRow> {
  const from = mission.status as MissionStatus;
  assertTransition('mission', from, to);
  const { rows } = await tx.client.query<MissionRow>(
    `UPDATE coordinator.missions
        SET status = $3,
            transition_version = transition_version + 1,
            generation = generation + $4,
            started_at = CASE WHEN $3 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
            finished_at = CASE WHEN $3 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE finished_at END,
            failure_reason = COALESCE($5, failure_reason),
            acceptance_receipt_id = COALESCE($6::uuid, acceptance_receipt_id),
            cancellation = COALESCE($7::jsonb, cancellation)
      WHERE id = $1 AND status = $2 AND transition_version = $8
      RETURNING *`,
    [
      mission.id,
      from,
      to,
      options.generationBump ? 1 : 0,
      options.failureReason ?? null,
      options.acceptanceReceiptId ?? null,
      options.cancellation ? JSON.stringify(options.cancellation) : null,
      mission.transition_version,
    ],
  );
  if (rows.length === 0)
    throw new CasConflictError('mission', mission.id, from);
  tx.events.add(mission.id, {
    kind: 'mission.status',
    from,
    to,
    reason: options.reason,
  });
  return rows[0];
}

// ------------------------------------------------------------------- create

/** Server-side creation options: never part of the HTTP body or a tool input. */
export interface CreateMissionServerOptions {
  /** A registered recovery scope rule (default 'selective'); unknown fails creation. */
  recoveryScopeRule?: string;
}

export async function createMission(
  deps: Pick<MissionDeps, 'pool' | 'config' | 'events'> & {
    recoveryScopeRules?: CoordinatorDeps['recoveryScopeRules'];
  },
  request: CreateMissionRequest,
  serverOptions: CreateMissionServerOptions = {},
): Promise<Mission> {
  const parsed = CreateMissionRequestSchema.parse(request);
  // an unknown rule name fails creation (before anything is written)
  const scopeRule = resolveScopeRule(
    deps.recoveryScopeRules,
    serverOptions.recoveryScopeRule,
  ).name;
  const { config } = deps;
  if (parsed.mode !== undefined && parsed.mode !== config.mode)
    throw new ModeMismatchError(parsed.mode, config.mode);
  const id = randomUUID();
  return withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const { rows } = await client.query<MissionRow>(
      `INSERT INTO coordinator.missions (
         id, owner_id, space_id, environment, resource, goal, constraints, mode,
         status, budgets, admission_min_age_ms, provider, recovery_scope_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'created', $9::jsonb, $10, $11::jsonb, $12)
       RETURNING *`,
      [
        id,
        config.ownerId,
        config.spaceId,
        config.environment,
        config.resource,
        parsed.goal,
        JSON.stringify(parsed.constraints ?? []),
        config.mode,
        JSON.stringify(config.budgets),
        parsed.admission?.minAgeMs ?? 0,
        JSON.stringify(config.provider),
        // the recovery scope rule is recorded on the mission (D8)
        scopeRule,
      ],
    );
    const mission = toMission(rows[0]);
    tx.events.add(id, { kind: 'mission.created', mission });
    await tx.events.flush(client);
    return mission;
  });
}

// -------------------------------------------------------------------- start

/** Seeds the mission's planner task (role planner, question = the goal). */
async function seedPlannerTask(
  tx: TxCtx,
  deps: MissionDeps,
  mission: MissionRow,
) {
  const existing = await tx.client.query(
    `SELECT 1 FROM coordinator.tasks WHERE mission_id = $1 AND dedupe_key = 'planner'`,
    [mission.id],
  );
  if (existing.rows.length > 0) return;
  const defaults = deps.config.taskDefaults;
  await insertTask(tx, {
    missionId: mission.id as MissionId,
    parentId: null,
    depth: 0,
    title: 'Plan the mission',
    question: mission.goal,
    role: 'planner',
    capabilities: [],
    prerequisites: [],
    generation: mission.generation,
    budget: {
      maxIterations: 1,
      maxTokens: defaults.maxTokens,
      maxChildren: 0,
    },
    maxAttempts: defaults.maxAttempts,
    createdByModelCallId: null,
    justification: null,
    dedupeKey: 'planner',
  });
  await promoteRunnable(tx, mission.id);
}

/**
 * created -> running (seeding the planner task), or -> blocked_provider when the
 * injected providerHealthy() says the provider is unreachable. A
 * blocked_provider mission re-checks and runs once the provider is back.
 */
export async function startMission(
  deps: MissionDeps,
  missionId: MissionId,
): Promise<Mission> {
  const healthy = await deps.providerHealthy();
  return withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    let mission = await lockMission(client, missionId);
    const status = mission.status as MissionStatus;
    if (status !== 'created' && status !== 'blocked_provider')
      throw new MissionStateError(missionId, status, 'start');
    if (!healthy) {
      if (status === 'created')
        mission = await transitionMission(tx, mission, 'blocked_provider', {
          reason: 'provider_unreachable',
        });
    } else {
      if (status === 'blocked_provider')
        mission = await transitionMission(tx, mission, 'created', {
          reason: 'provider_reachable',
        });
      mission = await transitionMission(tx, mission, 'running', {
        reason: 'started',
      });
      await seedPlannerTask(tx, deps, mission);
    }
    await tx.events.flush(client);
    return toMission(mission);
  });
}

// --------------------------------------------------------------- pause / resume

export async function pauseMission(
  deps: MissionDeps,
  missionId: MissionId,
  reason = 'paused',
): Promise<Mission> {
  return withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    let mission = await lockMission(client, missionId);
    if (!canTransition('mission', mission.status as MissionStatus, 'paused'))
      throw new MissionStateError(missionId, mission.status, 'pause');
    mission = await transitionMission(tx, mission, 'paused', {
      reason: reason.slice(0, 200),
    });
    // Draining attempts are marked aborted(mission_paused) first; their tasks
    // return to the pool and are not claimable while the mission is paused.
    const running = await lockRunningAttempts(client, missionId);
    const byTask = new Map<string, AttemptRow>();
    for (const attempt of running) {
      await finishAttempt(tx, attempt, 'aborted', {
        abortReason: 'mission_paused',
      });
      byTask.set(attempt.task_id, attempt);
    }
    const tasks = await lockTasks(client, [...byTask.keys()]);
    for (const task of tasks) {
      if (!['leased', 'running', 'waiting'].includes(task.status)) continue;
      await requeueTask(tx, task, {
        reason: 'mission_paused',
        bumpFence: true,
        repair: carryRepair(byTask.get(task.id)!, 'resume after pause'),
      });
    }
    await tx.events.flush(client);
    return toMission(mission);
  });
}

export async function resumeMission(
  deps: MissionDeps,
  missionId: MissionId,
): Promise<Mission> {
  return withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const mission = await lockMission(client, missionId);
    if (mission.status !== 'paused')
      throw new MissionStateError(missionId, mission.status, 'resume');
    const next = await transitionMission(tx, mission, 'running', {
      reason: 'resumed',
    });
    await tx.events.flush(client);
    return toMission(next);
  });
}

// ----------------------------------------------------- cancel / fail (terminate)

interface TerminationResult {
  mission: MissionRow;
  abortedAttemptIds: AttemptId[];
}

/** Marks every running attempt aborted, cancels every non-terminal task, bumps the generation. */
async function terminate(
  tx: TxCtx,
  deps: Pick<MissionDeps, 'intents'>,
  mission: MissionRow,
  to: 'cancelled' | 'failed',
  reason: string,
): Promise<TerminationResult> {
  const { client } = tx;
  const running = await lockRunningAttempts(client, mission.id);
  const abortedAttemptIds: AttemptId[] = [];
  for (const attempt of running) {
    await finishAttempt(tx, attempt, 'aborted', {
      abortReason: 'mission_cancelled',
    });
    abortedAttemptIds.push(attempt.id as AttemptId);
  }
  const open = (
    await client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks
        WHERE mission_id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY id FOR UPDATE`,
      [mission.id],
    )
  ).rows;
  for (const task of open)
    await transitionTask(tx, task, 'cancelled', { reason });
  const committedEffects =
    to === 'cancelled'
      ? await deps.intents.committedEffects(client, mission.id as MissionId)
      : [];
  const updated = await transitionMission(tx, mission, to, {
    reason,
    generationBump: true,
    failureReason: to === 'failed' ? reason : undefined,
    cancellation:
      to === 'cancelled'
        ? {
            requestedAt: new Date().toISOString(),
            abortedAttemptIds,
            cancelledIntentIds: [],
            committedEffects,
          }
        : undefined,
  });
  return { mission: updated, abortedAttemptIds };
}

/**
 * cancel: exclusive lock on the mission row (waits for in-flight
 * publications), generation + 1, attempts aborted, tasks cancelled,
 * committedEffects listed. Queued intents are cancelled through the actions
 * port after the lock is released (that port takes FOR SHARE on the mission
 * itself); cancelledIntentIds is filled in by a follow-up statement. Until
 * then every admit/commit already fails its generation check.
 */
export async function cancelMission(
  deps: MissionDeps,
  missionId: MissionId,
): Promise<Mission> {
  const done = await withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const mission = await lockMission(client, missionId);
    if (!canTransition('mission', mission.status as MissionStatus, 'cancelled'))
      throw new MissionStateError(missionId, mission.status, 'cancel');
    const result = await terminate(tx, deps, mission, 'cancelled', 'cancelled');
    await tx.events.flush(client);
    return result.mission;
  });
  const cancelled = await deps.actions.cancelQueued(missionId, done.generation);
  const { rows } = await deps.pool.query<MissionRow>(
    `UPDATE coordinator.missions
        SET cancellation = jsonb_set(cancellation, '{cancelledIntentIds}', $2::jsonb)
      WHERE id = $1 AND status = 'cancelled' AND cancellation IS NOT NULL
      RETURNING *`,
    [missionId, JSON.stringify(cancelled)],
  );
  return toMission(rows[0] ?? done);
}

export async function failMission(
  deps: MissionDeps,
  missionId: MissionId,
  reason: string,
): Promise<Mission> {
  const done = await withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const mission = await lockMission(client, missionId);
    if (!canTransition('mission', mission.status as MissionStatus, 'failed'))
      throw new MissionStateError(missionId, mission.status, 'fail');
    const result = await terminate(
      tx,
      deps,
      mission,
      'failed',
      reason.slice(0, 500),
    );
    await tx.events.flush(client);
    return result.mission;
  });
  await deps.actions.cancelQueued(missionId, done.generation);
  return toMission(done);
}

// ------------------------------------------------- evaluation and acceptance

export type EvaluationOutcome =
  'unchanged' | 'awaiting_acceptance' | 'running' | 'failed';

/**
 * Completion check, driven by the outbox after a task settles or an
 * invalidation resolves:
 *  - running, a root task failed for good -> failed;
 *  - running, every task is terminal, at least one planned task succeeded and
 *    no invalidation is open -> awaiting_acceptance;
 *  - awaiting_acceptance with unfinished work (a repair was scheduled) -> running.
 */
export async function evaluateMission(
  deps: MissionDeps,
  missionId: MissionId,
): Promise<EvaluationOutcome> {
  let failedReason: string | null = null;
  const outcome = await withTransaction<EvaluationOutcome>(
    deps.pool,
    async (client) => {
      const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
      const mission = await getMissionRow(client, missionId, {
        lock: 'update',
      });
      if (!mission) throw new MissionNotFoundError(missionId);
      if (
        mission.status !== 'running' &&
        mission.status !== 'awaiting_acceptance'
      )
        return 'unchanged';
      // Liveness: a repair held behind a gate that is gone must not wait forever.
      if (mission.status === 'running')
        await releaseOrphanedHolds(tx, missionId);
      const tasks = (
        await client.query<
          Pick<TaskRow, 'id' | 'status' | 'role' | 'parent_id'>
        >(
          `SELECT id, status, role, parent_id FROM coordinator.tasks WHERE mission_id = $1`,
          [missionId],
        )
      ).rows;
      const unfinished = tasks.some(
        (task) => !['succeeded', 'failed', 'cancelled'].includes(task.status),
      );
      if (mission.status === 'awaiting_acceptance') {
        if (!unfinished) return 'unchanged';
        await transitionMission(tx, mission, 'running', {
          reason: 'work_scheduled',
        });
        await tx.events.flush(client);
        return 'running';
      }
      const failedRoot = tasks.find(
        (task) => task.parent_id === null && task.status === 'failed',
      );
      if (failedRoot) {
        failedReason = `task ${failedRoot.id} failed`;
        return 'failed';
      }
      const planned = tasks.filter(
        (task) => task.role !== 'planner' && task.role !== 'postcondition',
      );
      if (unfinished) return 'unchanged';
      // Every task is terminal. The mission must now move: it can neither
      // succeed (nothing produced a result) nor wait (nothing can change).
      if (
        planned.length > 0 &&
        !planned.some((task) => task.status === 'succeeded')
      ) {
        failedReason =
          'no_task_succeeded: every planned task ended failed or cancelled';
        return 'failed';
      }
      if (planned.length === 0) return 'unchanged';
      const open = await evaluateOpen(client, deps, missionId);
      if (open.open.length > 0) {
        // Open invalidations that only the coordinator could close, with no task
        // left to close them: schedule the missing repair, or settle them as
        // unrecoverable and fail the mission with an explicit reason.
        const stuck = open.open.filter(
          (item) => item.kind === 'task' || item.kind === 'attempt',
        );
        if (stuck.length === 0 || stuck.length < open.open.length)
          return 'unchanged';
        const settled = await settleStuckInvalidations(
          tx,
          deps,
          missionId,
          stuck,
        );
        await tx.events.flush(client);
        if (settled.scheduled > 0) {
          await enqueueMissionEvaluate(client, missionId);
          return 'running';
        }
        failedReason = `repair_not_schedulable: ${stuck.length} invalidation(s) cannot be repaired`;
        return 'failed';
      }
      await transitionMission(tx, mission, 'awaiting_acceptance', {
        reason: 'all_tasks_succeeded',
      });
      await client.query(
        `INSERT INTO coordinator.outbox (mission_id, topic, payload, dedupe_key)
         VALUES ($1, 'mission.accept', $2::jsonb, $3) ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          missionId,
          JSON.stringify({ missionId }),
          `accept:${missionId}:${mission.transition_version + 1}`,
        ],
      );
      await tx.events.flush(client);
      return 'awaiting_acceptance';
    },
  );
  if (outcome === 'failed' && failedReason) {
    await failMission(deps, missionId, failedReason);
    return 'failed';
  }
  return outcome;
}

/**
 * Maintenance safety net: running missions whose tasks are all terminal are
 * evaluated even when no mission.evaluate message is pending (a lost message,
 * a crash between the last task settling and its enqueue). Never wedge.
 */
export async function evaluateStalled(
  deps: MissionDeps,
  limit = 20,
): Promise<number> {
  const client = await deps.pool.connect();
  let ids: string[];
  try {
    ids = (
      await client.query<{ id: string }>(
        `SELECT m.id FROM coordinator.missions m
          WHERE m.status = 'running'
            AND EXISTS (SELECT 1 FROM coordinator.tasks t WHERE t.mission_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM coordinator.tasks t
                             WHERE t.mission_id = m.id
                               AND t.status NOT IN ('succeeded', 'failed', 'cancelled'))
            AND NOT EXISTS (SELECT 1 FROM coordinator.outbox o
                             WHERE o.mission_id = m.id AND o.topic = 'mission.evaluate'
                               AND o.processed_at IS NULL AND o.failed_at IS NULL)
          ORDER BY m.created_at LIMIT $1`,
        [limit],
      )
    ).rows.map((row) => row.id);
  } finally {
    client.release();
  }
  for (const id of ids) await evaluateMission(deps, id as MissionId);
  return ids.length;
}

function acceptanceVerdict(
  receipt: ObservationReceipt,
): 'pass' | 'fail' | null {
  const value = receipt.normalizedValue as { verdict?: unknown } | null;
  return value && (value.verdict === 'pass' || value.verdict === 'fail')
    ? value.verdict
    : null;
}

/**
 * Settles an awaiting_acceptance mission from an acceptance probe receipt.
 * succeeded requires: a supported `checkout.acceptance` receipt of trust
 * `probe` for this mission with verdict pass, AND zero open invalidations (D9);
 * otherwise OpenInvalidationsError / AcceptanceRejectedError and the mission
 * stays awaiting_acceptance. A failing verdict returns the mission to running
 * with a bounded replan, or fails it when no replan is possible.
 */
export async function completeAcceptance(
  deps: MissionDeps,
  missionId: MissionId,
  receipt: ObservationReceipt,
): Promise<Mission> {
  return withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    const mission = await lockMission(client, missionId);
    if (mission.status !== 'awaiting_acceptance')
      throw new MissionStateError(missionId, mission.status, 'accept');
    if (
      receipt.source.key !== 'checkout.acceptance' ||
      receipt.trust !== 'probe' ||
      receipt.status !== 'supported'
    )
      throw new AcceptanceRejectedError(
        missionId,
        'not a supported checkout.acceptance probe receipt',
      );
    if (receipt.source.scope.missionId !== missionId)
      throw new AcceptanceRejectedError(
        missionId,
        'the probe receipt belongs to another mission',
      );
    const verdict = acceptanceVerdict(receipt);
    if (verdict === null)
      throw new AcceptanceRejectedError(
        missionId,
        'the probe receipt carries no verdict',
      );
    if (verdict === 'fail') {
      const marker = digest(['acceptance-failed-v1', receipt.id]);
      const running = await transitionMission(tx, mission, 'running', {
        reason: 'acceptance_failed',
      });
      const replanned = await scheduleReplan(
        tx,
        deps,
        running,
        marker,
        'the acceptance probe failed',
      );
      if (replanned) {
        await tx.events.flush(client);
        return toMission(running);
      }
      const failed = await transitionMission(tx, running, 'failed', {
        reason: 'acceptance_failed',
        failureReason: 'the acceptance probe failed and no replan is possible',
      });
      await tx.events.flush(client);
      return toMission(failed);
    }
    const evaluation = await evaluateOpen(client, deps, missionId);
    if (evaluation.open.length > 0)
      throw new OpenInvalidationsError(
        missionId,
        evaluation.open.map((item) => item.row.event_id),
      );
    const succeeded = await transitionMission(tx, mission, 'succeeded', {
      reason: 'acceptance_passed',
      acceptanceReceiptId: receipt.id as ReceiptId,
    });
    await tx.events.flush(client);
    return toMission(succeeded);
  });
}

/** Runs the injected acceptance probe and settles the mission from its receipt. */
export async function acceptMission(
  deps: MissionDeps,
  missionId: MissionId,
): Promise<Mission> {
  if (!deps.probe)
    throw new CoordinatorConfigError(
      'no ProbePort was provided to the coordinator',
    );
  const mission = await getMission(deps, missionId);
  if (mission.status !== 'awaiting_acceptance')
    throw new MissionStateError(missionId, mission.status, 'accept');
  const receipt = await deps.probe.run(missionId);
  return completeAcceptance(deps, missionId, receipt);
}

export { MISSION_TERMINAL };
