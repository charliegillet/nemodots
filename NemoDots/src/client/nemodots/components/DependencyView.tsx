import type { DependencyEdgeView } from '../mission-events';
import { truncate } from '../format';
import { Panel, type PanelState } from './Panel';

const MAX_GRAPH_EDGES = 60;
const ROW = 30;
const COLUMN_X = { receipt: 8, task: 252, action: 496 } as const;
const NODE_W = 136;

const KIND_TEXT = {
  scheduling: 'Scheduling',
  evidence: 'Evidence',
} as const;

function Graph({ edges }: { edges: readonly DependencyEdgeView[] }) {
  const shown = edges.slice(0, MAX_GRAPH_EDGES);
  const columns: Record<'receipt' | 'task' | 'action', string[]> = {
    receipt: [],
    task: [],
    action: [],
  };
  const labels = new Map<string, string>();
  const key = (kind: string, id: string) => `${kind}:${id}`;
  for (const edge of shown)
    for (const end of [edge.from, edge.to]) {
      const k = key(end.kind, end.id);
      if (!labels.has(k)) {
        labels.set(k, end.label);
        columns[end.kind].push(k);
      }
    }
  const pos = (kind: 'receipt' | 'task' | 'action', id: string) => ({
    x: COLUMN_X[kind],
    y: 28 + columns[kind].indexOf(key(kind, id)) * ROW,
  });
  const rows = Math.max(1, ...Object.values(columns).map((c) => c.length));
  const height = 28 + rows * ROW;
  return (
    <svg
      className="nd-graph"
      viewBox={`0 0 640 ${height}`}
      role="img"
      aria-label="Dependency graph. Solid lines are scheduling edges between tasks. Dashed lines are evidence edges from a receipt to the task or action that relied on it. The list below has the same edges as text."
    >
      <defs>
        <marker
          id="nd-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" className="nd-arrow" />
        </marker>
      </defs>
      <text x="8" y="14" className="nd-graph-head">
        Evidence
      </text>
      <text x="252" y="14" className="nd-graph-head">
        Tasks
      </text>
      <text x="496" y="14" className="nd-graph-head">
        Actions
      </text>
      {shown.map((edge) => {
        const a = pos(edge.from.kind, edge.from.id);
        const b = pos(edge.to.kind, edge.to.id);
        const sameColumn = a.x === b.x;
        const x1 = a.x + NODE_W;
        const y1 = a.y + 11;
        const x2 = sameColumn ? b.x + NODE_W : b.x;
        const y2 = b.y + 11;
        const d = sameColumn
          ? `M${x1},${y1} C${x1 + 36},${y1} ${x2 + 36},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`;
        return (
          <path
            key={edge.id}
            d={d}
            className={`nd-edge nd-edge-${edge.kind}`}
            markerEnd="url(#nd-arrow)"
          />
        );
      })}
      {(['receipt', 'task', 'action'] as const).flatMap((kind) =>
        columns[kind].map((k) => {
          const id = k.slice(kind.length + 1);
          const { x, y } = pos(kind, id);
          return (
            <g key={k}>
              <rect
                x={x}
                y={y}
                width={NODE_W}
                height={22}
                rx={4}
                className={`nd-node nd-node-${kind}`}
              />
              <text x={x + 6} y={y + 15} className="nd-node-text">
                {truncate(labels.get(k) ?? id, 20)}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

export function DependencyView({
  edges,
  loading,
  error,
}: PanelState & { edges: readonly DependencyEdgeView[] }) {
  const scheduling = edges.filter((edge) => edge.kind === 'scheduling');
  const evidence = edges.filter((edge) => edge.kind === 'evidence');
  return (
    <Panel
      title="Dependencies"
      className="nd-deps"
      loading={loading}
      error={error}
      empty={edges.length === 0}
      emptyText="No dependencies recorded yet."
    >
      <p className="nd-legend">
        <span className="nd-legend-key nd-legend-scheduling">
          Solid line: scheduling (a task waits for another task)
        </span>
        <span className="nd-legend-key nd-legend-evidence">
          Dashed line: evidence (work relied on a receipt)
        </span>
      </p>
      <Graph edges={edges} />
      {edges.length > MAX_GRAPH_EDGES && (
        <p className="nd-note">
          The graph shows the first {MAX_GRAPH_EDGES} of {edges.length} edges.
          The lists below are complete.
        </p>
      )}
      {(
        [
          ['scheduling', scheduling, 'must finish before'],
          ['evidence', evidence, 'is relied on by'],
        ] as const
      ).map(([kind, list, verb]) => (
        <div key={kind} className="nd-deps-group">
          <h4>
            {KIND_TEXT[kind]} edges ({list.length})
          </h4>
          {list.length === 0 ? (
            <p className="nd-empty">None.</p>
          ) : (
            <ul aria-label={`${KIND_TEXT[kind]} edges`}>
              {list.map((edge) => (
                <li key={edge.id} className={`nd-edge-item nd-edge-${kind}`}>
                  <span className="nd-edge-kind">{KIND_TEXT[kind]}</span>
                  <span>{edge.from.label}</span>
                  <span className="nd-edge-verb">{verb}</span>
                  <span>{edge.to.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </Panel>
  );
}
