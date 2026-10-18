// Per-attempt budget: iterations (contract maximum 12) and generated tokens.
import type { Usage } from '../contracts/index.js';

export const MAX_LOOP_ITERATIONS = 12;

export interface AttemptBudget {
  readonly maxIterations: number;
  readonly maxTokens: number;
  iteration(): number;
  /** Starts the next iteration; false when the iteration cap was already reached. */
  next(): boolean;
  isLastIteration(): boolean;
  spend(usage: Usage | null): void;
  spentTokens(): number;
  tokensExhausted(): boolean;
}

export function createBudget(limits: {
  maxIterations: number;
  maxTokens: number;
}): AttemptBudget {
  const maxIterations = Math.max(
    1,
    Math.min(MAX_LOOP_ITERATIONS, limits.maxIterations),
  );
  let iteration = 0;
  let spent = 0;
  return {
    maxIterations,
    maxTokens: limits.maxTokens,
    iteration: () => iteration,
    next() {
      if (iteration >= maxIterations) return false;
      iteration += 1;
      return true;
    },
    isLastIteration: () => iteration >= maxIterations,
    spend(usage) {
      if (!usage) return;
      // Output tokens only: the prompt is re-sent every iteration and is
      // already bounded by the iteration cap and the per-item caps.
      spent += usage.completionTokens ?? 0;
    },
    spentTokens: () => spent,
    tokensExhausted: () => spent >= limits.maxTokens,
  };
}
