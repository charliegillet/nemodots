import { describe, expect, it } from 'vitest';
import {
  percentile,
  summarizeAttempts,
  type AttemptRow,
} from '../../../src/server/nemodots/telemetry/index.js';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

function row(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    modelCallId: 'call-1',
    n: 1,
    role: 'worker',
    modelRequested: 'nvidia/super',
    modelReturned: 'nvidia/super',
    outcome: 'recorded',
    startedAt: at(0),
    firstContentAt: at(400),
    promptTokens: 1000,
    completionTokens: 100,
    cachedTokens: null,
    errorClass: null,
    prefixDigest: digestA,
    ...over,
  };
}

describe('summarizeAttempts', () => {
  it('an empty store gives zeros, unavailable cached tokens and null TTFT (no division by zero)', () => {
    expect(summarizeAttempts([])).toEqual({
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
  });

  it('cached stays unavailable (null) when no attempt reported it, and 0 only when the provider said 0', () => {
    const none = summarizeAttempts([row(), row({ modelCallId: 'call-2' })]);
    expect(none.tokens.cached).toEqual({ available: false, total: null });
    expect(none.byModel[0].cachedTokens).toBeNull();
    const zero = summarizeAttempts([row({ cachedTokens: 0 })]);
    expect(zero.tokens.cached).toEqual({ available: true, total: 0 });
    expect(zero.byModel[0].cachedTokens).toBe(0);
  });

  it('mixed availability sums only what was reported', () => {
    const summary = summarizeAttempts([
      row({ modelCallId: 'a', cachedTokens: 600 }),
      row({ modelCallId: 'b', cachedTokens: null }),
      row({ modelCallId: 'c', cachedTokens: 400 }),
      row({
        modelCallId: 'd',
        modelReturned: 'nvidia/lightning',
        modelRequested: 'nvidia/lightning',
        cachedTokens: null,
      }),
    ]);
    expect(summary.tokens.cached).toEqual({ available: true, total: 1000 });
    expect(summary.byModel).toEqual([
      expect.objectContaining({
        model: 'nvidia/lightning',
        cachedTokens: null,
        calls: 1,
      }),
      expect.objectContaining({
        model: 'nvidia/super',
        cachedTokens: 1000,
        calls: 3,
      }),
    ]);
  });

  it('counts orphaned calls separately and excludes them from every other figure', () => {
    const summary = summarizeAttempts([
      row({ modelCallId: 'ok' }),
      row({
        modelCallId: 'lost-1',
        outcome: 'orphaned_fence',
        prefixDigest: null,
      }),
      row({
        modelCallId: 'lost-1',
        n: 2,
        outcome: 'orphaned_fence',
        prefixDigest: null,
      }),
      row({
        modelCallId: 'lost-2',
        outcome: 'orphaned_fence',
        prefixDigest: null,
      }),
    ]);
    expect(summary.calls).toBe(1);
    expect(summary.orphanedCalls).toBe(2);
    expect(summary.tokens.prompt).toBe(1000);
    expect(summary.retries).toBe(0);
  });

  it('counts retries as attempts beyond the first and errors excluding cancellations', () => {
    const summary = summarizeAttempts([
      row({
        n: 1,
        errorClass: 'rate_limited',
        promptTokens: null,
        completionTokens: null,
        firstContentAt: null,
      }),
      row({ n: 2 }),
      row({
        modelCallId: 'call-2',
        errorClass: 'cancelled',
        promptTokens: null,
        completionTokens: null,
        firstContentAt: null,
      }),
    ]);
    expect(summary.calls).toBe(2);
    expect(summary.retries).toBe(1);
    expect(summary.errors).toBe(1);
    // null token counts contribute nothing rather than being read as 0 of a real figure
    expect(summary.tokens.prompt).toBe(1000);
  });

  it('computes TTFT percentiles from successful attempts with content only', () => {
    const times = [100, 200, 300, 400, 1000];
    const summary = summarizeAttempts([
      ...times.map((ms, i) =>
        row({ modelCallId: `c${i}`, firstContentAt: at(ms) }),
      ),
      row({ modelCallId: 'no-content', firstContentAt: null }),
      row({
        modelCallId: 'failed',
        firstContentAt: at(50),
        errorClass: 'timeout',
      }),
    ]);
    expect(summary.ttftMs?.p50).toBe(300);
    expect(summary.ttftMs?.p95).toBeCloseTo(880, 6);
  });

  it('groups calls by prefix digest and breaks tokens down by model and role', () => {
    const summary = summarizeAttempts([
      row({ modelCallId: 'a', prefixDigest: digestA }),
      row({ modelCallId: 'b', prefixDigest: digestA }),
      row({
        modelCallId: 'c',
        prefixDigest: digestB,
        role: 'planner',
        modelReturned: null,
      }),
    ]);
    expect(summary.prefixGroups).toEqual([
      { prefixDigest: digestA, calls: 2 },
      { prefixDigest: digestB, calls: 1 },
    ]);
    expect(summary.byRole).toEqual([
      expect.objectContaining({ role: 'planner', calls: 1 }),
      expect.objectContaining({ role: 'worker', calls: 2, promptTokens: 2000 }),
    ]);
    // an unreturned model falls back to the requested name
    expect(summary.byModel).toEqual([
      expect.objectContaining({ model: 'nvidia/super', calls: 3 }),
    ]);
  });
});

describe('percentile', () => {
  it('interpolates, handles one value and refuses a bad fraction', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 1)).toBe(4);
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
  });
});
