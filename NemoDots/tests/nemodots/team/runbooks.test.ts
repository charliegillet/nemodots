// D7/D10: runbooks and prompts describe semantics only. The healthy baseline
// and scenario values live in sandbox/seed.ts and the manifests; none of them
// may appear in anything the agents can read.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTHY_BASELINE } from '../../../src/server/nemodots/sandbox/seed.js';
import {
  COMMON_INSTRUCTIONS,
  REPAIR_NOTICE,
  roleInstructions,
} from '../../../src/server/nemodots/team/index.js';
import { ROLE_CAPABILITIES } from '../../../src/server/nemodots/contracts/index.js';

const TEAM = join(__dirname, '../../../src/server/nemodots/team');
const RUNBOOK_DIR = join(TEAM, 'runbooks');

const sources: { name: string; text: string }[] = [
  ...readdirSync(RUNBOOK_DIR).map((file) => ({
    name: `runbooks/${file}`,
    text: readFileSync(join(RUNBOOK_DIR, file), 'utf8'),
  })),
  { name: 'prompts.ts', text: readFileSync(join(TEAM, 'prompts.ts'), 'utf8') },
  {
    name: 'prompts (rendered)',
    text: [
      COMMON_INSTRUCTIONS,
      REPAIR_NOTICE,
      ...Object.keys(ROLE_CAPABILITIES).map((role) =>
        roleInstructions(role as never),
      ),
    ].join('\n'),
  },
];

// every string baseline value, as a case-insensitive substring
const stringLiterals = Object.values(HEALTHY_BASELINE).filter(
  (value): value is string => typeof value === 'string',
);
// numbers and booleans of the baseline, as whole words
const wordLiterals = Object.values(HEALTHY_BASELINE)
  .filter((value) => typeof value !== 'string')
  .map(String);

describe('no seed baseline literal reaches the agents (D7)', () => {
  it('the baseline being checked is not empty', () => {
    expect(stringLiterals.length).toBeGreaterThan(1);
    expect(wordLiterals).toContain('5000');
    expect(wordLiterals).toContain('true');
  });

  it.each(sources)('$name', ({ text }) => {
    const lowered = text.toLowerCase();
    for (const literal of stringLiterals)
      expect(lowered, `string literal "${literal}"`).not.toContain(
        literal.toLowerCase(),
      );
    for (const literal of wordLiterals) {
      // the schema/pool numbers that are also range ends in value domains
      // (1..9, 1..20) are checked through the explicit patterns below
      if (literal === '1') continue;
      expect(text, `word literal ${literal}`).not.toMatch(
        new RegExp(`(?<![\\w.])${literal}(?![\\w.])`),
      );
    }
    for (const pattern of [
      /\bv7\b/,
      /"2"/,
      /\bpool[^.\n]*\b8\b/i,
      /\bprimary\b/i,
    ])
      expect(text).not.toMatch(pattern);
  });

  it('does not state scenario or probe mechanics either', () => {
    const all = sources
      .map((s) => s.text)
      .join('\n')
      .toLowerCase();
    for (const word of [
      'probe-sku',
      'x-nemodots-probe',
      'scenario',
      'injector',
      'fault_schedules',
      'control.',
    ])
      expect(all, word).not.toContain(word);
  });
});

describe('runbook content', () => {
  it('describes value domains for every key an agent may change', () => {
    const all = sources.map((s) => s.text).join('\n');
    for (const needle of [
      'integer from 1 to 9',
      'integer from 1 to 20',
      'from 50 to 30000',
      '_stale',
      'fresh order',
    ])
      expect(all).toContain(needle);
  });
});
