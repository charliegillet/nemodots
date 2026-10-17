// Leakage checks for the frozen held-out set (TEST_PROMPT gate 6 and gate 8:
// "no manifest leakage"). Static scans of everything a runtime agent, its
// tools, the UI or builder evaluation code can read.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '../driver/entry-points.js';

const FROZEN = resolve(APP_ROOT, 'evals/nemodots/frozen');
const SCAN_ROOTS = [
  'src',
  'scripts/nemodots',
  'evals/nemodots/scenarios',
  'public',
];
const AGENT_SURFACES = [
  'src/server/nemodots/team',
  'src/server/nemodots/context',
  'src/server/nemodots/inference',
  'src/server/nemodots/routes',
  'src/server/nemodots/interception',
  'src/server/nemodots/watcher',
  'src/client',
];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html|ya?ml|sql)$/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.local' || name === 'dist')
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (TEXT.test(name)) out.push(path);
  }
  return out;
}

function heldOutTokens(): string[] {
  const tokens = new Set<string>();
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === 'string') {
      if (key === 'trialId' || key === 'id') tokens.add(value);
      if (key === 'value' && value !== 'primary' && value !== 'replica_stale')
        tokens.add(value);
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  for (const file of walk(resolve(FROZEN, 'scenarios')))
    visit(JSON.parse(readFileSync(file, 'utf8')), null);
  return [...tokens].filter((t) => t.length >= 6);
}

describe('frozen held-out set is not reachable from runtime code', () => {
  const tokens = heldOutTokens();

  it('has distinctive held-out tokens to scan for', () => {
    expect(tokens.length).toBeGreaterThanOrEqual(30);
  });

  it('no held-out value, trial id or scenario id appears in runtime-readable files', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS)
      for (const file of walk(resolve(APP_ROOT, root))) {
        const text = readFileSync(file, 'utf8');
        for (const token of tokens)
          if (text.includes(token))
            hits.push(`${relative(APP_ROOT, file)}: ${token}`);
      }
    expect(hits).toEqual([]);
  });

  it('no agent-facing module references the frozen or acceptance directories', () => {
    const hits: string[] = [];
    const forbidden = [
      'evals/nemodots/frozen',
      'nemodots/frozen',
      'tests/nemodots/acceptance',
      'acceptance/oracle',
    ];
    for (const root of AGENT_SURFACES)
      for (const file of walk(resolve(APP_ROOT, root))) {
        const text = readFileSync(file, 'utf8');
        for (const needle of forbidden)
          if (text.includes(needle))
            hits.push(`${relative(APP_ROOT, file)}: ${needle}`);
      }
    expect(hits).toEqual([]);
  });

  it('no production module imports verifier code', () => {
    const hits: string[] = [];
    for (const file of walk(resolve(APP_ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (
        /from\s+['"][^'"]*tests\/nemodots\/acceptance/.test(text) ||
        /import\([^)]*acceptance\//.test(text)
      )
        hits.push(relative(APP_ROOT, file));
    }
    expect(hits).toEqual([]);
  });

  it('the frozen directory is not under a served or bundled path', () => {
    for (const served of ['public', 'src', 'dist'])
      expect(relative(resolve(APP_ROOT, served), FROZEN).startsWith('..')).toBe(
        true,
      );
  });
});
