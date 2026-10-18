import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  appendTrial,
  openCohortDir,
  renderReport,
  writeSummary,
} from '../../../src/server/nemodots/evals/export.js';
import { runCohort } from '../../../src/server/nemodots/evals/runner.js';
import {
  SUITES,
  planCohort,
} from '../../../src/server/nemodots/evals/suites.js';
import { FakeHost } from './fake-host.js';

async function cohort(
  host: FakeHost,
  scenarios = ['diverging_edges', 'healthy'],
  trials = 2,
) {
  const plan = planCohort({
    suite: SUITES.matched,
    trials,
    seed: 3,
    scenarios,
    cohortId: 'cohort-1',
  });
  return runCohort(host, plan);
}

describe('aggregation', () => {
  it('builds the strategy and layout tables from live completed trials only', async () => {
    const agg = aggregate(await cohort(new FakeHost()));
    expect(agg.trials).toBe(20);
    expect(agg.liveScored).toBe(20);
    expect(agg.strategyTable.map((c) => `${c.strategy}/${c.layout}`)).toEqual([
      'broad-restart/cache_aware',
      'dag-restart/cache_aware',
      'selective/cache_aware',
    ]);
    expect(agg.layoutTable.map((c) => `${c.strategy}/${c.layout}`)).toEqual([
      'broad-restart/ordinary',
      'broad-restart/cache_aware',
      'selective/ordinary',
      'selective/cache_aware',
    ]);
    const selective = agg.strategyTable[2];
    expect(selective.correctness.repairResolved).toMatchObject({
      successes: 2,
      trials: 2,
    });
    expect(selective.correctness.safetyClean).toMatchObject({
      successes: 4,
      trials: 4,
    });
  });

  it('a timed-out trial stays in the denominators as unresolved and its spend is in the cohort total (no survivor bias)', async () => {
    const records = await cohort(
      new FakeHost({ timeoutAt: 0, probeFails: true }),
      ['diverging_edges'],
      1,
    );
    const agg = aggregate(records);
    expect(records[0].status).toBe('timed_out');
    expect(agg.liveScored).toBe(5);
    const timedOutCell = agg.cells.find(
      (c) =>
        c.strategy === records[0].spec.strategy &&
        c.layout === records[0].spec.layout,
    )!;
    expect(timedOutCell.notCompleted.timed_out).toBe(1);
    expect(timedOutCell.correctness.repairResolved).toMatchObject({
      successes: 0,
      trials: 1,
    });
    // all five trials contributed spend, the timed-out one included
    expect(agg.spend.pricedTrials).toBe(5);
    expect(agg.spend.modelCalls).toBe(100);
    expect(agg.spend.usd).toBeGreaterThan(0);
  });

  it('unexercised trials are excluded from every rate, listed in the report, and their spend still counts', async () => {
    const records = await cohort(
      new FakeHost({ notTriggeredAt: 0 }),
      ['diverging_edges'],
      1,
    );
    expect(records[0].status).toBe('not_exercised');
    expect(records[0].usage?.modelCalls).toBe(20);
    expect(records[0].cost?.usd).toBeGreaterThan(0);
    const agg = aggregate(records);
    expect(agg.trials).toBe(5);
    expect(agg.liveScored).toBe(4);
    expect(agg.unexercised).toEqual([
      expect.objectContaining({
        trialId: records[0].spec.trialId,
        status: 'not_exercised',
      }),
    ]);
    const cell = agg.cells.find(
      (c) =>
        c.strategy === records[0].spec.strategy &&
        c.layout === records[0].spec.layout,
    )!;
    expect(cell.notCompleted.not_exercised).toBe(1);
    expect(cell.liveScored).toBe(0);
    expect(cell.correctness.repairResolved.trials).toBe(0);
    // all five missions spent tokens, the unexercised one included
    expect(agg.spend.modelCalls).toBe(100);
    expect(agg.spend.pricedTrials).toBe(5);
    const report = renderReport(agg, {
      cohortId: 'c',
      suite: 'matched',
      mode: 'live',
      model: 'm',
      commit: null,
    });
    expect(report).toContain('did not exercise their scenario');
    expect(report).toContain('dependent_step_not_triggered');
  });

  it('a clean cohort says nothing was left unexercised', async () => {
    const agg = aggregate(await cohort(new FakeHost(), ['diverging_edges'], 1));
    expect(agg.unexercised).toEqual([]);
    expect(
      renderReport(agg, {
        cohortId: 'c',
        suite: 'matched',
        mode: 'live',
        model: 'm',
        commit: null,
      }),
    ).toContain('None: every recorded trial had its symptom visible');
  });

  it('a precondition_failed trial has no mission, no score and no spend', async () => {
    const records = await cohort(
      new FakeHost({ preconditionFailsAt: 0 }),
      ['diverging_edges'],
      1,
    );
    expect(records[0].status).toBe('precondition_failed');
    const agg = aggregate(records);
    expect(agg.unexercised.map((u) => u.status)).toEqual([
      'precondition_failed',
    ]);
    expect(agg.liveScored).toBe(4);
    expect(agg.spend.modelCalls).toBe(80);
    const cell = agg.cells.find(
      (c) =>
        c.strategy === records[0].spec.strategy &&
        c.layout === records[0].spec.layout,
    )!;
    expect(cell.notCompleted.precondition_failed).toBe(1);
  });

  it('errored and blocked trials are listed but have no score and no spend', async () => {
    const agg = aggregate(
      await cohort(new FakeHost({ errorAt: 0 }), ['diverging_edges'], 1),
    );
    expect(agg.trials).toBe(5);
    expect(agg.liveScored).toBe(4);
    expect(agg.spend.pricedTrials).toBe(4);
  });

  it('fixture trials are recorded but never aggregated as live', async () => {
    const records = await cohort(new FakeHost({ mode: 'fixture' }));
    const agg = aggregate(records);
    expect(agg.trials).toBe(20);
    expect(agg.liveScored).toBe(0);
    expect(
      agg.strategyTable.every((c) => c.liveScored === 0 && c.fixtureTrials > 0),
    ).toBe(true);
    expect(agg.notRun.length).toBeGreaterThan(0);
    expect(agg.notRun.every((n) => n.reason.length > 0)).toBe(true);
  });

  it('paired differences on identical schedules expose a measured gap between arms, or say none was measured', async () => {
    const host = new FakeHost({
      repeated: { 'dag-restart': 1, 'broad-restart': 2 },
    });
    const agg = aggregate(await cohort(host, ['diverging_edges']));
    const dag = agg.paired.find(
      (p) =>
        p.a === 'dag-restart' &&
        p.b === 'selective' &&
        p.layout === 'cache_aware',
    )!;
    expect(dag.pairs).toBe(2);
    expect(dag.metrics.repeatedWork).toMatchObject({
      median: 1,
      nonZero: 2,
      pairs: 2,
    });
    const broad = agg.paired.find(
      (p) =>
        p.a === 'broad-restart' &&
        p.b === 'selective' &&
        p.layout === 'ordinary',
    )!;
    expect(broad.metrics.repeatedWork.median).toBe(2);

    const equal = aggregate(await cohort(new FakeHost(), ['diverging_edges']));
    const none = equal.paired.find((p) => p.a === 'dag-restart')!;
    expect(none.metrics.repeatedWork).toMatchObject({ median: 0, nonZero: 0 });
    const text = renderReport(equal, {
      cohortId: 'c',
      mode: 'live',
      suite: 'matched',
      model: 'm',
      commit: null,
    });
    expect(text).toContain('0 (0/2)');
  });

  it('cached tokens: unavailable trials are counted out and reported, never as zero', async () => {
    const agg = aggregate(
      await cohort(
        new FakeHost({ cachedTokens: null }),
        ['diverging_edges'],
        1,
      ),
    );
    const cell = agg.strategyTable[2];
    expect(cell.efficiency.cachedTokens).toMatchObject({
      n: 0,
      mean: null,
      unavailable: 1,
    });
    expect(cell.efficiency.cost.sources).toEqual(['estimate']);
  });

  it('cache contamination is reported by block position', async () => {
    const agg = aggregate(await cohort(new FakeHost(), ['healthy'], 5));
    expect(agg.balance.balanced).toBe(true);
    expect(
      agg.positionEffect
        .filter((p) => p.layout === 'cache_aware')
        .map((p) => p.blockIndex),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('intervals accompany every rate and no significance language appears in the report', async () => {
    const agg = aggregate(await cohort(new FakeHost(), ['diverging_edges'], 1));
    const text = renderReport(agg, {
      cohortId: 'c',
      mode: 'live',
      suite: 'matched',
      model: 'm',
      commit: 'abc',
    });
    expect(text).toMatch(/\[\d+-\d+\]/);
    expect(text).not.toMatch(
      /significan(t|ce)(?! claimed)|p-value|p <|statistically/i,
    );
    for (const heading of [
      'Correctness',
      'Efficiency',
      'Strategy table',
      'Layout table',
      'False blocks',
      'NOT_RUN',
      'Cache contamination',
      'Pricing',
    ])
      expect(text).toContain(heading);
    expect(text).not.toMatch(/graphiti|memtx|coagent/i);
  });
});

describe('export files', () => {
  it('writes every trial raw (one JSON line each), then a summary and a report', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'evals-'));
    try {
      const files = await openCohortDir(root, 'cohort-1');
      const records = await cohort(
        new FakeHost({ errorAt: 1, blockAt: undefined }),
        ['diverging_edges'],
        1,
      );
      for (const record of records) await appendTrial(files, record);
      const lines = (await readFile(files.trials, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(records.length);
      const parsed = lines.map((l) => JSON.parse(l));
      expect(parsed.map((p) => p.status)).toContain('error');
      expect(parsed[0].spec.trialId).toBe(records[0].spec.trialId);
      const agg = await writeSummary(files, records, {
        cohortId: 'cohort-1',
        mode: 'live',
        suite: 'matched',
        model: 'm',
        commit: null,
      });
      const summary = JSON.parse(
        await readFile(path.join(files.dir, 'summary.json'), 'utf8'),
      );
      expect(summary.aggregate.trials).toBe(agg.trials);
      expect(
        await readFile(path.join(files.dir, 'report.md'), 'utf8'),
      ).toContain('# Evaluation report');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
