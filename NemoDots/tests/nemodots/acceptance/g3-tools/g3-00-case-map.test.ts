// Gate 3 coverage map: every TEST_PROMPT gate-3 bullet (TP3.1-TP3.7) and every execution-path row of
// TOOL_COVERAGE.md sections 2 and 3 (R1-R15, M1-M16) must be named by at least one test in this folder.
// A row that the suite does not name FAILS this test; a row whose only test cannot run yet fails in that test, never here. The map is hand-written from the two documents.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.ts') && f !== 'g3-00-case-map.test.ts')
  .map((f) => ({ file: f, text: readFileSync(join(HERE, f), 'utf8') }));

const named = (token: string) =>
  sources.filter(({ text }) => text.includes(`[${token}]`)).map((s) => s.file);

// TEST_PROMPT gate 3, one id per bullet.
const TEST_PROMPT_CASES: [string, string][] = [
  [
    'TP3.1',
    'every enabled read has scoped provenance; every enabled mutation is policy-checked at its boundary; disabled paths fail clearly',
  ],
  [
    'TP3.2',
    'permission revocation; cross-Dot/Space/resource identities; model-supplied ids grant nothing',
  ],
  [
    'TP3.3',
    'unknown tools and unclassified capabilities fail closed; a name containing read is not proof of read-only',
  ],
  [
    'TP3.4',
    'no shell/browser in the protected toolset; no host-shell fallback, raw DB credentials or Docker socket to the model',
  ],
  [
    'TP3.5',
    'instruction-like text in logs, tool results, pages and runbooks stays untrusted data',
  ],
  [
    'TP3.6',
    'approved callbacks keep payload binding and fresh evidence validation after reconnect; upstream owner approval semantics preserved',
  ],
  [
    'TP3.7',
    'Crusoe keys and Intelligence secrets are server-side only (built assets checked without printing values)',
  ],
];

// TOOL_COVERAGE.md sections 2 (reads) and 3 (mutations).
const ROWS = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R9b',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'M1',
  'M2',
  'M3',
  'M4',
  'M5',
  'M6',
  'M7',
  'M8',
  'M9',
  'M10',
  'M11',
  'M12',
  'M13',
  'M14',
  'M15',
  'M16',
];

describe('gate 3 case map', () => {
  it.each(TEST_PROMPT_CASES)('%s (%s) is named by at least one test', (id) => {
    expect(named(id), `no test is named [${id}]`).not.toEqual([]);
  });

  it.each(ROWS.map((row) => [row] as const))(
    'TOOL_COVERAGE row %s is named by at least one test',
    (row) => {
      expect(named(row), `no test is named [${row}]`).not.toEqual([]);
    },
  );

  it('the nine team tools of TOOL_COVERAGE section 1 each have a strictness test and an executor case', () => {
    const contract = sources.find((s) => s.file.startsWith('g3-01'))!.text;
    const executors = sources.find((s) => s.file.startsWith('g3-09'))!.text;
    expect(contract).toContain('DOCUMENTED_TOOLS');
    for (const tool of [
      'observe_source',
      'list_runbooks',
      'read_runbook',
      'delegate_task',
      'get_task_status',
      'wait_for_children',
      'publish_finding',
      'propose_action',
      'request_replan',
    ])
      expect(contract, tool).toContain(`'${tool}'`);
    for (const tag of [
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6',
      'T7',
      'T8',
      'T-fence',
      'T-idem',
      'T-scope',
    ])
      expect(executors, tag).toContain(`[${tag}]`);
    // the nine tools are all exercised by an executor case, not only by a strictness test
    for (const tool of [
      'observe_source',
      'list_runbooks',
      'read_runbook',
      'delegate_task',
      'get_task_status',
      'wait_for_children',
      'publish_finding',
      'propose_action',
      'request_replan',
    ])
      expect(executors, tool).toContain(`'${tool}'`);
  });
});
