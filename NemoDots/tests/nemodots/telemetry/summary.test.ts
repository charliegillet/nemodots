// Pure aggregation: no database. Every expected number is hand-computed from
// the attempts listed in the test.
import { describe, expect, it } from 'vitest';
import {
  percentile,
  summarizeAttempts,
  type AttemptSample,
} from '../../../src/server/nemodots/telemetry/summary.js';

const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const LIGHT = 'nvidia/Nemotron-3.5-Lightning-30B-A3B';

let seq = 0;
function sample(patch: Partial<AttemptSample> = {}): AttemptSample {
  seq += 1;
  return {
    modelCallId: `call-${seq}`,
    n: 1,
    role: 'worker',
    modelRequested: SUPER,
    modelReturned: SUPER,
    startedAtMs: 1_000,
    firstContentAtMs: null,
    promptTokens: 100,
    completionTokens: 10,
    cachedTokens: null,
    errorClass: null,
    outcome: 'recorded',
    ...patch,
  };
}

describe('percentile', () => {
  it('is null for an empty list and never divides by zero', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });
  it('uses nearest rank', () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
  });
  it('rejects out-of-range percentiles', () => {
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe('summarizeAttempts', () => {
  it('has no calls, null ttft and zero totals for an empty input', () => {
    const { summary, detail } = summarizeAttempts([], []);
    expect(summary).toEqual({
      calls: 0,
      orphanedCalls: 0,
      tokens: {
        prompt: 0,
        completion: 0,
        cached: { available: false, total: null },
      },
      byModel: [],
      byRole: [],
      retries: 0,
      errors: 0,
      ttftMs: null,
      prefixGroups: [],
    });
    expect(detail.cached).toEqual({
      attemptsWithUsage: 0,
      reported: 0,
      unavailable: 0,
    });
  });

  it('keeps cached tokens null with available:false when the provider never reported them', () => {
    const { summary, detail } = summarizeAttempts(
      [
        sample({ modelRequested: LIGHT, modelReturned: LIGHT }),
        sample({ modelRequested: LIGHT, modelReturned: LIGHT }),
      ],
      [],
    );
    expect(summary.tokens.cached).toEqual({ available: false, total: null });
    expect(summary.byModel[0].cachedTokens).toBeNull();
    expect(detail.cached.unavailable).toBe(2);
    expect(detail.cached.reported).toBe(0);
  });

  it('treats a reported 0 as available and distinguishes it from unavailable', () => {
    const { summary } = summarizeAttempts([sample({ cachedTokens: 0 })], []);
    expect(summary.tokens.cached).toEqual({ available: true, total: 0 });
  });

  it('reports mixed availability separately per model and in the detail', () => {
    const { summary, detail } = summarizeAttempts(
      [
        sample({ cachedTokens: 2304, promptTokens: 2330 }),
        sample({ cachedTokens: 0, promptTokens: 500 }),
        sample({
          modelRequested: LIGHT,
          modelReturned: LIGHT,
          cachedTokens: null,
          promptTokens: 400,
        }),
      ],
      [],
    );
    expect(summary.tokens.cached).toEqual({ available: true, total: 2304 });
    const bySuper = summary.byModel.find((m) => m.model === SUPER);
    const byLight = summary.byModel.find((m) => m.model === LIGHT);
    expect(bySuper?.cachedTokens).toBe(2304);
    expect(byLight?.cachedTokens).toBeNull();
    expect(detail.cached).toEqual({
      attemptsWithUsage: 3,
      reported: 2,
      unavailable: 1,
    });
  });

  it('does not count cancelled attempts (null usage) as unavailable cache data', () => {
    const { summary, detail } = summarizeAttempts(
      [
        sample({
          promptTokens: null,
          completionTokens: null,
          cachedTokens: null,
          errorClass: 'cancelled',
        }),
        sample({ cachedTokens: 40 }),
      ],
      [],
    );
    expect(detail.cached.unavailable).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.tokens.prompt).toBe(100);
    expect(summary.tokens.cached).toEqual({ available: true, total: 40 });
  });

  it('counts orphaned calls separately from fenced calls but bills their tokens', () => {
    const orphan = sample({
      outcome: 'orphaned_fence',
      promptTokens: 700,
      completionTokens: 70,
      cachedTokens: 600,
    });
    const { summary, detail } = summarizeAttempts(
      [sample(), sample(), orphan],
      [],
    );
    expect(summary.calls).toBe(2);
    expect(summary.orphanedCalls).toBe(1);
    expect(summary.tokens.prompt).toBe(100 + 100 + 700);
    expect(summary.tokens.completion).toBe(10 + 10 + 70);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0].calls).toBe(2);
    expect(summary.byModel[0].promptTokens).toBe(900);
    expect(detail.orphaned).toEqual({
      calls: 1,
      attempts: 1,
      promptTokens: 700,
      completionTokens: 70,
      cachedTokens: 600,
    });
  });

  it('counts a call once however many attempts it has, and retries as attempts beyond the first', () => {
    const retried = [
      sample({
        modelCallId: 'c',
        n: 1,
        errorClass: 'rate_limited',
        promptTokens: null,
        completionTokens: null,
      }),
      sample({
        modelCallId: 'c',
        n: 2,
        errorClass: 'provider_unavailable',
        promptTokens: null,
        completionTokens: null,
      }),
      sample({ modelCallId: 'c', n: 3 }),
    ];
    const { summary } = summarizeAttempts(retried, []);
    expect(summary.calls).toBe(1);
    expect(summary.retries).toBe(2);
    expect(summary.errors).toBe(2);
    expect(summary.tokens.prompt).toBe(100);
  });

  it('groups by role and by returned model, falling back to the requested model', () => {
    const { summary } = summarizeAttempts(
      [
        sample({ role: 'planner' }),
        sample({ role: 'worker' }),
        sample({ role: 'worker' }),
        sample({
          role: 'repair',
          modelReturned: null,
          modelRequested: LIGHT,
          promptTokens: 30,
        }),
      ],
      [],
    );
    expect(summary.byRole.map((r) => [r.role, r.calls])).toEqual([
      ['planner', 1],
      ['repair', 1],
      ['worker', 2],
    ]);
    expect(
      summary.byModel.map((m) => [m.model, m.calls, m.promptTokens]),
    ).toEqual([
      [SUPER, 3, 300],
      [LIGHT, 1, 30],
    ]);
  });

  it('computes ttft percentiles only from attempts with a first content token', () => {
    const attempts = [10, 20, 30, 40].map((ms) =>
      sample({ startedAtMs: 5_000, firstContentAtMs: 5_000 + ms }),
    );
    attempts.push(sample()); // no first content: ignored
    attempts.push(sample({ startedAtMs: 9_000, firstContentAtMs: 8_000 })); // clock skew: ignored
    const { summary } = summarizeAttempts(attempts, []);
    expect(summary.ttftMs).toEqual({ p50: 20, p95: 40 });
  });

  it('groups fenced calls by prefix digest, largest first', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const { summary } = summarizeAttempts([sample()], [b, a, b, b, a]);
    expect(summary.prefixGroups).toEqual([
      { prefixDigest: b, calls: 3 },
      { prefixDigest: a, calls: 2 },
    ]);
  });
});
