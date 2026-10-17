import type { AttemptNode, TaskNode } from '../mission-events';
import { humanize, plural } from '../format';
import { Panel, type PanelState } from './Panel';
import { StatusPill } from './StatusPill';

interface TreeNode {
  task: TaskNode;
  children: TreeNode[];
}

/** Roots first; orphans (unknown parent) and cycle members are promoted to roots. */
export function buildTaskTree(tasks: readonly TaskNode[]): TreeNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenOf = new Map<string, TaskNode[]>();
  const roots: TaskNode[] = [];
  for (const task of tasks) {
    if (task.parentId && byId.has(task.parentId) && task.parentId !== task.id) {
      const list = childrenOf.get(task.parentId) ?? [];
      list.push(task);
      childrenOf.set(task.parentId, list);
    } else roots.push(task);
  }
  const order = (list: TaskNode[]) =>
    list
      .map((task, index) => ({ task, index }))
      .sort(
        (a, b) =>
          (a.task.ordinal ?? Number.MAX_SAFE_INTEGER) -
            (b.task.ordinal ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
      )
      .map(({ task }) => task);
  const visited = new Set<string>();
  const build = (task: TaskNode): TreeNode => {
    visited.add(task.id);
    return {
      task,
      children: order(childrenOf.get(task.id) ?? [])
        .filter((child) => !visited.has(child.id))
        .map(build),
    };
  };
  const tree = order(roots).map(build);
  for (const task of tasks) if (!visited.has(task.id)) tree.push(build(task));
  return tree;
}

function Row({
  node,
  attempts,
  selectedTaskId,
  onSelectTask,
}: {
  node: TreeNode;
  attempts: readonly AttemptNode[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
}) {
  const { task } = node;
  const own = attempts.filter((attempt) => attempt.taskId === task.id);
  const repairs = own.filter((attempt) => attempt.repairOf !== null).length;
  const body = (
    <>
      <span className="nd-task-title">{task.title}</span>
      {task.role && <span className="nd-task-role">{humanize(task.role)}</span>}
      <StatusPill status={task.status} />
      {own.length > 0 && (
        <span className="nd-task-meta">
          {plural(own.length, 'attempt')}
          {repairs > 0 ? `, ${plural(repairs, 'repair')}` : ''}
        </span>
      )}
      {!task.known && (
        <span className="nd-task-meta">details not received yet</span>
      )}
    </>
  );
  return (
    <li className="nd-task" data-depth={task.depth}>
      {onSelectTask ? (
        <button
          type="button"
          className="nd-task-row"
          aria-current={selectedTaskId === task.id ? 'true' : undefined}
          onClick={() => onSelectTask(task.id)}
        >
          {body}
        </button>
      ) : (
        <div
          className="nd-task-row"
          aria-current={selectedTaskId === task.id ? 'true' : undefined}
        >
          {body}
        </div>
      )}
      {node.children.length > 0 && (
        <ul
          className="nd-task-children"
          aria-label={`Subtasks of ${task.title}`}
        >
          {node.children.map((child) => (
            <Row
              key={child.task.id}
              node={child}
              attempts={attempts}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TaskTree({
  tasks,
  attempts = [],
  selectedTaskId,
  onSelectTask,
  loading,
  error,
}: PanelState & {
  tasks: readonly TaskNode[];
  attempts?: readonly AttemptNode[];
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string) => void;
}) {
  return (
    <Panel
      title="Task tree"
      className="nd-task-tree"
      loading={loading}
      error={error}
      empty={tasks.length === 0}
      emptyText="No tasks yet. The planner has not produced a plan."
    >
      <ul className="nd-task-list" aria-label="Tasks">
        {buildTaskTree(tasks).map((node) => (
          <Row
            key={node.task.id}
            node={node}
            attempts={attempts}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
          />
        ))}
      </ul>
    </Panel>
  );
}
