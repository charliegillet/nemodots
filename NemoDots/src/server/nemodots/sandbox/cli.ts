// Developer/test command line for the sandbox:
//
//   cli.ts seed [--reset-config]
//   cli.ts inject --scenario <id> [--seed <n>] [--dir <path>] [--timeout-ms <n>]
//   cli.ts probe [--window-ms <n>]
//   cli.ts notify-proposed --key <config key>   (emits NOTIFY nemodots_action_proposed)
//   cli.ts scenarios                            (lists the development set)
//
// Run through `npm run nemodots:*` or directly:
//   node --import tsx src/server/nemodots/sandbox/cli.ts inject --scenario cache_schema_mismatch --seed 1
// Role URLs and the probe secret come from the environment or, when absent,
// from .local/<NEMODOTS_INSTANCE>/stack/roles.env; nothing secret is printed.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { CONFIG_MEMBER_KEY_PATTERN } from '../contracts/ids.js';
import { Injector, notifyProposed } from './injector.js';
import { defaultScenarioDir, listScenarios, loadScenario } from './manifest.js';
import { createProbe } from './probe.js';
import { loadConfig, roleUrl } from './runtime-env.js';
import { seedCheckout } from './seed.js';

function parseFlags(argv: string[], allowed: string[]) {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--') || !allowed.includes(arg.slice(2)))
      throw new UsageError(`unknown argument ${arg}`);
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

class UsageError extends Error {}

const pool = (url: string, name: string, max = 3) =>
  new pg.Pool({ connectionString: url, max, application_name: name });

async function inject(argv: string[]) {
  const flags = parseFlags(argv, ['scenario', 'seed', 'dir', 'timeout-ms']);
  if (typeof flags.scenario !== 'string')
    throw new UsageError('inject needs --scenario <id>');
  const seed = flags.seed === undefined ? 1 : Number(flags.seed);
  if (!Number.isInteger(seed) || seed < 0)
    throw new UsageError('--seed must be a non-negative integer');
  const timeoutMs =
    flags['timeout-ms'] === undefined ? 120_000 : Number(flags['timeout-ms']);
  const dir =
    typeof flags.dir === 'string'
      ? path.resolve(flags.dir)
      : defaultScenarioDir();
  const manifest = loadScenario(flags.scenario, dir);
  const url = roleUrl(loadConfig(), 'injector');
  const injectorPool = pool(url, 'nemodots-injector-cli', 4);
  try {
    const run = await new Injector({
      pool: injectorPool,
      listenUrl: url,
    }).start(manifest, seed);
    const waiting = run.steps.filter((s) => s.trigger !== 'immediate').length;
    if (waiting)
      console.log(
        `inject: run started, ${waiting} step(s) wait for a delay or a proposal (timeout ${timeoutMs} ms)`,
      );
    const summary = await Promise.race([
      run.done,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs),
      ),
    ]);
    if (!summary) {
      await run.cancel();
      console.error('inject: timed out; remaining steps were cancelled');
      return 1;
    }
    for (const step of summary.steps)
      console.log(
        `inject: step ${step.index} ${step.status}${step.error ? ` (${step.error})` : ''}`,
      );
    console.log(`inject: ${summary.status}`);
    return summary.status === 'completed' ? 0 : 1;
  } finally {
    await injectorPool.end();
  }
}

async function probe(argv: string[]) {
  const flags = parseFlags(argv, ['window-ms']);
  const config = loadConfig();
  if (!config.probe.secret)
    throw new UsageError('NEMODOTS_PROBE_SECRET is not set');
  const windowMs =
    flags['window-ms'] === undefined
      ? config.probe.windowMs
      : Number(flags['window-ms']);
  const verifier = pool(roleUrl(config, 'verifier'), 'nemodots-probe-cli');
  try {
    const result = await createProbe({
      verifier,
      checkoutUrl: config.checkout.url,
      probeSecret: config.probe.secret,
      windowMs,
    }).execute();
    for (const invariant of result.invariants)
      console.log(`probe: ${invariant.ok ? 'ok  ' : 'FAIL'} ${invariant.name}`);
    console.log(
      `probe: health ${result.healthWindow.okSamples}/${result.healthWindow.samples} samples ok`,
    );
    console.log(`probe: ${result.verdict.toUpperCase()}`);
    return result.verdict === 'pass' ? 0 : 1;
  } finally {
    await verifier.end();
  }
}

async function notify(argv: string[]) {
  const flags = parseFlags(argv, ['key']);
  if (
    typeof flags.key !== 'string' ||
    !CONFIG_MEMBER_KEY_PATTERN.test(
      flags.key.replace(/^checkout\.config\//, ''),
    )
  )
    throw new UsageError('notify-proposed needs --key <config key>');
  const appPool = pool(roleUrl(loadConfig(), 'app'), 'nemodots-notify-cli', 1);
  try {
    await notifyProposed(appPool, flags.key);
    console.log(`notify-proposed: sent for ${flags.key}`);
    return 0;
  } finally {
    await appPool.end();
  }
}

async function seed(argv: string[]) {
  const flags = parseFlags(argv, ['reset-config']);
  const adminPool = pool(
    roleUrl(loadConfig(), 'admin'),
    'nemodots-seed-cli',
    2,
  );
  try {
    const summary = await seedCheckout(adminPool, {
      restoreConfig: flags['reset-config'] === true,
    });
    console.log(
      `seed: ${summary.products} listed products, ${summary.orders} orders, config inserted ${summary.configInserted.length}, restored ${summary.configRestored.length}`,
    );
    return 0;
  } finally {
    await adminPool.end();
  }
}

export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'seed':
      return seed(rest);
    case 'inject':
      return inject(rest);
    case 'probe':
      return probe(rest);
    case 'notify-proposed':
      return notify(rest);
    case 'scenarios':
      for (const id of listScenarios()) console.log(id);
      return 0;
    default:
      throw new UsageError(
        'usage: cli.ts <seed|inject|probe|notify-proposed|scenarios> [options]',
      );
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked && pathToFileURL(invoked).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `sandbox cli: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(error instanceof UsageError ? 2 : 1);
    },
  );
}
