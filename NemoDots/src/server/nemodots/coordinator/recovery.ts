import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  digest,
  invalidationEventId,
  openInvalidation,
  type ActionId,
  type ActionStatus,
  type Affected,
  type AttemptId,
  type DependencyVector,
  type InvalidationEvent,
  type InvalidationEventId,
  type MissionId,
  type OpenInvalidationAttempt,
  type OpenInvalidationIntent,
  type ReceiptId,
  type RecoveryEvent,
  type RecoveryKind,
  type RecoveryPort,
  type SourceKey,
  type TaskId,
} from '../contracts/index.js';
import { finishAttempt, lockAttempts } from './attempts.js';
import { EventBuffer } from './events.js';
import { withTransaction } from '../db/tx.js';
import { MissionStateError, type SupportErrorShape } from './errors.js';
import {
  iso,
  toRecovery,
  type AttemptRow,
  type InvalidationRow,
  type MissionRow,
  type RecoveryRow,
  type TaskRepair,
  type TaskRow,
} from './rows.js';
import {
  enqueueMissionEvaluate,
  insertTask,
  isTerminalTask,
  lockTaskGraph,
  lockTasks,
  promoteRunnable,
  requeueTask,
  transitionTask,
  type TxCtx,
} from './tasks.js';
import { DEFAULT_REPLAN_CAP, type CoordinatorDeps } from './types.js';

// RecoveryPort (CONTRACTS.md section 10) and everything around it: ARCHITECTURE
// 5.2 (a SupportError at publication), 5.4 (self-writes), 7.1/D9 (open
// invalidations).
//
// The ledger's closure transaction marks affected attempts `invalidated`
// (status first). Recovery then, per affected mission and in one transaction:
//   - aborts any affected attempt that is still running (status written before
//     any signal, so a late publication is rejected by the fence);
//   - marks affected outputs and findings unusable;
//   - schedules a repair attempt for every affected task (a root task also
//     schedules a bounded replan); repairs behind a verified self-write are
//     coalesced behind a postcondition task (`repair_coalesced`);
//   - records `branch_preserved` for every preserved task and `intent_blocked`
//     for affected intents the actions package already closed.
// An invalidation is closed (`invalidation_resolved`) only when every affected
// task has published a newer usable output (or ended failed/cancelled) and every
// affected attempt/intent is closed; see evaluateOpen.

type RecoveryDeps = Pick<
  CoordinatorDeps,
  'pool' | 'config' | 'events' | 'intents' | 'clock'
>;

export interface RecoveryOptions {
  /** A root task invalidation re-invokes the planner (default true; bounded by replanCap). */
  replanOnRootInvalidation?: boolean;
  /**
   * Pauses a mission whose closure exceeded the cap (finding C14): the coarse
   * event affects every non-terminal attempt/intent, so the mission stops
   * before anything restarts. Wired to pauseMission by createCoordinator.
   */
  pauseOnClosureCap?: (missionId: MissionId) => Promise<void>;
}

type StoredEvent = InvalidationEvent;
const MAX_DETAIL = 500;

// ------------------------------------------------------------------ records

export async function recordRecovery(
  tx: TxCtx,
  input: {
    invalidationEventId: string;
    missionId: string;
    kind: RecoveryKind;
    taskId?: string | null;
    attemptId?: string | null;
    newAttemptId?: string | null;
    actionId?: string | null;
    detail: string;
  },
): Promise<boolean> {
  const { rows } = await tx.client.query<RecoveryRow>(
    `INSERT INTO coordinator.recovery_events
       (id, invalidation_event_id, mission_id, kind, task_id, attempt_id,
        new_attempt_id, action_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      input.invalidationEventId,
      input.missionId,
      input.kind,
      input.taskId ?? null,
      input.attemptId ?? null,
      input.newAttemptId ?? null,
      input.actionId ?? null,
      input.detail.slice(0, MAX_DETAIL),
    ],
  );
  if (rows.length === 0) return false;
  const recovery: RecoveryEvent = toRecovery(rows[0]);
  tx.events.add(input.missionId, { kind: 'recovery.recorded', recovery });
  return true;
}

// ------------------------------------------------------------- invalidations

/** Mission-scoped copy of an event: only this mission's subset (rev2 I10). */
export function scopeInvalidationEvent(
  event: InvalidationEvent,
  missionId: MissionId,
): StoredEvent | null {
  const entry = event.perMission.find((item) => item.missionId === missionId);
  if (!entry) return null;
  return {
    ...event,
    missionIds: [missionId],
    affected: entry.affected,
    perMission: [entry],
    resolvedAt: null,
  };
}

const unionIds = <T extends string>(a: readonly T[], b: readonly T[]): T[] => [
  ...new Set([...a, ...b]),
];

function mergeAffected(a: Affected, b: Affected): Affected {
  return {
    modelCallIds: unionIds(a.modelCallIds, b.modelCallIds),
    attemptIds: unionIds(a.attemptIds, b.attemptIds),
    outputIds: unionIds(a.outputIds, b.outputIds),
    actionIds: unionIds(a.actionIds, b.actionIds),
    taskIds: unionIds(a.taskIds, b.taskIds),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Insert the mission's copy of an event, or merge into the existing row when
 * the same event id arrives again with more affected members (two attempts
 * rejected for the same stale receipt share one event id). Re-delivery of an
 * identical event is a no-op. A merge that adds members reopens the row; the
 * processing step is idempotent per member (see processInvalidation), so
 * members that already recovered are left alone.
 *
 * Race-safe: the INSERT is `ON CONFLICT DO NOTHING`, so two transactions that
 * record the same event concurrently (two rejections for one stale receipt, or
 * the watcher re-delivering an event) cannot fail with a unique violation; the
 * loser waits for the winner's commit, then locks and merges into its row.
 */
export async function upsertInvalidation(
  tx: TxCtx,
  missionId: MissionId,
  event: StoredEvent,
): Promise<InvalidationRow> {
  const inserted = await tx.client.query<InvalidationRow>(
    `INSERT INTO coordinator.invalidations
       (event_id, mission_id, event, source_key, reason, self_write)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (event_id, mission_id) DO NOTHING
     RETURNING *`,
    [
      event.id,
      missionId,
      JSON.stringify(event),
      event.sourceKey,
      event.reason,
      event.selfWrite,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await tx.client.query<InvalidationRow>(
    `SELECT * FROM coordinator.invalidations
      WHERE event_id = $1 AND mission_id = $2 FOR UPDATE`,
    [event.id, missionId],
  );
  const row = existing.rows[0];
  const stored = row.event as StoredEvent;
  const merged = mergeAffected(stored.affected, event.affected);
  const grew =
    !sameSet(merged.attemptIds, stored.affected.attemptIds) ||
    !sameSet(merged.taskIds, stored.affected.taskIds) ||
    !sameSet(merged.outputIds, stored.affected.outputIds) ||
    !sameSet(merged.actionIds, stored.affected.actionIds) ||
    !sameSet(merged.modelCallIds, stored.affected.modelCallIds);
  if (!grew) return row;
  const entry = stored.perMission[0];
  const preserved = unionIds(
    entry.preserved.taskIds,
    event.perMission[0]?.preserved.taskIds ?? [],
  ).filter((id) => !merged.taskIds.includes(id));
  const next: StoredEvent = {
    ...stored,
    affected: merged,
    perMission: [
      { ...entry, affected: merged, preserved: { taskIds: preserved } },
    ],
  };
  const { rows } = await tx.client.query<InvalidationRow>(
    `UPDATE coordinator.invalidations
        SET event = $3::jsonb, processed_at = NULL, resolved_at = NULL
      WHERE event_id = $1 AND mission_id = $2
      RETURNING *`,
    [event.id, missionId, JSON.stringify(next)],
  );
  return rows[0];
}

// ------------------------------------------------------------ open predicate

export interface OpenEvaluation {
  open: { row: InvalidationRow; why: string }[];
  closed: InvalidationRow[];
  /**
   * Ids of ledger invalidation events that name this mission but have no
   * coordinator copy yet (the watcher has not delivered them to onInvalidation).
   * The ledger closure already marked tasks/outputs, so the mission must not
   * settle until they are delivered and processed (fail closed, D9).
   */
  undelivered: string[];
}

/**
 * Ledger events that name the mission and have no coordinator copy: read-only
 * SQL on ledger.invalidation_events (the closure commits before the watcher
 * calls RecoveryPort.onInvalidation).
 */
export async function undeliveredLedgerEvents(
  client: pg.PoolClient,
  missionId: MissionId | string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT e.id FROM ledger.invalidation_events e
      WHERE e.mission_ids @> to_jsonb($1::text)
        AND NOT EXISTS (
          SELECT 1 FROM coordinator.invalidations i
           WHERE i.event_id = e.id AND i.mission_id = $1::uuid)
      ORDER BY e.created_at, e.id`,
    [missionId],
  );
  return rows.map((row) => row.id);
}

/**
 * The D9 rule. The contract helper openInvalidation() treats an affected
 * `published` or `aborted` attempt as closed; ARCHITECTURE 7.1 is stricter
 * (terminal without a published repair stays open), so on top of the helper an
 * affected task must itself be repaired: it published a usable output after the
 * invalidation was recorded, or it ended failed/cancelled. An event that was
 * recorded but not yet processed is open (fail closed).
 *
 * Two inputs are adjusted before the helper sees them, so that an event can
 * always close:
 *  - an affected `invalidated` attempt whose TASK ended failed or cancelled (a
 *    replan superseded it, or its repairs were exhausted) can never get a
 *    published successor, so it is presented as `aborted`;
 *  - the planner is a scheduling artifact (D1): its task and attempts never
 *    keep an event open (a planner affected by an event is re-planned within
 *    replanCap by processInvalidation, and that is tracked by the planner task
 *    itself being unfinished).
 */
export async function evaluateOpen(
  client: pg.PoolClient,
  deps: Pick<RecoveryDeps, 'intents'>,
  missionId: MissionId | string,
): Promise<OpenEvaluation> {
  const undelivered = await undeliveredLedgerEvents(client, missionId);
  const rows = (
    await client.query<InvalidationRow>(
      `SELECT * FROM coordinator.invalidations
        WHERE mission_id = $1 AND resolved_at IS NULL ORDER BY created_at, event_id`,
      [missionId],
    )
  ).rows;
  if (rows.length === 0) return { open: [], closed: [], undelivered };

  const attemptRows = (
    await client.query<AttemptRow>(
      `SELECT id, task_id, status, repair_of FROM coordinator.task_attempts WHERE mission_id = $1`,
      [missionId],
    )
  ).rows;
  const taskRows = (
    await client.query<Pick<TaskRow, 'id' | 'status' | 'output_id' | 'role'>>(
      `SELECT id, status, output_id, role FROM coordinator.tasks WHERE mission_id = $1`,
      [missionId],
    )
  ).rows;
  const tasks = new Map(taskRows.map((row) => [row.id, row]));
  const attemptTask = new Map(attemptRows.map((row) => [row.id, row.task_id]));
  const attempts: OpenInvalidationAttempt[] = attemptRows.map((row) => {
    const task = tasks.get(row.task_id);
    const superseded =
      row.status === 'invalidated' &&
      task !== undefined &&
      (task.status === 'failed' ||
        task.status === 'cancelled' ||
        task.role === 'planner');
    return {
      id: row.id as AttemptId,
      status: superseded
        ? 'aborted'
        : (row.status as OpenInvalidationAttempt['status']),
      repairOf: row.repair_of
        ? {
            attemptId: row.repair_of.attemptId as AttemptId,
            invalidationEventId: row.repair_of
              .invalidationEventId as InvalidationEventId,
          }
        : null,
    };
  });
  const outputRows = (
    await client.query<{ id: string; published_at: Date; usable: boolean }>(
      `SELECT id, published_at, usable FROM coordinator.task_outputs WHERE mission_id = $1`,
      [missionId],
    )
  ).rows;
  const outputs = new Map(outputRows.map((row) => [row.id, row]));

  const actionIds = [
    ...new Set(rows.flatMap((row) => row.event.affected.actionIds)),
  ];
  const intents: OpenInvalidationIntent[] = actionIds.length
    ? (await deps.intents.statuses(client, actionIds)).map((item) => ({
        id: item.id,
        status: item.status as ActionStatus,
      }))
    : [];

  const result: OpenEvaluation = { open: [], closed: [], undelivered };
  for (const row of rows) {
    let why: string | null = null;
    if (row.processed_at === null) why = 'recovery has not run yet';
    else if (
      openInvalidation(row.event, attempts, intents, missionId as string)
    )
      why = 'an affected attempt or intent is still open';
    else {
      const affectedTasks = new Set<string>(row.event.affected.taskIds);
      for (const attemptId of row.event.affected.attemptIds) {
        const taskId = attemptTask.get(attemptId);
        if (taskId) affectedTasks.add(taskId);
      }
      for (const taskId of affectedTasks) {
        const task = tasks.get(taskId);
        if (
          !task ||
          task.status === 'failed' ||
          task.status === 'cancelled' ||
          task.role === 'planner'
        )
          continue;
        const output = task.output_id ? outputs.get(task.output_id) : undefined;
        const repaired =
          task.status === 'succeeded' &&
          output !== undefined &&
          output.usable &&
          output.published_at >= row.created_at;
        if (!repaired) {
          why = `task ${taskId} is ${task.status} without a published repair`;
          break;
        }
      }
    }
    if (why) result.open.push({ row, why });
    else result.closed.push(row);
  }
  return result;
}

/** Marks closed invalidations resolved and emits invalidation.resolved / invalidation_resolved. */
export async function resolveClosedInvalidations(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'intents'>,
  missionId: MissionId | string,
): Promise<string[]> {
  const evaluation = await evaluateOpen(tx.client, deps, missionId);
  const resolved: string[] = [];
  for (const row of evaluation.closed) {
    const { rows } = await tx.client.query<{ resolved_at: Date }>(
      `UPDATE coordinator.invalidations SET resolved_at = now()
        WHERE event_id = $1 AND mission_id = $2 AND resolved_at IS NULL
        RETURNING resolved_at`,
      [row.event_id, missionId],
    );
    if (rows.length === 0) continue;
    resolved.push(row.event_id);
    tx.events.add(missionId, {
      kind: 'invalidation.resolved',
      invalidationEventId: row.event_id as InvalidationEventId,
      resolvedAt: iso(rows[0].resolved_at),
    });
    await recordRecovery(tx, {
      invalidationEventId: row.event_id,
      missionId: missionId as string,
      kind: 'invalidation_resolved',
      detail: `all ${row.event.affected.taskIds.length} affected task(s) repaired or closed`,
    });
  }
  return resolved;
}

// --------------------------------------------------------- replan, postcondition

/** replan_scheduled facts of the mission, the bound for root-invalidation and request_replan. */
async function replanCount(client: pg.PoolClient, missionId: string) {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM coordinator.recovery_events
      WHERE mission_id = $1 AND kind = 'replan_scheduled'`,
    [missionId],
  );
  return Number(rows[0].n);
}

/**
 * Re-invokes the planner: its (succeeded or invalidated) task goes back to
 * runnable with a `replan` attempt spec. Bounded by config.replanCap per
 * mission: this is the ONLY way the planner runs again, whatever triggered it
 * (a root task invalidation, request_replan, a failed acceptance, or a closure
 * that reached the planner). Returns whether a replan was scheduled.
 */
export async function scheduleReplan(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'config'>,
  mission: Pick<MissionRow, 'id'>,
  invalidationId: string,
  reason: string,
): Promise<boolean> {
  const cap = deps.config.replanCap ?? DEFAULT_REPLAN_CAP;
  const planner = (
    await tx.client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks
        WHERE mission_id = $1 AND role = 'planner' ORDER BY ordinal LIMIT 1 FOR UPDATE`,
      [mission.id],
    )
  ).rows[0];
  if (!planner || !['succeeded', 'invalidated'].includes(planner.status))
    return false;
  if ((await replanCount(tx.client, mission.id)) >= cap) return false;
  const latest = (
    await tx.client.query<{ id: string }>(
      `SELECT id FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n DESC LIMIT 1`,
      [planner.id],
    )
  ).rows[0];
  if (!latest) return false;
  const repair: TaskRepair = {
    kind: 'replan',
    repairOf: { attemptId: latest.id, invalidationEventId: invalidationId },
    reason,
  };
  await requeueTask(tx, planner, { reason, repair });
  await recordRecovery(tx, {
    invalidationEventId: invalidationId,
    missionId: mission.id,
    kind: 'replan_scheduled',
    taskId: planner.id,
    attemptId: latest.id,
    detail: reason,
  });
  await enqueueMissionEvaluate(tx.client, mission.id);
  return true;
}

/**
 * The open (non-terminal) postcondition task of the mission, or a new one.
 * System-created after a verified self-write; at most one is open per mission.
 */
/**
 * The first non-terminal postcondition task of the mission (other than
 * `exceptId`), locked. Non-terminal here means pending/runnable/leased/running/
 * waiting, the set covered by tasks_one_open_postcondition_idx.
 */
async function openPostconditionTask(
  client: pg.PoolClient,
  missionId: string,
  exceptId?: string,
): Promise<TaskRow | undefined> {
  return (
    await client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks
        WHERE mission_id = $1 AND role = 'postcondition'
          AND status IN ('pending', 'runnable', 'leased', 'running', 'waiting')
          AND ($2::uuid IS NULL OR id <> $2)
        ORDER BY ordinal LIMIT 1 FOR UPDATE`,
      [missionId, exceptId ?? null],
    )
  ).rows[0];
}

/**
 * The open (non-terminal) postcondition task of the mission, or a new one.
 * System-created after a verified self-write; at most one is open per mission.
 * The check and the insert run under the mission's task-graph lock, so two
 * concurrent recoveries (each holding only FOR SHARE on the mission row) cannot
 * both create one or collide on the ordinal.
 */
export async function ensurePostconditionTask(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'config'>,
  mission: MissionRow,
  key: string,
  sourceKey: string,
): Promise<{ task: TaskRow; created: boolean }> {
  await lockTaskGraph(tx.client, mission.id);
  const open = await openPostconditionTask(tx.client, mission.id);
  if (open) return { task: open, created: false };
  const done = (
    await tx.client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks WHERE mission_id = $1 AND dedupe_key = $2`,
      [mission.id, key],
    )
  ).rows[0];
  if (done) return { task: done, created: false };
  const defaults = deps.config.taskDefaults;
  const inserted = await insertTask(tx, {
    missionId: mission.id as MissionId,
    parentId: null,
    depth: 0,
    title: 'Verify state after a verified change',
    question: `A controlled change to ${sourceKey} was applied and verified. Observe the current state of the sources it affects and report what you observe.`,
    role: 'postcondition',
    capabilities: ['observe', 'publish_finding'],
    prerequisites: [],
    generation: mission.generation,
    budget: {
      maxIterations: defaults.maxIterations,
      maxTokens: defaults.maxTokens,
      maxChildren: 0,
    },
    maxAttempts: defaults.maxAttempts,
    createdByModelCallId: null,
    justification: null,
    repair: {
      kind: 'postcondition',
      repairOf: null,
      reason: `verified self-write on ${sourceKey}`,
    },
    dedupeKey: key,
  });
  await promoteRunnable(tx, mission.id);
  const task = (
    await tx.client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks WHERE id = $1`,
      [inserted.id],
    )
  ).rows[0];
  return { task, created: true };
}

/**
 * Releases repairs that were coalesced behind a postcondition task once that
 * task is terminal: invalidated -> repairing -> runnable.
 */
export async function releaseGate(
  tx: TxCtx,
  missionId: MissionId | string,
  gateTaskId: string,
): Promise<number> {
  const held = (
    await tx.client.query<TaskRow>(
      `SELECT t.* FROM coordinator.tasks t
        WHERE t.mission_id = $1 AND t.status = 'invalidated' AND t.repair IS NOT NULL
          AND (t.repair -> 'repairOf' ->> 'invalidationEventId') IN (
            SELECT event_id FROM coordinator.invalidations
             WHERE mission_id = $1 AND gate_task_id = $2)
        ORDER BY t.id FOR UPDATE`,
      [missionId, gateTaskId],
    )
  ).rows;
  for (const task of held) {
    await requeueTask(tx, task, { reason: 'postcondition_verified' });
    await recordRecovery(tx, {
      invalidationEventId: task.repair!.repairOf!.invalidationEventId,
      missionId: missionId as string,
      kind: 'repair_scheduled',
      taskId: task.id,
      attemptId: task.repair!.repairOf!.attemptId,
      detail: 'repair released after postcondition verification',
    });
  }
  if (held.length > 0) await enqueueMissionEvaluate(tx.client, missionId);
  return held.length;
}

const ACTIVE_FOR_REPAIR = new Set([
  'leased',
  'running',
  'waiting',
  'succeeded',
  'invalidated',
]);

const sameAffectedSets = (a: Affected, b: Affected) =>
  sameSet(a.attemptIds, b.attemptIds) &&
  sameSet(a.taskIds, b.taskIds) &&
  sameSet(a.outputIds, b.outputIds) &&
  sameSet(a.actionIds, b.actionIds) &&
  sameSet(a.modelCallIds, b.modelCallIds);

/**
 * The recovery transaction body for one mission's copy of an event.
 *
 * Lock order (shared with the publication paths, see fence.ts): mission ->
 * attempts -> tasks -> the invalidation row -> task-graph advisory lock. The
 * attempts and tasks are locked BEFORE the invalidation row, because a
 * publication holds its attempt and task when it later updates invalidation
 * rows (resolveClosedInvalidations); locking the row first would deadlock.
 *
 * Every step is idempotent per member, so processing a row again after it grew
 * (a second attempt rejected for the same receipt, a re-delivered event) never
 * disturbs a member that already recovered: outputs published after the event
 * was recorded stay usable, a task that already published a fresh output or is
 * running a fresher attempt is not requeued, and recovery facts are unique.
 */
export async function processInvalidation(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'config' | 'intents'>,
  options: RecoveryOptions,
  mission: MissionRow,
  initial: InvalidationRow,
): Promise<void> {
  const missionId = mission.id as MissionId;
  const eventId = initial.event_id;

  if (['cancelled', 'failed', 'succeeded'].includes(mission.status)) {
    await tx.client.query(
      `UPDATE coordinator.invalidations
          SET processed_at = COALESCE(processed_at, now()), resolved_at = COALESCE(resolved_at, now())
        WHERE event_id = $1 AND mission_id = $2`,
      [eventId, missionId],
    );
    return;
  }

  // 0. Locks, in the global order. The row is re-read under its lock; if it
  // grew since the caller read it, take the locks for the grown set too.
  let row = initial;
  let listed: AttemptRow[] = [];
  let extra: AttemptRow[] = [];
  let tasks: TaskRow[] = [];
  for (let round = 0; round < 3; round += 1) {
    const wanted = row.event as StoredEvent;
    listed = await lockAttempts(
      tx.client,
      wanted.affected.attemptIds,
      missionId,
    );
    const taskIds = unionIds(
      wanted.affected.taskIds,
      listed.map((attempt) => attempt.task_id as TaskId),
    );
    // Running attempts of an affected task that were not listed. Attempts that
    // started after the event was recorded read fresher evidence: left alone.
    extra = taskIds.length
      ? (
          await tx.client.query<AttemptRow>(
            `SELECT * FROM coordinator.task_attempts
              WHERE task_id = ANY ($1::uuid[]) AND status = 'running'
                AND started_at <= $3
                AND NOT (id = ANY ($2::uuid[]))
              ORDER BY id FOR UPDATE`,
            [taskIds, listed.map((attempt) => attempt.id), row.created_at],
          )
        ).rows
      : [];
    tasks = await lockTasks(tx.client, taskIds);
    const locked = (
      await tx.client.query<InvalidationRow>(
        `SELECT * FROM coordinator.invalidations
          WHERE event_id = $1 AND mission_id = $2 FOR UPDATE`,
        [eventId, missionId],
      )
    ).rows[0];
    if (!locked || locked.processed_at !== null) return;
    const settled = sameAffectedSets(
      (locked.event as StoredEvent).affected,
      wanted.affected,
    );
    row = locked;
    if (settled) break;
  }
  const event = row.event as StoredEvent;
  const affected = event.affected;
  const entry = event.perMission[0];
  const taskIds = tasks.map((task) => task.id);

  if (event.closure.capped || event.reason === 'closure_cap_exceeded')
    await recordRecovery(tx, {
      invalidationEventId: eventId,
      missionId,
      kind: 'mission_paused_closure_cap',
      detail: `closure cap exceeded at ${event.closure.nodes} nodes: mission paused, coarse invalidation`,
    });

  // 1. Status first: abort affected attempts that are still running.
  const touchedAttempts = [...listed, ...extra];
  for (const attempt of touchedAttempts) {
    if (attempt.status !== 'running') continue;
    await finishAttempt(tx, attempt, 'aborted', {
      abortReason: 'readset_invalidated',
    });
    await recordRecovery(tx, {
      invalidationEventId: eventId,
      missionId,
      kind: 'attempt_aborted',
      taskId: attempt.task_id,
      attemptId: attempt.id,
      detail: `readset invalidated: ${event.sourceKey} (${event.reason})`,
    });
  }

  // 2. Affected outputs and findings are no longer usable. Outputs the listed
  // ids name are affected by definition; outputs found through a task count
  // only when they were published before the event was recorded.
  const reason = `invalidated:${eventId.slice(0, 16)}`;
  await tx.client.query(
    `UPDATE coordinator.task_outputs SET usable = false, unusable_reason = $4
      WHERE mission_id = $1 AND usable
        AND (id = ANY ($2::uuid[])
             OR (task_id = ANY ($3::uuid[]) AND published_at <= $5))`,
    [missionId, affected.outputIds, taskIds, reason, row.created_at],
  );
  await tx.client.query(
    `UPDATE coordinator.findings SET usable = false
      WHERE mission_id = $1 AND usable
        AND (attempt_id = ANY ($2::uuid[])
             OR (task_id = ANY ($3::uuid[]) AND created_at <= $4))`,
    [missionId, touchedAttempts.map((attempt) => attempt.id), taskIds, row.created_at],
  );

  // 3. Repairs.
  const latest = new Map<string, { id: string; startedAt: Date }>(
    taskIds.length
      ? (
          await tx.client.query<{
            task_id: string;
            id: string;
            started_at: Date;
          }>(
            `SELECT DISTINCT ON (task_id) task_id, id, started_at
               FROM coordinator.task_attempts
              WHERE task_id = ANY ($1::uuid[]) ORDER BY task_id, n DESC`,
            [taskIds],
          )
        ).rows.map(
          (item) =>
            [item.task_id, { id: item.id, startedAt: item.started_at }] as [
              string,
              { id: string; startedAt: Date },
            ],
        )
      : [],
  );
  const freshOutput = new Set<string>(
    taskIds.length
      ? (
          await tx.client.query<{ id: string }>(
            `SELECT t.id FROM coordinator.tasks t
               JOIN coordinator.task_outputs o ON o.id = t.output_id
              WHERE t.id = ANY ($1::uuid[]) AND o.usable AND o.published_at >= $2`,
            [taskIds, row.created_at],
          )
        ).rows.map((item) => item.id)
      : [],
  );
  const listedAttemptIds = new Set(listed.map((attempt) => attempt.id));
  /** Already repaired, or already running on evidence newer than the event. */
  const recovered = (task: TaskRow) => {
    if (task.status === 'succeeded') return freshOutput.has(task.id);
    if (['leased', 'running', 'waiting'].includes(task.status)) {
      const attempt = latest.get(task.id);
      return (
        attempt !== undefined &&
        !listedAttemptIds.has(attempt.id) &&
        attempt.startedAt > row.created_at
      );
    }
    return false;
  };
  const eligible = tasks.filter(
    (task) =>
      latest.has(task.id) &&
      (ACTIVE_FOR_REPAIR.has(task.status) ||
        task.status === 'runnable' ||
        task.status === 'repairing') &&
      !recovered(task),
  );

  let gate: TaskRow | null = null;
  const needsGate =
    event.selfWrite === 'verified' &&
    eligible.some(
      (task) => task.role !== 'postcondition' && task.role !== 'planner',
    );
  if (needsGate) {
    const ensured = await ensurePostconditionTask(
      tx,
      deps,
      mission,
      `invalidation:${eventId}`,
      event.sourceKey,
    );
    gate = ensured.task;
    await tx.client.query(
      `UPDATE coordinator.invalidations SET gate_task_id = $3
        WHERE event_id = $1 AND mission_id = $2`,
      [eventId, missionId, gate.id],
    );
    if (ensured.created)
      await recordRecovery(tx, {
        invalidationEventId: eventId,
        missionId,
        kind: 'postcondition_scheduled',
        taskId: gate.id,
        detail: `verified self-write on ${event.sourceKey}`,
      });
  }

  for (const task of eligible) {
    if (gate && task.id === gate.id) continue;
    const attemptId = latest.get(task.id)!.id;
    // The planner is a scheduling artifact (D1): once it has published (or was
    // marked invalidated), the plan is re-made only through scheduleReplan, so
    // replanCap bounds it and the root tasks are not multiplied by repairs.
    if (
      task.role === 'planner' &&
      (task.status === 'succeeded' || task.status === 'invalidated')
    ) {
      const scheduled = await scheduleReplan(
        tx,
        deps,
        mission,
        eventId,
        `the planner's context ${event.sourceKey} changed (${event.reason})`,
      );
      // Cap reached: the plan stays as it is, and the planner task must not
      // hold the mission open in `invalidated`.
      if (!scheduled && task.status === 'invalidated')
        await transitionTask(tx, task, 'cancelled', {
          reason: 'replan_cap_reached',
        });
      continue;
    }
    let held = false;
    const spec: TaskRepair = {
      kind: task.role === 'planner' ? 'replan' : 'repair',
      repairOf: { attemptId, invalidationEventId: eventId },
      reason: `evidence ${event.sourceKey} changed (${event.reason})`,
    };
    if (task.status === 'runnable' || task.status === 'repairing') {
      if (task.repair) {
        await recordRecovery(tx, {
          invalidationEventId: eventId,
          missionId,
          kind: 'repair_coalesced',
          taskId: task.id,
          attemptId,
          detail: 'a repair attempt is already scheduled for this task',
        });
        continue;
      }
      await tx.client.query(
        `UPDATE coordinator.tasks SET repair = $2::jsonb WHERE id = $1`,
        [task.id, JSON.stringify(spec)],
      );
    } else {
      if (
        task.role === 'postcondition' &&
        (task.status === 'succeeded' || task.status === 'invalidated') &&
        (await openPostconditionTask(tx.client, missionId, task.id))
      ) {
        // At most one open postcondition task per mission: the one in flight
        // already observes the current state.
        await recordRecovery(tx, {
          invalidationEventId: eventId,
          missionId,
          kind: 'repair_coalesced',
          taskId: task.id,
          attemptId,
          detail: 'another postcondition task is already open',
        });
        continue;
      }
      held = gate !== null && task.role !== 'postcondition';
      await requeueTask(tx, task, {
        reason: spec.reason,
        repair: spec,
        holdInvalidated: held,
      });
    }
    await recordRecovery(tx, {
      invalidationEventId: eventId,
      missionId,
      kind: held ? 'repair_coalesced' : 'repair_scheduled',
      taskId: task.id,
      attemptId,
      detail: held
        ? `repair held behind postcondition task ${gate!.id}`
        : spec.reason,
    });
  }

  // 4. A root task invalidation re-invokes the planner (bounded).
  const rootAffected = eligible.some(
    (task) =>
      task.parent_id === null &&
      task.role !== 'planner' &&
      task.role !== 'postcondition',
  );
  if (
    rootAffected &&
    options.replanOnRootInvalidation !== false &&
    event.reason !== 'publication_rejected'
  ) {
    await scheduleReplan(
      tx,
      deps,
      mission,
      eventId,
      `root task invalidated by ${event.sourceKey}`,
    );
  }

  // 5. Branches that are not affected keep running untouched.
  for (const taskId of entry.preserved.taskIds)
    await recordRecovery(tx, {
      invalidationEventId: eventId,
      missionId,
      kind: 'branch_preserved',
      taskId,
      detail: `no evidence path from ${event.sourceKey}`,
    });

  // 6. Intents the actions package already closed for this invalidation.
  await recordClosedIntents(tx, deps, missionId, eventId, affected.actionIds);

  await tx.client.query(
    `UPDATE coordinator.invalidations SET processed_at = now()
      WHERE event_id = $1 AND mission_id = $2 AND processed_at IS NULL`,
    [eventId, missionId],
  );
  // Always re-evaluate: the event may have been the last thing holding the
  // mission back (also when nothing needed a repair).
  await enqueueMissionEvaluate(tx.client, missionId);
  await resolveClosedInvalidations(tx, deps, missionId);
}

async function recordClosedIntents(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'intents'>,
  missionId: string,
  eventId: string,
  actionIds: readonly string[],
) {
  if (actionIds.length === 0) return;
  for (const intent of await deps.intents.statuses(tx.client, actionIds))
    if (intent.status === 'blocked')
      await recordRecovery(tx, {
        invalidationEventId: eventId,
        missionId,
        kind: 'intent_blocked',
        actionId: intent.id,
        detail: 'intent blocked after its evidence was invalidated',
      });
}

/**
 * Publication rejected by the SupportValidator (finding C13): the attempt is
 * `invalidated` (not failed) with abortReason publication_rejected, a synthetic
 * InvalidationEvent (reason publication_rejected) is written and a repair is
 * scheduled so the next attempt re-reads instead of blindly retrying. Runs in
 * its own transaction after the rejected publication rolled back.
 */
export async function recordPublicationRejection(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'config' | 'intents'>,
  options: RecoveryOptions,
  fenced: { mission: MissionRow; attempt: AttemptRow; task: TaskRow },
  vector: DependencyVector,
  error: SupportErrorShape,
  now: Date,
): Promise<void> {
  const entry =
    vector.find((item) => item.receiptId === error.receiptId) ?? vector[0];
  if (!entry)
    throw new Error(
      'a publication without receipts cannot be support-rejected',
    );
  const missionId = fenced.mission.id as MissionId;
  await finishAttempt(tx, fenced.attempt, 'invalidated', {
    abortReason: 'publication_rejected',
    failureReason: error.reason,
  });
  const affected: Affected = {
    modelCallIds: [],
    attemptIds: [fenced.attempt.id as AttemptId],
    outputIds: [],
    actionIds: [],
    taskIds: [fenced.task.id as TaskId],
  };
  const id = invalidationEventId(
    entry.sourceKey as SourceKey,
    entry.receiptId as ReceiptId,
    null,
    'publication_rejected',
  );
  const event: StoredEvent = {
    id,
    missionIds: [missionId],
    sourceKey: entry.sourceKey,
    oldReceiptId: entry.receiptId,
    newReceiptId: null,
    reason: 'publication_rejected',
    selfWrite: 'none',
    graphVersion: 0,
    affected,
    perMission: [{ missionId, affected, preserved: { taskIds: [] } }],
    closure: { depth: 0, nodes: 1, capped: false },
    resolvedAt: null,
    createdAt: iso(now),
  };
  const row = await upsertInvalidation(tx, missionId, event);
  tx.events.add(missionId, {
    kind: 'invalidation.recorded',
    invalidationEventId: id,
    sourceKey: entry.sourceKey,
    oldReceiptId: entry.receiptId,
    newReceiptId: null,
    reason: 'publication_rejected',
    selfWrite: 'none',
    affected,
    preserved: { taskIds: [] },
    closure: event.closure,
  });
  await processInvalidation(tx, deps, options, fenced.mission, row);
}

// ------------------------------------------------------------------ factory

export interface Recovery extends RecoveryPort {
  /** Process invalidations that were recorded but not yet processed, then re-evaluate open ones. */
  sweep(): Promise<number>;
  /** Re-evaluate one mission's open invalidations (an intent settled, a repair published). */
  reevaluate(missionId: MissionId): Promise<string[]>;
  /** Event ids of invalidations that are still open for the mission (D9). */
  openInvalidations(
    client: pg.PoolClient,
    missionId: MissionId | string,
  ): Promise<string[]>;
}

export class IntentNotFoundError extends Error {
  constructor(readonly actionId: string) {
    super(`action intent ${actionId} is not known to the coordinator`);
    this.name = 'IntentNotFoundError';
  }
}

export function createRecovery(
  deps: RecoveryDeps,
  options: RecoveryOptions = {},
): Recovery {
  const txCtx = (client: pg.PoolClient): TxCtx => ({
    client,
    events: new EventBuffer(deps.events),
  });

  async function lockMissionShared(client: pg.PoolClient, missionId: string) {
    const { rows } = await client.query<MissionRow>(
      `SELECT * FROM coordinator.missions WHERE id = $1 FOR SHARE`,
      [missionId],
    );
    return rows[0] ?? null;
  }

  async function processOne(missionId: string, eventId: string) {
    await withTransaction(deps.pool, async (client) => {
      const tx = txCtx(client);
      const mission = await lockMissionShared(client, missionId);
      if (!mission) return;
      // Read without a lock: processInvalidation locks attempts and tasks first
      // and the row last (the global order), then re-checks processed_at.
      const row = (
        await client.query<InvalidationRow>(
          `SELECT * FROM coordinator.invalidations
            WHERE event_id = $1 AND mission_id = $2`,
          [eventId, missionId],
        )
      ).rows[0];
      if (!row || row.processed_at !== null) return;
      await processInvalidation(tx, deps, options, mission, row);
      await tx.events.flush(client);
    });
  }

  async function onInvalidation(event: InvalidationEvent) {
    // Phase 1: make the intent durable (also wakes the sweeper via NOTIFY).
    const missions: string[] = [];
    for (const entry of event.perMission) {
      const scoped = scopeInvalidationEvent(event, entry.missionId);
      if (!scoped) continue;
      const known = await withTransaction(deps.pool, async (client) => {
        const tx = txCtx(client);
        const mission = await lockMissionShared(client, entry.missionId);
        if (!mission) return false;
        await upsertInvalidation(tx, entry.missionId, scoped);
        await tx.events.flush(client);
        return true;
      });
      if (known) missions.push(entry.missionId);
    }
    // Phase 2: act on it. A crash between the phases is repaired by sweep().
    const capped =
      event.closure.capped || event.reason === 'closure_cap_exceeded';
    for (const missionId of missions) {
      if (capped && options.pauseOnClosureCap)
        await options
          .pauseOnClosureCap(missionId as MissionId)
          .catch((error) => {
            // already paused or finished: nothing left to pause
            if (!(error instanceof MissionStateError)) throw error;
          });
      await processOne(missionId, event.id);
    }
  }

  async function reevaluate(missionId: MissionId) {
    return withTransaction(deps.pool, async (client) => {
      const tx = txCtx(client);
      const mission = await lockMissionShared(client, missionId);
      if (!mission) return [];
      const rows = (
        await client.query<InvalidationRow>(
          `SELECT * FROM coordinator.invalidations
            WHERE mission_id = $1 AND resolved_at IS NULL AND processed_at IS NOT NULL
            ORDER BY created_at, event_id FOR UPDATE`,
          [missionId],
        )
      ).rows;
      for (const row of rows)
        await recordClosedIntents(
          tx,
          deps,
          missionId,
          row.event_id,
          row.event.affected.actionIds,
        );
      const resolved = await resolveClosedInvalidations(tx, deps, missionId);
      if (resolved.length > 0) await enqueueMissionEvaluate(client, missionId);
      await tx.events.flush(client);
      return resolved;
    });
  }

  async function sweep() {
    const pending = await deps.pool.query<{
      event_id: string;
      mission_id: string;
    }>(
      `SELECT event_id, mission_id FROM coordinator.invalidations
        WHERE processed_at IS NULL ORDER BY created_at LIMIT 50`,
    );
    for (const item of pending.rows)
      await processOne(item.mission_id, item.event_id);
    const unresolved = await deps.pool.query<{ mission_id: string }>(
      `SELECT DISTINCT mission_id FROM coordinator.invalidations
        WHERE processed_at IS NOT NULL AND resolved_at IS NULL`,
    );
    for (const item of unresolved.rows)
      await reevaluate(item.mission_id as MissionId);
    return pending.rows.length;
  }

  async function onSelfWriteSettled(
    actionId: ActionId,
    outcome: 'verified' | 'failed',
  ) {
    const intent = await deps.intents.find(deps.pool, actionId);
    if (!intent) throw new IntentNotFoundError(actionId);
    const marker = digest([`self-write-${outcome}-v1`, actionId]);
    await withTransaction(deps.pool, async (client) => {
      const tx = txCtx(client);
      const mission = await lockMissionShared(client, intent.missionId);
      if (!mission || isTerminalMission(mission.status)) return;
      if (outcome === 'verified') {
        // The acting lineage keeps its output. A postcondition attempt with
        // fresh scoped reads verifies the changed source (one per mission at a
        // time); other branches' repairs are coalesced behind it.
        const ensured = await ensurePostconditionTask(
          tx,
          deps,
          mission,
          `action:${actionId}`,
          'the changed source',
        );
        if (ensured.created) {
          await recordRecovery(tx, {
            invalidationEventId: marker,
            missionId: mission.id,
            kind: 'postcondition_scheduled',
            taskId: ensured.task.id,
            actionId,
            detail: 'verified self-write: postcondition attempt scheduled',
          });
          await enqueueMissionEvaluate(client, mission.id);
        }
      } else {
        // postcondition_mismatch: the proposing task's output rests on a change
        // that did not take effect as expected; repair it unless the closure
        // already did.
        const task = (await lockTasks(client, [intent.taskId]))[0];
        if (task && task.status === 'succeeded') {
          const attemptId = intent.attemptId;
          const spec: TaskRepair = {
            kind: 'repair',
            repairOf: { attemptId, invalidationEventId: marker },
            reason: 'self-write postcondition failed',
          };
          await requeueTask(tx, task, { reason: spec.reason, repair: spec });
          await recordRecovery(tx, {
            invalidationEventId: marker,
            missionId: mission.id,
            kind: 'repair_scheduled',
            taskId: task.id,
            attemptId,
            actionId,
            detail: spec.reason,
          });
          await enqueueMissionEvaluate(client, mission.id);
        }
      }
      await tx.events.flush(client);
    });
  }

  return {
    onInvalidation,
    onSelfWriteSettled,
    sweep,
    reevaluate,
    async openInvalidations(client, missionId) {
      const evaluation = await evaluateOpen(client, deps, missionId);
      return evaluation.open.map((item) => item.row.event_id);
    },
  };
}

const isTerminalMission = (status: string) =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';

// Re-exported for publish/leases (terminal task check).
export { isTerminalTask, transitionTask };
