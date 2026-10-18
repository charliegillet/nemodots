// The runner's view of the world. A host resets the checkout, injects the
// scenario's faults through the same version authority the product uses,
// starts a mission under one arm (strategy and layout), waits for it, runs a
// fresh independent probe, and returns plain observations. Separating this
// from the runner lets the cohort logic, scoring and export be tested without a
// stack, and keeps "live" and "fixture" honestly apart (a fixture host is never
// counted as a live trial).
import type { ScenarioManifest, ResolvedStep } from '../sandbox/manifest.js';
import type { PreconditionReport } from '../sandbox/preconditions.js';
import type { Observations } from './observations.js';
import type { TrialSpec } from './types.js';

export class HostBlockedError extends Error {
  constructor(
    readonly missing: readonly string[],
    message?: string,
  ) {
    super(message ?? `BLOCKED: ${missing.join(', ')}`);
    this.name = 'HostBlockedError';
  }
}

export interface EnvironmentFacts {
  mode: 'live' | 'fixture';
  instance: string;
  /** requested model */
  model: string;
  /** new URL(OPENAI_BASE_URL).host */
  providerHost: string;
  commit: string | null;
  node: string;
  /** names only, e.g. NEMODOTS_TASK_MAX_TOKENS=200000 */
  settings: Record<string, string | number | boolean | null>;
}

export interface FaultOutcome {
  status: string;
  /** proposal-triggered steps that never fired (`dependent_step_not_triggered`) */
  notTriggered: number[];
  preconditions: PreconditionReport | null;
}

export interface FaultRun {
  /** resolves when every step has been applied, skipped or has failed */
  done: Promise<FaultOutcome>;
  /** stops armed steps (the mission is over), releases the listener, reports what happened */
  cancel(): Promise<FaultOutcome>;
}

/**
 * Thrown by `startFaults` when the scenario's symptom was not visible through
 * the readers before the mission would start. The sandbox's own error is the
 * type; fixtures construct it too.
 */
export function isPreconditionFailure(error: unknown): error is Error & {
  code: 'scenario_precondition_failed';
  report: PreconditionReport;
} {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'scenario_precondition_failed'
  );
}

export interface EndState {
  status: string;
  timedOut: boolean;
  endedAt: string;
}

export interface EvalHost {
  readonly facts: EnvironmentFacts;
  /** Restores the baseline, flushes and primes the cache, clears scenario residue. */
  prepare(
    spec: TrialSpec,
    manifest: ScenarioManifest,
    steps: readonly ResolvedStep[],
  ): Promise<void>;
  /**
   * Applies the scenario's faults and VERIFIES its preconditions: resolves only
   * when the symptoms are visible through the readers (or the manifest declares
   * none), rejects with a `scenario_precondition_failed` error otherwise. The
   * mission starts after this resolves, never before.
   */
  startFaults(spec: TrialSpec, manifest: ScenarioManifest): Promise<FaultRun>;
  /** Creates and starts a mission under the arm of `spec`. */
  startMission(
    spec: TrialSpec,
    goal: string,
  ): Promise<{ missionId: string; startedAt: string }>;
  waitForEnd(missionId: string, timeoutMs: number): Promise<EndState>;
  cancelMission(missionId: string): Promise<void>;
  /** Fresh probe + SQL collection; never reads anything the mission wrote to the model. */
  observe(input: {
    spec: TrialSpec;
    missionId: string;
    startedAt: string;
    endedAt: string | null;
  }): Promise<Observations>;
  close(): Promise<void>;
}
