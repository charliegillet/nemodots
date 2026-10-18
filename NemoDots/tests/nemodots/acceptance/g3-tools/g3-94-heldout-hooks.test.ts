// Gate 3 HELD-OUT cases for the defence-in-depth hooks (TOOL_COVERAGE I4, M4), added
// 2026-10-18 after the independence disclosure (./README.md). Pages, contents, tool names
// and revisions are random per run. Expectations restate TOOL_COVERAGE:
// - I4: with NEMODOTS_INCIDENT_DOT_IDS empty, every hook is inactive and upstream behaviour
//   is unchanged (no Dot is refused anything the hooks would refuse).
// - M4: owner page routes keep upstream CAS (a stale expectedRevision is 409 and changes
//   nothing). They are outside the guarantee, and "the Pages revision hook runs but
//   registers nothing" for an owner write.
import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminQuery, lazyWorld, runDotTurn, type World } from './g3-support.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

describe('[HELD-OUT] [TP3.1][I4] with no incident Dot listed the hooks are inactive', () => {
  const lazy = lazyWorld({ nemodots: true, listIncidentDot: false });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
    w.store.updateSettings({ appsAllowed: true });
  }, 600_000);
  afterAll(async () => {
    await lazy.close();
  }, 120_000);

  it('[TP3.1][I4] held-out: the Dot that would be an incident Dot edits and creates random pages as upstream, and a random MCP tool runs for it', async () => {
    const before = `v1 ${hex(4)}`;
    const after = `v2 ${hex(4)}`;
    const title = `made ${hex(4)}`;
    const page = w.workspace.pages.create(w.spaceA, {
      title: `p${hex(3)}`,
      content: before,
    });
    const turn = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: [
          {
            id: `e${hex(2)}`,
            name: 'edit_space_page',
            arguments: { id: page.id, content: after, expectedRevision: 1 },
          },
          {
            id: `c${hex(2)}`,
            name: 'create_space_page',
            arguments: { title, content: hex(4) },
          },
        ],
      },
      { text: 'done' },
    ]);
    expect(turn.runError).toBeUndefined();
    expect(w.workspace.pages.get(w.spaceA, page.id)).toMatchObject({
      revision: 2,
      content: after,
    });
    expect(
      w.workspace.pages
        .list(w.spaceA)
        .some((p: { title: string }) => p.title === title),
    ).toBe(true);

    const { McpServer } =
      await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { InMemoryTransport } =
      await import('@modelcontextprotocol/sdk/inMemory.js');
    const { z } = await import('zod');
    const name = `${['read', 'send', 'sync'][randomInt(3)]}_${hex(3)}`;
    const runs: unknown[] = [];
    const transport = () => {
      const server = new McpServer({ name: `s${hex(2)}`, version: '1.0.0' });
      server.registerTool(
        name,
        { description: 'x', inputSchema: { q: z.string() } },
        async (args: { q: string }) => {
          runs.push(args);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      );
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return client;
    };
    const service = new w.up.ConnectionService(
      w.workspace.connections,
      transport,
    );
    const connection = w.workspace.connections.create(
      w.incident.id,
      { name: `c${hex(4)}`, url: `https://${hex(4)}.acc3.invalid/mcp` },
      [
        {
          name,
          title: name,
          description: 'x',
          inputSchema: { type: 'object' },
          readOnly: randomInt(2) === 1,
          enabled: true,
          requiresApproval: false,
        },
      ],
    );
    const exposed = service
      .tools(w.incident.id)
      .find(
        (t: { connection: { id: string } }) =>
          t.connection.id === connection.id,
      );
    const q = hex(3);
    const result = await service.call(exposed, { q });
    expect(result.isError).toBe(false);
    expect(runs).toEqual([{ q }]);
  });
});

describe('[HELD-OUT] [TP3.1][M4] owner page routes keep upstream CAS and register nothing', () => {
  const lazy = lazyWorld({ nemodots: true, serve: true });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
  }, 600_000);
  afterAll(async () => {
    await lazy.close();
  }, 120_000);

  it('[TP3.1][M4] held-out: owner create, a random number of patches, a stale patch (409, unchanged) and delete; no opendots.page/<id> ledger source is registered for an owner write', async () => {
    const created = await w.authed(`/api/spaces/${w.spaceA}/pages`, {
      method: 'POST',
      body: JSON.stringify({ title: `o${hex(3)}`, content: hex(5) }),
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; revision: number };
    const patches = 1 + randomInt(3);
    let content = '';
    for (let n = 1; n <= patches; n += 1) {
      content = `v${n + 1} ${hex(4)}`;
      const ok = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: n, content }),
      });
      expect(ok.status, `patch ${n}`).toBe(200);
    }
    const staleRevision = 1 + randomInt(patches); // any revision below the current one
    const stale = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedRevision: staleRevision,
        content: `stale ${hex(4)}`,
      }),
    });
    expect(stale.status).toBe(409);
    expect(w.workspace.pages.get(w.spaceA, page.id)).toMatchObject({
      revision: patches + 1,
      content,
    });
    const del = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'DELETE',
      // upstream /api rejects any non-GET request without a JSON content type (415)
      headers: { 'Content-Type': 'application/json' },
    });
    expect(del.status).toBe(200);
    // TOOL_COVERAGE M4: "the Pages revision hook runs but registers nothing"
    const sources = await adminQuery<{ n: number }>(
      w.db!.admin,
      'SELECT count(*)::int n FROM ledger.sources WHERE key = $1',
      [`opendots.page/${page.id}`],
    );
    expect(sources[0].n).toBe(0);
  });
});
