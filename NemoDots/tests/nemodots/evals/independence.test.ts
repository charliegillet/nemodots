// The oracle is independent of the code it judges, and the harness never
// touches the verifier's frozen set or the acceptance tests.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../../src/server/nemodots/evals');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : name.endsWith('.ts')
        ? [path]
        : [];
  });
}
const importsOf = (path: string) =>
  [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

const ORACLE = ['scoring.ts', 'reference-closure.ts', 'observations.ts'];
const JUDGED =
  /\/(ledger\/(invalidation|closure|supersession|prelock|receipts)|coordinator\/recovery)\.js$/;

describe('oracle independence', () => {
  it('scoring.ts, reference-closure.ts and observations.ts import no ledger, coordinator, actions, team or bootstrap code', () => {
    for (const name of ORACLE)
      for (const spec of importsOf(join(DIR, name)))
        expect(spec, `${name} imports ${spec}`).not.toMatch(
          /\/(ledger|coordinator|actions|team|bootstrap|watcher|inference)(\/|\.js)/,
        );
  });

  it('nothing in evals imports the closure or invalidation code it judges', () => {
    for (const path of files(DIR))
      for (const spec of importsOf(path))
        expect(`${path} -> ${spec}`).not.toMatch(JUDGED);
  });

  it('the oracle reads the manifest module only for types, validation and seeded resolution', () => {
    const imports = ORACLE.flatMap((name) => importsOf(join(DIR, name))).filter(
      (s) => s.includes('sandbox'),
    );
    expect(new Set(imports)).toEqual(
      new Set(['../sandbox/config-schema.js', '../sandbox/manifest.js']),
    );
  });

  it('no evals source mentions the frozen set or the acceptance tests', () => {
    for (const path of files(DIR)) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(
        /nemodots\/frozen|tests\/nemodots\/acceptance/,
      );
    }
  });
});
