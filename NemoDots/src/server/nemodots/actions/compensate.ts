// Compensation (ARCHITECTURE 4 "Limits"): optional, only for set_config, and
// itself an intent that must pass G1 against the CURRENT version. It refuses
// when the target moved since the commit (a later valid change must not be
// undone) and never claims to undo an irreversible effect (the Redis flush).
import { randomUUID } from 'node:crypto';
import {
  digest,
  INTENT_TTL_MS,
  POLICY_VERSION,
  requiredSourcesFor,
  SetConfigPayloadSchema,
  type ActionId,
  type ActionIntent,
  type DependencyEntry,
  type SetConfigPayload,
} from '../contracts/index.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import { withTransaction } from '../db/tx.js';
import type { ActionsDeps } from './deps.js';
import { decidedEvent, flushEvents } from './emit.js';
import { CompensationRefusedError } from './errors.js';
import {
  expectedTargetVersionOf,
  intentVector,
  payloadHashOf,
  payloadInDomain,
} from './policy.js';
import { ACTION_PROPOSED_TOPIC } from './propose.js';
import { lockMissionThenIntent } from './predicates.js';
import {
  findResultReceipt,
  insertAuthorization,
  toIntent,
  type AuthorizationInput,
  type IntentRow,
} from './rows.js';

export async function compensate(
  deps: ActionsDeps,
  actionId: ActionId | string,
): Promise<ActionIntent> {
  return withTransaction(deps.pool, async (client) => {
    const { intent: original, mission } = await lockMissionThenIntent(
      client,
      actionId,
    );
    if (original.action !== 'set_config')
      throw new CompensationRefusedError(
        original.id,
        'irreversible',
        'only set_config is reversible',
      );
    if (original.status !== 'committed' && original.status !== 'verified')
      throw new CompensationRefusedError(
        original.id,
        'not_committed',
        `intent is ${original.status}`,
      );
    const receipt = await findResultReceipt(client, original.id);
    const plane = receipt?.controlPlane;
    if (!plane)
      throw new CompensationRefusedError(original.id, 'not_committed');
    const originalPayload = original.payload as unknown as SetConfigPayload;
    const key = originalPayload.key;

    const idempotencyKey = digest(['compensate', original.id]);
    const existing = await client.query<IntentRow>(
      `SELECT * FROM coordinator.action_intents
        WHERE idempotency_key = $1
          AND status IN ('proposed', 'admitted', 'committed', 'dispatched', 'outcome_unknown')
        ORDER BY proposed_at DESC LIMIT 1`,
      [idempotencyKey],
    );
    if (existing.rows[0]) return toIntent(existing.rows[0]);

    const live = await client.query<{ version: number }>(
      'SELECT version FROM checkout.config_entries WHERE key = $1 FOR SHARE',
      [key],
    );
    const liveVersion = live.rows[0] ? Number(live.rows[0].version) : 0;
    const before = await client.query<{ value: unknown }>(
      'SELECT value FROM checkout.config_versions WHERE key = $1 AND version = $2',
      [key, plane.targetVersionBefore],
    );
    if (before.rows.length === 0 || before.rows[0].value === null)
      throw new CompensationRefusedError(original.id, 'no_before_value');
    const payload = SetConfigPayloadSchema.parse({
      key,
      value: before.rows[0].value,
      expectedCurrentValueDigest: plane.afterDigest,
    });
    if (!payloadInDomain('set_config', payload))
      throw new CompensationRefusedError(original.id, 'no_before_value');

    // Current evidence: the head receipts of the required sources.
    const required = requiredSourcesFor('set_config', payload);
    const heads = await client.query<{
      key: string;
      id: string;
      source_revision: number;
    }>(
      `SELECT DISTINCT ON (s.key) s.key, r.id, r.source_revision
         FROM ledger.observation_receipts r
         JOIN ledger.sources s ON s.id = r.source_id
         JOIN coordinator.missions m
           ON m.owner_id = s.owner_id AND m.environment = s.environment
          AND m.resource = s.resource
        WHERE m.id = $1 AND s.key = ANY($2::text[]) AND r.status = 'supported'
        ORDER BY s.key, r.source_revision DESC`,
      [original.mission_id, required],
    );
    const entries: DependencyEntry[] = heads.rows.map((row) => ({
      sourceKey: row.key,
      sourceRevision: Number(row.source_revision),
      receiptId: row.id,
    })) as DependencyEntry[];
    const vector = intentVector([], entries);
    const expected = expectedTargetVersionOf('set_config', payload, vector);
    // The refusal is an inspectable state, not an error: a compensation that
    // would overwrite a newer valid change is recorded blocked.
    let blockReason: 'stale_version' | 'stale_pending_observation' | null =
      null;
    let blockDetail: string | null = null;
    if (liveVersion !== plane.targetVersionAfter) {
      blockReason = 'stale_version';
      blockDetail = `${key} is at version ${liveVersion}, the commit produced ${plane.targetVersionAfter}`;
    } else if (expected !== liveVersion) {
      blockReason = 'stale_pending_observation';
      blockDetail = 'the ledger has not observed the committed state yet';
    }

    const id = randomUUID();
    const inserted = await client.query<IntentRow>(
      `INSERT INTO coordinator.action_intents
         (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
          author_fencing_token, generation, action, adapter, payload, payload_hash,
          supporting_receipt_ids, target, actor_capability, dependency_vector,
          required_sources, expected_target_version, policy_version, idempotency_key,
          expires_at, rationale, status, block_reason, block_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'set_config','checkout_config',$9::jsonb,$10,'{}',
               $11::jsonb,'propose_config_change',$12::jsonb,$13::text[],$14,$15,$16,
               now() + ($17 || ' milliseconds')::interval,$18,$19,$20,$21)
       RETURNING *`,
      [
        id,
        original.mission_id,
        original.task_id,
        original.attempt_id,
        original.model_call_id,
        `compensate:${original.id}`,
        original.author_fencing_token,
        mission.generation,
        JSON.stringify(payload),
        payloadHashOf('set_config', payload, []),
        JSON.stringify(original.target),
        JSON.stringify(vector),
        required,
        blockReason ? (plane.targetVersionAfter as number) : expected,
        POLICY_VERSION,
        idempotencyKey,
        String(INTENT_TTL_MS),
        `compensation of ${original.id}`,
        blockReason ? 'blocked' : 'proposed',
        blockReason,
        blockDetail,
      ],
    );
    const row = inserted.rows[0];
    if (blockReason) {
      const authorization: AuthorizationInput = {
        actionId: id,
        stage: 'admission',
        decision: 'blocked',
        blockReason,
        checkedVector: [],
        targetVersion: {
          expected: plane.targetVersionAfter as number,
          live: liveVersion,
        },
        authorFence: { token: original.author_fencing_token, valid: true },
        dispatchFence: null,
        idempotencyBinding: 'new',
      };
      await insertAuthorization(client, authorization);
      await flushEvents(client, deps, original.mission_id, [
        decidedEvent(authorization, blockDetail),
      ]);
      return toIntent(row);
    }
    await enqueueOutbox(client, {
      missionId: original.mission_id,
      topic: ACTION_PROPOSED_TOPIC,
      payload: {
        actionId: id,
        missionId: original.mission_id,
        proposedAt: row.proposed_at.toISOString(),
      },
      dedupeKey: `${ACTION_PROPOSED_TOPIC}:${id}`,
    });
    await flushEvents(client, deps, original.mission_id, []);
    return toIntent(row);
  });
}
