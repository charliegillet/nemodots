// W5.3 integration devil's advocate: the tool-policy registry and the typed
// team toolset, attacked without PostgreSQL, Redis, a model or a network.
//
// Expected outcomes come from TOOL_COVERAGE.md and CONTRACTS.md, not from the
// registry's own tables: the set of tools an incident Dot may run is written
// out here by hand from the doc (R6, R7, R8, M3, M9/M10), every other name must
// be refused for every origin.
//
// Tests whose title starts with `FINDING` encode the documented behaviour and
// FAIL while the implementation deviates; they are listed in
// docs/nemodots/review/TOOL_PATH_REVIEW.md. They are never weakened.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { computerInputs } from '../../../../src/shared/computer-types.js';
import { connectionActionTool } from '../../../../src/shared/connection-types.js';
import { pageReviewTool } from '../../../../src/shared/page-review.js';
import {
  ADAPTER_POLICY,
  ROLE_CAPABILITIES,
  TEAM_TOOL_INPUTS,
  TEAM_TOOL_ORDER,
  toolSchemas,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  TOOL_POLICY_ENTRIES,
  ToolPolicyError,
  classifyTool,
  createApprovalRevalidator,
  createToolPolicy,
  parseIncidentDotIds,
  withToolPolicy,
  type ToolOrigin,
} from '../../../../src/server/nemodots/interception/index.js';

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const COVERAGE = readFileSync(
  join(APP_ROOT, 'docs', 'nemodots', 'TOOL_COVERAGE.md'),
  'utf8',
);

const INCIDENT = 'dot-incident';
const incidentPolicy = () => createToolPolicy({ incidentDotIds: [INCIDENT] });
const ORIGINS: (ToolOrigin | undefined)[] = [
  undefined,
  'server',
  'mcp',
  'composio',
  'learned_skill',
];

// Hand-written from TOOL_COVERAGE.md: the only tools an incident Dot keeps
// (instrumented, no mutation): R6, R7, R8 and the two executor-less client
// tools M3 and M9/M10. Everything else is disabled or policy-checked.
const INSTRUMENTED_FOR_INCIDENT = new Set([
  'list_authorized_spaces',
  'list_space_pages',
  'read_space_page',
  pageReviewTool.name,
  connectionActionTool.name,
]);

describe('default rule: a tool that is not in the table is disabled for incident Dots', () => {
  const hostile = [
    // names that sound harmless
    'read_file',
    'get_secret',
    'list_everything',
    'readonly_query',
    'read_only_delete',
    'get_task_status',
    'search',
    'fetch',
    'http_request',
    'run_sql',
    'shell',
    'bash',
    'exec',
    // near misses of registered names
    'read_space_page ',
    ' read_space_page',
    'read_space_page\u0000',
    'read_space_page\n',
    'Read_Space_Page',
    'READ_SPACE_PAGE',
    'read-space-page',
    'read_space_pages',
    'edit_space_page2',
    'computer_',
    'computer_snapshot2',
    'COMPUTER_SNAPSHOT',
    'copilotkit_load_skill2',
    // JavaScript object keys
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '',
  ];

  it('refuses every hostile name for every origin', () => {
    const policy = incidentPolicy();
    for (const toolName of hostile)
      for (const origin of ORIGINS) {
        const decision = policy.decideTool({
          dotId: INCIDENT,
          toolName,
          origin,
        });
        expect(
          decision.allow,
          `${JSON.stringify(toolName)} via ${origin ?? 'no origin'}`,
        ).toBe(false);
      }
  });

  it('allows exactly the hand-listed instrumented tools, and only as server tools', () => {
    const policy = incidentPolicy();
    for (const toolName of INSTRUMENTED_FOR_INCIDENT) {
      for (const origin of [undefined, 'server'] as const)
        expect(
          policy.decideTool({ dotId: INCIDENT, toolName, origin }).allow,
          `${toolName} via ${origin}`,
        ).toBe(true);
      // The same name arriving from a connection, Composio or a learned skill
      // is not the OpenDots tool: a name is not an identity.
      for (const origin of ['mcp', 'composio', 'learned_skill'] as const)
        expect(
          policy.decideTool({ dotId: INCIDENT, toolName, origin }).allow,
          `${toolName} spoofed via ${origin}`,
        ).toBe(false);
    }
  });

  it('every registry entry not in the instrumented set is refused for incident Dots', () => {
    const policy = incidentPolicy();
    for (const entry of TOOL_POLICY_ENTRIES) {
      if (INSTRUMENTED_FOR_INCIDENT.has(entry.id)) continue;
      const samples = entry.names ?? [
        'mail__send_mail',
        'GMAIL_SEND_EMAIL',
        entry.id,
      ];
      for (const toolName of samples)
        for (const origin of entry.origins) {
          const decision = policy.decideTool({
            dotId: INCIDENT,
            toolName,
            origin,
          });
          expect(
            decision.allow,
            `${entry.id}: ${toolName} via ${origin}`,
          ).toBe(false);
        }
    }
  });

  it('a name containing read, list or get is not proof of read-only (R9, R12, R13)', () => {
    const policy = incidentPolicy();
    for (const toolName of [
      'read_public_page',
      'computer_read',
      'computer_files_list',
      'computer_files_read',
      'computer_snapshot',
      'computer_screenshot',
      'copilotkit_read_skill_file',
    ]) {
      expect(classifyTool(toolName).class === 'read', toolName).toBe(true);
      expect(
        policy.decideTool({ dotId: INCIDENT, toolName }).allow,
        toolName,
      ).toBe(false);
    }
    // An MCP readOnlyHint is not an input to the decision at all.
    const hinted = policy.decideTool({
      dotId: INCIDENT,
      toolName: 'mail__search_mail',
      origin: 'mcp',
      args: { readOnlyHint: true, readOnly: true },
    });
    expect(hinted.allow).toBe(false);
  });

  it('every computer_* tool, including human_* takeover controls, is refused (R12, M6, M7)', () => {
    const policy = incidentPolicy();
    const names = Object.keys(computerInputs);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names)
      expect(
        policy.decideTool({ dotId: INCIDENT, toolName: `computer_${name}` })
          .allow,
        name,
      ).toBe(false);
  });
});

describe('policy-checked page writes (M1, M2)', () => {
  it('refuses create and edit by default, whatever space or page id the model supplies', () => {
    const policy = incidentPolicy();
    for (const toolName of ['create_space_page', 'edit_space_page'])
      for (const args of [
        {},
        { spaceId: 'projection' },
        { spaceId: 'other-space', id: 'p1', content: 'x' },
        { spaceId: null },
        { spaceId: ['projection'] },
        'not an object',
        null,
      ])
        expect(
          policy.decideTool({ dotId: INCIDENT, toolName, args }).allow,
          `${toolName} ${JSON.stringify(args)}`,
        ).toBe(false);
  });

  it('hands the allow predicates only the model-supplied strings, never an object that could be truthy by accident', () => {
    const seen: unknown[] = [];
    const policy = createToolPolicy({
      incidentDotIds: [INCIDENT],
      allowIncidentPageCreate: (request) => {
        seen.push(request);
        return request.spaceId === 'projection';
      },
      allowIncidentPageEdit: (request) => {
        seen.push(request);
        return request.spaceId === 'projection' && request.pageId === 'p-ok';
      },
    });
    expect(
      policy.decideTool({
        dotId: INCIDENT,
        toolName: 'create_space_page',
        args: { spaceId: { toString: () => 'projection' } },
      }).allow,
    ).toBe(false);
    expect(
      policy.decideTool({
        dotId: INCIDENT,
        toolName: 'edit_space_page',
        args: { spaceId: 'projection', id: ['p-ok'] },
      }).allow,
    ).toBe(false);
    expect(
      policy.decideTool({
        dotId: INCIDENT,
        toolName: 'edit_space_page',
        args: { spaceId: 'projection', id: 'p-ok' },
      }).allow,
    ).toBe(true);
    expect(seen).toContainEqual({ dotId: INCIDENT, spaceId: undefined });
  });
});

describe('scope of the policy (I4)', () => {
  it('with the incident list empty every decision is allow, including unknown names', () => {
    const policy = createToolPolicy({ incidentDotIds: [] });
    for (const toolName of ['edit_space_page', 'GMAIL_SEND_EMAIL', 'rm_rf'])
      expect(policy.decideTool({ dotId: 'any', toolName }).allow).toBe(true);
    expect(
      policy.decideConnectionCall({ dotId: 'any', tool: 't', via: 'agent' })
        .allow,
    ).toBe(true);
    expect(
      policy.decideComputerAction({
        dotId: 'any',
        action: 'exec',
        actor: 'agent',
      }).allow,
    ).toBe(true);
  });

  it('matches Dot ids exactly (no trimming, case folding or prefix matching)', () => {
    const policy = createToolPolicy({ incidentDotIds: ['Dot-A'] });
    for (const dotId of ['dot-a', 'Dot-A ', ' Dot-A', 'Dot-', 'Dot-A\u0000', ''])
      expect(policy.isIncidentDot(dotId), JSON.stringify(dotId)).toBe(false);
    expect(policy.isIncidentDot('Dot-A')).toBe(true);
  });

  it('reads the list on every decision, so removing a Dot id from a running process takes effect immediately', () => {
    const ids = new Set<string>();
    const policy = createToolPolicy({ incidentDotIds: () => ids });
    expect(
      policy.decideTool({ dotId: 'd', toolName: 'edit_space_page' }).allow,
    ).toBe(true);
    ids.add('d');
    expect(
      policy.decideTool({ dotId: 'd', toolName: 'edit_space_page' }).allow,
    ).toBe(false);
  });

  it('parseIncidentDotIds: whitespace and empty entries never create a wildcard id', () => {
    expect(parseIncidentDotIds(undefined)).toEqual([]);
    expect(parseIncidentDotIds('')).toEqual([]);
    expect(parseIncidentDotIds(' , ,')).toEqual([]);
    expect(parseIncidentDotIds(' a , b,,c ')).toEqual(['a', 'b', 'c']);
    expect(parseIncidentDotIds('*')).toEqual(['*']);
    // '*' is a literal id, not a pattern.
    expect(createToolPolicy({ incidentDotIds: ['*'] }).isIncidentDot('x')).toBe(
      false,
    );
  });
});

describe('connection and computer boundaries (R10, M6, M7, M8)', () => {
  it('refuses the agent paths for an incident Dot; only the owner-approved call and owner actions pass', () => {
    const policy = incidentPolicy();
    expect(
      policy.decideConnectionCall({ dotId: INCIDENT, tool: 't', via: 'agent' })
        .allow,
    ).toBe(false);
    expect(
      policy.decideConnectionCall({
        dotId: INCIDENT,
        tool: 't',
        via: 'owner_approval',
      }).allow,
    ).toBe(true);
    for (const action of ['snapshot', 'exec', 'human_takeover', 'files_read'])
      expect(
        policy.decideComputerAction({
          dotId: INCIDENT,
          action,
          actor: 'agent',
        }).allow,
        action,
      ).toBe(false);
    // The actor and `via` are set by server code, never by a tool argument:
    // a hostile value of either type is not 'owner'.
    for (const actor of ['Owner', 'owner ', 'admin', undefined, null] as never[])
      expect(
        policy.decideComputerAction({ dotId: INCIDENT, action: 'exec', actor })
          .allow,
        String(actor),
      ).toBe(false);
    for (const via of ['Owner_Approval', 'approval', undefined] as never[])
      expect(
        policy.decideConnectionCall({ dotId: INCIDENT, tool: 't', via }).allow,
        String(via),
      ).toBe(false);
  });
});

describe('approval revalidation (M9, M10, I6)', () => {
  const request = (dotId: string, vector: unknown) =>
    ({
      approvalId: 'a',
      threadId: 't',
      dotId,
      connectionId: 'c',
      tool: 'send_mail',
      vector,
    }) as never;
  const vectorOf = (receiptId: string) => [
    { sourceKey: 'opendots.page/p', sourceRevision: 1, receiptId },
  ];

  it('an incident Dot with a NULL vector is refused (unbound_evidence); nothing else is consulted', async () => {
    const checkCurrent = vi.fn(async () => ({ ok: true as const }));
    const policy = createToolPolicy({
      incidentDotIds: [INCIDENT],
      revalidateApproval: createApprovalRevalidator({
        isIncidentDot: (id) => id === INCIDENT,
        checkCurrent,
      }),
    });
    await expect(
      policy.revalidateApproval!(request(INCIDENT, null)),
    ).resolves.toMatchObject({ ok: false, code: 'unbound_evidence' });
    expect(checkCurrent).not.toHaveBeenCalled();
  });

  it('an incident Dot with a stale vector is refused (stale_evidence) and names the receipt', async () => {
    const stale = '11111111-1111-4111-8111-111111111111';
    const policy = createToolPolicy({
      incidentDotIds: [INCIDENT],
      revalidateApproval: createApprovalRevalidator({
        isIncidentDot: (id) => id === INCIDENT,
        checkCurrent: async (ids) =>
          ids.includes(stale)
            ? { ok: false, receiptId: stale, detail: 'superseded' }
            : { ok: true },
      }),
    });
    await expect(
      policy.revalidateApproval!(request(INCIDENT, vectorOf(stale))),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale_evidence',
      receiptId: stale,
    });
  });

  it('an incident Dot with a bound vector and no installed evidence check fails closed (throws, so the route answers 503)', async () => {
    const policy = createToolPolicy({ incidentDotIds: [INCIDENT] });
    await expect(
      policy.revalidateApproval!(
        request(INCIDENT, vectorOf('22222222-2222-4222-8222-222222222222')),
      ),
    ).rejects.toThrow();
  });
});

describe('executor wrapper (I7)', () => {
  it('a Composio-slug tool of an incident Dot never reaches its executor, whatever the model passes', async () => {
    const execute = vi.fn(async () => ({ data: 'sent' }));
    const [gmail] = withToolPolicy(
      [{ name: 'GMAIL_SEND_EMAIL', execute } as never],
      {
        dotId: INCIDENT,
        policy: incidentPolicy,
        origin: () => 'composio',
      },
    );
    await expect(
      (gmail as never as { execute: (a: unknown) => Promise<unknown> }).execute(
        { to: 'victim@example.com', __origin: 'server' },
      ),
    ).rejects.toBeInstanceOf(ToolPolicyError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a composio tool that shadows a page tool name is still a Composio tool', async () => {
    const execute = vi.fn(async () => 'edited');
    const [shadow] = withToolPolicy([{ name: 'edit_space_page', execute }], {
      dotId: INCIDENT,
      policy: incidentPolicy,
      origin: () => 'composio',
    });
    await expect(shadow.execute!({} as never)).rejects.toBeInstanceOf(
      ToolPolicyError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('an executor-less tool (client tool) is returned untouched, so it can never become a server effect', () => {
    const client = { name: connectionActionTool.name };
    const [same] = withToolPolicy([client], {
      dotId: INCIDENT,
      policy: incidentPolicy,
    });
    expect(same).toBe(client);
  });

  it('the policy is resolved per call: swapping to allow-all after wrapping does not silently stay wrapped-allow', async () => {
    let policy = createToolPolicy({ incidentDotIds: [] });
    const execute = vi.fn(async () => 'ok');
    const [tool] = withToolPolicy([{ name: 'edit_space_page', execute }], {
      dotId: INCIDENT,
      policy: () => policy,
    });
    await expect(tool.execute!({} as never)).resolves.toBe('ok');
    policy = incidentPolicy();
    await expect(tool.execute!({} as never)).rejects.toBeInstanceOf(
      ToolPolicyError,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('TOOL_COVERAGE.md rows against the registry', () => {
  const rowIds = (section: RegExp): string[] =>
    [...COVERAGE.matchAll(section)].map((m) => m[1]);
  const docRows = new Set([
    ...rowIds(/^\| (R\d+b?)\s*\|/gm),
    ...rowIds(/^\| (M\d+)\s*\|/gm),
  ]);

  it('the document has the rows this review expects', () => {
    for (const id of ['R1', 'R15', 'M1', 'M16', 'R9b']) expect(docRows).toContain(id);
  });

  it('every row id a registry entry cites exists in the document', () => {
    for (const entry of TOOL_POLICY_ENTRIES)
      for (const row of entry.rows)
        expect(docRows.has(row), `${entry.id} cites ${row}`).toBe(true);
  });

  it('every row that names a model-visible tool is covered by at least one registry entry', () => {
    const covered = new Set(TOOL_POLICY_ENTRIES.flatMap((e) => [...e.rows]));
    for (const row of [
      'R6',
      'R7',
      'R8',
      'R9',
      'R9b',
      'R10',
      'R11',
      'R12',
      'R13',
      'M1',
      'M2',
      'M3',
      'M6',
      'M7',
      'M8',
      'M9',
      'M10',
      'M11',
      'M12',
    ])
      expect(covered.has(row), row).toBe(true);
  });

  it('no registry entry is more permissive than its row: disabled rows stay disabled', () => {
    const mustBeDisabled = new Map([
      ['search_web', 'R9'],
      ['read_public_page', 'R9'],
      ['copilotkit_load_skill', 'R13'],
      ['copilotkit_read_skill_file', 'R13'],
    ]);
    for (const [name, row] of mustBeDisabled) {
      const found = classifyTool(name);
      expect(found.treatment, `${name} (${row})`).toBe('disabled');
    }
    expect(classifyTool('mail__send', 'mcp').treatment).toBe('disabled');
    expect(classifyTool('GMAIL_SEND_EMAIL', 'composio').treatment).toBe(
      'disabled',
    );
    expect(classifyTool('anything_at_all', 'composio').matched).toBe(true);
    expect(classifyTool('anything_at_all', 'composio').treatment).toBe(
      'disabled',
    );
    expect(classifyTool('anything_at_all').matched).toBe(false);
  });
});

describe('the typed team toolset (TOOL_COVERAGE section 1)', () => {
  const DOC_TOOLS = [
    'observe_source',
    'list_runbooks',
    'read_runbook',
    'get_task_status',
    'wait_for_children',
    'publish_finding',
    'delegate_task',
    'propose_action',
    'request_replan',
  ];

  it('exposes exactly the nine documented tools, in a fixed order, and no shell, SQL, HTTP or file tool', () => {
    expect(Object.keys(TEAM_TOOL_INPUTS).sort()).toEqual([...DOC_TOOLS].sort());
    expect([...TEAM_TOOL_ORDER].sort()).toEqual([...DOC_TOOLS].sort());
    expect(toolSchemas().map((s) => s.name)).toEqual([...TEAM_TOOL_ORDER]);
    for (const name of DOC_TOOLS) expect(COVERAGE).toContain(`\`${name}\``);
    for (const bad of ['shell', 'sql', 'redis', 'fetch', 'http', 'file', 'exec'])
      for (const name of DOC_TOOLS) expect(name.includes(bad), name).toBe(false);
  });

  it('the schemas the model sees contain no identity, fence or capability fields', () => {
    const FORBIDDEN = [
      'missionId',
      'attemptId',
      'fencingToken',
      'generation',
      'capabilities',
      'ownerId',
      'modelCallId',
      'toolCallId',
      'idempotencyKey',
      'dependencyVector',
      'causedByActionId',
      'requiredSources',
      'expectedTargetVersion',
    ];
    const text = JSON.stringify(toolSchemas());
    for (const field of FORBIDDEN)
      expect(text.includes(`"${field}"`), field).toBe(false);
  });

  const MINIMAL: Record<string, unknown> = {
    observe_source: { sourceKey: 'checkout.health' },
    list_runbooks: {},
    read_runbook: { id: 'acceptance' },
    get_task_status: { taskId: '4b8e7f0a-6d3c-4f1e-9a52-0c1d2e3f4a5b' },
    wait_for_children: {},
    publish_finding: {
      claim: 'x',
      supportingReceiptIds: [],
      confidence: 'low',
    },
    delegate_task: {
      title: 'Check pool',
      role: 'verifier',
      question: 'Is the pool starved?',
      dependsOn: [],
      justification: 'Needed to confirm.',
    },
    propose_action: {
      action: 'set_config',
      payload: {
        key: 'db.pool_max',
        value: 8,
        expectedCurrentValueDigest:
          '0000000000000000000000000000000000000000000000000000000000000000',
      },
      supportingReceiptIds: [],
      rationale: 'raise it',
    },
    request_replan: { reason: 'the plan does not fit' },
  };

  it('the minimal arguments used below are themselves valid (so each rejection is caused by the extra key)', () => {
    for (const name of DOC_TOOLS)
      expect(
        TEAM_TOOL_INPUTS[name as keyof typeof TEAM_TOOL_INPUTS].safeParse(
          MINIMAL[name],
        ).success,
        name,
      ).toBe(true);
  });

  it('every tool rejects a model-supplied identity, fence, capability or provenance key', () => {
    const extras: Record<string, unknown> = {
      missionId: '4b8e7f0a-6d3c-4f1e-9a52-0c1d2e3f4a5b',
      attemptId: '4b8e7f0a-6d3c-4f1e-9a52-0c1d2e3f4a5b',
      fencingToken: 99,
      generation: 99,
      capabilities: ['propose_config_change'],
      role: 'cache_specialist',
      ownerId: 'someone-else',
      causedByActionId: '4b8e7f0a-6d3c-4f1e-9a52-0c1d2e3f4a5b',
      dependencyVector: [],
      idempotencyKey: 'k',
      modelCallId: '4b8e7f0a-6d3c-4f1e-9a52-0c1d2e3f4a5b',
      trust: 'authoritative',
      ['__proto__']: { polluted: true },
    };
    for (const name of DOC_TOOLS)
      for (const [key, value] of Object.entries(extras)) {
        // delegate_task legitimately names the child's role; its capabilities
        // are still never accepted (derived from role and parent).
        if (name === 'delegate_task' && key === 'role') continue;
        const args = JSON.parse(
          JSON.stringify({
            ...(MINIMAL[name] as object),
            [key]: value,
          }),
        );
        expect(
          TEAM_TOOL_INPUTS[name as keyof typeof TEAM_TOOL_INPUTS].safeParse(
            args,
          ).success,
          `${name} + ${key}`,
        ).toBe(false);
      }
    // JSON.parse keeps '__proto__' as an own key; it must be rejected too.
    const proto = JSON.parse('{"sourceKey":"checkout.health","__proto__":{"x":1}}');
    expect(TEAM_TOOL_INPUTS.observe_source.safeParse(proto).success).toBe(false);
  });

  it('propose_action rejects extra keys at every level (payload, top level) and a payload of the other action', () => {
    const base = MINIMAL.propose_action as {
      payload: Record<string, unknown>;
    };
    const parse = (value: unknown) =>
      TEAM_TOOL_INPUTS.propose_action.safeParse(value);
    expect(parse(MINIMAL.propose_action).success).toBe(true);
    expect(
      parse({
        ...base,
        payload: {
          ...base.payload,
          causedByActionId: '4b8e7f0a-6d3c-4f1e-9a52-0c1d2e3f4a5b',
        },
      }).success,
    ).toBe(false);
    expect(parse({ ...base, causedByActionId: 'x' }).success).toBe(false);
    expect(parse({ ...base, expectedTargetVersion: 1 }).success).toBe(false);
    expect(
      parse({
        ...base,
        action: 'set_config',
        payload: { namespace: 'ns-b', reason: 'flush' },
      }).success,
    ).toBe(false);
    expect(
      parse({
        ...base,
        action: 'flush_cache_namespace',
        payload: base.payload,
      }).success,
    ).toBe(false);
    expect(
      parse({
        ...base,
        action: 'flush_cache_namespace',
        payload: { namespace: 'ns-b', reason: 'flush', extra: true },
      }).success,
    ).toBe(false);
  });

  it('propose_action rejects an unknown ActionKind however it is spelled', () => {
    const base = MINIMAL.propose_action as object;
    for (const action of [
      'run_sql',
      'delete_config',
      'set_config ',
      'SET_CONFIG',
      'set_config\n',
      'flush_cache',
      '__proto__',
      'constructor',
      '',
      null,
      7,
      ['set_config'],
    ])
      expect(
        TEAM_TOOL_INPUTS.propose_action.safeParse({ ...base, action }).success,
        JSON.stringify(action),
      ).toBe(false);
  });

  it('the adapter policy and the role table cannot be edited at run time', () => {
    expect(Object.isFrozen(ADAPTER_POLICY)).toBe(true);
    expect(Object.isFrozen(ADAPTER_POLICY.set_config)).toBe(true);
    expect(Object.isFrozen(ROLE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(ROLE_CAPABILITIES.investigator)).toBe(true);
    expect(() => {
      (ROLE_CAPABILITIES.investigator as string[]).push('propose_config_change');
    }).toThrow();
    expect(ROLE_CAPABILITIES.investigator).not.toContain('propose_config_change');
    // An investigator holds no propose capability at all (D5).
    for (const capability of ROLE_CAPABILITIES.investigator)
      expect(capability.startsWith('propose')).toBe(false);
  });

  it('read_runbook ids that are not catalogue ids are rejected at the schema (I13)', () => {
    for (const id of [
      '../x',
      '..',
      '../../../etc/passwd',
      '/etc/passwd',
      'checkout-architecture/../../x',
      'checkout-architecture.md',
      'Checkout-Architecture',
      '%2e%2e%2fx',
      'a\u0000b',
      'a b',
      'acceptance\n',
      '_hidden',
      '-x',
      'a'.repeat(65),
      '',
      'аcceptance', // Cyrillic a
    ])
      expect(
        TEAM_TOOL_INPUTS.read_runbook.safeParse({ id }).success,
        JSON.stringify(id),
      ).toBe(false);
  });
});
