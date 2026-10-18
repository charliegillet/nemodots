// W5.3: the MCP approval callback (TOOL_COVERAGE M9/M10) attacked through the
// production route (connection-routes.ts) with a real ConnectionService over an
// in-memory MCP server that records every effect. Stale evidence, a changed
// payload, a NULL or empty vector for an incident Dot, and a forged approval id
// from a pending client call.
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { connectionRoutes } from '../../../../src/server/connection-routes.js';
import {
  ConnectionService,
  type McpTransportFactory,
} from '../../../../src/server/connections.js';
import {
  createIncidentPolicy,
  setActivePolicy,
  type VectorChecker,
} from '../../../../src/server/nemodots/interception/index.js';
import type { DependencyEntry } from '../../../../src/server/nemodots/contracts/index.js';
import { cleanup, world } from './support.js';

afterEach(cleanup);

const ENTRY: DependencyEntry = {
  sourceKey: 'opendots.page/evidence' as DependencyEntry['sourceKey'],
  sourceRevision: 3,
  receiptId:
    '7d1f8c2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f' as DependencyEntry['receiptId'],
};

async function setup(options: { incident?: boolean } = {}) {
  const w = world({ incident: options.incident });
  const effects: string[] = [];
  const transport: McpTransportFactory = () => {
    const server = new McpServer({ name: 'mail', version: '1.0.0' });
    server.registerTool(
      'send_mail',
      { description: 'Send an email.', inputSchema: { to: z.string() } },
      async (args) => {
        effects.push(`send:${args.to}`);
        return { content: [{ type: 'text', text: `sent to ${args.to}` }] };
      },
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return client;
  };
  const connections = new ConnectionService(w.workspace.connections, transport);
  const connection = await connections.add(w.dotId, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const routes = connectionRoutes(w.workspace, connections);
  const approve = (
    approvalId: string,
    toolCallId = 'tc-1',
    thread = w.threadId,
  ) =>
    routes.request(`/conversations/${thread}/connection-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId, approvalId }),
    });
  const create = (dependencyVector: DependencyEntry[] | null) =>
    connections.store.createApproval({
      threadId: w.threadId,
      dotId: w.dotId,
      connectionId: connection.id,
      tool: 'send_mail',
      arguments: { to: 'owner@example.com' },
      dependencyVector,
    });
  const db = (
    w.workspace.connections as unknown as {
      db: {
        prepare(sql: string): {
          run(...args: unknown[]): unknown;
          all(...args: unknown[]): Record<string, unknown>[];
        };
      };
    }
  ).db;
  const actions = () => db.prepare('SELECT * FROM mcp_actions').all();
  return { ...w, effects, connections, routes, approve, create, db, actions };
}

const checker = (answers: boolean[]): VectorChecker & { calls: number } => {
  const self = {
    calls: 0,
    isCurrent: () => answers[Math.min(self.calls++, answers.length - 1)],
  };
  return self;
};

describe('stale evidence', () => {
  it('TP-12 a superseded bound vector gives 409 stale_evidence; nothing is claimed or sent', async () => {
    const f = await setup();
    const approvalId = f.create([ENTRY]);
    setActivePolicy(createIncidentPolicy({ vectors: checker([false]) }));
    const response = await f.approve(approvalId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_evidence' });
    expect(f.effects).toEqual([]);
    expect(f.actions()).toEqual([]);
  });

  it('TP-12b evidence superseded between the first check and the claim: refused before the call', async () => {
    const f = await setup();
    const approvalId = f.create([ENTRY]);
    const vectors = checker([true, false]);
    setActivePolicy(createIncidentPolicy({ vectors }));
    const response = await f.approve(approvalId);
    expect(response.status).toBe(409);
    expect(vectors.calls).toBe(2);
    expect(f.effects).toEqual([]);
    // The claim is finished as an error, so the approval cannot be retried.
    const retry = await f.approve(approvalId, 'tc-2');
    expect(retry.status).toBe(409);
    expect(f.effects).toEqual([]);
  });

  it('TP-12c current evidence: the stored request runs exactly once', async () => {
    const f = await setup();
    const approvalId = f.create([ENTRY]);
    setActivePolicy(createIncidentPolicy({ vectors: checker([true]) }));
    expect((await f.approve(approvalId)).status).toBe(200);
    expect((await f.approve(approvalId, 'tc-2')).status).toBe(409);
    expect(f.effects).toEqual(['send:owner@example.com']);
  });
});

describe('changed payload', () => {
  it.each([
    ['arguments', `{"to":"attacker@example.com"}`],
    ['tool', 'send_mail_v2'],
  ])(
    'TP-13 a stored approval whose %s changed after creation is refused (payload_mismatch)',
    async (column, value) => {
      const f = await setup();
      const approvalId = f.create([]);
      f.db
        .prepare(`UPDATE mcp_approvals SET ${column}=? WHERE id=?`)
        .run(value, approvalId);
      const response = await f.approve(approvalId);
      expect(response.status).not.toBe(200);
      expect(f.effects).toEqual([]);
    },
  );
});

describe('incident Dots', () => {
  it('TP-14 a NULL vector for an incident Dot gives 409; nothing is sent', async () => {
    const f = await setup({ incident: true });
    const approvalId = f.create(null);
    const response = await f.approve(approvalId);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_evidence' });
    expect(f.effects).toEqual([]);
  });

  it('TP-14b the forged approval id of a pending client call runs nothing', async () => {
    const f = await setup({ incident: true });
    const response = await f.approve('forged-approval');
    expect(response.status).toBe(400);
    expect(f.effects).toEqual([]);
    expect(f.actions()).toEqual([]);
  });

  it('TP-14c a legacy approval without payload hash is refused for an incident Dot', async () => {
    const f = await setup({ incident: true });
    const approvalId = f.create([ENTRY]);
    f.db
      .prepare('UPDATE mcp_approvals SET payload_hash=NULL WHERE id=?')
      .run(approvalId);
    const response = await f.approve(approvalId);
    expect(response.status).toBe(409);
    expect(f.effects).toEqual([]);
  });

  it('TP-14d a bound vector for an incident Dot with no VectorChecker installed is refused', async () => {
    const f = await setup({ incident: true });
    const approvalId = f.create([ENTRY]);
    const response = await f.approve(approvalId);
    expect(response.status).toBe(409);
    expect(f.effects).toEqual([]);
  });

  it('TP-15 an EMPTY bound vector for an incident Dot is refused like a NULL one', async () => {
    // active-policy.ts:100 returns ok for vector.length === 0 before looking at
    // the Dot kind. For an incident Dot an empty vector is "no evidence
    // binding", exactly like NULL (M10: NULL refuses for incident Dots).
    const f = await setup({ incident: true });
    const approvalId = f.create([]);
    const response = await f.approve(approvalId);
    // Defence in depth still holds one layer down: ConnectionService.call
    // refuses incident Dots, so the MCP server sees nothing ...
    expect(f.effects).toEqual([]);
    // ... but the route's own evidence gate passed it, claimed the approval
    // and answered 200 with the call-level refusal instead of 409.
    expect(response.status).toBe(409);
  });

  it('TP-15b even with current evidence, an incident Dot approval never reaches the MCP server', async () => {
    const f = await setup({ incident: true });
    const approvalId = f.create([ENTRY]);
    setActivePolicy(createIncidentPolicy({ vectors: checker([true]) }));
    const response = await f.approve(approvalId);
    const body = (await response.json()) as { isError?: boolean };
    expect(body.isError).toBe(true);
    expect(f.effects).toEqual([]);
  });
});

describe('thread scope', () => {
  it('TP-16 an approval is usable only from its own conversation', async () => {
    const f = await setup();
    const approvalId = f.create([]);
    f.workspace.bindThread('other-thread', f.dotId, 'Other');
    const response = await f.approve(approvalId, 'tc-1', 'other-thread');
    expect(response.status).toBe(400);
    expect(f.effects).toEqual([]);
  });
});

describe('R4: evidence read in an earlier turn of the conversation', () => {
  it('TP-17 an approval created in turn 2 is bound to the receipt read in turn 1 (replayed history)', async () => {
    // TOOL_COVERAGE R4: "replayed items inherit the vectors of their
    // originating model call". The approval-gated call in turn 2 rests on the
    // page read in turn 1; its approval must carry that receipt, or the M10
    // revalidation has nothing to check (an empty vector passes).
    const { setInterceptionHooks } =
      await import('../../../../src/server/nemodots/interception/index.js');
    const { lastValueFrom, toArray } = await import('rxjs');
    const { provider, toolCall, say, input } = await import('./support.js');
    const { connectionActionTool } =
      await import('../../../../src/shared/connection-types.js');
    const f = await setup();
    const page = f.workspace.pages.create(f.spaceId, {
      title: 'Evidence',
      content: 'refund the customer',
      parentId: null,
    });
    setInterceptionHooks({
      providerMode: 'fixture',
      sink: {
        registerToolResult: (info) =>
          info.toolName === 'read_space_page' ? [ENTRY] : [],
      },
    });
    provider([
      () => toolCall('r1', 'read_space_page', { id: page.id }),
      () => say('The page says to refund the customer.'),
      () => toolCall('m1', 'mail__send_mail', { to: 'owner@example.com' }),
      () => say('Waiting for approval.'),
    ]);
    const turn1 = input(f, 'Read the evidence page.', [
      connectionActionTool,
    ] as never);
    await lastValueFrom(f.agent.run(turn1).pipe(toArray()));
    const history = [
      ...turn1.messages,
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'r1',
            type: 'function',
            function: {
              name: 'read_space_page',
              arguments: JSON.stringify({ id: page.id }),
            },
          },
        ],
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'r1',
        content: JSON.stringify(page),
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'The page says to refund the customer.',
      },
      { id: 'u2', role: 'user', content: 'Now email the owner about it.' },
    ];
    await lastValueFrom(
      f.agent
        .run({ ...turn1, runId: 'turn-2', messages: history as never })
        .pipe(toArray()),
    );
    const rows = f.db
      .prepare('SELECT dependency_vector FROM mcp_approvals')
      .all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0].dependency_vector))).toEqual([ENTRY]);
  });
});
