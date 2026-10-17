#!/usr/bin/env node
// Appends the non-secret NEMODOTS_* settings of one stack instance to
// NemoDots/.env (instance, ports, Redis prefix, inference mode).
//
//   node scripts/nemodots/write-env.mjs [--instance <name>] [--pg-port <n>]
//        [--redis-port <n>] [--checkout-port <n>] [--mode live|fixture|blocked]
//        [--file <path>]
//
// It never writes role URLs or the probe secret (those stay in
// .local/<instance>/stack/roles.env) and never prints any value from the file
// it edits: only the names it wrote or kept. The managed block is delimited by
// markers and replaced on re-run; every other line is preserved byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const BEGIN = '# >>> nemodots (scripts/nemodots/write-env.mjs; non-secret values only)';
const END = '# <<< nemodots';
const FORBIDDEN_PORTS = new Set([5432, 6379]);
const SECRET_NAMES = /^NEMODOTS_(PG_URL_|PROBE_SECRET)/;

function fail(message, code = 2) {
  console.error(`write-env: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const names = ['--instance', '--pg-port', '--redis-port', '--checkout-port', '--mode', '--file'];
    if (!names.includes(arg)) fail(`unknown argument ${arg}`);
    if (argv[i + 1] === undefined) fail(`${arg} needs a value`);
    flags[arg.slice(2)] = argv[i + 1];
    i += 1;
  }
  return flags;
}

function port(name, raw, fallback) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    fail(`${name} must be a port number`);
  if (FORBIDDEN_PORTS.has(value))
    fail(`${name} ${value} is refused: 5432/6379 belong to the user's own PostgreSQL/Redis`);
  return value;
}

const flags = parseArgs(process.argv.slice(2));
const instance = flags.instance ?? 'dev';
if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(instance))
  fail('instance must match ^[a-z0-9][a-z0-9-]{0,23}$');
const mode = flags.mode ?? 'live';
if (!['live', 'fixture', 'blocked'].includes(mode))
  fail('mode must be live, fixture or blocked');

// Ports default to what stack.mjs recorded for the instance, if it exists.
let meta = {};
const metaFile = path.join(APP_ROOT, '.local', instance, 'stack', 'instance.json');
if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const pgPort = port('--pg-port', flags['pg-port'], meta.pgPort ?? 55432);
const redisPort = port('--redis-port', flags['redis-port'], meta.redisPort ?? 56379);
const checkoutPort = port('--checkout-port', flags['checkout-port'], meta.checkoutPort ?? 4510);

const values = {
  NEMODOTS_INSTANCE: instance,
  NEMODOTS_PG_HOST: '127.0.0.1',
  NEMODOTS_PG_PORT: String(pgPort),
  NEMODOTS_PG_DATABASE: 'nemodots',
  NEMODOTS_REDIS_PORT: String(redisPort),
  NEMODOTS_REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
  NEMODOTS_REDIS_PREFIX: `nemodots:${instance}`,
  NEMODOTS_CHECKOUT_PORT: String(checkoutPort),
  NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${checkoutPort}`,
  NEMODOTS_INFERENCE_MODE: mode,
};
for (const name of Object.keys(values))
  if (SECRET_NAMES.test(name)) fail(`refusing to write secret name ${name}`, 1);

const file = path.resolve(flags.file ?? path.join(APP_ROOT, '.env'));
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

// Drop a previous managed block; keep everything else untouched.
const lines = existing.split('\n');
const kept = [];
let inBlock = false;
for (const line of lines) {
  if (line === BEGIN) inBlock = true;
  else if (line === END && inBlock) inBlock = false;
  else if (!inBlock) kept.push(line);
}
if (inBlock) fail(`${path.basename(file)} has an unterminated nemodots block; fix it by hand`, 1);

// A name the user set outside the block wins; it is reported, not overwritten.
const userNames = new Set(
  kept
    .map((line) => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1])
    .filter(Boolean),
);
const written = [];
const skipped = [];
const block = [BEGIN];
for (const [name, value] of Object.entries(values)) {
  if (userNames.has(name)) skipped.push(name);
  else {
    block.push(`${name}=${value}`);
    written.push(name);
  }
}
block.push(END);

let body = kept.join('\n');
if (body && !body.endsWith('\n')) body += '\n';
const output = `${body}${block.join('\n')}\n`;
const tmp = `${file}.nemodots-${process.pid}.tmp`;
const mode0600 = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
fs.writeFileSync(tmp, output, { mode: mode0600 });
fs.renameSync(tmp, file);
console.log(
  `write-env: ${path.relative(APP_ROOT, file) || file}: wrote ${written.join(', ') || 'nothing'}${
    skipped.length ? `; kept user-set ${skipped.join(', ')}` : ''
  }`,
);
