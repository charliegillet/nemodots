#!/usr/bin/env node
// One command to a working development setup:
//
//   npm run nemodots:dev [-- --instance <name>]
//
//   1. initialise the instance if it has no database cluster yet (never on an
//      existing one: `stack.mjs init` recreates the cluster)
//   2. start PostgreSQL, Redis and the checkout API (`stack.mjs start`)
//   3. apply migrations (`nemodots:migrate`) and seed the healthy baseline
//      (`nemodots:seed`, idempotent)
//   4. run `npm run dev` (API on :4310, Vite on :5173)
//
// The server reads the role URLs it needs from .local/<instance>/stack/roles.env
// itself when NEMODOTS_INSTANCE is set, which this script sets. Nothing secret
// is printed or placed in the child's environment beyond that name. The stack
// is left running when the dev servers stop; stop it with
// `npm run nemodots:stack -- stop`.
//
// Plain Node ESM, no dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const STACK = path.join(APP_ROOT, 'scripts', 'nemodots', 'stack.mjs');
const say = (line) => console.log(`nemodots:dev ${line}`);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--instance' && argv[i + 1] !== undefined) {
      flags.instance = argv[i + 1];
      i += 1;
    } else {
      console.error(`nemodots:dev: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const instance = flags.instance ?? process.env.NEMODOTS_INSTANCE ?? 'dev';
if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(instance)) {
  console.error('nemodots:dev: instance must match ^[a-z0-9][a-z0-9-]{0,23}$');
  process.exit(2);
}

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env: { ...process.env, NEMODOTS_INSTANCE: instance, ...env },
      stdio: 'inherit',
    });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.once('error', () => resolve(1));
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

const stack = (...args) =>
  run(process.execPath, [STACK, ...args, '--instance', instance]);
const stackRun = (file) =>
  run(process.execPath, [STACK, 'run', file, '--instance', instance]);

async function main() {
  const cluster = path.join(APP_ROOT, '.local', instance, 'pg', 'PG_VERSION');
  if (!fs.existsSync(cluster)) {
    say(`instance ${instance}: initialising`);
    const code = await stack('init');
    if (code !== 0) return code;
  }
  let code = await stack('start');
  if (code !== 0) return code;
  code = await stackRun('src/server/nemodots/db/migrate.ts');
  if (code !== 0) return code;
  code = await stackRun('src/server/nemodots/sandbox/seed.ts');
  if (code !== 0) return code;
  say(`instance ${instance} is up; starting the dev servers`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  code = await run(npm, ['run', 'dev']);
  say(
    `dev servers stopped; the stack is still running (npm run nemodots:stack -- stop --instance ${instance})`,
  );
  return code;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      `nemodots:dev: ${error instanceof Error ? error.message : 'failed'}`,
    );
    process.exit(1);
  },
);
