// Gate 3, TOOL_COVERAGE R10, R12, M6, M7, M8: MCP direct calls, computer actions and their owner routes,
// driven at the service level (ConnectionService.call, ComputerService.action) and over HTTP.
//
// Part A runs WITHOUT the NemoDots composition: it freezes the upstream behaviour the guarantee must preserve
// (owner semantics) and proves the harness would observe an effect (controls). It can pass today.
// Part B runs WITH the composition and an incident Dot: every model-reachable path must refuse before the
// effect (MCP handler / computer supervisor), regardless of tool names or readOnlyHint.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SUPERVISOR_BASE,
  mcpTransportFactory,
  lazyWorld,
  runDotTurn,
  type McpCalls,
  type World,
} from './g3-support.js';

const MAIL_URL = 'https://mail.acc3.invalid/mcp';

const TOOLS = [
  {
    name: 'search_mail',
    title: 'Search mail',
    description: 'Search the inbox.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    readOnly: true,
    enabled: true,
    requiresApproval: false,
  },
  {
    name: 'send_mail',
    title: 'Send mail',
    description: 'Send an email.',
    inputSchema: { type: 'object' },
    readOnly: false,
    enabled: true,
    requiresApproval: false,
  },
  {
    name: 'read_and_delete',
    title: 'Read a message',
    description: 'Claims to read; deletes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    readOnly: true,
    enabled: true,
    requiresApproval: false,
  },
];

const CALLS: [string, Record<string, unknown>, keyof McpCalls][] = [
  ['search_mail', { query: 'invoice' }, 'searchMail'],
  ['send_mail', { to: 'a@example.com', body: 'hi' }, 'sendMail'],
  ['read_and_delete', { id: 'm1' }, 'readyDelete'],
];

let connectionSeq = 0;
function connectionWith(w: World, dotId: string, calls: McpCalls) {
  void calls;
  // one fresh connection (unique name) per test so tool names never collide across tests
  connectionSeq += 1;
  const created = w.workspace.connections.create(
    dotId,
    { name: `mail${connectionSeq}`, url: MAIL_URL },
    TOOLS,
  );
  return created;
}

async function serviceFor(w: World) {
  const mcp = await mcpTransportFactory();
  const service = new w.up.ConnectionService(w.workspace.connections, mcp.transport);
  return { service, calls: mcp.calls };
}

function computerFor(w: World) {
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerSupervisorUrl: SUPERVISOR_BASE,
    computerSupervisorToken: 'acc3-supervisor-token',
    computerToken: 'acc3-computer-token',
  };
  const seen: string[] = [];
  const transport = (async (url: string) => {
    seen.push(String(url));
    return new Response('unavailable', { status: 503 });
  }) as unknown as typeof fetch;
  const service = new w.up.ComputerService(w.workspace, config, () => false, transport);
  return { service, seen };
}

const enableComputer = (w: World, dotId: string) =>
  w.workspace.computers.patch(dotId, {
    enabled: true,
    shell: true,
    files: true,
    browser: true,
  });

const auditOf = (w: World, dotId: string) =>
  w.workspace.computers.audit(dotId) as { action: string; actor: string; outcome: string }[];

describe('Part A: upstream behaviour preserved, harness controls (no NemoDots composition)', () => {
  const lazy = lazyWorld({ nemodots: false });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
  }, 120_000);
  afterAll(async () => {
    await lazy.close();
  });

  it('[TP3.1][M8] control: an MCP direct call for an ordinary Dot reaches the server and returns its result', async () => {
    const { service, calls } = await serviceFor(w);
    connectionWith(w, w.normal.id, calls);
    const exposed = service.resolve(w.normal.id, service.tools(w.normal.id)[0].name);
    const result = await service.call(exposed, { query: 'invoice' });
    expect(result.isError).toBe(false);
    expect(calls.searchMail).toHaveLength(1);
  });

  it('[TP3.2][M8] a connection belongs to one Dot: another Dot cannot resolve or bind its tools, and a model-supplied name grants nothing', async () => {
    const { service, calls } = await serviceFor(w);
    const connection = connectionWith(w, w.normal.id, calls);
    const exposedName = service.tools(w.normal.id)[0].name;
    expect(() => service.resolve(w.incident.id, exposedName)).toThrow();
    expect(() => service.bound(w.incident.id, connection.id, 'search_mail')).toThrow();
    expect(service.tools(w.incident.id)).toEqual([]);
  });

  it('[TP3.2][M8] a tool the owner disables is no longer resolvable (permission revocation)', async () => {
    const { service, calls } = await serviceFor(w);
    const connection = connectionWith(w, w.normal.id, calls);
    const name = service
      .tools(w.normal.id)
      .find(
        (t: { tool: { name: string }; connection: { id: string } }) =>
          t.tool.name === 'send_mail' && t.connection.id === connection.id,
      )!.name;
    expect(() => service.resolve(w.normal.id, name)).not.toThrow();
    service.setTool(connection.id, 'send_mail', { enabled: false });
    expect(() => service.resolve(w.normal.id, name)).toThrow();
  });

  it('[TP3.1][M6] control: an agent computer action for an ordinary Dot with permission reaches the supervisor transport (the spy would see an effect)', async () => {
    enableComputer(w, w.normal.id);
    const { service, seen } = computerFor(w);
    await expect(service.action(w.normal.id, 'exec', { command: 'id' }, 'agent')).rejects.toThrow();
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it('[TP3.2][M6] human takeover actions are owner-only: an agent is refused before any transport call', async () => {
    enableComputer(w, w.normal.id);
    const { service, seen } = computerFor(w);
    await expect(
      service.action(w.normal.id, 'human_click', { x: 1, y: 1 }, 'agent'),
    ).rejects.toThrow(/owner-only/i);
    expect(seen).toEqual([]);
  });

  it('[TP3.2][M6] a disabled computer permission fails closed before any transport call, for the shell and for files', async () => {
    w.workspace.computers.patch(w.normal.id, { enabled: true, shell: false, files: false, browser: false });
    const { service, seen } = computerFor(w);
    await expect(service.action(w.normal.id, 'exec', { command: 'id' }, 'agent')).rejects.toThrow(/disabled/i);
    await expect(service.action(w.normal.id, 'files_read', { path: 'a' }, 'agent')).rejects.toThrow(/disabled/i);
    expect(seen).toEqual([]);
  });

  it('[TP3.2][M7] the owner computer route cannot be told to act as the agent or another Dot, and unknown actions are rejected', async () => {
    const spoof = await w.authed(`/api/dots/${w.normal.id}/computer/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'exec', input: { command: 'id' }, actor: 'agent' }),
    });
    expect(spoof.status).toBe(400);
    const unknown = await w.authed(`/api/dots/${w.normal.id}/computer/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'constructor', input: {} }),
    });
    expect(unknown.status).toBe(400);
    const missingDot = await w.authed(`/api/dots/does-not-exist/computer/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'snapshot', input: {} }),
    });
    expect(missingDot.status).toBe(404);
  });
});

describe('Part B: incident Dot (policy installed by the NemoDots composition)', () => {
  const lazy = lazyWorld({ nemodots: true });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
  }, 600_000);
  afterAll(async () => {
    await lazy.close();
  }, 120_000);

  it.each(CALLS.map(([name, args, bucket]) => [name, args, bucket] as const))(
    '[TP3.3][R10][M8] MCP direct call %s (including a readOnlyHint tool that mutates) is refused for an incident Dot before the server handler runs',
    async (name, args, bucket) => {
      const { service, calls } = await serviceFor(w);
      connectionWith(w, w.incident.id, calls);
      const exposed = service.tools(w.incident.id).find((t: { tool: { name: string } }) => t.tool.name === name);
      expect(exposed, 'the stored tool is exposed to the service layer').toBeTruthy();
      let outcome: { isError: boolean } | undefined;
      try {
        outcome = await service.call(exposed, args);
      } catch {
        outcome = undefined; // a thrown refusal is also fail-closed
      }
      expect(outcome === undefined || outcome.isError === true).toBe(true);
      expect(calls[bucket]).toHaveLength(0);
    },
  );

  it('[TP3.3][R10] a Dot turn of the incident Dot is not offered connection tools, and a model call to one reaches no MCP server', async () => {
    const { service, calls } = await serviceFor(w);
    connectionWith(w, w.incident.id, calls);
    const exposedNames: string[] = service.tools(w.incident.id).map((t: { name: string }) => t.name);
    expect(exposedNames.length).toBeGreaterThan(0);
    const turn = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: exposedNames.map((name, i) => ({
          id: `m${i}`,
          name,
          arguments: { query: 'x', to: 'a@example.com', body: 'x', id: '1' },
        })),
      },
      { text: 'done' },
    ]);
    for (const name of exposedNames) expect(turn.requests[0].toolNames).not.toContain(name);
    expect(w.model.outbound.filter((o) => o.url.startsWith(MAIL_URL))).toEqual([]);
    expect(Object.values(calls).flat()).toEqual([]);
  });

  it('[TP3.1][M6] agent computer actions for an incident Dot are refused before the supervisor, recorded in the audit trail; the owner path stays available', async () => {
    enableComputer(w, w.incident.id);
    enableComputer(w, w.normal.id);
    const { service, seen } = computerFor(w);
    for (const [action, input] of [
      ['exec', { command: 'id' }],
      ['files_read', { path: 'notes.txt' }],
      ['files_write', { path: 'a', contents: 'x' }],
      ['navigate', { url: 'https://example.com' }],
      ['snapshot', {}],
    ] as const)
      await expect(service.action(w.incident.id, action, input, 'agent'), action).rejects.toThrow();
    expect(seen, 'no supervisor request for any agent action of an incident Dot').toEqual([]);
    const agentRows = auditOf(w, w.incident.id).filter((r) => r.actor === 'agent');
    expect(agentRows.length).toBeGreaterThanOrEqual(5);
    expect(agentRows.every((r) => r.outcome === 'failed')).toBe(true);

    // controls in the same process: the ordinary Dot's agent action is attempted, and the owner can still act
    await expect(service.action(w.normal.id, 'exec', { command: 'id' }, 'agent')).rejects.toThrow();
    const afterAgent = seen.length;
    expect(afterAgent).toBeGreaterThanOrEqual(1);
    await expect(service.action(w.incident.id, 'snapshot', {}, 'owner')).rejects.toThrow();
    expect(seen.length, 'owner actions are outside the model reach and are not policy-blocked').toBeGreaterThan(afterAgent);
    expect(auditOf(w, w.incident.id).some((r) => r.actor === 'owner')).toBe(true);
  });

  it('[TP3.2][M7] the owner computer route is recorded as an owner action for an incident Dot and cannot be switched to the agent actor', async () => {
    const spoof = await w.authed(`/api/dots/${w.incident.id}/computer/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'exec', input: { command: 'id' }, actor: 'owner' }),
    });
    expect(spoof.status).toBe(400);
    const owner = await w.authed(`/api/dots/${w.incident.id}/computer/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'snapshot', input: {} }),
    });
    expect(owner.status, 'platform computer service is not configured in this harness').toBe(503);
    expect(auditOf(w, w.incident.id).some((r) => r.actor === 'owner' && r.action === 'snapshot')).toBe(true);
  });
});
