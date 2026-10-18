import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleComparison,
  buildComparisonFromDirectory,
  type EvalTrialResult,
} from '../../../src/server/nemodots/telemetry/comparison.js';

const trial = (patch: Partial<EvalTrialResult>): EvalTrialResult =>
  ({ arm: 'selective', scenarioId: 's1', ...patch }) as EvalTrialResult;

describe('assembleComparison', () => {
  it('has no arms and no metrics for no trials', () => {
    expect(assembleComparison([])).toEqual({
      arms: [],
      matchedScenarios: [],
      unmatchedScenarios: [],
      skipped: [],
    });
  });

  it('compares arms only on scenarios every arm ran', () => {
    const table = assembleComparison([
      trial({ arm: 'selective', scenarioId: 's1', modelCalls: 4 }),
      trial({ arm: 'broad', scenarioId: 's1', modelCalls: 10 }),
      trial({ arm: 'selective', scenarioId: 's2', modelCalls: 100 }),
    ]);
    expect(table.matchedScenarios).toEqual(['s1']);
    expect(table.unmatchedScenarios).toEqual(['s2']);
    const sel = table.arms.find((a) => a.arm === 'selective');
    expect(sel?.trials).toBe(1);
    expect(sel?.metrics.modelCalls).toEqual({ reported: 1, sum: 4, mean: 4 });
  });

  it('uses null for metrics no trial reported and averages only reporting trials', () => {
    const table = assembleComparison([
      trial({
        scenarioId: 'a',
        cachedTokens: null,
        promptTokens: 100,
        recoveryMs: 3000,
        resolved: true,
      }),
      trial({
        scenarioId: 'b',
        promptTokens: 300,
        recoveryMs: 1000,
        resolved: false,
      }),
      trial({ scenarioId: 'c', resolved: true }),
    ]);
    const [arm] = table.arms;
    expect(arm.trials).toBe(3);
    expect(arm.metrics.cachedTokens).toEqual({
      reported: 0,
      sum: null,
      mean: null,
    });
    expect(arm.metrics.promptTokens).toEqual({
      reported: 2,
      sum: 400,
      mean: 200,
    });
    expect(arm.metrics.recoveryMs.mean).toBe(2000);
    expect(arm.metrics.costUsd.sum).toBeNull();
    expect(arm.resolved).toEqual({ reported: 3, yes: 2, rate: 2 / 3 });
  });

  it('reports a null resolution rate when nobody reported resolution', () => {
    const [arm] = assembleComparison([trial({})]).arms;
    expect(arm.resolved).toEqual({ reported: 0, yes: 0, rate: null });
  });

  it('keeps zero as zero (a reported 0 is a value)', () => {
    const [arm] = assembleComparison([trial({ staleCommits: 0 })]).arms;
    expect(arm.metrics.staleCommits).toEqual({ reported: 1, sum: 0, mean: 0 });
  });
});

describe('buildComparisonFromDirectory', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'nemodots-cmp-'));
    await writeFile(
      path.join(dir, 'a.json'),
      JSON.stringify({
        trials: [{ arm: 'x', scenarioId: 's', modelCalls: 2 }],
      }),
    );
    await writeFile(
      path.join(dir, 'b.json'),
      JSON.stringify([
        { arm: 'y', scenarioId: 's', modelCalls: 5, cachedTokens: null },
      ]),
    );
    await writeFile(path.join(dir, 'broken.json'), '{nope');
    await writeFile(
      path.join(dir, 'bad-trial.json'),
      JSON.stringify({ arm: 'x' }),
    );
    await writeFile(path.join(dir, 'notes.txt'), 'ignored');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads trial objects, arrays and { trials } files and reports files it could not use', async () => {
    const table = await buildComparisonFromDirectory(dir);
    expect(table.arms.map((a) => a.arm)).toEqual(['x', 'y']);
    expect(table.matchedScenarios).toEqual(['s']);
    expect(table.skipped.map((s) => path.basename(s.file)).sort()).toEqual([
      'bad-trial.json',
      'broken.json',
    ]);
    expect(table.arms[1].metrics.cachedTokens.mean).toBeNull();
  });

  it('refuses a missing directory', async () => {
    await expect(
      buildComparisonFromDirectory(path.join(dir, 'missing')),
    ).rejects.toThrow(/not readable/);
  });
});
