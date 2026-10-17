// Gate 1 coverage guard: every TEST_PROMPT gate-1 item 1..13 must be named by at
// least one test in this folder ([G1.n] in a test title) and every oracle case
// (LG-*, CL-*, RJ-*) must be executed here. A missing mapping fails; it is
// never skipped.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOSURE_CASES, REJECTION_CASES } from '../oracle/closures.js';
import { LEDGER_CASES } from '../oracle/ledger.js';

const dir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts') && f !== 'coverage.test.ts')
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n');

describe('[G1] coverage of TEST_PROMPT gate 1', () => {
  it('[G1] every item 1..13 is named by a test title', () => {
    // Titles of the oracle-driven runners are generated from the cases' own `covers`; include them.
    const generated = new Set([...LEDGER_CASES, ...CLOSURE_CASES, ...REJECTION_CASES].flatMap((c) => c.covers).filter((c) => c.startsWith('gate1.')).map((c) => Number(c.slice(6))));
    const missing = Array.from({ length: 13 }, (_, i) => i + 1).filter((n) => !generated.has(n) && !new RegExp(`\\[G1\\.${n}\\]`).test(sources));
    expect(missing).toEqual([]);
  });

  it('[G1] every item named by the oracle for gate 1 is a real item number', () => {
    const covers = [...LEDGER_CASES, ...CLOSURE_CASES, ...REJECTION_CASES].flatMap((c) => c.covers).filter((c) => c.startsWith('gate1.'));
    for (const c of covers) expect(Number(c.slice(6)), c).toBeGreaterThanOrEqual(1);
    for (const c of covers) expect(Number(c.slice(6)), c).toBeLessThanOrEqual(13);
  });

  it('[G1] every oracle case is executed by this suite (runners iterate the full frozen lists)', () => {
    expect(sources).toContain('LEDGER_CASES.map');
    expect(sources).toContain('CLOSURE_CASES.map');
    expect(sources).toContain('for (const c of REJECTION_CASES)');
    expect(LEDGER_CASES.length).toBeGreaterThanOrEqual(16);
    expect(CLOSURE_CASES.length).toBeGreaterThanOrEqual(11);
    expect(REJECTION_CASES.length).toBeGreaterThanOrEqual(7);
  });
});
