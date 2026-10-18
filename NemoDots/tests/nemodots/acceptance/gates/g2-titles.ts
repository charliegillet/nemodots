// Test titles of the g2-races suite, read from source, for the gate 2 case
// maps. Every frozen ADM/LS/SW case runs once, in g2-races; the gate files
// only check that each case id is named by at least one g2-races test title.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../g2-races/', import.meta.url));

export function g2Titles(): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .flatMap((f) =>
      [
        ...readFileSync(resolve(dir, f), 'utf8').matchAll(
          /\bit(?:\.each\([^)]*\))?\(\s*(['`])((?:(?!\1).)+)\1/gs,
        ),
      ].map((m) => m[2]),
    );
}

/** True when a title names the case id as a whole token (ADM-05 does not match ADM-05a). */
export const names = (title: string, id: string) =>
  new RegExp(`(^|[^A-Za-z0-9-])${id}(?![A-Za-z0-9])`).test(title);
