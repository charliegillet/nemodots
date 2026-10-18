import {
  compareDependencyEntries,
  unionDependencyVectors,
  type ContextSnapshot,
  type DependencyEntry,
  type DependencyVector,
  type TaskAttempt,
} from '../contracts/index.js';
import { isMutated } from '../config/mutation.js';

// Provenance helpers (BUILD_PROMPT: a specialist can add but not remove
// dependencies; findings C10/I8). Pure functions over contract types.

export class DependencyRemovedError extends Error {
  constructor(readonly missing: readonly DependencyEntry[]) {
    super(
      `output vector drops ${missing.length} input dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.map((e) => e.receiptId).join(', ')}`,
    );
    this.name = 'DependencyRemovedError';
  }
}

export class CitationOutOfScopeError extends Error {
  constructor(readonly receiptIds: readonly string[]) {
    super(`citation out of scope: ${receiptIds.join(', ')}`);
    this.name = 'CitationOutOfScopeError';
  }
}

/**
 * The vector a derived output must carry: its own declared entries (e.g.
 * citations) plus the union of every input vector. Entries can be added, never
 * removed.
 */
export function inheritDependencies(
  output: { dependencyVector?: readonly DependencyEntry[] },
  inputs: readonly (readonly DependencyEntry[])[],
): DependencyVector {
  // MUTATION drop_inherited_edges: inherited dependencies are dropped.
  if (isMutated('drop_inherited_edges'))
    return unionDependencyVectors(output.dependencyVector ?? []);
  return unionDependencyVectors(output.dependencyVector ?? [], ...inputs);
}

/** Throws DependencyRemovedError when `outputVector` lacks any input entry. */
export function assertCarriesInputs(
  outputVector: readonly DependencyEntry[],
  inputs: readonly (readonly DependencyEntry[])[],
): void {
  const carried = new Set(outputVector.map((entry) => entry.receiptId));
  const missing = unionDependencyVectors(...inputs).filter(
    (entry) => !carried.has(entry.receiptId),
  );
  if (missing.length > 0) throw new DependencyRemovedError(missing);
}

type ScopeAttempt = Pick<
  TaskAttempt,
  'readSetReceiptIds' | 'inheritedDependencyVector'
>;

/**
 * I8: a cited receipt must be in the emitting call's snapshot vector, the
 * attempt's readset, or the attempt's inherited vector. Receipt ids are
 * citations validated against scope, never authority.
 */
export function citationInScope(
  receiptId: string,
  snapshot: Pick<ContextSnapshot, 'dependencyVector'>,
  attempt: ScopeAttempt,
): boolean {
  return (
    snapshot.dependencyVector.some((entry) => entry.receiptId === receiptId) ||
    attempt.readSetReceiptIds.some((id) => id === receiptId) ||
    attempt.inheritedDependencyVector.some(
      (entry) => entry.receiptId === receiptId,
    )
  );
}

export function citationsOutOfScope(
  receiptIds: readonly string[],
  snapshot: Pick<ContextSnapshot, 'dependencyVector'>,
  attempt: ScopeAttempt,
): string[] {
  return receiptIds.filter((id) => !citationInScope(id, snapshot, attempt));
}

/**
 * Output/intent dependency vector: the emitting snapshot's vector plus the
 * cited entries (each validated in scope). Citations add, never remove.
 */
export function outputDependencyVector(options: {
  snapshot: Pick<ContextSnapshot, 'dependencyVector'>;
  attempt: ScopeAttempt;
  cited: readonly DependencyEntry[];
}): DependencyVector {
  const outside = citationsOutOfScope(
    options.cited.map((entry) => entry.receiptId),
    options.snapshot,
    options.attempt,
  );
  if (outside.length > 0) throw new CitationOutOfScopeError(outside);
  return unionDependencyVectors(
    options.snapshot.dependencyVector,
    options.cited,
  );
}

export { compareDependencyEntries };
