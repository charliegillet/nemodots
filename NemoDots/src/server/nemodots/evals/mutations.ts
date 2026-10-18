// Gate-8 mutation matrix. Each NEMODOTS_MUTATION build switches OFF exactly one
// safety guard (config/mutation.ts, inert unless NEMODOTS_TEST_HOOKS=1 and never
// in a live-labelled run). A mutation is CAUGHT when at least one test that
// passes on a clean build fails on the mutated build; a mutation no test notices
// is NOT_CAUGHT and fails the gate. The catalogue names the builder-owned tests
// that are expected to notice; it was derived by running the whole integration
// and adversarial suites under each mutation (EVALUATION.md records the run).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MUTATIONS, type Mutation } from '../config/mutation.js';

/** Test files expected to notice each mutation (all run against the stack). */
export const MUTATION_CATALOGUE: Readonly<Record<Mutation, readonly string[]>> =
  Object.freeze({
    bypass_final_version_check: [
      'tests/nemodots/integration/ledger/support.test.ts',
      'tests/nemodots/integration/actions/boundary.test.ts',
    ],
    drop_inherited_edges: [
      'tests/nemodots/integration/actions/boundary.test.ts',
      'tests/nemodots/integration/actions/dispatch.test.ts',
      'tests/nemodots/integration/ledger/queries.test.ts',
    ],
    ignore_fencing: [
      'tests/nemodots/integration/coordinator/claim-lease.test.ts',
      'tests/nemodots/integration/actions/boundary.test.ts',
      'tests/nemodots/integration/actions/dispatch.test.ts',
    ],
    accept_duplicate_differing_payloads: [
      'tests/nemodots/integration/actions/boundary.test.ts',
      'tests/nemodots/adversarial/concurrency/idempotency.test.ts',
    ],
    skip_effect_marker: ['tests/nemodots/integration/actions/dispatch.test.ts'],
    skip_freshness: [
      'tests/nemodots/integration/ledger/support.test.ts',
      'tests/nemodots/integration/actions/boundary.test.ts',
    ],
  });

export interface FailedTest {
  file: string;
  title: string;
}

export interface SuiteRun {
  exitCode: number | null;
  total: number;
  failed: FailedTest[];
  /** set when the run produced no report (the stack is down, vitest crashed) */
  error: string | null;
}

export type MutationExecutor = (input: {
  files: readonly string[];
  /** extra environment: NEMODOTS_MUTATION and NEMODOTS_TEST_HOOKS for a mutated run */
  env: Record<string, string>;
}) => Promise<SuiteRun>;

export type MutationStatus =
  'caught' | 'NOT_CAUGHT' | 'baseline_failed' | 'error';

export interface MutationResult {
  mutation: Mutation;
  status: MutationStatus;
  files: readonly string[];
  /** failures that appear only under the mutation (first 10) */
  catchingTests: FailedTest[];
  catchingCount: number;
  mutatedTotal: number;
  note: string | null;
}

export interface MutationReport {
  baseline: { total: number; failed: number; clean: boolean };
  results: MutationResult[];
  /** true only when every mutation is caught on a clean baseline */
  allCaught: boolean;
}

const key = (test: FailedTest) => `${test.file}\u0000${test.title}`;

export async function runMutationMatrix(
  execute: MutationExecutor,
  catalogue: Readonly<Record<string, readonly string[]>> = MUTATION_CATALOGUE,
  names: readonly Mutation[] = MUTATIONS,
): Promise<MutationReport> {
  const unionFiles = [
    ...new Set(
      names.flatMap((n) => (Object.hasOwn(catalogue, n) ? catalogue[n] : [])),
    ),
  ].sort();
  const clean = await execute({ files: unionFiles, env: {} });
  const baselineFailed = new Set(clean.failed.map(key));
  const results: MutationResult[] = [];
  for (const mutation of names) {
    const files = Object.hasOwn(catalogue, mutation) ? catalogue[mutation] : [];
    if (files.length === 0) {
      results.push({
        mutation,
        status: 'NOT_CAUGHT',
        files,
        catchingTests: [],
        catchingCount: 0,
        mutatedTotal: 0,
        note: 'no test is mapped to this mutation',
      });
      continue;
    }
    const run = await execute({
      files,
      env: { NEMODOTS_MUTATION: mutation, NEMODOTS_TEST_HOOKS: '1' },
    });
    const only = run.failed.filter((test) => !baselineFailed.has(key(test)));
    const status: MutationStatus = run.error
      ? 'error'
      : clean.error || baselineFailed.size > 0
        ? only.length > 0
          ? 'caught'
          : 'baseline_failed'
        : only.length > 0
          ? 'caught'
          : 'NOT_CAUGHT';
    results.push({
      mutation,
      status,
      files,
      catchingTests: only.slice(0, 10),
      catchingCount: only.length,
      mutatedTotal: run.total,
      note:
        run.error ??
        (status === 'baseline_failed'
          ? 'the clean baseline already fails on these files; fix it before trusting the matrix'
          : null),
    });
  }
  return {
    baseline: {
      total: clean.total,
      failed: clean.failed.length,
      clean: !clean.error && clean.failed.length === 0,
    },
    results,
    allCaught:
      !clean.error &&
      clean.failed.length === 0 &&
      results.every((result) => result.status === 'caught'),
  };
}

// ------------------------------------------------------------------ executor

interface VitestJson {
  numTotalTests: number;
  testResults: {
    name: string;
    assertionResults: { title: string; status: string }[];
  }[];
}

/**
 * Runs vitest with the integration config as a child process and reads its JSON
 * report. The environment (role URLs, ports, instance) is inherited, so the CLI
 * must itself run under `stack.mjs run`/`exec`; a mutated run adds only the two
 * mutation variables.
 */
export function vitestExecutor(options: {
  root: string;
  timeoutMs?: number;
}): MutationExecutor {
  return async ({ files, env }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nemodots-mutation-'));
    const outputFile = path.join(dir, 'report.json');
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          'npx',
          [
            'vitest',
            'run',
            '--config',
            'vitest.integration.config.ts',
            ...files,
            '--reporter=json',
            `--outputFile=${outputFile}`,
          ],
          {
            cwd: options.root,
            env: { ...process.env, DO_NOT_TRACK: '1', ...env },
            stdio: 'ignore',
          },
        );
        const timer = setTimeout(
          () => child.kill('SIGKILL'),
          options.timeoutMs ?? 600_000,
        );
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      let report: VitestJson;
      try {
        report = JSON.parse(await readFile(outputFile, 'utf8')) as VitestJson;
      } catch {
        return {
          exitCode,
          total: 0,
          failed: [],
          error: 'vitest wrote no report',
        };
      }
      const prefix = `${options.root}${path.sep}`;
      return {
        exitCode,
        total: report.numTotalTests,
        failed: report.testResults.flatMap((file) =>
          file.assertionResults
            .filter((test) => test.status === 'failed')
            .map((test) => ({
              file: file.name.startsWith(prefix)
                ? file.name.slice(prefix.length)
                : file.name,
              title: test.title,
            })),
        ),
        error: null,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
