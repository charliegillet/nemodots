// Compensation of a set_config (ARCHITECTURE.md section 4, "Limits").
//
// A reversal is a NEW intent: it goes through the same admission and commit
// transactions and must pass G1 against the CURRENT versions. Nothing here
// writes the configuration.
//
//   refused  flush_cache_namespace (irreversible: deleted cache entries are not
//            restored, so it is never shown as undone), an action that is not
//            committed or verified, an action already compensated, and any case
//            where the target version moved after the action committed (a later
//            valid change must not be overwritten by a reversal built on stale
//            premises).
//   built    payload {key, value: <value before the action>, expectedCurrentValueDigest:
//            digest of the live value}; expected target version = the live
//            version; supporting receipts = the caller's CURRENT receipts (the
//            target member at the live version and the health source), because
//            the receipts the original rested on are superseded by the action's
//            own commit.
//
// A compensation is initiated by the system (an operator or the coordinator),
// not by a model: it reuses the original intent's attempt, task and emitting
// model call as lineage and has no model tool call; its tool call id is
// `compensate:<original action id>`. Callers must be trusted server code.
import {
  type ActionId,
  type ActionIntent,
  type ReceiptId,
  type SetConfigPayload,
  unionDependencyVectors,
  digest,
  type DependencyEntry,
} from '../contracts/index.js';
import { EventBuffer, createEventSink } from '../coordinator/events.js';
import { withTransaction } from '../db/tx.js';
import { getReceiptRows } from '../ledger/index.js';
import {
  configValueDigest,
  lockConfigRows,
  type ConfigScalar,
} from '../sandbox/version-authority.js';
import { lockMissionShared } from './decision.js';
import { ActionNotFoundError, CompensationRefusedError } from './errors.js';
import {
  checkBinding,
  expectedTargetVersionFrom,
  parsePayload,
  payloadHashOf,
  POLICY_VERSION,
  requiredSourcesFor,
  adapterFor,
  capabilityFor,
} from './policy.js';
import {
  claimAuthorizationWriter,
  getResultReceipt,
  loadIntent,
  toIntent,
} from './rows.js';
import { storeIntent } from './store.js';
import type { ActionDeps } from './types.js';

export interface CompensationInput {
  /** Current receipts supporting the reversal (target member at the live version, health). */
  supportingReceiptIds: ReceiptId[];
  rationale?: string;
}

export async function compensateIntent(
  deps: ActionDeps,
  actionId: ActionId | string,
  input: CompensationInput,
): Promise<ActionIntent> {
  const events = deps.events ?? createEventSink();
  return withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    const original = await loadIntent(client, actionId, { lock: true });
    if (!original) throw new ActionNotFoundError(actionId);
    if (original.action !== 'set_config')
      throw new CompensationRefusedError(
        original.id,
        'not_reversible',
        'a cache flush is irreversible and is never shown as undone',
      );
    if (original.status !== 'committed' && original.status !== 'verified')
      throw new CompensationRefusedError(
        original.id,
        'not_committed',
        `status is ${original.status}; only a committed or verified set_config can be reversed`,
      );
    const committed = await getResultReceipt(client, original.id, 'committed');
    const plane = committed?.controlPlane;
    if (!plane)
      throw new CompensationRefusedError(
        original.id,
        'not_committed',
        'no committed control-plane receipt',
      );
    const existing = await client.query(
      `SELECT 1 FROM coordinator.action_intents
        WHERE compensates_action_id = $1
          AND status IN ('proposed', 'admitted', 'committed', 'dispatched', 'outcome_unknown', 'verified')`,
      [original.id],
    );
    if (existing.rows.length > 0)
      throw new CompensationRefusedError(
        original.id,
        'already_compensated',
        'a reversal of this action is already in flight or done',
      );
    const mission = await lockMissionShared(client, original.missionId);
    if (!mission || mission.status !== 'running')
      throw new CompensationRefusedError(
        original.id,
        'not_committed',
        `mission is ${mission?.status ?? 'missing'}`,
      );

    const payload = parsePayload(original.action, original.payload)!
      .payload as SetConfigPayload;
    const key = payload.key;
    const locked = await lockConfigRows(client, { keys: [key], mode: 'share' });
    const live = locked.versions.get(key);
    if (live !== plane.targetVersionAfter)
      throw new CompensationRefusedError(
        original.id,
        'version_moved',
        `${key} is at version ${live ?? 'missing'}, the action produced version ${plane.targetVersionAfter}; a later change is not overwritten`,
      );
    const before = await client.query<{ value: unknown }>(
      `SELECT value FROM checkout.config_versions WHERE key = $1 AND version = $2`,
      [key, plane.targetVersionBefore],
    );
    if (!before.rows[0] || before.rows[0].value === null)
      throw new CompensationRefusedError(
        original.id,
        'no_prior_value',
        'the history has no value for the version before the action',
      );
    const current = await client.query<{ value: unknown }>(
      'SELECT value FROM checkout.config_entries WHERE key = $1',
      [key],
    );

    const receipts = await getReceiptRows(client, input.supportingReceiptIds);
    if (receipts.size !== new Set(input.supportingReceiptIds).size)
      throw new CompensationRefusedError(
        original.id,
        'evidence_missing',
        'a supporting receipt does not exist',
      );
    const entries: DependencyEntry[] = [...receipts.values()].map((row) => ({
      sourceKey: row.sourceKey,
      sourceRevision: row.sourceRevision,
      receiptId: row.id,
    }));
    const vector = unionDependencyVectors(entries);
    const reversal: SetConfigPayload = {
      key,
      value: before.rows[0].value as ConfigScalar,
      expectedCurrentValueDigest: configValueDigest(
        current.rows[0].value as ConfigScalar,
      ),
    };
    const expected = expectedTargetVersionFrom('set_config', reversal, vector);
    if (expected !== live)
      throw new CompensationRefusedError(
        original.id,
        'evidence_missing',
        `no supporting receipt of ${original.targetSourceKey} at the live version ${live}`,
      );
    const payloadHash = payloadHashOf({
      action: 'set_config',
      payload: reversal,
      environment: original.targetEnvironment,
      expectedTargetVersion: expected,
      dependencyVector: vector,
    });
    const refusal = checkBinding({
      action: 'set_config',
      adapter: adapterFor('set_config'),
      payload: reversal,
      payloadHash,
      targetSourceKey: original.targetSourceKey,
      targetEnvironment: original.targetEnvironment,
      actorCapability: capabilityFor('set_config'),
      dependencyVector: vector,
      requiredSources: requiredSourcesFor('set_config', reversal),
      expectedTargetVersion: expected,
      policyVersion: POLICY_VERSION,
    });
    const idempotency = digest(['compensation-v1', original.id]);
    const stored = await storeIntent(client, buffer, {
      context: {
        missionId: original.missionId,
        taskId: original.taskId,
        attemptId: original.attemptId,
        fencingToken: original.authorFencingToken,
      },
      toolCallId: `compensate:${original.id}`,
      modelCallId: original.modelCallId,
      mission: {
        generation: mission.generation,
        environment: original.targetEnvironment,
        admissionMinAgeMs: 0,
      },
      action: 'set_config',
      payload: reversal,
      vector,
      expectedTargetVersion: expected,
      payloadHash,
      idempotencyKey: idempotency,
      rationale: (
        input.rationale ?? `reversal of action ${original.id} on ${key}`
      ).slice(0, 1000),
      block: refusal,
      binding: 'new',
      compensatesActionId: original.id,
    });
    await buffer.flush(client);
    return toIntent(stored);
  });
}
