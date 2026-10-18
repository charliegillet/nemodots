// Gate 2 (admission, leases and fences) case map against the frozen oracle.
// The cases themselves run once, in ../g2-races (real PostgreSQL connections,
// Redis and the actions test hooks). This file FAILS for every ADMISSION_CASES
// or LEASE_CASES id that no g2-races test title names, so a case cannot be
// dropped silently (lead ruling 2026-10-18; see g2-races/README.md).
import { describe, expect, it } from 'vitest';
import { ADMISSION_CASES, LEASE_CASES } from '../oracle/admission.js';
import { g2Titles, names } from './g2-titles.js';

const titles = g2Titles();

describe('gate 2: every oracle case has a g2-races test', () => {
  it.each(
    [...ADMISSION_CASES, ...LEASE_CASES].map((c) => [c.id, c.title] as const),
  )('%s %s', (id) => {
    expect(
      titles.filter((t) => names(t, id)),
      `no g2-races test title names ${id}`,
    ).not.toHaveLength(0);
  });
});
