import { describe, expect, it } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { vi } from 'vitest';
import { computerInputs } from '../../../src/shared/computer-types.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import { pageReviewTool } from '../../../src/shared/page-review.js';
import { pageAccess, pageTools } from '../../../src/server/page-tools.js';
import {
  ALLOW_ALL_POLICY,
  classifyTool,
  createToolPolicy,
  getActivePolicy,
  hasActivePolicy,
  parseIncidentDotIds,
  setActivePolicy,
  TOOL_POLICY_ENTRIES,
} from '../../../src/server/nemodots/interception/index.js';
import { dotFixture, textResponse } from './helpers.js';

describe('registry completeness', () => {
  it('maps every page tool OpenDots registers', () => {
    const f = dotFixture();
    const names = pageTools(
      pageAccess(f.workspace, f.dot.spaceId, 'thread', () => {}),
    ).map((tool) => tool.name);
    expect(names.sort()).toEqual(
      [
        'create_space_page',
        'edit_space_page',
        'list_authorized_spaces',
        'list_space_pages',
        'read_space_page',
      ].sort(),
    );
    const treatments = Object.fromEntries(
      names.map((name) => [name, classifyTool(name)]),
    );
    for (const name of names) expect(treatments[name].matched).toBe(true);
    expect(treatments.read_space_page).toMatchObject({
      class: 'read',
      treatment: 'instrumented',
    });
    expect(treatments.list_space_pages.class).toBe('read');
    expect(treatments.list_authorized_spaces.class).toBe('read');
    expect(treatments.create_space_page).toMatchObject({
      class: 'mutate',
      treatment: 'policy-checked',
    });
    expect(treatments.edit_space_page).toMatchObject({
      class: 'mutate',
      treatment: 'policy-checked',
    });
  });

  it('maps research, computer, learned-skill and client tools', () => {
    expect(classifyTool('search_web')).toMatchObject({
      matched: true,
      treatment: 'disabled',
      rows: expect.arrayContaining(['R9']),
    });
    expect(classifyTool('read_public_page')).toMatchObject({
      matched: true,
      treatment: 'disabled',
    });
    for (const action of Object.keys(computerInputs)) {
      const entry = classifyTool(`computer_${action}`);
      expect(entry.matched, action).toBe(true);
      expect(['disabled', 'n/a-blocked']).toContain(entry.treatment);
    }
    expect(classifyTool('computer_exec').class).toBe('mutate');
    expect(classifyTool('computer_snapshot').class).toBe('read');
    expect(classifyTool('computer_files_read').class).toBe('read');
    expect(classifyTool('computer_files_write').class).toBe('mutate');
    expect(classifyTool('copilotkit_load_skill')).toMatchObject({
      matched: true,
      class: 'read',
      treatment: 'disabled',
    });
    expect(classifyTool('copilotkit_read_skill_file').treatment).toBe(
      'disabled',
    );
    expect(classifyTool(pageReviewTool.name)).toMatchObject({
      matched: true,
      class: 'mutate',
      treatment: 'instrumented',
    });
    expect(classifyTool(connectionActionTool.name)).toMatchObject({
      matched: true,
      treatment: 'instrumented',
    });
  });

  it('maps sample MCP and Composio tool names by pattern and by origin', () => {
    for (const name of ['mail__search_mail', 'work_mail__send_mail_', 'a__b_2'])
      expect(classifyTool(name), name).toMatchObject({
        matched: true,
        id: 'mcp_tools',
        class: 'unknown',
        treatment: 'disabled',
      });
    for (const name of ['GMAIL_SEND_EMAIL', 'COMPOSIO_SEARCH_TOOLS'])
      expect(classifyTool(name), name).toMatchObject({
        matched: true,
        id: 'composio_tools',
        treatment: 'disabled',
      });
    expect(classifyTool('anything', 'mcp').id).toBe('mcp_tools');
    expect(classifyTool('anything', 'composio').id).toBe('composio_tools');
    // An origin narrows: a server-registered tool cannot pose as an MCP tool.
    expect(classifyTool('mail__send', 'server').matched).toBe(false);
    // And an MCP tool cannot pose as a trusted server tool.
    expect(classifyTool('edit_space_page', 'mcp').id).toBe('mcp_tools');
  });

  it('denies unknown names by default, whatever they sound like', () => {
    for (const name of [
      'totally_new_tool',
      'get_secret',
      'list_everything',
      'read_file',
      'readonly_query',
      '',
    ]) {
      expect(classifyTool(name), name).toMatchObject({
        id: 'deny_unknown',
        matched: false,
        class: 'unknown',
        treatment: 'disabled',
      });
    }
  });

  it('has unique entry ids and a row reference for every entry', () => {
    const ids = TOOL_POLICY_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of TOOL_POLICY_ENTRIES) {
      expect(entry.rows.length).toBeGreaterThan(0);
      expect(entry.names || entry.pattern).toBeTruthy();
    }
  });

  it('classifies every tool name in the request DotAgent actually sends to the model', async () => {
    const f = dotFixture({
      computerSupervisorUrl: 'https://supervisor.invalid',
      computerSupervisorToken: 'fixture',
      computerToken: 'fixture',
    });
    f.workspace.connections.create(
      f.dot.id,
      { name: 'Mail', url: 'https://mail.example.com/mcp' },
      [
        {
          name: 'send_mail',
          title: 'Send mail',
          description: 'Send an email.',
          inputSchema: { type: 'object', properties: {} },
          readOnly: false,
          enabled: true,
          requiresApproval: true,
        },
      ],
    );
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(textResponse('Ready.'));
    await lastValueFrom(
      f.agent
        .run({
          ...f.input,
          tools: [
            { name: pageReviewTool.name, description: '', parameters: {} },
            {
              name: connectionActionTool.name,
              description: '',
              parameters: {},
            },
          ],
        })
        .pipe(toArray()),
    );
    const body = JSON.parse(String(network.mock.calls[0][1]?.body)) as {
      tools: { function: { name: string } }[];
    };
    const names = body.tools.map((tool) => tool.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_web',
        'read_public_page',
        'edit_space_page',
        'mail__send_mail',
        'computer_snapshot',
        'computer_exec',
        pageReviewTool.name,
        connectionActionTool.name,
      ]),
    );
    for (const name of names)
      expect(classifyTool(name).matched, `unclassified: ${name}`).toBe(true);
  });
});

describe('incident detection and decisions (I4)', () => {
  it('parses NEMODOTS_INCIDENT_DOT_IDS', () => {
    expect(parseIncidentDotIds(undefined)).toEqual([]);
    expect(parseIncidentDotIds('')).toEqual([]);
    expect(parseIncidentDotIds(' a , b,,c ')).toEqual(['a', 'b', 'c']);
  });

  it('with the list empty every decision passes, including unknown names', () => {
    const policy = createToolPolicy({ incidentDotIds: [] });
    for (const toolName of [
      'edit_space_page',
      'search_web',
      'computer_exec',
      'GMAIL_SEND_EMAIL',
      'mail__send',
      'never_heard_of_it',
    ])
      expect(policy.decideTool({ dotId: 'dot-1', toolName })).toEqual({
        allow: true,
      });
    expect(
      policy.decideConnectionCall({ dotId: 'dot-1', tool: 'x', via: 'agent' }),
    ).toEqual({ allow: true });
    expect(
      policy.decideComputerAction({
        dotId: 'dot-1',
        action: 'exec',
        actor: 'agent',
      }),
    ).toEqual({ allow: true });
    expect(policy.isIncidentDot('dot-1')).toBe(false);
  });

  it('applies the registry only to listed Dots', () => {
    const policy = createToolPolicy({ incidentDotIds: ['inc'] });
    const decide = (dotId: string, toolName: string, args?: unknown) =>
      policy.decideTool({ dotId, toolName, args });
    expect(decide('inc', 'read_space_page')).toEqual({ allow: true });
    expect(decide('inc', 'list_space_pages')).toEqual({ allow: true });
    expect(decide('inc', 'edit_space_page')).toMatchObject({
      allow: false,
      code: 'policy_checked_refused',
    });
    expect(decide('inc', 'create_space_page')).toMatchObject({
      allow: false,
      code: 'policy_checked_refused',
    });
    expect(decide('inc', 'search_web')).toMatchObject({
      allow: false,
      code: 'disabled_for_incident',
    });
    expect(decide('inc', 'computer_exec')).toMatchObject({ allow: false });
    expect(decide('inc', 'surprise')).toMatchObject({
      allow: false,
      code: 'deny_unknown',
    });
    expect(
      policy.decideTool({
        dotId: 'inc',
        toolName: 'mail__send',
        origin: 'mcp',
      }),
    ).toMatchObject({ allow: false });
    // The same calls for an unlisted Dot.
    for (const name of ['edit_space_page', 'search_web', 'surprise'])
      expect(decide('other', name)).toEqual({ allow: true });
  });

  it('lets an incident Dot create pages only where the predicate allows', () => {
    const policy = createToolPolicy({
      incidentDotIds: ['inc'],
      allowIncidentPageCreate: ({ spaceId }) => spaceId === 'projection',
    });
    expect(
      policy.decideTool({
        dotId: 'inc',
        toolName: 'create_space_page',
        args: { spaceId: 'projection', title: 'x' },
      }),
    ).toEqual({ allow: true });
    expect(
      policy.decideTool({
        dotId: 'inc',
        toolName: 'create_space_page',
        args: { spaceId: 'elsewhere', title: 'x' },
      }),
    ).toMatchObject({ allow: false });
    expect(
      policy.decideTool({
        dotId: 'inc',
        toolName: 'create_space_page',
        args: { title: 'no space' },
      }),
    ).toMatchObject({ allow: false });
  });

  it('reads a lazily supplied id list on every decision', () => {
    let ids: string[] = [];
    const policy = createToolPolicy({ incidentDotIds: () => ids });
    expect(policy.isIncidentDot('late')).toBe(false);
    ids = ['late'];
    expect(policy.isIncidentDot('late')).toBe(true);
  });

  it('refuses direct MCP calls and agent computer actions for incident Dots only', () => {
    const policy = createToolPolicy({ incidentDotIds: ['inc'] });
    expect(
      policy.decideConnectionCall({ dotId: 'inc', tool: 'x', via: 'agent' }),
    ).toMatchObject({ allow: false, code: 'agent_action_refused' });
    expect(
      policy.decideConnectionCall({
        dotId: 'inc',
        tool: 'x',
        via: 'owner_approval',
      }),
    ).toEqual({ allow: true });
    expect(
      policy.decideComputerAction({
        dotId: 'inc',
        action: 'exec',
        actor: 'agent',
      }),
    ).toMatchObject({ allow: false });
    expect(
      policy.decideComputerAction({
        dotId: 'inc',
        action: 'exec',
        actor: 'owner',
      }),
    ).toEqual({ allow: true });
  });
});

describe('active policy registry', () => {
  it('defaults to allow-all and restores it on null', () => {
    expect(getActivePolicy()).toBe(ALLOW_ALL_POLICY);
    expect(hasActivePolicy()).toBe(false);
    const policy = createToolPolicy({ incidentDotIds: ['x'] });
    setActivePolicy(policy);
    expect(getActivePolicy()).toBe(policy);
    expect(hasActivePolicy()).toBe(true);
    setActivePolicy(null);
    expect(getActivePolicy()).toBe(ALLOW_ALL_POLICY);
  });
});
