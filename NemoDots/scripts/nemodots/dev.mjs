#!/usr/bin/env node
// Brings one NemoDots stack instance to a runnable state: init (first time),
// start, migrate, seed. It runs only the repository's own npm scripts, so the
// instance and ports come from NEMODOTS_INSTANCE / NEMODOTS_*_PORT exactly as
// they do for those scripts. It prints names and exit codes, never values.
//
//   node scripts/nemodots/dev.mjs [--no-seed] [--worker]
//
// --worker also starts `npm run nemodots:worker` in the foreground after the
// stack is ready. Start the server separately with `npm run dev` or
// `npm start`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !['--no-seed', '--worker'].includes(a));
if (unknown.length) {
  console.error(`dev: unknown arguments: ${unknown.join(' ')}`);
  process.exit(2);
}
const instance = process.env.NEMODOTS_INSTANCE || 'dev';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(label, script, extra = []) {
  console.log(`dev: ${label}`);
  const result = spawnSync(npm, ['run', '--silent', script, ...extra], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`dev: ${label} failed (exit ${result.status ?? 'signal'})`);
    process.exit(result.status ?? 1);
  }
}

const initialised = fs.existsSync(
  path.join(ROOT, '.local', instance, 'stack', 'instance.json'),
);
if (!initialised) step(`init ${instance}`, 'nemodots:stack', ['--', 'init']);
step('start stack', 'nemodots:stack', ['--', 'start']);
step('migrate', 'nemodots:migrate');
if (!args.has('--no-seed')) step('seed', 'nemodots:seed');
console.log(
  'dev: stack ready. Start the server with `npm run dev` (or `npm run build && npm start`).',
);
if (args.has('--worker')) step('worker (Ctrl-C to stop)', 'nemodots:worker');
