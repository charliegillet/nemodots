// Fails if any frozen acceptance file changed, appeared or disappeared
// without a reviewed revision (TEST_PROMPT verification contract: "freeze
// the behavior contract and fixture/oracle version before evaluating").
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '../driver/entry-points.js';

const MANIFEST = 'tests/nemodots/acceptance/oracle/MANIFEST.sha256';
const CONTRACT = 'docs/nemodots/ACCEPTANCE_CONTRACT.md';
const FROZEN_DIRS = [
  'tests/nemodots/acceptance/oracle',
  'tests/nemodots/acceptance/integrity',
  'evals/nemodots/frozen',
];
const FROZEN_FILES = ['tests/nemodots/acceptance/vitest.config.ts', CONTRACT];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(APP_ROOT, path)))
    .digest('hex');

function readManifest(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(resolve(APP_ROOT, MANIFEST), 'utf8').split(
    '\n',
  )) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`Malformed manifest line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

describe('frozen acceptance files', () => {
  const manifest = readManifest();

  it('every frozen file is listed in MANIFEST.sha256 and nothing else is', () => {
    const onDisk = [
      ...FROZEN_DIRS.flatMap((dir) => walk(resolve(APP_ROOT, dir))),
      ...FROZEN_FILES.map((file) => resolve(APP_ROOT, file)),
    ]
      .map((path) => relative(APP_ROOT, path))
      .filter((path) => path !== MANIFEST)
      .sort();
    expect([...manifest.keys()].sort()).toEqual(onDisk);
  });

  it.each([...readManifest().keys()].map((path) => [path]))(
    '%s matches its frozen SHA-256',
    (path) => {
      expect(sha256(path)).toBe(manifest.get(path));
    },
  );

  it('ACCEPTANCE_CONTRACT.md lists the same hashes for every file it names', () => {
    const contract = readFileSync(resolve(APP_ROOT, CONTRACT), 'utf8');
    const rows = [
      ...contract.matchAll(/\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/g),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const [, path, hash] of rows) {
      expect(manifest.has(path), `${path} in manifest`).toBe(true);
      expect(manifest.get(path), path).toBe(hash);
    }
    const named = new Set(rows.map((row) => row[1]));
    for (const path of manifest.keys())
      if (path !== CONTRACT)
        expect(named.has(path), `${path} in contract table`).toBe(true);
  });
});
