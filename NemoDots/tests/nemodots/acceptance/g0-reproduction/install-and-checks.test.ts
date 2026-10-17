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
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
import {
  collectNeedles,
  scan,
  summarize,
  type Needle,
} from './helpers/secrets.js';

const COPY = path.join(SCRATCH, 'install-copy');
const results = new Map<string, RunResult>();
let redact: (t: string) => string = (t) => t;
let lockBefore = '';
let pkgBefore = '';
let rolesFiles: string[] = [];

// Canary secrets present at build time (see the build case and G0.6).
const CANARY_PLAIN = [
  'OPENAI_API_KEY',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
  'CRUSOE_API_KEY',
  'NEMODOTS_PROBE_SECRET',
];
const CANARY_URLS = ['ADMIN', 'APP', 'CHECKOUT', 'INJECTOR', 'VERIFIER'].map(
  (role) => `NEMODOTS_PG_URL_${role}`,
);
interface Canaries {
  env: Record<string, string>;
  needles: Needle[];
}
let canaries: Canaries | undefined;

/** Fresh random canary values for every secret name plus VITE_-prefixed twins. */
function makeCanaries(): Canaries {
  const env: Record<string, string> = {};
  const needles: Needle[] = [];
  const add = (name: string, secret: string, value = secret) => {
    env[name] = value;
    needles.push({ name, value: secret });
  };
  const fresh = (name: string) =>
    `cnry-${name.toLowerCase()}-${randomBytes(12).toString('hex')}`;
  for (const name of CANARY_PLAIN) {
    add(name, fresh(name));
    add(`VITE_${name}`, fresh(`vite-${name}`));
  }
  for (const name of CANARY_URLS) {
    for (const prefix of ['', 'VITE_']) {
      const password = fresh(`${prefix}${name}`);
      const role = name.replace('NEMODOTS_PG_URL_', 'nemodots_').toLowerCase();
      add(
        `${prefix}${name}`,
        password,
        `postgres://${role}:${password}@127.0.0.1:55432/nemodots`,
      );
    }
  }
  return { env, needles };
}

function sh(command: string, args: string[]) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim() };
}

async function step(
  name: string,
  command: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
) {
  const cached = results.get(name);
  if (cached) return cached;
  const result = await run(command, args, {
    cwd: COPY,
    env: cleanEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...extraEnv }),
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

/** File paths named as failing in a tool log (paths only, relative to the copy). */
function failingFiles(
  kind: 'tsc' | 'eslint' | 'prettier' | 'vitest',
  log: string,
) {
  const files = new Set<string>();
  const rel = (f: string) =>
    f.startsWith(COPY) ? f.slice(COPY.length + 1) : f.replace(/^\.\//, '');
  for (const line of log.split('\n')) {
    let m: RegExpExecArray | null;
    if (kind === 'tsc') m = /^(\S+?)\(\d+,\d+\): error/.exec(line);
    else if (kind === 'eslint') m = /^(\/\S+\.(?:ts|tsx|js|mjs))$/.exec(line);
    else if (kind === 'prettier') m = /^\[warn\] (\S+)$/.exec(line);
    else m = /^\s*FAIL\s+(\S+\.test\.ts)/.exec(line);
    if (m) files.add(rel(m[1]));
  }
  return [...files].sort();
}

const readLog = (name: string) => {
  const r = results.get(name);
  return r && existsSync(r.logFile) ? readFileSync(r.logFile, 'utf8') : '';
};

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
  it('[G0.3] npm run build exits 0 with canary secrets in the build environment and a .env file', async () => {
    const ci = results.get('npm-ci');
    expect(ci?.code, 'npm ci did not succeed; cannot run build').toBe(0);
    canaries = makeCanaries();
    redact = makeRedactor([
      ...collectNeedles(rolesFiles).map((n) => n.value),
      ...canaries.needles.map((n) => n.value),
    ]);
    // A .env inside the scratch copy (never the user's real one) plus the same
    // names exported to the build process: both ways Vite and a vite.config
    // `define` could pick them up.
    const envFile = path.join(COPY, '.env');
    writeFileSync(
      envFile,
      Object.entries(canaries.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
    try {
      const r = await step(
        'build',
        'npm',
        ['run', 'build'],
        900_000,
        canaries.env,
      );
      expect(r.code, failureText('npm run build', r)).toBe(0);
    } finally {
      rmSync(envFile, { force: true });
    }
  });
  it('[G0.3] npm run check-format exits 0', () =>
    gate('check-format', 'check-format', 300_000));

  it('[G0.3] every NemoDots-owned source file is inside the lint and check-format globs of package.json', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(COPY, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const tokens = (script: string) =>
      script
        .split(/\s+/)
        .slice(1)
        .filter((t) => !t.startsWith('--'))
        .map((t) => t.replace(/^"|"$/g, ''));
    const lintTokens = tokens(pkg.scripts.lint);
    const formatTokens = tokens(pkg.scripts['check-format']);
    const globRe = (glob: string) =>
      new RegExp(
        '^' +
          glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') +
          '$',
      );
    const covered = (file: string, toks: string[]) =>
      toks.some((t) =>
        t.includes('*')
          ? globRe(t).test(file)
          : file === t || file.startsWith(`${t}/`),
      );
    const owned: string[] = [];
    const walkDir = (dir: string) => {
      const abs = path.join(APP_ROOT, dir);
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs)) {
        const rel = `${dir}/${name}`;
        if (statSync(path.join(APP_ROOT, rel)).isDirectory()) walkDir(rel);
        else owned.push(rel);
      }
    };
    for (const dir of [
      'scripts/nemodots',
      'evals',
      'src/server/nemodots',
      'tests/nemodots',
    ])
      walkDir(dir);
    const lintable = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/.test(f);
    const formattable = (f: string) =>
      /\.(ts|tsx|js|mjs|cjs|json|md|css|ya?ml)$/.test(f);
    const outsideLint = owned.filter(
      (f) => lintable(f) && !covered(f, lintTokens),
    );
    const outsideFormat = owned.filter(
      (f) => formattable(f) && !covered(f, formatTokens),
    );
    const byDir = (files: string[]) => {
      const counts = new Map<string, number>();
      for (const f of files) {
        const d = f.split('/').slice(0, -1).join('/');
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      return [...counts].map(([d, n]) => `${d} (${n})`).join(', ');
    };
    appendManifest({
      gate: 0,
      step: 'format-lint-coverage',
      ownedFiles: owned.length,
      outsideLint: outsideLint.length,
      outsideFormat: outsideFormat.length,
    });
    expect(
      { outsideLint, outsideFormat },
      `NemoDots-owned files outside the lint globs: ${byDir(outsideLint) || 'none'}; outside the check-format globs: ${byDir(outsideFormat) || 'none'}`,
    ).toEqual({ outsideLint: [], outsideFormat: [] });
  });

  it('[G0.3] prettier --check passes directly on scripts/nemodots and evals', async () => {
    expect(results.get('npm-ci')?.code, 'npm ci did not succeed').toBe(0);
    const r = await step(
      'prettier-owned',
      'npx',
      ['prettier', '--check', 'scripts/nemodots', 'evals'],
      300_000,
    );
    expect(
      r.code,
      failureText('prettier --check scripts/nemodots evals', r),
    ).toBe(0);
  });

  it('[G0.3] eslint passes directly on scripts/nemodots and evals', async () => {
    expect(results.get('npm-ci')?.code, 'npm ci did not succeed').toBe(0);
    // ESLint errors out on a directory without lintable files, so pass only
    // the directories that contain some.
    const hasLintable = (dir: string): boolean => {
      const abs = path.join(APP_ROOT, dir);
      if (!existsSync(abs)) return false;
      return readdirSync(abs).some((name) => {
        const rel = `${dir}/${name}`;
        return statSync(path.join(APP_ROOT, rel)).isDirectory()
          ? hasLintable(rel)
          : /\.(ts|tsx|js|mjs|cjs)$/.test(name);
      });
    };
    const dirs = ['scripts/nemodots', 'evals'].filter(hasLintable);
    expect(dirs, 'scripts/nemodots has lintable files').toContain(
      'scripts/nemodots',
    );
    const r = await step('eslint-owned', 'npx', ['eslint', ...dirs], 300_000);
    expect(r.code, failureText(`eslint ${dirs.join(' ')}`, r)).toBe(0);
  });

  it('[G0.3] typecheck, lint and format failures are not in production or builder-owned files', () => {
    // Attribution only: acceptance suites written concurrently by the
    // verifier are excluded here, but they still fail the exit-code cases above.
    const owned = (f: string) => !f.startsWith('tests/nemodots/acceptance/');
    const offenders = [
      ...failingFiles('tsc', readLog('typecheck'))
        .filter(owned)
        .map((f) => `tsc ${f}`),
      ...failingFiles('eslint', readLog('lint'))
        .filter(owned)
        .map((f) => `eslint ${f}`),
      ...failingFiles('prettier', readLog('check-format'))
        .filter(owned)
        .map((f) => `prettier ${f}`),
    ];
    expect(results.get('typecheck'), 'typecheck did not run').toBeDefined();
    expect(
      offenders,
      `failing non-acceptance files: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('[G0.3] unit test failures are named (and not caused by the checkout path length)', () => {
    const files = failingFiles('vitest', readLog('test'));
    const log = readLog('test');
    const pathLength = /would exceed the 103-byte limit/.test(log);
    expect(
      files,
      `failing test files: ${files.join(', ')}${pathLength ? ' (stack-cli.test.ts depends on the checkout path being <=60 bytes: a clone in a deeper directory cannot pass npm test)' : ''}`,
    ).toEqual([]);
  });

  it('[G0.3] build output exists: frontend bundle and compiled server', () => {
    expect(results.get('build')?.code, 'build did not succeed').toBe(0);
    expect(existsSync(path.join(COPY, 'dist', 'client', 'index.html'))).toBe(
      true,
    );
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
  const FORBIDDEN_BROWSER_NAMES = [
    'OPENAI_API_KEY',
    'CPK_INTELLIGENCE_API_KEY',
    'INTELLIGENCE_API_KEY',
    'CRUSOE_API_KEY',
    'NEMODOTS_PG_URL_',
    'NEMODOTS_PROBE_SECRET',
  ];

  it('[G0.6] the canary scanner finds a planted canary (positive control)', () => {
    const dir = ensureScratch('canary-control');
    const planted = makeCanaries();
    writeFileSync(
      path.join(dir, 'bundle.js'),
      `const leaked = "${planted.needles[0].value}";\n`,
    );
    writeFileSync(path.join(dir, 'clean.js'), 'const fine = 1;\n');
    const report = scan(planted.needles, {
      roots: [dir],
      skipDirs: new Set(),
    });
    expect(report.filesScanned).toBe(2);
    expect(Object.keys(report.hits)).toEqual([planted.needles[0].name]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('[G0.6] dist/client of the canary build contains none of the canary values (plain, VITE_-prefixed, role URL passwords); dist/server none either', () => {
    expect(canaries, 'the canary build did not run').toBeDefined();
    expect(results.get('build')?.code, 'build did not succeed').toBe(0);
    const needles = canaries!.needles;
    expect(needles.length).toBe((CANARY_PLAIN.length + CANARY_URLS.length) * 2);
    const client = path.join(COPY, 'dist', 'client');
    const server = path.join(COPY, 'dist', 'server');
    expect(
      existsSync(path.join(client, 'assets')),
      'build produced no frontend bundle to scan',
    ).toBe(true);
    const clientReport = scan(needles, {
      roots: [client],
      skipDirs: new Set(),
    });
    const serverReport = scan(needles, {
      roots: [server],
      skipDirs: new Set(),
    });
    appendManifest({
      gate: 0,
      step: 'canary-scan',
      canaryNames: needles.map((n) => n.name),
      clientFilesScanned: clientReport.filesScanned,
      serverFilesScanned: serverReport.filesScanned,
      clientHits: summarize(clientReport),
      serverHits: summarize(serverReport),
      policy:
        'dist/client: zero canary values (secrets must never reach the browser). dist/server: zero as well, since secrets must arrive from the runtime environment and never be baked into compiled output.',
    });
    expect(clientReport.filesScanned).toBeGreaterThan(10);
    expect(serverReport.filesScanned).toBeGreaterThan(10);
    expect(summarize(clientReport)).toBe('no matches');
    expect(summarize(serverReport)).toBe('no matches');
  });

  it('[G0.6] the real secret values (roles.env and gitignored env files) are absent from the clean-build dist/', () => {
    expect(
      existsSync(path.join(COPY, 'dist', 'client', 'assets')),
      'build produced no frontend bundle to scan',
    ).toBe(true);
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
  });

  it('[G0.6] the browser bundle does not reference server-only secret names (OpenAI, Intelligence, Crusoe, role URLs, probe secret)', () => {
    const client = path.join(COPY, 'dist', 'client');
    expect(existsSync(client), 'no dist/client to scan').toBe(true);
    const hits: Record<string, number> = {};
    let scanned = 0;
    const walkFiles = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (statSync(abs).isDirectory()) walkFiles(abs);
        else if (/\.(js|mjs|css|html|map|json|svg)$/.test(name)) {
          scanned += 1;
          const text = readFileSync(abs, 'utf8');
          for (const n of FORBIDDEN_BROWSER_NAMES)
            if (text.includes(n)) hits[n] = (hits[n] ?? 0) + 1;
        }
      }
    };
    walkFiles(client);
    expect(scanned).toBeGreaterThan(10);
    expect(
      hits,
      `browser bundle files referencing server-only names: ${JSON.stringify(hits)}`,
    ).toEqual({});
  });
});
