// Pricing read from the provider's own /v1/models response. When the endpoint
// is unreachable, malformed or silent about a model, the price is null and so
// is any cost derived from it: nothing is estimated, nothing is defaulted.
// The endpoint does not state its unit; values are read as USD per 1M tokens
// and every result carries that assumption.
import type { TelemetrySummary } from '../contracts/index.js';

export const PRICING_UNIT_ASSUMPTION =
  'USD per 1,000,000 tokens (assumed: the provider /v1/models response does not state a unit)';

export interface ModelPrice {
  model: string;
  promptPerMTok: number | null;
  completionPerMTok: number | null;
  cachedPromptPerMTok: number | null;
}

const rate = (value: unknown): number | null => {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};

/** Prices by model id; models without a usable pricing object are omitted. */
export function parsePricing(body: unknown): Record<string, ModelPrice> | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const prices: Record<string, ModelPrice> = {};
  for (const entry of data) {
    const model = (entry as { id?: unknown } | null)?.id;
    const pricing = (entry as { pricing?: unknown } | null)?.pricing;
    if (typeof model !== 'string' || !pricing || typeof pricing !== 'object')
      continue;
    const raw = pricing as Record<string, unknown>;
    prices[model] = {
      model,
      promptPerMTok: rate(raw.prompt),
      completionPerMTok: rate(raw.completion),
      cachedPromptPerMTok: rate(raw.input_cache_reads),
    };
  }
  return prices;
}

export interface PricingResult {
  prices: Record<string, ModelPrice> | null;
  /** why prices are null; null when they were read */
  unavailableReason: string | null;
  unit: typeof PRICING_UNIT_ASSUMPTION;
}

export async function fetchPricing(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PricingResult> {
  const unavailable = (reason: string): PricingResult => ({
    prices: null,
    unavailableReason: reason,
    unit: PRICING_UNIT_ASSUMPTION,
  });
  let url: URL;
  try {
    url = new URL(`${options.baseUrl.replace(/\/+$/, '')}/models`);
  } catch {
    return unavailable('base URL is not valid');
  }
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      redirect: 'error',
      signal: options.signal,
    });
    if (!response.ok)
      return unavailable(`/models answered HTTP ${response.status}`);
    const prices = parsePricing(await response.json());
    return prices
      ? { prices, unavailableReason: null, unit: PRICING_UNIT_ASSUMPTION }
      : unavailable('/models response has no model list');
  } catch {
    return unavailable('/models could not be read');
  }
}

export interface Cost {
  usd: number | null;
  /** true when cached prompt tokens were billed at the cached rate */
  cachedDiscountApplied: boolean;
  /** why usd is null */
  reason: string | null;
}

/**
 * Cost of one model's token totals. Null when the price or a needed rate is
 * unknown. When cached tokens are unavailable, every prompt token is billed at
 * the full prompt rate and `cachedDiscountApplied` says no discount was taken.
 */
export function costOf(
  price: ModelPrice | undefined,
  tokens: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
  },
): Cost {
  if (!price)
    return { usd: null, cachedDiscountApplied: false, reason: 'no price' };
  if (price.promptPerMTok === null || price.completionPerMTok === null)
    return {
      usd: null,
      cachedDiscountApplied: false,
      reason: 'prompt or completion rate unavailable',
    };
  const cached =
    tokens.cachedTokens !== null && price.cachedPromptPerMTok !== null
      ? Math.min(tokens.cachedTokens, tokens.promptTokens)
      : 0;
  const discount = cached > 0 && price.cachedPromptPerMTok !== null;
  const usd =
    ((tokens.promptTokens - cached) * price.promptPerMTok +
      cached * (price.cachedPromptPerMTok ?? 0) +
      tokens.completionTokens * price.completionPerMTok) /
    1_000_000;
  return { usd, cachedDiscountApplied: discount, reason: null };
}

/** Sums per-model costs; null as soon as one model's cost is unknown. */
export function summaryCost(
  summary: TelemetrySummary,
  prices: Record<string, ModelPrice> | null,
): Cost {
  if (!prices)
    return {
      usd: null,
      cachedDiscountApplied: false,
      reason: 'pricing unavailable',
    };
  let usd = 0;
  let discounted = false;
  for (const entry of summary.byModel) {
    const cost = costOf(prices[entry.model], entry);
    if (cost.usd === null)
      return {
        usd: null,
        cachedDiscountApplied: false,
        reason: `${entry.model}: ${cost.reason}`,
      };
    usd += cost.usd;
    discounted ||= cost.cachedDiscountApplied;
  }
  return { usd, cachedDiscountApplied: discounted, reason: null };
}
