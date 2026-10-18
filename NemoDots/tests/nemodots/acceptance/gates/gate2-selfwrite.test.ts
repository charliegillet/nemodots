// Gate 2 item 16 (self-write classification) case map. The SELF_WRITE_CASES
// run once, in ../g2-races (lifecycle.test.ts, G2-16); this file FAILS for
// every SW id that no g2-races test title names (lead ruling 2026-10-18).
import { describe, expect, it } from 'vitest';
import { SELF_WRITE_CASES } from '../oracle/closures.js';
import { g2Titles, names } from './g2-titles.js';

const titles = g2Titles();

describe('gate 2.16: every self-write oracle case has a g2-races test', () => {
  it.each(SELF_WRITE_CASES.map((c) => [c.id, c.title] as const))(
    '%s %s',
    (id) => {
      expect(
        titles.filter((t) => names(t, id)),
        `no g2-races test title names ${id}`,
      ).not.toHaveLength(0);
    },
  );
});
