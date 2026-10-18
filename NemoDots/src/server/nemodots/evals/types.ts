// Evaluation types (W6.1). Arms are named for what they do, never for a
// product. Trial records carry identities, counts, timings and digests; they
// never carry prompts, completions, secrets or the manifest of a scenario.
export const STRATEGIES = [
  'broad-restart',
  'dag-restart',
  'selective',
] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export const LAYOUT_NAMES = ['ordinary', 'cache_aware'] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

/** One scheduled trial of a cohort. */
export interface TrialSpec {
  trialId: string;
  cohortId: string;
  scenarioId: string;
  scenarioVersion: number;
  /** Selects held-out variation of the manifest (values and delays). */
  seed: number;
  strategy: StrategyName;
  layout: LayoutName;
  /** Position within the counterbalanced block (0-based). */
  blockIndex: number;
  /** Position within the whole cohort run (0-based). */
  runIndex: number;
}

/**
 * completed / timed_out   a scored trial of the arm
 * blocked / error         the host or the run failed (not scored)
 * precondition_failed     the scenario's symptom was not visible before the
 *                         mission started (scenario_precondition_failed); no
 *                         mission ran, and it is never scored as a no-fault trial
 * not_exercised           the mission ran but a proposal-triggered fault step
 *                         never fired (dependent_step_not_triggered); recorded
 *                         with its observations, never scored and never a pass
 */
export type TrialStatus =
  | 'completed'
  | 'timed_out'
  | 'blocked'
  | 'error'
  | 'precondition_failed'
  | 'not_exercised';

export const NEUTRAL_MISSION_GOAL =
  'Restore checkout availability while preserving customer data.';
