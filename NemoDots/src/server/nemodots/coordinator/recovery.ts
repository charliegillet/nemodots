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
  type RecoveryScopeRule,
  type RecoveryScopeTask,
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
  'pool' | 'config' | 'events' | 'intents' | 'clock' | 'recoveryScopeRules'
>;

// ------------------------------------------------------------ scope rule (D8)

/**
 * The default recovery scope: today's selective closure. The interface
 * (`RecoveryScopeRule`, contracts/ports.ts) is fixed by the contract; the
 * coordinator applies the result identically for every rule, so only the
 * scope differs between evaluation arms.
 */
export const SELECTIVE_SCOPE_RULE: RecoveryScopeRule = Object.freeze({
  name: 'selective',
  select: (input: { closureTaskIds: TaskId[] }) => ({
    restartTaskIds: input.closureTaskIds,
  }),
});

export class UnknownScopeRuleError extends Error {
  constructor(readonly ruleName: string) {
    super(`recovery scope rule "${ruleName}" is not registered`);
    this.name = 'UnknownScopeRuleError';
  }
}

/** The registry the coordinator runs with: the built-in `selective` always wins. */
export function scopeRuleRegistry(
  registered?: Readonly<Record<string, RecoveryScopeRule>>,
): Record<string, RecoveryScopeRule> {
  return { ...(registered ?? {}), selective: SELECTIVE_SCOPE_RULE };
}

export function resolveScopeRule(
  registered: Readonly<Record<string, RecoveryScopeRule>> | undefined,
  name: string | null | undefined,
): RecoveryScopeRule {
  const wanted = name ?? 'selective';
  const rule = scopeRuleRegistry(registered)[wanted];
  if (!rule) throw new UnknownScopeRuleError(wanted);
  return rule;
}

/** Tasks whose own attempts read the superseded or retired receipt directly. */
async function directReaderTasks(
  client: pg.PoolClient,
  missionId: string,
  receiptId: string,
): Promise<TaskId[]> {
  const { rows } = await client.query<{ task_id: string }>(
    `SELECT DISTINCT n.task_id
       FROM ledger.dependency_edges e
       JOIN ledger.dependency_nodes n ON n.kind = 'attempt' AND n.id = e.to_id
      WHERE e.from_kind = 'receipt' AND e.from_id = $1 AND e.to_kind = 'attempt'
        AND e.kind = 'evidence' AND e.mission_id = $2 AND n.task_id IS NOT NULL
      ORDER BY n.task_id`,
    [receiptId, missionId],
  );
  return rows.map((row) => row.task_id as TaskId);
}

async function loadScopeTasks(
  client: pg.PoolClient,
  missionId: string,
): Promise<RecoveryScopeTask[]> {
  const { rows } = await client.query<{
    id: string;
    parent_id: string | null;
    role: string;
    status: string;
    prerequisites: string[];
  }>(
    `SELECT id, parent_id, role, status, prerequisites
       FROM coordinator.tasks WHERE mission_id = $1 ORDER BY ordinal`,
    [missionId],
  );
  return rows.map((row) => ({
    id: row.id as TaskId,
    parentId: row.parent_id as TaskId | null,
    prerequisites: row.prerequisites as TaskId[],
    role: row.role as RecoveryScopeTask['role'],
    status: row.status as RecoveryScopeTask['status'],
  }));
}

export interface RecoveryOptions {
  /** A root task invalidation re-invokes the planner (default true; bounded by replanCap). */
  replanOnRootInvalidation?: boolean;
  /**
   * Pauses a mission whose closure exceeded the cap (finding C14): the coarse
   * event affects every non-terminal attempt/intent, so the mission stops
   * before anything restarts. Wired to pauseMission by createCoordinator.
   */
  pauseOnClosureCap?: (missionId: MissionId) => Promise<void>;
  /**
   * Fail closed on a mission whose stamped recovery scope rule this process
   * does not know (another process created it): pause it with an explicit
   * reason. Recovery never falls back to the selective closure. Wired to
   * pauseMission by createCoordinator.
   */
  pauseOnUnknownScopeRule?: (
    missionId: MissionId,
    reason: string,
  ) => Promise<void>;
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
  open: { row: InvalidationRow; why: string; kind: OpenKind }[];
  closed: InvalidationRow[];
}

/**
 * Why an invalidation is open: recovery has not run (`unprocessed`, the sweep
 * handles it), an affected intent is still live (`intent`, the actions package
 * closes it), or the AFFECTED WORK itself is unrepaired (`attempt` / `task`):
 * nothing but the coordinator can close those, so once no task is unfinished
 * they are the ones that must be scheduled or settled as unrecoverable.
 */
export type OpenKind = 'unprocessed' | 'intent' | 'attempt' | 'task';

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
    await client.query<Pick<TaskRow, 'id' | 'status' | 'output_id'>>(
      `SELECT id, status, output_id FROM coordinator.tasks WHERE mission_id = $1`,
      [missionId],
    )
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

  // An affected attempt of a task that ended failed or cancelled can never get
  // a published repair (a replan obsoleted the task, the mission budget or the
  // task's attempts ran out): it is closed, it does not hold the event open.
  const deadTask = new Set(
    attemptRows
      .filter((row) => {
        const status = tasks.get(row.task_id)?.status;
        return status === 'failed' || status === 'cancelled';
      })
      .map((row) => row.id),
  );
  // A task that SUCCEEDED again with a usable output published after the event
  // was recorded is repaired, however its repair chain is linked (a retry of a
  // failed repair, repairs re-linked by a later event). Publication passed the
  // support check against the then-current ledger, and `usable` says it still
  // does, so the affected attempts of that task cannot hold the event open.
  const repairedSince = (attemptId: string, since: Date) => {
    const task = tasks.get(attemptTask.get(attemptId) ?? '');
    const output = task?.output_id ? outputs.get(task.output_id) : undefined;
    return (
      task?.status === 'succeeded' &&
      output !== undefined &&
      output.usable &&
      output.published_at >= since
    );
  };
  const liveAttempts = (
    event: Pick<StoredEvent, 'affected' | 'perMission' | 'missionIds'>,
    keepActions: boolean,
    since: Date,
  ) => {
    const strip = (affected: StoredEvent['affected']) => ({
      ...affected,
      attemptIds: affected.attemptIds.filter(
        (id) => !deadTask.has(id) && !repairedSince(id, since),
      ),
      actionIds: keepActions ? affected.actionIds : [],
    });
    return {
      missionIds: event.missionIds,
      affected: strip(event.affected),
      perMission: event.perMission.map((entry) => ({
        ...entry,
        affected: strip(entry.affected),
      })),
    };
  };
  const result: OpenEvaluation = { open: [], closed: [] };
  for (const row of rows) {
    let why: string | null = null;
    let kind: OpenKind = 'task';
    if (row.processed_at === null) {
      why = 'recovery has not run yet';
      kind = 'unprocessed';
    } else if (
      openInvalidation(
        liveAttempts(row.event, false, row.created_at),
        attempts,
        [],
        missionId as string,
      )
    ) {
      why = 'an affected attempt is still open';
      kind = 'attempt';
    } else if (
      openInvalidation(
        {
          ...row.event,
          affected: { ...row.event.affected, attemptIds: [] },
          perMission: row.event.perMission.map((entry) => ({
            ...entry,
            affected: { ...entry.affected, attemptIds: [] },
          })),
        },
        attempts,
        intents,
        missionId as string,
      )
    ) {
      why = 'an affected intent is still open';
      kind = 'intent';
    } else {
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
    if (why) result.open.push({ row, why, kind });
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

/**
 * Liveness (never wedge): a mission whose tasks are all terminal but whose
 * invalidations are still open has nothing left that could close them.
 *   - an affected task that SUCCEEDED but holds no usable, newer output gets a
 *     repair now while it has attempts left (`repair_scheduled`);
 *   - otherwise the invalidation is settled as unrecoverable with the explicit
 *     reason `repair_not_schedulable` (`invalidation_resolved`) and the caller
 *     fails the mission with that reason.
 * Returns what it did; only called when no task is unfinished.
 */
export async function settleStuckInvalidations(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'intents'>,
  missionId: MissionId | string,
  stuck: readonly { row: InvalidationRow; why: string }[],
): Promise<{ scheduled: number; unrecoverable: string[] }> {
  let scheduled = 0;
  const unrecoverable: string[] = [];
  for (const { row, why } of stuck) {
    const affectedTasks = new Set<string>(row.event.affected.taskIds);
    const attemptRows = (
      await tx.client.query<{ id: string; task_id: string }>(
        `SELECT id, task_id FROM coordinator.task_attempts
          WHERE mission_id = $1 AND id = ANY ($2::uuid[])`,
        [missionId, row.event.affected.attemptIds],
      )
    ).rows;
    for (const attempt of attemptRows) affectedTasks.add(attempt.task_id);
    const tasks = await lockTasks(tx.client, [...affectedTasks]);
    for (const task of tasks) {
      if (
        task.status !== 'succeeded' ||
        task.attempt_count >= task.max_attempts
      )
        continue;
      const latest = (
        await tx.client.query<{ id: string }>(
          `SELECT id FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n DESC LIMIT 1`,
          [task.id],
        )
      ).rows[0];
      if (!latest) continue;
      const spec: TaskRepair = {
        kind: task.role === 'planner' ? 'replan' : 'repair',
        repairOf: { attemptId: latest.id, invalidationEventId: row.event_id },
        reason: `unrepaired after invalidation ${row.event_id.slice(0, 16)}`,
      };
      await requeueTask(tx, task, { reason: spec.reason, repair: spec });
      await recordRecovery(tx, {
        invalidationEventId: row.event_id,
        missionId: missionId as string,
        kind: task.role === 'planner' ? 'replan_scheduled' : 'repair_scheduled',
        taskId: task.id,
        attemptId: latest.id,
        detail:
          'repair scheduled by the liveness check: every task was terminal',
      });
      scheduled += 1;
    }
    if (scheduled > 0) continue;
    const { rows } = await tx.client.query<{ resolved_at: Date }>(
      `UPDATE coordinator.invalidations SET resolved_at = now()
        WHERE event_id = $1 AND mission_id = $2 AND resolved_at IS NULL
        RETURNING resolved_at`,
      [row.event_id, missionId],
    );
    if (rows.length === 0) continue;
    unrecoverable.push(row.event_id);
    tx.events.add(missionId, {
      kind: 'invalidation.resolved',
      invalidationEventId: row.event_id as InvalidationEventId,
      resolvedAt: iso(rows[0].resolved_at),
    });
    await recordRecovery(tx, {
      invalidationEventId: row.event_id,
      missionId: missionId as string,
      kind: 'invalidation_resolved',
      detail: `repair_not_schedulable: ${why}`,
    });
  }
  return { scheduled, unrecoverable };
}

/**
 * A repair held behind a postcondition gate whose gate task is gone (cancelled
 * by a replan, failed, missing) would stay `invalidated` forever. Releases
 * every such hold. Safe to call at any time; returns how many were released.
 */
export async function releaseOrphanedHolds(
  tx: TxCtx,
  missionId: MissionId | string,
): Promise<number> {
  const gates = (
    await tx.client.query<{ gate_task_id: string }>(
      `SELECT DISTINCT i.gate_task_id
         FROM coordinator.invalidations i
         JOIN coordinator.tasks held ON held.mission_id = i.mission_id
              AND held.status = 'invalidated' AND held.repair IS NOT NULL
              AND (held.repair -> 'repairOf' ->> 'invalidationEventId') = i.event_id
        WHERE i.mission_id = $1 AND i.gate_task_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM coordinator.tasks gate
                           WHERE gate.id = i.gate_task_id
                             AND gate.status NOT IN ('succeeded', 'failed', 'cancelled'))`,
      [missionId],
    )
  ).rows;
  let released = 0;
  for (const { gate_task_id } of gates)
    released += await releaseGate(tx, missionId, gate_task_id);
  return released;
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
  /**
   * A postcondition task that holds this invalidation's repairs: the replan is
   * held behind it too (`replan_coalesced`) and released with the repairs
   * (CONTRACTS 1, revision 3 "replan coalescing").
   */
  gateTaskId: string | null = null,
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
  await requeueTask(tx, planner, {
    reason,
    repair,
    holdInvalidated: gateTaskId !== null,
  });
  await recordRecovery(tx, {
    invalidationEventId: invalidationId,
    missionId: mission.id,
    kind: gateTaskId !== null ? 'replan_coalesced' : 'replan_scheduled',
    taskId: planner.id,
    attemptId: latest.id,
    detail:
      gateTaskId !== null
        ? `replan held behind postcondition task ${gateTaskId}`
        : reason,
  });
  await enqueueMissionEvaluate(tx.client, mission.id);
  return true;
}

/**
 * A second event wants a replan while the planner is already held, runnable or
 * running one: the replan is MERGED into the pending one. Recorded explicitly
 * (replan_coalesced) so it is never dropped silently. A planner that is
 * missing or settled records nothing: no replan is pending.
 */
async function recordReplanMerge(
  tx: TxCtx,
  mission: Pick<MissionRow, 'id'>,
  invalidationId: string,
) {
  const planner = (
    await tx.client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks
        WHERE mission_id = $1 AND role = 'planner' ORDER BY ordinal LIMIT 1`,
      [mission.id],
    )
  ).rows[0];
  // A replan is pending while the planner is anything but settled: held,
  // runnable, or RUNNING one (claiming a replan clears its repair spec, so the
  // spec cannot be the test). No new replan is scheduled; the event is merged.
  if (!planner || ['succeeded', 'failed', 'cancelled'].includes(planner.status))
    return;
  const latest = (
    await tx.client.query<{ id: string }>(
      `SELECT id FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n DESC LIMIT 1`,
      [planner.id],
    )
  ).rows[0];
  await recordRecovery(tx, {
    invalidationEventId: invalidationId,
    missionId: mission.id,
    kind: 'replan_coalesced',
    taskId: planner.id,
    attemptId: latest?.id ?? null,
    detail: `merged into the replan already pending (planner ${planner.status})`,
  });
}

/**
 * The open (non-terminal) postcondition task of the mission, or a new one.
 * System-created after a verified self-write; at most one is open per mission.
 */
export async function ensurePostconditionTask(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'config'>,
  mission: MissionRow,
  key: string,
  sourceKey: string,
): Promise<{ task: TaskRow; created: boolean }> {
  const open = (
    await tx.client.query<TaskRow>(
      `SELECT * FROM coordinator.tasks
        WHERE mission_id = $1 AND role = 'postcondition'
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY ordinal LIMIT 1 FOR UPDATE`,
      [mission.id],
    )
  ).rows[0];
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
 * Task-row lock order of every recovery writer, after the mission and attempt
 * rows: the open postcondition task (the gate), then the planner, then the
 * remaining tasks by id. A publication that completes the gate already holds
 * the gate when it calls releaseGate, so gate -> planner -> others is the one
 * order all of them follow.
 */
async function lockGateAndPlanner(client: pg.PoolClient, missionId: string) {
  await client.query(
    `SELECT id FROM coordinator.tasks
      WHERE mission_id = $1 AND role = 'postcondition'
        AND status NOT IN ('succeeded', 'failed', 'cancelled')
      ORDER BY ordinal FOR UPDATE`,
    [missionId],
  );
  await client.query(
    `SELECT id FROM coordinator.tasks
      WHERE mission_id = $1 AND role = 'planner' ORDER BY ordinal FOR UPDATE`,
    [missionId],
  );
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
  await lockGateAndPlanner(tx.client, missionId as string);
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
    const replan = task.repair!.kind === 'replan';
    await requeueTask(tx, task, { reason: 'postcondition_verified' });
    await recordRecovery(tx, {
      invalidationEventId: task.repair!.repairOf!.invalidationEventId,
      missionId: missionId as string,
      kind: replan ? 'replan_scheduled' : 'repair_scheduled',
      taskId: task.id,
      attemptId: task.repair!.repairOf!.attemptId,
      detail: replan
        ? 'replan released after postcondition verification'
        : 'repair released after postcondition verification',
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

/** The recovery transaction body for one mission's copy of an event. */
export async function processInvalidation(
  tx: TxCtx,
  deps: Pick<RecoveryDeps, 'config' | 'intents' | 'recoveryScopeRules'>,
  options: RecoveryOptions,
  mission: MissionRow,
  row: InvalidationRow,
): Promise<'processed' | 'unknown_rule'> {
  const missionId = mission.id as MissionId;
  const event = row.event as StoredEvent;
  const eventId = row.event_id;
  const affected = event.affected;
  const entry = event.perMission[0];

  if (['cancelled', 'failed', 'succeeded'].includes(mission.status)) {
    await tx.client.query(
      `UPDATE coordinator.invalidations
          SET processed_at = COALESCE(processed_at, now()), resolved_at = COALESCE(resolved_at, now())
        WHERE event_id = $1 AND mission_id = $2`,
      [eventId, missionId],
    );
    return 'processed';
  }

  // The mission's stamped rule (read from the row this transaction already
  // holds; no lock upgrade) is resolved through THIS process's registry. An
  // unregistered name writes nothing and leaves the event unprocessed: the
  // caller pauses the mission with an explicit reason. Never a fallback.
  let scopeRule: RecoveryScopeRule;
  try {
    scopeRule = resolveScopeRule(
      deps.recoveryScopeRules,
      mission.recovery_scope_rule,
    );
  } catch (error) {
    if (error instanceof UnknownScopeRuleError) return 'unknown_rule';
    throw error;
  }

  if (event.closure.capped || event.reason === 'closure_cap_exceeded')
    await recordRecovery(tx, {
      invalidationEventId: eventId,
      missionId,
      kind: 'mission_paused_closure_cap',
      detail: `closure cap exceeded at ${event.closure.nodes} nodes: mission paused, coarse invalidation`,
    });

  // 1. Status first: abort affected attempts that are still running.
  const listed = await lockAttempts(tx.client, affected.attemptIds, missionId);
  const defaultTaskIds = [
    ...new Set([
      ...affected.taskIds,
      ...listed.map((attempt) => attempt.task_id),
    ]),
  ];
  // The scope rule decides WHICH tasks are restarted; everything below is the
  // same code for every rule. The built-in selective rule is the closure above
  // and costs nothing extra; any other rule is chosen by the mission's
  // recovery_scope_rule (set at creation by the server, never by a client).
  let taskIds = defaultTaskIds;
  if (scopeRule !== SELECTIVE_SCOPE_RULE) {
    const tasks = await loadScopeTasks(tx.client, missionId);
    const known = new Set<string>(tasks.map((task) => task.id));
    const decision = scopeRule.select({
      missionId,
      closureTaskIds: defaultTaskIds as TaskId[],
      directReaderTaskIds: await directReaderTasks(
        tx.client,
        missionId,
        event.oldReceiptId,
      ),
      tasks,
    });
    taskIds = [...new Set<string>(decision.restartTaskIds)].filter((id) =>
      known.has(id),
    );
  }
  const extra = taskIds.length
    ? (
        await tx.client.query<AttemptRow>(
          `SELECT * FROM coordinator.task_attempts
            WHERE task_id = ANY ($1::uuid[]) AND status = 'running'
              AND NOT (id = ANY ($2::uuid[]))
            ORDER BY id FOR UPDATE`,
          [taskIds, listed.map((attempt) => attempt.id)],
        )
      ).rows
    : [];
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

  // 2. Affected outputs and findings are no longer usable.
  const reason = `invalidated:${eventId.slice(0, 16)}`;
  await tx.client.query(
    `UPDATE coordinator.task_outputs SET usable = false, unusable_reason = $4
      WHERE mission_id = $1 AND usable
        AND (id = ANY ($2::uuid[]) OR task_id = ANY ($3::uuid[]))`,
    [missionId, affected.outputIds, taskIds, reason],
  );
  await tx.client.query(
    `UPDATE coordinator.findings SET usable = false
      WHERE mission_id = $1 AND usable
        AND (attempt_id = ANY ($2::uuid[]) OR task_id = ANY ($3::uuid[]))`,
    [missionId, touchedAttempts.map((attempt) => attempt.id), taskIds],
  );

  // 3. Repairs.
  await lockGateAndPlanner(tx.client, missionId);
  const tasks = await lockTasks(tx.client, taskIds);
  const latest = new Map<string, string>(
    taskIds.length
      ? (
          await tx.client.query<{ task_id: string; id: string }>(
            `SELECT DISTINCT ON (task_id) task_id, id FROM coordinator.task_attempts
              WHERE task_id = ANY ($1::uuid[]) ORDER BY task_id, n DESC`,
            [taskIds],
          )
        ).rows.map((item) => [item.task_id, item.id] as [string, string])
      : [],
  );
  const eligible = tasks.filter(
    (task) =>
      latest.has(task.id) &&
      (ACTIVE_FOR_REPAIR.has(task.status) ||
        task.status === 'runnable' ||
        task.status === 'repairing'),
  );

  let gate: TaskRow | null = null;
  const needsGate =
    event.selfWrite === 'verified' &&
    eligible.some((task) => task.role !== 'postcondition');
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

  let scheduledAny = false;
  for (const task of eligible) {
    if (gate && task.id === gate.id) continue;
    const attemptId = latest.get(task.id)!;
    let held = false;
    const spec: TaskRepair = {
      kind: task.role === 'planner' ? 'replan' : 'repair',
      repairOf: { attemptId, invalidationEventId: eventId },
      reason: `evidence ${event.sourceKey} changed (${event.reason})`,
    };
    const planner = task.role === 'planner';
    // A task held behind an open gate stays held whatever later event reaches
    // it (invalidated WITH a repair spec: the closure alone marks tasks
    // invalidated without one). The later event merges into the pending
    // repair / replan and is recorded; it never releases the hold, and every
    // planner run is recorded as replan_* so it counts toward the cap.
    if (task.status === 'invalidated' && task.repair) {
      await recordRecovery(tx, {
        invalidationEventId: eventId,
        missionId,
        kind: planner ? 'replan_coalesced' : 'repair_coalesced',
        taskId: task.id,
        attemptId,
        detail: `merged into the ${planner ? 'replan' : 'repair'} held behind a postcondition task`,
      });
      continue;
    }
    if (task.status === 'runnable' || task.status === 'repairing') {
      if (task.repair) {
        await recordRecovery(tx, {
          invalidationEventId: eventId,
          missionId,
          kind: planner ? 'replan_coalesced' : 'repair_coalesced',
          taskId: task.id,
          attemptId,
          detail: `a ${planner ? 'replan' : 'repair'} attempt is already scheduled for this task`,
        });
        continue;
      }
      await tx.client.query(
        `UPDATE coordinator.tasks SET repair = $2::jsonb WHERE id = $1`,
        [task.id, JSON.stringify(spec)],
      );
    } else {
      held = gate !== null && task.role !== 'postcondition';
      await requeueTask(tx, task, {
        reason: spec.reason,
        repair: spec,
        holdInvalidated: held,
      });
    }
    scheduledAny = true;
    await recordRecovery(tx, {
      invalidationEventId: eventId,
      missionId,
      kind: held
        ? planner
          ? 'replan_coalesced'
          : 'repair_coalesced'
        : planner
          ? 'replan_scheduled'
          : 'repair_scheduled',
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
    if (
      await scheduleReplan(
        tx,
        deps,
        mission,
        eventId,
        `root task invalidated by ${event.sourceKey}`,
        gate?.id ?? null,
      )
    )
      scheduledAny = true;
    else await recordReplanMerge(tx, mission, eventId);
  }

  // 5. Branches that are not affected keep running untouched.
  for (const taskId of scopeRule === SELECTIVE_SCOPE_RULE
    ? entry.preserved.taskIds
    : entry.preserved.taskIds.filter((id) => !taskIds.includes(id)))
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
  if (scheduledAny) await enqueueMissionEvaluate(tx.client, missionId);
  await resolveClosedInvalidations(tx, deps, missionId);
  return 'processed';
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
    const unknownRule = await withTransaction<string | null>(
      deps.pool,
      async (client) => {
        const tx = txCtx(client);
        const mission = await lockMissionShared(client, missionId);
        if (!mission) return null;
        const row = (
          await client.query<InvalidationRow>(
            `SELECT * FROM coordinator.invalidations
            WHERE event_id = $1 AND mission_id = $2 FOR UPDATE`,
            [eventId, missionId],
          )
        ).rows[0];
        if (!row || row.processed_at !== null) return null;
        const outcome = await processInvalidation(
          tx,
          deps,
          options,
          mission,
          row,
        );
        await tx.events.flush(client);
        return outcome === 'unknown_rule'
          ? (mission.recovery_scope_rule ?? 'selective')
          : null;
      },
    );
    // Fail closed, outside the transaction: pause with an explicit reason.
    if (unknownRule && options.pauseOnUnknownScopeRule)
      await options
        .pauseOnUnknownScopeRule(
          missionId as MissionId,
          `recovery_scope_rule_unregistered: ${unknownRule}`,
        )
        .catch((error) => {
          if (!(error instanceof MissionStateError)) throw error;
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
