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
