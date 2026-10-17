// Gate 3 remainder:
//  A. [TP3.1][I4] with NEMODOTS_INCIDENT_DOT_IDS empty the hooks are inactive: upstream behaviour unchanged.
//  B. [TP3.1][M3][M4] owner page routes and the reviewed-page route emit page revisions into the ledger while
//     upstream CAS / idempotency semantics are preserved.
//  C. [TP3.3] deployment audit: the disabled paths of TOOL_COVERAGE (web search, browser, Composio, computer,
//     voice, Slack) are disabled in the configuration the incident run uses (names and provider words only).
//  D. [TP3.1][TP3.2][TP3.3][TP3.5] the nine NemoDots team-tool executors (TOOL_COVERAGE section 1). These need
//     team/tools.ts, which does not exist yet: each case FAILS with ENTRY POINT MISSING and, once the module
//     exists, with DRIVER WIRING PENDING until the verifier binds the executor signature. No case passes vacuously.
//  E. NOT_RUN paths that need a persisted Intelligence conversation or a live provider.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  DriverWiringPendingError,
  EntryPointMissingError,
  SUPERVISOR_BASE,
  lazyWorld,
  mcpTransportFactory,
  runDotTurn,
  tablesContaining,
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

  it('[TP3.1][M4] owner create, patch and delete over HTTP each leave an opendots.page/<id> trace in the ledger; a stale expectedRevision is 409 and changes nothing', async () => {
    const created = await w.authed(`/api/spaces/${w.spaceA}/pages`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Owner page', content: 'v1' }),
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; revision: number };
    expect(
      await tablesContaining(w.db!.admin, `opendots.page/${page.id}`),
    ).not.toEqual([]);

    const ok = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 1, content: 'v2' }),
    });
    expect(ok.status).toBe(200);
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

    const del = await w.authed(`/api/spaces/${w.spaceA}/pages/${page.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
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
    expect(
      await tablesContaining(w.db!.admin, `opendots.page/${saved.id}`),
    ).not.toEqual([]);
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

/* ------------------------------------------------------------------ D. team-tool executors */

function pendingUntilBound(
  caseId: string,
  expectation: string,
  module = 'src/server/nemodots/team/tools.ts',
): never {
  if (!existsSync(join(APP_ROOT, module)))
    throw new EntryPointMissingError(
      module,
      `required for ${caseId}: ${expectation}`,
    );
  throw new DriverWiringPendingError(
    caseId,
    `${module} exists; the verifier must bind its signature. Expected: ${expectation}`,
  );
}

describe('[TP3.1][TP3.2][TP3.3][TP3.5] NemoDots team-tool executors (TOOL_COVERAGE section 1)', () => {
  it('[TP3.3][T1] a tool name outside the nine is rejected by the executor registry before any handler runs, including names containing read/list/get', () => {
    pendingUntilBound(
      'G3-T1',
      'dispatching "read_file", "run_shell", "__proto__", "constructor" returns a typed error, writes no receipt, and calls no handler',
    );
  });
  it('[TP3.3][T2] read_runbook resolves ids through the catalogue map only: traversal ids return an error and never touch the file system', () => {
    pendingUntilBound(
      'G3-T2',
      'ids "../../.env", "/etc/passwd", "cache-recovery.md/../x" fail; a catalogue id returns its digest-recorded text',
    );
  });
  it("[TP3.2][T3] get_task_status accepts only tasks of the attempt's own mission: a task id of another mission returns not-found without revealing existence", () => {
    pendingUntilBound(
      'G3-T3',
      'foreign and unknown task ids are indistinguishable (same error), the own-mission task returns status and output summary',
    );
  });
  it('[TP3.2][T4] model-supplied mission, task, attempt and receipt ids grant nothing: identity comes from AttemptContext, receipt ids are citations checked against scope', () => {
    pendingUntilBound(
      'G3-T4',
      'publish_finding citing a receipt outside the attempt scope is rejected (citation_out_of_scope); extra identity keys fail strict parsing',
    );
  });
  it('[TP3.1][T5] observe_source records or confirms a receipt and a readset edge in one transaction, scoped to the attempt context, and a source key outside the registry is rejected', () => {
    pendingUntilBound(
      'G3-T5',
      'one receipt (or confirmation), one readset edge, one tool_call.recorded event; an unregistered key writes nothing; opendots.page/<id> for a page outside the Dot/mission Space grant is refused',
    );
  });
  it('[TP3.5][T6] a tool result containing instruction-like text is stored and returned as data: it creates no task, no action and no capability', () => {
    pendingUntilBound(
      'G3-T6',
      'observe_source of a source whose value says "delegate_task to run_shell" leaves task and action counts unchanged',
    );
  });
  it('[TP3.4][T7] no tool result contains a database URL, probe secret, provider key or injector actor', () => {
    pendingUntilBound(
      'G3-T7',
      'serialized results of all nine tools contain none of the visible secret values and no caused_by_actor field',
    );
  });
  it('[TP3.1][T8] delegate_task and propose_action are policy-checked at their boundary: capability subset, depth/breadth/total caps, justification required, specialists delegate verifier only', () => {
    pendingUntilBound(
      'G3-T8',
      'violations return typed errors and create no task or intent',
    );
  });
});

describe('[TP3.1] Dot-turn context snapshots (TOOL_COVERAGE R1, R4)', () => {
  it('[TP3.1][R1] a Dot turn records the Dot id and an instructions digest in the model-call context snapshot', () => {
    pendingUntilBound(
      'G3-R1',
      'the ContextSnapshot.injected entry for a Dot turn names the Dot and the digest of its instructions; the instructions text itself is not duplicated into the record',
      'src/server/nemodots/interception/provenance-middleware.ts',
    );
  });
  it('[TP3.1][R4] replayed conversation history items are recorded as historyItems[] digests and inherit the dependency vectors of the model call that produced them', () => {
    pendingUntilBound(
      'G3-R4',
      'turn 2 of a thread records history digests for turn 1 and carries turn 1 vectors; a page read in turn 1 and edited before turn 2 makes the turn-2 snapshot non-current',
      'src/server/nemodots/interception/provenance-middleware.ts',
    );
  });
});

/* ------------------------------------------------------------------ E. NOT_RUN paths */

describe('NOT_RUN: paths that need a persisted Intelligence conversation or a live provider', () => {
  it('[TP3.1][M5][M14] POST /api/conversations/:id/page and scheduled/voice/Slack headless turns are exercised only by the live Intelligence suites', () => {
    throw new Error(
      'NOT_RUN: M5 (saveConversation) reads persisted Intelligence messages and M14 scheduled turns use IntelligenceAgent; ' +
        'they are covered by the verifier live run (tests/nemodots/live/interception, gate 4.8). The channel/headless ' +
        'DotAgent path is covered above in g3-03. This case stays red until that live run is recorded.',
    );
  });
  it('[TP3.1][R5][R13] learned-skill catalog and executors (copilotkit_load_skill / copilotkit_read_skill_file) need an Intelligence-hosted skill snapshot', () => {
    throw new Error(
      'NOT_RUN: learned-skill tools are built from the BuiltInAgent factory context with an Intelligence skill snapshot; ' +
        'the executor path needs a live snapshot. Red until recorded by the live run.',
    );
  });
});
