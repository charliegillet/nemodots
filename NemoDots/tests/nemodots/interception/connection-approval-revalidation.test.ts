import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import {
  ConnectionService,
  type McpTransportFactory,
} from '../../../src/server/connections.js';
import { connectionRoutes } from '../../../src/server/connection-routes.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import { APPROVAL_TTL_MS } from '../../../src/shared/connection-types.js';
import {
  createApprovalRevalidator,
  createToolPolicy,
  setActivePolicy,
  setInterceptionRuntime,
  type EvidenceCheck,
} from '../../../src/server/nemodots/interception/index.js';
import {
  attachPage,
  dotFixture,
  recordingRuntime,
  textResponse,
  toolCallResponse,
} from './helpers.js';

function world(options: { incident?: boolean } = {}) {
  const f = dotFixture();
  const sent = vi.fn();
  const transport: McpTransportFactory = () => {
    const server = new McpServer({ name: 'mail', version: '1.0.0' });
    server.registerTool(
      'send_mail',
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
  const service = new ConnectionService(f.workspace.connections, transport);
  const connection = f.workspace.connections.create(
    f.dot.id,
    { name: 'Mail', url: 'https://mail.example.invalid/mcp' },
    [
      {
        name: 'send_mail',
        title: 'Send mail',
        description: 'Send an email.',
        inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
        readOnly: false,
        enabled: true,
        requiresApproval: true,
      },
    ],
  );
  // The Dot is incident or not; approvals are always revalidated.
  const superseded = new Set<string>();
  const checks: string[][] = [];
  const checkCurrent = async (ids: readonly string[]): Promise<EvidenceCheck> => {
    checks.push([...ids]);
    const bad = ids.find((id) => superseded.has(id));
    return bad
      ? { ok: false, receiptId: bad, detail: 'superseded' }
      : { ok: true };
  };
  const policy = createToolPolicy({
    // The Dot that asks for the approval is never incident in the executor
    // tests (incident Dots cannot use connection tools at all).
    incidentDotIds: options.incident ? [f.dot.id] : ['some-other-dot'],
    revalidateApproval: createApprovalRevalidator({
      isIncidentDot: (id) => (options.incident ? id === f.dot.id : false),
      checkCurrent,
    }),
  });
  setActivePolicy(policy);
  const routes = connectionRoutes(f.workspace, service);
  const post = (toolCallId: string, approvalId: string, threadId = 'thread') =>
    routes.request(`/conversations/${threadId}/connection-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, toolCallId }),
    });
  return { ...f, sent, service, connection, routes, post, superseded, checks };
}

/** Drives DotAgent so the approval is created by the connection tool executor. */
async function approvalThroughExecutor(
  w: ReturnType<typeof world>,
  runtimeOverrides = {},
) {
  attachPage(w);
  const { runtime, calls } = recordingRuntime(runtimeOverrides);
  setInterceptionRuntime(runtime);
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCallResponse('mail__send_mail', { to: 'ops@example.com' }, 'send-1'),
    )
    .mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const tool = body.messages.find((m) => m.role === 'tool')!;
      const { approvalId } = JSON.parse(tool.content) as { approvalId: string };
      return toolCallResponse(
        connectionActionTool.name,
        { approvalId, summary: 'Send the mail.' },
        'approve-1',
      );
    });
  const events = (await lastValueFrom(
    w.agent
      .run({
        ...w.input,
        tools: [
          { name: connectionActionTool.name, description: '', parameters: {} },
        ],
      })
      .pipe(toArray()),
  )) as BaseEvent[];
  const request = events.find(
    (e) =>
      e.type === EventType.TOOL_CALL_START &&
      (e as { toolCallName?: string }).toolCallName === connectionActionTool.name,
  ) as { toolCallId: string } | undefined;
  // The approval id the model was handed.
  const approvalId = (
    w.workspace.connections as unknown as {
      db: { prepare(s: string): { all(): { id: string }[] } };
    }
  ).db
    .prepare('SELECT id FROM mcp_approvals')
    .all()[0].id;
  return { events, request, approvalId, calls };
}

describe('approval created through the tool executor path', () => {
  it('binds the dependency vector of what the model saw and ends with a pending client tool call', async () => {
    const w = world();
    const { events, request, approvalId, calls } =
      await approvalThroughExecutor(w);
    expect(request?.toolCallId).toBe('approve-1');
    // Pending client tool call: no result was produced server-side.
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(
      events.filter(
        (e) =>
          e.type === EventType.TOOL_CALL_RESULT &&
          (e as { toolCallId?: string }).toolCallId === 'approve-1',
      ),
    ).toEqual([]);
    const approval = w.workspace.connections.approval(approvalId)!;
    expect(approval).toMatchObject({
      dotId: w.dot.id,
      tool: 'send_mail',
      arguments: { to: 'ops@example.com' },
    });
    expect(approval.dependencyVector).not.toBeNull();
    expect(approval.dependencyVector!.length).toBeGreaterThan(0);
    expect(approval.dependencyVector).toEqual(
      calls[0].input.snapshot.dependencyVector,
    );
    expect(w.sent).not.toHaveBeenCalled();
  });

  it('stores no vector when the evidence had no receipt (unresolved)', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w, {
      resolveReceipt: () => null,
    });
    expect(
      w.workspace.connections.approval(approvalId)!.dependencyVector,
    ).toBeNull();
  });

  it('stores no vector without a provenance runtime (plain OpenDots)', async () => {
    const f = dotFixture();
    f.workspace.connections.create(
      f.dot.id,
      { name: 'Mail', url: 'https://mail.example.invalid/mcp' },
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
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolCallResponse('mail__send_mail', {}))
      .mockResolvedValueOnce(textResponse('Waiting.'));
    await lastValueFrom(
      f.agent
        .run({
          ...f.input,
          tools: [
            { name: connectionActionTool.name, description: '', parameters: {} },
          ],
        })
        .pipe(toArray()),
    );
    const row = (
      f.workspace.connections as unknown as {
        db: { prepare(s: string): { all(): { id: string }[] } };
      }
    ).db
      .prepare('SELECT id FROM mcp_approvals')
      .all()[0];
    expect(f.workspace.connections.approval(row.id)!.dependencyVector).toBeNull();
  });
});

describe('revalidation in front of the approval callback', () => {
  it('returns 409 stale_evidence when a bound receipt was superseded, runs nothing and claims nothing', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w);
    const vector = w.workspace.connections.approval(approvalId)!.dependencyVector!;
    w.superseded.add(vector[0].receiptId);

    const response = await w.post('approve-1', approvalId);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'stale_evidence' });
    expect(w.sent).not.toHaveBeenCalled();
    expect(w.workspace.connections.action('thread', 'approve-1')).toBeUndefined();
    expect(w.workspace.connections.actionForApproval(approvalId)).toBeUndefined();
    // The approval record itself is untouched.
    expect(w.workspace.connections.approval(approvalId)).toBeDefined();
  });

  it('executes exactly once when the evidence is unchanged', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w);
    const first = await w.post('approve-1', approvalId);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      isError: false,
      text: 'Sent to ops@example.com',
    });
    // A retried request returns the saved result without running again.
    const retry = await w.post('approve-1', approvalId);
    expect(retry.status).toBe(200);
    // And one approval cannot run again under a fresh tool call id.
    const again = await w.post('approve-2', approvalId);
    expect(again.status).toBe(409);
    expect(w.sent).toHaveBeenCalledTimes(1);
    const checked = new Set(w.checks.flat());
    expect(checked.size).toBeGreaterThan(0);
  });

  it('does not revalidate a request that was already completed (saved result wins)', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w);
    expect((await w.post('approve-1', approvalId)).status).toBe(200);
    const vector = w.workspace.connections.approval(approvalId)!.dependencyVector!;
    w.superseded.add(vector[0].receiptId);
    const retry = await w.post('approve-1', approvalId);
    expect(retry.status).toBe(200);
    expect(w.sent).toHaveBeenCalledTimes(1);
  });

  it('keeps upstream approval semantics: TTL and thread binding are checked first', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w);
    w.workspace.bindThread('other', w.dot.id, 'Other');
    expect((await w.post('x', approvalId, 'other')).status).toBe(400);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + APPROVAL_TTL_MS + 1000);
    const expired = await w.post('x', approvalId);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({
      error: expect.stringContaining('expired'),
    });
    expect(w.checks).toEqual([]);
    expect(w.sent).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the evidence check cannot run', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w);
    const routes = connectionRoutes(w.workspace, w.service, {
      revalidate: async () => {
        throw new Error('ledger unreachable');
      },
    });
    const response = await routes.request(
      '/conversations/thread/connection-actions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, toolCallId: 'approve-1' }),
      },
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('ledger');
    expect(w.sent).not.toHaveBeenCalled();
    expect(w.workspace.connections.action('thread', 'approve-1')).toBeUndefined();
  });

  it('passes straight through when no policy is installed (upstream behaviour)', async () => {
    const w = world();
    const { approvalId } = await approvalThroughExecutor(w);
    setActivePolicy(null);
    const response = await w.post('approve-1', approvalId);
    expect(response.status).toBe(200);
    expect(w.sent).toHaveBeenCalledTimes(1);
  });
});

describe('NULL vector per Dot kind', () => {
  const unbound = (w: ReturnType<typeof world>) =>
    w.workspace.connections.createApproval({
      threadId: 'thread',
      dotId: w.dot.id,
      connectionId: w.connection.id,
      tool: 'send_mail',
      arguments: { to: 'a@example.com' },
    });

  it('passes for a Dot that is not an incident Dot', async () => {
    const w = world();
    const id = unbound(w);
    expect(w.workspace.connections.approval(id)!.dependencyVector).toBeNull();
    const response = await w.post('call-1', id);
    expect(response.status).toBe(200);
    expect(w.sent).toHaveBeenCalledTimes(1);
  });

  it('is refused for an incident Dot, and nothing runs', async () => {
    const w = world({ incident: true });
    const id = unbound(w);
    const response = await w.post('call-1', id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'unbound_evidence' });
    expect(w.sent).not.toHaveBeenCalled();
  });

  it('lets an incident Dot run an approval whose evidence is bound and current', async () => {
    const w = world({ incident: true });
    const id = w.workspace.connections.createApproval({
      threadId: 'thread',
      dotId: w.dot.id,
      connectionId: w.connection.id,
      tool: 'send_mail',
      arguments: { to: 'a@example.com' },
      dependencyVector: [
        {
          sourceKey: 'checkout.health' as never,
          sourceRevision: 3,
          receiptId: '5d6c7e0e-6f6a-4a55-9a64-0d1d4f5b7a10' as never,
        },
      ],
    });
    const response = await w.post('call-1', id);
    expect(response.status).toBe(200);
    expect(w.sent).toHaveBeenCalledTimes(1);
    // The owner-approved path is the one thing a policy-refused agent call is
    // allowed to turn into: the direct agent call stays refused.
    const exposed = w.service.resolve(w.dot.id, 'mail__send_mail');
    const direct = await w.service.call(exposed, { to: 'b@example.com' });
    expect(direct).toMatchObject({ isError: true });
    expect(direct.text).toContain('Refused by NemoDots policy');
    expect(w.sent).toHaveBeenCalledTimes(1);
  });

  it('passes an empty bound vector (nothing to go stale)', async () => {
    const w = world({ incident: true });
    const id = w.workspace.connections.createApproval({
      threadId: 'thread',
      dotId: w.dot.id,
      connectionId: w.connection.id,
      tool: 'send_mail',
      arguments: { to: 'a@example.com' },
      dependencyVector: [],
    });
    expect(w.workspace.connections.approval(id)!.dependencyVector).toEqual([]);
    expect((await w.post('call-1', id)).status).toBe(200);
  });
});

describe('createApprovalRevalidator', () => {
  const vector = [
    {
      sourceKey: 'checkout.health',
      sourceRevision: 1,
      receiptId: '5d6c7e0e-6f6a-4a55-9a64-0d1d4f5b7a10',
    },
    {
      sourceKey: 'redis.stats',
      sourceRevision: 4,
      receiptId: '5d6c7e0e-6f6a-4a55-9a64-0d1d4f5b7a11',
    },
  ] as never;
  const base = {
    approvalId: 'a',
    threadId: 't',
    dotId: 'd',
    connectionId: 'c',
    tool: 'x',
  };

  it('checks every distinct receipt id once', async () => {
    const seen: string[][] = [];
    const revalidate = createApprovalRevalidator({
      isIncidentDot: () => false,
      checkCurrent: async (ids) => {
        seen.push([...ids]);
        return { ok: true };
      },
    });
    await revalidate({ ...base, vector: [...vector, ...vector] });
    expect(seen).toEqual([
      [
        '5d6c7e0e-6f6a-4a55-9a64-0d1d4f5b7a10',
        '5d6c7e0e-6f6a-4a55-9a64-0d1d4f5b7a11',
      ],
    ]);
  });

  it('reports the offending receipt', async () => {
    const revalidate = createApprovalRevalidator({
      isIncidentDot: () => false,
      checkCurrent: async () => ({
        ok: false,
        receiptId: 'r-1',
        detail: 'superseded',
      }),
    });
    expect(await revalidate({ ...base, vector })).toMatchObject({
      ok: false,
      code: 'stale_evidence',
      receiptId: 'r-1',
    });
  });
});
