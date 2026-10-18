import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  ConnectionService,
  type McpTransportFactory,
} from '../../../src/server/connections.js';
import { connectionRoutes } from '../../../src/server/connection-routes.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import {
  INCIDENT_ENV,
  createIncidentPolicy,
  setActivePolicy,
} from '../../../src/server/nemodots/interception/index.js';
import {
  cleanup,
  collectingSink,
  entryFor,
  fixture,
  text,
  toolCall,
} from './support.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

async function setup(options: { incident?: boolean } = {}) {
  const f = fixture(options);
  const sent = vi.fn();
  const transport: McpTransportFactory = () => {
    const server = new McpServer({ name: 'mail', version: '1.0.0' });
    server.registerTool(
      'send mail!',
      {
        description: 'Send an email.',
        inputSchema: { to: z.string() },
      },
      async (args) => {
        sent(args);
        return { content: [{ type: 'text', text: `Sent to ${args.to}` }] };
      },
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return client;
  };
  const connections = new ConnectionService(f.workspace.connections, transport);
  await connections.add(f.dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const routes = connectionRoutes(f.workspace, connections);
  const approve = (toolCallId: string, approvalId: string) =>
    routes.request('/conversations/thread/connection-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId, approvalId }),
    });
  const approvals = () =>
    (
      f.workspace.connections as unknown as {
        db: { prepare(sql: string): { all(): Record<string, unknown>[] } };
      }
    ).db
      .prepare('SELECT * FROM mcp_approvals')
      .all();
  return { ...f, connections, routes, sent, approve, approvals };
}

// Drives a real Dot turn: read a page (registers a receipt), then call the
// approval-gated tool, so the approval is created by the tool executor path.
async function approvalFromTurn(f: Awaited<ReturnType<typeof setup>>) {
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'Evidence',
    content: 'x',
    parentId: null,
  });
  const entry = entryFor(page.id, page.revision);
  collectingSink({
    registerToolResult: (info) =>
      info.toolName === 'read_space_page' ? [entry] : [],
  });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolCall('r1', 'read_space_page', { id: page.id }))
    .mockResolvedValueOnce(
      toolCall('m1', 'mail__send_mail', { to: 'a@example.com' }),
    )
    .mockResolvedValueOnce(text('Waiting for approval.'));
  await lastValueFrom(
    f.agent
      .run(f.input('Send the report.', [connectionActionTool] as never))
      .pipe(toArray()),
  );
  const rows = f.approvals();
  expect(rows).toHaveLength(1);
  return { entry, row: rows[0], approvalId: String(rows[0].id) };
}

it('an approval created through the tool executor path carries the turn vector', async () => {
  const f = await setup();
  const { entry, row } = await approvalFromTurn(f);
  expect(JSON.parse(String(row.dependency_vector))).toEqual([entry]);
});

it('a superseded receipt gives 409 stale_evidence and nothing is claimed or run', async () => {
  const f = await setup();
  const { approvalId } = await approvalFromTurn(f);
  const checks: unknown[] = [];
  setActivePolicy(
    createIncidentPolicy({
      vectors: {
        isCurrent: (vector) => {
          checks.push(vector);
          return false;
        },
      },
    }),
  );
  const response = await f.approve('tc1', approvalId);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'stale_evidence' });
  expect(checks).toHaveLength(1);
  expect(f.sent).not.toHaveBeenCalled();
  // Not claimed: the owner can ask the Dot again, and a current vector runs.
  expect(
    await (
      await f.routes.request('/conversations/thread/connection-actions/tc1')
    ).json(),
  ).toBeNull();
});

it('an unchanged vector executes exactly once', async () => {
  const f = await setup();
  const { approvalId } = await approvalFromTurn(f);
  setActivePolicy(createIncidentPolicy({ vectors: { isCurrent: () => true } }));
  const first = await f.approve('tc1', approvalId);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    isError: false,
    text: 'Sent to a@example.com',
  });
  const again = await f.approve('tc1', approvalId);
  expect(await again.json()).toEqual({
    isError: false,
    text: 'Sent to a@example.com',
  });
  expect(f.sent).toHaveBeenCalledOnce();
});

it('a NULL vector passes for an ordinary Dot', async () => {
  const f = await setup();
  const approvalId = f.workspace.connections.createApproval({
    threadId: 'thread',
    dotId: f.dot.id,
    connectionId: f.workspace.connections.list(f.dot.id)[0].id,
    tool: 'send mail!',
    arguments: { to: 'a@example.com' },
  });
  expect(f.approvals()[0].dependency_vector).toBeNull();
  const response = await f.approve('tc1', approvalId);
  expect(response.status).toBe(200);
  expect(f.sent).toHaveBeenCalledOnce();
});

it('a NULL vector is refused for an incident Dot', async () => {
  const f = await setup({ incident: true });
  expect(process.env[INCIDENT_ENV]).toBe(f.dot.id);
  const approvalId = f.workspace.connections.createApproval({
    threadId: 'thread',
    dotId: f.dot.id,
    connectionId: f.workspace.connections.list(f.dot.id)[0].id,
    tool: 'send mail!',
    arguments: { to: 'a@example.com' },
  });
  const response = await f.approve('tc1', approvalId);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'stale_evidence' });
  expect(f.sent).not.toHaveBeenCalled();
});

it('the approval itself keeps its upstream semantics: one claim per approval, payload from the store', async () => {
  const f = await setup();
  const { approvalId } = await approvalFromTurn(f);
  setActivePolicy(createIncidentPolicy({ vectors: { isCurrent: () => true } }));
  expect((await f.approve('tc1', approvalId)).status).toBe(200);
  const second = await f.approve('tc2', approvalId);
  expect(second.status).toBe(409);
  expect(f.sent).toHaveBeenCalledOnce();
});

// Gate 2 item 4: the approval race.
type Setup = Awaited<ReturnType<typeof setup>>;
const rawDb = (f: Setup) =>
  (
    f.workspace.connections as unknown as {
      db: { prepare(sql: string): { run(...v: unknown[]): unknown } };
    }
  ).db;

it('an approval is bound to its payload hash: a changed stored request is refused and never runs', async () => {
  const f = await setup();
  const { approvalId, row } = await approvalFromTurn(f);
  expect(String(row.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
  rawDb(f)
    .prepare('UPDATE mcp_approvals SET arguments=? WHERE id=?')
    .run(JSON.stringify({ to: 'evil@example.com' }), approvalId);
  setActivePolicy(createIncidentPolicy({ vectors: { isCurrent: () => true } }));
  const response = await f.approve('tc1', approvalId);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'payload_mismatch' });
  expect(f.sent).not.toHaveBeenCalled();
});

it('evidence that changes between the first check and execution stops the run', async () => {
  const f = await setup();
  const { approvalId } = await approvalFromTurn(f);
  // current at the first check, superseded by the time of the final check
  const answers = [true, false];
  setActivePolicy(
    createIncidentPolicy({
      vectors: { isCurrent: () => answers.shift() ?? false },
    }),
  );
  const response = await f.approve('tc1', approvalId);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'stale_evidence' });
  expect(f.sent).not.toHaveBeenCalled();
  // the claim is closed with a visible error result, not left running
  expect(
    await (
      await f.routes.request('/conversations/thread/connection-actions/tc1')
    ).json(),
  ).toMatchObject({
    status: 'done',
    result: { isError: true },
  });
});

it('approval does not bypass permissions: a tool disabled after approval is not run, whatever the evidence', async () => {
  const f = await setup();
  const { approvalId } = await approvalFromTurn(f);
  setActivePolicy(createIncidentPolicy({ vectors: { isCurrent: () => true } }));
  const connection = f.workspace.connections.list(f.dot.id)[0];
  f.connections.setTool(connection.id, 'send mail!', { enabled: false });
  const response = await f.approve('tc1', approvalId);
  expect(response.status).toBe(400);
  expect(f.sent).not.toHaveBeenCalled();
});

it('an incident Dot cannot run an approved call even with a current vector', async () => {
  const f = await setup({ incident: true });
  const approvalId = f.workspace.connections.createApproval({
    threadId: 'thread',
    dotId: f.dot.id,
    connectionId: f.workspace.connections.list(f.dot.id)[0].id,
    tool: 'send mail!',
    arguments: { to: 'a@example.com' },
    dependencyVector: [],
  });
  setActivePolicy(createIncidentPolicy({ vectors: { isCurrent: () => true } }));
  const response = await f.approve('tc1', approvalId);
  // the vector check passes; the domain service still refuses an incident Dot
  expect(await response.json()).toMatchObject({ isError: true });
  expect(f.sent).not.toHaveBeenCalled();
});
