// Verified self-writes (ARCHITECTURE.md section 5.4, finding C7). When the
// watcher registers the head receipt of a controlled member that a committed
// action itself produced, the acting lineage is not invalidated by that
// closure: its attempt, task, model calls, published output and the intent
// keep their state and move to postcondition verification. Every other branch
// that read the old revision is still invalidated.
//
// Nothing here trusts the caller. `provenance.selfWrite` / `causedByActionId`
// arrive from the watcher, but they only excuse anything when the authority's
// own history agrees: checkout.config_versions must hold the row
// (key, version = the receipt's revision) with exactly that caused_by_action_id.
// That column is nulled by a trigger for every role except nemodots_app, so a
// forged marker (injector, owner, admin, checkout) never matches and the
// closure stays full.
import type { PgClient } from '../contracts/index.js';
import type { GraphNodeKind } from './closure.js';
import {
  checkoutSchema,
  coordinatorSchema,
  type LedgerOptions,
} from './options.js';
import { configMemberKey } from './sources.js';

export interface LineageNode {
  kind: GraphNodeKind;
  id: string;
}

/**
 * The action that wrote revision `revision` of `sourceKey`, if and only if the
 * version history says so; null otherwise (nothing is excused).
 */
export async function verifiedSelfWriteAction(
  client: PgClient,
  claim: {
    sourceKey: string;
    revision: number;
    selfWrite: string;
    causedByActionId: string | null;
  },
  options?: LedgerOptions,
): Promise<string | null> {
  if (claim.selfWrite !== 'verified' || !claim.causedByActionId) return null;
  const key = configMemberKey(claim.sourceKey);
  if (key === null) return null;
  const schema = checkoutSchema(options);
  const present = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${schema}.config_versions`],
  );
  if (!present.rows[0]?.present) return null;
  const { rows } = await client.query(
    `SELECT 1 FROM ${schema}.config_versions
      WHERE key = $1 AND version = $2 AND caused_by_action_id = $3`,
    [key, claim.revision, claim.causedByActionId],
  );
  return rows.length > 0 ? claim.causedByActionId : null;
}

/**
 * The nodes of the acting lineage of intent `actionId`: the intent itself,
 * the attempt(s) and model call(s) that emitted it (evidence edges into the
 * intent, or the intent row), their tasks, and the outputs those attempts
 * published, then the delegation ancestors of the acting task with their
 * attempts and outputs. Read-only.
 */
export async function selfWriteLineage(
  client: PgClient,
  actionId: string,
  options?: LedgerOptions,
): Promise<LineageNode[]> {
  const nodes = new Map<string, LineageNode>();
  const add = (kind: GraphNodeKind, id: string | null | undefined) => {
    if (id) nodes.set(`${kind}:${id}`, { kind, id });
  };
  add('action_intent', actionId);

  const attempts = new Set<string>();
  const edges = await client.query<{
    from_kind: GraphNodeKind;
    from_id: string;
  }>(
    `SELECT from_kind, from_id FROM ledger.dependency_edges
      WHERE to_kind = 'action_intent' AND to_id = $1 AND kind = 'evidence'
        AND from_kind IN ('attempt', 'model_call')`,
    [actionId],
  );
  for (const row of edges.rows) {
    add(row.from_kind, row.from_id);
    if (row.from_kind === 'attempt') attempts.add(row.from_id);
  }

  const schema = coordinatorSchema(options);
  const present = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${schema}.action_intents`],
  );
  if (present.rows[0]?.present) {
    const intent = await client.query<{
      attempt_id: string;
      task_id: string;
      model_call_id: string | null;
    }>(
      `SELECT attempt_id, task_id, model_call_id FROM ${schema}.action_intents WHERE id = $1`,
      [actionId],
    );
    if (intent.rows[0]) {
      attempts.add(intent.rows[0].attempt_id);
      add('attempt', intent.rows[0].attempt_id);
      add('task', intent.rows[0].task_id);
      add('model_call', intent.rows[0].model_call_id);
    }
  }
  const ids = [...attempts];
  const taskIds = new Set<string>();
  for (const node of nodes.values())
    if (node.kind === 'task') taskIds.add(node.id);
  if (ids.length > 0) {
    const tasks = await client.query<{ task_id: string | null }>(
      `SELECT DISTINCT task_id FROM ledger.dependency_nodes
        WHERE kind = 'attempt' AND id = ANY($1::uuid[]) AND task_id IS NOT NULL`,
      [ids],
    );
    for (const row of tasks.rows) {
      add('task', row.task_id);
      if (row.task_id) taskIds.add(row.task_id);
    }
    const outputs = await client.query<{ to_id: string }>(
      `SELECT to_id FROM ledger.dependency_edges
        WHERE from_kind = 'attempt' AND from_id = ANY($1::uuid[])
          AND to_kind = 'task_output' AND kind = 'evidence'`,
      [ids],
    );
    for (const row of outputs.rows) add('task_output', row.to_id);
    if (await hasColumn(client, schema, 'task_outputs', 'attempt_id')) {
      const published = await client.query<{ id: string }>(
        `SELECT id FROM ${schema}.task_outputs WHERE attempt_id = ANY($1::uuid[])`,
        [ids],
      );
      for (const row of published.rows) add('task_output', row.id);
    }
  }

  // Delegation ancestors: the tasks that delegated, directly or transitively,
  // to the acting task, with their attempts and outputs. Their premise became
  // the expected revision through the delegated repair, so they are part of
  // the acting lineage. Siblings (other children of an ancestor) and every
  // branch whose support does not run through the delegation chain are not.
  if (
    taskIds.size > 0 &&
    (await hasColumn(client, schema, 'tasks', 'parent_id'))
  ) {
    const ancestors = await client.query<{ id: string }>(
      `WITH RECURSIVE up(id, parent_id) AS (
         SELECT t.id, t.parent_id FROM ${schema}.tasks t WHERE t.id = ANY($1::uuid[])
         UNION
         SELECT p.id, p.parent_id FROM ${schema}.tasks p
           JOIN up ON p.id = up.parent_id
           JOIN ${schema}.tasks child ON child.id = up.id AND child.mission_id = p.mission_id
       )
       SELECT id FROM up WHERE NOT (id = ANY($1::uuid[]))`,
      [[...taskIds]],
    );
    const ancestorIds = ancestors.rows.map((row) => row.id);
    for (const id of ancestorIds) add('task', id);
    if (ancestorIds.length > 0) {
      const theirAttempts = await client.query<{ id: string }>(
        `SELECT id FROM ledger.dependency_nodes
          WHERE kind = 'attempt' AND task_id = ANY($1::uuid[])`,
        [ancestorIds],
      );
      for (const row of theirAttempts.rows) add('attempt', row.id);
      const theirOutputs = await client.query<{ to_id: string }>(
        `SELECT e.to_id FROM ledger.dependency_edges e
           JOIN ledger.dependency_nodes n ON n.kind = 'attempt' AND n.id = e.from_id
          WHERE e.from_kind = 'attempt' AND e.to_kind = 'task_output'
            AND e.kind = 'evidence' AND n.task_id = ANY($1::uuid[])`,
        [ancestorIds],
      );
      for (const row of theirOutputs.rows) add('task_output', row.to_id);
      if (await hasColumn(client, schema, 'task_outputs', 'task_id')) {
        const published = await client.query<{ id: string }>(
          `SELECT id FROM ${schema}.task_outputs WHERE task_id = ANY($1::uuid[])`,
          [ancestorIds],
        );
        for (const row of published.rows) add('task_output', row.id);
      }
    }
  }
  return [...nodes.values()];
}

async function hasColumn(
  client: PgClient,
  schema: string,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column],
  );
  return rows.length > 0;
}
