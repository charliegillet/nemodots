// Suites and cohort planning. A cohort is a list of trials in a run order:
//   - every arm of a block (same scenario, same seed) sees the same fault
//     schedule, because the manifest is resolved from (id, seed) alone;
//   - arms are counterbalanced with a cyclic Latin-square rotation across the
//     scenarios and replicates, so no arm is always first. The rotation is
//     exactly balanced only when (scenarios x replicates) is a multiple of the
//     number of cells; otherwise the residual imbalance is reported
//     (cohortBalance), not hidden;
//   - providers cache prefixes for several minutes (about 4 min observed), so
//     arms that share a prefix contaminate each other. Counterbalancing spreads
//     that effect across arms; it does not remove it. EVALUATION.md states it.
import { randomUUID } from 'node:crypto';
import {
  LAYOUT_NAMES,
  STRATEGIES,
  type LayoutName,
  type StrategyName,
  type TrialSpec,
} from './types.js';
import { seededRandom, shuffled } from './stats.js';

export interface Cell {
  strategy: StrategyName;
  layout: LayoutName;
}

export interface SuiteDefinition {
  name: string;
  description: string;
  scenarios: readonly string[];
  /** The arms: a strategy/layout pair each. */
  cells: readonly Cell[];
  defaultTrials: number;
}

/** Strategy table (three strategies, cache-aware) plus the 2x2 (broad vs selective x layout). */
export const MATCHED_CELLS: readonly Cell[] = Object.freeze([
  { strategy: 'broad-restart', layout: 'cache_aware' },
  { strategy: 'dag-restart', layout: 'cache_aware' },
  { strategy: 'selective', layout: 'cache_aware' },
  { strategy: 'broad-restart', layout: 'ordinary' },
  { strategy: 'selective', layout: 'ordinary' },
]);

export const SUITES: Readonly<Record<string, SuiteDefinition>> = Object.freeze({
  smoke: {
    name: 'smoke',
    description:
      'one repairable fault, one arm: proves the harness runs end to end (not a comparison)',
    scenarios: ['cache_schema_mismatch'],
    cells: [{ strategy: 'selective', layout: 'cache_aware' }],
    defaultTrials: 1,
  },
  matched: {
    name: 'matched',
    description:
      'controls, repairable faults and the scenarios where arms can differ (diverging_edges, dependent and second changes), every arm on identical fault schedules',
    scenarios: [
      'healthy',
      'benign_change',
      'cache_schema_mismatch',
      'conflicting_observations',
      'dependent_change_after_proposal',
      'second_change_during_repair',
      'diverging_edges',
    ],
    cells: MATCHED_CELLS,
    defaultTrials: 3,
  },
});

export interface PlanOptions {
  suite: SuiteDefinition;
  trials: number;
  /** Base seed; replicate r uses baseSeed + r so held-out variations differ per replicate. */
  seed: number;
  scenarios?: readonly string[];
  strategies?: readonly StrategyName[];
  layouts?: readonly LayoutName[];
  /** Scenario versions, for the record. */
  versionOf?: (scenarioId: string) => number;
  cohortId?: string;
}

export function selectCells(
  suite: SuiteDefinition,
  strategies?: readonly StrategyName[],
  layouts?: readonly LayoutName[],
): Cell[] {
  const cells = suite.cells.filter(
    (cell) =>
      (!strategies || strategies.includes(cell.strategy)) &&
      (!layouts || layouts.includes(cell.layout)),
  );
  // a requested combination the suite does not define is a user error, not a silent drop
  for (const strategy of strategies ?? [])
    if (!(STRATEGIES as readonly string[]).includes(strategy))
      throw new RangeError(`unknown strategy ${strategy}`);
  for (const layout of layouts ?? [])
    if (!(LAYOUT_NAMES as readonly string[]).includes(layout))
      throw new RangeError(`unknown layout ${layout}`);
  if (cells.length === 0)
    throw new RangeError(
      `no cell of suite ${suite.name} matches strategies=${(strategies ?? ['*']).join(',')} layouts=${(layouts ?? ['*']).join(',')}`,
    );
  return cells;
}

export function planCohort(options: PlanOptions): TrialSpec[] {
  if (!Number.isInteger(options.trials) || options.trials < 1)
    throw new RangeError('trials must be a positive integer');
  const cells = selectCells(options.suite, options.strategies, options.layouts);
  const scenarios = options.scenarios ?? options.suite.scenarios;
  const cohortId = options.cohortId ?? randomUUID();
  const random = seededRandom(options.seed);
  const specs: TrialSpec[] = [];
  let runIndex = 0;
  // scenario order is shuffled once (seeded) so a scenario is not always early
  for (const [scenarioIndex, scenarioId] of shuffled(
    scenarios,
    random,
  ).entries()) {
    for (let replicate = 0; replicate < options.trials; replicate += 1) {
      const seed = options.seed + replicate;
      // cyclic Latin-square rotation of the cell order for this replicate
      // (rotating by scenario as well keeps a one-replicate cohort balanced too)
      const offset = (scenarioIndex + replicate) % cells.length;
      const order = [...cells.slice(offset), ...cells.slice(0, offset)];
      order.forEach((cell, blockIndex) => {
        specs.push({
          trialId: `${cohortId}:${scenarioId}:${seed}:${cell.strategy}:${cell.layout}`,
          cohortId,
          scenarioId,
          scenarioVersion: options.versionOf?.(scenarioId) ?? 1,
          seed,
          strategy: cell.strategy,
          layout: cell.layout,
          blockIndex,
          runIndex: runIndex++,
        });
      });
    }
  }
  return specs;
}

/** How evenly each cell occupies each block position (for the report). */
export function cohortBalance(specs: readonly TrialSpec[]) {
  const positions = new Map<string, number[]>();
  for (const spec of specs) {
    const key = `${spec.strategy}/${spec.layout}`;
    const row = positions.get(key) ?? [];
    row[spec.blockIndex] = (row[spec.blockIndex] ?? 0) + 1;
    positions.set(key, row);
  }
  const width = Math.max(0, ...[...positions.values()].map((r) => r.length));
  const table = Object.fromEntries(
    [...positions].map(([key, row]) => [
      key,
      Array.from({ length: width }, (_, i) => row[i] ?? 0),
    ]),
  );
  const perCellTotals = Object.values(table).map((row) =>
    row.reduce((a, b) => a + b, 0),
  );
  const maxSpread = Math.max(
    0,
    ...Object.values(table).map((row) => Math.max(...row) - Math.min(...row)),
  );
  return {
    positionCounts: table,
    balanced: maxSpread === 0 && new Set(perCellTotals).size <= 1,
    maxPositionSpread: maxSpread,
  };
}
