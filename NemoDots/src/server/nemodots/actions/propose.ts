// ActionAdmissionPort.propose (ARCHITECTURE.md section 11, findings C5, C10,
// I8). One transaction:
//
//   1. the author's fence, generation and lease are validated under the
//      mission FOR SHARE and the attempt/task FOR UPDATE (coordinator/fence.ts,
//      the same prefix as every publication). A lost fence throws FenceError
//      and writes nothing;
//   2. the emitting model call's snapshot vector is read from the ledger and
//      every cited receipt must be in scope (snapshot vector, readset or
//      inherited vector) or the intent is stored `blocked(citation_out_of_scope)`;
//   3. the intent's dependency vector is the snapshot vector UNION the in-scope
//      citations; required sources, value domain and capability come from the
//      server's policy, never from the model;
//   4. the idempotency key is derived from the emitting tool call and bound to
//      the payload hash: the same key with the same hash returns the stored
//      intent, the same key with a different hash stores
//      `blocked(idempotency_conflict)`;
//   5. a proposed intent gets evidence edges (receipt -> intent, model call ->
//      intent, attempt -> intent), an `action.proposed` outbox message (admission
//      is scheduled by the coordinator) and an `action.proposed` event; the
//      INSERT trigger notifies nemodots_action_proposed (target key only).
//
// A malformed proposal (unknown ActionKind, extra fields) is not an intent:
// InvalidProposalError, nothing written. A well-typed proposal the policy
// refuses is stored as a blocked intent with an Authorization, so the model
// sees the reason and the decision is auditable.
import { randomUUID } from 'node:crypto';
import {
  actionTargetSourceKey,
  AttemptContextSchema,
  DependencyVectorSchema,
  INTENT_TTL_MS,
  ModelCallIdSchema,
  ProposeInputSchema,
  type ActionIntent,
  type AttemptContext,
  type BlockReason,
  type DependencyEntry,
  type DependencyVector,
  type Environment,
  type ModelCallId,
  type PgClient,
  type ProposeInput,
  type ReceiptId,
} from '../contracts/index.js';
import { EventBuffer, createEventSink } from '../coordinator/events.js';
import { lockFencedAttempt } from '../coordinator/fence.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import {
  addEdges,
  getReceiptRows,
  linkPublication,
  lockReceiptsShared,
} from '../ledger/index.js';
import { withTransaction } from '../db/tx.js';
import { InvalidProposalError } from './errors.js';
import {
  adapterFor,
  capabilityFor,
  checkBinding,
  citationsOutsideScope,
  expectedTargetVersionFrom,
  idempotencyKeyOf,
  intentVector,
  parsePayload,
  payloadHashOf,
  POLICY_VERSION,
  requiredSourcesFor,
  type ActionPayload,
} from './policy.js';
import {
  claimAuthorizationWriter,
  insertAuthorization,
  loadIntentsByKey,
  mapIntentRow,
  toIntent,
  type IntentDbRow,
} from './rows.js';
import type { ActionDeps } from './types.js';

export type ProposeContext = AttemptContext & {
  modelCallId: ModelCallId;
  toolCallId: string;
};

interface EmittingCall {
  missionId: string;
  taskId: string;
  attemptId: string;
  dependencyVector: DependencyVector;
}

async function loadEmittingCall(
  client: PgClient,
  modelCallId: string,
): Promise<EmittingCall | null> {
  const { rows } = await client.query<{
    mission_id: string;
    task_id: string;
    attempt_id: string;
    dependency_vector: unknown;
  }>(
    `SELECT m.mission_id, m.task_id, m.attempt_id, s.dependency_vector
       FROM ledger.model_call_records m
       JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
      WHERE m.id = $1`,
    [modelCallId],
  );
  if (!rows[0]) return null;
  return {
    missionId: rows[0].mission_id,
    taskId: rows[0].task_id,
    attemptId: rows[0].attempt_id,
    dependencyVector: DependencyVectorSchema.parse(rows[0].dependency_vector),
  };
}

function parseProposal(input: unknown): ProposeInput {
  const parsed = ProposeInputSchema.safeParse(input);
  if (!parsed.success)
    throw new InvalidProposalError(
      'the proposal is not a valid propose_action input',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  return parsed.data;
}

function parseContext(ctx: ProposeContext) {
  const base = AttemptContextSchema.safeParse({
    missionId: ctx.missionId,
    taskId: ctx.taskId,
    attemptId: ctx.attemptId,
    fencingToken: ctx.fencingToken,
    generation: ctx.generation,
    capabilities: ctx.capabilities,
    role: ctx.role,
  });
  if (!base.success)
    throw new InvalidProposalError('the attempt context is malformed');
  if (!ModelCallIdSchema.safeParse(ctx.modelCallId).success)
    throw new InvalidProposalError('modelCallId is not a model call id');
  if (
    typeof ctx.toolCallId !== 'string' ||
    ctx.toolCallId.length < 1 ||
    ctx.toolCallId.length > 256
  )
    throw new InvalidProposalError('toolCallId is required');
  return base.data;
}

export async function proposeIntent(
  deps: ActionDeps,
  input: ProposeInput,
  ctx: ProposeContext,
): Promise<ActionIntent> {
  const proposal = parseProposal(input);
  const context = parseContext(ctx);
  // Strict payload shape already holds (ProposeInputSchema is .strict()).
  const parsedPayload = parsePayload(proposal.action, proposal.payload);
  if (!parsedPayload)
    throw new InvalidProposalError('payload does not match the action');
  const { action, payload } = parsedPayload;
  const events = deps.events ?? createEventSink();

  const row = await withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    // Serialise replays of one tool call (the unique index is the backstop).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `nemodots_action_propose:${context.attemptId}:${ctx.toolCallId}`,
    ]);
    // 1. author fence, mission share lock, attempt and task FOR UPDATE.
    const { mission, task, attempt } = await lockFencedAttempt(
      client as never,
      context,
      { missionLock: 'share' },
    );

    // 2-3. the emitting call, citations, vector.
    const call = await loadEmittingCall(client, ctx.modelCallId);
    if (
      !call ||
      call.missionId !== context.missionId ||
      call.taskId !== context.taskId ||
      call.attemptId !== context.attemptId
    )
      throw new InvalidProposalError(
        'the emitting model call is unknown or belongs to another attempt',
      );
    const cited = [...new Set(proposal.supportingReceiptIds)] as ReceiptId[];
    const outside = new Set(
      citationsOutsideScope(cited, {
        snapshot: { dependencyVector: call.dependencyVector },
        attempt: {
          readSetReceiptIds: attempt.read_set_receipt_ids,
          inheritedDependencyVector: attempt.inherited_dependency_vector,
        },
      }),
    );
    const receiptRows = await getReceiptRows(
      client,
      cited.filter((id) => !outside.has(id)),
    );
    for (const id of cited)
      if (!outside.has(id) && !receiptRows.has(id)) outside.add(id);
    const citedEntries: DependencyEntry[] = cited
      .filter((id) => !outside.has(id))
      .map((id) => {
        const receipt = receiptRows.get(id)!;
        return {
          sourceKey: receipt.sourceKey,
          sourceRevision: receipt.sourceRevision,
          receiptId: receipt.id,
        };
      });
    const vector = intentVector(call.dependencyVector, citedEntries);
    const environment = mission.environment as Environment;
    const targetSourceKey = actionTargetSourceKey(action, payload);
    const expected = expectedTargetVersionFrom(action, payload, vector);
    const expectedTargetVersion = expected ?? 0;
    const capability = capabilityFor(action);

    // 4. idempotency.
    const payloadHash = payloadHashOf({
      action,
      payload,
      environment,
      expectedTargetVersion,
      dependencyVector: vector,
    });
    const key = idempotencyKeyOf({
      missionId: context.missionId,
      taskId: context.taskId,
      attemptId: context.attemptId,
      action,
      expectedTargetVersion,
      toolCallId: ctx.toolCallId,
    });
    const known = await loadIntentsByKey(client, key);
    const same = known.find((stored) => stored.payloadHash === payloadHash);
    if (same) return { stored: same, created: false as const };

    // Static policy: the server decides, the model's claims do not count.
    let block: { reason: BlockReason; detail: string } | null = null;
    let binding = 'new' as 'new' | 'conflict';
    if (known.length > 0) {
      block = {
        reason: 'idempotency_conflict',
        detail: 'the tool call id was already used with a different payload',
      };
      binding = 'conflict';
    } else if (!task.capabilities.includes(capability)) {
      block = {
        reason: 'capability_denied',
        detail: `the task does not hold capability ${capability}`,
      };
    } else if (outside.size > 0) {
      block = {
        reason: 'citation_out_of_scope',
        detail: `cited receipt(s) outside the attempt's scope: ${[...outside].join(', ')}`,
      };
    } else {
      block = checkBinding({
        action,
        adapter: adapterFor(action),
        payload,
        payloadHash,
        targetSourceKey,
        targetEnvironment: environment,
        actorCapability: capability,
        dependencyVector: vector,
        requiredSources: requiredSourcesFor(action, payload),
        expectedTargetVersion,
        policyVersion: POLICY_VERSION,
      });
    }

    // 5. the intent row.
    const id = randomUUID();
    const status = block ? 'blocked' : 'proposed';
    const inserted = await client.query<IntentDbRow>(
      `INSERT INTO coordinator.action_intents
         (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
          author_fencing_token, generation, action, adapter, payload, payload_hash,
          target_resource, target_source_key, target_environment, actor_capability,
          dependency_vector, required_sources, expected_target_version, policy_version,
          idempotency_key, expires_at, rationale, status, block_reason, block_detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
               'checkout', $13, $14, $15, $16::jsonb, $17, $18, $19, $20,
               clock_timestamp() + $21 * interval '1 millisecond', $22, $23, $24, $25)
       RETURNING *`,
      [
        id,
        context.missionId,
        context.taskId,
        context.attemptId,
        ctx.modelCallId,
        ctx.toolCallId,
        context.fencingToken,
        mission.generation,
        action,
        adapterFor(action),
        JSON.stringify(payload),
        payloadHash,
        targetSourceKey,
        environment,
        capability,
        JSON.stringify(vector),
        requiredSourcesFor(action, payload),
        expectedTargetVersion,
        POLICY_VERSION,
        key,
        INTENT_TTL_MS,
        proposal.rationale,
        status,
        block?.reason ?? null,
        block?.detail ?? null,
      ],
    );
    const stored = mapIntentRow(inserted.rows[0]);
    const proposedEvent = {
      kind: 'action.proposed' as const,
      actionId: stored.id,
      taskId: stored.taskId,
      attemptId: stored.attemptId,
      action,
      target: {
        resource: 'checkout' as const,
        sourceKey: toIntent(stored).target.sourceKey,
        environment,
      },
      payloadHash,
      expectedTargetVersion,
      dependencyVector: vector,
      requiredSources: toIntent(stored).requiredSources,
      admissionNotBefore: new Date(
        stored.proposedAt.getTime() + mission.admission_min_age_ms,
      ).toISOString(),
    };
    buffer.add(context.missionId, proposedEvent);

    if (block) {
      const live = await client.query<{ version: string }>(
        'SELECT version FROM checkout.config_entries WHERE key = $1',
        [targetSourceKey.slice('checkout.config/'.length)],
      );
      const authorization = await insertAuthorization(client, {
        actionId: stored.id,
        stage: 'admission',
        decision: 'blocked',
        blockReason: block.reason,
        blockDetail: block.detail,
        checkedVector: [],
        targetVersion: {
          expected: expectedTargetVersion,
          live: live.rows[0] ? Number(live.rows[0].version) : 0,
        },
        authorFence: { token: context.fencingToken, valid: true },
        dispatchFence: null,
        idempotencyBinding: binding,
      });
      buffer.add(context.missionId, {
        kind: 'action.decided',
        actionId: stored.id,
        stage: authorization.stage,
        decision: authorization.decision,
        blockReason: block.reason,
        blockDetail: block.detail,
        checkedVector: authorization.checkedVector,
        targetVersion: authorization.targetVersion,
        dispatchFence: null,
      });
    } else {
      // Evidence edges: the closure of a superseded receipt reaches the intent.
      // The receipt rows are share-locked first (finding C13): a supersession
      // either waits for this transaction and then sees the edges, or ran
      // first and admission refuses the superseded receipt.
      await lockReceiptsShared(
        client,
        vector.map((entry) => entry.receiptId),
      );
      const node = {
        kind: 'action_intent' as const,
        id: stored.id,
        missionId: context.missionId,
        taskId: context.taskId,
      };
      await linkPublication(client, {
        missionId: context.missionId,
        taskId: context.taskId,
        attemptId: context.attemptId,
        modelCallIds: [ctx.modelCallId],
        actionId: stored.id,
      });
      await addEdges(
        client,
        vector.map((entry) => ({
          kind: 'evidence' as const,
          from: { kind: 'receipt' as const, id: entry.receiptId },
          to: node,
        })),
      );
      await enqueueOutbox(client, {
        missionId: context.missionId,
        topic: 'action.proposed',
        payload: {
          actionId: stored.id,
          missionId: context.missionId,
          proposedAt: stored.proposedAt.toISOString(),
        },
        dedupeKey: `action.proposed:${stored.id}`,
      });
    }
    await buffer.flush(client);
    return { stored, created: true as const };
  });

  return toIntent(row.stored);
}
