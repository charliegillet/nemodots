import { describe, expect, it } from 'vitest';
import {
  seededRandom,
  shuffled,
  summarize,
  wilson95,
} from '../../../src/server/nemodots/evals/stats.js';

describe('wilson95', () => {
  it('matches reference values', () => {
    const near = (value: number | null, expected: number) =>
      expect(Math.abs((value as number) - expected)).toBeLessThan(0.0005);
    const zero = wilson95(0, 10);
    near(zero.low, 0);
    near(zero.high, 0.2775);
    const half = wilson95(5, 10);
    near(half.low, 0.2366);
    near(half.high, 0.7634);
    const all = wilson95(10, 10);
    near(all.low, 0.7225);
    near(all.high, 1);
  });

  it('has no rate without trials and rejects impossible counts', () => {
    expect(wilson95(0, 0)).toMatchObject({ rate: null, low: null, high: null });
    expect(() => wilson95(3, 2)).toThrow(RangeError);
    expect(() => wilson95(-1, 2)).toThrow(RangeError);
    expect(() => wilson95(1.5, 2)).toThrow(RangeError);
  });

  it('small cohorts give wide intervals (no false precision)', () => {
    const three = wilson95(3, 3);
    expect((three.low as number) < 0.5).toBe(true);
  });
});

describe('summarize', () => {
  it('counts unavailable values out instead of treating them as 0', () => {
    expect(summarize([1, null, 3])).toMatchObject({
      n: 2,
      mean: 2,
      median: 2,
      unavailable: 1,
    });
    expect(summarize([null, null])).toMatchObject({
      n: 0,
      mean: null,
      unavailable: 2,
    });
    expect(summarize([4, 1, 2, 3])).toMatchObject({
      median: 2.5,
      min: 1,
      max: 4,
    });
  });
});

describe('seeded shuffling', () => {
  it('is deterministic and a permutation', () => {
    const a = shuffled([1, 2, 3, 4, 5, 6], seededRandom(7));
    const b = shuffled([1, 2, 3, 4, 5, 6], seededRandom(7));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(shuffled([1, 2, 3, 4, 5, 6], seededRandom(8))).not.toEqual(a);
  });
});
