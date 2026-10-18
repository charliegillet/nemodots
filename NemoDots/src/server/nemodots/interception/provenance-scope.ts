// The current Dot turn's provenance, carried through AsyncLocalStorage so
// executors that are not passed a context (connection-tools approval creation)
// can bind the turn's dependency vector (finding I6).
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  unionDependencyVectors,
  type DependencyEntry,
} from '../contracts/index.js';

export interface ProvenanceScope {
  dotId: string;
  threadId: string;
  incident: boolean;
  /** Mutable: grows as tool results register receipts during the turn. */
  dependencyVector: DependencyEntry[];
}

const storage = new AsyncLocalStorage<ProvenanceScope>();

export function runInProvenanceScope<T>(
  scope: ProvenanceScope,
  fn: () => T,
): T {
  return storage.run(scope, fn);
}
export function currentProvenanceScope(): ProvenanceScope | undefined {
  return storage.getStore();
}
/** null outside a scope (no producer), otherwise the turn's vector. */
export function currentDependencyVector(): DependencyEntry[] | null {
  return storage.getStore()?.dependencyVector ?? null;
}
export function addToScopeVector(
  scope: ProvenanceScope,
  entries: readonly DependencyEntry[],
): void {
  scope.dependencyVector = unionDependencyVectors(
    scope.dependencyVector,
    entries,
  );
}

// Evidence read in earlier turns of a conversation (TOOL_COVERAGE R4). The next
// turn replays the transcript, so what a replayed tool result was read from has
// to be recalled server-side: the history itself comes from the client and
// never supplies a receipt. Keyed by (thread, toolCallId); process-local and
// bounded, so a restart or an eviction loses attribution, never invents it.
const MAX_THREADS = 1000;
const MAX_CALLS_PER_THREAD = 2000;
const toolEvidence = new Map<string, Map<string, DependencyEntry[]>>();

export function rememberToolEvidence(
  threadId: string,
  toolCallId: string,
  entries: readonly DependencyEntry[],
): void {
  if (entries.length === 0) return;
  const calls = toolEvidence.get(threadId) ?? new Map();
  // Same id seen again in this thread: keep the union, never narrow.
  calls.set(
    toolCallId,
    unionDependencyVectors(calls.get(toolCallId) ?? [], entries),
  );
  if (calls.size > MAX_CALLS_PER_THREAD)
    calls.delete(calls.keys().next().value as string);
  // Re-insert so the most recently used thread is evicted last.
  toolEvidence.delete(threadId);
  toolEvidence.set(threadId, calls);
  if (toolEvidence.size > MAX_THREADS)
    toolEvidence.delete(toolEvidence.keys().next().value as string);
}

export function recallToolEvidence(
  threadId: string,
  toolCallId: string,
): readonly DependencyEntry[] {
  return toolEvidence.get(threadId)?.get(toolCallId) ?? [];
}

export function resetToolEvidence(): void {
  toolEvidence.clear();
}
