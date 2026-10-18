// Matched comparison table assembled from evaluation result files. The result
// files are produced by the evaluation runner (evals/nemodots/results/, one
// JSON file per run: a trial object, an array of trials, or `{ trials: [] }`).
// This module only reads them. It computes no savings and no significance:
// per arm it reports the cohort size, how many trials actually reported each
// metric, and the sum / mean over exactly those trials. A metric no trial
// reported is null, never 0. Arms are compared only on scenarios that every
// arm has at least one trial for (the matched set); the rest are listed.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TelemetryError } from './spans.js';

const count = z.number().int().nonnegative().nullish();
const duration = z.number().nonnegative().nullish();

export const EvalTrialResultSchema = z
  .object({
    arm: z.string().min(1),
    scenarioId: z.string().min(1),
    trialId: z.string().min(1).nullish(),
    seed: z.union([z.string(), z.number()]).nullish(),
    resolved: z.boolean().nullish(),
    staleCommits: count,
    unsafeActions: count,
    falseBlocks: count,
    missedInvalidations: count,
    falseInvalidations: count,
    preservedWork: count,
    repeatedCalls: count,
    unknownOutcomes: count,
    modelCalls: count,
    orphanedCalls: count,
    promptTokens: count,
    completionTokens: count,
    /** null / absent = the provider did not report cached tokens. */
    cachedTokens: count,
    recoveryMs: duration,
    completionMs: duration,
    setupMs: duration,
    inferenceMs: duration,
    toolMs: duration,
    costUsd: z.number().nonnegative().nullish(),
  })
  .passthrough();
export type EvalTrialResult = z.infer<typeof EvalTrialResultSchema>;

export const COMPARISON_METRICS = [
  'staleCommits',
  'unsafeActions',
  'falseBlocks',
  'missedInvalidations',
  'falseInvalidations',
  'preservedWork',
  'repeatedCalls',
  'unknownOutcomes',
  'modelCalls',
  'orphanedCalls',
  'promptTokens',
  'completionTokens',
  'cachedTokens',
  'recoveryMs',
  'completionMs',
  'setupMs',
  'inferenceMs',
  'toolMs',
  'costUsd',
] as const;
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

export interface MetricStat {
  /** Trials in the cohort that reported this metric. */
  reported: number;
  sum: number | null;
  mean: number | null;
}

export interface ComparisonArm {
  arm: string;
  /** Matched trials in this arm. */
  trials: number;
  resolved: { reported: number; yes: number; rate: number | null };
  metrics: Record<ComparisonMetric, MetricStat>;
}

export interface SkippedResultFile {
  file: string;
  reason: string;
}

export interface ComparisonTable {
  arms: ComparisonArm[];
  matchedScenarios: string[];
  /** Scenarios not every arm has a trial for; excluded from `arms`. */
  unmatchedScenarios: string[];
  skipped: SkippedResultFile[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stat(values: readonly number[]): MetricStat {
  if (values.length === 0) return { reported: 0, sum: null, mean: null };
  const sum = values.reduce((total, value) => total + value, 0);
  return { reported: values.length, sum, mean: sum / values.length };
}

/** Pure assembly of the matched table from already-parsed trials. */
export function assembleComparison(
  trials: readonly EvalTrialResult[],
  skipped: readonly SkippedResultFile[] = [],
): ComparisonTable {
  const armNames = [...new Set(trials.map((t) => t.arm))].sort(compare);
  const scenarios = [...new Set(trials.map((t) => t.scenarioId))].sort(compare);
  const matched = scenarios.filter((scenario) =>
    armNames.every((arm) =>
      trials.some((t) => t.arm === arm && t.scenarioId === scenario),
    ),
  );
  const matchedSet = new Set(matched);
  const arms = armNames.map((arm): ComparisonArm => {
    const cohort = trials.filter(
      (t) => t.arm === arm && matchedSet.has(t.scenarioId),
    );
    const resolvedValues = cohort
      .map((t) => t.resolved)
      .filter((v): v is boolean => typeof v === 'boolean');
    const yes = resolvedValues.filter(Boolean).length;
    const metrics = Object.fromEntries(
      COMPARISON_METRICS.map((metric) => [
        metric,
        stat(
          cohort
            .map((t) => t[metric])
            .filter((v): v is number => typeof v === 'number'),
        ),
      ]),
    ) as Record<ComparisonMetric, MetricStat>;
    return {
      arm,
      trials: cohort.length,
      resolved: {
        reported: resolvedValues.length,
        yes,
        rate: resolvedValues.length === 0 ? null : yes / resolvedValues.length,
      },
      metrics,
    };
  });
  return {
    arms,
    matchedScenarios: matched,
    unmatchedScenarios: scenarios.filter((s) => !matchedSet.has(s)),
    skipped: [...skipped],
  };
}

function trialsOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const inner = (json as { trials?: unknown } | null)?.trials;
  if (Array.isArray(inner)) return inner;
  return [json];
}

/** Reads result files; unreadable or invalid files are reported in `skipped`, never dropped silently. */
export async function readEvalResultFiles(
  files: readonly string[],
): Promise<{ trials: EvalTrialResult[]; skipped: SkippedResultFile[] }> {
  const trials: EvalTrialResult[] = [];
  const skipped: SkippedResultFile[] = [];
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      skipped.push({
        file,
        reason:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'file not found'
            : 'not valid JSON',
      });
      continue;
    }
    for (const [index, entry] of trialsOf(json).entries()) {
      const parsed = EvalTrialResultSchema.safeParse(entry);
      if (parsed.success) trials.push(parsed.data);
      else
        skipped.push({
          file,
          reason: `trial ${index}: ${parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join('.') || '<root>'}: ${issue.message}`,
            )
            .join('; ')}`,
        });
    }
  }
  return { trials, skipped };
}

/** Assembles the table from every *.json file directly inside `dir`. */
export async function buildComparisonFromDirectory(
  dir: string,
): Promise<ComparisonTable> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    throw new TelemetryError(
      'comparison_invalid',
      'evaluation results directory is not readable',
    );
  }
  const { trials, skipped } = await readEvalResultFiles(
    names.sort(compare).map((name) => path.join(dir, name)),
  );
  return assembleComparison(trials, skipped);
}
