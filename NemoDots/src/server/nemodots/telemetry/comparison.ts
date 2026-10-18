// Comparison assembly across strategies (broad restart, DAG restart,
// selective repair). It copies stored numbers and derives differences only
// when both sides are known; anything unavailable stays null with a reason, so
// no saving is ever invented.
import type { TelemetrySummary } from '../contracts/index.js';
import {
  PRICING_UNIT_ASSUMPTION,
  summaryCost,
  type ModelPrice,
} from './pricing.js';
import type { TimingSplit } from './spans.js';

export interface ComparisonArmInput {
  arm: string;
  summary: TelemetrySummary;
  timing?: TimingSplit | null;
  prices?: Record<string, ModelPrice> | null;
}

export interface ComparisonRow {
  arm: string;
  calls: number;
  orphanedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  retries: number;
  errors: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  costUsd: number | null;
  costNote: string | null;
  recoveryMs: number | null;
  completionMs: number | null;
}

export interface ComparisonDelta {
  arm: string;
  /** arm minus baseline; null when either side is unavailable */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  costUsd: number | null;
  recoveryMs: number | null;
  completionMs: number | null;
}

export interface ComparisonReport {
  baseline: string;
  rows: ComparisonRow[];
  deltas: ComparisonDelta[];
  /** one line per field that could not be filled, with the arm */
  unavailable: string[];
  pricingUnit: typeof PRICING_UNIT_ASSUMPTION;
}

const minus = (value: number | null, base: number | null) =>
  value === null || base === null ? null : value - base;

export function assembleComparison(
  arms: readonly ComparisonArmInput[],
  baseline: string,
): ComparisonReport {
  if (!arms.some((arm) => arm.arm === baseline))
    throw new RangeError(`baseline arm ${baseline} is not among the arms`);
  if (new Set(arms.map((arm) => arm.arm)).size !== arms.length)
    throw new RangeError('arm names must be unique');
  const unavailable: string[] = [];
  const rows: ComparisonRow[] = arms.map(({ arm, summary, timing, prices }) => {
    const cost = summaryCost(summary, prices ?? null);
    const row: ComparisonRow = {
      arm,
      calls: summary.calls,
      orphanedCalls: summary.orphanedCalls,
      promptTokens: summary.tokens.prompt,
      completionTokens: summary.tokens.completion,
      cachedTokens: summary.tokens.cached.total,
      retries: summary.retries,
      errors: summary.errors,
      ttftP50Ms: summary.ttftMs?.p50 ?? null,
      ttftP95Ms: summary.ttftMs?.p95 ?? null,
      costUsd: cost.usd,
      costNote: cost.reason,
      recoveryMs: timing?.recoveryMs ?? null,
      completionMs: timing?.completionMs ?? null,
    };
    if (row.cachedTokens === null)
      unavailable.push(`${arm}: cached tokens unavailable`);
    if (row.ttftP50Ms === null) unavailable.push(`${arm}: TTFT unavailable`);
    if (row.costUsd === null)
      unavailable.push(`${arm}: cost unavailable (${cost.reason})`);
    if (row.recoveryMs === null)
      unavailable.push(`${arm}: recovery time unavailable`);
    if (row.completionMs === null)
      unavailable.push(`${arm}: completion time unavailable`);
    return row;
  });
  const base = rows.find((row) => row.arm === baseline)!;
  const deltas: ComparisonDelta[] = rows
    .filter((row) => row.arm !== baseline)
    .map((row) => ({
      arm: row.arm,
      calls: row.calls - base.calls,
      promptTokens: row.promptTokens - base.promptTokens,
      completionTokens: row.completionTokens - base.completionTokens,
      cachedTokens: minus(row.cachedTokens, base.cachedTokens),
      costUsd: minus(row.costUsd, base.costUsd),
      recoveryMs: minus(row.recoveryMs, base.recoveryMs),
      completionMs: minus(row.completionMs, base.completionMs),
    }));
  return {
    baseline,
    rows,
    deltas,
    unavailable,
    pricingUnit: PRICING_UNIT_ASSUMPTION,
  };
}
