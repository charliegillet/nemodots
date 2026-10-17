// Gate 0 item 6 (secrets half): secret values are absent from files that would
// be committed, from the shared checkout's built assets and from logs. Only
// counts, variable names and relative paths are ever reported, never values.
//
// Approximation of "tracked files" (the verifier runs no git): every file under
// the worktree that is not excluded by the worktree and app .gitignore rules.
// That is a superset of tracked files and also catches untracked-but-not-ignored
// directories (for example .claude/) that a careless `git add` could pick up.
//
// Screenshots (binary) cannot be text-scanned here; gate 7 owns that check.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, WORKTREE_ROOT, appendManifest } from './helpers/common.js';
import { collectNeedles, scan, summarize } from './helpers/secrets.js';

function rolesFiles() {
  const local = path.join(APP_ROOT, '.local');
  if (!existsSync(local)) return [];
  return readdirSync(local)
    .map((n) => path.join(local, n, 'stack', 'roles.env'))
    .filter(existsSync);
}

const needles = () => collectNeedles(rolesFiles());

const NEVER_COMMITTED_DIRS = [
  'node_modules',
  '.git',
  '.references',
  'artifacts',
  '.local',
  'dist',
  'data',
  '.opendots',
  'playwright-report',
  'test-results',
];

describe('G0.6 secrets are absent from committed content', () => {
  it('[G0.6] there are secret values to check for (absence is not vacuous)', () => {
    const list = needles();
    appendManifest({
      gate: 0,
      step: 'secret-needles',
      names: list.map((n) => n.name),
    });
    expect(
      list.length,
      'no env/roles secrets found; cannot prove absence',
    ).toBeGreaterThan(2);
    // Presence of a variable is not proof it works: the check is by value, names only here.
    expect(list.some((n) => n.name.startsWith('NEMODOTS_PG_URL_'))).toBe(true);
  });

  it('[G0.6] zero secret-value or credential-pattern matches in files outside .gitignore', () => {
    const report = scan(needles(), {
      roots: [WORKTREE_ROOT],
      skipDirs: new Set(NEVER_COMMITTED_DIRS),
      skipFile: (rel) => {
        const name = rel.split('/').pop() ?? rel;
        return (
          ((name === '.env' || name.startsWith('.env.')) &&
            name !== '.env.example') ||
          name === '.mcp.json'
        );
      },
    });
    appendManifest({
      gate: 0,
      step: 'secret-scan-files',
      filesScanned: report.filesScanned,
      summary: summarize(report),
    });
    expect(report.filesScanned).toBeGreaterThan(100);
    expect(summarize(report)).toBe('no matches');
  });

  it('[G0.6] .gitignore (worktree and app) excludes env files, local state and build output', () => {
    const outer = readFileSync(path.join(WORKTREE_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    const inner = readFileSync(path.join(APP_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    for (const rule of [
      '.env',
      '.env.*',
      '!.env.example',
      '.local/',
      '.mcp.json',
    ])
      expect(outer, `worktree .gitignore lacks ${rule}`).toContain(rule);
    for (const rule of [
      '.env',
      '.env.*',
      '!.env.example',
      'node_modules/',
      'dist/',
      '.local/',
    ])
      expect(inner, `app .gitignore lacks ${rule}`).toContain(rule);
  });

  it('[G0.6] secret-bearing files are owner-only (mode 0600)', () => {
    const files = [
      path.join(WORKTREE_ROOT, '.env'),
      path.join(APP_ROOT, '.env'),
      ...rolesFiles(),
    ].filter(existsSync);
    const loose = files
      .filter((f) => statSync(f).mode & 0o077)
      .map((f) => path.relative(APP_ROOT, f));
    expect(
      loose,
      `group/other-readable secret files: ${loose.join(', ')}`,
    ).toEqual([]);
  });

  it('[G0.6] .env.example and write-env output carry names only (no role URLs or probe secret)', () => {
    const example = readFileSync(path.join(APP_ROOT, '.env.example'), 'utf8');
    expect(example).not.toMatch(/NEMODOTS_PG_URL_\w+=\S/);
    expect(example).not.toMatch(/NEMODOTS_PROBE_SECRET=\S/);
    const envFile = path.join(APP_ROOT, '.env');
    if (existsSync(envFile)) {
      const text = readFileSync(envFile, 'utf8');
      expect(text, 'role URLs must stay in roles.env, not .env').not.toMatch(
        /^NEMODOTS_PG_URL_\w+=/m,
      );
      expect(text).not.toMatch(/^NEMODOTS_PROBE_SECRET=/m);
    }
  });
});

describe('G0.6 secrets are absent from built assets and logs', () => {
  it("[G0.6] the shared checkout's dist/ (when built) has zero secret matches", (ctx) => {
    const dist = path.join(APP_ROOT, 'dist');
    if (!existsSync(dist)) {
      // A missing build is NOT_RUN, never a pass: the clean-build canary scan
      // in install-and-checks.test.ts is the authoritative one.
      appendManifest({
        gate: 0,
        step: 'secret-scan-shared-dist',
        status: 'NOT_RUN',
        note: 'dist absent',
      });
      ctx.skip('NOT_RUN: shared dist/ is absent, nothing to scan');
      return;
    }
    const report = scan(needles(), { roots: [dist], skipDirs: new Set() });
    appendManifest({
      gate: 0,
      step: 'secret-scan-shared-dist',
      filesScanned: report.filesScanned,
      summary: summarize(report),
    });
    expect(report.filesScanned).toBeGreaterThan(5);
    expect(summarize(report)).toBe('no matches');
  });

  it('[G0.6] logs and run artifacts under .local contain no secret values', () => {
    const local = path.join(APP_ROOT, '.local');
    const report = scan(needles(), {
      roots: [local],
      skipDirs: new Set([
        'pg',
        'redis',
        'stack',
        'run',
        'node_modules',
        'install-copy',
      ]),
      extensions: new Set([
        '.log',
        '.txt',
        '.out',
        '.json',
        '.md',
        '.ndjson',
        '.jsonl',
      ]),
      skipFile: (rel) => rel.endsWith('roles.env'),
    });
    appendManifest({
      gate: 0,
      step: 'secret-scan-logs',
      filesScanned: report.filesScanned,
      summary: summarize(report),
    });
    expect(report.filesScanned).toBeGreaterThan(0);
    expect(summarize(report)).toBe('no matches');
  });

  it('[G0.6] stack logs written by the instance scripts contain no role password or probe secret', () => {
    const local = path.join(APP_ROOT, '.local');
    const logDirs = readdirSync(local)
      .map((n) => path.join(local, n, 'logs'))
      .filter((d) => existsSync(d) && statSync(d).isDirectory());
    const report = scan(needles(), {
      roots: logDirs,
      skipDirs: new Set(),
      extensions: new Set(['.log']),
    });
    expect(summarize(report)).toBe('no matches');
  });
});

describe('G0.6 parts this suite cannot execute (reported, never folded into PASS)', () => {
  it('[G0.6] git history (git log -p main..nemodots and the staged diff) has zero secret-value matches', (ctx) => {
    appendManifest({
      gate: 0,
      step: 'secret-scan-git-history',
      status: 'NOT_RUN',
      reason:
        'the verifier runs no git commands (LEAD_NOTES); every commit on nemodots is auto-pushed, so a committed-then-deleted secret would stay in pushed history',
      dependency:
        'integrator: run a needle-count scan (counts only, never values) over `git log -p main..nemodots` and the staged diff with the needles from .env and roles.env, and write the result into the acceptance manifest',
    });
    ctx.skip(
      'NOT_RUN: git history scan is handed to the integrator (counts only)',
    );
  });

  it('[G0.6] screenshots and other binary files (png, gif, mp4, zip) contain no secrets', (ctx) => {
    appendManifest({
      gate: 0,
      step: 'secret-scan-binaries',
      status: 'NOT_RUN',
      reason:
        'the text scanner skips binary files; screenshots named by TEST_PROMPT G0.6 cannot be text-scanned here',
      handedTo: 'gate 7 (UI/E2E) with a visual check of every screenshot',
    });
    ctx.skip('NOT_RUN: binary and screenshot scan is handed to gate 7');
  });
});
