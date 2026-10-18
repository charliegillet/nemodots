import { describe, expect, it } from 'vitest';
import { createBudget } from '../../../src/server/nemodots/team/index.js';
import { calls, claimed, rig, runHandler, text } from './harness.js';

const usage = (
  promptTokens: number | null,
  completionTokens: number | null,
  cachedTokens: number | null = null,
) => ({ promptTokens, completionTokens, cachedTokens, reasoningTokens: null });

describe('token budget', () => {
  it('counts input plus output tokens', () => {
    const budget = createBudget({ maxIterations: 12, maxTokens: 1000 });
    budget.spend(usage(600, 100));
    expect(budget.spentTokens()).toBe(700);
    expect(budget.tokensExhausted()).toBe(false);
    budget.spend(usage(250, 50));
    expect(budget.spentTokens()).toBe(1000);
    expect(budget.tokensExhausted()).toBe(true);
  });

  it('keeps cached tokens separate and null distinct from 0', () => {
    const none = createBudget({ maxIterations: 12, maxTokens: 10_000 });
    none.spend(usage(100, 10, null));
    expect(none.report()).toMatchObject({
      cachedTokens: null,
      promptTokens: 100,
    });
    const zero = createBudget({ maxIterations: 12, maxTokens: 10_000 });
    zero.spend(usage(100, 10, 0));
    expect(zero.report().cachedTokens).toBe(0);
    const some = createBudget({ maxIterations: 12, maxTokens: 10_000 });
    some.spend(usage(100, 10, 40));
    some.spend(usage(100, 10, null));
    some.spend(usage(100, 10, 5));
    expect(some.report().cachedTokens).toBe(45);
    // cached tokens are part of the prompt count, never subtracted from the budget
    expect(some.spentTokens()).toBe(330);
  });

  it('unavailable usage is reported, not silently treated as zero', () => {
    const budget = createBudget({ maxIterations: 12, maxTokens: 10_000 });
    budget.spend(usage(null, null));
    budget.spend(null);
    budget.spend(usage(10, 5));
    expect(budget.report()).toMatchObject({
      callsWithUnavailableUsage: 2,
      promptTokens: 10,
    });
  });

  it('input tokens alone exhaust the budget before the next call; usage is reported on exit', async () => {
    const r = rig([
      calls({ id: 'l', name: 'list_runbooks', args: {} }),
      text('never reached'),
    ]);
    // the scripted call reports 900 input (300 cached) and 5 output tokens
    const steps = r.inference['steps'] as ((req: never) => any)[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const original = steps[0];
    steps[0] = (req) => {
      const base = original(req);
      return {
        ...base,
        usage: usage(900, 5, 300),
        attempts: [{ ...base.attempts[0], usage: usage(900, 5, 300) }],
      };
    };
    expect(
      await runHandler(r, claimed('cache_specialist', { maxTokens: 800 })),
    ).toEqual({
      type: 'abort',
      reason: 'budget_exhausted',
    });
    expect(r.inference.requests).toHaveLength(1);
    const report = r.events.find(
      (e) => (e as { kind: string }).kind === 'attempt_usage',
    );
    expect(report).toMatchObject({
      kind: 'attempt_usage',
      role: 'cache_specialist',
      spentTokens: 905,
      promptTokens: 900,
      completionTokens: 5,
      cachedTokens: 300,
      budgetTokens: 800,
    });
  });
});
