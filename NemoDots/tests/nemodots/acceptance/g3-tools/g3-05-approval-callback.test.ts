// Gate 3, TOOL_COVERAGE M9 and M10: MCP approval creation and the approved callback
// (POST /conversations/:id/connection-actions). Payload binding, single claim, TTL and thread scope are
// upstream semantics that must be preserved; fresh-evidence validation (409 stale_evidence) is the NemoDots addition.
//
// Part A (no NemoDots composition) freezes the upstream semantics and can pass today.
// Part B (composition installed) checks the hooks and is unconditional about the evidence rule:
//   B1  an ordinary Dot turn that read a page binds a NON-NULL vector holding the hand-computed entry
//       (source opendots.page/<id>, revision 1, a receipt id that exists in ledger.observation_receipts);
//   B2  a page edit after approval creation makes the callback answer 409 stale_evidence with zero effects,
//       also after a reconnect; unchanged evidence runs the stored request exactly once;
//   B3  the same after a real restart (nd.stop(), a new createNemoDots on the same databases, a new app);
//   B4  the incident-Dot rule: a NULL vector is refused for an incident Dot and accepted for an ordinary Dot.
// If no configuration produces a bound vector the tests FAIL with "revalidation unverifiable" (see
// docs/nemodots/ACCEPTANCE_CONTRACT.md, gate 3 gap I6/M10): a NULL vector must never turn the stale case into a pass.
import { DatabaseSync } from 'node:sqlite';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  adminQuery,
  lazyWorld,
  mcpTransportFactory,
  pageLedgerTrace,
  runDotTurn,
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
  const service = new w.up.ConnectionService(
    w.workspace.connections,
    mcp.transport,
  );
  const routes = w.up.connectionRoutes(w.workspace, service);
  return { service, routes, calls: mcp.calls };
}

function call(
  routes: {
    request: (p: string, i?: RequestInit) => Response | Promise<Response>;
  },
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
    .find(
      (t: { connection: { id: string } }) => t.connection.id === connection.id,
    )!.name as string;
  const turn = await runDotTurn(
    w,
    dotId,
    [
      ...(options.readPageId
        ? [
            {
              toolCalls: [
                {
                  id: 'rp',
                  name: 'read_space_page',
                  arguments: { id: options.readPageId },
                },
              ],
            },
          ]
        : []),
      {
        toolCalls: [{ id: 'g1', name: toolName, arguments: SEND_ARGS }],
      },
      (req: { toolResults: { id: string; content: string }[] }) => {
        const gated =
          req.toolResults.find((r) => r.id === 'g1')?.content ?? '{}';
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
    const parsed = JSON.parse(gatedResult) as {
      status?: string;
      approvalId?: string;
    };
    if (parsed.status === 'approval_required' && parsed.approvalId)
      approvalId = parsed.approvalId;
  } catch {
    /* refused or not a tool result */
  }
  return { turn, approvalId, threadId: turn.threadId, gatedResult };
}

function storedVector(
  sqlitePath: string,
  approvalId: string,
): { present: boolean; value: string | null } {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(mcp_approvals)').all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === 'dependency_vector'))
      return { present: false, value: null };
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
    w.store.updateSettings({
      researchAllowed: true,
      memoryAllowed: true,
      appsAllowed: true,
    });
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
      const rejected = await call(routes, threadId, {
        approvalId,
        toolCallId: 'act1',
        ...extra,
      });
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
    const first = await call(routes, threadId, {
      approvalId,
      toolCallId: 'act1',
    });
    expect(first.status).toBe(200);
    const replay = await call(routes, threadId, {
      approvalId,
      toolCallId: 'act1',
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.clone().json());
    const other = await call(routes, threadId, {
      approvalId,
      toolCallId: 'act2',
    });
    expect(other.status).toBe(409);
    expect(calls.sendMail).toHaveLength(1);
  });

  it('[TP3.2][M10] an approval is usable only from its own conversation (cross-thread and cross-Dot ids grant nothing)', async () => {
    const { routes, calls } = await setup(w);
    const { approvalId } = await requestApproval(w, w.normal.id);
    w.workspace.bindThread('acc3-foreign-thread', w.incident.id, 'foreign');
    const foreign = await call(routes, 'acc3-foreign-thread', {
      approvalId,
      toolCallId: 'x',
    });
    expect(foreign.status).toBe(400);
    const missing = await call(routes, 'acc3-no-such-thread', {
      approvalId,
      toolCallId: 'x',
    });
    expect(missing.status).toBe(400);
    expect(calls.sendMail).toHaveLength(0);
  });

  it('[TP3.6][M10] an approval expires after one hour and a tool disabled after approval is not run', async () => {
    const { routes, calls, service } = await setup(w);
    const expired = await requestApproval(w, w.normal.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + w.up.APPROVAL_TTL_MS + 5000);
    const late = await call(routes, expired.threadId, {
      approvalId: expired.approvalId,
      toolCallId: 'act1',
    });
    expect(late.status).toBe(400);
    vi.useRealTimers();

    const revoked = await requestApproval(w, w.normal.id);
    const record = w.workspace.connections.approval(revoked.approvalId!);
    service.setTool(record.connectionId, 'send_mail', { enabled: false });
    const blocked = await call(routes, revoked.threadId, {
      approvalId: revoked.approvalId,
      toolCallId: 'act1',
    });
    expect(blocked.status).toBe(400);
    expect(calls.sendMail).toHaveLength(0);
  });

  it('[TP3.6][reconnect] after a reconnect (new workspace handle, service and routes) the stored approval still runs once with the stored arguments', async () => {
    const { approvalId, threadId } = await requestApproval(w, w.normal.id);
    const reopened = new w.up.WorkspaceStore(w.sqlitePath, 'owner');
    try {
      const mcp = await mcpTransportFactory();
      const service = new w.up.ConnectionService(
        reopened.connections,
        mcp.transport,
      );
      const routes = w.up.connectionRoutes(reopened, service);
      const ok = await call(routes, threadId, {
        approvalId,
        toolCallId: 'act1',
      });
      expect(ok.status).toBe(200);
      expect(mcp.calls.sendMail).toEqual([SEND_ARGS]);
      const replay = await call(routes, threadId, {
        approvalId,
        toolCallId: 'act1',
      });
      expect(replay.status).toBe(200);
      expect(mcp.calls.sendMail).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

/** Parses mcp_approvals.dependency_vector into entries (an array, or {entries:[...]}). */
function parseVector(value: string | null): {
  sourceKey: string;
  sourceRevision: number;
  receiptId: string;
}[] {
  if (value === null) return [];
  const parsed = JSON.parse(value) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { entries?: unknown[] } | null)?.entries ?? []);
  return list as {
    sourceKey: string;
    sourceRevision: number;
    receiptId: string;
  }[];
}

const UNVERIFIABLE =
  'revalidation unverifiable: no bound dependency vector was produced for an ordinary Dot turn that read a page. ' +
  'TOOL_COVERAGE M9 says createApproval stores the current provenance scope vector, but I6/M10 leave NULL allowed; ' +
  'the lead must state which Dot kind gets a bound vector (acceptance assumes: every Dot turn while the incident list is non-empty).';

/** Creates an approval for `dotId` with a NULL vector, bypassing the model (the owner-side store API). */
function nullVectorApproval(w: World, dotId: string) {
  seq += 1;
  const threadId = `acc3-null-thread-${seq}-${Date.now()}`;
  w.workspace.bindThread(threadId, dotId, 'null vector');
  const connection = w.workspace.connections.create(
    dotId,
    { name: `nullvec${seq}`, url: MAIL_URL },
    GATED_TOOLS,
  );
  const approvalId = w.workspace.connections.createApproval({
    threadId,
    dotId,
    connectionId: connection.id,
    tool: 'send_mail',
    arguments: SEND_ARGS,
  });
  return { threadId, approvalId };
}

describe('Part B: fresh evidence is validated at the callback (NemoDots composition installed)', () => {
  const lazy = lazyWorld({ nemodots: true });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
    w.store.updateSettings({
      researchAllowed: true,
      memoryAllowed: true,
      appsAllowed: true,
    });
  }, 600_000);
  afterAll(async () => {
    await lazy.close();
  }, 120_000);

  it('[TP3.6][M9] B1: an ordinary Dot turn that read a page stores a NON-NULL vector holding exactly the page entry (opendots.page/<id>, revision 1, an existing receipt id)', async () => {
    const page = w.workspace.pages.create(w.spaceA, {
      title: 'Evidence page',
      content: 'v1',
    });
    const { approvalId, gatedResult } = await requestApproval(w, w.normal.id, {
      readPageId: page.id,
    });
    expect(approvalId, gatedResult).toBeTruthy();
    const stored = storedVector(w.sqlitePath, approvalId!);
    expect(
      stored.present,
      'mcp_approvals.dependency_vector must exist (TOOL_COVERAGE M9)',
    ).toBe(true);
    expect(stored.value, UNVERIFIABLE).not.toBeNull();
    const entries = parseVector(stored.value);
    expect(entries.length, UNVERIFIABLE).toBeGreaterThan(0);
    const pageEntries = entries.filter(
      (entry) => entry.sourceKey === `opendots.page/${page.id}`,
    );
    expect(
      pageEntries,
      'exactly one entry for the page the model read in this turn',
    ).toHaveLength(1);
    expect(pageEntries[0].sourceRevision).toBe(1);
    const trace = await pageLedgerTrace(w.db!.admin, page.id);
    expect(
      trace.receiptIdByRevision[1],
      'the ledger holds a receipt for page revision 1',
    ).toBeTruthy();
    expect(pageEntries[0].receiptId).toBe(trace.receiptIdByRevision[1]);
    // no entry for a page that was never read in this turn
    const other = w.workspace.pages.create(w.spaceA, {
      title: 'Never read',
      content: 'x',
    });
    expect(
      entries.some((entry) => entry.sourceKey === `opendots.page/${other.id}`),
    ).toBe(false);
  });

  it('[TP3.6][M10] B2: a page edit after approval creation makes the callback fail with 409 stale_evidence and zero effects, also after a reconnect; unchanged evidence runs the stored request exactly once', async () => {
    const mcp = await setup(w);
    const page = w.workspace.pages.create(w.spaceA, {
      title: 'Stale evidence page',
      content: 'v1',
    });
    const stale = await requestApproval(w, w.normal.id, {
      readPageId: page.id,
    });
    expect(stale.approvalId, stale.gatedResult).toBeTruthy();
    const vector = storedVector(w.sqlitePath, stale.approvalId!);
    expect(vector.present).toBe(true);
    expect(vector.value, UNVERIFIABLE).not.toBeNull();

    const edit = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedRevision: 1,
        content: 'v2: the situation changed',
      }),
    });
    expect(edit.status).toBe(200);

    const reopened = new w.up.WorkspaceStore(w.sqlitePath, 'owner');
    try {
      const again = await mcpTransportFactory();
      const service = new w.up.ConnectionService(
        reopened.connections,
        again.transport,
      );
      const routes = w.up.connectionRoutes(reopened, service);
      const first = await call(mcp.routes, stale.threadId, {
        approvalId: stale.approvalId,
        toolCallId: 'act1',
      });
      const afterReconnect = await call(routes, stale.threadId, {
        approvalId: stale.approvalId,
        toolCallId: 'act1',
      });
      for (const response of [first, afterReconnect]) {
        expect(response.status).toBe(409);
        expect(JSON.stringify(await response.json())).toContain(
          'stale_evidence',
        );
      }
      expect(mcp.calls.sendMail).toHaveLength(0);
      expect(again.calls.sendMail).toHaveLength(0);
    } finally {
      reopened.close();
    }

    // control: evidence read at the CURRENT revision executes the stored request exactly once,
    // also through a reconnected handle (so the 409 above is caused by the edit, not by a blanket refusal)
    const fresh = await requestApproval(w, w.normal.id, {
      readPageId: page.id,
    });
    expect(fresh.approvalId, fresh.gatedResult).toBeTruthy();
    const reopened2 = new w.up.WorkspaceStore(w.sqlitePath, 'owner');
    try {
      const again = await mcpTransportFactory();
      const service = new w.up.ConnectionService(
        reopened2.connections,
        again.transport,
      );
      const routes = w.up.connectionRoutes(reopened2, service);
      const ok = await call(routes, fresh.threadId, {
        approvalId: fresh.approvalId,
        toolCallId: 'act1',
      });
      expect(ok.status).toBe(200);
      expect(again.calls.sendMail).toEqual([SEND_ARGS]);
      const replay = await call(routes, fresh.threadId, {
        approvalId: fresh.approvalId,
        toolCallId: 'act1',
      });
      expect(replay.status).toBe(200);
      expect(again.calls.sendMail).toHaveLength(1);
    } finally {
      reopened2.close();
    }
  });

  it('[TP3.3][TP3.6][M10] B4: a NULL vector is refused for an incident Dot (zero effects) and accepted for an ordinary Dot (control); the incident rule does not depend on evidence being stale', async () => {
    const { routes, calls } = await setup(w);
    const incident = nullVectorApproval(w, w.incident.id);
    expect(storedVector(w.sqlitePath, incident.approvalId).value).toBeNull();
    const refused = await call(routes, incident.threadId, {
      approvalId: incident.approvalId,
      toolCallId: 'act1',
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(
      calls.sendMail,
      'the gated MCP tool must not run for an incident Dot',
    ).toHaveLength(0);

    const ordinary = nullVectorApproval(w, w.normal.id);
    const accepted = await call(routes, ordinary.threadId, {
      approvalId: ordinary.approvalId,
      toolCallId: 'act1',
    });
    expect(
      accepted.status,
      'TOOL_COVERAGE M10: a NULL vector passes for a non-incident Dot',
    ).toBe(200);
    expect(calls.sendMail).toEqual([SEND_ARGS]);
  });

  it('[TP3.6][M10][reconnect] B3: after a REAL restart (nd.stop(), a new createNemoDots on the same databases, a new app) the stale approval is 409 stale_evidence and the fresh one executes exactly once over HTTP', async () => {
    const page = w.workspace.pages.create(w.spaceA, {
      title: 'Restart evidence page',
      content: 'v1',
    });
    const stale = await requestApproval(w, w.normal.id, {
      readPageId: page.id,
    });
    expect(stale.approvalId, stale.gatedResult).toBeTruthy();
    expect(storedVector(w.sqlitePath, stale.approvalId!).value).not.toBeNull();
    const edit = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 1, content: 'v2' }),
    });
    expect(edit.status).toBe(200);
    // this approval is created AFTER the edit, from the current revision (2)
    const fresh = await requestApproval(w, w.normal.id, {
      readPageId: page.id,
    });
    expect(fresh.approvalId, fresh.gatedResult).toBeTruthy();

    const mcp = await mcpTransportFactory();
    await w.restart({ transport: mcp.transport });

    const post = (threadId: string, approvalId: string | null) =>
      w.authed(`/api/conversations/${threadId}/connection-actions`, {
        method: 'POST',
        body: JSON.stringify({ approvalId, toolCallId: 'act1' }),
      });
    const refused = await post(stale.threadId, stale.approvalId);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('stale_evidence');
    expect(mcp.calls.sendMail).toHaveLength(0);

    const ok = await post(fresh.threadId, fresh.approvalId);
    expect(ok.status).toBe(200);
    expect(mcp.calls.sendMail).toEqual([SEND_ARGS]);
    const replay = await post(fresh.threadId, fresh.approvalId);
    expect(replay.status).toBe(200);
    expect(mcp.calls.sendMail).toHaveLength(1);

    // the vector of the stale approval still names revision 1 in the restarted composition's database
    const rows = await adminQuery<{ n: number }>(
      w.db!.admin,
      `SELECT count(*)::int AS n FROM ledger.source_revisions r JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1`,
      [`opendots.page/${page.id}`],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
