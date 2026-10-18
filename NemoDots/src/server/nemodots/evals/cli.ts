// `npm run nemodots:evals -- <flags>` (run through scripts/nemodots/stack.mjs,
// which supplies the instance's role URLs and ports).
//
//   --suite smoke|matched|mutations   default smoke
//   --trials N                        replicates per scenario (default per suite)
//   --strategies a,b --layouts x,y --scenarios a,b   restrict the cohort
//   --seed N                          base seed (default 1)
//   --timeout-s N                     per-trial limit (default 900)
//   --spacing-s N                     pause between trials
//   --out DIR                         results root (default evals/nemodots/results)
//   --allow-instance dev              permit the shared dev instance
//   --dry-run                         print the cohort plan and exit
//   --report DIR                      rebuild summary.json/report.md from DIR/trials.jsonl
//
// Exit codes: 0 completed, 1 trial errors or a failed mutation matrix,
// 2 BLOCKED (the line starts with "BLOCKED:"). Nothing here prints a secret.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchPricing, type ModelPrice } from '../telemetry/pricing.js';
import { createBootstrapDriver } from './bootstrap-driver.js';
import { appendTrial, openCohortDir, writeSummary } from './export.js';
import { isLayoutName } from './layouts.js';
import { HostBlockedError, type EvalHost } from './host.js';
import { createLiveHost, missingLiveEnv, LIVE_ENV_NAMES } from './live-host.js';
import {
  MUTATION_CATALOGUE,
  runMutationMatrix,
  vitestExecutor,
  type MutationExecutor,
} from './mutations.js';
import { runCohort, TRIAL_SCHEMA, type TrialRecord } from './runner.js';
import { isStrategyName } from './strategies/index.js';
import { SUITES, cohortBalance, planCohort } from './suites.js';
import type { LayoutName, StrategyName } from './types.js';
import { loadScenario } from '../sandbox/manifest.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface CliOptions {
  suite: string;
  trials: number | null;
  strategies: StrategyName[] | null;
  layouts: LayoutName[] | null;
  scenarios: string[] | null;
  seed: number;
  timeoutS: number;
  spacingS: number;
  out: string;
  allowInstances: string[];
  dryRun: boolean;
  report: string | null;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function integer(
  flag: string,
  value: string | undefined,
  min: number,
  max: number,
) {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < min || n > max)
    throw new CliUsageError(
      `${flag} needs an integer between ${min} and ${max}`,
    );
  return n;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    suite: 'smoke',
    trials: null,
    strategies: null,
    layouts: null,
    scenarios: null,
    seed: 1,
    timeoutS: 900,
    spacingS: 0,
    out: path.join(APP_ROOT, 'evals', 'nemodots', 'results'),
    allowInstances: [],
    dryRun: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new CliUsageError(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case '--suite':
        options.suite = next();
        if (
          !Object.hasOwn(SUITES, options.suite) &&
          options.suite !== 'mutations'
        )
          throw new CliUsageError(
            `unknown suite ${options.suite} (smoke, matched, mutations)`,
          );
        break;
      case '--trials':
        options.trials = integer(flag, next(), 1, 100);
        break;
      case '--strategies': {
        const names = list(next());
        for (const name of names)
          if (!isStrategyName(name))
            throw new CliUsageError(`unknown strategy ${name}`);
        options.strategies = names as StrategyName[];
        break;
      }
      case '--layouts': {
        const names = list(next());
        for (const name of names)
          if (!isLayoutName(name))
            throw new CliUsageError(`unknown layout ${name}`);
        options.layouts = names as LayoutName[];
        break;
      }
      case '--scenarios':
        options.scenarios = list(next());
        break;
      case '--seed':
        options.seed = integer(flag, next(), 0, 2 ** 31 - 1);
        break;
      case '--timeout-s':
        options.timeoutS = integer(flag, next(), 30, 3600);
        break;
      case '--spacing-s':
        options.spacingS = integer(flag, next(), 0, 3600);
        break;
      case '--out':
        options.out = path.resolve(next());
        break;
      case '--allow-instance':
        options.allowInstances.push(next());
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--report':
        options.report = path.resolve(next());
        break;
      default:
        throw new CliUsageError(`unknown argument ${flag}`);
    }
  }
  return options;
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  log(line: string): void;
  /** builds the live host; tests inject a fake */
  hostFactory?: (
    options: CliOptions,
    commit: string | null,
  ) => Promise<EvalHost>;
  mutationExecutor?: MutationExecutor;
  commit?: () => string | null;
  /** NemoDots/.env by default; null reads none (hermetic tests) */
  dotEnvFile?: string | null;
  prices?: () => Promise<Record<string, ModelPrice> | null>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const gitCommit = (): string | null => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: APP_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
};

/** Fills OPENAI_* from NemoDots/.env for names that are undefined; nothing is printed. */
export function loadLiveDotEnv(
  env: Record<string, string | undefined>,
  file = path.join(APP_ROOT, '.env'),
): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !(LIVE_ENV_NAMES as readonly string[]).includes(match[1]))
      continue;
    if (env[match[1]] !== undefined) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    deps.log(`usage: ${(error as Error).message}`);
    return 1;
  }
  const commit = (deps.commit ?? gitCommit)();

  if (options.report) return rebuildReport(options.report, deps, commit);

  if (options.suite === 'mutations') return runMutations(options, deps);

  const suite = SUITES[options.suite];
  const specs = (() => {
    try {
      return planCohort({
        suite,
        trials: options.trials ?? suite.defaultTrials,
        seed: options.seed,
        scenarios: options.scenarios ?? undefined,
        strategies: options.strategies ?? undefined,
        layouts: options.layouts ?? undefined,
        versionOf: (id) => loadScenario(id).version,
      });
    } catch (error) {
      deps.log(`usage: ${(error as Error).message}`);
      return null;
    }
  })();
  if (!specs) return 1;
  const cohortId = specs[0].cohortId;
  const balance = cohortBalance(specs);
  deps.log(
    `cohort ${cohortId}: suite ${suite.name}, ${specs.length} trials (${new Set(specs.map((s) => s.scenarioId)).size} scenarios), counterbalanced ${balance.balanced ? 'exactly' : `approximately (max position spread ${balance.maxPositionSpread})`}`,
  );
  if (options.dryRun) {
    for (const spec of specs)
      deps.log(
        `  ${spec.runIndex}\t${spec.scenarioId}\tseed ${spec.seed}\t${spec.strategy}/${spec.layout}\tposition ${spec.blockIndex}`,
      );
    deps.log('dry run: nothing was started');
    return 0;
  }

  if (deps.dotEnvFile !== null) loadLiveDotEnv(deps.env, deps.dotEnvFile);
  const missing = missingLiveEnv(deps.env);
  if (missing.length > 0 && !deps.hostFactory) {
    deps.log(`BLOCKED: ${missing.join(', ')} missing`);
    return 2;
  }

  let host: EvalHost;
  try {
    host = await (deps.hostFactory ?? defaultHostFactory(deps))(
      options,
      commit,
    );
  } catch (error) {
    if (error instanceof HostBlockedError) {
      deps.log(
        error.message.startsWith('BLOCKED')
          ? error.message
          : `BLOCKED: ${error.message}`,
      );
      return 2;
    }
    deps.log(`error: ${(error as Error).name}: ${(error as Error).message}`);
    return 1;
  }

  const files = await openCohortDir(options.out, cohortId);
  const prices = await (
    deps.prices ?? (() => providerPrices(deps.env))
  )().catch(() => null);
  const records: TrialRecord[] = [];
  try {
    await runCohort(
      host,
      specs,
      { timeoutMs: options.timeoutS * 1000, prices, now: deps.now },
      {
        spacingMs: options.spacingS * 1000,
        sleep: deps.sleep,
        onTrial: async (record, index, total) => {
          records.push(record);
          await appendTrial(files, record);
          const c = record.score?.correctness;
          deps.log(
            `trial ${index + 1}/${total} ${record.spec.scenarioId} ${record.spec.strategy}/${record.spec.layout}: ${record.status}${c ? ` resolved=${c.resolved} safety=${c.safetyViolations}` : ''}${record.note ? ` (${record.note})` : ''}`,
          );
        },
      },
    );
  } finally {
    await host.close().catch(() => undefined);
  }
  const header = {
    cohortId,
    mode: host.facts.mode,
    suite: suite.name,
    model: host.facts.model,
    commit,
  };
  await writeFile(
    path.join(files.dir, 'cohort.json'),
    `${JSON.stringify({ header, options: { ...options, out: undefined }, environment: host.facts, plan: specs, balance }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const agg = await writeSummary(files, records, header);
  deps.log(
    `done: ${agg.trials} trials, ${agg.liveScored} scored live; ${agg.spend.modelCalls} model calls, ${agg.spend.promptTokens} prompt / ${agg.spend.completionTokens} completion tokens; cost ${agg.spend.usd === null ? 'unavailable' : `${agg.spend.usd.toFixed(3)} USD (${agg.spend.sources.join('+')})`}; results in ${files.dir}`,
  );
  if (records.every((r) => r.status === 'blocked')) {
    deps.log(`BLOCKED: ${records[0]?.note ?? 'every trial was blocked'}`);
    return 2;
  }
  // A trial that did not exercise its scenario is a loud finding, not a pass.
  const unexercised = records.filter(
    (r) => r.status === 'precondition_failed' || r.status === 'not_exercised',
  );
  for (const r of unexercised)
    deps.log(
      `${r.status.toUpperCase()}: ${r.spec.trialId} (${r.spec.scenarioId}): ${r.note ?? ''}`,
    );
  return records.some((r) => r.status === 'error') || unexercised.length
    ? 1
    : 0;
}

function defaultHostFactory(deps: CliDeps) {
  return async (options: CliOptions, commit: string | null) =>
    createLiveHost({
      env: deps.env,
      commit,
      allowInstances: options.allowInstances,
      driver: createBootstrapDriver({ env: deps.env }),
    });
}

async function providerPrices(env: Record<string, string | undefined>) {
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  const result = await fetchPricing({ baseUrl, apiKey });
  return result.prices;
}

async function rebuildReport(
  dir: string,
  deps: CliDeps,
  commit: string | null,
) {
  const file = path.join(dir, 'trials.jsonl');
  if (!existsSync(file)) {
    deps.log(`usage: ${file} does not exist`);
    return 1;
  }
  const records = (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrialRecord);
  if (records.some((r) => r.schema !== TRIAL_SCHEMA)) {
    deps.log(`usage: ${file} holds records of another schema`);
    return 1;
  }
  const first = records[0];
  const agg = await writeSummary({ dir, trials: file }, records, {
    cohortId: first?.spec.cohortId ?? path.basename(dir),
    mode: first?.mode ?? 'unknown',
    suite: 'rebuilt',
    model: first?.environment.model ?? 'unknown',
    commit,
  });
  deps.log(`rebuilt ${agg.trials} trials into ${dir}`);
  return 0;
}

async function runMutations(
  options: CliOptions,
  deps: CliDeps,
): Promise<number> {
  const execute = deps.mutationExecutor ?? vitestExecutor({ root: APP_ROOT });
  deps.log(
    `mutation matrix: ${Object.keys(MUTATION_CATALOGUE).length} mutations (clean baseline first)`,
  );
  const report = await runMutationMatrix(execute);
  for (const row of report.results)
    deps.log(
      `${row.status === 'caught' ? 'CAUGHT    ' : row.status}\t${row.mutation}\t${row.catchingCount} test(s) fail only under it${row.note ? ` (${row.note})` : ''}`,
    );
  deps.log(
    `baseline: ${report.baseline.total} tests, ${report.baseline.failed} failing; ${report.allCaught ? 'every mutation is caught' : 'NOT every mutation is caught'}`,
  );
  await mkdir(options.out, { recursive: true });
  const file = path.join(
    options.out,
    `mutations-${(deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  deps.log(`written ${file}`);
  return report.allCaught ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCli(process.argv.slice(2), {
    env: process.env,
    log: (line) => console.log(line),
  })
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        `error: ${(error as Error).name}: ${(error as Error).message}`,
      );
      process.exit(1);
    });
}
