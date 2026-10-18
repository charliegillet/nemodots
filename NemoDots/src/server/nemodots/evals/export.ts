// Aggregation and export. Raw per-trial records (JSONL) are the primary
// artifact; the summary and the markdown report are derived from them and can be
// regenerated. Rates carry Wilson 95% intervals, differences are shown with the
// number of pairs they rest on, and nothing is called significant. Cells with no
// live trial are listed as NOT_RUN rather than left out.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PRICING_UNIT_ASSUMPTION } from '../telemetry/pricing.js';
import { cohortBalance } from './suites.js';
import { summarize, wilson95, type RateWithInterval } from './stats.js';
import type { TrialRecord } from './runner.js';
import {
  LAYOUT_NAMES,
  STRATEGIES,
  type LayoutName,
  type StrategyName,
} from './types.js';

type Num = ReturnType<typeof summarize>;

export interface CellSummary {
  strategy: StrategyName;
  layout: LayoutName;
  trials: number;
  liveScored: number;
  notCompleted: {
    blocked: number;
    error: number;
    timed_out: number;
    /** symptom never visible before the mission (scenario_precondition_failed) */
    precondition_failed: number;
    /** a proposal-triggered fault step never fired (dependent_step_not_triggered) */
    not_exercised: number;
  };
  fixtureTrials: number;
  correctness: {
    /** repairable scenarios: independent probe passed after a committed repair */
    repairResolved: RateWithInterval;
    /** healthy and benign controls: resolved with zero commits */
    controlsSucceeded: RateWithInterval;
    /** trials with zero safety violations */
    safetyClean: RateWithInterval;
    /** trials with at least one false block, among live completed trials */
    falseBlockTrials: RateWithInterval;
    /** benign/healthy trials in which any work was invalidated */
    benignFalseInvalidationTrials: RateWithInterval;
    totals: {
      staleControlledCommits: number;
      unsafeActions: number;
      mutationsOutsideAllowedKeys: number;
      duplicateEffects: number;
      commitsUnderObsoleteFence: number;
      businessInvariantViolations: number;
      falseBlocks: number;
      blocksNotJudgeable: number;
      missedInvalidations: number;
      falseInvalidations: number;
      unknownOutcomes: number;
      unnecessaryCommits: number;
    };
  };
  efficiency: {
    modelCalls: Num;
    promptTokens: Num;
    completionTokens: Num;
    /** n = trials where the provider reported it; unavailable counted separately */
    cachedTokens: Num;
    admittedActionsBeforeResolution: Num;
    preservedWork: Num;
    repeatedWork: Num;
    repairAttempts: Num;
    setupMs: Num;
    inferenceMs: Num;
    toolMs: Num;
    recoveryMs: Num;
    completionMs: Num;
    cost: {
      usdSum: number | null;
      trialsWithCost: number;
      trialsWithoutCost: number;
      sources: string[];
    };
  };
}

export interface PairedDifference {
  scenario: string;
  scenarioClass: string;
  layout: LayoutName;
  a: StrategyName;
  b: StrategyName;
  pairs: number;
  /** a minus b, per metric: medians over the pairs and how many pairs differ */
  metrics: Record<
    string,
    {
      median: number | null;
      mean: number | null;
      nonZero: number;
      pairs: number;
    }
  >;
}

export interface Spend {
  /** every trial that has a cost, timed-out ones included */
  usd: number | null;
  pricedTrials: number;
  unpricedTrials: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  sources: string[];
}

export interface Aggregate {
  /** total spend of the cohort, whatever the trial status */
  spend: Spend;
  trials: number;
  liveScored: number;
  cells: CellSummary[];
  strategyTable: CellSummary[];
  layoutTable: CellSummary[];
  paired: PairedDifference[];
  notRun: { strategy: StrategyName; layout: LayoutName; reason: string }[];
  falseBlocks: { trialId: string; actionId: string; reason: string }[];
  /**
   * Trials that did not exercise their scenario: the symptom was never visible
   * before the mission (precondition_failed) or a proposal-triggered fault step
   * never fired (not_exercised). Excluded from every rate, listed here so a
   * scenario that cannot be exercised is a visible finding, not a quiet gap.
   */
  unexercised: {
    trialId: string;
    scenario: string;
    strategy: StrategyName;
    layout: LayoutName;
    status: 'precondition_failed' | 'not_exercised';
    note: string | null;
  }[];
  /** cached-token share by position in the counterbalanced block (cache contamination) */
  positionEffect: {
    layout: LayoutName;
    blockIndex: number;
    trials: number;
    meanCachedShare: number | null;
  }[];
  balance: ReturnType<typeof cohortBalance>;
  priceNote: string;
}

const rate = (hit: number, of: number) => wilson95(hit, of);
/**
 * Scored live trial, derived from the record's facts rather than a stored flag
 * (so a report rebuilt from older raw files applies today's rule): a live host,
 * a score, and a mission that ran to its end or to the time limit.
 */
const completedLive = (r: TrialRecord) =>
  r.mode === 'live' &&
  r.score !== null &&
  (r.status === 'completed' || r.status === 'timed_out');

function summarizeCell(
  strategy: StrategyName,
  layout: LayoutName,
  records: TrialRecord[],
): CellSummary {
  const live = records.filter(completedLive);
  const scores = live.map((r) => r.score!);
  const repair = scores.filter(
    (s) => s.correctness.expectation === 'repair_required',
  );
  const controls = scores.filter(
    (s) => s.correctness.expectation === 'no_action_required',
  );
  const sum = (pick: (c: (typeof scores)[number]['correctness']) => number) =>
    scores.reduce((n, s) => n + pick(s.correctness), 0);
  const eff = (
    pick: (e: (typeof scores)[number]['efficiency']) => number | null,
  ) => summarize(scores.map((s) => pick(s.efficiency)));
  const costs = live.map((r) => r.cost).filter((c) => c !== null);
  const known = costs.filter((c) => c.usd !== null);
  return {
    strategy,
    layout,
    trials: records.length,
    liveScored: live.length,
    notCompleted: {
      blocked: records.filter((r) => r.status === 'blocked').length,
      error: records.filter((r) => r.status === 'error').length,
      timed_out: records.filter((r) => r.status === 'timed_out').length,
      precondition_failed: records.filter(
        (r) => r.status === 'precondition_failed',
      ).length,
      not_exercised: records.filter((r) => r.status === 'not_exercised').length,
    },
    fixtureTrials: records.filter((r) => r.mode === 'fixture').length,
    correctness: {
      repairResolved: rate(
        repair.filter((s) => s.correctness.resolved).length,
        repair.length,
      ),
      controlsSucceeded: rate(
        controls.filter((s) => s.correctness.resolved).length,
        controls.length,
      ),
      safetyClean: rate(
        scores.filter((s) => s.correctness.safetyViolations === 0).length,
        scores.length,
      ),
      falseBlockTrials: rate(
        scores.filter((s) => s.correctness.falseBlocks > 0).length,
        scores.length,
      ),
      benignFalseInvalidationTrials: rate(
        controls.filter((s) => s.correctness.falseInvalidations > 0).length,
        controls.length,
      ),
      totals: {
        staleControlledCommits: sum((c) => c.staleControlledCommits),
        unsafeActions: sum((c) => c.unsafeActions),
        mutationsOutsideAllowedKeys: sum((c) => c.mutationsOutsideAllowedKeys),
        duplicateEffects: sum((c) => c.duplicateEffects),
        commitsUnderObsoleteFence: sum((c) => c.commitsUnderObsoleteFence),
        businessInvariantViolations: sum((c) => c.businessInvariantViolations),
        falseBlocks: sum((c) => c.falseBlocks),
        blocksNotJudgeable: sum((c) => c.blocksNotJudgeable),
        missedInvalidations: sum((c) => c.missedInvalidations),
        falseInvalidations: sum((c) => c.falseInvalidations),
        unknownOutcomes: sum((c) => c.unknownOutcomes),
        unnecessaryCommits: sum((c) => c.unnecessaryCommits),
      },
    },
    efficiency: {
      modelCalls: eff((e) => e.modelCalls),
      promptTokens: eff((e) => e.promptTokens),
      completionTokens: eff((e) => e.completionTokens),
      cachedTokens: eff((e) => e.cachedTokens),
      admittedActionsBeforeResolution: eff(
        (e) => e.admittedActionsBeforeResolution,
      ),
      preservedWork: eff((e) => e.preservedWork),
      repeatedWork: eff((e) => e.repeatedWork),
      repairAttempts: eff((e) => e.repairAttempts),
      setupMs: eff((e) => e.timing.setupMs),
      inferenceMs: eff((e) => e.timing.inferenceMs),
      toolMs: eff((e) => e.timing.toolMs),
      recoveryMs: eff((e) => e.timing.recoveryMs),
      completionMs: eff((e) => e.timing.completionMs),
      cost: {
        usdSum: known.length
          ? known.reduce((n, c) => n + (c.usd as number), 0)
          : null,
        trialsWithCost: known.length,
        trialsWithoutCost: costs.length - known.length,
        sources: [...new Set(known.map((c) => c.source))],
      },
    },
  };
}

const PAIR_METRICS: Record<string, (r: TrialRecord) => number | null> = {
  repeatedWork: (r) => r.score?.efficiency.repeatedWork ?? null,
  preservedWork: (r) => r.score?.efficiency.preservedWork ?? null,
  repairAttempts: (r) => r.score?.efficiency.repairAttempts ?? null,
  modelCalls: (r) => r.score?.efficiency.modelCalls ?? null,
  promptTokens: (r) => r.score?.efficiency.promptTokens ?? null,
};

export function pairedDifferences(
  records: readonly TrialRecord[],
  a: StrategyName,
  b: StrategyName,
  layout: LayoutName,
): PairedDifference[] {
  const live = records.filter(completedLive);
  const key = (r: TrialRecord) => `${r.spec.scenarioId}:${r.spec.seed}`;
  const byA = new Map(
    live
      .filter((r) => r.spec.strategy === a && r.spec.layout === layout)
      .map((r) => [key(r), r]),
  );
  const out = new Map<
    string,
    PairedDifference & { diffs: Record<string, number[]> }
  >();
  for (const rb of live.filter(
    (r) => r.spec.strategy === b && r.spec.layout === layout,
  )) {
    const ra = byA.get(key(rb));
    if (!ra) continue;
    const entry =
      out.get(rb.spec.scenarioId) ??
      ({
        scenario: rb.spec.scenarioId,
        scenarioClass: rb.scenarioClass,
        layout,
        a,
        b,
        pairs: 0,
        metrics: {},
        diffs: Object.fromEntries(
          Object.keys(PAIR_METRICS).map((m) => [m, [] as number[]]),
        ),
      } as PairedDifference & { diffs: Record<string, number[]> });
    entry.pairs += 1;
    for (const [metric, pick] of Object.entries(PAIR_METRICS)) {
      const va = pick(ra);
      const vb = pick(rb);
      if (va !== null && vb !== null) entry.diffs[metric].push(va - vb);
    }
    out.set(rb.spec.scenarioId, entry);
  }
  return [...out.values()]
    .map(({ diffs, ...rest }) => ({
      ...rest,
      metrics: Object.fromEntries(
        Object.entries(diffs).map(([metric, values]) => {
          const s = summarize(values);
          return [
            metric,
            {
              median: s.median,
              mean: s.mean,
              nonZero: values.filter((v) => v !== 0).length,
              pairs: values.length,
            },
          ];
        }),
      ),
    }))
    .sort((x, y) => (x.scenario < y.scenario ? -1 : 1));
}

export function aggregate(records: readonly TrialRecord[]): Aggregate {
  const cells: CellSummary[] = [];
  const notRun: Aggregate['notRun'] = [];
  const seenCells = new Set(
    records.map((r) => `${r.spec.strategy}/${r.spec.layout}`),
  );
  for (const strategy of STRATEGIES)
    for (const layout of LAYOUT_NAMES) {
      const mine = records.filter(
        (r) => r.spec.strategy === strategy && r.spec.layout === layout,
      );
      if (mine.length === 0) {
        if (!seenCells.has(`${strategy}/${layout}`))
          notRun.push({ strategy, layout, reason: 'not part of this cohort' });
        continue;
      }
      const cell = summarizeCell(strategy, layout, mine);
      if (cell.liveScored === 0)
        notRun.push({ strategy, layout, reason: 'no scored live trial' });
      cells.push(cell);
    }
  const find = (s: StrategyName, l: LayoutName) =>
    cells.find((c) => c.strategy === s && c.layout === l);
  const strategyTable = STRATEGIES.flatMap((s) => find(s, 'cache_aware') ?? []);
  const layoutTable = (['broad-restart', 'selective'] as const).flatMap((s) =>
    LAYOUT_NAMES.flatMap((l) => find(s, l) ?? []),
  );
  const paired = [
    ...pairedDifferences(records, 'dag-restart', 'selective', 'cache_aware'),
    ...pairedDifferences(records, 'broad-restart', 'selective', 'cache_aware'),
    ...pairedDifferences(records, 'broad-restart', 'selective', 'ordinary'),
  ];
  const falseBlocks = records.flatMap((r) =>
    (r.score?.correctness.falseBlockDetails ?? []).map((d) => ({
      trialId: r.spec.trialId,
      actionId: d.actionId,
      reason: d.reason,
    })),
  );
  const positionEffect: Aggregate['positionEffect'] = [];
  for (const layout of LAYOUT_NAMES)
    for (const blockIndex of [
      ...new Set(records.map((r) => r.spec.blockIndex)),
    ].sort((a, b) => a - b)) {
      const at = records.filter(
        (r) =>
          completedLive(r) &&
          r.spec.layout === layout &&
          r.spec.blockIndex === blockIndex,
      );
      const shares = at.flatMap((r) => {
        const e = r.score!.efficiency;
        return e.cachedTokens !== null && e.promptTokens > 0
          ? [e.cachedTokens / e.promptTokens]
          : [];
      });
      if (at.length)
        positionEffect.push({
          layout,
          blockIndex,
          trials: at.length,
          meanCachedShare: shares.length
            ? shares.reduce((a, b) => a + b, 0) / shares.length
            : null,
        });
    }
  const costed = records.filter((r) => r.cost !== null);
  const priced = costed.filter((r) => r.cost!.usd !== null);
  return {
    spend: {
      usd: priced.length
        ? priced.reduce((n, r) => n + (r.cost!.usd as number), 0)
        : null,
      pricedTrials: priced.length,
      unpricedTrials:
        records.filter((r) => r.observations !== null).length - priced.length,
      modelCalls: records.reduce(
        (n, r) => n + ((r.usage ?? r.score?.efficiency)?.modelCalls ?? 0),
        0,
      ),
      promptTokens: records.reduce(
        (n, r) => n + ((r.usage ?? r.score?.efficiency)?.promptTokens ?? 0),
        0,
      ),
      completionTokens: records.reduce(
        (n, r) => n + ((r.usage ?? r.score?.efficiency)?.completionTokens ?? 0),
        0,
      ),
      sources: [...new Set(priced.map((r) => r.cost!.source))],
    },
    trials: records.length,
    liveScored: records.filter(completedLive).length,
    cells,
    strategyTable,
    layoutTable,
    paired,
    notRun,
    falseBlocks,
    unexercised: records.flatMap((r) =>
      r.status === 'precondition_failed' || r.status === 'not_exercised'
        ? [
            {
              trialId: r.spec.trialId,
              scenario: r.spec.scenarioId,
              strategy: r.spec.strategy,
              layout: r.spec.layout,
              status: r.status,
              note: r.note,
            },
          ]
        : [],
    ),
    positionEffect,
    balance: cohortBalance(records.map((r) => r.spec)),
    priceNote: PRICING_UNIT_ASSUMPTION,
  };
}

// ------------------------------------------------------------------- report

const pct = (r: RateWithInterval) =>
  r.rate === null
    ? 'n/a (0 trials)'
    : `${r.successes}/${r.trials} = ${(r.rate * 100).toFixed(0)}% [${((r.low as number) * 100).toFixed(0)}-${((r.high as number) * 100).toFixed(0)}]`;
const med = (n: Num) =>
  n.median === null
    ? 'n/a'
    : `${Number(n.median.toFixed(1))}${n.unavailable ? ` (${n.unavailable} unavailable)` : ''}`;
const usd = (c: CellSummary['efficiency']['cost']) =>
  c.usdSum === null
    ? 'n/a'
    : `$${c.usdSum.toFixed(3)} (${c.sources.join('+')}${c.trialsWithoutCost ? `, ${c.trialsWithoutCost} unpriced` : ''})`;

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [
    line(headers),
    line(headers.map(() => '---')),
    ...rows.map(line),
  ].join('\n');
}

export function renderReport(
  agg: Aggregate,
  header: {
    cohortId: string;
    mode: string;
    suite: string;
    model: string;
    commit: string | null;
  },
): string {
  const correctnessRows = (cells: CellSummary[]) =>
    cells.map((c) => [
      `${c.strategy} / ${c.layout}`,
      String(c.trials),
      String(c.liveScored),
      pct(c.correctness.repairResolved),
      pct(c.correctness.controlsSucceeded),
      pct(c.correctness.safetyClean),
      String(c.correctness.totals.staleControlledCommits),
      String(
        c.correctness.totals.unsafeActions +
          c.correctness.totals.mutationsOutsideAllowedKeys,
      ),
      pct(c.correctness.falseBlockTrials),
      `${c.correctness.totals.missedInvalidations}/${c.correctness.totals.falseInvalidations}`,
    ]);
  const efficiencyRows = (cells: CellSummary[]) =>
    cells.map((c) => [
      `${c.strategy} / ${c.layout}`,
      med(c.efficiency.modelCalls),
      med(c.efficiency.promptTokens),
      med(c.efficiency.cachedTokens),
      med(c.efficiency.admittedActionsBeforeResolution),
      med(c.efficiency.preservedWork),
      med(c.efficiency.repeatedWork),
      med(c.efficiency.recoveryMs),
      med(c.efficiency.completionMs),
      usd(c.efficiency.cost),
    ]);
  const cHead = [
    'arm',
    'trials',
    'scored live',
    'repair resolved [95% Wilson]',
    'controls ok',
    'safety clean',
    'stale commits',
    'unsafe+outside',
    'trials with a false block',
    'missed/false invalidations',
  ];
  const eHead = [
    'arm',
    'model calls (median)',
    'prompt tokens',
    'cached tokens',
    'admitted before resolution',
    'preserved work',
    'repeated work',
    'recovery ms',
    'completion ms',
    'cost',
  ];
  const sections: string[] = [
    `# Evaluation report`,
    `Cohort ${header.cohortId}; suite ${header.suite}; mode ${header.mode}; model ${header.model}; commit ${header.commit ?? 'unknown'}.`,
    `${agg.trials} trials recorded, ${agg.liveScored} scored live (completed or timed out at the limit). Every trial, including blocked, errored and timed-out ones, is in trials.jsonl.`,
    `## Trials that did not exercise their scenario (excluded from every rate)`,
    agg.unexercised.length
      ? table(
          ['trial', 'scenario', 'arm', 'status', 'why'],
          agg.unexercised.map((u) => [
            u.trialId,
            u.scenario,
            `${u.strategy}/${u.layout}`,
            u.status,
            (u.note ?? '').replace(/\|/g, '/').slice(0, 220),
          ]),
        )
      : 'None: every recorded trial had its symptom visible before the mission and every proposal-triggered fault step fired.',
    `## Correctness (reported separately from efficiency)`,
    `### Strategy table (cache-aware layout)`,
    table(cHead, correctnessRows(agg.strategyTable)),
    `### Layout table (broad vs selective x layout)`,
    table(cHead, correctnessRows(agg.layoutTable)),
    `## Efficiency (medians over scored live trials; unavailable values counted out, never as 0)`,
    `### Strategy table`,
    table(eHead, efficiencyRows(agg.strategyTable)),
    `### Layout table`,
    table(eHead, efficiencyRows(agg.layoutTable)),
    `## Paired differences on identical fault schedules (a minus b; no significance claimed)`,
    agg.paired.length
      ? table(
          [
            'scenario',
            'layout',
            'a - b',
            'pairs',
            'repeated work (median, pairs that differ)',
            'preserved work',
            'model calls',
          ],
          agg.paired.map((p) => [
            p.scenario,
            p.layout,
            `${p.a} - ${p.b}`,
            String(p.pairs),
            `${p.metrics.repeatedWork.median ?? 'n/a'} (${p.metrics.repeatedWork.nonZero}/${p.metrics.repeatedWork.pairs})`,
            `${p.metrics.preservedWork.median ?? 'n/a'} (${p.metrics.preservedWork.nonZero}/${p.metrics.preservedWork.pairs})`,
            `${p.metrics.modelCalls.median ?? 'n/a'} (${p.metrics.modelCalls.nonZero}/${p.metrics.modelCalls.pairs})`,
          ]),
        )
      : 'No paired live trials: no difference was measured.',
    `## False blocks`,
    agg.falseBlocks.length
      ? table(
          ['trial', 'action', 'reason'],
          agg.falseBlocks.map((f) => [f.trialId, f.actionId, f.reason]),
        )
      : 'None observed in the completed live trials (blocks the oracle cannot judge are counted in the cell totals as blocksNotJudgeable).',
    `## NOT_RUN`,
    agg.notRun.length
      ? table(
          ['arm', 'reason'],
          agg.notRun.map((n) => [
            `${n.strategy} / ${n.layout}`,
            `NOT_RUN: ${n.reason}`,
          ]),
        )
      : 'Every defined arm has at least one completed live trial.',
    `## Cache contamination`,
    `Counterbalanced order: ${agg.balance.balanced ? 'balanced' : `not fully balanced (max position spread ${agg.balance.maxPositionSpread})`}. Arms that share a prefix share a provider-side prefix cache for roughly 4 minutes, so a later arm can read an earlier arm's cache. Cached-token share by block position:`,
    agg.positionEffect.length
      ? table(
          ['layout', 'block position', 'trials', 'mean cached share of prompt'],
          agg.positionEffect.map((p) => [
            p.layout,
            String(p.blockIndex),
            String(p.trials),
            p.meanCachedShare === null
              ? 'unavailable'
              : p.meanCachedShare.toFixed(2),
          ]),
        )
      : 'No data.',
    `## Pricing`,
    `Spend of the whole cohort (every trial, timed-out ones included): ${agg.spend.usd === null ? 'unavailable' : `$${agg.spend.usd.toFixed(3)} (${agg.spend.sources.join('+')})`} over ${agg.spend.modelCalls} model calls, ${agg.spend.promptTokens} prompt and ${agg.spend.completionTokens} completion tokens.`,
    `Unit assumption: ${agg.priceNote}. Figures marked estimate use the LEAD_NOTES price table and are not a bill.`,
  ];
  return `${sections.join('\n\n')}\n`;
}

// ------------------------------------------------------------------- files

export interface CohortFiles {
  dir: string;
  trials: string;
}

export async function openCohortDir(
  root: string,
  cohortId: string,
): Promise<CohortFiles> {
  const dir = path.join(root, cohortId);
  await mkdir(dir, { recursive: true });
  return { dir, trials: path.join(dir, 'trials.jsonl') };
}

/** Appends one trial as it completes, so a crash never loses finished trials. */
export async function appendTrial(
  files: CohortFiles,
  record: TrialRecord,
): Promise<void> {
  await appendFile(files.trials, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

export async function writeSummary(
  files: CohortFiles,
  records: readonly TrialRecord[],
  header: {
    cohortId: string;
    mode: string;
    suite: string;
    model: string;
    commit: string | null;
  },
): Promise<Aggregate> {
  const agg = aggregate(records);
  await writeFile(
    path.join(files.dir, 'summary.json'),
    `${JSON.stringify({ header, aggregate: agg }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(files.dir, 'report.md'),
    renderReport(agg, header),
    { mode: 0o600 },
  );
  return agg;
}
