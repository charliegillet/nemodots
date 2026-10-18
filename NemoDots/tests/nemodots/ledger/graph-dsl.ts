// Tiny graph builder for the closure tests. Node ids are symbolic here; the
// integration tests map them to UUIDs.
import type {
  GraphEdgeRecord,
  GraphNodeKind,
  NodeMeta,
} from '../../../src/server/nemodots/ledger/closure.js';

export interface DslNode {
  id: string;
  kind: GraphNodeKind;
  missionId: string | null;
  taskId: string | null;
}

export const receipt = (id: string): DslNode => ({
  id,
  kind: 'receipt',
  missionId: null,
  taskId: null,
});
export const task = (id: string, missionId: string): DslNode => ({
  id,
  kind: 'task',
  missionId,
  taskId: null,
});
const owned =
  (kind: GraphNodeKind) => (id: string, missionId: string, taskId: string) =>
    ({ id, kind, missionId, taskId }) satisfies DslNode;
export const attempt = owned('attempt');
export const modelCall = owned('model_call');
export const output = owned('task_output');
export const intent = owned('action_intent');

export const ev = (from: string, to: string) => ({
  kind: 'evidence' as const,
  from,
  to,
});
export const inh = (from: string, to: string) => ({
  kind: 'inheritance' as const,
  from,
  to,
});
export const sch = (from: string, to: string) => ({
  kind: 'scheduling' as const,
  from,
  to,
});

export function buildGraph(
  nodes: readonly DslNode[],
  edges: readonly {
    kind: 'evidence' | 'inheritance' | 'scheduling';
    from: string;
    to: string;
  }[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const need = (id: string) => {
    const node = byId.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    return node;
  };
  const records: GraphEdgeRecord[] = edges.map((edge) => ({
    kind: edge.kind,
    fromKind: need(edge.from).kind,
    fromId: edge.from,
    toKind: need(edge.to).kind,
    toId: edge.to,
  }));
  const meta = (id: string): NodeMeta => {
    const node = need(id);
    return {
      kind: node.kind,
      id: node.id,
      missionId: node.missionId,
      taskId: node.taskId,
    };
  };
  const tasksByMission = new Map<string, Set<string>>();
  for (const node of nodes)
    if (node.kind === 'task' && node.missionId) {
      const set = tasksByMission.get(node.missionId) ?? new Set<string>();
      set.add(node.id);
      tasksByMission.set(node.missionId, set);
    }
  return { records, meta, tasksByMission, need };
}
