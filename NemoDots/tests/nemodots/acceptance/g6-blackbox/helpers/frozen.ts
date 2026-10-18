// Loader and types for the frozen held-out manifest (evals/nemodots/frozen).
// Only this suite (the verifier harness) reads it; runtime code never does.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT } from './config.js';

export const FROZEN_DIR = resolve(APP_ROOT, 'evals/nemodots/frozen');

export type StepTrigger =
  | { kind: 'pre_start' }
  | { kind: 'at_ms'; ms: number }
  | { kind: 'on_action_proposed'; key: string; delayMs: number }
  | { kind: 'after_first_commit'; delayMs: number }
  | { kind: 'after_first_admitted'; delayMs: number };

export interface Step {
  trigger: StepTrigger;
  key: string;
  value: string | number | boolean;
  actor: 'injector' | 'owner';
  requiresStaleBlobs?: boolean;
}

export type KeyPredicate =
  | {
      key: string;
      equals: 'pre_trial' | string | number | boolean;
    }
  | {
      key: string;
      anyOf: ({ equals: unknown } | { verifiedFlushOfActiveNamespace: true })[];
    }
  | {
      kind: 'load_sample';
      requests: number;
      concurrency: number;
      max503PoolTimeout: number;
    }
  | { kind: 'false_invalidations'; max: number }
  | { kind: 'redis_effects_per_action'; max: number };

export interface Disruption {
  mode: 'http_503' | 'http_429' | 'connection_reset';
  startAfterModelCalls: number;
  durationMs?: number;
  requests?: number;
}

export interface Crash {
  signal: 'SIGKILL';
  at:
    | 'after_first_specialist_model_call'
    | 'after_first_admitted'
    | 'after_first_commit';
  restartAfterMs: number;
}

export interface FrozenTrial {
  trialId: string;
  seed: number;
  faultClass?: string;
  missionOptions?: { admissionMinAgeMs?: number };
  steps: Step[];
  load: { readConcurrency: number };
  probe: { quantity: number; windowMs: number };
  disruption?: Disruption;
  crash?: Crash;
  expected?: {
    allowedMutationKeys: string[];
    flushAllowed: boolean;
    keyPredicates: KeyPredicate[];
    acceptableMissionOutcomes?: string[];
    refrainScoring?: {
      key: string;
      unnecessaryCommitsAfterRepairObserved: number;
    };
  };
}

export interface Manifest {
  manifestVersion: string;
  missionGoal: string;
  missionConstraints: string[];
  defaults: {
    admissionMinAgeMs: number;
    trialMaxWallClockMs: number;
    probeWindowMs: number;
    healthSampleIntervalMs: number;
  };
  classes: { class: string; file: string; trials: number }[];
  totalTrials: number;
}

export interface Thresholds {
  safety: { metrics: Record<string, number> };
  usefulness: {
    repairResolution: {
      classes: string[];
      minAggregateRate: number;
    };
    controlSuccess: { classes: string[]; minRate: number };
    falseBlockRate: { max: number };
  };
  provider: {
    maxRetriesPerCall: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    maxInFlightPerModel: number;
  };
  boundedRecovery: {
    maxRepairAttemptsPerTaskPerInvalidationEvent: number;
    maxAttemptsPerTask: number;
    maxInvalidationEventsPerSourceRevision: number;
    maxModelCallsPerTrial: number;
  };
  timing: {
    trialMaxWallClockMs: number;
    crashResumeMaxMs: number;
    probeWindowMsDefault: number;
    healthSampleIntervalMs: number;
  };
}

export interface FrozenTrialRef {
  cls: string;
  trial: FrozenTrial;
}

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(resolve(FROZEN_DIR, file), 'utf8')) as T;

export function loadManifest(): Manifest {
  return readJson<Manifest>('manifest.json');
}
export function loadThresholds(): Thresholds {
  return readJson<Thresholds>('thresholds.json');
}

export function loadTrials(): FrozenTrialRef[] {
  const manifest = loadManifest();
  return manifest.classes.flatMap((entry) =>
    readJson<{ trials: FrozenTrial[] }>(entry.file).trials.map((trial) => ({
      cls: entry.class,
      trial,
    })),
  );
}

/** ACC6_TRIALS="fz-rf-1,healthy_control" limits the autonomous runs; unset = all 28. */
export function selectedTrials(env = process.env): FrozenTrialRef[] {
  const all = loadTrials();
  const filter = env.ACC6_TRIALS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!filter?.length) return all;
  return all.filter(
    ({ cls, trial }) => filter.includes(trial.trialId) || filter.includes(cls),
  );
}

export const REPAIR_CLASSES = [
  'repairable_checkout_fault',
  'dependent_change_after_proposed_repair',
  'second_change_during_repair',
  'conflicting_observations',
  'worker_crash',
] as const;
export const CONTROL_CLASSES = [
  'healthy_control',
  'benign_unrelated_change',
] as const;
