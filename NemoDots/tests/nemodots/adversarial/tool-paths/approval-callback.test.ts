// W5.3: the MCP approval callback (TOOL_COVERAGE M8, M9, M10) attacked through
// the real connectionRoutes over the real ConnectionService and an in-memory
// MCP server. The tool the server exposes counts its executions, so "did it
// run" is observed at the effect, not inferred from a status code.
//
// The Dot is a real WorkspaceStore Dot; approvals are inserted with the same
// store method the connection tool executor uses. Evidence checks are a
// labelled double (a set of superseded receipt ids), exactly as bootstrap will
// back it with SupportValidator.assertCurrent.
//
// Tests titled FINDING encode the documented behaviour and fail while the
// implementation deviates (docs/nemodots/review/TOOL_PATH_REVIEW.md).
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectionRoutes } from '../../../../src/server/connection-routes.js';
import {
  ConnectionService,
  type McpTransportFactory,
} from '../../../../src/server/connections.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import { APPROVAL_TTL_MS } from '../../../../src/shared/connection-types.js';
import {
  createApprovalRevalidator,
  createToolPolicy,
  setActivePolicy,
  type EvidenceCheck,
} from '../../../../src/server/nemodots/interception/index.js';

const closers: Array<() => void> = [];
afterEach(() => {
  setActivePolicy(null);
  closers.splice(0).forEach((close) => close());
});

const RECEIPT_A = '5a2f0f6e-0d4e-4d57-9d3a-5f0a9a1c0a01';
const RECEIPT_B = '5a2f0f6e-0d4e-4d57-9d3a-5f0a9a1c0a02';
const vectorOf = (...ids: string[]) =>
  ids.map((receiptId, i) => ({
    sourceKey: `opendots.page/p${i}`,
    sourceRevision: 1,
    receiptId,
  }));

function world(options: { incident?: boolean; revalidateDelayMs?: number } = {}) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Approvals');
  workspace.bindThread('other-thread', dot.id, 'Elsewhere');
  const executions: Array<Record<string, unknown>> = [];
  const transport: McpTransportFactory = () => {
    const server = new McpServer({ name: 'mail', version: '1.0.0' });
    server.registerTool(
      'send_mail',
      { description: 'Send.', inputSchema: { to: z.string() } },
      async (args) => {
        executions.push({ tool: 'send_mail', ...args });
        return { content: [{ type: 'text', text: `sent ${args.to}` }] };
      },
    );
    server.registerTool(
      'delete_all',
      { description: 'Delete.', inputSchema: { confirm: z.string() } },
      async (args) => {
        executions.push({ tool: 'delete_all', ...args });
        return { content: [{ type: 'text', text: 'deleted' }] };
      },
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return client;
  };
  const service = new ConnectionService(workspace.connections, transport);
  const tool = (name: string, enabled = true) => ({
    name,
    title: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    readOnly: false,
    enabled,
    requiresApproval: true,
  });
  const connection = workspace.connections.create(
    dot.id,
    { name: 'Mail', url: 'https://mail.example.invalid/mcp' },
    [tool('send_mail'), tool('delete_all', false)],
  );
  const superseded = new Set<string>();
  const checks: string[][] = [];
  const checkCurrent = async (
    ids: readonly string[],
  ): Promise<EvidenceCheck> => {
    checks.push([...ids]);
    if (options.revalidateDelayMs)
      await new Promise((r) => setTimeout(r, options.revalidateDelayMs));
    const bad = ids.find((id) => superseded.has(id));
    return bad
      ? { ok: false, receiptId: bad, detail: 'superseded' }
      : { ok: true };
  };
  const incident = new Set<string>(options.incident ? [dot.id] : []);
  setActivePolicy(
    createToolPolicy({
      incidentDotIds: () => incident,
      revalidateApproval: createApprovalRevalidator({
        isIncidentDot: (id) => incident.has(id),
        checkCurrent,
      }),
    }),
  );
  const routes = connectionRoutes(workspace, service);
  const approve = (
    vector: ReturnType<typeof vectorOf> | null,
    args: Record<string, unknown> = { to: 'ops@example.com' },
    toolName = 'send_mail',
    threadId = 'thread',
  ) =>
    workspace.connections.createApproval({
      threadId,
      dotId: dot.id,
      connectionId: connection.id,
      tool: toolName,
      arguments: args,
      dependencyVector: vector,
    });
  const post = (
    approvalId: string,
    toolCallId: string,
    threadId = 'thread',
    extra: Record<string, unknown> = {},
  ) =>
    routes.request(`/conversations/${threadId}/connection-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, toolCallId, ...extra }),
    });
  return {
    workspace,
    dot,
    connection,
    executions,
    superseded,
    checks,
    incident,
    approve,
    post,
    service,
  };
}

describe('approval callback: stale and unbound evidence', () => {
  it('an incident Dot with a superseded receipt in the bound vector: 409 stale_evidence, nothing runs, nothing is claimed', async () => {
    const w = world({ incident: true });
    const id = w.approve(vectorOf(RECEIPT_A, RECEIPT_B));
    w.superseded.add(RECEIPT_B);
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'stale_evidence' });
    expect(w.executions).toEqual([]);
    expect(w.workspace.connections.actionForApproval(id)).toBeUndefined();
    expect(w.workspace.connections.action('thread', 'tc-1')).toBeUndefined();
    // The failed attempt did not burn the approval: once the evidence is
    // current again the same approval can still be executed once.
    w.superseded.clear();
    const retry = await w.post(id, 'tc-2');
    expect(retry.status).toBe(200);
    expect(w.executions).toHaveLength(1);
  });

  it('an incident Dot with a NULL vector: 409 unbound_evidence, nothing runs', async () => {
    const w = world({ incident: true });
    const id = w.approve(null);
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'unbound_evidence' });
    expect(w.executions).toEqual([]);
    expect(w.checks).toEqual([]);
  });

  it('the evidence check being unavailable answers 503 and runs nothing', async () => {
    const w = world({ incident: true });
    setActivePolicy(
      createToolPolicy({
        incidentDotIds: [w.dot.id],
        revalidateApproval: async () => {
          throw new Error('ledger unreachable');
        },
      }),
    );
    const id = w.approve(vectorOf(RECEIPT_A));
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(503);
    expect(w.executions).toEqual([]);
    expect(w.workspace.connections.actionForApproval(id)).toBeUndefined();
  });

  it('a Dot that was ordinary when the approval was created and is incident when it is approved is checked at approval time', async () => {
    const w = world();
    const id = w.approve(null);
    w.incident.add(w.dot.id);
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(409);
    expect(w.executions).toEqual([]);
  });

  it('OBSERVATION O-03: an incident Dot whose approval has an EMPTY (not NULL) vector runs on no evidence at all', async () => {
    // Documents the boundary of I6: NULL is refused, [] is "bound to nothing"
    // and passes. The owner approved a request the Dot made while holding no
    // receipt; the claim and payload binding still apply. Recorded as a
    // finding, asserted as the current behaviour so a change is noticed.
    const w = world({ incident: true });
    const id = w.approve([]);
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(200);
    expect(w.executions).toHaveLength(1);
  });

  it('FINDING F-02: an ordinary Dot whose bound vector holds a superseded receipt is refused with stale_evidence (M10 revalidates every bound vector)', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A));
    w.superseded.add(RECEIPT_A);
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(409);
    expect(w.executions).toEqual([]);
  });
});

describe('approval callback: the stored request is the only request', () => {
  it('connection, tool and arguments in the POST body are ignored or rejected; the stored ones run', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A), { to: 'ops@example.com' });
    const response = await w.post(id, 'tc-1', 'thread', {
      tool: 'delete_all',
      connectionId: 'other',
      arguments: { confirm: 'yes' },
      to: 'attacker@example.com',
    });
    expect([200, 400]).toContain(response.status);
    expect(w.executions.filter((e) => e.tool === 'delete_all')).toEqual([]);
    expect(w.executions.filter((e) => e.to === 'attacker@example.com')).toEqual(
      [],
    );
    if (response.status === 200)
      expect(w.executions).toEqual([
        { tool: 'send_mail', to: 'ops@example.com' },
      ]);
  });

  it('an approval is usable only from its own conversation', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A), undefined, 'send_mail', 'thread');
    const response = await w.post(id, 'tc-1', 'other-thread');
    expect(response.status).toBe(400);
    expect(w.executions).toEqual([]);
  });

  it('an expired approval does not run', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A));
    (
      w.workspace.connections as unknown as {
        db: { prepare(s: string): { run(...a: unknown[]): void } };
      }
    ).db
      .prepare('UPDATE mcp_approvals SET createdAt = ? WHERE id = ?')
      .run(Date.now() - APPROVAL_TTL_MS - 1000, id);
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(400);
    expect(w.executions).toEqual([]);
  });

  it('a tool the owner has since disabled does not run', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A), { confirm: 'yes' }, 'delete_all');
    const response = await w.post(id, 'tc-1');
    expect(response.status).toBe(400);
    expect(w.executions).toEqual([]);
  });

  it('a made-up or foreign approval id runs nothing', async () => {
    const w = world();
    for (const approvalId of ['nope', '0', 'x'.repeat(64), "' OR 1=1 --"]) {
      const response = await w.post(approvalId, 'tc-1');
      expect(response.status).toBe(400);
    }
    expect(w.executions).toEqual([]);
  });

  it('a finished approval cannot be replayed under a fresh tool call id', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A));
    expect((await w.post(id, 'tc-1')).status).toBe(200);
    expect((await w.post(id, 'tc-2')).status).toBe(409);
    expect((await w.post(id, 'tc-3')).status).toBe(409);
    expect(w.executions).toHaveLength(1);
    // The same tool call id is idempotent and returns the stored result.
    const again = await w.post(id, 'tc-1');
    expect(again.status).toBe(200);
    expect(w.executions).toHaveLength(1);
  });

  it('FINDING F-01: two concurrent callbacks for one approval with different tool call ids execute the stored request once', async () => {
    // With an asynchronous evidence check in front of claimAction the
    // "already ran" test and the claim are separated by an await, and the
    // claim is keyed on (thread, toolCallId) only.
    const w = world({ revalidateDelayMs: 25 });
    const id = w.approve(vectorOf(RECEIPT_A));
    const responses = await Promise.all(
      ['tc-1', 'tc-2', 'tc-3', 'tc-4'].map((toolCallId) =>
        w.post(id, toolCallId),
      ),
    );
    expect(w.executions.length, `statuses ${responses.map((r) => r.status)}`).toBe(
      1,
    );
  });

  it('FINDING F-01 (zero delay): the same race with the evidence check resolving on the next microtask', async () => {
    const w = world();
    const id = w.approve(vectorOf(RECEIPT_A));
    await Promise.all(
      ['tc-1', 'tc-2'].map((toolCallId) => w.post(id, toolCallId)),
    );
    expect(w.executions.length).toBe(1);
  });
});

describe('direct MCP call by an incident Dot (R10, M8)', () => {
  it('is refused on the shared service and on a fresh per-turn instance, before any transport is opened', async () => {
    const w = world({ incident: true });
    let opened = 0;
    const perTurn = new ConnectionService(w.workspace.connections, () => {
      opened += 1;
      throw new Error('transport must not be opened');
    });
    for (const instance of [w.service, perTurn]) {
      const exposed = instance.resolve(w.dot.id, 'mail__send_mail');
      const result = await instance.call(exposed, { to: 'x@example.com' });
      expect(result).toMatchObject({ isError: true });
      expect(result.text).toContain('Refused by NemoDots policy');
    }
    expect(opened).toBe(0);
    expect(w.executions).toEqual([]);
  });

  it('a model-supplied via/dotId cannot be smuggled through the arguments', async () => {
    const w = world({ incident: true });
    const exposed = w.service.resolve(w.dot.id, 'mail__send_mail');
    const result = await w.service.call(exposed, {
      to: 'x@example.com',
      via: 'owner_approval',
      dotId: 'someone-else',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Refused by NemoDots policy');
    expect(w.executions).toEqual([]);
  });
});
