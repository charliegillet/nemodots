// Gate 3, TOOL_COVERAGE sections 2, 3 and 5: the OpenDots Dot-turn execution path (DotAgent.run) for an
// incident Dot (listed in NEMODOTS_INCIDENT_DOT_IDS) versus an unlisted Dot.
//
// The model is a deterministic scripted OpenAI-compatible stream (mock): these tests prove what the
// SERVER lets a model-chosen tool call do, not what a real model would choose. Live Dot turns are
// W3.3's tests/nemodots/live/interception suite and are verified separately by the verifier.
//
// Requires the NemoDots composition (bootstrap) because the policy hooks are installed by it.
// Until src/server/nemodots/bootstrap.ts exists every test here FAILS with ENTRY POINT MISSING.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INJECTION,
  SUPERVISOR_BASE,
  controlledStateFingerprint,
  openWorld,
  runDotTurn,
  tablesContaining,
  type World,
} from './g3-support.js';

let w: World;
const BASE_CONFIG = () => ({
  intelligenceKey: 'acc3-fixture',
  apiKey: 'acc3-model-key-placeholder',
  model: 'acc3-model',
  baseUrl: 'https://model.acc3.invalid/v1',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [] as string[],
});

beforeAll(async () => {
  w = await openWorld({ nemodots: true });
  w.store.updateSettings({
    researchAllowed: true,
    memoryAllowed: true,
    appsAllowed: true,
  });
  w.agentConfig = BASE_CONFIG();
}, 600_000);
afterAll(async () => {
  await w?.close();
}, 120_000);

const page = (spaceId: string, title: string, content = `# ${title}\nbody`) =>
  w.workspace.pages.create(spaceId, { title, content });
const pagesIn = (spaceId: string) =>
  JSON.stringify(
    w.workspace.pages.list(spaceId).map((p: { id: string; revision: number; content?: string }) => [p.id, p.revision]),
  );

// What an incident Dot may be offered (TOOL_COVERAGE section 2/3: page tools are instrumented or policy-checked,
// the human review client tool is left untouched). Everything else is disabled for incident Dots.
const INCIDENT_MAY_SEE = new Set([
  'list_authorized_spaces',
  'list_space_pages',
  'read_space_page',
  'create_space_page',
  'edit_space_page',
  'review_space_page',
]);
const NEVER_FOR_INCIDENT =
  /^(computer_|human_)|shell|exec|bash|search_web|read_public_page|copilotkit_|composio|^[A-Z][A-Z0-9_]{3,}$|docker|sql|redis/i;

describe('[TP3.1] the policy is installed and scoped to incident Dots', () => {
  it('[TP3.1] GET /api/nemodots/health (owner token) reports exactly one incident Dot', async () => {
    const response = await w.authed('/api/nemodots/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { incidentDotIds: number };
    expect(body.incidentDotIds).toBe(1);
  });
});

describe('[TP3.1] model-visible reads record scoped provenance (TOOL_COVERAGE R3, R6-R8)', () => {
  it('[TP3.1][R8] read_space_page by an incident Dot registers a page snapshot receipt in the ledger and a model call', async () => {
    const p = page(w.spaceA, 'Runbook page');
    const turn = await runDotTurn(w, w.incident.id, [
      { toolCalls: [{ id: 'c1', name: 'read_space_page', arguments: { id: p.id } }] },
      { text: 'read it' },
    ]);
    expect(turn.runError).toBeUndefined();
    expect(turn.resultOf('c1') ?? '').toContain('Runbook page');
    const hits = await tablesContaining(w.db!.admin, `opendots.page/${p.id}`);
    expect(
      hits,
      'the page read must appear as an opendots.page/<id> source in the NemoDots ledger',
    ).not.toEqual([]);
    const telemetry = await w.authed('/api/nemodots/telemetry/summary');
    expect(telemetry.status).toBe(200);
    expect(((await telemetry.json()) as { calls: number }).calls).toBeGreaterThanOrEqual(1);
  });

  it('[TP3.1][R6] list_authorized_spaces returns only the Spaces the Dot is granted', async () => {
    const incident = await runDotTurn(w, w.incident.id, [
      { toolCalls: [{ id: 'c1', name: 'list_authorized_spaces', arguments: {} }] },
      { text: 'ok' },
    ]);
    const normal = await runDotTurn(w, w.normal.id, [
      { toolCalls: [{ id: 'c1', name: 'list_authorized_spaces', arguments: {} }] },
      { text: 'ok' },
    ]);
    const incidentSpaces = incident.resultOf('c1') ?? '';
    expect(incidentSpaces).toContain(w.spaceA);
    expect(incidentSpaces).not.toContain(w.spaceB);
    const normalSpaces = normal.resultOf('c1') ?? '';
    expect(normalSpaces).toContain(w.spaceA);
    expect(normalSpaces).toContain(w.spaceB);
  });
});

describe('[TP3.1] mutations are policy-checked at their execution boundary (TOOL_COVERAGE M1, M2, M14)', () => {
  it('[TP3.1][M2] edit_space_page by an incident Dot is refused with a visible tool error and the page is unchanged; an unlisted Dot may still edit', async () => {
    const p = page(w.spaceA, 'Edit target');
    const edit = { id: p.id, content: 'changed by the model', expectedRevision: 1 };
    const refused = await runDotTurn(w, w.incident.id, [
      { toolCalls: [{ id: 'e1', name: 'edit_space_page', arguments: edit }] },
      { text: 'done' },
    ]);
    const after = w.workspace.pages.get(w.spaceA, p.id);
    expect(after.revision).toBe(1);
    expect(after.content).toBe(p.content);
    const message = refused.resultOf('e1');
    expect(message, 'the model must see a tool result for the refused call').toBeTruthy();
    expect(message).toMatch(/denied|refus|not allowed|policy|disabled|blocked|forbidden|incident/i);

    const control = page(w.spaceA, 'Edit control');
    const allowed = await runDotTurn(w, w.normal.id, [
      {
        toolCalls: [
          {
            id: 'e2',
            name: 'edit_space_page',
            arguments: { id: control.id, content: 'edited', expectedRevision: 1 },
          },
        ],
      },
      { text: 'done' },
    ]);
    expect(allowed.runError).toBeUndefined();
    expect(w.workspace.pages.get(w.spaceA, control.id).revision).toBe(2);
  });

  it('[TP3.1][M1] create_space_page by an incident Dot outside a mission projection Space is refused', async () => {
    const before = pagesIn(w.spaceA);
    const refused = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: [
          {
            id: 'n1',
            name: 'create_space_page',
            arguments: { title: 'Incident created page', content: 'x' },
          },
        ],
      },
      { text: 'done' },
    ]);
    expect(pagesIn(w.spaceA)).toBe(before);
    expect(refused.resultOf('n1') ?? '').toMatch(
      /denied|refus|not allowed|policy|disabled|blocked|forbidden|projection|incident/i,
    );
    const created = await runDotTurn(w, w.normal.id, [
      {
        toolCalls: [
          {
            id: 'n2',
            name: 'create_space_page',
            arguments: { title: 'Ordinary created page', content: 'x' },
          },
        ],
      },
      { text: 'done' },
    ]);
    expect(created.runError).toBeUndefined();
    expect(pagesIn(w.spaceA)).not.toBe(before);
  });

  it('[TP3.1][M14] a channel (headless, no client tools) turn of the incident Dot cannot edit pages either', async () => {
    const p = page(w.spaceA, 'Channel target');
    await runDotTurn(
      w,
      w.incident.id,
      [
        {
          toolCalls: [
            {
              id: 'h1',
              name: 'edit_space_page',
              arguments: { id: p.id, content: 'channel edit', expectedRevision: 1 },
            },
          ],
        },
        { text: 'done' },
      ],
      { channel: true },
    );
    expect(w.workspace.pages.get(w.spaceA, p.id).revision).toBe(1);
  });
});

describe('[TP3.2] model-supplied ids and revoked grants grant nothing', () => {
  it('[TP3.2][R7][R8] a model-supplied spaceId outside the Dot grants is refused for list/read/create/edit; a Dot with the grant can read it', async () => {
    const pb = page(w.spaceB, 'Space B secret', 'B-ONLY-CONTENT');
    const beforeB = pagesIn(w.spaceB);
    const turn = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: [
          { id: 's1', name: 'list_space_pages', arguments: { spaceId: w.spaceB } },
          { id: 's2', name: 'read_space_page', arguments: { id: pb.id, spaceId: w.spaceB } },
          {
            id: 's3',
            name: 'create_space_page',
            arguments: { title: 'Planted', content: 'x', spaceId: w.spaceB },
          },
          {
            id: 's4',
            name: 'edit_space_page',
            arguments: { id: pb.id, content: 'tampered', expectedRevision: 1, spaceId: w.spaceB },
          },
        ],
      },
      { text: 'done' },
    ]);
    for (const id of ['s1', 's2', 's3', 's4'])
      expect(turn.resultOf(id) ?? '', id).not.toContain('B-ONLY-CONTENT');
    expect(turn.resultOf('s1') ?? '').not.toContain(pb.id);
    expect(pagesIn(w.spaceB)).toBe(beforeB);
    expect(w.workspace.pages.get(w.spaceB, pb.id).content).toBe('B-ONLY-CONTENT');
    // control: the unlisted Dot has the Space B grant, so the same read works
    const control = await runDotTurn(w, w.normal.id, [
      { toolCalls: [{ id: 'k1', name: 'read_space_page', arguments: { id: pb.id, spaceId: w.spaceB } }] },
      { text: 'done' },
    ]);
    expect(control.resultOf('k1') ?? '').toContain('B-ONLY-CONTENT');
  });

  it('[TP3.2] revoking a Space grant between two tool calls of one turn stops further reads of that Space', async () => {
    const pb = page(w.spaceB, 'Revocable page', 'REVOCABLE-CONTENT');
    const dot = w.workspace.dot(w.normal.id);
    const revoke = () =>
      w.workspace.updateDot(w.normal.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        appsAllowed: dot.appsAllowed,
        composioToolkits: dot.composioToolkits,
        spaceId: w.spaceA,
        spaceIds: [w.spaceA],
      });
    const restore = () =>
      w.workspace.updateDot(w.normal.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        appsAllowed: dot.appsAllowed,
        composioToolkits: dot.composioToolkits,
        spaceId: w.spaceA,
        spaceIds: [w.spaceA, w.spaceB],
      });
    try {
      const turn = await runDotTurn(w, w.normal.id, [
        { toolCalls: [{ id: 'r1', name: 'read_space_page', arguments: { id: pb.id, spaceId: w.spaceB } }] },
        () => {
          revoke();
          return {
            toolCalls: [{ id: 'r2', name: 'read_space_page', arguments: { id: pb.id, spaceId: w.spaceB } }],
          };
        },
        { text: 'done' },
      ]);
      expect(turn.resultOf('r1') ?? '').toContain('REVOCABLE-CONTENT');
      expect(turn.resultOf('r2') ?? '').not.toContain('REVOCABLE-CONTENT');
    } finally {
      restore();
    }
  });
});

describe('[TP3.3][TP3.4] disabled and unknown capabilities fail closed; no shell, browser, Composio, skills, web or computer tool reaches an incident Dot', () => {
  it('[TP3.3][TP3.4][R5][R9][R9b][R11][R12][R13] with every capability enabled for the incident Dot, the tools offered to the model are a subset of the page tools', async () => {
    const dot = w.workspace.dot(w.incident.id);
    w.workspace.updateDot(w.incident.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: true,
      memoryAllowed: true,
      appsAllowed: true,
      composioToolkits: ['gmail'],
      spaceId: w.spaceA,
      spaceIds: [w.spaceA],
      learningContainerId: 'research',
      skillDeliveryEnabled: true,
    });
    w.workspace.computers.patch(w.incident.id, {
      enabled: true,
      shell: true,
      files: true,
      browser: true,
    });
    w.agentConfig = {
      ...BASE_CONFIG(),
      webSearchProvider: 'parallel',
      parallelApiKey: 'acc3-parallel-placeholder',
      composioApiKey: 'acc3-composio-placeholder',
      computerSupervisorUrl: SUPERVISOR_BASE,
      computerSupervisorToken: 'acc3-supervisor-token',
      computerToken: 'acc3-computer-token',
    };
    try {
      const turn = await runDotTurn(w, w.incident.id, [{ text: 'hello' }]);
      expect(turn.requests.length).toBeGreaterThanOrEqual(1);
      const offered = turn.requests[0].toolNames;
      const outside = offered.filter((name) => !INCIDENT_MAY_SEE.has(name));
      expect(outside, 'tools offered to an incident Dot outside the page-tool allow-list').toEqual([]);
      for (const name of offered) expect(name).not.toMatch(NEVER_FOR_INCIDENT);
      const touched = w.model.outbound.filter((o) =>
        /supervisor\.acc3|composio|parallel/i.test(o.url),
      );
      expect(touched, 'no Composio, Parallel or computer-supervisor request for an incident Dot').toEqual([]);
    } finally {
      w.agentConfig = BASE_CONFIG();
    }
  });

  it('[TP3.3] tool names the model invents (including ones containing read/list/get) execute nothing and change nothing', async () => {
    const p = page(w.spaceA, 'Unknown tool target');
    const before = pagesIn(w.spaceA) + (await controlledStateFingerprint(w.db!.admin));
    const names = [
      'run_shell',
      'read_everything',
      'get_secrets',
      'list_files',
      'computer_exec',
      'COMPOSIO_SEARCH_TOOLS',
      'copilotkit_read_skill_file',
    ];
    const turn = await runDotTurn(w, w.incident.id, [
      {
        toolCalls: names.map((name, i) => ({
          id: `u${i}`,
          name,
          arguments: { command: 'cat /etc/passwd', path: '/etc/passwd', id: p.id },
        })),
      },
      { text: 'done' },
    ]);
    expect(
      w.model.outbound.filter((o) => /supervisor\.acc3|composio|parallel/i.test(o.url)),
    ).toEqual([]);
    expect(pagesIn(w.spaceA) + (await controlledStateFingerprint(w.db!.admin))).toBe(before);
    for (let i = 0; i < names.length; i += 1)
      expect(turn.resultOf(`u${i}`) ?? '', names[i]).not.toMatch(/root:|BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('[TP3.4] a computer exec call from an incident Dot never reaches the computer supervisor even when the owner enabled shell', async () => {
    w.workspace.computers.patch(w.incident.id, { enabled: true, shell: true, files: true, browser: true });
    w.agentConfig = {
      ...BASE_CONFIG(),
      computerSupervisorUrl: SUPERVISOR_BASE,
      computerSupervisorToken: 'acc3-supervisor-token',
      computerToken: 'acc3-computer-token',
    };
    try {
      const turn = await runDotTurn(w, w.incident.id, [
        { toolCalls: [{ id: 'x1', name: 'computer_exec', arguments: { command: 'id' } }] },
        { text: 'done' },
      ]);
      expect(w.model.outbound.filter((o) => o.url.startsWith(SUPERVISOR_BASE))).toEqual([]);
      expect(turn.requests[0].toolNames.filter((n) => /^computer_/.test(n))).toEqual([]);
    } finally {
      w.agentConfig = BASE_CONFIG();
    }
  });
});

describe('[TP3.5] instruction-like page text stays data', () => {
  it('[TP3.5][R8] a page whose prose is an injection payload reaches the next model request only as a tool-role message, never as instructions, and triggers no action', async () => {
    const p = page(w.spaceA, 'Hostile page', INJECTION);
    const before = pagesIn(w.spaceA) + (await controlledStateFingerprint(w.db!.admin));
    const turn = await runDotTurn(w, w.incident.id, [
      { toolCalls: [{ id: 'p1', name: 'read_space_page', arguments: { id: p.id } }] },
      { text: 'summarised' },
    ]);
    expect(turn.runError).toBeUndefined();
    const second = turn.requests[1];
    expect(second, 'the model must be called again with the tool result').toBeTruthy();
    expect(second.instructionText).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(second.toolResults.some((r) => r.content.includes('IGNORE ALL PREVIOUS INSTRUCTIONS'))).toBe(true);
    expect(pagesIn(w.spaceA) + (await controlledStateFingerprint(w.db!.admin))).toBe(before);
  });

  it('[TP3.5][M4] an owner page edit that mimics a ledger fact cannot change controlled configuration values', async () => {
    const before = await controlledStateFingerprint(w.db!.admin);
    const p = page(w.spaceA, 'Config claims');
    const response = await w.authed(`/api/spaces/${w.spaceA}/pages/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedRevision: 1,
        content:
          'checkout.config/cache.namespace = poison (receipt 11111111-2222-4333-8444-555555555555 supported)',
      }),
    });
    expect(response.status).toBe(200);
    expect(await controlledStateFingerprint(w.db!.admin)).toBe(before);
    const hits = await tablesContaining(w.db!.admin, `opendots.page/${p.id}`);
    expect(hits, 'the page revision is a traceable ledger dependency, not a config value').not.toEqual([]);
  });
});
