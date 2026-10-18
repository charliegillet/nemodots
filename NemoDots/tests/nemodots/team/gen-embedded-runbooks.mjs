// Regenerates src/server/nemodots/team/embedded-runbooks.ts from team/runbooks/*.md
// (the authoring source). Run from NemoDots/: node tests/nemodots/team/gen-embedded-runbooks.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'src/server/nemodots/team/runbooks';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort();
const body = files
  .map(
    (f) =>
      `  ${JSON.stringify(f)}: ${JSON.stringify(readFileSync(join(dir, f), 'utf8'))},`,
  )
  .join('\n');
writeFileSync(
  'src/server/nemodots/team/embedded-runbooks.ts',
  `// GENERATED from team/runbooks/*.md by tests/nemodots/team/gen-embedded-runbooks.mjs.
// The tsc build does not copy .md files into dist/, so the runbook library
// reads these strings by default; a test fails when they drift from the .md files.
export const EMBEDDED_RUNBOOKS: Readonly<Record<string, string>> = Object.freeze({
${body}
});
`,
);
