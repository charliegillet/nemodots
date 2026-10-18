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
 * published. Read-only.
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
  if (attempts.size === 0) return [...nodes.values()];

  const ids = [...attempts];
  const tasks = await client.query<{ task_id: string | null }>(
    `SELECT DISTINCT task_id FROM ledger.dependency_nodes
      WHERE kind = 'attempt' AND id = ANY($1::uuid[]) AND task_id IS NOT NULL`,
    [ids],
  );
  for (const row of tasks.rows) add('task', row.task_id);
  const outputs = await client.query<{ to_id: string }>(
    `SELECT to_id FROM ledger.dependency_edges
      WHERE from_kind = 'attempt' AND from_id = ANY($1::uuid[])
        AND to_kind = 'task_output' AND kind = 'evidence'`,
    [ids],
  );
  for (const row of outputs.rows) add('task_output', row.to_id);
  const outputTable = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${schema}.task_outputs`],
  );
  if (outputTable.rows[0]?.present) {
    const published = await client
      .query<{ id: string }>(
        `SELECT id FROM ${schema}.task_outputs WHERE attempt_id = ANY($1::uuid[])`,
        [ids],
      )
      .catch(() => ({ rows: [] as { id: string }[] }));
    for (const row of published.rows) add('task_output', row.id);
  }
  return [...nodes.values()];
}
