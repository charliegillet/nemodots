// Cost estimates from the provider's own /v1/models pricing (USD per 1M
// tokens, delivered as strings). Prices are fetched once, stored per mission
// (ledger.mission_pricing, append-only) and every estimate is computed from
// stored attempts and stored prices. A price the provider did not publish is
// NULL and makes the affected cost null: it is never defaulted to zero, and no
// price table is baked into the code.
//
// Estimate per model:
//   usd = (prompt - cached) * input + cached * cachedPrice + completion * output
// (same as prompt*in + cached*(cachedPrice - in) + completion*out). When the
// provider reported no cachedTokens for a model, all prompt tokens are priced
// at the input rate and the result is flagged `cachedAssumedUncached` (an
// upper bound). A cached count with no published cached price gives null.
import type { PgClient } from '../contracts/index.js';
import { TelemetryError } from './spans.js';

export interface ModelPrice {
  model: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedPerMillion: number | null;
}

export interface PricingTarget {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

const INPUT_KEYS = [
  'input',
  'prompt',
  'input_per_million',
  'input_per_1m',
  'prompt_per_million',
  'input_token',
  'input_tokens',
] as const;
const OUTPUT_KEYS = [
  'output',
  'completion',
  'output_per_million',
  'output_per_1m',
  'completion_per_million',
  'output_token',
  'output_tokens',
] as const;
// `input_cache_reads` is the field Crusoe's live /v1/models returns (verified
// 2026-10-17: prompt, completion, image, request, video, input_cache_reads).
// The other names are unverified aliases kept for tolerance.
const CACHED_KEYS = [
  'input_cache_reads',
  'cached',
  'cached_input',
  'cache_read',
  'cached_per_million',
  'cached_input_per_million',
  'cached_input_per_1m',
  'input_cached',
] as const;

function price(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function pick(
  pricing: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const found = price(pricing[key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Extracts per-model prices from a /v1/models response body. Models without a
 * pricing object yield all-null prices; unparseable fields are null.
 */
export function parseModelPricing(body: unknown): ModelPrice[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new TelemetryError(
      'pricing_invalid',
      '/v1/models response has no data array',
    );
  const out: ModelPrice[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') continue;
    const raw = (entry as { pricing?: unknown }).pricing;
    const pricing =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    out.push({
      model: id,
      inputPerMillion: pick(pricing, INPUT_KEYS),
      outputPerMillion: pick(pricing, OUTPUT_KEYS),
      cachedPerMillion: pick(pricing, CACHED_KEYS),
    });
  }
  return out;
}

export type FetchLike = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * GET {baseUrl}/models and returns the parsed prices. Failure throws a
 * TelemetryError('pricing_invalid') without the key or the response body;
 * callers store nothing and every cost stays null.
 */
export async function fetchModelPricing(
  target: PricingTarget,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ModelPrice[]> {
  let response;
  try {
    response = await fetchImpl(`${target.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(target.timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new TelemetryError('pricing_invalid', 'could not reach /v1/models');
  }
  if (!response.ok)
    throw new TelemetryError(
      'pricing_invalid',
      `/v1/models returned HTTP ${response.status}`,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TelemetryError('pricing_invalid', 'malformed /v1/models body');
  }
  return parseModelPricing(body);
}

/**
 * Stores the prices of `models` for a mission (insert-only: a model already
 * priced for the mission keeps its first observation). Models the provider did
 * not list are stored with all-null prices so the gap is visible.
 */
export async function storeMissionPricing(
  client: PgClient,
  input: {
    missionId: string;
    models: readonly string[];
    prices: readonly ModelPrice[];
    source: string;
    fetchedAt: string;
  },
): Promise<{ stored: number }> {
  const byModel = new Map(input.prices.map((p) => [p.model, p]));
  let stored = 0;
  for (const model of [...new Set(input.models)].sort()) {
    const p = byModel.get(model);
    const result = await client.query(
      `INSERT INTO ledger.mission_pricing
         (mission_id, model, input_per_million, output_per_million, cached_per_million, source, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (mission_id, model) DO NOTHING`,
      [
        input.missionId,
        model,
        p?.inputPerMillion ?? null,
        p?.outputPerMillion ?? null,
        p?.cachedPerMillion ?? null,
        input.source,
        input.fetchedAt,
      ],
    );
    stored += result.rowCount ?? 0;
  }
  return { stored };
}

export async function loadMissionPricing(
  client: PgClient,
  missionId: string,
): Promise<ModelPrice[]> {
  const { rows } = await client.query<{
    model: string;
    input_per_million: string | null;
    output_per_million: string | null;
    cached_per_million: string | null;
  }>(
    `SELECT model, input_per_million, output_per_million, cached_per_million
       FROM ledger.mission_pricing WHERE mission_id = $1 ORDER BY model`,
    [missionId],
  );
  return rows.map((row) => ({
    model: row.model,
    inputPerMillion:
      row.input_per_million === null ? null : Number(row.input_per_million),
    outputPerMillion:
      row.output_per_million === null ? null : Number(row.output_per_million),
    cachedPerMillion:
      row.cached_per_million === null ? null : Number(row.cached_per_million),
  }));
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** null: the provider reported no cached count for these tokens. */
  cachedTokens: number | null;
  /** Attempts that reported prompt tokens but no cached count; they are priced as uncached. */
  cachedUnreportedAttempts?: number;
}

export interface CostEstimate {
  usd: number | null;
  /** True when cachedTokens was unavailable and all prompt tokens were priced as uncached. */
  cachedAssumedUncached: boolean;
  /** Why usd is null; null when usd is a number. */
  unavailableReason:
    | 'no_price'
    | 'no_input_price'
    | 'no_output_price'
    | 'no_cached_price'
    | null;
}

export function estimateCost(
  usage: UsageTotals,
  priceRow: ModelPrice | undefined,
): CostEstimate {
  const none = (reason: CostEstimate['unavailableReason']): CostEstimate => ({
    usd: null,
    cachedAssumedUncached: false,
    unavailableReason: reason,
  });
  if (!priceRow) return none('no_price');
  if (priceRow.inputPerMillion === null) return none('no_input_price');
  if (priceRow.outputPerMillion === null) return none('no_output_price');
  const cached = usage.cachedTokens;
  if (cached !== null && cached > 0 && priceRow.cachedPerMillion === null)
    return none('no_cached_price');
  const cachedTokens = cached ?? 0;
  const uncachedPrompt = Math.max(0, usage.promptTokens - cachedTokens);
  const usd =
    (uncachedPrompt * priceRow.inputPerMillion +
      cachedTokens * (priceRow.cachedPerMillion ?? 0) +
      usage.completionTokens * priceRow.outputPerMillion) /
    1_000_000;
  return {
    usd,
    cachedAssumedUncached:
      (cached === null && usage.promptTokens > 0) ||
      (usage.cachedUnreportedAttempts ?? 0) > 0,
    unavailableReason: null,
  };
}

export interface MissionCost {
  byModel: { model: string; usage: UsageTotals; cost: CostEstimate }[];
  /** Sum over models; null when any model's cost is unavailable. */
  totalUsd: number | null;
  /** Number of models whose cost could not be computed. */
  unpricedModels: number;
}

/** Cost of a mission from stored attempts and stored prices. */
export async function estimateMissionCost(
  client: PgClient,
  missionId: string,
): Promise<MissionCost> {
  const prices = new Map(
    (await loadMissionPricing(client, missionId)).map((p) => [p.model, p]),
  );
  const { rows } = await client.query<{
    model: string;
    prompt: string;
    completion: string;
    cached: string | null;
    unreported: string;
  }>(
    `SELECT COALESCE(model_returned, model_requested) AS model,
            COUNT(*) FILTER (WHERE prompt_tokens IS NOT NULL AND cached_tokens IS NULL) AS unreported,
            COALESCE(SUM(prompt_tokens), 0) AS prompt,
            COALESCE(SUM(completion_tokens), 0) AS completion,
            SUM(cached_tokens) AS cached
       FROM ledger.inference_attempts WHERE mission_id = $1
      GROUP BY 1 ORDER BY 1`,
    [missionId],
  );
  const byModel = rows.map((row) => {
    const usage: UsageTotals = {
      promptTokens: Number(row.prompt),
      completionTokens: Number(row.completion),
      cachedTokens: row.cached === null ? null : Number(row.cached),
      cachedUnreportedAttempts: Number(row.unreported),
    };
    return {
      model: row.model,
      usage,
      cost: estimateCost(usage, prices.get(row.model)),
    };
  });
  const unpriced = byModel.filter((entry) => entry.cost.usd === null).length;
  return {
    byModel,
    totalUsd:
      unpriced > 0 || byModel.length === 0
        ? null
        : byModel.reduce((sum, entry) => sum + (entry.cost.usd ?? 0), 0),
    unpricedModels: unpriced,
  };
}
