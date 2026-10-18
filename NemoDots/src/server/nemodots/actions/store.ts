// Storing a new intent (shared by propose and compensate): the row, then either
// the Authorization of a refusal, or the evidence edges, the outbox hint and
// the events of a live proposal. Runs on the caller's transaction.
import { randomUUID } from 'node:crypto';
import {
  actionTargetSourceKey,
  INTENT_TTL_MS,
  type ActionId,
  type AttemptId,
  type BlockReason,
  type DependencyVector,
  type Environment,
  type MissionId,
  type ModelCallId,
  type PgClient,
  type TaskId,
} from '../contracts/index.js';
import type { EventBuffer } from '../coordinator/events.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import {
  addEdges,
  linkPublication,
  lockReceiptsShared,
} from '../ledger/index.js';
import {
  adapterFor,
  capabilityFor,
  POLICY_VERSION,
  requiredSourcesFor,
  type ActionPayload,
} from './policy.js';
import {
  insertAuthorization,
  mapIntentRow,
  toIntent,
  type IntentDbRow,
  type IntentRow,
} from './rows.js';
import type { ActionKind } from '../contracts/index.js';
import { configKeyOf } from './policy.js';

export interface StoreParams {
  context: {
    missionId: MissionId;
    taskId: TaskId;
    attemptId: AttemptId;
    fencingToken: number;
  };
  toolCallId: string;
  modelCallId: ModelCallId;
  mission: {
    generation: number;
    environment: Environment;
    admissionMinAgeMs: number;
  };
  action: ActionKind;
  payload: ActionPayload;
  vector: DependencyVector;
  expectedTargetVersion: number;
  payloadHash: string;
  idempotencyKey: string;
  rationale: string;
  /** A refusal decided at proposal; null stores a live `proposed` intent. */
  block: { reason: BlockReason; detail: string } | null;
  binding: 'new' | 'conflict';
  compensatesActionId?: ActionId | null;
}

export async function storeIntent(
  client: PgClient,
  buffer: EventBuffer,
  params: StoreParams,
): Promise<IntentRow> {
  const { context, block } = params;
  const targetSourceKey = actionTargetSourceKey(params.action, params.payload);
  const status = block ? 'blocked' : 'proposed';
  const inserted = await client.query<IntentDbRow>(
    `INSERT INTO coordinator.action_intents
       (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
        author_fencing_token, generation, action, adapter, payload, payload_hash,
        target_resource, target_source_key, target_environment, actor_capability,
        dependency_vector, required_sources, expected_target_version, policy_version,
        idempotency_key, expires_at, rationale, status, block_reason, block_detail,
        compensates_action_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
             'checkout', $13, $14, $15, $16::jsonb, $17, $18, $19, $20,
             clock_timestamp() + $21 * interval '1 millisecond', $22, $23, $24, $25, $26)
     RETURNING *`,
    [
      randomUUID(),
      context.missionId,
      context.taskId,
      context.attemptId,
      params.modelCallId,
      params.toolCallId,
      context.fencingToken,
      params.mission.generation,
      params.action,
      adapterFor(params.action),
      JSON.stringify(params.payload),
      params.payloadHash,
      targetSourceKey,
      params.mission.environment,
      capabilityFor(params.action),
      JSON.stringify(params.vector),
      requiredSourcesFor(params.action, params.payload),
      params.expectedTargetVersion,
      POLICY_VERSION,
      params.idempotencyKey,
      INTENT_TTL_MS,
      params.rationale,
      status,
      block?.reason ?? null,
      block?.detail ?? null,
      params.compensatesActionId ?? null,
    ],
  );
  const stored = mapIntentRow(inserted.rows[0]);
  const dto = toIntent(stored);
  buffer.add(context.missionId, {
    kind: 'action.proposed',
    actionId: stored.id,
    taskId: stored.taskId,
    attemptId: stored.attemptId,
    action: params.action,
    target: dto.target,
    payloadHash: params.payloadHash,
    expectedTargetVersion: params.expectedTargetVersion,
    dependencyVector: params.vector,
    requiredSources: dto.requiredSources,
    admissionNotBefore: new Date(
      stored.proposedAt.getTime() + params.mission.admissionMinAgeMs,
    ).toISOString(),
  });

  if (block) {
    const key = configKeyOf(targetSourceKey)!;
    const live = await client.query<{ version: string }>(
      'SELECT version FROM checkout.config_entries WHERE key = $1',
      [key],
    );
    const authorization = await insertAuthorization(client, {
      actionId: stored.id,
      stage: 'admission',
      decision: 'blocked',
      blockReason: block.reason,
      blockDetail: block.detail,
      checkedVector: [],
      targetVersion: {
        expected: params.expectedTargetVersion,
        live: live.rows[0] ? Number(live.rows[0].version) : 0,
      },
      authorFence: { token: context.fencingToken, valid: true },
      dispatchFence: null,
      idempotencyBinding: params.binding,
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
    return stored;
  }

  // Evidence edges: the closure of a superseded receipt reaches the intent.
  // The receipt rows are share-locked first (finding C13): a supersession
  // either waits for this transaction and then sees the edges, or ran first
  // and admission refuses the superseded receipt.
  await lockReceiptsShared(
    client,
    params.vector.map((entry) => entry.receiptId),
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
    modelCallIds: [params.modelCallId],
    actionId: stored.id,
  });
  await addEdges(
    client,
    params.vector.map((entry) => ({
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
  return stored;
}
