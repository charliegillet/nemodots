import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEALTHY_BASELINE } from '../../../src/server/nemodots/sandbox/seed.js';
import {
  DEFAULT_RUNBOOK_DIR,
  RUNBOOK_ENTRIES,
  createRunbookLibrary,
} from '../../../src/server/nemodots/team/catalogue.js';
import {
  COMMON_INSTRUCTIONS,
  PLANNER_INSTRUCTIONS,
  roleInstructions,
} from '../../../src/server/nemodots/team/prompts.js';
import { EMBEDDED_RUNBOOKS } from '../../../src/server/nemodots/team/embedded-runbooks.js';
import { ROLE_CAPABILITIES } from '../../../src/server/nemodots/contracts/index.js';

// D7: runbooks and prompts describe semantics and value DOMAINS only. No
// healthy-baseline value and no scenario value may appear, in any phrasing
// that assigns it to a key. There is no allowance: value domains reach the
// model through the server-owned CONFIG_VALUE_DOMAINS (observe_source returns
// them as valueDomain), not through prose.

const SCENARIOS = join(
  import.meta.dirname,
  '../../../evals/nemodots/scenarios',
);

function sources(): { name: string; text: string }[] {
  const out = readdirSync(DEFAULT_RUNBOOK_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      name: `runbooks/${f}`,
      text: readFileSync(join(DEFAULT_RUNBOOK_DIR, f), 'utf8'),
    }));
  out.push({
    name: 'prompts.ts',
    text: readFileSync(
      join(import.meta.dirname, '../../../src/server/nemodots/team/prompts.ts'),
      'utf8',
    ),
  });
  const rendered = [
    COMMON_INSTRUCTIONS,
    PLANNER_INSTRUCTIONS,
    ...Object.keys(ROLE_CAPABILITIES).map((r) => roleInstructions(r as never)),
  ].join('\n');
  out.push({ name: 'rendered prompts', text: rendered });
  return out;
}

function scenarioValues(): [string, unknown][] {
  const pairs: [string, unknown][] = [];
  for (const file of readdirSync(SCENARIOS)) {
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const rec = node as Record<string, unknown>;
        if (typeof rec.key === 'string' && 'value' in rec)
          pairs.push([rec.key, rec.value]);
        Object.values(rec).forEach(walk);
      }
    };
    walk(JSON.parse(readFileSync(join(SCENARIOS, file), 'utf8')));
  }
  return pairs;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('catalogue', () => {
  it('lists exactly the declared runbooks and every file loads', () => {
    const library = createRunbookLibrary();
    expect(library.list().map((r) => r.id)).toEqual(
      Object.keys(RUNBOOK_ENTRIES).sort(),
    );
    for (const entry of library.all())
      expect(entry.text.length).toBeGreaterThan(200);
    expect(
      readdirSync(DEFAULT_RUNBOOK_DIR).filter((f) => f.endsWith('.md')),
    ).toHaveLength(Object.keys(RUNBOOK_ENTRIES).length);
  });

  it('covers the required subjects', () => {
    const text = createRunbookLibrary()
      .all()
      .map((r) => r.text)
      .join('\n');
    for (const needle of [
      'cache.namespace',
      'cache.schema_version',
      'db.pool_max',
      'routing.inventory_source',
      'fresh order succeeds',
      'inventory invariant',
      'health stays',
    ])
      expect(text).toContain(needle);
  });
});

describe('no baseline or scenario values (D7/D10)', () => {
  it('no baseline literal is stated or assigned to its key', () => {
    for (const { name, text } of sources()) {
      for (const [key, value] of Object.entries(HEALTHY_BASELINE)) {
        const literal = escape(String(value));
        const assigned = new RegExp(
          `${escape(key)}[^\\n]{0,24}?(?:=|:|\\bis\\b|\\bare\\b|equals|baseline|default|healthy|set to|should be)\\W{0,4}${literal}\\b`,
          'i',
        );
        expect(
          assigned.test(text),
          `${name}: ${key} assigned ${String(value)}`,
        ).toBe(false);
      }
      expect(text, name).not.toContain(
        String(HEALTHY_BASELINE['cache.namespace']),
      );
      expect(text, name).not.toContain(
        String(HEALTHY_BASELINE['ui.banner_text']),
      );
      for (const bare of ['5000', '10'])
        expect(
          new RegExp(`(?<![\\w.])${bare}(?![\\w.])`).test(text),
          `${name}: ${bare}`,
        ).toBe(false);
      // boolean and enum baselines never appear as a backticked value
      expect(text, name).not.toMatch(/`(?:true|false)`/);
      // no allowance for enum members either: domains come from the server
      expect(text, name).not.toMatch(/\bprimary\b/);
    }
  });

  it('no scenario value is stated or assigned', () => {
    const pairs = scenarioValues();
    expect(pairs.length).toBeGreaterThan(5);
    for (const { name, text } of sources()) {
      for (const [key, value] of pairs) {
        const literal = escape(String(value));
        const assigned = new RegExp(
          `${escape(key)}[^\\n]{0,24}?(?:=|:|\\bis\\b|\\bare\\b|equals|set to|should be)\\W{0,4}${literal}\\b`,
          'i',
        );
        expect(assigned.test(text), `${name}: ${key} ${String(value)}`).toBe(
          false,
        );
        if (typeof value === 'string' && value.length > 6)
          expect(text, name).not.toContain(value);
      }
    }
  });

  it('prompts describe capabilities, not a procedure or a diagnosis', () => {
    const investigator = roleInstructions('investigator');
    expect(investigator).toContain('observe');
    expect(investigator).toContain('delegate');
    expect(investigator).not.toContain('propose_action');
    expect(roleInstructions('cache_specialist')).toContain(
      'propose_cache_flush',
    );
    expect(roleInstructions('verifier')).not.toContain('delegate_task');
  });
});

describe('runbooks are semantics only (reviewer finding: no diagnoses or procedures)', () => {
  it('no remedy, symptom-to-fix mapping or key-specific do-not-touch instruction', () => {
    for (const { name, text } of sources()) {
      if (name === 'prompts.ts') continue;
      expect(text, name).not.toMatch(/^#+\s*(Remed|Reasoning)/im);
      expect(text, name).not.toMatch(
        /banner_text[^\n]*(unrelated|do not touch)/i,
      );
      expect(text, name).not.toMatch(/\b503\b[^\n]*(raise|increase)/i);
      expect(text, name).not.toMatch(
        /\b(raise|route|point)\b[^\n]*\b(pool|reads|namespace)\b/i,
      );
    }
  });
});

describe('embedded runbooks', () => {
  it('are identical to the .md files (the tsc build does not copy .md files)', () => {
    for (const [id, entry] of Object.entries(RUNBOOK_ENTRIES)) {
      expect(
        EMBEDDED_RUNBOOKS[entry.path],
        `${id}: regenerate with node tests/nemodots/team/gen-embedded-runbooks.mjs`,
      ).toBe(readFileSync(join(DEFAULT_RUNBOOK_DIR, entry.path), 'utf8'));
    }
    expect(Object.keys(EMBEDDED_RUNBOOKS).sort()).toEqual(
      Object.values(RUNBOOK_ENTRIES)
        .map((e) => e.path)
        .sort(),
    );
  });

  it('the default library needs no file on disk', () => {
    const library = createRunbookLibrary();
    for (const entry of library.all())
      expect(entry.text).toBe(
        EMBEDDED_RUNBOOKS[RUNBOOK_ENTRIES[entry.id].path],
      );
  });
});
