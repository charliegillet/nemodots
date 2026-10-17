// Loads a symbolic graph (tests/nemodots/ledger/graph-dsl.ts) into the ledger
// and the fixture coordinator tables with real UUIDs, and maps results back to
// the symbolic names so assertions read as the hand-drawn graph.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  Affected,
  InvalidationEvent,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  addEdges,
  registerObservation,
  type NodeRef,
  type RegisterOptions,
  type RegisterResult,
} from '../../../../src/server/nemodots/ledger/index.js';
import type { DslNode } from '../../ledger/graph-dsl.js';
import {
  FX,
  collectionState,
  inTx,
  newScope,
  readMember,
  sourceRef,
  updateConfig,
  type TestScope,
} from './fixtures.js';

export interface ReceiptSpec {
  key: string;
  environment?: TestScope['environment'];
}

export interface GraphOptions {
  receipts: Record<string, ReceiptSpec>;
  attemptStatus?: Record<string, string>;
  intentStatus?: Record<string, string>;
  taskStatus?: Record<string, string>;
}

export interface LoadedGraph {
  scope: TestScope;
  /** symbolic -> uuid */
  id: (symbol: string) => string;
  /** uuid -> symbolic */
  symbol: (uuid: string) => string;
  receiptSpec: (symbol: string) => ReceiptSpec;
  scopeOf: (symbol: string) => TestScope;
  nodes: readonly DslNode[];
}

const HEALTH = (n: number) => ({ rev: n });

function scopeFor(base: TestScope, spec: ReceiptSpec): TestScope {
  return { ...base, environment: spec.environment ?? base.environment };
}

/** Registers the receipts, inserts coordinator rows and adds the edges. */
export async function loadGraph(
  app: pg.Pool,
  nodes: readonly DslNode[],
  edges: readonly {
    kind: 'evidence' | 'inheritance' | 'scheduling';
    from: string;
    to: string;
  }[],
  options: GraphOptions,
): Promise<LoadedGraph> {
  const scope = newScope();
  const ids = new Map<string, string>();
  const missionIds = new Map<string, string>();
  const reverse = new Map<string, string>();
  const missionOf = (missionSymbol: string) => {
    let id = missionIds.get(missionSymbol);
    if (!id) {
      id = randomUUID();
      missionIds.set(missionSymbol, id);
      reverse.set(id, missionSymbol);
    }
    return id;
  };
  const taskUuid = new Map<string, string>();

  // receipts first: the ledger assigns their ids
  for (const node of nodes.filter((n) => n.kind === 'receipt')) {
    const spec = options.receipts[node.id];
    if (!spec) throw new Error(`no receipt spec for ${node.id}`);
    const receiptScope = scopeFor(scope, spec);
    const result = await inTx(app, async (client) => {
      const common = { provenance: { kind: 'watcher' as const } };
      if (spec.key === 'checkout.config') {
        const state = await collectionState(client);
        return registerObservation(
          client,
          {
            source: sourceRef(receiptScope, spec.key),
            normalizedValue: state,
            ...common,
          },
          { ledger: FX },
        );
      }
      if (spec.key.startsWith('checkout.config/')) {
        const read = await readMember(
          client,
          spec.key.slice('checkout.config/'.length),
        );
        return registerObservation(
          client,
          {
            source: sourceRef(receiptScope, spec.key),
            normalizedValue: read.normalizedValue,
            ...common,
          },
          { ledger: FX },
        );
      }
      return registerObservation(
        client,
        {
          source: sourceRef(receiptScope, spec.key),
          normalizedValue: HEALTH(1),
          ...common,
        },
        { ledger: FX },
      );
    });
    ids.set(node.id, result.receipt.id);
    reverse.set(result.receipt.id, node.id);
  }
  for (const node of nodes.filter((n) => n.kind !== 'receipt')) {
    const id = randomUUID();
    ids.set(node.id, id);
    reverse.set(id, node.id);
    if (node.kind === 'task') taskUuid.set(node.id, id);
  }

  const mission = (node: DslNode) =>
    node.missionId ? missionOf(node.missionId) : null;
  const taskOf = (node: DslNode) =>
    node.taskId ? ids.get(node.taskId)! : null;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // coordinator rows
  await inTx(app, async (client) => {
    for (const node of nodes) {
      const id = ids.get(node.id)!;
      switch (node.kind) {
        case 'task':
          await client.query(
            'INSERT INTO fx_coordinator.tasks (id, mission_id, status) VALUES ($1, $2, $3)',
            [id, mission(node), options.taskStatus?.[node.id] ?? 'succeeded'],
          );
          break;
        case 'attempt':
          await client.query(
            'INSERT INTO fx_coordinator.task_attempts (id, task_id, mission_id, status) VALUES ($1, $2, $3, $4)',
            [
              id,
              taskOf(node),
              mission(node),
              options.attemptStatus?.[node.id] ?? 'published',
            ],
          );
          break;
        case 'task_output':
          await client.query(
            'INSERT INTO fx_coordinator.task_outputs (id, task_id) VALUES ($1, $2)',
            [id, taskOf(node)],
          );
          break;
        case 'action_intent':
          await client.query(
            'INSERT INTO fx_coordinator.action_intents (id, mission_id, task_id, status) VALUES ($1, $2, $3, $4)',
            [
              id,
              mission(node),
              taskOf(node),
              options.intentStatus?.[node.id] ?? 'proposed',
            ],
          );
          break;
        default:
          break;
      }
    }
  });

  const ref = (symbol: string): NodeRef => {
    const node = byId.get(symbol)!;
    return {
      kind: node.kind,
      id: ids.get(symbol)!,
      missionId: mission(node),
      taskId: node.kind === 'task' ? null : taskOf(node),
    };
  };
  await inTx(app, (client) =>
    addEdges(
      client,
      edges.map((edge) => ({
        kind: edge.kind,
        from: ref(edge.from),
        to: ref(edge.to),
      })),
    ),
  );

  return {
    scope,
    nodes,
    id: (symbol) => {
      const value = ids.get(symbol) ?? missionIds.get(symbol);
      if (!value) throw new Error(`unknown symbol ${symbol}`);
      return value;
    },
    symbol: (uuid) => reverse.get(uuid) ?? uuid,
    receiptSpec: (symbol) => options.receipts[symbol],
    scopeOf: (symbol) => scopeFor(scope, options.receipts[symbol]),
  };
}

/** Moves the authority / observed source of a receipt symbol and registers the new observation. */
export async function changeReceipt(
  app: pg.Pool,
  graph: LoadedGraph,
  symbol: string,
  how:
    | 'member_value_change'
    | 'collection_insert'
    | 'collection_delete'
    | 'observed_digest_change',
  hooks?: RegisterOptions['hooks'],
): Promise<RegisterResult> {
  const spec = graph.receiptSpec(symbol);
  const scope = graph.scopeOf(symbol);
  return inTx(app, async (client) => {
    const common = { provenance: { kind: 'watcher' as const } };
    const options = { ledger: FX, hooks };
    if (how === 'observed_digest_change')
      return registerObservation(
        client,
        {
          source: sourceRef(scope, spec.key),
          normalizedValue: HEALTH(2),
          ...common,
        },
        options,
      );
    if (how === 'member_value_change') {
      const key = spec.key.slice('checkout.config/'.length);
      await updateConfig(client, key, `changed-${randomUUID()}`);
      const read = await readMember(client, key);
      return registerObservation(
        client,
        {
          source: sourceRef(scope, spec.key),
          normalizedValue: read.normalizedValue,
          claimed: { sourceRevision: read.version },
          ...common,
        },
        options,
      );
    }
    if (how === 'collection_insert') {
      await client.query(
        'SELECT version FROM fx_checkout.config_collection FOR UPDATE',
      );
      await client.query(
        "INSERT INTO fx_checkout.config_entries (key, value, version) VALUES ($1, 'true'::jsonb, 1)",
        [`checkout.restrict_${randomUUID().slice(0, 8)}`],
      );
      await client.query(
        'UPDATE fx_checkout.config_collection SET version = version + 1',
      );
    } else {
      await client.query(
        'SELECT version FROM fx_checkout.config_collection FOR UPDATE',
      );
      await client.query(
        'DELETE FROM fx_checkout.config_entries WHERE key = (SELECT key FROM fx_checkout.config_entries ORDER BY key LIMIT 1)',
      );
      await client.query(
        'UPDATE fx_checkout.config_collection SET version = version + 1',
      );
    }
    const state = await collectionState(client);
    return registerObservation(
      client,
      { source: sourceRef(scope, spec.key), normalizedValue: state, ...common },
      options,
    );
  });
}

export function symbolic(graph: LoadedGraph, affected: Affected) {
  const map = (ids: readonly string[]) =>
    ids.map((id) => graph.symbol(id)).sort();
  return {
    modelCallIds: map(affected.modelCallIds),
    attemptIds: map(affected.attemptIds),
    outputIds: map(affected.outputIds),
    actionIds: map(affected.actionIds),
    taskIds: map(affected.taskIds),
  };
}

export function symbolicPerMission(
  graph: LoadedGraph,
  event: InvalidationEvent,
) {
  return event.perMission
    .map((entry) => ({
      missionId: graph.symbol(entry.missionId),
      affected: symbolic(graph, entry.affected),
      preserved: entry.preserved.taskIds.map((id) => graph.symbol(id)).sort(),
    }))
    .sort((a, b) => (a.missionId < b.missionId ? -1 : 1));
}

export async function coordinatorState(app: pg.Pool, graph: LoadedGraph) {
  const state: Record<string, string> = {};
  const rows = await Promise.all([
    app.query<{ id: string; status: string; abort_reason: string | null }>(
      'SELECT id, status, abort_reason FROM fx_coordinator.task_attempts',
    ),
    app.query<{ id: string; status: string }>(
      'SELECT id, status FROM fx_coordinator.tasks',
    ),
    app.query<{ id: string; usable: boolean; unusable_reason: string | null }>(
      'SELECT id, usable, unusable_reason FROM fx_coordinator.task_outputs',
    ),
    app.query<{ id: string; status: string; block_reason: string | null }>(
      'SELECT id, status, block_reason FROM fx_coordinator.action_intents',
    ),
  ]);
  for (const row of rows[0].rows) state[graph.symbol(row.id)] = row.status;
  for (const row of rows[1].rows) state[graph.symbol(row.id)] = row.status;
  for (const row of rows[2].rows)
    state[graph.symbol(row.id)] = row.usable ? 'usable' : 'unusable';
  for (const row of rows[3].rows)
    state[graph.symbol(row.id)] = row.block_reason
      ? `${row.status}(${row.block_reason})`
      : row.status;
  return state;
}
