// Maps every Gate 7 case to the named tests that cover it. It reads this
// folder's test titles, so a case with no test fails instead of being forgotten.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'playwright/test';
import { describe, it } from 'vitest';
import { G7_CASES } from './helpers/env.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('Gate 7 case coverage', () => {
  it('every Gate 7 case has at least one named test', () => {
    const titles = readdirSync(here)
      .filter((f) => f.endsWith('.test.ts') && f !== 'g7-case-map.test.ts')
      .flatMap((f) =>
        [
          ...readFileSync(resolve(here, f), 'utf8').matchAll(
            /it\('\[(G7\.\d+)\]/g,
          ),
        ].map((m) => m[1]),
      );
    for (const id of Object.keys(G7_CASES))
      expect(titles, `no test names case G7.${id}`).toContain(`G7.${id}`);
  });
});
