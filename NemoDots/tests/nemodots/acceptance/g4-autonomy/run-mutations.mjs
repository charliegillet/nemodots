/* global console, process */
// Gate 8 mutation runs for the gate 4 cases that map to them (run from the
// NemoDots directory: node tests/nemodots/acceptance/g4-autonomy/run-mutations.mjs).
// For each mutation the mapped case is run twice: once unmutated (baseline) and
// once with G4_MUTATION=<name>, which the suite forwards to the app and worker
// as NEMODOTS_MUTATION. A mutation counts as CAUGHT only if the baseline passes
// and the mutated run fails for a reason other than a missing entry point or an
// uninitialised stack. Results are written to
// .local/acceptance/g4/mutation-results.json. Needs an initialised stack
// (npm run nemodots:stack -- init) and the production entry points.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const dir = 'tests/nemodots/acceptance/g4-autonomy';
const CASES = [
  { mutation: 'ignore_fencing', file: 'recovery.test.ts', pattern: 'G4.5d' },
  {
    mutation: 'drop_inherited_edges',
    file: 'staleness-scripted.test.ts',
    pattern: 'G4.4c',
  },
  {
    mutation: 'accept_duplicate_differing_payloads',
    file: 'idempotency.test.ts',
    pattern: 'G4.9a',
  },
];

function run(file, pattern, mutation) {
  const env = { ...process.env };
  delete env.G4_MUTATION;
  if (mutation) env.G4_MUTATION = mutation;
  const started = Date.now();
  const result = spawnSync(
    'npm',
    [
      'run',
      '--silent',
      'test:nemodots:acceptance',
      '--',
      `${dir}/${file}`,
      '-t',
      pattern,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 40 * 60_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    exitCode: result.status,
    seconds: Math.round((Date.now() - started) / 1000),
    entryPointMissing: /ENTRY POINT MISSING/.test(output),
    stackMissing:
      /not initialised|stack/i.test(output) &&
      /error/i.test(output) &&
      !/ENTRY POINT/.test(output),
    tail: output.split('\n').slice(-12).join('\n'),
  };
}

const results = [];
for (const c of CASES) {
  const command = `G4_MUTATION=${c.mutation} npm run test:nemodots:acceptance -- ${dir}/${c.file} -t "${c.pattern}"`;
  const baseline = run(c.file, c.pattern, null);
  const mutated = run(c.file, c.pattern, c.mutation);
  let verdict;
  if (baseline.entryPointMissing || mutated.entryPointMissing)
    verdict =
      'NOT_RUN: production entry points missing, so a failure proves nothing about the mutation';
  else if (baseline.stackMissing || mutated.stackMissing)
    verdict = 'NOT_RUN: the NemoDots stack is not initialised';
  else if (baseline.exitCode !== 0)
    verdict =
      'INCONCLUSIVE: the unmutated baseline does not pass, so the case cannot judge the mutation';
  else if (mutated.exitCode === 0)
    verdict = 'NOT_CAUGHT: the mutated build passes the case (gate 8 FAIL)';
  else verdict = 'CAUGHT';
  results.push({ ...c, command, baseline, mutated, verdict });
  console.log(`${c.mutation} -> ${c.file} [${c.pattern}]: ${verdict}`);
}
const out = resolve(root, '.local/acceptance/g4/mutation-results.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
);
console.log(`wrote ${out}`);
process.exit(results.every((r) => r.verdict === 'CAUGHT') ? 0 : 1);
