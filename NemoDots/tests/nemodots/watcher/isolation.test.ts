// The watcher reaches actions and the coordinator only through injected ports.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../../src/server/nemodots/watcher');
const files = readdirSync(DIR).filter((name) => name.endsWith('.ts'));

describe('watcher import rules', () => {
  it('has the documented modules', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'watcher.ts',
        'self-write.ts',
        'closure-cap.ts',
        'scheduler.ts',
        'manual.ts',
      ]),
    );
  });

  it.each(files)(
    '%s imports no team, actions, coordinator or inference code',
    (file) => {
      const source = readFileSync(join(DIR, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports)
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /\/(team|actions|coordinator|inference)\//,
        );
    },
  );

  it('only manual.ts reaches into the sandbox, and only for the version authority writer', () => {
    for (const file of files) {
      const source = readFileSync(join(DIR, file), 'utf8');
      const sandbox = [...source.matchAll(/from '([^']*sandbox[^']*)'/g)].map(
        (m) => m[1],
      );
      if (file === 'manual.ts')
        expect(sandbox).toEqual(['../sandbox/version-authority.js']);
      else expect(sandbox, file).toEqual([]);
    }
  });

  it('does not log or select the writer of a configuration change', () => {
    for (const file of files) {
      const source = readFileSync(join(DIR, file), 'utf8');
      expect(source, file).not.toMatch(/caused_by_actor/);
    }
  });
});
