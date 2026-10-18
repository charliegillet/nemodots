import { describe, expect, it } from 'vitest';
import {
  loadScenario,
  resolveScenario,
} from '../../../src/server/nemodots/sandbox/manifest.js';
import {
  MATCHED_CELLS,
  SUITES,
  cohortBalance,
  planCohort,
  selectCells,
} from '../../../src/server/nemodots/evals/suites.js';

describe('suites', () => {
  it('matched contains the controls, a repairable fault, diverging_edges and the dependent/second-change classes', () => {
    const scenarios = SUITES.matched.scenarios;
    for (const id of [
      'healthy',
      'benign_change',
      'cache_schema_mismatch',
      'diverging_edges',
      'dependent_change_after_proposal',
      'second_change_during_repair',
      'conflicting_observations',
    ])
      expect(scenarios).toContain(id);
    // every listed scenario exists in the development set
    for (const id of scenarios) expect(loadScenario(id).id).toBe(id);
  });

  it('matched cells are the strategy table plus the 2x2 and nothing else', () => {
    expect(MATCHED_CELLS.map((c) => `${c.strategy}/${c.layout}`)).toEqual([
      'broad-restart/cache_aware',
      'dag-restart/cache_aware',
      'selective/cache_aware',
      'broad-restart/ordinary',
      'selective/ordinary',
    ]);
  });

  it('smoke is a single trial of a single arm', () => {
    const plan = planCohort({ suite: SUITES.smoke, trials: 1, seed: 1 });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      strategy: 'selective',
      layout: 'cache_aware',
    });
  });
});

describe('cohort planning', () => {
  const plan = (
    trials: number,
    extra: Partial<Parameters<typeof planCohort>[0]> = {},
  ) =>
    planCohort({
      suite: SUITES.matched,
      trials,
      seed: 10,
      cohortId: 'c',
      ...extra,
    });

  it('is deterministic for a seed and unique per trial', () => {
    expect(plan(3)).toEqual(plan(3));
    const ids = plan(3).map((t) => t.trialId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan(3).map((t) => t.runIndex)).toEqual(plan(3).map((_, i) => i));
  });

  it('every arm of a block sees the same fault schedule', () => {
    const specs = plan(2, { scenarios: ['diverging_edges'] });
    const bySeed = new Map<number, string[]>();
    for (const spec of specs) {
      const resolved = JSON.stringify(
        resolveScenario(loadScenario(spec.scenarioId), spec.seed),
      );
      bySeed.set(spec.seed, [...(bySeed.get(spec.seed) ?? []), resolved]);
    }
    for (const [, schedules] of bySeed) {
      expect(schedules).toHaveLength(MATCHED_CELLS.length);
      expect(new Set(schedules).size).toBe(1);
    }
    expect(bySeed.size).toBe(2); // different replicates use different held-out values
  });

  it('Latin-square rotation: with as many replicates as cells every arm takes every position equally often', () => {
    const specs = plan(5, { scenarios: ['healthy'] });
    const balance = cohortBalance(specs);
    expect(balance.balanced).toBe(true);
    expect(balance.maxPositionSpread).toBe(0);
    for (const row of Object.values(balance.positionCounts))
      expect(row).toEqual([1, 1, 1, 1, 1]);
  });

  it('rotation also runs across scenarios: one replicate over a multiple of the cell count is balanced', () => {
    const five = [
      'healthy',
      'benign_change',
      'cache_schema_mismatch',
      'diverging_edges',
      'second_change_during_repair',
    ];
    const balance = cohortBalance(plan(1, { scenarios: five }));
    expect(balance.balanced).toBe(true);
    expect(
      plan(1, { scenarios: five })
        .filter((t) => t.blockIndex === 0)
        .map((t) => `${t.strategy}/${t.layout}`)
        .sort(),
    ).toEqual(MATCHED_CELLS.map((c) => `${c.strategy}/${c.layout}`).sort());
  });

  it('with fewer replicates than cells the imbalance is reported, not hidden', () => {
    const balance = cohortBalance(plan(3, { scenarios: ['healthy'] }));
    expect(balance.balanced).toBe(false);
    expect(balance.maxPositionSpread).toBeGreaterThan(0);
  });

  it('no arm is always first', () => {
    const first = plan(5, { scenarios: ['healthy'] }).filter(
      (t) => t.blockIndex === 0,
    );
    expect(new Set(first.map((t) => `${t.strategy}/${t.layout}`)).size).toBe(5);
  });

  it('filters keep the suite definition and reject impossible requests', () => {
    expect(
      selectCells(SUITES.matched, ['selective'], undefined).map(
        (c) => c.layout,
      ),
    ).toEqual(['cache_aware', 'ordinary']);
    expect(() => selectCells(SUITES.smoke, ['broad-restart'])).toThrow(
      /no cell/,
    );
    expect(() => selectCells(SUITES.matched, ['nope' as never])).toThrow(
      RangeError,
    );
    expect(() =>
      planCohort({ suite: SUITES.smoke, trials: 0, seed: 1 }),
    ).toThrow(RangeError);
  });
});
