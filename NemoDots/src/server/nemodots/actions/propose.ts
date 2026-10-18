// ActionAdmissionPort.propose (ARCHITECTURE 5.1, CONTRACTS 5).
//
// Everything that matters is derived here, never read from the model:
//   - identity and capability from the AttemptContext (server-built),
//   - dependency vector = the emitting call's snapshot.dependencyVector ∪ the
//     cited receipts, each citation scope-checked (C10 / I8),
//   - expectedTargetVersion from the vector's target receipt (C11),
//   - payloadHash over action + strict payload + citations,
//   - idempotencyKey from the tool call id (C5).
// The author's fence is validated INSIDE the insert transaction: a proposal
// from a lost lease writes nothing (FenceError). Admission happens later and
// separately, from the outbox.
import { isMutated } from '../config/mutation.js';
import { randomUUID } from 'node:crypto';
import {
  actionTargetSourceKey,
  ADAPTER_POLICY,
  INTENT_TTL_MS,
  POLICY_VERSION,
  ProposeInputSchema,
  requiredSourcesFor,
  type ActionIntent,
  type AttemptContext,
  type BlockReason,
  type DependencyEntry,
  type DependencyVector,
  type EventPayload,
  type ModelCallId,
  type PgClient,
} from '../contracts/index.js';
import { lockFencedAttempt } from '../coordinator/fence.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import { withTransaction } from '../db/tx.js';
import { linkPublication } from '../ledger/edges.js';
import { getReceiptRows } from '../ledger/receipt-store.js';
import type { ActionsDeps } from './deps.js';
import { decidedEvent, flushEvents } from './emit.js';
import { ProposalRejectedError } from './errors.js';
import {
  capabilityFor,
  citationInScope,
  expectedTargetVersionOf,
  idempotencyKeyOf,
  intentVector,
  payloadHashOf,
  payloadInDomain,
  type ActionPayload,
} from './policy.js';
import {
  insertAuthorization,
  toIntent,
  type AuthorizationInput,
  type IntentRow,
} from './rows.js';

export type ProposeContext = AttemptContext & {
  modelCallId: ModelCallId;
  toolCallId: string;
};

export const ACTION_PROPOSED_TOPIC = 'action.proposed';

interface EmittingCall {
  attemptId: string;
  missionId: string;
  toolCallIds: string[];
  snapshotVector: DependencyVector;
}

async function loadEmittingCall(
  client: PgClient,
  modelCallId: string,
): Promise<EmittingCall | null> {
  const { rows } = await client.query<{
    attempt_id: string;
    mission_id: string;
    tool_calls: { toolCallId: string }[];
    dependency_vector: DependencyVector;
  }>(
    `SELECT m.attempt_id, m.mission_id, m.tool_calls, s.dependency_vector
       FROM ledger.model_call_records m
       JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
      WHERE m.id = $1`,
    [modelCallId],
  );
  const row = rows[0];
  return row
    ? {
        attemptId: row.attempt_id,
        missionId: row.mission_id,
        toolCallIds: row.tool_calls.map((call) => call.toolCallId),
        snapshotVector: row.dependency_vector,
      }
    : null;
}

async function liveTargetVersion(
  client: PgClient,
  sourceKey: string,
): Promise<number> {
  const key = sourceKey.replace(/^checkout\.config\//, '');
  const { rows } = await client.query<{ version: number }>(
    'SELECT version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  return rows[0] ? Number(rows[0].version) : 0;
}

export async function propose(
  deps: ActionsDeps,
  rawInput: unknown,
  ctx: ProposeContext,
): Promise<ActionIntent> {
  const parsed = ProposeInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new ProposalRejectedError(
      'payload_invalid',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    );
  const input = parsed.data;
  const action = input.action;
  const payload = input.payload as ActionPayload;
  // A payload outside the adapter's value domain fails exactly like a
  // malformed one: thrown, nothing stored (the model call and its tool result
  // already record the attempt). Only well-formed proposals that fail a
  // policy predicate are stored as blocked intents.
  if (!payloadInDomain(action, payload))
    throw new ProposalRejectedError(
      'payload_invalid',
      'the payload is outside the value domain of the adapter',
    );

  return withTransaction(deps.pool, async (client) => {
    // Author fence + generation + mission share lock, inside this transaction.
    const fenced = await lockFencedAttempt(client as never, ctx);

    const call = await loadEmittingCall(client, ctx.modelCallId);
    if (!call)
      throw new ProposalRejectedError(
        'unknown_model_call',
        `model call ${ctx.modelCallId} is not recorded`,
      );
    if (call.attemptId !== ctx.attemptId || call.missionId !== ctx.missionId)
      throw new ProposalRejectedError(
        'model_call_mismatch',
        'the emitting call belongs to another attempt or mission',
      );
    if (!call.toolCallIds.includes(ctx.toolCallId))
      throw new ProposalRejectedError(
        'unknown_tool_call',
        `tool call ${ctx.toolCallId} was not emitted by model call ${ctx.modelCallId}`,
      );

    // Citations: scope first (I8), then resolved to vector entries.
    const cited = [...new Set(input.supportingReceiptIds as string[])].sort();
    const scope = citationInScope(cited, {
      snapshotVector: call.snapshotVector,
      readSetReceiptIds: fenced.attempt.read_set_receipt_ids,
      inheritedVector: fenced.attempt.inherited_dependency_vector,
    });
    const rows = await getReceiptRows(client, scope.inScope);
    const citedEntries: DependencyEntry[] = [];
    const unresolved: string[] = [];
    for (const id of scope.inScope) {
      const row = rows.get(id);
      if (row)
        citedEntries.push({
          sourceKey: row.sourceKey,
          sourceRevision: row.sourceRevision,
          receiptId: row.id,
        });
      else unresolved.push(id);
    }
    const outOfScope = [...scope.outOfScope, ...unresolved];
    // MUTATION drop_inherited_edges: the emitting snapshot's vector is dropped,
    // only the citations remain.
    const vector = intentVector(
      isMutated('drop_inherited_edges') ? [] : call.snapshotVector,
      citedEntries,
    );
    const expectedTargetVersion = expectedTargetVersionOf(
      action,
      payload,
      vector,
    );
    const payloadHash = payloadHashOf(action, payload, cited);
    const idempotencyKey = idempotencyKeyOf({
      missionId: ctx.missionId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      action,
      expectedTargetVersion,
      toolCallId: ctx.toolCallId,
    });

    // Idempotency (C5). The attempt row is locked FOR UPDATE above and the
    // key contains the attempt id, so concurrent proposals of one key
    // serialize here.
    const existing = await client.query<IntentRow>(
      `SELECT * FROM coordinator.action_intents
        WHERE idempotency_key = $1
           OR (attempt_id = $2 AND tool_call_id = $3)
        ORDER BY proposed_at DESC, id`,
      [idempotencyKey, ctx.attemptId, ctx.toolCallId],
    );
    // MUTATION accept_duplicate_differing_payloads: a different payload under
    // a used key / tool call id is accepted as the stored call (no conflict).
    if (isMutated('accept_duplicate_differing_payloads') && existing.rows[0])
      return toIntent(
        existing.rows.find((row) => row.status !== 'blocked') ??
          existing.rows[existing.rows.length - 1],
      );
    const same = existing.rows.find((row) => row.payload_hash === payloadHash);
    if (same) return toIntent(same);
    const conflict = existing.rows.length > 0;

    // Decide whether the proposal is storable as proposed or recorded blocked.
    let blockReason: BlockReason | null = null;
    let blockDetail: string | null = null;
    if (conflict) {
      blockReason = 'idempotency_conflict';
      blockDetail = `tool call ${ctx.toolCallId} was already used with a different payload`;
    } else if (!ctx.capabilities.includes(capabilityFor(action))) {
      blockReason = 'capability_denied';
      blockDetail = `the author task does not hold ${capabilityFor(action)}`;
    } else if (outOfScope.length > 0) {
      blockReason = 'citation_out_of_scope';
      blockDetail = `citations outside the attempt's scope: ${outOfScope.join(', ')}`;
    }

    const id = randomUUID();
    const targetSourceKey = actionTargetSourceKey(action, payload);
    const target = {
      resource: 'checkout',
      sourceKey: targetSourceKey,
      environment: (
        await client.query<{ environment: string }>(
          'SELECT environment FROM coordinator.missions WHERE id = $1',
          [ctx.missionId],
        )
      ).rows[0].environment,
    };
    const status = blockReason ? 'blocked' : 'proposed';
    const inserted = await client.query<IntentRow>(
      `INSERT INTO coordinator.action_intents
         (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
          author_fencing_token, generation, action, adapter, payload, payload_hash,
          supporting_receipt_ids, target, actor_capability, dependency_vector,
          required_sources, expected_target_version, policy_version, idempotency_key,
          expires_at, rationale, status, block_reason, block_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::uuid[],$14::jsonb,$15,
               $16::jsonb,$17::text[],$18,$19,$20, now() + ($21 || ' milliseconds')::interval,
               $22,$23,$24,$25)
       RETURNING *`,
      [
        id,
        ctx.missionId,
        ctx.taskId,
        ctx.attemptId,
        ctx.modelCallId,
        ctx.toolCallId,
        ctx.fencingToken,
        ctx.generation,
        action,
        ADAPTER_POLICY[action].adapter,
        JSON.stringify(payload),
        payloadHash,
        cited,
        JSON.stringify(target),
        capabilityFor(action),
        JSON.stringify(vector),
        requiredSourcesFor(action, payload),
        expectedTargetVersion,
        POLICY_VERSION,
        idempotencyKey,
        String(INTENT_TTL_MS),
        input.rationale,
        status,
        blockReason,
        blockDetail,
      ],
    );
    const row = inserted.rows[0];
    const events: EventPayload[] = [];
    if (blockReason) {
      const authorization: AuthorizationInput = {
        actionId: id,
        stage: 'admission',
        decision: 'blocked',
        blockReason,
        checkedVector: [],
        targetVersion: {
          expected: expectedTargetVersion,
          live: await liveTargetVersion(client, targetSourceKey),
        },
        authorFence: { token: ctx.fencingToken, valid: true },
        dispatchFence: null,
        idempotencyBinding: conflict ? 'conflict' : 'new',
      };
      await insertAuthorization(client, authorization);
      events.push(decidedEvent(authorization, blockDetail));
    } else {
      const proposedAt = row.proposed_at.toISOString();
      const notBefore = new Date(
        row.proposed_at.getTime() + fenced.mission.admission_min_age_ms,
      );
      // The live intent joins the dependency graph (attempt -> intent, model
      // call -> intent): a supersession of anything the call read blocks it
      // immediately through the ledger closure, before any admission runs.
      await linkPublication(client, {
        missionId: ctx.missionId,
        taskId: ctx.taskId,
        attemptId: ctx.attemptId,
        modelCallIds: [ctx.modelCallId],
        actionId: id,
      });
      await enqueueOutbox(client, {
        missionId: ctx.missionId,
        topic: ACTION_PROPOSED_TOPIC,
        payload: { actionId: id, missionId: ctx.missionId, proposedAt },
        dedupeKey: `${ACTION_PROPOSED_TOPIC}:${id}`,
      });
      events.push({
        kind: 'action.proposed',
        actionId: id,
        taskId: ctx.taskId,
        attemptId: ctx.attemptId,
        action,
        target,
        payloadHash,
        expectedTargetVersion,
        dependencyVector: vector,
        requiredSources: requiredSourcesFor(action, payload),
        admissionNotBefore: notBefore.toISOString(),
      } as unknown as EventPayload);
    }
    await flushEvents(client, deps, ctx.missionId, events);
    return toIntent(row);
  });
}
