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
  type RecoveryEventId,
  type RecoveryKind,
  type RecoveryPort,
  type SourceKey,
  type TaskId,
} from '../contracts/index.js';
import { finishAttempt, lockAttempts } from './attempts.js';
import { EventBuffer } from './events.js';
import { withTransaction } from '../db/tx.js';
import type { SupportErrorShape } from './errors.js';
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
 * identical event is a no-op. A merge that adds members reopens the row.
 */
export async function upsertInvalidation(
  tx: TxCtx,
  missionId: MissionId,
  event: StoredEvent,
): Promise<InvalidationRow> {
  const existing = await tx.client.query<InvalidationRow>(
    `SELECT * FROM coordinator.invalidations
      WHERE event_id = $1 AND mission_id = $2 FOR UPDATE`,
    [event.id, missionId],
  );
  if (existing.rows.length === 0) {
    const { rows } = await tx.client.query<InvalidationRow>(
      `INSERT INTO coordinator.invalidations
         (event_id, mission_id, event, source_key, reason, self_write)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
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
    return rows[0];
  }
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
    perMission: [{ ...entry, affected: merged, preserved: { taskIds: preserved } }],
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

interface OpenEvaluation {
  open: { row: InvalidationRow; why: string }[];
  closed: InvalidationRow[];
}

/**
 * The D9 rule. The contract helper openInvalidation() treats an affected
 * `published` or `aborted` attempt as closed; ARCHITECTURE 7.1 is stricter
 * (terminal without a published repair stays open), so on top of the helper an
 * affected task must itself be repaired: it published a usable output after the
 * invalidation was recorded, or it ended failed/cancelled. An event that was
 * recorded but not yet processed is open (fail closed).
 */
export async function evaluateOpen(
  client: pg.PoolClient,
  deps: Pick<RecoveryDeps, 'intents'>,
  missionId: MissionId | string,
): Promise<OpenEvaluation> {
  const rows = (
    await client.query<InvalidationRow>(
      `SELECT * FROM coordinator.invalidations
        WHERE mission_id = $1 AND resolved_at IS NULL ORDER BY created_at, event_id`,
      [missionId],
    )
  ).rows;
  if (rows.length === 0) return { open: [], closed: [] };

  const attemptRows = (
    await client.query<AttemptRow>(
      `SELECT id, task_id, status, repair_of FROM coordinator.task_attempts WHERE mission_id = $1`,
      [missionId],
    )
  ).rows;
  const attempts: OpenInvalidationAttempt[] = attemptRows.map((row) => ({
    id: row.id as AttemptId,
    status: row.status as OpenInvalidationAttempt['status'],
    repairOf: row.repair_of
      ? {
          attemptId: row.repair_of.attemptId as AttemptId,
          invalidationEventId: row.repair_of
            .invalidationEventId as InvalidationEventId,
        }
      : null,
  }));
  const attemptTask = new Map(attemptRows.map((row) => [row.id, row.task_id]));
  const taskRows = (
    await client.query<
      Pick<TaskRow, 'id' | 'status' | 'output_id'>
    >(`SELECT id, status, output_id FROM coordinator.tasks WHERE mission_id = $1`, [
      missionId,
    ])
  ).rows;
  const tasks = new Map(taskRows.map((row) => [row.id, row]));
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

  const result: OpenEvaluation = { open: [], closed: [] };
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
        if (!task || task.status === 'failed' || task.status === 'cancelled')
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
 * Re-invokes the planner: its (succeeded) task goes back to runnable with a
 * `replan` attempt spec. Bounded by config.replanCap per mission. Returns
 * whether a replan was scheduled.
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
  if (!planner || planner.status !== 'succeeded') return false;
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

