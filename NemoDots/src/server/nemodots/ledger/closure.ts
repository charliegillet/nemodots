// Pure invalidation-closure logic (ARCHITECTURE.md section 5.2, CONTRACTS.md
// section 6). No I/O: invalidation.ts feeds it what the recursive CTE returned
// and the tests feed it hand-drawn graphs.
//
// Rules (frozen with the acceptance oracle):
//   R1 the closure of a receipt is every node reachable from it over
//      `evidence` and `inheritance` edges; `scheduling` edges never propagate.
//   R2 a task is affected iff one of its attempts is affected (or the task is
//      itself a reached node).
//   R3 the preserved tasks of a mission are its tasks minus its affected tasks.
//   R5 only missions with at least one affected node get a per-mission entry.
//   R6 the closure is conservative: a node resting on two receipts is affected
//      when either changes (v1 has no representation of independent support).
import type { Affected, EdgeKind } from '../contracts/index.js';

export const CLOSURE_LIMITS = Object.freeze({ maxDepth: 64, maxNodes: 10_000 });

export type ClosureLimits = { maxDepth: number; maxNodes: number };

export const GRAPH_NODE_KINDS = [
  'receipt',
  'model_call',
  'attempt',
  'task_output',
  'task',
  'action_intent',
] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

/** Edge kinds the closure follows. */
export const PROPAGATING_EDGE_KINDS = ['evidence', 'inheritance'] as const;

export interface GraphEdgeRecord {
  kind: EdgeKind;
  fromKind: GraphNodeKind;
  fromId: string;
  toKind: GraphNodeKind;
  toId: string;
}

export interface NodeMeta {
  kind: GraphNodeKind;
  id: string;
  /** null for receipts (shared across missions). */
  missionId: string | null;
  taskId: string | null;
}

export interface ReachedNode {
  kind: GraphNodeKind;
  id: string;
  /** Shortest path length from the root (informational). */
  depth: number;
}

export type TraversalResult = {
  nodes: ReachedNode[];
  /** Longest path (edges) from the root, bounded by maxDepth + 1. */
  depth: number;
  exceeded: null | 'depth' | 'nodes';
};

const nodeKey = (kind: string, id: string) => `${kind}:${id}`;

/**
 * Reference traversal with the exact semantics of the recursive CTE in
 * invalidation.ts: dedupe by node for the node cap, by (node, depth) for the
 * depth cap, evidence and inheritance edges only. Used by the unit tests and
 * as the oracle the integration tests compare the SQL against.
 */
export function traverseClosure(
  edges: readonly GraphEdgeRecord[],
  root: { kind: GraphNodeKind; id: string },
  limits: ClosureLimits = CLOSURE_LIMITS,
): TraversalResult {
  const successors = new Map<string, GraphEdgeRecord[]>();
  for (const edge of edges) {
    if (edge.kind === 'scheduling') continue;
    const key = nodeKey(edge.fromKind, edge.fromId);
    const list = successors.get(key);
    if (list) list.push(edge);
    else successors.set(key, [edge]);
  }
  const shortest = new Map<string, ReachedNode>();
  let frontier = new Map<string, { kind: GraphNodeKind; id: string }>([
    [nodeKey(root.kind, root.id), root],
  ]);
  let depth = 0;
  while (frontier.size > 0) {
    const next = new Map<string, { kind: GraphNodeKind; id: string }>();
    for (const current of frontier.values())
      for (const edge of successors.get(nodeKey(current.kind, current.id)) ??
        []) {
        const key = nodeKey(edge.toKind, edge.toId);
        next.set(key, { kind: edge.toKind, id: edge.toId });
      }
    if (next.size === 0) break;
    depth += 1;
    for (const [key, node] of next)
      if (!shortest.has(key)) shortest.set(key, { ...node, depth });
    if (shortest.size > limits.maxNodes)
      return { nodes: [...shortest.values()], depth, exceeded: 'nodes' };
    if (depth > limits.maxDepth)
      return { nodes: [...shortest.values()], depth, exceeded: 'depth' };
    frontier = next;
  }
  // A cycle back to the root is not a reachable "other" node.
  shortest.delete(nodeKey(root.kind, root.id));
  return { nodes: [...shortest.values()], depth, exceeded: null };
}

export interface PerMissionClosure {
  missionId: string;
  affected: Affected;
  preserved: { taskIds: string[] };
}

export interface ClosureResult {
  affected: Affected;
  perMission: PerMissionClosure[];
  missionIds: string[];
  /** Number of reached nodes (the root excluded). */
  nodes: number;
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (ids: Iterable<string>) =>
  [...new Set(ids)].sort(compareIds);

type AffectedBuckets = {
  modelCallIds: Set<string>;
  attemptIds: Set<string>;
  outputIds: Set<string>;
  actionIds: Set<string>;
  taskIds: Set<string>;
};

const emptyBuckets = (): AffectedBuckets => ({
  modelCallIds: new Set(),
  attemptIds: new Set(),
  outputIds: new Set(),
  actionIds: new Set(),
  taskIds: new Set(),
});

function addNode(buckets: AffectedBuckets, node: NodeMeta) {
  switch (node.kind) {
    case 'model_call':
      buckets.modelCallIds.add(node.id);
      break;
    case 'attempt':
      buckets.attemptIds.add(node.id);
      if (node.taskId) buckets.taskIds.add(node.taskId); // R2
      break;
    case 'task_output':
      buckets.outputIds.add(node.id);
      break;
    case 'action_intent':
      buckets.actionIds.add(node.id);
      break;
    case 'task':
      buckets.taskIds.add(node.id);
      break;
    case 'receipt':
      break;
  }
}

const toAffected = (buckets: AffectedBuckets): Affected =>
  ({
    modelCallIds: sortedUnique(buckets.modelCallIds),
    attemptIds: sortedUnique(buckets.attemptIds),
    outputIds: sortedUnique(buckets.outputIds),
    actionIds: sortedUnique(buckets.actionIds),
    taskIds: sortedUnique(buckets.taskIds),
  }) as Affected;

/**
 * Partitions the reached nodes into the global affected set and one subset per
 * affected mission (finding I10). `missionTasks` lists every task the graph
 * or the coordinator knows for a mission; the preserved set is that minus the
 * mission's affected tasks.
 */
export function buildClosure(
  reached: readonly NodeMeta[],
  missionTasks: ReadonlyMap<string, ReadonlySet<string>>,
): ClosureResult {
  const global = emptyBuckets();
  const byMission = new Map<string, AffectedBuckets>();
  let nodes = 0;
  for (const node of reached) {
    if (node.kind === 'receipt') continue;
    nodes += 1;
    addNode(global, node);
    if (node.missionId === null) continue;
    let buckets = byMission.get(node.missionId);
    if (!buckets) {
      buckets = emptyBuckets();
      byMission.set(node.missionId, buckets);
    }
    addNode(buckets, node);
  }
  const perMission: PerMissionClosure[] = [...byMission.keys()]
    .sort(compareIds)
    .map((missionId) => {
      const buckets = byMission.get(missionId)!;
      const tasks = missionTasks.get(missionId) ?? new Set<string>();
      return {
        missionId,
        affected: toAffected(buckets),
        preserved: {
          taskIds: sortedUnique(
            [...tasks].filter((taskId) => !buckets.taskIds.has(taskId)),
          ),
        },
      };
    });
  return {
    affected: toAffected(global),
    perMission,
    missionIds: perMission.map((entry) => entry.missionId),
    nodes,
  };
}

export function emptyAffected(): Affected {
  return toAffected(emptyBuckets());
}
