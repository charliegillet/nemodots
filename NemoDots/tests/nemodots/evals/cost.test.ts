import { describe, expect, it } from 'vitest';
import {
  ESTIMATED_PRICE,
  priceFor,
  trialCost,
} from '../../../src/server/nemodots/evals/cost.js';

const MODEL = ESTIMATED_PRICE.model;

describe('trial cost', () => {
  it('uses the labelled estimate when the provider states no price', () => {
    const cost = trialCost(
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 },
      MODEL,
      null,
    );
    expect(cost.source).toBe('estimate');
    expect(cost.usd).toBeCloseTo(0.3, 6);
    expect(cost.note).toContain('ESTIMATE');
  });

  it('prices cached prompt tokens at the cached rate', () => {
    const cost = trialCost(
      {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cachedTokens: 400_000,
      },
      MODEL,
      null,
    );
    // 0.6M * 0.30 + 0.4M * 0.15 + 1M * 2.40
    expect(cost.usd).toBeCloseTo(0.18 + 0.06 + 2.4, 6);
  });

  it('unavailable cached tokens price the whole prompt uncached and say so', () => {
    const cost = trialCost(
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: null },
      MODEL,
      null,
    );
    expect(cost.usd).toBeCloseTo(0.3, 6);
    expect(cost.note).toContain('unavailable');
  });

  it('provider prices win over the estimate and are labelled so', () => {
    const provider = {
      [MODEL]: {
        model: MODEL,
        promptPerMTok: 1,
        completionPerMTok: 2,
        cachedPromptPerMTok: null,
      },
    };
    expect(priceFor(MODEL, provider).source).toBe('provider');
    const cost = trialCost(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
      MODEL,
      provider,
    );
    expect(cost.usd).toBeCloseTo(3, 6);
    expect(cost.source).toBe('provider');
  });

  it('an unknown model has no price and no invented cost', () => {
    const cost = trialCost(
      { promptTokens: 10, completionTokens: 10, cachedTokens: 0 },
      'other/model',
      null,
    );
    expect(cost).toMatchObject({ usd: null, source: 'none' });
  });
});
