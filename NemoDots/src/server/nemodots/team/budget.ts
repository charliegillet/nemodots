import type { Usage } from '../contracts/index.js';
import { BudgetExhaustedError } from './errors.js';

// Server-side budgets (BUILD_PROMPT: bounded budgets). Limits come from the
// task row and the mission row, never from the model. The mission-wide figures
// are re-read before every call from the ledger, so concurrent attempts of
// the same mission share one budget.

/** Hard ceiling on tool-loop iterations, whatever the task row says. */
export const MAX_LOOP_ITERATIONS = 12;

export interface AttemptBudgetOptions {
  maxIterations: number;
  /** task.budget.maxTokens: prompt + completion tokens across this attempt. */
  taskMaxTokens: number;
  missionMaxTokens: number;
  missionMaxCalls: number;
  missionUsage: () => Promise<{ calls: number; tokens: number }>;
}

export interface AttemptBudget {
  /** Throws BudgetExhaustedError when the next model call would exceed a limit. */
  beforeCall(): Promise<void>;
  /** Adds a completed call's usage (null counts as unavailable, i.e. 0). */
  record(usage: Usage): void;
  readonly iterations: number;
  readonly tokens: number;
}

export function createAttemptBudget(
  options: AttemptBudgetOptions,
): AttemptBudget {
  const limit = Math.min(options.maxIterations, MAX_LOOP_ITERATIONS);
  let iterations = 0;
  let tokens = 0;
  return {
    async beforeCall() {
      if (iterations >= limit)
        throw new BudgetExhaustedError('iterations', iterations, limit);
      if (tokens >= options.taskMaxTokens)
        throw new BudgetExhaustedError(
          'task_tokens',
          tokens,
          options.taskMaxTokens,
        );
      const mission = await options.missionUsage();
      if (mission.calls >= options.missionMaxCalls)
        throw new BudgetExhaustedError(
          'mission_calls',
          mission.calls,
          options.missionMaxCalls,
        );
      if (mission.tokens >= options.missionMaxTokens)
        throw new BudgetExhaustedError(
          'mission_tokens',
          mission.tokens,
          options.missionMaxTokens,
        );
      iterations += 1;
    },
    record(usage) {
      tokens += (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    },
    get iterations() {
      return iterations;
    },
    get tokens() {
      return tokens;
    },
  };
}
