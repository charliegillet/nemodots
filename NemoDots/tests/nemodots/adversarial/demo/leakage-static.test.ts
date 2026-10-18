// W6.3 demo adversary, static leakage (D7/D10). Everything under team/** is
// scanned, not only prompts.ts and the runbooks: planner/replan task text, tool
// refusal messages, closing-check notices and every other string literal a
// model can receive. Forbidden: the healthy baseline of sandbox/seed.ts, every
// value and identifier of the development scenario manifests, and the control
// and oracle vocabulary. Allowed: the runbook vocabulary (value domains stated
// as ranges, source keys, key semantics).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  CONTROL_VOCABULARY,
  MANIFEST_VOCABULARY,
  TEAM_DIR,
  baselineScalars,
  baselineStrings,
  hits,
  injectedValues,
  scenarioIdentifiers,
} from './support.js';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const FILES = walk(TEAM_DIR).sort();
const rel = (file: string) => path.relative(APP_ROOT, file);

/** Every string a model could receive from a .ts file: string and template literal text. */
function stringLiterals(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Lead ruling (W6.3 round 1): value domains are runbook vocabulary when stated
 * neutrally, never saying which value is healthy. A bullet of a runbook's
 * "Value domains" section is therefore exempt from the literal scan unless it
 * uses evaluative words. Everything else in the runbook is scanned.
 */
const EVALUATIVE =
  /\b(healthy|correct|default|normal|recommended|preferred|safe|right|good|baseline|expected|usual)\b/i;

function neutralDomainLines(text: string): {
  exempt: string[];
  rest: string;
} {
  const exempt: string[] = [];
  const kept: string[] = [];
  let inDomains = false;
  for (const line of text.split('\n')) {
    if (/^\s*Value domains\s*$/i.test(line)) {
      inDomains = true;
      kept.push(line);
      continue;
    }
    if (inDomains && line.trim() !== '' && !line.trimStart().startsWith('- '))
      inDomains = false;
    if (
      inDomains &&
      line.trimStart().startsWith('- ') &&
      !EVALUATIVE.test(line)
    )
      exempt.push(line.trim());
    else kept.push(line);
  }
  return { exempt, rest: kept.join('\n') };
}

/** Model-visible text of one team file, minus neutral value-domain bullets. */
function visibleText(file: string): string {
  return file.endsWith('.md')
    ? neutralDomainLines(readFileSync(file, 'utf8')).rest
    : stringLiterals(file).join('\n');
}

const CONFIG_CONTEXT =
  /schema|pool|timeout|namespace|routing|write|banner|connection|version|setting|value/i;
/** Range statements ("from 1 to 9", "2 to 6 tasks") are runbook vocabulary. */
const DOMAIN_RANGE = /\b(from )?\d+ to \d+\b/gi;

/** Sentences that talk about configuration, with domain ranges removed. */
function configSentences(text: string): string[] {
  return text
    .split(/[.\n;:]/)
    .filter((sentence) => CONFIG_CONTEXT.test(sentence))
    .map((sentence) => sentence.replace(DOMAIN_RANGE, ' '));
}

const forbiddenStrings = [
  ...baselineStrings(),
  ...[...injectedValues().values()].flatMap((values) =>
    [...values].filter((v): v is string => typeof v === 'string'),
  ),
];
const forbiddenScalars = new Set([
  ...baselineScalars(),
  ...[...injectedValues().values()].flatMap((values) =>
    [...values].filter((v) => typeof v !== 'string').map(String),
  ),
]);

describe('the forbidden sets are derived, not hand-typed', () => {
  it('cover the seed baseline and every development manifest', () => {
    expect(forbiddenStrings).toEqual(
      expect.arrayContaining([
        'catalog-a',
        'primary',
        'replica_stale',
        'All systems normal: inventory is in sync',
      ]),
    );
    for (const scalar of ['1', '10', '5000', 'true', 'false', '5', '6'])
      expect(forbiddenScalars.has(scalar), scalar).toBe(true);
    expect(scenarioIdentifiers()).toEqual(
      expect.arrayContaining([
        'cache_schema_mismatch',
        'dependent_change_after_proposal',
        'diverging_edges',
        'repairable_checkout_fault',
        'stale_replica',
      ]),
    );
    expect(FILES.length).toBeGreaterThanOrEqual(20);
  });
});

describe('no seed baseline or scenario literal in team/** (D7)', () => {
  it.each(FILES.map((file) => [rel(file), file]))(
    '%s: no baseline or injected string value in model-visible text',
    (_name, file) => {
      expect(hits(visibleText(file), forbiddenStrings)).toEqual([]);
    },
  );

  it.each(FILES.map((file) => [rel(file), file]))(
    '%s: no baseline or injected number/boolean in configuration sentences',
    (_name, file) => {
      const found: string[] = [];
      for (const sentence of configSentences(visibleText(file)))
        for (const word of sentence.match(/(?<![\w.$])[\w]+(?![\w.])/g) ?? [])
          if (forbiddenScalars.has(word.toLowerCase()))
            found.push(`${word} in "${sentence.trim().slice(0, 120)}"`);
      expect(found).toEqual([]);
    },
  );

  it.each(FILES.map((file) => [rel(file), file]))(
    '%s: no scenario id, class or step kind anywhere in the file (code and comments included)',
    (_name, file) => {
      const text = readFileSync(file, 'utf8');
      expect(hits(text, scenarioIdentifiers())).toEqual([]);
    },
  );

  it.each(FILES.map((file) => [rel(file), file]))(
    '%s: no manifest, oracle, control or probe vocabulary in model-visible text',
    (_name, file) => {
      const text = visibleText(file);
      expect(
        hits(text, [
          ...MANIFEST_VOCABULARY,
          ...CONTROL_VOCABULARY,
          'PROBE-SKU',
        ]),
      ).toEqual([]);
      // fault-class labels of ARCHITECTURE 9.2 (F1..F5, B1)
      expect(text.match(/\b(F[1-5]|B1)\b/g) ?? []).toEqual([]);
    },
  );

  it('team/** imports nothing from the sandbox, the evals or the control schema', () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from\s+'([^']+)'/g))
        if (/(^|\/)(sandbox|evals|routes)\//.test(match[1]))
          offenders.push(`${rel(file)} imports ${match[1]}`);
      if (/\bcontrol\.(fault_schedules|scenario_runs)\b/.test(text))
        offenders.push(`${rel(file)} names a control table`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('neutral value-domain bullets exempt from the literal scan (lead ruling)', () => {
  it('lists them, and none of them says which value is healthy', () => {
    const exempt = FILES.filter((f) => f.endsWith('.md')).flatMap((file) =>
      neutralDomainLines(readFileSync(file, 'utf8')).exempt.map(
        (line) => `${rel(file)}: ${line}`,
      ),
    );
    // the domain sections exist in the cache, pool and routing runbooks
    expect(exempt.length).toBeGreaterThanOrEqual(5);
    for (const line of exempt) expect(line).not.toMatch(EVALUATIVE);
  });
});

describe('DA-01: a forbidden literal is not encoded by paraphrase either', () => {
  // The routing runbook avoids the literal `primary` (which the D7 grep test
  // forbids) by describing it as "the English word meaning first in rank (the
  // leading node of a leader and follower pair)". The recorded live trace
  // .local/dev/live/team-trace.json shows Nemotron decoding it: "the
  // routing-semantics runbook confirms that 'primary' (meaning 'first in
  // rank') is the authority option". The value is the healthy baseline and the
  // stale_replica repair. Either state the enum domain plainly (and have the
  // lead allowlist it as domain vocabulary) or make it observable; a riddle
  // keeps the grep test green while the answer still reaches the model.
  it('routing-semantics.md does not describe the authority option by a riddle', () => {
    const text = readFileSync(
      path.join(TEAM_DIR, 'runbooks/routing-semantics.md'),
      'utf8',
    );
    expect(
      hits(text, ['first in rank', 'leader and follower', 'leading node']),
    ).toEqual([]);
  });
});

describe('prompt text that mentions delegation (reported, not judged here)', () => {
  // DEMO_REVIEW states whether prompts script delegation. This pins the
  // sentences so a change to them is visible in review.
  it('lists every model-visible sentence that tells a role to delegate', () => {
    const sentences: string[] = [];
    for (const file of FILES) {
      const text = visibleText(file);
      for (const sentence of text.split(/(?<=[.!?])\s+|\n/))
        if (/delegat|wait_for_children|verifier/i.test(sentence))
          sentences.push(`${rel(file)}: ${sentence.trim().slice(0, 160)}`);
    }
    // The planner, investigator and specialist prompts, the closing-check
    // notice and the verification_required refusal all name delegation.
    expect(sentences.some((s) => s.includes('prompts.ts'))).toBe(true);
    expect(
      sentences.some((s) => /Delegate it now with delegate_task/.test(s)),
    ).toBe(true);
    expect(
      sentences.some((s) =>
        /delegate a verifier \(delegate_task with role verifier\)/.test(s),
      ),
    ).toBe(true);
    expect(sentences.length).toBeGreaterThan(10);
  });
});
