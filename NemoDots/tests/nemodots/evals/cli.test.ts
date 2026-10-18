import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliUsageError,
  parseCliArgs,
  runCli,
  type CliDeps,
} from '../../../src/server/nemodots/evals/cli.js';
import { HostBlockedError } from '../../../src/server/nemodots/evals/host.js';
import { MUTATIONS } from '../../../src/server/nemodots/config/mutation.js';
import type { MutationExecutor } from '../../../src/server/nemodots/evals/mutations.js';
import { FakeHost } from './fake-host.js';

let out: string;
beforeEach(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'evals-cli-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

const SECRET = 'sk-test-secret-value-123456';
function deps(extra: Partial<CliDeps> = {}) {
  const lines: string[] = [];
  const base: CliDeps = {
    env: {
      OPENAI_API_KEY: SECRET,
      OPENAI_BASE_URL: 'https://api.example.test/v1',
      OPENAI_MODEL: 'm',
    },
    log: (line) => lines.push(line),
    commit: () => 'abc123',
    dotEnvFile: null,
    prices: async () => null,
    sleep: async () => {},
    ...extra,
  };
  return { deps: base, lines };
}

describe('argument parsing', () => {
  it('defaults to the smoke suite and validates every flag', () => {
    expect(parseCliArgs([])).toMatchObject({
      suite: 'smoke',
      trials: null,
      seed: 1,
      timeoutS: 900,
      dryRun: false,
    });
    expect(
      parseCliArgs([
        '--suite',
        'matched',
        '--trials',
        '3',
        '--strategies',
        'selective,dag-restart',
        '--layouts',
        'cache_aware',
        '--scenarios',
        'a,b',
        '--seed',
        '7',
        '--timeout-s',
        '60',
        '--spacing-s',
        '5',
        '--allow-instance',
        'dev',
        '--dry-run',
      ]),
    ).toMatchObject({
      suite: 'matched',
      trials: 3,
      strategies: ['selective', 'dag-restart'],
      layouts: ['cache_aware'],
      scenarios: ['a', 'b'],
      seed: 7,
      timeoutS: 60,
      spacingS: 5,
      allowInstances: ['dev'],
      dryRun: true,
    });
  });

  it.each([
    [['--suite', 'huge']],
    [['--suite', 'constructor']],
    [['--suite', '__proto__']],
    [['--trials', '0']],
    [['--trials', 'x']],
    [['--strategies', 'selective,graphiti']],
    [['--layouts', 'fancy']],
    [['--timeout-s', '5']],
    [['--bogus']],
    [['--seed']],
  ])('rejects %j', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
  });
});

describe('runCli', () => {
  it('smoke: runs one trial, exports the raw record, the summary and the report, and exits 0', async () => {
    const host = new FakeHost();
    const { deps: d, lines } = deps({ hostFactory: async () => host });
    const code = await runCli(['--suite', 'smoke', '--out', out], d);
    expect(code).toBe(0);
    const [cohort] = await readdir(out);
    const dir = path.join(out, cohort);
    expect(
      (await readFile(path.join(dir, 'trials.jsonl'), 'utf8'))
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    for (const file of ['summary.json', 'report.md', 'cohort.json'])
      expect((await readdir(dir)).includes(file)).toBe(true);
    const meta = JSON.parse(
      await readFile(path.join(dir, 'cohort.json'), 'utf8'),
    );
    expect(meta.header.commit).toBe('abc123');
    expect(meta.options.out).toBeUndefined();
    expect(lines.some((l) => l.startsWith('done:'))).toBe(true);
    expect(host.calls).toContain('close');
  });

  it('dry run prints the plan and starts nothing', async () => {
    const { deps: d, lines } = deps({
      hostFactory: async () => {
        throw new Error('must not be called');
      },
    });
    expect(
      await runCli(
        ['--suite', 'matched', '--trials', '1', '--dry-run', '--out', out],
        d,
      ),
    ).toBe(0);
    expect(lines.filter((l) => l.includes('diverging_edges')).length).toBe(5);
    expect(lines.at(-1)).toContain('nothing was started');
    expect(await readdir(out)).toEqual([]);
  });

  it('without live credentials it prints BLOCKED naming the missing variables and exits 2', async () => {
    const { deps: d, lines } = deps({ env: { NEMODOTS_INSTANCE: 'ci-evals' } });
    expect(await runCli(['--out', out], d)).toBe(2);
    expect(lines.at(-1)).toBe(
      'BLOCKED: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL missing',
    );
    expect(await readdir(out)).toEqual([]);
  });

  it('a host that blocks (a missing hook) exits 2 and every trial is recorded as blocked', async () => {
    const { deps: d, lines } = deps({
      hostFactory: async () => new FakeHost({ blockAt: 0 }),
    });
    const code = await runCli(
      [
        '--suite',
        'matched',
        '--trials',
        '1',
        '--scenarios',
        'healthy',
        '--out',
        out,
      ],
      d,
    );
    expect(code).toBe(2);
    const [cohort] = await readdir(out);
    const rows = (
      await readFile(path.join(out, cohort, 'trials.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === 'blocked')).toBe(true);
    expect(lines.some((l) => l.startsWith('BLOCKED:'))).toBe(true);
  });

  it('a factory that throws HostBlockedError is BLOCKED (exit 2), another error exits 1', async () => {
    const blocked = deps({
      hostFactory: async () => {
        throw new HostBlockedError(
          ['NEMODOTS_INSTANCE'],
          'refusing the shared dev instance',
        );
      },
    });
    expect(await runCli(['--out', out], blocked.deps)).toBe(2);
    expect(blocked.lines.some((l) => l.startsWith('BLOCKED:'))).toBe(true);
    const broken = deps({
      hostFactory: async () => {
        throw new Error('boom');
      },
    });
    expect(await runCli(['--out', out], broken.deps)).toBe(1);
  });

  it('trial errors exit 1 but are still exported', async () => {
    const { deps: d } = deps({
      hostFactory: async () => new FakeHost({ errorAt: 0 }),
    });
    expect(await runCli(['--out', out], d)).toBe(1);
    const [cohort] = await readdir(out);
    expect(
      await readFile(path.join(out, cohort, 'trials.jsonl'), 'utf8'),
    ).toContain('"status":"error"');
  });

  it('a scenario whose symptom never appeared exits 1, names the trial, and is exported unscored', async () => {
    const { deps: d, lines } = deps({
      hostFactory: async () => new FakeHost({ preconditionFailsAt: 0 }),
    });
    expect(await runCli(['--out', out], d)).toBe(1);
    expect(lines.join('\n')).toMatch(
      /PRECONDITION_FAILED: .*scenario_precondition_failed/,
    );
    const [cohort] = await readdir(out);
    const raw = await readFile(path.join(out, cohort, 'trials.jsonl'), 'utf8');
    expect(raw).toContain('"status":"precondition_failed"');
  });

  it('a dependent step that never fired exits 1 as not exercised', async () => {
    const { deps: d, lines } = deps({
      hostFactory: async () => new FakeHost({ notTriggeredAt: 0 }),
    });
    expect(await runCli(['--out', out], d)).toBe(1);
    expect(lines.join('\n')).toMatch(
      /NOT_EXERCISED: .*dependent_step_not_triggered/,
    );
  });

  it('never prints a credential', async () => {
    const { deps: d, lines } = deps({
      hostFactory: async () => new FakeHost(),
    });
    await runCli(['--out', out], d);
    expect(lines.join('\n')).not.toContain(SECRET);
    const [cohort] = await readdir(out);
    for (const file of await readdir(path.join(out, cohort)))
      expect(
        await readFile(path.join(out, cohort, file), 'utf8'),
      ).not.toContain(SECRET);
  });

  it('--report rebuilds the summary from an existing trials.jsonl', async () => {
    const { deps: d } = deps({ hostFactory: async () => new FakeHost() });
    await runCli(['--out', out], d);
    const [cohort] = await readdir(out);
    const dir = path.join(out, cohort);
    await rm(path.join(dir, 'report.md'));
    const again = deps();
    expect(await runCli(['--report', dir], again.deps)).toBe(0);
    expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toContain(
      '# Evaluation report',
    );
    expect(await runCli(['--report', path.join(dir, 'nope')], again.deps)).toBe(
      1,
    );
  });

  it('usage errors exit 1 without starting anything', async () => {
    const { deps: d, lines } = deps();
    expect(await runCli(['--suite', 'nope'], d)).toBe(1);
    expect(lines[0]).toContain('usage');
    expect(
      await runCli(
        ['--strategies', 'broad-restart', '--suite', 'smoke', '--dry-run'],
        d,
      ),
    ).toBe(1);
  });

  it('--suite mutations: exit 0 only when every mutation is caught, and the report is written', async () => {
    const caught: MutationExecutor = async ({ env }) =>
      env.NEMODOTS_MUTATION
        ? {
            exitCode: 1,
            total: 5,
            failed: [{ file: 'f', title: `t-${env.NEMODOTS_MUTATION}` }],
            error: null,
          }
        : { exitCode: 0, total: 5, failed: [], error: null };
    const ok = deps({ mutationExecutor: caught });
    expect(await runCli(['--suite', 'mutations', '--out', out], ok.deps)).toBe(
      0,
    );
    expect(ok.lines.filter((l) => l.startsWith('CAUGHT'))).toHaveLength(
      MUTATIONS.length,
    );
    expect((await readdir(out)).some((f) => f.startsWith('mutations-'))).toBe(
      true,
    );

    const missed: MutationExecutor = async ({ env }) => ({
      exitCode: 0,
      total: 5,
      failed:
        env.NEMODOTS_MUTATION === 'skip_freshness'
          ? []
          : env.NEMODOTS_MUTATION
            ? [{ file: 'f', title: 'x' }]
            : [],
      error: null,
    });
    const bad = deps({ mutationExecutor: missed });
    expect(await runCli(['--suite', 'mutations', '--out', out], bad.deps)).toBe(
      1,
    );
    expect(
      bad.lines.some(
        (l) => l.includes('NOT_CAUGHT') && l.includes('skip_freshness'),
      ),
    ).toBe(true);
  });
});
