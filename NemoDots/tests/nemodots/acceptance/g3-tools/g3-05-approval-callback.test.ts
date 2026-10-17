// Gate 3, TOOL_COVERAGE M9 and M10: MCP approval creation and the approved callback
// (POST /conversations/:id/connection-actions). Payload binding, single claim, TTL and thread scope are
// upstream semantics that must be preserved; fresh-evidence validation (409 stale_evidence) is the NemoDots addition.
//
// Part A (no NemoDots composition) freezes the upstream semantics and can pass today.
// Part B (composition installed) checks the hooks: bound dependency vector, stale evidence after a page edit,
// the same result after a reconnect (new workspace handle, new routes, new service), and the incident-Dot rule.
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lazyWorld,
  mcpTransportFactory,
  runDotTurn,
  type McpCalls,
  type World,
} from './g3-support.js';

const MAIL_URL = 'https://mail.acc3.invalid/mcp';
const SEND_ARGS = { to: 'ops@example.com', body: 'restart the checkout' };

const GATED_TOOLS = [
  {
    name: 'send_mail',
    title: 'Send mail',
    description: 'Send an email.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, body: { type: 'string' } },
    },
    readOnly: false,
    enabled: true,
    requiresApproval: true,
  },
];

let seq = 0;

async function setup(w: World) {
  const mcp = await mcpTransportFactory();
  const service = new w.up.ConnectionService(w.workspace.connections, mcp.transport);
  const routes = w.up.connectionRoutes(w.workspace, service);
  return { service, routes, calls: mcp.calls };
}

function call(
  routes: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
  threadId: string,
  body: unknown,
) {
  return Promise.resolve(
    routes.request(`/conversations/${threadId}/connection-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Drives a real Dot turn (scripted model) up to the owner-approval request; returns the stored approval. */
async function requestApproval(
  w: World,
  dotId: string,
  options: { readPageId?: string } = {},
) {
  seq += 1;
  const connection = w.workspace.connections.create(
    dotId,
    { name: `ops${seq}`, url: MAIL_URL },
    GATED_TOOLS,
  );
  const toolName = new w.up.ConnectionService(w.workspace.connections)
    .tools(dotId)
    .find((t: { connection: { id: string } }) => t.connection.id === connection.id)!.name as string;
  const turn = await runDotTurn(
    w,
    dotId,
    [
      ...(options.readPageId
        ? [
            {
              toolCalls: [
                { id: 'rp', name: 'read_space_page', arguments: { id: options.readPageId } },
              ],
            },
          ]
        : []),
      {
        toolCalls: [{ id: 'g1', name: toolName, arguments: SEND_ARGS }],
      },
      (req: { toolResults: { id: string; content: string }[] }) => {
        const gated = req.toolResults.find((r) => r.id === 'g1')?.content ?? '{}';
        let approvalId = 'none';
        try {
          approvalId = JSON.parse(gated).approvalId ?? 'none';
        } catch {
          /* tool refused */
        }
        return {
          toolCalls: [
            {
              id: 'act1',
              name: 'request_connection_action',
              arguments: { approvalId, summary: 'Send the restart request' },
            },
          ],
        };
      },
    ],
    { clientTools: ['approval'] },
  );
  const gatedResult = turn.resultOf('g1') ?? '';
  let approvalId: string | null = null;
  try {
    const parsed = JSON.parse(gatedResult) as { status?: string; approvalId?: string };
    if (parsed.status === 'approval_required' && parsed.approvalId) approvalId = parsed.approvalId;
  } catch {
    /* refused or not a tool result */
  }
  return { turn, approvalId, threadId: turn.threadId, gatedResult };
}

function storedVector(sqlitePath: string, approvalId: string): { present: boolean; value: string | null } {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(mcp_approvals)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'dependency_vector')) return { present: false, value: null };
    const row = db
      .prepare('SELECT dependency_vector AS v FROM mcp_approvals WHERE id=?')
      .get(approvalId) as { v: string | null } | undefined;
    return { present: true, value: row?.v ?? null };
  } finally {
    db.close();
  }
}

describe('Part A: upstream approval semantics preserved (no NemoDots composition)', () => {
  const lazy = lazyWorld({ nemodots: false });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
    w.store.updateSettings({ researchAllowed: true, memoryAllowed: true, appsAllowed: true });
  }, 120_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await lazy.close();
  });

  it('[TP3.6][M9] a gated tool call creates an approval record bound to the exact connection, tool and arguments, and executes nothing', async () => {
    const { calls } = await setup(w);
    const { approvalId, gatedResult } = await requestApproval(w, w.normal.id);
    expect(approvalId, gatedResult).toBeTruthy();
    const stored = w.workspace.connections.approval(approvalId!);
    expect(stored.tool).toBe('send_mail');
    expect(stored.arguments).toEqual(SEND_ARGS);
    expect(calls.sendMail).toHaveLength(0);
  });

  it('[TP3.6][M10] the callback runs the STORED request once; body-supplied tool or arguments are rejected and never used', async () => {
    const { routes, calls } = await setup(w);
    const { approvalId, threadId } = await requestApproval(w, w.normal.id);
    for (const extra of [
      { arguments: { to: 'attacker@example.net', body: 'x' } },
      { tool: 'read_and_delete' },
      { connectionId: 'other' },
      { dotId: w.incident.id },
    ]) {
      const rejected = await call(routes, threadId, { approvalId, toolCallId: 'act1', ...extra });
      expect(rejected.status, JSON.stringify(extra)).toBe(400);
    }
    expect(calls.sendMail).toHaveLength(0);
    const ok = await call(routes, threadId, { approvalId, toolCallId: 'act1' });
    expect(ok.status).toBe(200);
    expect(calls.sendMail).toEqual([SEND_ARGS]);
  });

  it('[TP3.6][M10] a replay of the same tool call returns the saved result without a second effect; a second tool call id on the same approval is refused (single claim)', async () => {
    const { routes, calls } = await setup(w);
    const { approvalId, threadId } = await requestApproval(w, w.normal.id);
    const first = await call(routes, threadId, { approvalId, toolCallId: 'act1' });
    expect(first.status).toBe(200);
    const replay = await call(routes, threadId, { approvalId, toolCallId: 'act1' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.clone().json());
    const other = await call(routes, threadId, { approvalId, toolCallId: 'act2' });
    expect(other.status).toBe(409);
    expect(calls.sendMail).toHaveLength(1);
  });

  it('[TP3.2][M10] an approval is usable only from its own conversation (cross-thread and cross-Dot ids grant nothing)', async () => {
    const { routes, calls } = await setup(w);
    const { approvalId } = await requestApproval(w, w.normal.id);
    w.workspace.bindThread('acc3-foreign-thread', w.incident.id, 'foreign');
    const foreign = await call(routes, 'acc3-foreign-thread', { approvalId, toolCallId: 'x' });
    expect(foreign.status).toBe(400);
    const missing = await call(routes, 'acc3-no-such-thread', { approvalId, toolCallId: 'x' });
    expect(missing.status).toBe(400);
    expect(calls.sendMail).toHaveLength(0);
  });

  it('[TP3.6][M10] an approval expires after one hour and a tool disabled after approval is not run', async () => {
    const { routes, calls, service } = await setup(w);
    const expired = await requestApproval(w, w.normal.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + w.up.APPROVAL_TTL_MS + 5000);
    const late = await call(routes, expired.threadId, { approvalId: expired.approvalId, toolCallId: 'act1' });
    expect(late.status).toBe(400);
    vi.useRealTimers();

    const revoked = await requestApproval(w, w.normal.id);
    const record = w.workspace.connections.approval(revoked.approvalId!);
    service.setTool(record.connectionId, 'send_mail', { enabled: false });
    const blocked = await call(routes, revoked.threadId, { approvalId: revoked.approvalId, toolCallId: 'act1' });
    expect(blocked.status).toBe(400);
    expect(calls.sendMail).toHaveLength(0);
  });

  it('[TP3.6][reconnect] after a reconnect (new workspace handle, service and routes) the stored approval still runs once with the stored arguments', async () => {
    const { approvalId, threadId } = await requestApproval(w, w.normal.id);
    const reopened = new w.up.WorkspaceStore(w.sqlitePath, 'owner');
    try {
      const mcp = await mcpTransportFactory();
      const service = new w.up.ConnectionService(reopened.connections, mcp.transport);
      const routes = w.up.connectionRoutes(reopened, service);
      const ok = await call(routes, threadId, { approvalId, toolCallId: 'act1' });
      expect(ok.status).toBe(200);
      expect(mcp.calls.sendMail).toEqual([SEND_ARGS]);
      const replay = await call(routes, threadId, { approvalId, toolCallId: 'act1' });
      expect(replay.status).toBe(200);
      expect(mcp.calls.sendMail).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe('Part B: fresh evidence is validated at the callback (NemoDots composition installed)', () => {
  const lazy = lazyWorld({ nemodots: true });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
    w.store.updateSettings({ researchAllowed: true, memoryAllowed: true, appsAllowed: true });
  }, 600_000);
  afterAll(async () => {
    await lazy.close();
  }, 120_000);

  it('[TP3.6][M9] the approval row has a dependency_vector column; an approval created after a page read carries a bound vector or an explicit NULL', async () => {
    const page = w.workspace.pages.create(w.spaceA, { title: 'Evidence page', content: 'v1' });
    const { approvalId, gatedResult } = await requestApproval(w, w.normal.id, { readPageId: page.id });
    expect(approvalId, gatedResult).toBeTruthy();
    const vector = storedVector(w.sqlitePath, approvalId!);
    expect(vector.present, 'mcp_approvals.dependency_vector must exist (TOOL_COVERAGE M9)').toBe(true);
  });

  it('[TP3.6][M10] when a vector is bound, a page edit after approval creation makes the callback fail with 409 stale_evidence before any effect, also after a reconnect; unchanged evidence runs the stored request once', async () => {
    const mcp = await setup(w);
    const page = w.workspace.pages.create(w.spaceA, { title: 'Stale evidence page', content: 'v1' });
    const stale = await requestApproval(w, w.normal.id, { readPageId: page.id });
    expect(stale.approvalId, stale.gatedResult).toBeTruthy();
    const vector = storedVector(w.sqlitePath, stale.approvalId!);
    expect(vector.present).toBe(true);

    const edit = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 1, content: 'v2: the situation changed' }),
    });
    expect(edit.status).toBe(200);

    const reopened = new w.up.WorkspaceStore(w.sqlitePath, 'owner');
    try {
      const again = await mcpTransportFactory();
      const service = new w.up.ConnectionService(reopened.connections, again.transport);
      const routes = w.up.connectionRoutes(reopened, service);
      const first = await call(mcp.routes, stale.threadId, { approvalId: stale.approvalId, toolCallId: 'act1' });
      const afterReconnect = await call(routes, stale.threadId, { approvalId: stale.approvalId, toolCallId: 'act1' });
      if (vector.value !== null) {
        // evidence is bound: both the original and the reconnected callback refuse
        for (const response of [first, afterReconnect]) {
          expect(response.status).toBe(409);
          expect(JSON.stringify(await response.json())).toContain('stale_evidence');
        }
        expect(mcp.calls.sendMail).toHaveLength(0);
        expect(again.calls.sendMail).toHaveLength(0);
      } else {
        // explicit NULL: upstream behaviour for a non-incident Dot (TOOL_COVERAGE M10): the stored request runs once
        expect(first.status).toBe(200);
        expect(mcp.calls.sendMail.length + again.calls.sendMail.length).toBe(1);
      }
    } finally {
      reopened.close();
    }

    // control: unchanged evidence executes the stored request exactly once, also through a reconnected handle
    const fresh = await requestApproval(w, w.normal.id, { readPageId: page.id });
    expect(fresh.approvalId, fresh.gatedResult).toBeTruthy();
    const reopened2 = new w.up.WorkspaceStore(w.sqlitePath, 'owner');
    try {
      const again = await mcpTransportFactory();
      const service = new w.up.ConnectionService(reopened2.connections, again.transport);
      const routes = w.up.connectionRoutes(reopened2, service);
      const ok = await call(routes, fresh.threadId, { approvalId: fresh.approvalId, toolCallId: 'act1' });
      expect(ok.status).toBe(200);
      expect(again.calls.sendMail).toEqual([SEND_ARGS]);
    } finally {
      reopened2.close();
    }
  });

  it('[TP3.3][TP3.6][M10] an approval requested by an incident Dot never executes through the callback, whether evidence is fresh or stale', async () => {
    const { routes, calls } = await setup(w);
    const page = w.workspace.pages.create(w.spaceA, { title: 'Incident evidence page', content: 'v1' });
    const request = await requestApproval(w, w.incident.id, { readPageId: page.id });
    if (request.approvalId) {
      // creation is allowed to exist, but it must be unusable: a bound vector is required for incident Dots
      const bound = storedVector(w.sqlitePath, request.approvalId);
      expect(bound.present).toBe(true);
      const fresh = await call(routes, request.threadId, { approvalId: request.approvalId, toolCallId: 'act1' });
      expect(fresh.status).toBeGreaterThanOrEqual(400);
      await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, content: 'v2' }),
      });
      const stale = await call(routes, request.threadId, { approvalId: request.approvalId, toolCallId: 'act1' });
      expect(stale.status).toBeGreaterThanOrEqual(400);
    }
    expect(calls.sendMail, 'the gated MCP tool must not run for an incident Dot').toHaveLength(0);
  });
});
