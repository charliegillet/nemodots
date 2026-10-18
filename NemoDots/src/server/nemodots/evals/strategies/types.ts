// The recovery-scope arms. Each strategy is a RecoveryScopeRule (contracts/
// ports.ts rev3): a pure function of the closure, the direct readers and the
// scheduling graph. The coordinator applies the result identically for every
// rule (fresh reads, invalidation summary, gate coalescing, replan bounds,
// admission, events), so only the scope differs between arms.
import type {
  RecoveryScopeRule,
  RecoveryScopeTask,
  TaskId,
} from '../../contracts/index.js';
import type { StrategyName } from '../types.js';

export type { RecoveryScopeRule, RecoveryScopeTask };

export interface NamedRule extends RecoveryScopeRule {
  readonly name: StrategyName;
}

/** Tasks that can still hold, or hold, work: not failed, not cancelled. */
export const LIVE_TASK_STATUSES = new Set([
  'pending',
  'runnable',
  'leased',
  'running',
  'waiting',
  'succeeded',
  'invalidated',
  'repairing',
]);

/**
 * Scheduling descendants of `roots`: children (parentId) and dependents (tasks
 * listing a member in prerequisites), transitively. The roots are included.
 */
export function schedulingDescendants(
  roots: readonly TaskId[],
  tasks: readonly RecoveryScopeTask[],
): Set<TaskId> {
  const reached = new Set<TaskId>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as TaskId;
    for (const task of tasks) {
      if (reached.has(task.id)) continue;
      if (task.parentId === current || task.prerequisites.includes(current)) {
        reached.add(task.id);
        queue.push(task.id);
      }
    }
  }
  return reached;
}

/** Stable output order, restricted to tasks the mission actually has. */
export function inTaskOrder(
  ids: ReadonlySet<TaskId>,
  tasks: readonly RecoveryScopeTask[],
): TaskId[] {
  return tasks.filter((task) => ids.has(task.id)).map((task) => task.id);
}
