// TelemetrySummary (CONTRACTS section 9) computed from stored inference
// attempts. Every number traces to a row. Unavailable is null, never 0:
// cached tokens are `available:false, total:null` when no attempt reported
// them; time to first token is null when no attempt produced content.
// Attempts whose fenced record was rejected (outcome 'orphaned_fence', C16)
// are counted separately as `orphanedCalls` and excluded from every other
// figure, because they never became part of a mission's reasoning.
import {
  TelemetrySummarySchema,
  type ModelRole,
  type PgClient,
  type TelemetrySummary,
} from '../contracts/index.js';

export interface AttemptRow {
  modelCallId: string;
  n: number;
  role: ModelRole;
  modelRequested: string;
  modelReturned: string | null;
  outcome: 'recorded' | 'orphaned_fence';
  startedAt: string;
  firstContentAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  errorClass: string | null;
  /** prefix digest of the call's context snapshot; null for orphaned calls */
  prefixDigest: string | null;
}

interface RawRow {
  model_call_id: string;
  n: number;
  role: ModelRole;
  model_requested: string;
  model_returned: string | null;
  outcome: 'recorded' | 'orphaned_fence';
  started_at: Date;
  first_content_at: Date | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  error_class: string | null;
  prefix_digest: string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

export async function loadAttemptRows(
  client: PgClient,
  missionId?: string,
): Promise<AttemptRow[]> {
  const { rows } = await client.query<RawRow>(
    `SELECT a.model_call_id, a.n, a.role, a.model_requested, a.model_returned, a.outcome,
            a.started_at, a.first_content_at, a.prompt_tokens, a.completion_tokens,
            a.cached_tokens, a.error_class, s.prefix_digest
       FROM ledger.inference_attempts a
       LEFT JOIN ledger.model_call_records m ON m.id = a.model_call_id
       LEFT JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
      WHERE ($1::uuid IS NULL OR a.mission_id = $1::uuid)
      ORDER BY a.model_call_id, a.n`,
    [missionId ?? null],
  );
  return rows.map((row) => ({
    modelCallId: row.model_call_id,
    n: row.n,
    role: row.role,
    modelRequested: row.model_requested,
    modelReturned: row.model_returned,
    outcome: row.outcome,
    startedAt: iso(row.started_at),
    firstContentAt: row.first_content_at ? iso(row.first_content_at) : null,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    cachedTokens: row.cached_tokens,
    errorClass: row.error_class,
    prefixDigest: row.prefix_digest,
  }));
}

/** Linear-interpolation percentile (the continuous definition); null when empty. */
export function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) return null;
  if (!(fraction >= 0 && fraction <= 1))
    throw new RangeError('fraction must be between 0 and 1');
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

interface Bucket {
  calls: Set<string>;
  prompt: number;
  completion: number;
  cached: number;
  cachedSeen: boolean;
}
const bucket = (): Bucket => ({
  calls: new Set(),
  prompt: 0,
  completion: 0,
  cached: 0,
  cachedSeen: false,
});
function add(target: Bucket, row: AttemptRow) {
  target.calls.add(row.modelCallId);
  target.prompt += row.promptTokens ?? 0;
  target.completion += row.completionTokens ?? 0;
  if (row.cachedTokens !== null) {
    target.cached += row.cachedTokens;
    target.cachedSeen = true;
  }
}
const byKey = <T>(a: [string, T], b: [string, T]) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

export function summarizeAttempts(
  rows: readonly AttemptRow[],
): TelemetrySummary {
  const recorded = rows.filter((row) => row.outcome === 'recorded');
  const orphaned = new Set(
    rows
      .filter((row) => row.outcome === 'orphaned_fence')
      .map((row) => row.modelCallId),
  );
  const total = bucket();
  const models = new Map<string, Bucket>();
  const roles = new Map<ModelRole, Bucket>();
  const prefixes = new Map<string, Set<string>>();
  const ttft: number[] = [];
  let retries = 0;
  let errors = 0;
  for (const row of recorded) {
    add(total, row);
    const model = row.modelReturned ?? row.modelRequested;
    add(models.get(model) ?? models.set(model, bucket()).get(model)!, row);
    add(
      roles.get(row.role) ?? roles.set(row.role, bucket()).get(row.role)!,
      row,
    );
    if (row.n > 1) retries += 1;
    // A cancelled attempt is not an error.
    if (row.errorClass !== null && row.errorClass !== 'cancelled') errors += 1;
    if (row.firstContentAt !== null && row.errorClass === null) {
      const ms = Date.parse(row.firstContentAt) - Date.parse(row.startedAt);
      if (ms >= 0) ttft.push(ms);
    }
    if (row.prefixDigest)
      (
        prefixes.get(row.prefixDigest) ??
        prefixes.set(row.prefixDigest, new Set()).get(row.prefixDigest)!
      ).add(row.modelCallId);
  }
  const p50 = percentile(ttft, 0.5);
  const p95 = percentile(ttft, 0.95);
  return TelemetrySummarySchema.parse({
    calls: total.calls.size,
    orphanedCalls: orphaned.size,
    tokens: {
      prompt: total.prompt,
      completion: total.completion,
      cached: {
        available: total.cachedSeen,
        total: total.cachedSeen ? total.cached : null,
      },
    },
    byModel: [...models.entries()].sort(byKey).map(([model, b]) => ({
      model,
      calls: b.calls.size,
      promptTokens: b.prompt,
      completionTokens: b.completion,
      cachedTokens: b.cachedSeen ? b.cached : null,
    })),
    byRole: [...roles.entries()].sort(byKey).map(([role, b]) => ({
      role,
      calls: b.calls.size,
      promptTokens: b.prompt,
      completionTokens: b.completion,
    })),
    retries,
    errors,
    ttftMs: p50 === null || p95 === null ? null : { p50, p95 },
    prefixGroups: [...prefixes.entries()]
      .sort(byKey)
      .map(([prefixDigest, calls]) => ({ prefixDigest, calls: calls.size })),
  });
}

/** Summary of one mission, or of everything when no mission is given. */
export async function telemetrySummary(
  client: PgClient,
  missionId?: string,
): Promise<TelemetrySummary> {
  return summarizeAttempts(await loadAttemptRows(client, missionId));
}
