// Adapter policy evaluation (policy-v1). Pure functions: no database, no clock.
// ADAPTER_POLICY itself lives in contracts/policy.ts and is re-exported here so
// every consumer of the action boundary reads one module.
//
// The server decides what a controlled action needs. The model supplies the
// payload and citations; required sources, value domains, capabilities, the
// target and the maximum evidence age all come from this table, so a proposal
// can never weaken them (TEST_PROMPT gate 2 item 6).
import {
  ACTION_ADAPTER,
  ADAPTER_POLICY,
  actionTargetSourceKey,
  digest,
  FlushCachePayloadSchema,
  idempotencyKey,
  POLICY_VERSION,
  SetConfigPayloadSchema,
  requiredSourcesFor,
  unionDependencyVectors,
  type ActionAdapter,
  type ActionKind,
  type AttemptId,
  type BlockReason,
  type Capability,
  type DependencyVector,
  type Environment,
  type FlushCachePayload,
  type MissionId,
  type SetConfigPayload,
  type TaskId,
} from '../contracts/index.js';
import { citationsOutOfScope } from '../context/provenance.js';

export { ADAPTER_POLICY, POLICY_VERSION, requiredSourcesFor };

export type ActionPayload = SetConfigPayload | FlushCachePayload;

export interface PolicyVerdict {
  reason: BlockReason;
  detail: string;
}

export const CONFIG_SOURCE_PREFIX = 'checkout.config/';
export const COLLECTION_SOURCE_KEY = 'checkout.config';

/** `checkout.config/<key>` -> `<key>`; null for anything else. */
export const configKeyOf = (sourceKey: string): string | null =>
  sourceKey.startsWith(CONFIG_SOURCE_PREFIX)
    ? sourceKey.slice(CONFIG_SOURCE_PREFIX.length)
    : null;

/** Parses the payload strictly for its action; null if it is not a valid payload of that action. */
export function parsePayload(
  action: string,
  payload: unknown,
): { action: ActionKind; payload: ActionPayload } | null {
  if (action === 'set_config') {
    const parsed = SetConfigPayloadSchema.safeParse(payload);
    return parsed.success ? { action, payload: parsed.data } : null;
  }
  if (action === 'flush_cache_namespace') {
    const parsed = FlushCachePayloadSchema.safeParse(payload);
    return parsed.success ? { action, payload: parsed.data } : null;
  }
  return null;
}

function policyEntry(action: ActionKind) {
  return action === 'set_config'
    ? ADAPTER_POLICY.set_config
    : ADAPTER_POLICY.flush_cache_namespace;
}

export function capabilityFor(action: ActionKind): Capability {
  return policyEntry(action).capability;
}

export function adapterFor(action: ActionKind): ActionAdapter {
  return ACTION_ADAPTER[action];
}

/** maxAgeMs per source key for the action (against lastConfirmedAt). */
export function freshnessFor(action: ActionKind): Record<string, number> {
  return { ...policyEntry(action).maxAgeMs };
}

export function isExternalEffect(action: ActionKind): boolean {
  return policyEntry(action).externalEffect;
}

/**
 * The target version the proposal is bound to: the highest revision of the
 * target source's receipt in the vector (for flush: `cache.namespace`, C11).
 * null when the vector has no receipt of the target at all.
 */
export function expectedTargetVersionFrom(
  action: ActionKind,
  payload: ActionPayload,
  vector: DependencyVector,
): number | null {
  const target = actionTargetSourceKey(action, payload);
  let best: number | null = null;
  for (const entry of vector)
    if (entry.sourceKey === target)
      best = best === null ? entry.sourceRevision : Math.max(best, entry.sourceRevision);
  return best;
}

/** Required sources absent from the vector (irrelevant receipts do not count). */
export function missingRequiredSources(
  action: ActionKind,
  payload: ActionPayload,
  vector: DependencyVector,
): string[] {
  const have = new Set<string>(vector.map((entry) => entry.sourceKey));
  return requiredSourcesFor(action, payload).filter((key) => !have.has(key));
}

export interface BindingInput {
  action: ActionKind;
  payload: ActionPayload;
  environment: Environment;
  expectedTargetVersion: number;
  dependencyVector: DependencyVector;
  policyVersion?: string;
}

/**
 * Digest binding the decision to everything that determines it: action,
 * payload, target (resource, source, environment), policy version, expected
 * target version and the dependency vector. A change to any of them after
 * admission yields a different hash, which both the idempotency check and the
 * admission/commit re-verification detect.
 */
export function payloadHashOf(input: BindingInput): string {
  return digest([
    'action-binding-v1',
    input.action,
    input.payload,
    {
      resource: 'checkout',
      sourceKey: actionTargetSourceKey(input.action, input.payload),
      environment: input.environment,
    },
    input.policyVersion ?? POLICY_VERSION,
    input.expectedTargetVersion,
    input.dependencyVector.map((entry) => [
      entry.sourceKey,
      entry.sourceRevision,
      entry.receiptId,
    ]),
  ]);
}

/** (rev2 C5) sha256(missionId, taskId, attemptId, action, expectedTargetVersion, toolCallId). */
export function idempotencyKeyOf(input: {
  missionId: MissionId;
  taskId: TaskId;
  attemptId: AttemptId;
  action: ActionKind;
  expectedTargetVersion: number;
  toolCallId: string;
}): string {
  return idempotencyKey(
    input.missionId,
    input.taskId,
    input.attemptId,
    input.action,
    input.expectedTargetVersion,
    input.toolCallId,
  );
}

export interface CitationScope {
  snapshot: { dependencyVector: DependencyVector };
  attempt: {
    readSetReceiptIds: readonly string[];
    inheritedDependencyVector: DependencyVector;
  };
}

/**
 * I8: cited receipt ids that are neither in the emitting call's snapshot
 * vector, nor in the attempt's readset, nor in its inherited vector. Receipt
 * ids are citations validated against scope, never authority.
 */
export function citationsOutsideScope(
  cited: readonly string[],
  scope: CitationScope,
): string[] {
  return citationsOutOfScope(
    cited,
    scope.snapshot,
    scope.attempt as Parameters<typeof citationsOutOfScope>[2],
  );
}

/** The intent's vector: the emitting snapshot's vector plus the cited entries, sorted. */
export function intentVector(
  snapshotVector: DependencyVector,
  cited: DependencyVector,
): DependencyVector {
  return unionDependencyVectors(snapshotVector, cited);
}

export interface StoredBinding {
  action: string;
  adapter: string;
  payload: unknown;
  payloadHash: string;
  targetSourceKey: string;
  targetEnvironment: Environment;
  actorCapability: string;
  dependencyVector: DependencyVector;
  requiredSources: readonly string[];
  expectedTargetVersion: number;
  policyVersion: string;
}

/**
 * Every policy predicate that needs no database: policy version, strict
 * payload shape, value domain, target/adapter/capability consistency, the
 * server-derived required sources, presence of every required source in the
 * vector, and the payload hash. Run at proposal, again at admission and again
 * at commit, so a row altered after the fact cannot be committed.
 */
export function checkBinding(binding: StoredBinding): PolicyVerdict | null {
  if (binding.policyVersion !== POLICY_VERSION)
    return {
      reason: 'policy_version_mismatch',
      detail: `intent was proposed under ${binding.policyVersion}, the server runs ${POLICY_VERSION}`,
    };
  const parsed = parsePayload(binding.action, binding.payload);
  if (!parsed)
    return {
      reason: 'payload_invalid',
      detail: `payload is not a valid ${binding.action} payload`,
    };
  const { action, payload } = parsed;
  const policy = policyEntry(action);
  if (!(policy.validatePayload as (p: ActionPayload) => boolean)(payload))
    return {
      reason: 'payload_invalid',
      detail: `payload violates the ${action} value domain`,
    };
  if (binding.adapter !== adapterFor(action))
    return {
      reason: 'payload_invalid',
      detail: `action ${action} uses adapter ${adapterFor(action)}`,
    };
  if (binding.targetSourceKey !== actionTargetSourceKey(action, payload))
    return {
      reason: 'payload_invalid',
      detail: 'target does not match the payload',
    };
  if (binding.actorCapability !== policy.capability)
    return {
      reason: 'capability_denied',
      detail: `${action} needs capability ${policy.capability}`,
    };
  const required = requiredSourcesFor(action, payload);
  if (
    required.length !== binding.requiredSources.length ||
    required.some((key, i) => key !== binding.requiredSources[i])
  )
    return {
      reason: 'payload_invalid',
      detail: 'requiredSources differ from the server-derived set',
    };
  const missing = missingRequiredSources(action, payload, binding.dependencyVector);
  if (missing.length > 0)
    return {
      reason: 'missing_required_source',
      detail: `no receipt for required source(s): ${missing.join(', ')}`,
    };
  const expected = payloadHashOf({
    action,
    payload,
    environment: binding.targetEnvironment,
    expectedTargetVersion: binding.expectedTargetVersion,
    dependencyVector: binding.dependencyVector,
    policyVersion: binding.policyVersion,
  });
  if (expected !== binding.payloadHash)
    return {
      reason: 'payload_invalid',
      detail: 'payload hash does not match the stored binding',
    };
  return null;
}
