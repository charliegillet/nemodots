// Supersession and invalidation closure (ARCHITECTURE.md section 5.2 steps
// 3-5). The closure runs on the caller's connection inside the supersession
// transaction, so no reader ever sees a superseded receipt whose dependents are
// still usable. Repair scheduling is NOT here: the coordinator consumes the
// InvalidationEvent through RecoveryPort / the outbox.
//
// Order inside supersedeAndInvalidate():
//   1. closure read (recursive CTE; ClosureCapExceeded here writes nothing),
//   2. new receipt + revision row + graph node,
//   3. compare-and-set of the prior head (superseded / retracted) + transition row,
//   4. marks on attempts, tasks, outputs and live intents (fixed table order,
//      rows locked in id order, so two closures cannot deadlock on each other),
//   5. invalidation_events row.
import {
  invalidationEventId,
  type Affected,
  type InvalidationEvent,
  type InvalidationReason,
  type PgClient,
  type ReceiptId,
  type SelfWrite,
  type SourceKey,
  type TransitionReason,
} from '../contracts/index.js';
import {
  buildClosure,
  CLOSURE_LIMITS,
  emptyAffected,
  type ClosureLimits,
  type ClosureResult,
  type GraphNodeKind,
  type NodeMeta,
} from './closure.js';
import { ClosureCapExceeded } from './errors.js';
import { coordinatorSchema, type LedgerOptions } from './options.js';
import {
  insertReceipt,
  transitionRow,
  type ReceiptDraft,
  type ReceiptRow,
} from './receipt-store.js';

export { ClosureCapExceeded };

// --- closure read -----------------------------------------------------------

export interface LoadedClosure extends ClosureResult {
  depth: number;
  graphVersion: number;
}

const FOLLOWED = `e.kind IN ('evidence', 'inheritance')`;

/**
 * Walks evidence and inheritance edges from `receiptId` with a bounded
 * recursive CTE (never scheduling edges). Distinct reached nodes are capped at
 * `maxNodes` and the longest path at `maxDepth`; either excess throws
 * ClosureCapExceeded. Read-only.
 */
export async function loadClosure(
  client: PgClient,
  root: { receiptId: string; sourceKey: string },
  limits: ClosureLimits = CLOSURE_LIMITS,
  options?: LedgerOptions,
): Promise<LoadedClosure> {
  const reachedQuery = await client.query<{ kind: GraphNodeKind; id: string }>(
    `WITH RECURSIVE reach(kind, id) AS (
       SELECT e.to_kind, e.to_id FROM ledger.dependency_edges e
        WHERE e.from_kind = 'receipt' AND e.from_id = $1 AND ${FOLLOWED}
       UNION
       SELECT e.to_kind, e.to_id FROM reach r
         JOIN ledger.dependency_edges e ON e.from_kind = r.kind AND e.from_id = r.id
        WHERE ${FOLLOWED}
     )
     SELECT kind, id FROM reach LIMIT $2`,
    [root.receiptId, limits.maxNodes + 1],
  );
  const capExceeded = async (cap: 'depth' | 'nodes') =>
    new ClosureCapExceeded(
      cap,
      limits,
      root.sourceKey,
      root.receiptId,
      await directMissionIds(client, root.receiptId),
    );
  if (reachedQuery.rows.length > limits.maxNodes)
    throw await capExceeded('nodes');

  const depthQuery = await client.query<{ depth: number | null }>(
    `WITH RECURSIVE reach(kind, id, depth) AS (
       SELECT e.to_kind, e.to_id, 1 FROM ledger.dependency_edges e
        WHERE e.from_kind = 'receipt' AND e.from_id = $1 AND ${FOLLOWED}
       UNION
       SELECT e.to_kind, e.to_id, r.depth + 1 FROM reach r
         JOIN ledger.dependency_edges e ON e.from_kind = r.kind AND e.from_id = r.id
        WHERE ${FOLLOWED} AND r.depth <= $2
     )
     SELECT max(depth) AS depth FROM reach`,
    [root.receiptId, limits.maxDepth],
  );
  const depth = Number(depthQuery.rows[0]?.depth ?? 0);
  if (depth > limits.maxDepth) throw await capExceeded('depth');

  const reached = reachedQuery.rows;
  const meta = await loadNodeMeta(client, reached);
  const missionIds = [
    ...new Set(
      meta.flatMap((node) => (node.missionId ? [node.missionId] : [])),
    ),
  ];
  const missionTasks = await loadMissionTasks(client, missionIds, options);
  const closure = buildClosure(meta, missionTasks);
  const version = await client.query<{ version: string | null }>(
    'SELECT max(seq) AS version FROM ledger.dependency_edges',
  );
  return {
    ...closure,
    depth,
    graphVersion: Number(version.rows[0]?.version ?? 0),
  };
}

async function directMissionIds(
  client: PgClient,
  receiptId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ mission_id: string }>(
    `SELECT DISTINCT mission_id FROM ledger.dependency_edges e
      WHERE e.from_kind = 'receipt' AND e.from_id = $1 AND ${FOLLOWED}
      ORDER BY mission_id`,
    [receiptId],
  );
  return rows.map((row) => row.mission_id);
}

async function loadNodeMeta(
  client: PgClient,
  reached: readonly { kind: GraphNodeKind; id: string }[],
): Promise<NodeMeta[]> {
  if (reached.length === 0) return [];
  const { rows } = await client.query<{
    kind: GraphNodeKind;
    id: string;
    mission_id: string | null;
    task_id: string | null;
  }>(
    `SELECT n.kind, n.id, n.mission_id, n.task_id
       FROM ledger.dependency_nodes n
       JOIN unnest($1::text[], $2::uuid[]) AS r(kind, id) ON r.kind = n.kind AND r.id = n.id`,
    [reached.map((node) => node.kind), reached.map((node) => node.id)],
  );
  const known = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  return reached.map((node) => {
    const row = known.get(`${node.kind}:${node.id}`);
    return {
      kind: node.kind,
      id: node.id,
      missionId: row?.mission_id ?? null,
      taskId: row?.task_id ?? null,
    };
  });
}

/**
 * Tasks the graph (task nodes) and, when the coordinator schema exists, the
 * coordinator know for each mission. The preserved set is derived from them.
 */
async function loadMissionTasks(
  client: PgClient,
  missionIds: readonly string[],
  options?: LedgerOptions,
): Promise<Map<string, Set<string>>> {
  const tasks = new Map<string, Set<string>>();
  if (missionIds.length === 0) return tasks;
  const add = (missionId: string, taskId: string) => {
    const set = tasks.get(missionId) ?? new Set<string>();
    set.add(taskId);
    tasks.set(missionId, set);
  };
  const nodes = await client.query<{ mission_id: string; id: string }>(
    `SELECT mission_id, id FROM ledger.dependency_nodes
      WHERE kind = 'task' AND mission_id = ANY($1::uuid[])`,
    [missionIds],
  );
  for (const row of nodes.rows) add(row.mission_id, row.id);
  const schema = coordinatorSchema(options);
  const present = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${schema}.tasks`],
  );
  if (present.rows[0]?.present) {
    const known = await client.query<{ mission_id: string; id: string }>(
      `SELECT mission_id, id FROM ${schema}.tasks WHERE mission_id = ANY($1::uuid[])`,
      [missionIds],
    );
    for (const row of known.rows) add(row.mission_id, row.id);
  }
  return tasks;
}

// --- marks ------------------------------------------------------------------

export interface MarkSummary {
  attemptsInvalidated: string[];
  tasksInvalidated: string[];
  outputsUnusable: string[];
  intentsBlocked: string[];
}

export interface ClosureMarker {
  mark(
    client: PgClient,
    context: { eventId: string; affected: Affected },
  ): Promise<MarkSummary>;
}

export const emptyMarkSummary = (): MarkSummary => ({
  attemptsInvalidated: [],
  tasksInvalidated: [],
  outputsUnusable: [],
  intentsBlocked: [],
});

/**
 * Compare-and-set marks on the coordinator's rows. Each statement locks its
 * candidate rows in id order first and only moves rows still in a state the
 * transition tables allow, so an in-flight commit holding an intent row is
 * serialized before or after this transaction, never interleaved:
 *   attempts  running                       -> invalidated (abort_reason readset_invalidated)
 *   tasks     running | waiting | succeeded -> invalidated (transition_version + 1)
 *   outputs   usable                        -> unusable
 *   intents   proposed | admitted           -> blocked(stale_version) (status_version + 1)
 * Anything else (published attempts, terminal intents) keeps its state.
 * Columns used: task_attempts(id, status, abort_reason), tasks(id, status,
 * transition_version), task_outputs(id, usable, unusable_reason),
 * action_intents(id, status, status_version, block_reason, block_detail).
 */
export function createCoordinatorMarker(options?: LedgerOptions): ClosureMarker {
  return {
    async mark(client, { eventId, affected }) {
      const schema = coordinatorSchema(options);
      const run = async (sql: string, params: unknown[]) =>
        (await client.query<{ id: string }>(sql, params)).rows
          .map((row) => row.id)
          .sort();
      const summary = emptyMarkSummary();
      if (affected.attemptIds.length > 0)
        summary.attemptsInvalidated = await run(
          `WITH locked AS (
             SELECT id FROM ${schema}.task_attempts
              WHERE id = ANY($1::uuid[]) AND status = 'running' ORDER BY id FOR UPDATE)
           UPDATE ${schema}.task_attempts a
              SET status = 'invalidated', abort_reason = 'readset_invalidated'
             FROM locked WHERE a.id = locked.id AND a.status = 'running'
           RETURNING a.id`,
          [affected.attemptIds],
        );
      if (affected.taskIds.length > 0)
        summary.tasksInvalidated = await run(
          `WITH locked AS (
             SELECT id FROM ${schema}.tasks
              WHERE id = ANY($1::uuid[]) AND status IN ('running', 'waiting', 'succeeded')
              ORDER BY id FOR UPDATE)
           UPDATE ${schema}.tasks t
              SET status = 'invalidated', transition_version = t.transition_version + 1
             FROM locked WHERE t.id = locked.id
              AND t.status IN ('running', 'waiting', 'succeeded')
           RETURNING t.id`,
          [affected.taskIds],
        );
      if (affected.outputIds.length > 0)
        summary.outputsUnusable = await run(
          `WITH locked AS (
             SELECT id FROM ${schema}.task_outputs
              WHERE id = ANY($1::uuid[]) AND usable ORDER BY id FOR UPDATE)
           UPDATE ${schema}.task_outputs o
              SET usable = false, unusable_reason = $2
             FROM locked WHERE o.id = locked.id AND o.usable
           RETURNING o.id`,
          [affected.outputIds, `invalidated:${eventId}`],
        );
      if (affected.actionIds.length > 0)
        summary.intentsBlocked = await run(
          `WITH locked AS (
             SELECT id FROM ${schema}.action_intents
              WHERE id = ANY($1::uuid[]) AND status IN ('proposed', 'admitted')
              ORDER BY id FOR UPDATE)
           UPDATE ${schema}.action_intents i
              SET status = 'blocked', status_version = i.status_version + 1,
                  block_reason = 'stale_version', block_detail = $2
             FROM locked WHERE i.id = locked.id AND i.status IN ('proposed', 'admitted')
           RETURNING i.id`,
          [affected.actionIds, `evidence changed (invalidation ${eventId})`],
        );
      return summary;
    },
  };
}

// --- events -----------------------------------------------------------------

export interface InvalidationRecord {
  sourceId: string;
  sourceKey: SourceKey;
  oldReceiptId: ReceiptId;
  newReceiptId: ReceiptId | null;
  reason: InvalidationReason;
  selfWrite: SelfWrite;
  graphVersion: number;
  affected: Affected;
  perMission: InvalidationEvent['perMission'];
  closure: InvalidationEvent['closure'];
}

/** Writes one invalidation_events row (idempotent on the content-derived id). */
export async function insertInvalidationEvent(
  client: PgClient,
  record: InvalidationRecord,
): Promise<InvalidationEvent> {
  const id = invalidationEventId(
    record.sourceKey,
    record.oldReceiptId,
    record.newReceiptId,
    record.reason,
  );
  const missionIds = record.perMission.map((entry) => entry.missionId);
  await client.query(
    `INSERT INTO ledger.invalidation_events
       (id, source_id, source_key, old_receipt_id, new_receipt_id, reason, self_write,
        graph_version, mission_ids, affected, per_mission, closure)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      record.sourceId,
      record.sourceKey,
      record.oldReceiptId,
      record.newReceiptId,
      record.reason,
      record.selfWrite,
      record.graphVersion,
      JSON.stringify(missionIds),
      JSON.stringify(record.affected),
      JSON.stringify(record.perMission),
      JSON.stringify(record.closure),
    ],
  );
  const { rows } = await client.query<{
    resolved_at: Date | null;
    created_at: Date;
  }>('SELECT resolved_at, created_at FROM ledger.invalidation_events WHERE id = $1', [
    id,
  ]);
  return {
    id,
    missionIds: missionIds as InvalidationEvent['missionIds'],
    sourceKey: record.sourceKey,
    oldReceiptId: record.oldReceiptId,
    newReceiptId: record.newReceiptId,
    reason: record.reason,
    selfWrite: record.selfWrite,
    graphVersion: record.graphVersion,
    affected: record.affected,
    perMission: record.perMission,
    closure: record.closure,
    resolvedAt: rows[0].resolved_at ? rows[0].resolved_at.toISOString() : null,
    createdAt: rows[0].created_at.toISOString(),
  };
}

// --- supersession -----------------------------------------------------------

export interface SupersedeInput {
  /** The source's head receipt before this change, or null for the first revision. */
  prior: ReceiptRow | null;
  /** The receipt to register (sourceRevision and supersedes are set by the caller). */
  draft: ReceiptDraft;
  reason: InvalidationReason;
  transitionReason: TransitionReason;
  sourceKey: SourceKey;
  limits?: ClosureLimits;
  /** null skips the marks (tests of the pure graph); default marks the coordinator's rows. */
  marker?: ClosureMarker | null;
  ledger?: LedgerOptions;
}

export interface SupersedeResult {
  receipt: ReceiptRow;
  supersededReceiptId: ReceiptId | null;
  event: InvalidationEvent | null;
  marks: MarkSummary | null;
}

const isLiveHead = (prior: ReceiptRow | null): prior is ReceiptRow =>
  prior !== null && (prior.status === 'supported' || prior.status === 'contested');

/**
 * Registers `draft` as the new head and, when the prior head was supported or
 * contested, supersedes it and invalidates its closure, all on `client`. The
 * closure is read first: a cap overrun throws ClosureCapExceeded before any
 * receipt row exists (C14).
 */
export async function supersedeAndInvalidate(
  client: PgClient,
  input: SupersedeInput,
): Promise<SupersedeResult> {
  const { prior, draft } = input;
  const closure = isLiveHead(prior)
    ? await loadClosure(
        client,
        { receiptId: prior.id, sourceKey: input.sourceKey },
        input.limits,
        input.ledger,
      )
    : null;
  const receipt = await insertReceipt(client, {
    ...draft,
    supersedes: prior ? prior.id : null,
  });
  if (!isLiveHead(prior) || !closure)
    return { receipt, supersededReceiptId: null, event: null, marks: null };

  const eventId = invalidationEventId(
    input.sourceKey,
    prior.id,
    receipt.id,
    input.reason,
  );
  if (prior.status === 'supported')
    await transitionRow(
      client,
      prior,
      'superseded',
      input.transitionReason,
      eventId,
      receipt.id,
    );
  else
    // A contested head cannot become superseded (transition table); the new
    // observation resolves the contest by retracting it.
    await transitionRow(client, prior, 'retracted', input.transitionReason, eventId);

  const marker =
    input.marker === undefined
      ? createCoordinatorMarker(input.ledger)
      : input.marker;
  const marks = marker
    ? await marker.mark(client, { eventId, affected: closure.affected })
    : null;
  const event = await insertInvalidationEvent(client, {
    sourceId: prior.sourceId,
    sourceKey: input.sourceKey,
    oldReceiptId: prior.id,
    newReceiptId: receipt.id,
    reason: input.reason,
    selfWrite: receipt.provenance.selfWrite,
    graphVersion: closure.graphVersion,
    affected: closure.affected,
    perMission: closure.perMission as unknown as InvalidationEvent['perMission'],
    closure: { depth: closure.depth, nodes: closure.nodes, capped: false },
  });
  return { receipt, supersededReceiptId: prior.id, event, marks };
}

export interface CoarseInvalidation {
  /** Missions the watcher paused; they receive the coarse event. */
  perMission: InvalidationEvent['perMission'];
  /** Number of nodes the closure had reached when it gave up (informational). */
  nodes?: number;
}

/**
 * The cap path (C14): registers `draft` and supersedes the prior head WITHOUT
 * running the closure, and records a coarse invalidation event
 * (reason closure_cap_exceeded, closure.capped = true) whose affected set is
 * the union of `coarse.perMission`. The caller (the watcher) has already
 * paused the missions in a transaction of its own.
 */
export async function supersedeWithoutClosure(
  client: PgClient,
  input: Omit<SupersedeInput, 'limits' | 'marker'> & {
    coarse?: CoarseInvalidation;
  },
): Promise<SupersedeResult> {
  const { prior, draft } = input;
  const receipt = await insertReceipt(client, {
    ...draft,
    supersedes: prior ? prior.id : null,
  });
  if (!isLiveHead(prior))
    return { receipt, supersededReceiptId: null, event: null, marks: null };
  const eventId = invalidationEventId(
    input.sourceKey,
    prior.id,
    receipt.id,
    'closure_cap_exceeded',
  );
  if (prior.status === 'supported')
    await transitionRow(
      client,
      prior,
      'superseded',
      input.transitionReason,
      eventId,
      receipt.id,
    );
  else
    await transitionRow(client, prior, 'retracted', input.transitionReason, eventId);
  const perMission = input.coarse?.perMission ?? [];
  const affected = unionAffected(perMission.map((entry) => entry.affected));
  const event = await insertInvalidationEvent(client, {
    sourceId: prior.sourceId,
    sourceKey: input.sourceKey,
    oldReceiptId: prior.id,
    newReceiptId: receipt.id,
    reason: 'closure_cap_exceeded',
    selfWrite: receipt.provenance.selfWrite,
    graphVersion: await currentGraphVersion(client),
    affected,
    perMission,
    closure: {
      depth: 0,
      nodes: input.coarse?.nodes ?? 0,
      capped: true,
    },
  });
  return { receipt, supersededReceiptId: prior.id, event, marks: null };
}

/**
 * Closure for a receipt that stops being current without a replacement
 * (retraction or expiry): marks the dependents and records the event with
 * newReceiptId null. The caller has performed the receipt transition.
 */
export async function invalidateRetired(
  client: PgClient,
  input: {
    receipt: ReceiptRow;
    sourceKey: SourceKey;
    reason: Extract<InvalidationReason, 'retraction' | 'expiry'>;
    limits?: ClosureLimits;
    marker?: ClosureMarker | null;
    ledger?: LedgerOptions;
  },
): Promise<{ event: InvalidationEvent; marks: MarkSummary | null }> {
  const closure = await loadClosure(
    client,
    { receiptId: input.receipt.id, sourceKey: input.sourceKey },
    input.limits,
    input.ledger,
  );
  const eventId = invalidationEventId(
    input.sourceKey,
    input.receipt.id,
    null,
    input.reason,
  );
  const marker =
    input.marker === undefined
      ? createCoordinatorMarker(input.ledger)
      : input.marker;
  const marks = marker
    ? await marker.mark(client, { eventId, affected: closure.affected })
    : null;
  const event = await insertInvalidationEvent(client, {
    sourceId: input.receipt.sourceId,
    sourceKey: input.sourceKey,
    oldReceiptId: input.receipt.id,
    newReceiptId: null,
    reason: input.reason,
    selfWrite: 'none',
    graphVersion: closure.graphVersion,
    affected: closure.affected,
    perMission: closure.perMission as unknown as InvalidationEvent['perMission'],
    closure: { depth: closure.depth, nodes: closure.nodes, capped: false },
  });
  return { event, marks };
}

async function currentGraphVersion(client: PgClient): Promise<number> {
  const { rows } = await client.query<{ version: string | null }>(
    'SELECT max(seq) AS version FROM ledger.dependency_edges',
  );
  return Number(rows[0]?.version ?? 0);
}

export function unionAffected(sets: readonly Affected[]): Affected {
  const merged: Record<keyof Affected, string[]> = { ...emptyAffected() };
  for (const key of Object.keys(merged) as (keyof Affected)[]) {
    const ids = new Set<string>();
    for (const set of sets) for (const id of set[key]) ids.add(id);
    merged[key] = [...ids].sort();
  }
  return merged as unknown as Affected;
}
