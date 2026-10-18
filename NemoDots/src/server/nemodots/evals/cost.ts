// Cost of a trial. Prefer prices the provider states in /v1/models (telemetry/
// pricing.ts). When none are available the documented ESTIMATE below is used
// and every figure derived from it is labelled as an estimate. Nothing is
// invented: with neither source the cost is null.
import {
  PRICING_UNIT_ASSUMPTION,
  type ModelPrice,
} from '../telemetry/pricing.js';

/**
 * LEAD_NOTES.md "Runtime models": $0.30 in / $2.40 out / $0.15 cached per 1M
 * tokens for nvidia/NVIDIA-Nemotron-3-Super-120B-A12B. Third-party research
 * figures, not a bill: labelled an estimate wherever used.
 */
export const ESTIMATED_PRICE: Readonly<ModelPrice> = Object.freeze({
  model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  promptPerMTok: 0.3,
  completionPerMTok: 2.4,
  cachedPromptPerMTok: 0.15,
});

export type PriceSource = 'provider' | 'estimate' | 'none';

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  /** null = unavailable; the prompt is then priced entirely at the uncached rate */
  cachedTokens: number | null;
}

export interface TrialCost {
  usd: number | null;
  source: PriceSource;
  note: string;
  unit: typeof PRICING_UNIT_ASSUMPTION;
}

export function priceFor(
  model: string,
  provider: Record<string, ModelPrice> | null,
): { price: ModelPrice | null; source: PriceSource } {
  const stated = provider?.[model];
  if (
    stated &&
    stated.promptPerMTok !== null &&
    stated.completionPerMTok !== null
  )
    return { price: stated, source: 'provider' };
  if (model === ESTIMATED_PRICE.model)
    return { price: ESTIMATED_PRICE, source: 'estimate' };
  return { price: null, source: 'none' };
}

export function trialCost(
  tokens: TokenCounts,
  model: string,
  provider: Record<string, ModelPrice> | null,
): TrialCost {
  const { price, source } = priceFor(model, provider);
  if (
    !price ||
    price.promptPerMTok === null ||
    price.completionPerMTok === null
  )
    return {
      usd: null,
      source: 'none',
      note: 'no price available for this model',
      unit: PRICING_UNIT_ASSUMPTION,
    };
  const cached = tokens.cachedTokens ?? 0;
  const cachedRate = price.cachedPromptPerMTok ?? price.promptPerMTok;
  const uncachedPrompt = Math.max(0, tokens.promptTokens - cached);
  const usd =
    (uncachedPrompt * price.promptPerMTok +
      cached * cachedRate +
      tokens.completionTokens * price.completionPerMTok) /
    1_000_000;
  return {
    usd,
    source,
    note:
      (source === 'estimate'
        ? 'ESTIMATE from the LEAD_NOTES price table, not a bill. '
        : 'prices read from the provider /v1/models response. ') +
      (tokens.cachedTokens === null
        ? 'cached tokens unavailable: the whole prompt is priced uncached (upper bound).'
        : 'cached prompt tokens priced at the cached rate.'),
    unit: PRICING_UNIT_ASSUMPTION,
  };
}
