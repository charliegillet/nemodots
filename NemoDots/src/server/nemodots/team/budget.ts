// Per-attempt budget: iterations (contract maximum 12) and tokens. Tokens are
// input + output, since input dominates cost. Cached tokens are reported
// separately and `null` (the provider did not say) stays distinct from 0.
import type { Usage } from '../contracts/index.js';

export const MAX_LOOP_ITERATIONS = 12;

export interface TokenReport {
  promptTokens: number;
  completionTokens: number;
  /** Sum of the cached tokens providers reported; null when none did. */
  cachedTokens: number | null;
  /** Calls whose input or output count was unavailable (not counted as 0 in spirit). */
  callsWithUnavailableUsage: number;
}

export interface AttemptBudget {
  readonly maxIterations: number;
  readonly maxTokens: number;
  iteration(): number;
  /** Starts the next iteration; false when the iteration cap was already reached. */
  next(): boolean;
  isLastIteration(): boolean;
  spend(usage: Usage | null): void;
  /** input + output tokens counted so far. */
  spentTokens(): number;
  tokensExhausted(): boolean;
  report(): TokenReport;
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
  let prompt = 0;
  let completion = 0;
  let cached: number | null = null;
  let unavailable = 0;
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
      if (
        !usage ||
        usage.promptTokens === null ||
        usage.completionTokens === null
      )
        unavailable += 1;
      if (!usage) return;
      prompt += usage.promptTokens ?? 0;
      completion += usage.completionTokens ?? 0;
      if (usage.cachedTokens !== null)
        cached = (cached ?? 0) + usage.cachedTokens;
    },
    spentTokens: () => prompt + completion,
    tokensExhausted: () => prompt + completion >= limits.maxTokens,
    report: () => ({
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens: cached,
      callsWithUnavailableUsage: unavailable,
    }),
  };
}
