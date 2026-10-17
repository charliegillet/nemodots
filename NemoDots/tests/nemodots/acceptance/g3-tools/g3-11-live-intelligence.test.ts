/* eslint-disable @typescript-eslint/no-explicit-any -- AG-UI and OpenAI wire payloads are untyped JSON */
// Gate 3 live Intelligence cases (LEAD_NOTES: Intelligence is AVAILABLE, so these are RUN, never hard-coded NOT_RUN):
//   L1  one incident-Dot turn through /api/copilotkit: the ledger holds a ModelCallRecord with provider.mode
//       'live' and the model's edit_space_page call is refused with a visible error, the page unchanged;
//   L2  TOOL_COVERAGE M5: POST /api/conversations/:id/page saves a persisted Intelligence conversation and the
//       page revision reaches the ledger;
//   L3  TOOL_COVERAGE M14: a scheduled turn of the incident Dot runs through the same middleware and is refused
//       the same way.
//
// Honest labels: Intelligence (conversation store, AG-UI runtime) is REAL; the model behind OPENAI_BASE_URL is the
// verifier's scripted provider (g4-autonomy/provider.ts) so that the edit attempt is deterministic. This proves
// server-side enforcement on the real Dot path, not what a real Nemotron would choose (gate 4 and gate 5 cover live
// Nemotron). Without the Intelligence key the cases FAIL with "BLOCKED: ..." (neither PASS nor skipped).
//
// Ports (the g4 block, files run one at a time): checkout 4680, app 4681, provider 4683.
// Two boots share one OpenDots SQLite file: boot 1 creates the incident Dot (its id is random), boot 2 lists the id in
// NEMODOTS_INCIDENT_DOT_IDS, as TOOL_COVERAGE section 6 prescribes.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { G4, requireIntelligence } from '../g4-autonomy/config.js';
import { startProvider, type Provider } from '../g4-autonomy/provider.js';
import { startSystem, type System } from '../g4-autonomy/system.js';
import { REFUSAL, SCRATCH } from './g3-support.js';

const MODEL = 'acc3-live-model';
const EDIT_MARKER = /ACC3-EDIT ([0-9a-f-]{36})/;

interface Live {
  provider: Provider;
  system: System;
  dotId: string;
  spaceId: string;
  pageId: string;
  threadId: string;
  dir: string;
}

let memo: Promise<Live> | null = null;

async function json(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}
const post = (base: string, path: string, body: unknown) =>
  json(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function boot(): Promise<Live> {
  requireIntelligence();
  const dir = join(SCRATCH, `live-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const sqlite = join(dir, 'opendots.sqlite');
  const provider = await startProvider({
    port: G4.providerPort,
    model: MODEL,
    script: (call) => {
      const messages: any[] = call.body.messages ?? [];
      const lastUser = messages.map((m) => m.role).lastIndexOf('user');
      const prompt = textOf(messages[lastUser]);
      const marker = EDIT_MARKER.exec(prompt);
      if (!marker || call.kind !== 'worker') return { type: 'content', text: 'ok' };
      // only tool results of THIS turn (history of earlier turns is replayed by Intelligence)
      if (messages.slice(lastUser + 1).some((m) => m.role === 'tool'))
        return { type: 'content', text: 'The edit was refused.' };
      return {
        type: 'tool_calls',
        calls: [
          {
            name: 'edit_space_page',
            args: { id: marker[1], content: 'LIVE-EDIT', expectedRevision: 1 },
          },
        ],
      };
    },
  });
  let first: System | null = null;
  try {
    first = await startSystem({
      providerUrl: provider.url,
      providerModel: MODEL,
      intelligence: true,
      env: { DATABASE_PATH: sqlite },
    });
    const workspace = await json(first.baseUrl, '/api/workspace');
    expect(workspace.status, 'GET /api/workspace').toBe(200);
    const spaceId: string = workspace.body.dots[0].spaceId;
    const created = await post(first.baseUrl, '/api/dots', {
      name: 'Acc3 live incident',
      instructions: 'Investigate incidents and report.',
      researchAllowed: false,
      memoryAllowed: false,
      appsAllowed: false,
      spaceId,
      spaceIds: [spaceId],
    });
    expect(created.status, 'POST /api/dots').toBe(201);
    const dotId: string = created.body.id;
    await first.stop();
    first = null;
    const system = await startSystem({
      providerUrl: provider.url,
      providerModel: MODEL,
      intelligence: true,
      env: { DATABASE_PATH: sqlite, NEMODOTS_INCIDENT_DOT_IDS: dotId },
    });
    const page = await post(system.baseUrl, `/api/spaces/${spaceId}/pages`, {
      title: 'Acc3 live page',
      content: 'LIVE-ORIGINAL',
    });
    expect(page.status, 'create page').toBe(201);
    const conversation = await post(system.baseUrl, '/api/conversations', {
      dotId,
      title: 'Acc3 live conversation',
    });
    expect(conversation.status, 'create conversation').toBe(201);
    return {
      provider,
      system,
      dotId,
      spaceId,
      pageId: page.body.id,
      threadId: conversation.body.id,
      dir,
    };
  } catch (error) {
    await first?.stop().catch(() => undefined);
    await provider.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
const live = () => (memo ??= boot());

function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
}

afterAll(async () => {
  if (!memo) return;
  const started = await memo.catch(() => null);
  if (!started) return;
  await started.system.stop().catch(() => undefined);
  await started.provider.close().catch(() => undefined);
  rmSync(started.dir, { recursive: true, force: true });
}, 180_000);

async function runTurn(l: Live, prompt: string) {
  const response = await fetch(
    `${l.system.baseUrl}/api/copilotkit/agent/${encodeURIComponent(l.dotId)}/run`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId: l.threadId,
        runId: randomUUID(),
        state: {},
        messages: [{ id: randomUUID(), role: 'user', content: prompt }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    },
  );
  if (!response.ok)
    throw new Error(`run -> HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body!.getReader();
  const deadline = Date.now() + 240_000;
  let terminal = 'none';
  while (Date.now() < deadline && terminal === 'none') {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        events.push(event);
        if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') terminal = event.type;
      } catch {
        /* non-JSON frame */
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return { events, terminal };
}

/** Tool messages of the CURRENT turn (after the last user message) in calls whose last user message contains `marker`. */
function toolMessagesFor(provider: Provider, marker: string): string[] {
  const out: string[] = [];
  for (const call of provider.calls) {
    const messages: any[] = call.body.messages ?? [];
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    if (!textOf(messages[lastUser]).includes(marker)) continue;
    for (const message of messages.slice(lastUser + 1))
      if (message.role === 'tool') out.push(textOf(message));
  }
  return out;
}

async function pageOf(l: Live) {
  const response = await json(l.system.baseUrl, `/api/spaces/${l.spaceId}/pages/${l.pageId}`);
  expect(response.status).toBe(200);
  return response.body as { revision: number; content: string };
}

describe('LIVE Intelligence: the incident-Dot path with the real conversation store', () => {
  it('[TP3.1][TP3.3][R1][M2] L1: one incident-Dot turn through /api/copilotkit records a live-mode ModelCallRecord and refuses edit_space_page visibly, leaving the page unchanged', async () => {
    const l = await live();
    const marker = `ACC3-EDIT ${l.pageId}`;
    const turn = await runTurn(l, `${marker}: replace the page content with LIVE-EDIT`);
    expect(turn.terminal, 'the turn finished without RUN_ERROR').toBe('RUN_FINISHED');
    const attempted = turn.events.some(
      (event) =>
        event.type === 'TOOL_CALL_START' &&
        (event.toolCallName ?? event.name) === 'edit_space_page',
    );
    expect(attempted, 'the model attempted edit_space_page').toBe(true);
    const seen = toolMessagesFor(l.provider, marker);
    expect(seen.length, 'the model received a tool result for the edit').toBeGreaterThan(0);
    expect(seen.join('\n'), 'a visible refusal').toMatch(REFUSAL);
    expect(await pageOf(l)).toMatchObject({ revision: 1, content: 'LIVE-ORIGINAL' });

    const rows = await l.system.verifier.query(
      `SELECT provider_mode, count(*)::int AS n FROM ledger.model_call_records GROUP BY provider_mode ORDER BY provider_mode`,
    );
    const live = rows.rows.find((row: any) => row.provider_mode === 'live');
    expect(live?.n ?? 0, "ModelCallRecord with provider.mode 'live'").toBeGreaterThanOrEqual(1);
    const telemetry = await json(l.system.baseUrl, '/api/nemodots/telemetry/summary');
    expect(telemetry.status).toBe(200);
    expect(telemetry.body.calls).toBeGreaterThanOrEqual(1);
  }, 400_000);

  it('[TP3.1][M5] L2: POST /api/conversations/:id/page saves the persisted conversation and the page revision reaches the ledger', async () => {
    const l = await live();
    const saved = await post(l.system.baseUrl, `/api/conversations/${l.threadId}/page`, {
      title: 'Saved conversation',
      parentId: null,
    });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(201);
    const id: string = saved.body.id;
    const rows = await l.system.verifier.query(
      `SELECT r.source_revision, s.source_type FROM ledger.source_revisions r JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1 ORDER BY r.source_revision`,
      [`opendots.page/${id}`],
    );
    expect(
      rows.rows.map((row: any) => [Number(row.source_revision), row.source_type]),
      'the saved page is revision 1 of a page_snapshot source',
    ).toEqual([[1, 'page_snapshot']]);
  }, 400_000);

  it('[TP3.1][M14][R15] L3: a scheduled turn of the incident Dot goes through the same middleware and its edit_space_page is refused', async () => {
    const l = await live();
    const marker = `ACC3-EDIT ${l.pageId} scheduled`;
    const before = l.provider.calls.length;
    const created = await post(l.system.baseUrl, '/api/tasks', {
      prompt: `${marker}: replace the page content with LIVE-EDIT`,
      threadId: l.threadId,
    });
    expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(201);
    const run = await post(l.system.baseUrl, `/api/tasks/${created.body.id}/actions`, {
      action: 'run',
    });
    expect(run.status).toBe(200);
    const deadline = Date.now() + 180_000;
    let seen: string[] = [];
    while (Date.now() < deadline) {
      seen = toolMessagesFor(l.provider, marker);
      if (seen.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(l.provider.calls.length, 'the scheduled turn called the model').toBeGreaterThan(before);
    expect(seen.length, 'the scheduled turn reached its tool result').toBeGreaterThan(0);
    expect(seen.join('\n')).toMatch(REFUSAL);
    expect(await pageOf(l)).toMatchObject({ revision: 1, content: 'LIVE-ORIGINAL' });
  }, 400_000);
});
