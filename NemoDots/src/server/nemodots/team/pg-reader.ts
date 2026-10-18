import type pg from 'pg';
import type {
  AttemptContext,
  DependencyVector,
  InvalidationEvent,
  MissionId,
  TaskId,
  TaskRole,
} from '../contracts/index.js';
import type { Capability } from '../contracts/index.js';
import { toReceipt } from '../ledger/receipt-store.js';
import { getReceiptRows } from '../ledger/receipt-store.js';
import { eventForMission, getInvalidationEvent } from '../ledger/queries.js';
import type { MissionRow, TaskRow } from '../coordinator/rows.js';
import { toMission } from '../coordinator/rows.js';
import type { GraphTask } from '../coordinator/plan-validation.js';
import type {
  MissionFacts,
  PlanOverviewTask,
  TaskOutputView,
  TeamReader,
} from './types.js';

// Production TeamReader over the NemoDots PostgreSQL schemas. Read-only SQL on
// coordinator.* and ledger.*; never control.* and never checkout.*. Every query
// is scoped by the mission id of the AttemptContext or of a row the caller
// already owns, so an id supplied by a model cannot reach another mission.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OutputJoinRow {
  id: string;
  task_id: string;
  task_title: string;
  task_role: string;
  kind: string;
  content: unknown;
  digest: string;
  usable: boolean;
  dependency_vector: DependencyVector;
}

function toView(row: OutputJoinRow): TaskOutputView {
  return {
    id: row.id,
    taskId: row.task_id as TaskId,
    taskTitle: row.task_title,
    role: row.task_role as TaskRole,
    kind: row.kind as TaskOutputView['kind'],
    content: row.content,
    digest: row.digest,
    usable: row.usable,
    dependencyVector: row.dependency_vector,
  };
}

const OUTPUT_SELECT = `
  SELECT o.id, o.task_id, t.title AS task_title, t.role AS task_role, o.kind,
         o.content, o.digest, o.usable, o.dependency_vector
    FROM coordinator.task_outputs o
    JOIN coordinator.tasks t ON t.id = o.task_id`;

export function createPgTeamReader(pool: pg.Pool): TeamReader {
  return {
    async mission(missionId): Promise<MissionFacts> {
      const { rows } = await pool.query<MissionRow>(
        'SELECT * FROM coordinator.missions WHERE id = $1',
        [missionId],
      );
      if (!rows[0]) throw new RangeError('mission not found');
      const mission = toMission(rows[0]);
      return {
        scope: mission.scope,
        goal: mission.goal,
        constraints: mission.constraints,
        budgets: mission.budgets,
        provider: mission.provider,
      };
    },

    async receipts(ids) {
      const valid = ids.filter((id) => UUID.test(id));
      const rows = await getReceiptRows(pool, valid);
      return [...rows.values()].map((row) => toReceipt(row));
    },

    async snapshotVector(modelCallId, context: AttemptContext) {
      if (!UUID.test(modelCallId)) return null;
      const { rows } = await pool.query<{
        dependency_vector: DependencyVector;
      }>(
        `SELECT s.dependency_vector
           FROM ledger.model_call_records m
           JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
          WHERE m.id = $1 AND m.mission_id = $2 AND m.task_id = $3 AND m.attempt_id = $4`,
        [modelCallId, context.missionId, context.taskId, context.attemptId],
      );
      return rows[0] ? rows[0].dependency_vector : null;
    },

    async invalidation(eventId, missionId): Promise<InvalidationEvent | null> {
      const event = await getInvalidationEvent(pool, eventId);
      return event ? eventForMission(event, missionId) : null;
    },

    async readSetOf(attemptId, missionId) {
      if (!UUID.test(attemptId)) return null;
      const { rows } = await pool.query<{ read_set_vector: DependencyVector }>(
        'SELECT read_set_vector FROM coordinator.task_attempts WHERE id = $1 AND mission_id = $2',
        [attemptId, missionId],
      );
      return rows[0] ? rows[0].read_set_vector : null;
    },

    async taskOutputs(missionId, outputIds) {
      const valid = outputIds.filter((id) => UUID.test(id));
      if (valid.length === 0) return [];
      const { rows } = await pool.query<OutputJoinRow>(
        `${OUTPUT_SELECT} WHERE o.mission_id = $1 AND o.id = ANY($2::uuid[]) ORDER BY o.published_at, o.id`,
        [missionId, valid],
      );
      return rows.map(toView);
    },

    async prerequisiteOutputs(missionId, taskId) {
      const { rows } = await pool.query<OutputJoinRow>(
        `${OUTPUT_SELECT}
          WHERE t.mission_id = $1
            AND t.status = 'succeeded'
            AND o.id = t.output_id
            AND t.id = ANY(COALESCE((SELECT prerequisites FROM coordinator.tasks
                                      WHERE id = $2 AND mission_id = $1), '{}'::uuid[]))
          ORDER BY t.ordinal, o.id`,
        [missionId, taskId],
      );
      return rows.map(toView);
    },

    async delegationFacts(context) {
      const [mission, tasks] = await Promise.all([
        pool.query<MissionRow>(
          'SELECT * FROM coordinator.missions WHERE id = $1',
          [context.missionId],
        ),
        pool.query<TaskRow>(
          'SELECT * FROM coordinator.tasks WHERE mission_id = $1',
          [context.missionId],
        ),
      ]);
      const budgets = mission.rows[0]?.budgets;
      const parent = tasks.rows.find((row) => row.id === context.taskId);
      if (!budgets || !parent) throw new RangeError('task not found');
      const graph: GraphTask[] = tasks.rows.map((row) => ({
        id: row.id as TaskId,
        parentId: row.parent_id as TaskId | null,
        prerequisites: row.prerequisites as TaskId[],
        status: row.status,
      }));
      return {
        parent: {
          id: parent.id as TaskId,
          role: parent.role as TaskRole,
          depth: parent.depth,
          capabilities: parent.capabilities as Capability[],
          maxChildren: parent.budget.maxChildren,
        },
        limits: {
          maxDepth: budgets.maxDepth,
          maxBreadth: budgets.maxBreadth,
          maxTasks: budgets.maxTasks,
        },
        totalTasks: tasks.rows.length,
        parentChildren: tasks.rows.filter((row) => row.parent_id === parent.id)
          .length,
        tasks: graph,
      };
    },

    async planOverview(missionId): Promise<PlanOverviewTask[]> {
      const { rows } = await pool.query<
        TaskRow & { output_usable: boolean | null }
      >(
        `SELECT t.*, o.usable AS output_usable
           FROM coordinator.tasks t
           LEFT JOIN coordinator.task_outputs o ON o.id = t.output_id
          WHERE t.mission_id = $1
          ORDER BY t.depth, t.ordinal`,
        [missionId],
      );
      return rows.map((row) => ({
        id: row.id as TaskId,
        parentId: row.parent_id as TaskId | null,
        depth: row.depth,
        title: row.title,
        role: row.role as TaskRole,
        status: row.status,
        outputUsable: row.output_usable,
        attemptCount: row.attempt_count,
      }));
    },

    async missionUsage(missionId: MissionId) {
      const { rows } = await pool.query<{ calls: string; tokens: string }>(
        `SELECT count(DISTINCT model_call_id) AS calls,
                COALESCE(sum(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens
           FROM ledger.inference_attempts
          WHERE mission_id = $1`,
        [missionId],
      );
      return {
        calls: Number(rows[0]?.calls ?? 0),
        tokens: Number(rows[0]?.tokens ?? 0),
      };
    },
  };
}
