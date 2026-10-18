// Pure rules of the action boundary: no I/O, so the unit tests cover them
// without a database. The server derives everything below; the model supplies
// only the action, its strict payload, citations and a rationale.
import {
  ADAPTER_POLICY,
  actionTargetSourceKey,
  digest,
  POLICY_VERSION,
  requiredSourcesFor,
  unionDependencyVectors,
  type ActionKind,
  type DependencyEntry,
  type DependencyVector,
  type FlushCachePayload,
  type SetConfigPayload,
} from '../contracts/index.js';

export type ActionPayload = SetConfigPayload | FlushCachePayload;

export const CACHE_NAMESPACE_KEY = 'checkout.config/cache.namespace';
export const COLLECTION_KEY = 'checkout.config';

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

/**
 * Hash of what the model asked for: action, strict payload and the receipts it
 * cited. A replay of the same tool call with anything different hashes
 * differently, which is what `idempotency_conflict` detects.
 */
export function payloadHashOf(
  action: ActionKind,
  payload: ActionPayload,
  supportingReceiptIds: readonly string[],
): string {
  return digest({
    action,
    payload,
    supportingReceiptIds: sortedUnique(supportingReceiptIds),
  });
}

/** CONTRACTS 5: sha256(missionId, taskId, attemptId, action, expectedTargetVersion, toolCallId). */
export function idempotencyKeyOf(input: {
  missionId: string;
  taskId: string;
  attemptId: string;
  action: ActionKind;
  expectedTargetVersion: number;
  toolCallId: string;
}): string {
  return digest([
    input.missionId,
    input.taskId,
    input.attemptId,
    input.action,
    input.expectedTargetVersion,
    input.toolCallId,
  ]);
}

/** Value domain / namespace pattern of the adapter policy. */
export function payloadInDomain(
  action: ActionKind,
  payload: ActionPayload,
): boolean {
  return action === 'set_config'
    ? ADAPTER_POLICY.set_config.validatePayload(payload as SetConfigPayload)
    : ADAPTER_POLICY.flush_cache_namespace.validatePayload(
        payload as FlushCachePayload,
      );
}

export function capabilityFor(action: ActionKind) {
  return ADAPTER_POLICY[action].capability;
}

export function maxAgeFor(action: ActionKind): Record<string, number> {
  return { ...ADAPTER_POLICY[action].maxAgeMs };
}

export function isExternalEffect(action: ActionKind): boolean {
  return ADAPTER_POLICY[action].externalEffect;
}

export interface CitationScope {
  /** receipts of the emitting model call's snapshot.dependencyVector */
  snapshotVector: readonly DependencyEntry[];
  /** the attempt's readSetReceiptIds */
  readSetReceiptIds: readonly string[];
  /** the attempt's inheritedDependencyVector */
  inheritedVector: readonly DependencyEntry[];
}

/**
 * I8: a cited receipt must be in the emitting snapshot's vector, the attempt's
 * read set or its inherited vector. Citations are scope-checked, never
 * authority (a foreign-mission or never-seen receipt id is `outOfScope`).
 */
export function citationInScope(
  cited: readonly string[],
  scope: CitationScope,
): { inScope: string[]; outOfScope: string[] } {
  const allowed = new Set<string>([
    ...scope.snapshotVector.map((entry) => entry.receiptId),
    ...scope.readSetReceiptIds,
    ...scope.inheritedVector.map((entry) => entry.receiptId),
  ]);
  const unique = sortedUnique(cited);
  return {
    inScope: unique.filter((id) => allowed.has(id)),
    outOfScope: unique.filter((id) => !allowed.has(id)),
  };
}

/** Required sources of the action that the vector does not cover (sorted). */
export function missingRequiredSources(
  action: ActionKind,
  payload: ActionPayload,
  vector: readonly DependencyEntry[],
): string[] {
  const present = new Set(vector.map((entry) => entry.sourceKey as string));
  return requiredSourcesFor(action, payload).filter(
    (source) => !present.has(source),
  );
}

/**
 * The version the proposal is made against: the vector's revision of the
 * target source (the member receipt; for a flush, cache.namespace, C11). 0
 * when the vector holds no receipt for the target; admission then blocks the
 * intent as `missing_required_source` before any version comparison.
 */
export function expectedTargetVersionOf(
  action: ActionKind,
  payload: ActionPayload,
  vector: readonly DependencyEntry[],
): number {
  const target = actionTargetSourceKey(action, payload);
  const revisions = vector
    .filter((entry) => entry.sourceKey === target)
    .map((entry) => entry.sourceRevision);
  return revisions.length === 0 ? 0 : Math.max(...revisions);
}

/** Emitting snapshot vector ∪ the in-scope cited entries, sorted (C10). */
export function intentVector(
  snapshotVector: readonly DependencyEntry[],
  citedEntries: readonly DependencyEntry[],
): DependencyVector {
  return unionDependencyVectors(snapshotVector, citedEntries);
}

/** Config member keys named by a vector's controlled sources (sorted). */
export function memberKeysOf(
  vector: readonly DependencyEntry[],
  target: string,
): { keys: string[]; collection: boolean } {
  const keys = new Set<string>();
  let collection = false;
  for (const entry of [...vector.map((e) => e.sourceKey as string), target]) {
    if (entry === COLLECTION_KEY) collection = true;
    else if (entry.startsWith(`${COLLECTION_KEY}/`))
      keys.add(entry.slice(COLLECTION_KEY.length + 1));
  }
  return { keys: [...keys].sort(), collection };
}

export { POLICY_VERSION };
