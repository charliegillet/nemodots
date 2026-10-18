// W5.3: the interception policy registry (TOOL_COVERAGE sections 2-3) as a
// pure decision table. Every model-visible name OpenDots can register gets the
// matrix treatment; anything else, including look-alikes and names that merely
// contain read/list/get, is deny_unknown and refused for incident Dots. With
// NEMODOTS_INCIDENT_DOT_IDS empty nothing is wrapped or refused (I4).
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkToolCall,
  classifyTool,
  createIncidentPolicy,
  decideTool,
  INCIDENT_ENV,
  isIncidentDot,
  parseIncidentDotIds,
  REGISTERED_TOOL_NAMES,
  resetInterception,
  withToolPolicy,
} from '../../../../src/server/nemodots/interception/index.js';
import { computerInputs } from '../../../../src/shared/computer-types.js';

afterEach(() => {
  delete process.env[INCIDENT_ENV];
  resetInterception();
});

// TOOL_COVERAGE.md rows, verbatim treatments for incident agents.
const MATRIX: Record<string, { row: string; treatment: string }> = {
  list_authorized_spaces: { row: 'R6', treatment: 'instrumented' },
  list_space_pages: { row: 'R7', treatment: 'instrumented' },
  read_space_page: { row: 'R8', treatment: 'instrumented' },
  search_web: { row: 'R9', treatment: 'disabled' },
  read_public_page: { row: 'R9', treatment: 'disabled' },
  copilotkit_load_skill: { row: 'R13', treatment: 'disabled' },
  copilotkit_read_skill_file: { row: 'R13', treatment: 'disabled' },
  create_space_page: { row: 'M1', treatment: 'policy-checked' },
  edit_space_page: { row: 'M2', treatment: 'policy-checked' },
  review_space_page: { row: 'M3', treatment: 'instrumented' },
  request_connection_action: { row: 'M10', treatment: 'policy-checked' },
};

describe('matrix rows', () => {
  it('TP-30 every registered name has exactly its TOOL_COVERAGE row and treatment', () => {
    expect([...REGISTERED_TOOL_NAMES].sort()).toEqual(
      Object.keys(MATRIX).sort(),
    );
    for (const [name, want] of Object.entries(MATRIX))
      expect(classifyTool(name), name).toMatchObject(want);
  });

  it('TP-30b every computer_* action name is disabled (R12/M6)', () => {
    const names = Object.keys(computerInputs).map((a) => `computer_${a}`);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names)
      expect(classifyTool(name), name).toMatchObject({
        row: 'M6',
        treatment: 'disabled',
      });
  });
});

describe('fail closed: unknown, look-alike and "read-sounding" names', () => {
  it.each([
    'read',
    'read_secrets',
    'list_env',
    'get_config',
    'get_task_status', // a NemoDots team tool name is not an OpenDots Dot tool
    'observe_source',
    'propose_action',
    'read_space_page_v2',
    'read_space_page ',
    ' read_space_page',
    'Read_space_page',
    'read_space_page​',
    'rеad_space_page', // Cyrillic е
    'readonly_delete_space',
    'mail__read_inbox', // MCP tool with readOnlyHint: still unknown
    'mail__send_mail',
    'GMAIL_SEND_EMAIL', // Composio
    'COMPOSIO_SEARCH_TOOLS',
    'computerexec',
    'Computer_exec',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    '',
  ])('TP-31 %j is deny_unknown and refused for an incident Dot', (name) => {
    expect(classifyTool(name).treatment).toBe('deny_unknown');
    expect(decideTool(name, () => true, {})).toMatchObject({ refused: true });
  });

  it('TP-31b disabled and deny_unknown are refused even when the policy predicate says yes', () => {
    for (const name of [
      'search_web',
      'copilotkit_load_skill',
      'computer_exec',
      'x',
    ])
      expect(decideTool(name, () => true, {})).toMatchObject({ refused: true });
    // instrumented passes without consulting the predicate
    expect(
      decideTool(
        'read_space_page',
        () => {
          throw new Error('predicate must not run');
        },
        {},
      ),
    ).toBeNull();
  });
});

describe('incident identity (I4)', () => {
  it('TP-32 the id list is exact: no prefix, substring or case match', () => {
    const env = { [INCIDENT_ENV]: ' dot-1 , dot-22 ,, ' };
    expect([...parseIncidentDotIds(env[INCIDENT_ENV])].sort()).toEqual([
      'dot-1',
      'dot-22',
    ]);
    expect(isIncidentDot('dot-1', env)).toBe(true);
    expect(isIncidentDot('dot-2', env)).toBe(false);
    expect(isIncidentDot('dot-10', env)).toBe(false);
    expect(isIncidentDot('DOT-1', env)).toBe(false);
    expect(isIncidentDot('', env)).toBe(false);
  });

  it('TP-33 with the list empty every hook passes through unchanged', async () => {
    const policy = createIncidentPolicy({ env: {} });
    const execute = async () => 'ran';
    const tools = [{ name: 'edit_space_page', execute }] as never[];
    const wrapped = withToolPolicy(tools, {
      dotId: 'any',
      policy,
      defaultSpaceId: null,
    });
    expect((wrapped[0] as { execute: unknown }).execute).toBe(execute);
    expect(
      checkToolCall({ dotId: 'any', policy, defaultSpaceId: null }, 'x', {}),
    ).toBeNull();
    expect(
      policy.connectionCall({ dotId: 'any', connectionId: 'c', tool: 't' }),
    ).toBeNull();
    expect(
      policy.computerAction({ dotId: 'any', action: 'exec', actor: 'agent' }),
    ).toBeNull();
    expect(
      await policy.revalidateApproval({
        threadId: 't',
        dotId: 'any',
        approvalId: 'a',
        dependencyVector: null,
      }),
    ).toEqual({ ok: true });
  });

  it('TP-34 for an incident Dot, withToolPolicy refuses at execution and leaves executor-less tools alone', async () => {
    const policy = createIncidentPolicy({ env: { [INCIDENT_ENV]: 'dot-x' } });
    let ran = 0;
    const tools = [
      { name: 'edit_space_page', execute: async () => ran++ },
      { name: 'mail__send_mail', execute: async () => ran++ },
      { name: 'read_space_page', execute: async () => ran++ },
      { name: 'request_connection_action' },
    ] as never[];
    const wrapped = withToolPolicy(tools, {
      dotId: 'dot-x',
      policy,
      defaultSpaceId: null,
    }) as { name: string; execute?: (a: unknown) => Promise<unknown> }[];
    // The wrapper refuses synchronously, before the executor is entered.
    expect(() => wrapped[0].execute!({})).toThrow(/not available/);
    expect(() => wrapped[1].execute!({})).toThrow(/not available/);
    await wrapped[2].execute!({});
    expect(ran).toBe(1);
    expect(wrapped[3]).toBe(tools[3]);
    expect(wrapped[3].execute).toBeUndefined();
  });
});
