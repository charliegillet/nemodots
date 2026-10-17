import { AsyncLocalStorage } from 'node:async_hooks';
import {
  unionDependencyVectors,
  type DependencyEntry,
  type DependencyVector,
} from '../contracts/model-call.js';

// The provenance scope of one Dot turn (ARCHITECTURE.md section 2, finding I6).
//
// DotAgent runs the whole turn inside `runInTurnScope`, so server-side tool
// executors (connection-tools.ts createApproval) can read the dependency
// vector of what the model was shown without any change to the executor
// signatures. The scope object is mutable: the provenance middleware replaces
// the vector each time it builds a ContextSnapshot, and tools that read more
// evidence mid-turn add entries.

export interface TurnScope {
  readonly dotId: string;
  readonly threadId: string;
  readonly runId: string;
  /** Dependency vector of the context the model is currently looking at. */
  vector: DependencyVector;
  /**
   * Evidence the model saw that could not be tied to a receipt (the ledger had
   * none yet). While this is non-empty the vector is not a complete binding,
   * so an approval created now is stored without one (NULL).
   */
  unresolved: string[];
}

const storage = new AsyncLocalStorage<TurnScope>();

export function createTurnScope(
  identity: Pick<TurnScope, 'dotId' | 'threadId' | 'runId'>,
): TurnScope {
  return { ...identity, vector: [], unresolved: [] };
}

export function runInTurnScope<T>(scope: TurnScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentTurnScope(): TurnScope | undefined {
  return storage.getStore();
}

/**
 * The vector to bind to an approval created now. null outside a provenance
 * scope or while some evidence is unresolved: "no binding", which revalidation
 * treats per Dot kind (pass for ordinary Dots, refuse for incident Dots).
 */
export function currentDependencyVector(): DependencyVector | null {
  const scope = storage.getStore();
  if (!scope || scope.unresolved.length > 0) return null;
  return scope.vector;
}

/** Adds entries to the scope's vector (a union: entries are never removed). */
export function addToScopeVector(
  scope: TurnScope,
  entries: readonly DependencyEntry[],
): void {
  if (entries.length > 0)
    scope.vector = unionDependencyVectors(scope.vector, entries);
}
