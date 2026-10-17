// TelemetrySummary (CONTRACTS.md section 9, GET /telemetry/summary), per
// mission or global. Every number is an aggregate over stored rows of
// ledger.inference_attempts (and model_call_records / context_snapshots for
// the prefix groups); nothing is estimated here.
//
// Semantics:
//   calls          distinct model calls with a fenced record (attempt outcome
//                  'recorded').
//   orphanedCalls  distinct model calls stored only as 'orphaned_fence'
//                  attempts (C16). Counted separately, never inside `calls`.
//   tokens         summed over EVERY stored attempt, orphaned ones included:
//                  they were billed. A null usage field (cancelled attempt,
//                  provider omitted it) contributes nothing.
//   tokens.cached  `available` is true when at least one stored attempt
//                  reported cachedTokens; `total` sums the reported values and
//                  is null when none did. Partial coverage is reported in
//                  `detail.cached` and per model in byModel[].cachedTokens
//                  (null for a model that never reported it).
//   retries        attempts with n > 1.
//   errors         attempts that ended in an error class other than 'cancelled'.
//   ttftMs         nearest-rank p50/p95 of firstContentAt - startedAt over
//                  attempts that streamed a first content token; null if none.
//   prefixGroups   fenced calls grouped by ContextSnapshot.prefixDigest.
import {
  TelemetrySummarySchema,
  type ModelRole,
  type PgClient,
  type TelemetrySummary,
} from '../contracts/index.js';

/** Nearest-rank percentile of an unsorted list; null for an empty list. */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new RangeError('percentile is 0..100');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export interface TelemetryDetail {
  cached: {
    /** Attempts that reported prompt tokens. */
    attemptsWithUsage: number;
    /** Of those, attempts that also reported cachedTokens (possibly 0). */
    reported: number;
    /** Of those, attempts where cachedTokens was null (unavailable). */
    unavailable: number;
  };
  orphaned: {
    calls: number;
    attempts: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
  };
}

export interface DetailedTelemetrySummary {
  summary: TelemetrySummary;
  detail: TelemetryDetail;
}

/** The stored fields of one inference attempt that the summary reads. */
export interface AttemptSample {
  modelCallId: string;
  n: number;
  role: ModelRole;
  modelRequested: string;
  modelReturned: string | null;
  startedAtMs: number;
  firstContentAtMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  errorClass: string | null;
  outcome: 'recorded' | 'orphaned_fence';
}

/** Sum of the non-null values; null when there are none (unavailable, not 0). */
function sumReported(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) if (value !== null) total = (total ?? 0) + value;
  return total;
}

const distinctCalls = (samples: readonly AttemptSample[]) =>
  new Set(samples.map((s) => s.modelCallId)).size;

function group<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Pure aggregation over stored attempts; see the semantics in the file header. */
export function summarizeAttempts(
  attempts: readonly AttemptSample[],
  prefixDigests: readonly string[],
): DetailedTelemetrySummary {
  const fenced = attempts.filter((a) => a.outcome === 'recorded');
  const orphaned = attempts.filter((a) => a.outcome === 'orphaned_fence');
  const cachedTotal = sumReported(attempts.map((a) => a.cachedTokens));
  const ttft = attempts
    .filter(
      (a) => a.firstContentAtMs !== null && a.firstContentAtMs >= a.startedAtMs,
    )
    .map((a) => (a.firstContentAtMs as number) - a.startedAtMs);
  const p50 = percentile(ttft, 50);
  const p95 = percentile(ttft, 95);
  const tokens = (list: readonly AttemptSample[]) => ({
    promptTokens: sumReported(list.map((a) => a.promptTokens)) ?? 0,
    completionTokens: sumReported(list.map((a) => a.completionTokens)) ?? 0,
  });
  const prefixCounts = new Map<string, number>();
  for (const digest of prefixDigests)
    prefixCounts.set(digest, (prefixCounts.get(digest) ?? 0) + 1);

  const summary = TelemetrySummarySchema.parse({
    calls: distinctCalls(fenced),
    orphanedCalls: distinctCalls(orphaned),
    tokens: {
      prompt: tokens(attempts).promptTokens,
      completion: tokens(attempts).completionTokens,
      cached: { available: cachedTotal !== null, total: cachedTotal },
    },
    byModel: group(attempts, (a) => a.modelReturned ?? a.modelRequested).map(
      ([model, list]) => ({
        model,
        calls: distinctCalls(list.filter((a) => a.outcome === 'recorded')),
        ...tokens(list),
        cachedTokens: sumReported(list.map((a) => a.cachedTokens)),
      }),
    ),
    byRole: group(attempts, (a) => a.role).map(([role, list]) => ({
      role,
      calls: distinctCalls(list.filter((a) => a.outcome === 'recorded')),
      ...tokens(list),
    })),
    retries: attempts.filter((a) => a.n > 1).length,
    errors: attempts.filter(
      (a) => a.errorClass !== null && a.errorClass !== 'cancelled',
    ).length,
    ttftMs: p50 === null || p95 === null ? null : { p50, p95 },
    prefixGroups: [...prefixCounts.entries()]
      .map(([prefixDigest, calls]) => ({ prefixDigest, calls }))
      .sort(
        (a, b) =>
          b.calls - a.calls ||
          (a.prefixDigest < b.prefixDigest
            ? -1
            : a.prefixDigest > b.prefixDigest
              ? 1
              : 0),
      ),
  });

  const withUsage = attempts.filter((a) => a.promptTokens !== null);
  const reported = withUsage.filter((a) => a.cachedTokens !== null).length;
  return {
    summary,
    detail: {
      cached: {
        attemptsWithUsage: withUsage.length,
        reported,
        unavailable: withUsage.length - reported,
      },
      orphaned: {
        calls: distinctCalls(orphaned),
        attempts: orphaned.length,
        ...tokens(orphaned),
        cachedTokens: sumReported(orphaned.map((a) => a.cachedTokens)),
      },
    },
  };
}

interface AttemptDbRow {
  model_call_id: string;
  n: number;
  role: ModelRole;
  model_requested: string;
  model_returned: string | null;
  started_ms: number;
  first_content_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  error_class: string | null;
  outcome: 'recorded' | 'orphaned_fence';
}

/** Summary plus the coverage detail the contract shape has no room for. */
export async function summarizeTelemetryDetailed(
  client: PgClient,
  missionId: string | null = null,
): Promise<DetailedTelemetrySummary> {
  const scope = [missionId];
  // Epoch milliseconds are computed in SQL so timestamps keep microsecond
  // precision until the subtraction.
  const attempts = await client.query<AttemptDbRow>(
    `SELECT model_call_id, n, role, model_requested, model_returned,
            (EXTRACT(EPOCH FROM started_at) * 1000)::float8 AS started_ms,
            (EXTRACT(EPOCH FROM first_content_at) * 1000)::float8 AS first_content_ms,
            prompt_tokens, completion_tokens, cached_tokens, error_class, outcome
       FROM ledger.inference_attempts
      WHERE ($1::uuid IS NULL OR mission_id = $1::uuid)`,
    scope,
  );
  const prefixes = await client.query<{ prefix_digest: string }>(
    `SELECT s.prefix_digest
       FROM ledger.model_call_records r
       JOIN ledger.context_snapshots s ON s.id = r.context_snapshot_id
      WHERE ($1::uuid IS NULL OR r.mission_id = $1::uuid)`,
    scope,
  );
  return summarizeAttempts(
    attempts.rows.map((row) => ({
      modelCallId: row.model_call_id,
      n: row.n,
      role: row.role,
      modelRequested: row.model_requested,
      modelReturned: row.model_returned,
      startedAtMs: row.started_ms,
      firstContentAtMs: row.first_content_ms,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cachedTokens: row.cached_tokens,
      errorClass: row.error_class,
      outcome: row.outcome,
    })),
    prefixes.rows.map((row) => row.prefix_digest),
  );
}

/** The contract-shaped summary: one mission, or every mission when omitted. */
export async function summarizeTelemetry(
  client: PgClient,
  missionId: string | null = null,
): Promise<TelemetrySummary> {
  return (await summarizeTelemetryDetailed(client, missionId)).summary;
}
