// Small statistics for the evaluation report. Intervals are Wilson 95% and are
// shown for every rate; nothing here tests significance, and no function turns
// a difference into a claim (EVALUATION.md states what a cohort can support).

export interface RateWithInterval {
  successes: number;
  trials: number;
  /** null when there are no trials */
  rate: number | null;
  /** Wilson 95% interval, null when there are no trials */
  low: number | null;
  high: number | null;
}

const Z95 = 1.959963984540054;

export function wilson95(successes: number, trials: number): RateWithInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials))
    throw new RangeError('counts must be integers');
  if (successes < 0 || trials < 0 || successes > trials)
    throw new RangeError('need 0 <= successes <= trials');
  if (trials === 0)
    return { successes, trials, rate: null, low: null, high: null };
  const p = successes / trials;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half =
    (Z95 * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denominator;
  return {
    successes,
    trials,
    rate: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

export interface Summary {
  n: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

/** Summary of the known values; null entries are unavailable and are counted out, never as 0. */
export function summarize(values: readonly (number | null)[]): Summary & {
  unavailable: number;
} {
  const known = values
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const unavailable = values.length - known.length;
  if (known.length === 0)
    return {
      n: 0,
      mean: null,
      median: null,
      min: null,
      max: null,
      unavailable,
    };
  const mid = Math.floor(known.length / 2);
  return {
    n: known.length,
    mean: known.reduce((sum, v) => sum + v, 0) / known.length,
    median:
      known.length % 2 === 1 ? known[mid] : (known[mid - 1] + known[mid]) / 2,
    min: known[0],
    max: known[known.length - 1],
    unavailable,
  };
}

/** Deterministic PRNG (mulberry32) so cohort plans reproduce from a seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
