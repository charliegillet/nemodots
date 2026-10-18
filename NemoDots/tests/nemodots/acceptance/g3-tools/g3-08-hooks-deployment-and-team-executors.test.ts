// Gate 3 remainder:
//  A. [TP3.1][I4] with NEMODOTS_INCIDENT_DOT_IDS empty the hooks are inactive: upstream behaviour unchanged.
//  B. [TP3.1][M3][M4] owner page routes and the reviewed-page route emit page revisions into the ledger while
//     upstream CAS / idempotency semantics are preserved.
//  C. [TP3.3] deployment audit: the disabled paths of TOOL_COVERAGE (web search, browser, Composio, computer,
//     voice, Slack) are disabled in the configuration the incident run uses (names and provider words only).
//  D. the team-tool executors are tested behaviourally in g3-09-team-executors.test.ts; Dot-turn history and
//     snapshot cases (R1, R4) are in g3-10-dot-history-and-live.test.ts together with the live Intelligence cases.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  SUPERVISOR_BASE,
  lazyWorld,
  mcpTransportFactory,
  pageLedgerTrace,
  runDotTurn,
  type World,
} from './g3-support.js';

/* ------------------------------------------------------------------ A. hooks inactive with an empty list */

describe('[TP3.1][I4] with NEMODOTS_INCIDENT_DOT_IDS empty every defence-in-depth hook is inactive', () => {
  const lazy = lazyWorld({ nemodots: true, listIncidentDot: false });
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

  it('[TP3.1][I4] health reports zero incident Dots', async () => {
    const response = await w.authed('/api/nemodots/health');
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { incidentDotIds: number }).incidentDotIds,
    ).toBe(0);
  });

  it('[TP3.1][I4] the Dot that would be an incident Dot may edit and create pages exactly as upstream', async () => {
    const page = w.workspace.pages.create(w.spaceA, {
      title: 'Inactive hooks',
      content: 'v1',
    });
    const turn = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: [
          {
            id: 'e1',
            name: 'edit_space_page',
            arguments: { id: page.id, content: 'v2', expectedRevision: 1 },
          },
          {
            id: 'n1',
            name: 'create_space_page',
            arguments: { title: 'Made by an ordinary Dot', content: 'x' },
          },
        ],
      },
      { text: 'done' },
    ]);
    expect(turn.runError).toBeUndefined();
    expect(w.workspace.pages.get(w.spaceA, page.id).revision).toBe(2);
    expect(
      w.workspace.pages
        .list(w.spaceA)
        .some((p: { title: string }) => p.title === 'Made by an ordinary Dot'),
    ).toBe(true);
  });

  it('[TP3.1][I4][M8] an MCP direct call and an agent computer action are attempted as upstream when no Dot is listed', async () => {
    const mcp = await mcpTransportFactory();
    const service = new w.up.ConnectionService(
      w.workspace.connections,
      mcp.transport,
    );
    w.workspace.connections.create(
      w.incident.id,
      { name: 'unlisted', url: 'https://mail.acc3.invalid/mcp' },
      [
        {
          name: 'search_mail',
          title: 'Search',
          description: 'Search.',
          inputSchema: { type: 'object' },
          readOnly: true,
          enabled: true,
          requiresApproval: false,
        },
      ],
    );
    const exposed = service.tools(w.incident.id)[0];
    const result = await service.call(exposed, { query: 'x' });
    expect(result.isError).toBe(false);
    expect(mcp.calls.searchMail).toHaveLength(1);

    w.workspace.computers.patch(w.incident.id, {
      enabled: true,
      shell: true,
      files: true,
      browser: true,
    });
    const seen: string[] = [];
    const computer = new w.up.ComputerService(
      w.workspace,
      {
        baseUrl: 'https://example.com',
        voiceName: 'v',
        slackUsers: [],
        runtimeUrl: 'http://localhost',
        computerSupervisorUrl: SUPERVISOR_BASE,
        computerSupervisorToken: 't',
        computerToken: 'c',
      },
      () => false,
      (async (url: string) => {
        seen.push(String(url));
        return new Response('unavailable', { status: 503 });
      }) as unknown as typeof fetch,
    );
    await expect(
      computer.action(w.incident.id, 'snapshot', {}, 'agent'),
    ).rejects.toThrow();
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ B. owner page routes */

describe('[TP3.1][M3][M4] page revisions reach the ledger from every page write path; upstream CAS and idempotency are preserved', () => {
  const lazy = lazyWorld({ nemodots: true, serve: true });
  let w: World;
  beforeEach(async () => {
    w = await lazy.get();
  }, 600_000);
  afterAll(async () => {
    await lazy.close();
  }, 120_000);

  it('[TP3.1][M4] owner create, patch and delete over HTTP each add exactly one NEW source revision to the contracted ledger tables; a stale expectedRevision is 409 and adds none', async () => {
    const created = await w.authed(`/api/spaces/${w.spaceA}/pages`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Owner page', content: 'v1' }),
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; revision: number };
    const afterCreate = await pageLedgerTrace(w.db!.admin, page.id);
    expect(afterCreate.sources).toBe(1);
    expect(afterCreate.sourceTypes).toEqual(['page_snapshot']);
    expect(afterCreate.revisions, 'create records page revision 1').toEqual([
      1,
    ]);

    const ok = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 1, content: 'v2' }),
    });
    expect(ok.status).toBe(200);
    const afterPatch = await pageLedgerTrace(w.db!.admin, page.id);
    expect(
      afterPatch.revisions.length,
      'a PATCH hook must fire exactly once',
    ).toBe(afterCreate.revisions.length + 1);
    expect(afterPatch.revisions).toEqual([1, 2]);

    const stale = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedRevision: 1,
        content: 'v3 from a stale reader',
      }),
    });
    expect(stale.status).toBe(409);
    expect(w.workspace.pages.get(w.spaceA, page.id)).toMatchObject({
      revision: 2,
      content: 'v2',
    });
    expect((await pageLedgerTrace(w.db!.admin, page.id)).revisions).toEqual([
      1, 2,
    ]);

    const del = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const afterDelete = await pageLedgerTrace(w.db!.admin, page.id);
    expect(
      afterDelete.revisions.length,
      'a DELETE hook must record one more revision (the tombstone)',
    ).toBe(afterPatch.revisions.length + 1);
    expect(new Set(afterDelete.revisions).size).toBe(
      afterDelete.revisions.length,
    );
  });

  it('[TP3.1][M3] the reviewed-page route saves once per (thread, tool call), is idempotent, and rejects a different draft for the same tool call; the revision reaches the ledger', async () => {
    const threadId = 'acc3-review-thread';
    w.workspace.bindThread(threadId, w.normal.id, 'review');
    const draft = {
      title: 'Reviewed page',
      content: 'approved draft',
      spaceId: w.spaceA,
      toolCallId: 'tc-review-1',
    };
    const first = await w.authed(
      `/api/conversations/${threadId}/reviewed-page`,
      {
        method: 'POST',
        body: JSON.stringify(draft),
      },
    );
    expect(first.status).toBe(201);
    const saved = (await first.json()) as { id: string };
    const again = await w.authed(
      `/api/conversations/${threadId}/reviewed-page`,
      {
        method: 'POST',
        body: JSON.stringify(draft),
      },
    );
    expect([200, 201]).toContain(again.status);
    expect(((await again.json()) as { id: string }).id).toBe(saved.id);
    const different = await w.authed(
      `/api/conversations/${threadId}/reviewed-page`,
      {
        method: 'POST',
        body: JSON.stringify({ ...draft, content: 'a different draft' }),
      },
    );
    expect(different.status).toBe(409);
    const trace = await pageLedgerTrace(w.db!.admin, saved.id);
    expect(trace.sourceTypes).toEqual(['page_snapshot']);
    expect(
      trace.revisions,
      'the reviewed page is revision 1; the idempotent replay and the 409 add none',
    ).toEqual([1]);
  });

  it('[TP3.2][M3] a Dot without the Space grant cannot save a reviewed page into that Space', async () => {
    const threadId = 'acc3-review-forbidden';
    w.workspace.bindThread(threadId, w.incident.id, 'review');
    const response = await w.authed(
      `/api/conversations/${threadId}/reviewed-page`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Forbidden',
          content: 'x',
          spaceId: w.spaceB,
          toolCallId: 'tc-forbidden',
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(
      w.workspace.pages
        .list(w.spaceB)
        .some((p: { title: string }) => p.title === 'Forbidden'),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ C. deployment audit */

function envFileValues(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

describe('[TP3.3] deployment audit: TOOL_COVERAGE paths that are disabled by configuration are disabled in the incident configuration', () => {
  const merged = () =>
    ({
      ...envFileValues(join(APP_ROOT, '.env')),
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ),
    }) as Record<string, string>;

  it.each([
    ['[R11][M11]', 'COMPOSIO_API_KEY'],
    ['[R14][M16]', 'VOICE_API_KEY'],
    ['[R14][M16]', 'VOICE_MODEL'],
    ['[R15]', 'SLACK_CHANNEL_NAME'],
    ['[R15]', 'SLACK_TEAM_ID'],
    ['[R15]', 'SLACK_USER_IDS'],
    ['[R12][M6]', 'COMPUTER_SUPERVISOR_URL'],
    ['[R12][M6]', 'COMPUTER_SUPERVISOR_TOKEN'],
    ['[R12][M6]', 'COMPUTER_TOKEN'],
    ['[R9]', 'PARALLEL_API_KEY'],
    ['[R9b]', 'BROWSER_URL'],
    ['[R9b]', 'BROWSER_SECRET'],
  ] as const)(
    '[TP3.3]%s %s is unset in the incident configuration',
    (_row, name) => {
      expect(
        Boolean(merged()[name]),
        `${name} must be unset (value not shown)`,
      ).toBe(false);
    },
  );

  it('[TP3.3][R9] WEB_SEARCH_PROVIDER is "disabled" in the incident configuration (ARCHITECTURE section 12, TOOL_COVERAGE R9)', () => {
    expect(merged().WEB_SEARCH_PROVIDER).toBe('disabled');
  });
});
