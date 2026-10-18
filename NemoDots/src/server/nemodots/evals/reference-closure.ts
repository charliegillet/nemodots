// Independent reference traversal for the oracle. It is written from the
// specification (ARCHITECTURE 5.2: evidence and inheritance edges only, never
// scheduling; an attempt marks its task affected) over plain edge records read
// from the database. It shares no code with the ledger's closure or
// invalidation modules, so a bug there cannot hide in both.
import type { ObsAffected, ObsEdge, ObsNode } from './observations.js';

const PROPAGATING = new Set(['evidence', 'inheritance']);

const key = (kind: string, id: string) => `${kind}\u0000${id}`;

export interface ReferenceClosure extends ObsAffected {
  reachedNodes: number;
}

/**
 * Everything reachable forward from `rootReceiptId`. `existedAt` restricts the
 * graph to edges that existed when an invalidation event was recorded.
 * `missionId` restricts the result (not the walk) to one mission's nodes.
 */
export function referenceClosure(
  edges: readonly ObsEdge[],
  nodes: readonly ObsNode[],
  rootReceiptId: string,
  options: { existedAt?: string; missionId?: string } = {},
): ReferenceClosure {
  const cutoff = options.existedAt ? Date.parse(options.existedAt) : Infinity;
  const forward = new Map<string, ObsEdge[]>();
  for (const edge of edges) {
    if (!PROPAGATING.has(edge.kind)) continue;
    if (Date.parse(edge.createdAt) > cutoff) continue;
    const from = key(edge.fromKind, edge.fromId);
    const list = forward.get(from);
    if (list) list.push(edge);
    else forward.set(from, [edge]);
  }
  const meta = new Map(nodes.map((node) => [key(node.kind, node.id), node]));
  const seen = new Set<string>([key('receipt', rootReceiptId)]);
  const queue: { kind: string; id: string }[] = [
    { kind: 'receipt', id: rootReceiptId },
  ];
  const attemptIds = new Set<string>();
  const taskIds = new Set<string>();
  const outputIds = new Set<string>();
  const actionIds = new Set<string>();
  const modelCallIds = new Set<string>();
  let reached = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of forward.get(key(current.kind, current.id)) ?? []) {
      const next = key(edge.toKind, edge.toId);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ kind: edge.toKind, id: edge.toId });
      reached += 1;
      const node = meta.get(next);
      if (options.missionId && node && node.missionId !== options.missionId)
        continue;
      switch (edge.toKind) {
        case 'attempt':
          attemptIds.add(edge.toId);
          if (node?.taskId) taskIds.add(node.taskId);
          break;
        case 'task':
          taskIds.add(edge.toId);
          break;
        case 'task_output':
          outputIds.add(edge.toId);
          break;
        case 'action_intent':
          actionIds.add(edge.toId);
          break;
        case 'model_call':
          modelCallIds.add(edge.toId);
          break;
        default:
          break;
      }
    }
  }
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    attemptIds: sorted(attemptIds),
    taskIds: sorted(taskIds),
    outputIds: sorted(outputIds),
    actionIds: sorted(actionIds),
    modelCallIds: sorted(modelCallIds),
    reachedNodes: reached,
  };
}
