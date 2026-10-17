// Model-call records (CONTRACTS.md section 3, ARCHITECTURE.md sections 5.2 and
// 6, findings C13 and C16).
//
// recordModelCall is the FENCED path: one transaction stores the
// ContextSnapshot, the ModelCallRecord (with its toolCalls), the inference
// attempts and the evidence / inheritance edges that make the call part of the
// invalidation closure. The coordinator checks the attempt's fence and
// generation before calling it; this function additionally re-validates the
// whole dependency vector with assertCurrent(lockMode 'share'), so a
// publication resting on a superseded receipt cannot enter the graph.
//
// recordOrphanedAttempt is the UNFENCED telemetry path: a call that completed
// on the provider after the author's lease was lost keeps its cost accounting
// (inference_attempts rows with outcome 'orphaned_fence') and nothing else:
// no record, no snapshot, no edges, no output reuse.
import {
  ContextSnapshotSchema,
  InferenceAttemptSchema,
  ModelCallRecordSchema,
  type ContextSnapshot,
  type InferenceAttempt,
  type ModelCallId,
  type ModelCallRecord,
  type ModelRole,
  type PgClient,
  type Scope,
} from '../contracts/index.js';
import { addEdges, type EdgeInput, type NodeRef } from './edges.js';
import { ModelCallRecordError, SupportError } from './errors.js';
import { coordinatorSchema, type LedgerOptions } from './options.js';
import { getReceiptRows } from './receipt-store.js';
import { assertCurrent } from './support.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecordModelCallInput {
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
}

export interface RecordedModelCall {
  /** False when the same record was already stored (redelivery). */
  created: boolean;
  inferenceAttempts: number;
  edges: { inserted: number; existing: number };
}

interface AttemptContext {
  modelCallId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
  role: ModelRole;
  requested: string;
  returned: string | null;
  host: string;
  mode: 'live' | 'fixture';
}

async function insertInferenceAttempts(
  client: PgClient,
  context: AttemptContext,
  attempts: readonly InferenceAttempt[],
  outcome: 'recorded' | 'orphaned_fence',
): Promise<number> {
  let inserted = 0;
  for (const attempt of attempts) {
    const result = await client.query(
      `INSERT INTO ledger.inference_attempts
         (model_call_id, n, mission_id, task_id, attempt_id, role, model_requested,
          model_returned, provider_host, provider_mode, started_at, headers_at,
          first_content_at, finished_at, http_status, prompt_tokens, completion_tokens,
          cached_tokens, reasoning_tokens, finish_reason, error_class, error_code,
          error_id, retry_after_ms, streamed, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       ON CONFLICT (model_call_id, n) DO NOTHING`,
      [
        context.modelCallId,
        attempt.n,
        context.missionId,
        context.taskId,
        context.attemptId,
        context.role,
        context.requested,
        context.returned,
        context.host,
        context.mode,
        attempt.startedAt,
        attempt.headersAt,
        attempt.firstContentAt,
        attempt.finishedAt,
        attempt.httpStatus,
        attempt.usage.promptTokens,
        attempt.usage.completionTokens,
        attempt.usage.cachedTokens,
        attempt.usage.reasoningTokens,
        attempt.finishReason,
        attempt.error?.class ?? null,
        attempt.error?.code ?? null,
        attempt.error?.errorId ?? null,
        attempt.retryAfterMs,
        attempt.streamed,
        outcome,
      ],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

function modelCallEdges(
  record: ModelCallRecord,
  snapshot: ContextSnapshot,
): EdgeInput[] {
  const { missionId } = record.scope;
  const modelCall: NodeRef = {
    kind: 'model_call',
    id: record.id,
    missionId,
    taskId: record.taskId,
  };
  const attempt: NodeRef = {
    kind: 'attempt',
    id: record.attemptId,
    missionId,
    taskId: record.taskId,
  };
  const edges: EdgeInput[] = [];
  // Evidence: every receipt in the output vector (>= the input vector) is a
  // premise of the call and of the attempt that made it.
  for (const entry of record.outputDependencyVector) {
    const receipt: NodeRef = { kind: 'receipt', id: entry.receiptId };
    edges.push({ kind: 'evidence', from: receipt, to: modelCall });
    edges.push({ kind: 'evidence', from: receipt, to: attempt });
  }
  // Inheritance: outputs/handoffs injected into the context (validated and
  // locked by lockInheritedOutputs before any of this is written).
  for (const id of inheritedOutputIds(snapshot)) {
    const output: NodeRef = { kind: 'task_output', id };
    edges.push({ kind: 'inheritance', from: output, to: modelCall });
    edges.push({ kind: 'inheritance', from: output, to: attempt });
  }
  return edges;
}

/** Ids of the outputs and handoffs the context inherits (both live in task_outputs). */
function inheritedOutputIds(snapshot: ContextSnapshot): string[] {
  const ids = new Set<string>();
  for (const artifact of snapshot.injected.inheritedArtifacts) {
    if (artifact.kind !== 'task_output' && artifact.kind !== 'handoff')
      continue;
    if (!UUID.test(artifact.id))
      throw new ModelCallRecordError(
        'model_call_invalid',
        `inherited ${artifact.kind} id is not a uuid`,
      );
    ids.add(artifact.id.toLowerCase());
  }
  return [...ids].sort();
}

/**
 * Locks every inherited output FOR SHARE (id order) and refuses the call unless
 * each exists, is still usable, and rests only on receipts the call cites. The
 * lock is what ties the new inheritance edges to the closure: an invalidation
 * of the output (FOR UPDATE on the same row) either committed before this read
 * (the output is unusable, the call is refused) or waits until this transaction
 * has written its edges and then reaches them. The stored dependency vector of
 * the output is authoritative; the dependencyReceiptIds the caller lists in the
 * snapshot are not trusted.
 */
async function lockInheritedOutputs(
  client: PgClient,
  ids: readonly string[],
  cited: ReadonlySet<string>,
  options?: LedgerOptions,
): Promise<void> {
  if (ids.length === 0) return;
  const schema = coordinatorSchema(options);
  const { rows } = await client.query<{
    id: string;
    usable: boolean;
    dependency_vector: unknown;
  }>(
    `SELECT id, usable, dependency_vector FROM ${schema}.task_outputs
      WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
    [ids],
  );
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = found.get(id);
    if (!row)
      throw new ModelCallRecordError(
        'model_call_invalid',
        `inherited output ${id} does not exist`,
      );
    if (!row.usable)
      throw new SupportError(
        'stale_version',
        `inherited output ${id} is no longer usable`,
      );
    const vector = Array.isArray(row.dependency_vector)
      ? (row.dependency_vector as unknown[])
      : null;
    if (!vector)
      throw new ModelCallRecordError(
        'model_call_invalid',
        `inherited output ${id} has no readable dependency vector`,
      );
    for (const entry of vector) {
      const receiptId = (entry as { receiptId?: unknown } | null)?.receiptId;
      if (typeof receiptId !== 'string')
        throw new ModelCallRecordError(
          'model_call_invalid',
          `inherited output ${id} has a malformed dependency vector entry`,
        );
      if (!cited.has(receiptId))
        throw new ModelCallRecordError(
          'model_call_invalid',
          `inherited output ${id} rests on receipt ${receiptId}, which the call does not cite`,
        );
    }
  }
}

/**
 * Stores one fenced model call. Rejects (SupportError) when any receipt of the
 * output dependency vector is no longer current; the caller turns that into
 * the invalidation + repair path (C13). Redelivery of an identical record is
 * idempotent.
 */
export async function recordModelCall(
  client: PgClient,
  input: RecordModelCallInput,
  options?: LedgerOptions,
): Promise<RecordedModelCall> {
  const parsedRecord = ModelCallRecordSchema.safeParse(input.record);
  if (!parsedRecord.success)
    throw new ModelCallRecordError(
      'model_call_invalid',
      `model call record is invalid: ${parsedRecord.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  const parsedSnapshot = ContextSnapshotSchema.safeParse(input.snapshot);
  if (!parsedSnapshot.success)
    throw new ModelCallRecordError(
      'model_call_invalid',
      `context snapshot is invalid: ${parsedSnapshot.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  const record = parsedRecord.data;
  const snapshot = parsedSnapshot.data;
  if (record.contextSnapshotId !== snapshot.id)
    throw new ModelCallRecordError(
      'model_call_invalid',
      'record.contextSnapshotId does not name the supplied snapshot',
    );
  if (record.attempts.some((attempt) => attempt.outcome !== 'recorded'))
    throw new ModelCallRecordError(
      'model_call_invalid',
      "a fenced record carries attempts with outcome 'recorded' only; orphaned attempts use recordOrphanedAttempt",
    );
  const outputReceipts = new Set(
    record.outputDependencyVector.map((entry) => entry.receiptId as string),
  );
  for (const entry of snapshot.dependencyVector)
    if (!outputReceipts.has(entry.receiptId))
      throw new ModelCallRecordError(
        'model_call_invalid',
        'outputDependencyVector must contain the snapshot dependencyVector (citations add, never remove)',
      );

  // Lock order (prelock.ts): coordinator rows (the inherited outputs) first,
  // then the ledger rows assertCurrent locks.
  const receiptIds = record.outputDependencyVector.map(
    (entry) => entry.receiptId,
  );
  await lockInheritedOutputs(
    client,
    inheritedOutputIds(snapshot),
    new Set<string>(receiptIds),
    options,
  );
  // Currency: locks the controlled rows, observed registry rows and receipt
  // rows FOR SHARE, so the edges inserted below cannot be missed by a closure.
  await assertCurrent(client, receiptIds, { lockMode: 'share' }, options);
  const stored = await getReceiptRows(client, receiptIds);
  for (const entry of record.outputDependencyVector) {
    const row = stored.get(entry.receiptId);
    if (
      !row ||
      row.sourceKey !== entry.sourceKey ||
      row.sourceRevision !== entry.sourceRevision
    )
      throw new ModelCallRecordError(
        'model_call_invalid',
        `dependency entry ${entry.receiptId} does not match the stored receipt`,
      );
  }

  await client.query(
    `INSERT INTO ledger.context_snapshots
       (id, mission_id, context_schema_version, layout, prefix_digest, prefix_length,
        context_digest, context_length, tool_schema_hash, injected, dependency_vector, volatile_now)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
     ON CONFLICT (id) DO NOTHING`,
    [
      snapshot.id,
      record.scope.missionId,
      snapshot.contextSchemaVersion,
      snapshot.layout,
      snapshot.prefixDigest,
      snapshot.prefixLength,
      snapshot.contextDigest,
      snapshot.contextLength,
      snapshot.toolSchemaHash,
      JSON.stringify(snapshot.injected),
      JSON.stringify(snapshot.dependencyVector),
      snapshot.volatile.nowIso,
    ],
  );
  const existingSnapshot = await client.query<{ context_digest: string }>(
    'SELECT context_digest FROM ledger.context_snapshots WHERE id = $1',
    [snapshot.id],
  );
  if (existingSnapshot.rows[0].context_digest !== snapshot.contextDigest)
    throw new ModelCallRecordError(
      'model_call_conflict',
      `context snapshot ${snapshot.id} exists with a different digest`,
    );

  const inserted = await client.query(
    `INSERT INTO ledger.model_call_records
       (id, scope, mission_id, task_id, attempt_id, role, model_requested, model_returned,
        provider_host, provider_mode, context_snapshot_id, outcome, output_digest,
        output_dependency_vector, tool_calls, created_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16)
     ON CONFLICT (id) DO NOTHING`,
    [
      record.id,
      JSON.stringify(record.scope),
      record.scope.missionId,
      record.taskId,
      record.attemptId,
      record.role,
      record.model.requested,
      record.model.returned,
      record.provider.host,
      record.provider.mode,
      record.contextSnapshotId,
      record.outcome,
      record.outputDigest,
      JSON.stringify(record.outputDependencyVector),
      JSON.stringify(record.toolCalls),
      record.createdAt,
    ],
  );
  const created = inserted.rowCount === 1;
  if (!created) {
    const existing = await client.query<{
      output_digest: string | null;
      context_snapshot_id: string;
      attempt_id: string;
    }>(
      'SELECT output_digest, context_snapshot_id, attempt_id FROM ledger.model_call_records WHERE id = $1',
      [record.id],
    );
    const row = existing.rows[0];
    if (
      row.output_digest !== record.outputDigest ||
      row.context_snapshot_id !== record.contextSnapshotId ||
      row.attempt_id !== record.attemptId
    )
      throw new ModelCallRecordError(
        'model_call_conflict',
        `model call ${record.id} was already recorded with different content`,
      );
  }

  const inferenceAttempts = await insertInferenceAttempts(
    client,
    {
      modelCallId: record.id,
      missionId: record.scope.missionId,
      taskId: record.taskId,
      attemptId: record.attemptId,
      role: record.role,
      requested: record.model.requested,
      returned: record.model.returned,
      host: record.provider.host,
      mode: record.provider.mode,
    },
    record.attempts,
    'recorded',
  );
  const edges = await addEdges(client, modelCallEdges(record, snapshot));
  return { created, inferenceAttempts, edges };
}

export interface RecordOrphanedAttemptInput {
  modelCallId: ModelCallId;
  scope: Scope;
  taskId: string;
  attemptId: string;
  role: ModelRole;
  model: { requested: string; returned: string | null };
  provider: { host: string; mode: 'live' | 'fixture' };
  attempts: readonly InferenceAttempt[];
}

/**
 * Telemetry for a call whose fenced record was rejected (lease lost while the
 * provider request was in flight, C16). Writes ONLY ledger.inference_attempts
 * rows with outcome 'orphaned_fence': no record, no snapshot, no edges, so the
 * result can never become support or be reused. Idempotent per (call, n).
 */
export async function recordOrphanedAttempt(
  client: PgClient,
  input: RecordOrphanedAttemptInput,
): Promise<{ inserted: number }> {
  if (input.attempts.length === 0)
    throw new ModelCallRecordError(
      'model_call_invalid',
      'an orphaned call has at least one inference attempt',
    );
  const attempts = input.attempts.map((attempt) => {
    const parsed = InferenceAttemptSchema.safeParse({
      ...attempt,
      outcome: 'orphaned_fence',
    });
    if (!parsed.success)
      throw new ModelCallRecordError(
        'model_call_invalid',
        `inference attempt ${attempt.n} is invalid: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; ')}`,
      );
    return parsed.data;
  });
  const recorded = await client.query(
    'SELECT 1 FROM ledger.model_call_records WHERE id = $1',
    [input.modelCallId],
  );
  if (recorded.rows.length > 0)
    throw new ModelCallRecordError(
      'model_call_conflict',
      `model call ${input.modelCallId} has a fenced record; it is not orphaned`,
    );
  const inserted = await insertInferenceAttempts(
    client,
    {
      modelCallId: input.modelCallId,
      missionId: input.scope.missionId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      role: input.role,
      requested: input.model.requested,
      returned: input.model.returned,
      host: input.provider.host,
      mode: input.provider.mode,
    },
    attempts,
    'orphaned_fence',
  );
  return { inserted };
}
