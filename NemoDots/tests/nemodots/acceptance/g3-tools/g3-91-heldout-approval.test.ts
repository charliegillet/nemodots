// Gate 3 HELD-OUT cases for MCP approvals and the approved callback (TOOL_COVERAGE M9, M10;
// TEST_PROMPT TP3.6), added 2026-10-18 after the independence disclosure (./README.md). The gated
// tool, its server, its arguments, the thread and tool-call ids are random per run. Expectations
// restate TOOL_COVERAGE M9/M10: the callback runs the STORED request once, in its own thread,
// and refuses a stored payload that no longer matches its hash (409 payload_mismatch).
import { randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { lazyWorld, runDotTurn, type World } from './g3-support.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

const lazy = lazyWorld({ nemodots: true }, (world) => {
  world.store.updateSettings({ appsAllowed: true });
});
let w: World;
beforeEach(async () => {
  w = await lazy.get();
}, 600_000);
afterAll(async () => {
  await lazy.close();
}, 120_000);

/** A random server with one gated (approval-required) tool; every handler call is recorded. */
async function gatedServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } =
    await import('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = await import('zod');
  const name = `${['send', 'post', 'notify', 'page'][randomInt(4)]}_${hex(3)}`;
  const runs: unknown[] = [];
  const transport = () => {
    const server = new McpServer({ name: `srv-${hex(3)}`, version: '1.0.0' });
    server.registerTool(
      name,
      {
        description: `Performs ${name}.`,
        inputSchema: { to: z.string(), body: z.string() },
      },
      async (args: { to: string; body: string }) => {
        runs.push(args);
        return { content: [{ type: 'text', text: `done ${hex(2)}` }] };
      },
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return client;
  };
  const stored = [
    {
      name,
      title: name,
      description: `Performs ${name}.`,
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, body: { type: 'string' } },
      },
      readOnly: false,
      enabled: true,
      requiresApproval: true,
    },
  ];
  const args = { to: `${hex(3)}@example.com`, body: `body ${hex(6)}` };
  return { name, runs, transport, stored, args };
}

/** Drives a real Dot turn up to request_connection_action; returns the stored approval id. */
async function requestApproval(
  dotId: string,
  server: Awaited<ReturnType<typeof gatedServer>>,
) {
  const connection = w.workspace.connections.create(
    dotId,
    { name: `c${hex(4)}`, url: `https://${hex(5)}.acc3.invalid/mcp` },
    server.stored,
  );
  const exposed = new w.up.ConnectionService(w.workspace.connections)
    .tools(dotId)
    .find(
      (t: { connection: { id: string } }) => t.connection.id === connection.id,
    )?.name as string | undefined;
  const gatedId = `g${hex(3)}`;
  const actionId = `a${hex(3)}`;
  const turn = await runDotTurn(
    w,
    dotId,
    [
      {
        toolCalls: [
          {
            id: gatedId,
            name: exposed ?? server.name,
            arguments: server.args,
          },
        ],
      },
      (req: { toolResults: { id: string; content: string }[] }) => {
        let approvalId = 'none';
        try {
          approvalId =
            JSON.parse(
              req.toolResults.find((r) => r.id === gatedId)?.content ?? '{}',
            ).approvalId ?? 'none';
        } catch {
          /* refused */
        }
        return {
          toolCalls: [
            {
              id: actionId,
              name: 'request_connection_action',
              arguments: { approvalId, summary: `approve ${hex(2)}` },
            },
          ],
        };
      },
    ],
    { clientTools: ['approval'] },
  );
  let approvalId: string | null = null;
  try {
    const parsed = JSON.parse(turn.resultOf(gatedId) ?? '{}') as {
      status?: string;
      approvalId?: string;
    };
    if (parsed.status === 'approval_required' && parsed.approvalId)
      approvalId = parsed.approvalId;
  } catch {
    /* not a tool result */
  }
  return { approvalId, threadId: turn.threadId, actionId, connection };
}

function routesFor(server: Awaited<ReturnType<typeof gatedServer>>) {
  const service = new w.up.ConnectionService(
    w.workspace.connections,
    server.transport,
  );
  return w.up.connectionRoutes(w.workspace, service) as {
    request: (p: string, i?: RequestInit) => Response | Promise<Response>;
  };
}
const callback = (
  routes: ReturnType<typeof routesFor>,
  threadId: string,
  body: unknown,
) =>
  Promise.resolve(
    routes.request(`/conversations/${threadId}/connection-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('[HELD-OUT] approvals and the callback with run-time random inputs', () => {
  it('[TP3.6][M9][M10] held-out: the approval binds the random tool and arguments, executes nothing, and the callback runs the STORED request exactly once; body-supplied overrides are rejected', async () => {
    const server = await gatedServer();
    const routes = routesFor(server);
    const r = await requestApproval(w.normal.id, server);
    expect(r.approvalId, 'an ordinary Dot gets an approval').toBeTruthy();
    const stored = w.workspace.connections.approval(r.approvalId!);
    expect(stored.tool).toBe(server.name);
    expect(stored.arguments).toEqual(server.args);
    expect(server.runs).toHaveLength(0);
    for (const extra of [
      { arguments: { to: `${hex(3)}@example.net`, body: hex(4) } },
      { tool: `x_${hex(3)}` },
      { connectionId: hex(8) },
      { dotId: w.incident.id },
    ]) {
      const rejected = await callback(routes, r.threadId, {
        approvalId: r.approvalId,
        toolCallId: r.actionId,
        ...extra,
      });
      expect(rejected.status, Object.keys(extra)[0]).toBe(400);
    }
    expect(server.runs).toHaveLength(0);
    const ok = await callback(routes, r.threadId, {
      approvalId: r.approvalId,
      toolCallId: r.actionId,
    });
    expect(ok.status).toBe(200);
    expect(server.runs).toEqual([server.args]);
  });

  it('[TP3.6][M10] held-out: a replay of the random tool call id returns the saved result with no second effect; another random tool call id is refused (single claim)', async () => {
    const server = await gatedServer();
    const routes = routesFor(server);
    const r = await requestApproval(w.normal.id, server);
    expect(r.approvalId).toBeTruthy();
    const first = await callback(routes, r.threadId, {
      approvalId: r.approvalId,
      toolCallId: r.actionId,
    });
    expect(first.status).toBe(200);
    const replay = await callback(routes, r.threadId, {
      approvalId: r.approvalId,
      toolCallId: r.actionId,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.clone().json());
    const other = await callback(routes, r.threadId, {
      approvalId: r.approvalId,
      toolCallId: `a${hex(4)}`,
    });
    expect(other.status).toBe(409);
    expect(server.runs).toHaveLength(1);
  });

  it('[TP3.2][M10] held-out: the approval is usable only from its own thread: a random thread bound to another Dot and a random unbound thread id are refused', async () => {
    const server = await gatedServer();
    const routes = routesFor(server);
    const r = await requestApproval(w.normal.id, server);
    expect(r.approvalId).toBeTruthy();
    const foreign = `t-${hex(5)}`;
    w.workspace.bindThread(foreign, w.incident.id, `foreign ${hex(2)}`);
    for (const threadId of [foreign, `t-${hex(5)}`]) {
      const res = await callback(routes, threadId, {
        approvalId: r.approvalId,
        toolCallId: r.actionId,
      });
      expect(res.status, threadId).toBe(400);
    }
    expect(server.runs).toHaveLength(0);
  });

  it('[TP3.6][M10] held-out: a stored payload changed after approval (random new arguments written to the approval row) is refused with 409 payload_mismatch before any effect', async () => {
    const server = await gatedServer();
    const routes = routesFor(server);
    const r = await requestApproval(w.normal.id, server);
    expect(r.approvalId).toBeTruthy();
    const db = new DatabaseSync(w.sqlitePath);
    try {
      db.prepare('UPDATE mcp_approvals SET arguments = ? WHERE id = ?').run(
        JSON.stringify({ to: `${hex(3)}@example.org`, body: hex(5) }),
        r.approvalId!,
      );
    } finally {
      db.close();
    }
    const res = await callback(routes, r.threadId, {
      approvalId: r.approvalId,
      toolCallId: r.actionId,
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('payload_mismatch');
    expect(server.runs).toHaveLength(0);
  });

  it('[TP3.3][TP3.6][M9][M10] held-out: an incident Dot never obtains a usable approval for a random gated tool, and the tool never runs', async () => {
    const server = await gatedServer();
    const routes = routesFor(server);
    const r = await requestApproval(w.incident.id, server);
    if (r.approvalId) {
      const res = await callback(routes, r.threadId, {
        approvalId: r.approvalId,
        toolCallId: r.actionId,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(server.runs).toHaveLength(0);
  });
});
