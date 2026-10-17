// Dependency graph writes (CONTRACTS.md section 4, ARCHITECTURE.md 5.2).
//
// Nodes carry their mission and task so the closure is self-contained. Edges
// are append-only. Evidence and inheritance edges must keep the graph acyclic
// and point older -> newer; the rule is enforced by a reachability check
// under an advisory transaction lock PER MISSION (edges never cross missions,
// so a cycle can only form inside one; two writers of one mission cannot each
// add half of a cycle, writers of different missions do not wait for each
// other). It is the LAST lock of the ledger order (prelock.ts): coordinator
// rows, config rows, sources, receipts, then this. Scheduling edges are task -> task and checked for cycles among
// themselves. A batch is all-or-nothing: addEdges runs inside a savepoint.
//
// All functions need a client inside an open transaction.
import { randomUUID } from 'node:crypto';
import type { EdgeKind, PgClient } from '../contracts/index.js';
import { EdgeError } from './errors.js';
import { GRAPH_NODE_KINDS, type GraphNodeKind } from './closure.js';

export interface NodeRef {
  kind: GraphNodeKind;
  id: string;
  /** Required for the `to` side of an edge unless the node is already registered. */
  missionId?: string | null;
  taskId?: string | null;
}

export interface EdgeInput {
  kind: EdgeKind;
  from: NodeRef;
  to: NodeRef;
}

export interface AddEdgesResult {
  inserted: number;
  existing: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_LOCK_PREFIX = 'nemodots_ledger_edges:';
const SAVEPOINT = 'ledger_add_edges';

const edgeClass = (kind: EdgeKind): EdgeKind[] =>
  kind === 'scheduling' ? ['scheduling'] : ['evidence', 'inheritance'];

function validateRef(ref: NodeRef, side: 'from' | 'to') {
  if (!GRAPH_NODE_KINDS.includes(ref.kind))
    throw new EdgeError(`unknown ${side} node kind "${String(ref.kind)}"`);
  if (!UUID.test(ref.id))
    throw new EdgeError(`${side} node id of kind ${ref.kind} is not a uuid`);
  if (ref.kind === 'receipt' && (ref.missionId || ref.taskId))
    throw new EdgeError(
      'receipt nodes are shared and carry no mission or task',
    );
  for (const value of [ref.missionId, ref.taskId])
    if (value && !UUID.test(value))
      throw new EdgeError(
        `${side} node ${ref.kind} has a malformed mission or task id`,
      );
}

/** Registers a graph node; mission/task are filled once and never changed. */
export async function ensureNode(
  client: PgClient,
  node: NodeRef,
): Promise<{ missionId: string | null; taskId: string | null }> {
  validateRef(node, 'from');
  const { rows } = await client.query<{
    mission_id: string | null;
    task_id: string | null;
  }>(
    `INSERT INTO ledger.dependency_nodes (kind, id, mission_id, task_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind, id) DO UPDATE
        SET mission_id = COALESCE(ledger.dependency_nodes.mission_id, EXCLUDED.mission_id),
            task_id = COALESCE(ledger.dependency_nodes.task_id, EXCLUDED.task_id)
     RETURNING mission_id, task_id`,
    [node.kind, node.id, node.missionId ?? null, node.taskId ?? null],
  );
  const stored = { missionId: rows[0].mission_id, taskId: rows[0].task_id };
  if (node.missionId && stored.missionId !== node.missionId)
    throw new EdgeError(
      `node ${node.kind}:${node.id} already belongs to another mission`,
    );
  if (node.taskId && stored.taskId !== node.taskId)
    throw new EdgeError(
      `node ${node.kind}:${node.id} already belongs to another task`,
    );
  return stored;
}

async function reaches(
  client: PgClient,
  start: NodeRef,
  target: NodeRef,
  kinds: EdgeKind[],
): Promise<boolean> {
  const { rows } = await client.query(
    `WITH RECURSIVE reach(kind, id) AS (
       SELECT $1::text, $2::uuid
       UNION
       SELECT e.to_kind, e.to_id
         FROM reach r
         JOIN ledger.dependency_edges e ON e.from_kind = r.kind AND e.from_id = r.id
        WHERE e.kind = ANY($3::text[])
     )
     SELECT 1 FROM reach WHERE kind = $4 AND id = $5 LIMIT 1`,
    [start.kind, start.id, kinds, target.kind, target.id],
  );
  return rows.length > 0;
}

/**
 * Takes the per-mission cycle locks of a batch, in ascending lock-key order so
 * two batches spanning the same missions cannot deadlock. A mission is the
 * `to` node's (given, or already stored); an edge without one fails later in
 * addEdges with its own message.
 */
async function lockMissions(
  client: PgClient,
  edges: readonly EdgeInput[],
): Promise<void> {
  const missions = new Set<string>();
  const unresolved = new Map<string, NodeRef>();
  for (const edge of edges) {
    if (edge.to.missionId) missions.add(edge.to.missionId.toLowerCase());
    else unresolved.set(`${edge.to.kind}:${edge.to.id}`, edge.to);
  }
  if (unresolved.size > 0) {
    const nodes = [...unresolved.values()];
    const { rows } = await client.query<{ mission_id: string | null }>(
      `SELECT n.mission_id FROM ledger.dependency_nodes n
         JOIN unnest($1::text[], $2::uuid[]) AS r(kind, id) ON r.kind = n.kind AND r.id = n.id`,
      [nodes.map((node) => node.kind), nodes.map((node) => node.id)],
    );
    for (const row of rows) if (row.mission_id) missions.add(row.mission_id);
  }
  if (missions.size === 0) return;
  const { rows } = await client.query<{ key: string }>(
    `SELECT DISTINCT hashtext($1 || m)::bigint AS key FROM unnest($2::text[]) AS m ORDER BY key`,
    [EDGE_LOCK_PREFIX, [...missions]],
  );
  for (const { key } of rows)
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
}

/**
 * Adds edges (idempotent per edge). Rejects, writing nothing: unknown or
 * malformed endpoints, a `to` receipt, self loops, edges across missions,
 * scheduling edges that are not task -> task, and any edge that would close a
 * cycle ('edge_cycle'; this also covers an edge from a newer node back to an
 * older one, which can only exist if it closes a path).
 */
export async function addEdges(
  client: PgClient,
  edges: readonly EdgeInput[],
): Promise<AddEdgesResult> {
  if (edges.length === 0) return { inserted: 0, existing: 0 };
  for (const edge of edges) {
    validateRef(edge.from, 'from');
    validateRef(edge.to, 'to');
    if (edge.to.kind === 'receipt')
      throw new EdgeError('an edge cannot point at a receipt');
    if (edge.from.kind === edge.to.kind && edge.from.id === edge.to.id)
      throw new EdgeError('an edge cannot connect a node to itself');
    if (
      edge.kind === 'scheduling' &&
      (edge.from.kind !== 'task' || edge.to.kind !== 'task')
    )
      throw new EdgeError('scheduling edges connect tasks');
  }
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    await lockMissions(
      client,
      edges.filter((edge) => edge.kind !== 'scheduling'),
    );
    let inserted = 0;
    let existing = 0;
    for (const edge of edges) {
      const from = await ensureNode(client, edge.from);
      const to = await ensureNode(client, edge.to);
      if (!to.missionId)
        throw new EdgeError(
          `node ${edge.to.kind}:${edge.to.id} has no mission; the edge needs one`,
        );
      if (from.missionId && from.missionId !== to.missionId)
        throw new EdgeError('an edge cannot connect nodes of two missions');
      const found = await client.query(
        `SELECT 1 FROM ledger.dependency_edges
          WHERE kind = $1 AND from_kind = $2 AND from_id = $3 AND to_kind = $4 AND to_id = $5`,
        [edge.kind, edge.from.kind, edge.from.id, edge.to.kind, edge.to.id],
      );
      if (found.rows.length > 0) {
        existing += 1;
        continue;
      }
      if (await reaches(client, edge.to, edge.from, edgeClass(edge.kind)))
        throw new EdgeError(
          `edge ${edge.from.kind}:${edge.from.id} -> ${edge.to.kind}:${edge.to.id} would close a ${edge.kind} cycle`,
          'edge_cycle',
        );
      await client.query(
        `INSERT INTO ledger.dependency_edges (id, mission_id, kind, from_kind, from_id, to_kind, to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          to.missionId,
          edge.kind,
          edge.from.kind,
          edge.from.id,
          edge.to.kind,
          edge.to.id,
        ],
      );
      inserted += 1;
    }
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return { inserted, existing };
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    throw error;
  }
}

export interface PublicationLink {
  missionId: string;
  taskId: string;
  attemptId: string;
  /** Model calls the publication rests on. */
  modelCallIds: readonly string[];
  /** A published TaskOutput (evidence edges model_call -> output, attempt -> output). */
  outputId?: string;
  /** A proposed ActionIntent (evidence edges model_call -> intent, attempt -> intent). */
  actionId?: string;
}

/**
 * Evidence edges for the things an attempt publishes: its outputs and action
 * intents rest on the attempt and on the model calls that produced them.
 */
export async function linkPublication(
  client: PgClient,
  link: PublicationLink,
): Promise<AddEdgesResult> {
  const attempt: NodeRef = {
    kind: 'attempt',
    id: link.attemptId,
    missionId: link.missionId,
    taskId: link.taskId,
  };
  const targets: NodeRef[] = [];
  if (link.outputId)
    targets.push({
      kind: 'task_output',
      id: link.outputId,
      missionId: link.missionId,
      taskId: link.taskId,
    });
  if (link.actionId)
    targets.push({
      kind: 'action_intent',
      id: link.actionId,
      missionId: link.missionId,
      taskId: link.taskId,
    });
  const edges: EdgeInput[] = [];
  for (const target of targets) {
    edges.push({ kind: 'evidence', from: attempt, to: target });
    for (const modelCallId of link.modelCallIds)
      edges.push({
        kind: 'evidence',
        from: {
          kind: 'model_call',
          id: modelCallId,
          missionId: link.missionId,
          taskId: link.taskId,
        },
        to: target,
      });
  }
  return addEdges(client, edges);
}

/** Inheritance edges: a child attempt (and its model calls) inherits a parent output. */
export async function linkInheritance(
  client: PgClient,
  link: {
    missionId: string;
    taskId: string;
    attemptId: string;
    outputId: string;
    modelCallIds?: readonly string[];
  },
): Promise<AddEdgesResult> {
  const output: NodeRef = { kind: 'task_output', id: link.outputId };
  const to: NodeRef[] = [
    {
      kind: 'attempt',
      id: link.attemptId,
      missionId: link.missionId,
      taskId: link.taskId,
    },
    ...(link.modelCallIds ?? []).map((id): NodeRef => ({
      kind: 'model_call',
      id,
      missionId: link.missionId,
      taskId: link.taskId,
    })),
  ];
  return addEdges(
    client,
    to.map((node) => ({
      kind: 'inheritance' as const,
      from: output,
      to: node,
    })),
  );
}

export interface StoredEdge {
  id: string;
  seq: number;
  missionId: string;
  kind: EdgeKind;
  from: { kind: GraphNodeKind; id: string };
  to: { kind: GraphNodeKind; id: string };
}

export async function listEdges(
  client: PgClient,
  filter: { missionId?: string } = {},
): Promise<StoredEdge[]> {
  const { rows } = await client.query<{
    id: string;
    seq: string;
    mission_id: string;
    kind: EdgeKind;
    from_kind: GraphNodeKind;
    from_id: string;
    to_kind: GraphNodeKind;
    to_id: string;
  }>(
    `SELECT id, seq, mission_id, kind, from_kind, from_id, to_kind, to_id
       FROM ledger.dependency_edges
      WHERE ($1::uuid IS NULL OR mission_id = $1)
      ORDER BY seq`,
    [filter.missionId ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    seq: Number(row.seq),
    missionId: row.mission_id,
    kind: row.kind,
    from: { kind: row.from_kind, id: row.from_id },
    to: { kind: row.to_kind, id: row.to_id },
  }));
}
