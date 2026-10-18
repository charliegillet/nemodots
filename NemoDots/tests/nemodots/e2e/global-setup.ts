// Runs once before the browser suites: refuses anything but a dedicated ci-*
// stack with a built server and a launchable system Chrome, and after the last
// suite scans every artifact this run wrote (screenshots, rendered text, DOM,
// server logs) for secret values. Names of offending files are reported, never
// the values.
import fs from 'node:fs';
import {
  APP_ROOT,
  E2E_DIR,
  SHOT_DIR,
  assertCiStack,
  launchChrome,
  scanForSecrets,
  secretValues,
} from './support/env.js';
import path from 'node:path';

export default async function setup() {
  assertCiStack();
  if (
    !fs.existsSync(path.join(APP_ROOT, 'dist', 'server', 'server', 'index.js'))
  )
    throw new Error('BLOCKED: dist/ is missing; run npm run build first');
  // The built server reads the runbook markdown next to its compiled code. A
  // build that leaves it out fails every mission at the planner.
  const runbooksSrc = path.join(APP_ROOT, 'src/server/nemodots/team/runbooks');
  const runbooksDist = path.join(
    APP_ROOT,
    'dist/server/server/nemodots/team/runbooks',
  );
  const absent = fs
    .readdirSync(runbooksSrc)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !fs.existsSync(path.join(runbooksDist, name)));
  if (absent.length > 0)
    throw new Error(
      `BLOCKED: build output is missing runbooks/${absent.join(', ')} (npm run build does not copy them)`,
    );
  fs.rmSync(SHOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await launchChrome();
  await browser.close();
  return async function teardown() {
    const scan = scanForSecrets(E2E_DIR, secretValues());
    console.log(
      `e2e secret scan: ${scan.files} files under ${path.relative(APP_ROOT, E2E_DIR)}, ${scan.hits.length} with a secret value`,
    );
    if (scan.hits.length > 0)
      throw new Error(`secret values found in: ${scan.hits.join(', ')}`);
  };
}
