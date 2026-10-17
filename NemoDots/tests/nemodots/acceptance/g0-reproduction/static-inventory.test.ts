// Gate 0 (TEST_PROMPT gate_0_reproduction), static inspection cases:
//   G0.1 inspect repository instructions, build documents, package files,
//        migrations, configuration schema and operational modules
//   G0.2 (static half) Node >=24 / npm present, lockfile v3 and consistent
//   G0.3 (static half) upstream scripts present and wired
//   G0.6 (static half) MIT licence + copied notices intact, source refs/pins
//        match code, new dependencies exactly pinned
// Expected values come from TEST_PROMPT, BUILD_PROMPT, STACK.md and the
// recorded upstream facts, never from production logic.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, WORKTREE_ROOT, sha256File } from './helpers/common.js';

const app = (...p: string[]) => path.join(APP_ROOT, ...p);
const read = (...p: string[]) => readFileSync(app(...p), 'utf8');
const pkg = () =>
  JSON.parse(read('package.json')) as {
    license?: string;
    engines?: { node?: string };
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

describe('G0.1 repository inventory', () => {
  it('[G0.1] repository instructions and build documents are present', () => {
    const required = [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'LICENSE',
      'package.json',
      'package-lock.json',
      'docs/nemodots/BUILD_PROMPT.md',
      'docs/nemodots/TEST_PROMPT.md',
      'docs/nemodots/CONTRACTS.md',
      'docs/nemodots/ARCHITECTURE.md',
      'docs/nemodots/TOOL_COVERAGE.md',
      'docs/nemodots/DEPENDENCIES.md',
      'docs/nemodots/IMPLEMENTATION_STATUS.md',
      'docs/nemodots/LEAD_NOTES.md',
      'docs/nemodots/STACK.md',
    ];
    const missing = required.filter((f) => !existsSync(app(f)));
    expect(missing, `missing files: ${missing.join(', ')}`).toEqual([]);
  });

  it('[G0.1] configuration schema and operational modules exist', () => {
    const required = [
      'src/server/nemodots/config/env.ts',
      'src/server/nemodots/config/roles-file.ts',
      'src/server/nemodots/db/migrate.ts',
      'src/server/nemodots/db/pool.ts',
      'src/server/nemodots/db/tx.ts',
      'src/server/nemodots/contracts/index.ts',
      'scripts/nemodots/stack.mjs',
      'scripts/nemodots/write-env.mjs',
    ];
    const missing = required.filter((f) => !existsSync(app(f)));
    expect(missing, `missing files: ${missing.join(', ')}`).toEqual([]);
  });

  it('[G0.1] migrations are contiguous, id equals file name, and cover the architecture layout', () => {
    const dir = app('src/server/nemodots/db/migrations');
    expect(existsSync(dir), 'migrations directory missing').toBe(true);
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.ts$/.test(f) && !f.endsWith('.d.ts'))
      .sort();
    const ids = files.map((f) => f.replace(/\.ts$/, ''));
    ids.forEach((id, index) => {
      expect(Number(id.slice(0, 4)), `gap or reorder at ${id}`).toBe(index + 1);
      // The module must declare the same id as its file name.
      const text = readFileSync(path.join(dir, `${id}.ts`), 'utf8');
      expect(text, `${id} must declare id '${id}'`).toMatch(
        new RegExp(`id:\\s*['"]${id}['"]`),
      );
    });
    // ARCHITECTURE.md section 3 layout (spec, not production behavior).
    const expected = [
      '0001_bootstrap',
      '0002_ledger',
      '0003_coordinator',
      '0004_checkout',
      '0005_actions',
      '0006_telemetry',
    ];
    const absent = expected.filter((id) => !ids.includes(id));
    expect(absent, `migrations absent: ${absent.join(', ')}`).toEqual([]);
  });

  it('[G0.1] .env.example documents the live/blocked contract with no values', () => {
    const text = read('.env.example');
    for (const name of [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'INTELLIGENCE_API_KEY',
    ])
      expect(text, `${name} undocumented`).toMatch(
        new RegExp(`^${name}=`, 'm'),
      );
    // Secret-bearing variables must be empty in the template.
    for (const name of ['OPENAI_API_KEY', 'INTELLIGENCE_API_KEY']) {
      const line = new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? '';
      expect(line.trim(), `${name} has a value in .env.example`).toBe('');
    }
    // No default fallback to a non-Crusoe provider host (LEAD_NOTES, finding I1).
    expect(text).not.toMatch(/^OPENAI_BASE_URL=.*api\.openai\.com/m);
  });
});

describe('G0.2 toolchain declarations (static)', () => {
  it('[G0.2] engines require Node >=24 and the running Node satisfies it', () => {
    expect(pkg().engines?.node).toBe('>=24.0.0');
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(
      24,
    );
  });

  it('[G0.2] package-lock.json is lockfile v3 and agrees with package.json', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      lockfileVersion: number;
      packages: Record<
        string,
        {
          version?: string;
          integrity?: string;
          resolved?: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        }
      >;
    };
    expect(lock.lockfileVersion).toBe(3);
    const root = lock.packages[''];
    const p = pkg();
    expect(root.dependencies ?? {}).toEqual(p.dependencies);
    expect(root.devDependencies ?? {}).toEqual(p.devDependencies);
    // Every non-link package carries an integrity hash (clean-install integrity).
    const noIntegrity = Object.entries(lock.packages).filter(
      ([name, entry]) =>
        name !== '' &&
        entry.resolved?.startsWith('http') &&
        !entry.integrity,
    );
    expect(noIntegrity.length, 'lock entries without integrity').toBe(0);
  });

  it('[G0.2] dependencies added for NemoDots are exactly pinned in package.json and the lockfile', () => {
    const p = pkg();
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>;
    };
    // STACK.md "Dependencies added": exact versions, no ranges.
    const pins: [string, string, 'dependencies' | 'devDependencies'][] = [
      ['pg', '8.23.1', 'dependencies'],
      ['redis', '5.12.1', 'dependencies'],
      ['@types/pg', '8.23.1', 'devDependencies'],
    ];
    for (const [name, version, bucket] of pins) {
      expect(p[bucket][name], `${name} must be pinned exactly`).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });
});

describe('G0.3 upstream scripts (static)', () => {
  it('[G0.3] upstream verification scripts are present and still do their job', () => {
    const s = pkg().scripts;
    for (const name of [
      'dev',
      'build',
      'start',
      'test',
      'typecheck',
      'lint',
      'format',
      'check-format',
    ])
      expect(s[name], `script ${name} missing`).toBeTruthy();
    expect(s.typecheck).toContain('tsc --noEmit');
    expect(s.test).toContain('vitest run');
    expect(s.build).toContain('vite build');
    expect(s.build).toContain('tsconfig.server.json');
    expect(s.lint).toContain('eslint');
    expect(s['check-format']).toContain('prettier --check');
  });

  it('[G0.3] every NemoDots npm script resolves to an existing target file', () => {
    const s = pkg().scripts;
    const nemo = Object.entries(s).filter(([n]) => /nemodots/.test(n));
    expect(nemo.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const [name, command] of nemo) {
      for (const token of command.split(/\s+/)) {
        if (
          /^(scripts|src|tests)\/.+\.(mjs|ts|js)$/.test(token) &&
          !existsSync(app(token))
        )
          missing.push(`${name} -> ${token}`);
        if (/^vitest[^ ]*\.config\.ts$/.test(token)) continue;
        if (token.endsWith('.config.ts') && !existsSync(app(token)))
          missing.push(`${name} -> ${token}`);
      }
    }
    expect(missing, `scripts with missing targets: ${missing.join('; ')}`).toEqual(
      [],
    );
  });

  it('[G0.3] default npm test excludes suites that need the stack or credentials', () => {
    const cfg = read('vitest.config.ts');
    for (const dir of ['integration', 'live', 'e2e', 'acceptance'])
      expect(cfg, `vitest.config.ts must exclude ${dir}`).toContain(dir);
  });
});

describe('G0.6 licence, notices and pins (static)', () => {
  it('[G0.6] upstream MIT LICENSE is intact', () => {
    const text = read('LICENSE');
    expect(text.startsWith('The MIT License')).toBe(true);
    expect(text).toContain('Copyright (c) Atai Barkai');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    // Digest observed at acceptance authoring (2026-10-17), after the squashed
    // subtree import; byte identity with the upstream blob at ab39f25 must be
    // confirmed by the integrator with git (the verifier runs no git).
    expect(sha256File(app('LICENSE'))).toBe(
      '15a0e5343aea872c0573ad72feb6044b336f162d724cc1673c608e6b37ea071b',
    );
    expect(pkg().license).toBe('MIT');
  });

  it('[G0.6] copied OpenBot notice remains next to the computers deployment', () => {
    const file = app('deployment/computers/LICENSE.openbot');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('MIT');
    expect(text).toContain('Permission is hereby granted');
  });

  it('[G0.6] THIRD_PARTY_NOTICES.md names upstream sources and their pinned refs', () => {
    // BUILD_PROMPT Phase 6: preserve licences, add THIRD_PARTY_NOTICES.md.
    const file = [app('THIRD_PARTY_NOTICES.md'), path.join(WORKTREE_ROOT, 'THIRD_PARTY_NOTICES.md')].find(
      existsSync,
    );
    expect(
      file,
      'THIRD_PARTY_NOTICES.md missing (expected in NemoDots/ or the worktree root)',
    ).toBeTruthy();
    const text = readFileSync(file!, 'utf8');
    expect(text).toMatch(/CopilotKit\/OpenDots/);
    expect(text).toContain('ab39f2508f3fd23a949837622456f3d61a108e9a');
    expect(text).toMatch(/OpenBot/);
    expect(text).toContain('b6932d31a8d6e7896c15139dfc27a6c6911deb27');
    expect(text).toMatch(/MIT/);
  });

  it('[G0.6] OpenBot computer-service pin matches the build prompt everywhere it is used', () => {
    const OPENBOT = 'b6932d31a8d6e7896c15139dfc27a6c6911deb27';
    const compose = read('compose.computers.yml');
    const refs = [...compose.matchAll(/OpenBot\.git#([^\s"']+)/g)].map(
      (m) => m[1],
    );
    expect(refs.length, 'no OpenBot refs found in compose.computers.yml').toBeGreaterThan(0);
    expect([...new Set(refs)], 'every OpenBot ref must be the pinned SHA').toEqual([OPENBOT]);
    // The pin documented in deployment docs and build docs equals the code pin.
    expect(read('deployment/computers/README.md')).toContain(OPENBOT);
    expect(read('docs/nemodots/BUILD_PROMPT.md')).toContain(OPENBOT);
    expect(read('docs/nemodots/DEPENDENCIES.md')).toContain(OPENBOT);
  });

  it('[G0.6] no floating git refs: every git dependency or build context is a full SHA', () => {
    const files = ['Dockerfile', 'compose.yml', 'compose.computers.yml', 'compose.computers-app.yml'];
    const floating: string[] = [];
    for (const f of files) {
      if (!existsSync(app(f))) continue;
      for (const m of read(f).matchAll(/\.git#([^\s"']+)/g))
        if (!/^[0-9a-f]{40}$/.test(m[1])) floating.push(`${f}: ${m[1]}`);
    }
    expect(floating, `floating refs: ${floating.join('; ')}`).toEqual([]);
    const p = pkg();
    const gitDeps = Object.entries({ ...p.dependencies, ...p.devDependencies })
      .filter(([, v]) => /^(git|github:|https?:)/.test(v) || /\.git/.test(v))
      .filter(([, v]) => !/#[0-9a-f]{40}$/.test(v));
    expect(gitDeps, 'git dependencies must be pinned to a full SHA').toEqual([]);
  });

  it('[G0.6] the upstream OpenDots revision is cited consistently in the audit documents', () => {
    const UPSTREAM = 'ab39f2508f3fd23a949837622456f3d61a108e9a';
    expect(read('docs/nemodots/BUILD_PROMPT.md')).toContain(UPSTREAM);
    expect(read('docs/nemodots/LEAD_NOTES.md')).toContain(UPSTREAM);
  });
});
