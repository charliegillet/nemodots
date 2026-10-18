import { describe, expect, it } from 'vitest';
import {
  PRICING_UNIT_ASSUMPTION,
  assembleComparison,
  costOf,
  fetchPricing,
  parsePricing,
  splitTiming,
  summarizeAttempts,
  summaryCost,
  type AttemptRow,
  type MissionTimingMark,
} from '../../../src/server/nemodots/telemetry/index.js';

const body = {
  data: [
    {
      id: 'm/super',
      pricing: {
        prompt: '0.30',
        completion: '2.40',
        input_cache_reads: '0.15',
        image: '0',
      },
    },
    { id: 'm/nopricing' },
    { id: 'm/partial', pricing: { prompt: '0.10', completion: 'n/a' } },
    { id: 'm/negative', pricing: { prompt: '-1', completion: '1' } },
  ],
};

describe('pricing', () => {
  it('parses what the provider states and leaves the rest null', () => {
    const prices = parsePricing(body)!;
    expect(prices['m/super']).toEqual({
      model: 'm/super',
      promptPerMTok: 0.3,
      completionPerMTok: 2.4,
      cachedPromptPerMTok: 0.15,
    });
    expect(prices['m/nopricing']).toBeUndefined();
    expect(prices['m/partial']).toMatchObject({
      promptPerMTok: 0.1,
      completionPerMTok: null,
    });
    expect(prices['m/negative'].promptPerMTok).toBeNull();
    expect(parsePricing({})).toBeNull();
    expect(parsePricing(null)).toBeNull();
  });

  it('fetchPricing is null with a reason when the endpoint fails, and never defaults a host', async () => {
    const ok = await fetchPricing({
      baseUrl: 'https://crusoe.example/v1/',
      apiKey: 'k-123456',
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://crusoe.example/v1/models');
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer k-123456',
        );
        return Response.json(body);
      },
    });
    expect(ok.prices?.['m/super']).toBeDefined();
    expect(ok.unavailableReason).toBeNull();
    expect(ok.unit).toBe(PRICING_UNIT_ASSUMPTION);
    for (const failing of [
      async () => new Response('no', { status: 500 }),
      async () => new Response('{"nope":1}'),
      async () => {
        throw new Error('down');
      },
    ]) {
      const result = await fetchPricing({
        baseUrl: 'https://crusoe.example/v1',
        apiKey: 'k-123456',
        fetch: failing as typeof fetch,
      });
      expect(result.prices).toBeNull();
      expect(result.unavailableReason).toEqual(expect.any(String));
    }
    expect(
      (await fetchPricing({ baseUrl: 'not a url', apiKey: 'k' })).prices,
    ).toBeNull();
  });

  it('costOf is exact when known, takes the cached discount only when cached tokens are known, and is null otherwise', () => {
    const price = parsePricing(body)!['m/super'];
    // 1M prompt at 0.30 + 1M completion at 2.40
    expect(
      costOf(price, {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cachedTokens: null,
      }),
    ).toEqual({ usd: 2.7, cachedDiscountApplied: false, reason: null });
    const discounted = costOf(price, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedTokens: 500_000,
    });
    expect(discounted.usd).toBeCloseTo(0.5 * 0.3 + 0.5 * 0.15, 10);
    expect(discounted.cachedDiscountApplied).toBe(true);
    expect(
      costOf(undefined, {
        promptTokens: 1,
        completionTokens: 1,
        cachedTokens: 0,
      }).usd,
    ).toBeNull();
    expect(
      costOf(parsePricing(body)!['m/partial'], {
        promptTokens: 1,
        completionTokens: 1,
        cachedTokens: 0,
      }).usd,
    ).toBeNull();
  });
});

const attempt = (over: Partial<AttemptRow>): AttemptRow => ({
  modelCallId: 'c',
  n: 1,
  role: 'worker',
  modelRequested: 'm/super',
  modelReturned: 'm/super',
  outcome: 'recorded',
  startedAt: '2026-10-18T10:00:00.000Z',
  firstContentAt: '2026-10-18T10:00:00.500Z',
  promptTokens: 1_000_000,
  completionTokens: 1_000_000,
  cachedTokens: null,
  errorClass: null,
  prefixDigest: 'a'.repeat(64),
  ...over,
});

describe('comparison', () => {
  const prices = parsePricing(body);
  const broad = summarizeAttempts([
    attempt({ modelCallId: '1' }),
    attempt({ modelCallId: '2' }),
  ]);
  const selective = summarizeAttempts([attempt({ modelCallId: '1' })]);

  it('derives differences only from known numbers and lists everything unavailable', () => {
    const report = assembleComparison(
      [
        {
          arm: 'broad',
          summary: broad,
          prices,
          timing: {
            recoveryMs: 9000,
            completionMs: 20000,
            detectionToRecoveryStartMs: 100,
          },
        },
        {
          arm: 'selective',
          summary: selective,
          prices,
          timing: {
            recoveryMs: null,
            completionMs: 12000,
            detectionToRecoveryStartMs: null,
          },
        },
      ],
      'broad',
    );
    expect(report.pricingUnit).toBe(PRICING_UNIT_ASSUMPTION);
    expect(report.rows[0].costUsd).toBeCloseTo(5.4, 10);
    expect(report.rows[1].costUsd).toBeCloseTo(2.7, 10);
    expect(report.deltas).toHaveLength(1);
    expect(report.deltas[0]).toMatchObject({
      arm: 'selective',
      calls: -1,
      promptTokens: -1_000_000,
      cachedTokens: null, // neither side reported cached tokens
      recoveryMs: null, // one side has no recovery mark
      completionMs: -8000,
    });
    expect(report.deltas[0].costUsd).toBeCloseTo(-2.7, 10);
    expect(report.unavailable).toEqual(
      expect.arrayContaining([
        'broad: cached tokens unavailable',
        'selective: recovery time unavailable',
      ]),
    );
  });

  it('without pricing every cost and cost delta is null, not zero', () => {
    const report = assembleComparison(
      [
        { arm: 'a', summary: broad },
        { arm: 'b', summary: selective },
      ],
      'a',
    );
    expect(report.rows.map((r) => r.costUsd)).toEqual([null, null]);
    expect(report.deltas[0].costUsd).toBeNull();
    expect(summaryCost(broad, null).usd).toBeNull();
  });

  it('refuses an unknown baseline and duplicate arms', () => {
    expect(() =>
      assembleComparison([{ arm: 'a', summary: broad }], 'zzz'),
    ).toThrow(RangeError);
    expect(() =>
      assembleComparison(
        [
          { arm: 'a', summary: broad },
          { arm: 'a', summary: broad },
        ],
        'a',
      ),
    ).toThrow(RangeError);
  });
});

describe('splitTiming', () => {
  const mark = (
    phase: MissionTimingMark['phase'],
    at: string,
  ): MissionTimingMark => ({
    missionId: 'm',
    phase,
    n: 1,
    at,
  });
  it('measures between marks and gives null for a missing mark', () => {
    expect(
      splitTiming([
        mark('started', '2026-10-18T10:00:00.000Z'),
        mark('conflict_detected', '2026-10-18T10:00:05.000Z'),
        mark('recovery_started', '2026-10-18T10:00:06.000Z'),
        mark('recovered', '2026-10-18T10:00:16.000Z'),
        mark('completed', '2026-10-18T10:00:20.000Z'),
      ]),
    ).toEqual({
      detectionToRecoveryStartMs: 1000,
      recoveryMs: 10000,
      completionMs: 20000,
    });
    expect(splitTiming([mark('started', '2026-10-18T10:00:00.000Z')])).toEqual({
      detectionToRecoveryStartMs: null,
      recoveryMs: null,
      completionMs: null,
    });
  });
});
