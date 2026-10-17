// Seeds the oracle's hand-drawn dependency graphs (ClosureCase / RejectionCase
// nodes and edges) into the real tables and reads the closure result back with
// SQL. Receipts are created through the production registerObservation, every
// other node by direct inserts into the coordinator/ledger tables resolved by
// introspection (SCHEMA BINDING errors name any column that is missing).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  ClosureCase,
  GraphEdge,
  GraphNode,
  AffectedSets,
} from '../oracle/types.js';
import { World, errorCode, type Env } from './driver.js';
import { entry, fillRow, insertRow, insertValues } from './harness.js';

export const T = {
  missions: 'coordinator.missions',
  tasks: 'coordinator.tasks',
  attempts: 'coordinator.task_attempts',
  outputs: 'coordinator.task_outputs',
  intents: 'coordinator.action_intents',
  models: 'ledger.model_call_records',
  edges: 'ledger.dependency_edges',
  invalidations: 'ledger.invalidation_events',
  events: 'coordinator.events',
} as const;

const HEALTH_OK = {
  status: 'ok',
  checks: { postgres: true, redis: true, config_parse: true, writes: true },
  errorClasses: [],
};

/** Logical field -> first existing candidate column; value skipped when the table has none and it is optional. */
async function mapped(
  w: World,
  table: string,
  fields: [candidates: string[], value: unknown, required?: boolean][],
) {
  const given: Record<string, unknown> = {};
  for (const [candidates, value, required] of fields) {
    const col = required
      ? await w.schema.need(table, candidates)
      : await w.schema.pick(table, candidates);
    if (col) given[col] = value;
  }
  return given;
}

export interface Seeded {
  ids: Map<string, string>; // oracle id -> real uuid
  missions: Map<string, string>; // oracle mission id -> real uuid
  reverse: Map<string, string>;
  /** Intent nodes whose rows could not be written because the actions table does not exist yet. */
  intentRowsMissing: number;
}

const defaultValueFor = (key: string): string | number | boolean => {
  const k = key.replace('checkout.config/', '');
  switch (k) {
    case 'cache.namespace':
      return 'acc-ns';
    case 'cache.schema_version':
      return 4;
    case 'db.pool_max':
      return 3;
    case 'db.statement_timeout_ms':
      return 5000;
    case 'routing.inventory_source':
      return 'primary';
    case 'orders.write_enabled':
      return true;
    default:
      return 'acc';
  }
};

export async function seedGraph(
  w: World,
  inputNodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: { ensureExtraKey?: boolean } = {},
): Promise<Seeded> {
  // Tasks referenced by taskId but not drawn in the case are real tasks too.
  const drawn = new Set(inputNodes.map((n) => n.id));
  const implicit: GraphNode[] = [];
  for (const n of inputNodes)
    if (
      n.taskId &&
      !drawn.has(n.taskId) &&
      !implicit.some((s) => s.id === n.taskId)
    )
      implicit.push({
        id: n.taskId,
        kind: 'task',
        missionId: n.missionId,
        seq: -1,
        role: 'investigator',
        parentTaskId: null,
      });
  const nodes: GraphNode[] = [...inputNodes, ...implicit];
  const ids = new Map<string, string>();
  const missions = new Map<string, string>();
  const rows = [...nodes].sort((a, b) => a.seq - b.seq);

  for (const n of nodes) {
    if (n.missionId !== 'shared' && !missions.has(n.missionId)) {
      const id = randomUUID();
      await insertRow(w.admin, w.schema, T.missions, { id, status: 'running' });
      missions.set(n.missionId, id);
    }
  }

  // Controlled authority rows needed by receipts, seeded before any registration.
  const seededKeys = new Set<string>();
  for (const n of rows) {
    if (n.kind !== 'receipt' || !n.sourceKey?.startsWith('checkout.config/'))
      continue;
    const key = n.sourceKey.slice('checkout.config/'.length);
    if (seededKeys.has(key)) continue;
    seededKeys.add(key);
    await w.seedConfig(key, defaultValueFor(n.sourceKey));
  }
  if (options.ensureExtraKey) await w.seedConfig('acc.extra_key', 'x');
  await w.snapshotBases();

  const receiptByKey = new Map<string, string>();
  for (const n of rows) {
    if (n.kind !== 'receipt') continue;
    const env = (n.environment ?? 'test') as Env;
    const cacheKey = `${env}:${n.sourceKey}`;
    let id = receiptByKey.get(cacheKey);
    if (!id) {
      const controlled = w.isControlled(n.sourceKey!);
      const res = await w.register({
        op: 'register',
        label: n.id,
        sourceKey: n.sourceKey!,
        environment: env,
        ...(controlled
          ? {}
          : {
              normalizedValue:
                n.sourceKey === 'checkout.health' ? HEALTH_OK : { seed: n.id },
            }),
      });
      if (!res.ok || !res.current)
        throw new Error(
          `could not register receipt node ${n.id} (${n.sourceKey}): ${res.error ?? 'no receipt'}`,
        );
      id = res.current.id;
      receiptByKey.set(cacheKey, id);
    }
    ids.set(n.id, id);
  }

  const taskOf = (n: GraphNode) => (n.taskId ? ids.get(n.taskId) : undefined);
  const attemptOfTask = (taskId: string | undefined) => {
    for (const n of nodes)
      if (
        n.kind === 'attempt' &&
        n.taskId &&
        ids.get(n.taskId) === taskId &&
        ids.has(n.id)
      )
        return ids.get(n.id);
    return undefined;
  };

  const ordinals = new Map<string, number>();
  const attemptNs = new Map<string, number>();
  // Harness self-check ONLY (ACC1_SELFCHECK_INTENTS_STUB=1): validates this file's assertions while the
  // wave-3 actions migration is absent. A run with the stub is never reported as a production result.
  if (
    process.env.ACC1_SELFCHECK_INTENTS_STUB === '1' &&
    !(await w.schema.exists(T.intents))
  ) {
    await w.admin
      .query(`CREATE TABLE ${T.intents} (id uuid PRIMARY KEY, mission_id uuid, task_id uuid, attempt_id uuid, status text NOT NULL,
      status_version integer NOT NULL DEFAULT 0, block_reason text, block_detail text)`);
    await w.admin.query(
      `GRANT SELECT, INSERT, UPDATE ON ${T.intents} TO nemodots_app`,
    );
  }
  const intentsTable = await w.schema.exists(T.intents);
  const counts = { intentRowsMissing: 0 };
  for (const n of rows) {
    if (n.kind === 'receipt') continue;
    const id = randomUUID();
    const mission = missions.get(n.missionId);
    switch (n.kind) {
      case 'task': {
        const ordinal = ordinals.get(mission!) ?? 0;
        ordinals.set(mission!, ordinal + 1);
        const parent = n.parentTaskId ? ids.get(n.parentTaskId) : null;
        await w.admin.query(
          `INSERT INTO ${T.tasks} (id, mission_id, parent_id, depth, ordinal, title, question, role, status, generation, justification, budget)
           VALUES ($1, $2, $3, $4, $5, 'acc', 'acc', $6, 'succeeded', 0, $7, '{"maxIterations":1,"maxTokens":1,"maxChildren":1}'::jsonb)`,
          [
            id,
            mission,
            parent,
            parent ? 1 : 0,
            ordinal,
            n.role ?? 'investigator',
            parent ? 'acc' : null,
          ],
        );
        break;
      }
      case 'attempt': {
        const task = taskOf(n)!;
        const k = (attemptNs.get(task) ?? 0) + 1;
        attemptNs.set(task, k);
        const status = n.attemptStatus ?? 'published';
        await w.admin.query(
          `INSERT INTO ${T.attempts} (id, task_id, mission_id, n, kind, status, generation, lease_owner, fencing_token, lease_expires_at, lease_renewed_at, abort_reason)
           VALUES ($1, $2, $3, $4, 'initial', $5, 0, 'acc1', $4, now() + interval '1 hour', now(), $6)`,
          [
            id,
            task,
            mission,
            k,
            status,
            status === 'aborted' ? 'lease_lost' : null,
          ],
        );
        break;
      }
      case 'model_call':
        // A model call is a graph node only; its record needs a context snapshot the closure never reads.
        break;
      case 'task_output': {
        const task = taskOf(n)!;
        let attempt = attemptOfTask(task);
        if (!attempt) {
          attempt = randomUUID();
          await w.admin.query(
            `INSERT INTO ${T.attempts} (id, task_id, mission_id, n, kind, status, generation, lease_owner, fencing_token, lease_expires_at, lease_renewed_at)
             VALUES ($1, $2, $3, 99, 'initial', 'published', 0, 'acc1', 99, now() + interval '1 hour', now())`,
            [attempt, task, mission],
          );
        }
        await w.admin.query(
          `INSERT INTO ${T.outputs} (id, task_id, attempt_id, mission_id, kind, content, digest, usable)
           VALUES ($1, $2, $3, $4, 'finding', '{}'::jsonb, repeat('a', 64), true)`,
          [id, task, attempt, mission],
        );
        break;
      }
      case 'action_intent':
        // coordinator.action_intents arrives with the wave-3 actions migration.
        if (intentsTable) {
          await insertRow(
            w.admin,
            w.schema,
            T.intents,
            await mapped(w, T.intents, [
              [['id'], id, true],
              [['mission_id'], mission, true],
              [['task_id'], taskOf(n)],
              [['attempt_id'], attemptOfTask(taskOf(n))],
              [['status'], n.intentStatus ?? 'proposed'],
            ]),
            { parents: { [T.missions]: mission } },
          );
        } else counts.intentRowsMissing += 1;
        break;
    }
    ids.set(n.id, id);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ref = (id: string) => {
    const n = byId.get(id)!;
    const real = ids.get(id)!;
    if (n.kind === 'receipt') return { kind: 'receipt', id: real };
    return {
      kind: n.kind,
      id: real,
      missionId: missions.get(n.missionId),
      taskId: n.kind === 'task' ? real : n.taskId ? ids.get(n.taskId) : null,
    };
  };
  const { addEdges, ensureNode } = await edgeApi();
  await w.inTx(async (client) => {
    for (const n of rows)
      if (n.kind !== 'receipt') await ensureNode(client, ref(n.id));
  });
  for (const e of edges)
    await w.inTx((client) =>
      addEdges(client, [{ kind: e.kind, from: ref(e.from), to: ref(e.to) }]),
    );
  const reverse = new Map<string, string>();
  for (const [oracle, real] of ids)
    if (!reverse.has(real)) reverse.set(real, oracle);
  return {
    ids,
    missions,
    reverse,
    intentRowsMissing: counts.intentRowsMissing,
  };
}

type EdgeApi = {
  addEdges: (client: pg.PoolClient, edges: unknown[]) => Promise<unknown>;
  ensureNode: (client: pg.PoolClient, node: unknown) => Promise<unknown>;
};
/** BIND: ledger/edges.ts#addEdges(client in txn, [{kind, from: NodeRef, to: NodeRef}]) and #ensureNode(client, NodeRef). */
export async function edgeApi(): Promise<EdgeApi> {
  const addEdges = await entry<EdgeApi['addEdges']>('ledger/edges.ts', [
    'addEdges',
  ]);
  const ensureNode = await entry<EdgeApi['ensureNode']>('ledger/edges.ts', [
    'ensureNode',
  ]);
  return { addEdges, ensureNode };
}

/** Moves the controlled authority for one change (no-op for observed sources). */
export async function applyAuthority(w: World, c: ClosureCase, index: number) {
  const change = c.changes[index];
  const node = c.nodes.find((n) => n.id === change.oldReceipt)!;
  const key = node.sourceKey!;
  if (!w.isControlled(key)) return;
  const member = key.startsWith('checkout.config/')
    ? key.slice('checkout.config/'.length)
    : null;
  if (change.via === 'collection_insert')
    await w.advance({
      op: 'advance_config',
      key: `acc.new_key_${index}`,
      value: true,
      actor: 'injector',
      insertIfMissing: true,
    });
  else if (change.via === 'collection_delete')
    await w.advance({
      op: 'advance_config',
      key: 'acc.extra_key',
      value: 'x',
      actor: 'injector',
      deleteKey: true,
    });
  else if (member) {
    const current = await w.configValue(member);
    const next =
      typeof current === 'number'
        ? current + 1
        : typeof current === 'boolean'
          ? !current
          : `${String(current)}-changed`;
    await w.advance({
      op: 'advance_config',
      key: member,
      value: next as never,
      actor: 'injector',
    });
  }
}

/** Registers the changed source through the production path, which supersedes and runs the closure. */
export async function registerChange(w: World, c: ClosureCase, index: number) {
  const change = c.changes[index];
  const node = c.nodes.find((n) => n.id === change.oldReceipt)!;
  const env = (node.environment ?? 'test') as Env;
  const key = node.sourceKey!;
  const controlled = w.isControlled(key);
  return w.register({
    op: 'register',
    label: `${change.oldReceipt}#new${index}`,
    sourceKey: key,
    environment: env,
    ...(controlled
      ? {}
      : {
          normalizedValue:
            key === 'checkout.health'
              ? { ...HEALTH_OK, status: 'degraded', errorClasses: ['changed'] }
              : { changed: index + 1 },
        }),
  });
}

// ----------------------------------------------------------------- readers

const lowerSnake = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase();
/** Reads `affected` style objects whichever case the JSON uses. */
export function affectedSets(obj: unknown): AffectedSets {
  const o = (obj ?? {}) as Record<string, unknown>;
  const pick = (name: string): string[] => {
    for (const k of Object.keys(o))
      if (lowerSnake(k) === lowerSnake(name)) return (o[k] as string[]) ?? [];
    return [];
  };
  return {
    modelCallIds: pick('modelCallIds'),
    attemptIds: pick('attemptIds'),
    outputIds: pick('outputIds'),
    actionIds: pick('actionIds'),
    taskIds: pick('taskIds'),
  };
}

export interface ClosureObserved {
  eventRows: number;
  union: AffectedSets;
  perMission: Map<string, { affected: AffectedSets; preserved: string[] }>;
  attemptsInvalidated: string[];
  outputsUnusable: string[];
  tasksInvalidated: string[];
  intents: Map<string, { status: string; blockReason: string | null }>;
  receiptStatus: Map<string, string>;
  capped: boolean[];
  coordinatorEventsByMission: Map<string, number>;
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

export async function observeClosure(
  w: World,
  seeded: Seeded,
): Promise<ClosureObserved> {
  const aff = await w.schema.need(T.invalidations, ['affected']);
  const per = await w.schema.pick(T.invalidations, [
    'per_mission',
    'perMission',
  ]);
  const clo = await w.schema.pick(T.invalidations, ['closure']);
  const ev = await w.admin.query(
    `SELECT "${aff}" AS affected, ${per ? `"${per}"` : 'NULL'} AS per, ${clo ? `"${clo}"` : 'NULL'} AS closure FROM ${T.invalidations}`,
  );
  const union: AffectedSets = {
    modelCallIds: [],
    attemptIds: [],
    outputIds: [],
    actionIds: [],
    taskIds: [],
  };
  const perMission = new Map<
    string,
    { affected: AffectedSets; preserved: string[] }
  >();
  const capped: boolean[] = [];
  for (const row of ev.rows) {
    const a = affectedSets(row.affected);
    for (const k of Object.keys(union) as (keyof AffectedSets)[])
      union[k] = uniq([...union[k], ...a[k]]);
    for (const m of (row.per ?? []) as {
      missionId?: string;
      mission_id?: string;
      affected: unknown;
      preserved?: { taskIds?: string[] };
    }[]) {
      const mid = (m.missionId ?? m.mission_id)!;
      const seen = perMission.get(mid);
      const prev = seen ?? { affected: affectedSets({}), preserved: [] };
      const aa = affectedSets(m.affected);
      for (const k of Object.keys(prev.affected) as (keyof AffectedSets)[])
        prev.affected[k] = uniq([...prev.affected[k], ...aa[k]]);
      // Each event preserves "all tasks minus its own affected"; over several events a task is
      // preserved only if every event preserved it (intersection = all minus the union of affected).
      const mine = m.preserved?.taskIds ?? [];
      prev.preserved = seen
        ? prev.preserved.filter((id) => mine.includes(id))
        : uniq(mine);
      perMission.set(mid, prev);
    }
    capped.push(Boolean((row.closure as { capped?: boolean } | null)?.capped));
  }

  const status = async (table: string, idCol = 'id') => {
    const sc = await w.schema.need(table, ['status']);
    const r = await w.admin.query(
      `SELECT "${idCol}" AS id, "${sc}" AS status FROM ${table}`,
    );
    return r.rows as { id: string; status: string }[];
  };
  const attempts = await status(T.attempts);
  const tasks = await status(T.tasks);
  const outCol = await w.schema.need(T.outputs, ['usable']);
  const outs = (
    await w.admin.query(`SELECT id, "${outCol}" AS usable FROM ${T.outputs}`)
  ).rows as { id: string; usable: boolean }[];
  const intents = new Map<
    string,
    { status: string; blockReason: string | null }
  >();
  if (await w.schema.exists(T.intents)) {
    const intentRows = await w.admin.query(
      `SELECT id, status, ${(await w.schema.pick(T.intents, ['block_reason'])) ? 'block_reason' : 'NULL'} AS block_reason FROM ${T.intents}`,
    );
    for (const r of intentRows.rows)
      intents.set(r.id, { status: r.status, blockReason: r.block_reason });
  }

  const receiptStatus = new Map<string, string>();
  for (const [oracle, real] of seeded.ids) {
    const rec = await w.receiptById(real);
    if (rec) receiptStatus.set(oracle, rec.status);
  }

  const coordinatorEventsByMission = new Map<string, number>();
  if (await w.schema.exists(T.events)) {
    const typeCol = await w.schema.pick(T.events, [
      'type',
      'kind',
      'event_type',
    ]);
    const missionCol = await w.schema.pick(T.events, ['mission_id']);
    if (typeCol && missionCol) {
      const r = await w.admin.query(
        `SELECT "${missionCol}" AS mission, count(*)::int AS n FROM ${T.events} WHERE "${typeCol}" = 'invalidation.recorded' GROUP BY 1`,
      );
      for (const row of r.rows)
        coordinatorEventsByMission.set(row.mission, row.n);
    }
  }

  return {
    eventRows: ev.rowCount ?? 0,
    union,
    perMission,
    attemptsInvalidated: attempts
      .filter((a) => a.status === 'invalidated')
      .map((a) => a.id)
      .sort(),
    outputsUnusable: outs
      .filter((o) => !o.usable)
      .map((o) => o.id)
      .sort(),
    tasksInvalidated: tasks
      .filter((t) => t.status === 'invalidated')
      .map((t) => t.id)
      .sort(),
    intents,
    receiptStatus,
    capped,
    coordinatorEventsByMission,
  };
}

export const mapIds = (seeded: Seeded, oracleIds: readonly string[]) =>
  uniq(oracleIds.map((id) => seeded.ids.get(id) ?? `UNSEEDED:${id}`));

export { errorCode, fillRow, insertValues };
