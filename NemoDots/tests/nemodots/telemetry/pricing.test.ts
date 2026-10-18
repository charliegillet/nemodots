import { describe, expect, it } from 'vitest';
import {
  estimateCost,
  fetchModelPricing,
  parseModelPricing,
  type FetchLike,
  type ModelPrice,
} from '../../../src/server/nemodots/telemetry/pricing.js';
import { TelemetryError } from '../../../src/server/nemodots/telemetry/spans.js';

const SUPER: ModelPrice = {
  model: 'super',
  inputPerMillion: 0.3,
  outputPerMillion: 2.4,
  cachedPerMillion: 0.15,
};

describe('parseModelPricing', () => {
  it('reads string prices and leaves unparseable or missing ones null', () => {
    const prices = parseModelPricing({
      data: [
        {
          id: 'a',
          pricing: { input: '0.30', output: '2.40', cached_input: '0.15' },
        },
        { id: 'b', pricing: { input: '$0.05', output: 'free' } },
        { id: 'c' },
        { id: '' },
        { nope: true },
      ],
    });
    expect(prices).toEqual([
      {
        model: 'a',
        inputPerMillion: 0.3,
        outputPerMillion: 2.4,
        cachedPerMillion: 0.15,
      },
      {
        model: 'b',
        inputPerMillion: 0.05,
        outputPerMillion: null,
        cachedPerMillion: null,
      },
      {
        model: 'c',
        inputPerMillion: null,
        outputPerMillion: null,
        cachedPerMillion: null,
      },
    ]);
  });
  it('rejects a body without a data array', () => {
    expect(() => parseModelPricing({})).toThrow(TelemetryError);
  });
});

describe('parseModelPricing against the live Crusoe shape', () => {
  it('reads prompt, completion and input_cache_reads', () => {
    const prices = parseModelPricing({
      data: [
        {
          id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
          pricing: {
            prompt: '0.30',
            completion: '2.40',
            image: '0',
            request: '0',
            video: '0',
            input_cache_reads: '0.15',
          },
        },
      ],
    });
    expect(prices).toEqual([
      {
        model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
        inputPerMillion: 0.3,
        outputPerMillion: 2.4,
        cachedPerMillion: 0.15,
      },
    ]);
    const cost = estimateCost(
      {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cachedTokens: 500_000,
      },
      prices[0],
    );
    // 0.5M uncached prompt @0.30 + 0.5M cached @0.15 + 1M completion @2.40
    expect(cost.usd).toBeCloseTo(0.15 + 0.075 + 2.4, 10);
    expect(cost.unavailableReason).toBeNull();
  });
});

describe('estimateCost', () => {
  it('prices cached tokens at the cached rate', () => {
    const cost = estimateCost(
      {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        cachedTokens: 400_000,
      },
      SUPER,
    );
    // 600k*0.30 + 400k*0.15 + 500k*2.40 = 0.18 + 0.06 + 1.2
    expect(cost.usd).toBeCloseTo(1.44, 10);
    expect(cost.cachedAssumedUncached).toBe(false);
  });
  it('prices unavailable cache data as uncached and says so', () => {
    const cost = estimateCost(
      { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: null },
      SUPER,
    );
    expect(cost.usd).toBeCloseTo(0.3, 10);
    expect(cost.cachedAssumedUncached).toBe(true);
  });
  it('flags partially reported cache data', () => {
    const cost = estimateCost(
      {
        promptTokens: 100,
        completionTokens: 0,
        cachedTokens: 40,
        cachedUnreportedAttempts: 1,
      },
      SUPER,
    );
    expect(cost.cachedAssumedUncached).toBe(true);
  });
  it('is null, never zero, when a needed price is missing', () => {
    const usage = { promptTokens: 10, completionTokens: 10, cachedTokens: 5 };
    expect(estimateCost(usage, undefined)).toMatchObject({
      usd: null,
      unavailableReason: 'no_price',
    });
    expect(
      estimateCost(usage, { ...SUPER, inputPerMillion: null }),
    ).toMatchObject({ usd: null, unavailableReason: 'no_input_price' });
    expect(
      estimateCost(usage, { ...SUPER, outputPerMillion: null }),
    ).toMatchObject({ usd: null, unavailableReason: 'no_output_price' });
    expect(
      estimateCost(usage, { ...SUPER, cachedPerMillion: null }),
    ).toMatchObject({ usd: null, unavailableReason: 'no_cached_price' });
  });
  it('costs nothing for no usage without dividing by anything', () => {
    expect(
      estimateCost(
        { promptTokens: 0, completionTokens: 0, cachedTokens: null },
        SUPER,
      ).usd,
    ).toBe(0);
  });
});

describe('fetchModelPricing', () => {
  const target = {
    baseUrl: 'https://example.invalid/v1/',
    apiKey: 'test-key-not-real',
    timeoutMs: 1000,
  };
  it('parses a successful response and calls /models once', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'm', pricing: { input: '1', output: '2' } }],
        }),
      };
    };
    const prices = await fetchModelPricing(target, fetchImpl);
    expect(calls).toEqual(['https://example.invalid/v1/models']);
    expect(prices[0]).toMatchObject({
      model: 'm',
      inputPerMillion: 1,
      outputPerMillion: 2,
    });
  });
  it('fails without echoing the key or the body', async () => {
    const failing: FetchLike = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    await expect(fetchModelPricing(target, failing)).rejects.toThrow(
      /HTTP 503/,
    );
    const down: FetchLike = async () => {
      throw new Error('boom test-key-not-real');
    };
    const error = await fetchModelPricing(target, down).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('test-key-not-real');
  });
});
