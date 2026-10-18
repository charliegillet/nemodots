// Gate 8: every NEMODOTS_MUTATION must be caught. This unit test pins the
// matrix logic, the catalogue (names, files, honour rules); the real matrix is
// executed against a stack by `npm run nemodots:evals -- --suite mutations`
// and its result is recorded in docs/nemodots/EVALUATION.md.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUTATIONS,
  MutationConfigError,
  parseMutation,
} from '../../../src/server/nemodots/config/mutation.js';
import {
  MUTATION_CATALOGUE,
  runMutationMatrix,
  type MutationExecutor,
  type SuiteRun,
} from '../../../src/server/nemodots/evals/mutations.js';

const ROOT = join(__dirname, '../../..');
const ok = (total = 10): SuiteRun => ({
  exitCode: 0,
  total,
  failed: [],
  error: null,
});
const failing = (...titles: string[]): SuiteRun => ({
  exitCode: 1,
  total: 10,
  failed: titles.map((title) => ({ file: 'f.test.ts', title })),
  error: null,
});

/** An executor that fails the named tests only under the named mutation. */
function scripted(
  caughtBy: Partial<Record<string, string[]>>,
  baselineFailures: string[] = [],
): {
  execute: MutationExecutor;
  calls: { files: readonly string[]; env: Record<string, string> }[];
} {
  const calls: { files: readonly string[]; env: Record<string, string> }[] = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      const mutation = input.env.NEMODOTS_MUTATION;
      const titles = [
        ...baselineFailures,
        ...(mutation ? (caughtBy[mutation] ?? []) : []),
      ];
      return titles.length ? failing(...titles) : ok();
    },
  };
}

describe('the six gate-8 mutations', () => {
  it('the catalogue covers exactly the names the code honours', () => {
    expect(Object.keys(MUTATION_CATALOGUE).sort()).toEqual(
      [...MUTATIONS].sort(),
    );
    expect(MUTATIONS).toEqual([
      'bypass_final_version_check',
      'drop_inherited_edges',
      'ignore_fencing',
      'accept_duplicate_differing_payloads',
      'skip_effect_marker',
      'skip_freshness',
    ]);
  });

  it('every mapped test file exists and is run by the integration config', () => {
    for (const [mutation, files] of Object.entries(MUTATION_CATALOGUE)) {
      expect(files.length, mutation).toBeGreaterThan(0);
      for (const file of files) {
        expect(existsSync(join(ROOT, file)), file).toBe(true);
        expect(file).toMatch(
          /^tests\/nemodots\/(integration|adversarial)\/.+\.test\.ts$/,
        );
      }
    }
  });

  it.each(MUTATIONS)(
    '%s is honoured only with test hooks, never when live, and an unknown name is refused',
    (name) => {
      expect(
        parseMutation({ NEMODOTS_MUTATION: name, NEMODOTS_TEST_HOOKS: '1' }),
      ).toBe(name);
      expect(() => parseMutation({ NEMODOTS_MUTATION: name })).toThrow(
        MutationConfigError,
      );
      expect(() =>
        parseMutation({
          NEMODOTS_MUTATION: name,
          NEMODOTS_TEST_HOOKS: '1',
          OPENAI_API_KEY: 'k',
          OPENAI_BASE_URL: 'https://api.example.test/v1',
          OPENAI_MODEL: 'm',
        }),
      ).toThrow(/never honoured in a run labelled live/);
      expect(parseMutation({})).toBeNull();
      expect(() =>
        parseMutation({
          NEMODOTS_MUTATION: 'weaken_everything',
          NEMODOTS_TEST_HOOKS: '1',
        }),
      ).toThrow(MutationConfigError);
    },
  );
});

describe('the matrix', () => {
  const everyone = Object.fromEntries(MUTATIONS.map((m) => [m, [`${m} test`]]));

  it('all caught on a clean baseline: runs once clean, then once per mutation with only the two mutation variables', async () => {
    const { execute, calls } = scripted(everyone);
    const report = await runMutationMatrix(execute);
    expect(report.allCaught).toBe(true);
    expect(report.baseline).toMatchObject({ clean: true, failed: 0 });
    expect(report.results.map((r) => r.status)).toEqual(
      Array(6).fill('caught'),
    );
    expect(calls).toHaveLength(7);
    expect(calls[0].env).toEqual({});
    for (const [i, mutation] of MUTATIONS.entries()) {
      expect(calls[i + 1].env).toEqual({
        NEMODOTS_MUTATION: mutation,
        NEMODOTS_TEST_HOOKS: '1',
      });
      expect(calls[i + 1].files).toEqual(MUTATION_CATALOGUE[mutation]);
    }
    expect(report.results[0].catchingTests[0].title).toBe(
      'bypass_final_version_check test',
    );
  });

  it('a mutation no test notices is NOT_CAUGHT and fails the gate', async () => {
    const partial = { ...everyone, skip_freshness: [] };
    const report = await runMutationMatrix(scripted(partial).execute);
    expect(report.allCaught).toBe(false);
    expect(
      report.results.find((r) => r.mutation === 'skip_freshness')!.status,
    ).toBe('NOT_CAUGHT');
    expect(report.results.filter((r) => r.status === 'caught')).toHaveLength(5);
  });

  it('failures that also fail on the clean build do not count as catching', async () => {
    const report = await runMutationMatrix(
      scripted({ ignore_fencing: ['already broken'] }, ['already broken'])
        .execute,
    );
    expect(report.baseline.clean).toBe(false);
    expect(report.allCaught).toBe(false);
    expect(
      report.results.find((r) => r.mutation === 'ignore_fencing')!.status,
    ).toBe('baseline_failed');
    expect(
      report.results.find((r) => r.mutation === 'ignore_fencing')!.note,
    ).toContain('baseline');
  });

  it('a new failure under a mutation is credited even when the baseline has unrelated failures, but the matrix is not clean', async () => {
    const report = await runMutationMatrix(
      scripted({ ignore_fencing: ['fencing test'] }, ['unrelated']).execute,
    );
    const row = report.results.find((r) => r.mutation === 'ignore_fencing')!;
    expect(row.status).toBe('caught');
    expect(row.catchingTests.map((t) => t.title)).toEqual(['fencing test']);
    expect(report.allCaught).toBe(false);
  });

  it('an executor error is reported as such, never as caught', async () => {
    const execute: MutationExecutor = async ({ env }) =>
      env.NEMODOTS_MUTATION === 'skip_effect_marker'
        ? {
            exitCode: null,
            total: 0,
            failed: [],
            error: 'vitest wrote no report',
          }
        : ok();
    const report = await runMutationMatrix(execute);
    expect(
      report.results.find((r) => r.mutation === 'skip_effect_marker'),
    ).toMatchObject({
      status: 'error',
      note: 'vitest wrote no report',
    });
    expect(report.allCaught).toBe(false);
  });

  it('can run a subset and an unmapped mutation is NOT_CAUGHT', async () => {
    const report = await runMutationMatrix(
      scripted(everyone).execute,
      MUTATION_CATALOGUE,
      ['ignore_fencing'],
    );
    expect(report.results).toHaveLength(1);
    const unmapped = await runMutationMatrix(scripted(everyone).execute, {}, [
      'ignore_fencing',
    ]);
    expect(unmapped.results[0]).toMatchObject({
      status: 'NOT_CAUGHT',
      note: 'no test is mapped to this mutation',
    });
  });
});
