// Gate 0 cases that need a clean install:
//   G0.2 `npm ci` reproduces from the lockfile and leaves it unchanged
//   G0.3 typecheck, lint, test, build and format checks exit 0 on that install
//   G0.6 built frontend/server assets contain no secret values (counts only)
//
// Verify-only: the shared checkout's node_modules is owned by one agent and
// is never touched. The tree is copied (minus node_modules, .local, dist,
// .git and every real .env) to .local/acceptance/g0/install-copy and
// installed there with a scrubbed environment (no Crusoe/Intelligence keys).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  appendManifest,
  cleanEnv,
  ensureScratch,
  makeRedactor,
  run,
  sha256File,
  SCRATCH,
  type RunResult,
} from './helpers/common.js';
import { collectNeedles, scan, summarize } from './helpers/secrets.js';

const COPY = path.join(SCRATCH, 'install-copy');
const results = new Map<string, RunResult>();
let redact: (t: string) => string = (t) => t;
let lockBefore = '';
let pkgBefore = '';
let rolesFiles: string[] = [];

function sh(command: string, args: string[]) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim() };
}

async function step(
  name: string,
  command: string,
  args: string[],
  timeoutMs: number,
) {
  const cached = results.get(name);
  if (cached) return cached;
  const result = await run(command, args, {
    cwd: COPY,
    env: cleanEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }),
    logName: `g0-${name}.log`,
    timeoutMs,
    redact,
  });
  results.set(name, result);
  appendManifest({
    gate: 0,
    step: name,
    command: `${command} ${args.join(' ')}`,
    exitCode: result.code,
    ms: result.ms,
    timedOut: result.timedOut,
    log: path.relative(APP_ROOT, result.logFile),
  });
  return result;
}

const failureText = (name: string, r: RunResult) =>
  `${name} exit ${r.code}${r.timedOut ? ' (timed out)' : ''} after ${r.ms} ms; log ${path.relative(APP_ROOT, r.logFile)}; tail:\n${r.tail.slice(-1500)}`;

beforeAll(async () => {
  rolesFiles = [];
  const local = path.join(APP_ROOT, '.local');
  if (existsSync(local))
    for (const n of (await import('node:fs')).readdirSync(local)) {
      const f = path.join(local, n, 'stack', 'roles.env');
      if (existsSync(f)) rolesFiles.push(f);
    }
  redact = makeRedactor(collectNeedles(rolesFiles).map((n) => n.value));
  ensureScratch();
  rmSync(COPY, { recursive: true, force: true });
  mkdirSync(COPY, { recursive: true });
  const rsync = sh('rsync', [
    '-a',
    '--include=.env.example',
    '--exclude=node_modules',
    '--exclude=.local',
    '--exclude=dist',
    '--exclude=.git',
    '--exclude=.env',
    '--exclude=.env.*',
    '--exclude=data',
    '--exclude=artifacts',
    '--exclude=.opendots',
    '--exclude=playwright-report',
    '--exclude=test-results',
    `${APP_ROOT}/`,
    `${COPY}/`,
  ]);
  if (rsync.code !== 0) throw new Error(`rsync failed (${rsync.code})`);
  lockBefore = sha256File(path.join(COPY, 'package-lock.json'));
  pkgBefore = sha256File(path.join(COPY, 'package.json'));
  expect(lockBefore).toBe(sha256File(path.join(APP_ROOT, 'package-lock.json')));
}, 300_000);

afterAll(() => {
  // The copy (with its node_modules) is scratch under the gitignored .local.
  if (process.env.G0_KEEP_COPY !== '1')
    rmSync(COPY, { recursive: true, force: true });
});

describe('G0.2 npm ci reproducibility', () => {
  it('[G0.2] records toolchain versions (Node >=24, npm present)', () => {
    const npm = sh('npm', ['--version']);
    expect(npm.code).toBe(0);
    appendManifest({
      gate: 0,
      step: 'toolchain',
      node: process.version,
      npm: npm.out,
      lockfileSha256: lockBefore,
      packageJsonSha256: pkgBefore,
    });
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(
      24,
    );
  });

  it('[G0.2] `npm ci` exits 0 from the lockfile on a clean tree', async () => {
    let r = await step(
      'npm-ci',
      'npm',
      ['ci', '--no-audit', '--no-fund', '--prefer-offline'],
      600_000,
    );
    if (r.code !== 0) {
      // DEPENDENCIES.md: one transient cold-cache failure is documented;
      // retry exactly once and report the first failure in the log.
      results.delete('npm-ci');
      r = await step(
        'npm-ci',
        'npm',
        ['ci', '--no-audit', '--no-fund', '--prefer-offline'],
        600_000,
      );
    }
    expect(r.code, failureText('npm ci', r)).toBe(0);
    expect(existsSync(path.join(COPY, 'node_modules', 'pg'))).toBe(true);
    expect(existsSync(path.join(COPY, 'node_modules', 'redis'))).toBe(true);
  });

  it('[G0.2] `npm ci` leaves package.json and package-lock.json byte-identical', () => {
    expect(sha256File(path.join(COPY, 'package-lock.json'))).toBe(lockBefore);
    expect(sha256File(path.join(COPY, 'package.json'))).toBe(pkgBefore);
  });

  it('[G0.2] installed tree has no missing or invalid top-level packages', async () => {
    const r = await step('npm-ls', 'npm', ['ls', '--depth=0'], 120_000);
    expect(r.code, failureText('npm ls --depth=0', r)).toBe(0);
  });

  it('[G0.2] lockfile in the shared checkout is unchanged by this run', () => {
    expect(sha256File(path.join(APP_ROOT, 'package-lock.json'))).toBe(
      lockBefore,
    );
  });
});

describe('G0.3 upstream verification commands on the clean install', () => {
  const gate = async (name: string, script: string, ms: number) => {
    const ci = results.get('npm-ci');
    expect(ci?.code, 'npm ci did not succeed; cannot run ' + script).toBe(0);
    const r = await step(name, 'npm', ['run', script], ms);
    expect(r.code, failureText(`npm run ${script}`, r)).toBe(0);
  };

  it('[G0.3] npm run typecheck exits 0', () =>
    gate('typecheck', 'typecheck', 600_000));
  it('[G0.3] npm run lint exits 0', () => gate('lint', 'lint', 600_000));
  it('[G0.3] npm test exits 0 without the stack or any credential', () =>
    gate('test', 'test', 900_000));
  it('[G0.3] npm run build exits 0', () => gate('build', 'build', 900_000));
  it('[G0.3] npm run check-format exits 0 (covers every changed file)', () =>
    gate('check-format', 'check-format', 300_000));

  it('[G0.3] build output exists: frontend bundle and compiled server', () => {
    expect(results.get('build')?.code, 'build did not succeed').toBe(0);
    expect(existsSync(path.join(COPY, 'dist', 'index.html'))).toBe(true);
    expect(
      existsSync(path.join(COPY, 'dist', 'server', 'server', 'index.js')),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          COPY,
          'dist',
          'server',
          'server',
          'nemodots',
          'db',
          'migrate.js',
        ),
      ),
    ).toBe(true);
    // Migrations must be compiled next to the runner (migrate.ts discovers them).
    expect(
      existsSync(
        path.join(
          COPY,
          'dist',
          'server',
          'server',
          'nemodots',
          'db',
          'migrations',
          '0001_bootstrap.js',
        ),
      ),
    ).toBe(true);
  });
});

describe('G0.6 built assets carry no secrets', () => {
  it('[G0.6] dist/ of the clean build has zero secret-value matches', () => {
    expect(results.get('build')?.code, 'build did not succeed').toBe(0);
    const needles = collectNeedles(rolesFiles);
    expect(
      needles.length,
      'no secret values available to scan for (cannot prove absence)',
    ).toBeGreaterThan(0);
    const report = scan(needles, {
      roots: [path.join(COPY, 'dist')],
      skipDirs: new Set(),
    });
    expect(report.filesScanned).toBeGreaterThan(10);
    expect(summarize(report)).toBe('no matches');
    // Extra pins: the Crusoe key and the PG role URLs never reach the browser bundle.
    const bundle = path.join(COPY, 'dist', 'assets');
    expect(existsSync(bundle) && statSync(bundle).isDirectory()).toBe(true);
    const assetReport = scan(needles, {
      roots: [bundle],
      skipDirs: new Set(),
      extensions: new Set(['.js', '.css', '.html', '.map', '.json']),
    });
    expect(assetReport.filesScanned).toBeGreaterThan(0);
    expect(summarize(assetReport)).toBe('no matches');
    // Server-only variable names must not be referenced by the browser bundle.
    const forbiddenNames = [
      'NEMODOTS_PG_URL_',
      'NEMODOTS_PROBE_SECRET',
      'CRUSOE_API_KEY',
    ];
    let nameHits = 0;
    for (const file of (
      spawnSync('find', [bundle, '-type', 'f', '-name', '*.js'], {
        encoding: 'utf8',
      }).stdout ?? ''
    )
      .split('\n')
      .filter(Boolean)) {
      const text = readFileSync(file, 'utf8');
      for (const n of forbiddenNames) if (text.includes(n)) nameHits += 1;
    }
    expect(nameHits, 'browser bundle references server-only secret names').toBe(
      0,
    );
  });
});
