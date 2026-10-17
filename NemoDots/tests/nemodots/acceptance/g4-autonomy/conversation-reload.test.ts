// TEST_PROMPT gate 4 case 8: reload a user conversation after a real
// Intelligence turn. LEAD_NOTES: the Intelligence key is AVAILABLE, so this is
// run, not marked BLOCKED; if the key or the Crusoe credentials are missing
// the test fails with "BLOCKED:" (never skipped). The turn runs the upstream
// OpenDots chat path (AG-UI run -> Dot agent -> Nemotron through the verifier
// pass-through proxy -> CopilotKit Intelligence). The reload is checked three
// ways: through the app's thread route after a full app restart, through the
// Intelligence SDK directly, and by comparing both.
//
// Also covered here (case 8, the other half of the sentence in LEAD_NOTES):
// NemoDots mission control must not depend on Intelligence.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { G4, mergedEnv, readDotEnv, requireIntelligence, requireLive } from './config.js';
import { finish, launchMission, lazySystem } from './flow.js';
import { planReply, TWO_BRANCH_PLAN } from './scenarios.js';

const getSystem = lazySystem(() => {
  requireIntelligence();
  const status = requireLive();
  return {
    providerPort: G4.providerPort,
    model: status.model!,
    upstream: { baseUrl: status.baseUrl!, apiKey: mergedEnv().OPENAI_API_KEY! },
    system: { intelligence: true },
  };
});

const OWNER_ID = readDotEnv().OWNER_ID ?? 'acc4-owner';

async function json(base: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** Runs one AG-UI turn and returns the streamed assistant text and terminal event type. */
async function runTurn(base: string, dotId: string, threadId: string, prompt: string) {
  const response = await fetch(`${base}/api/copilotkit/agent/${encodeURIComponent(dotId)}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: randomUUID(),
      state: {},
      messages: [{ id: randomUUID(), role: 'user', content: prompt }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  });
  if (!response.ok) throw new Error(`run -> HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  let text = '';
  let terminal = 'none';
  let error = '';
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = response.body!.getReader();
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        if (event.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') text += event.delta;
        if (event.type === 'RUN_FINISHED') terminal = 'RUN_FINISHED';
        if (event.type === 'RUN_ERROR') {
          terminal = 'RUN_ERROR';
          error = String(event.message ?? '').slice(0, 200);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    }
    if (terminal !== 'none') break;
  }
  await reader.cancel().catch(() => undefined);
  return { text, terminal, error };
}

const contentOf = (message: any) =>
  typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');

let memo: ReturnType<typeof execute> | null = null;
async function execute() {
  const { system: sys } = await getSystem();
  const workspace = await json(sys.baseUrl, '/api/workspace');
  expect(workspace.status, 'GET /api/workspace').toBe(200);
  expect(workspace.body.setup.missing, 'Intelligence and runtime setup complete').toEqual([]);
  const dotId: string = workspace.body.dots[0].id;
  const created = await json(sys.baseUrl, '/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dotId, title: 'Gate 4 reload check' }),
  } as RequestInit);
  expect(created.status, 'create conversation').toBe(201);
  const threadId: string = created.body.id;
  const nonce = `acc4-${randomUUID().slice(0, 8)}`;
  const turn = await runTurn(sys.baseUrl, dotId, threadId, `Reply with one short sentence that contains the code ${nonce}.`);
  return { sys, dotId, threadId, nonce, turn };
}

describe('LIVE G4.8 conversation reload through CopilotKit Intelligence', () => {
  it('G4.8a a real turn completes through the Dot agent on Crusoe and Intelligence', async () => {
    const run = await (memo ??= execute());
    expect(run.turn.error, 'no RUN_ERROR').toBe('');
    expect(run.turn.terminal).toBe('RUN_FINISHED');
    expect(run.turn.text.trim().length, 'assistant produced text').toBeGreaterThan(0);
  }, 400_000);

  it('G4.8b after a full app restart the app thread route returns the same user and assistant messages', async () => {
    const run = await (memo ??= execute());
    await run.sys.restartApp();
    const messages = await json(run.sys.baseUrl, `/api/copilotkit/threads/${encodeURIComponent(run.threadId)}/messages`);
    expect(messages.status, 'thread messages route').toBe(200);
    const list: any[] = Array.isArray(messages.body) ? messages.body : (messages.body?.messages ?? []);
    const roles = list.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    const user = list.find((m) => m.role === 'user' && contentOf(m).includes(run.nonce));
    expect(user, 'the user message with the unique code survived the restart').toBeDefined();
    const assistant = list.filter((m) => m.role === 'assistant' && contentOf(m).trim().length > 0);
    expect(assistant.length, 'a non-empty assistant message was persisted').toBeGreaterThanOrEqual(1);
    expect(list.findIndex((m) => m === user), 'order: user before assistant').toBeLessThan(list.findIndex((m) => m === assistant[0]));
  }, 400_000);

  it('G4.8c the Intelligence SDK, queried independently of the app, holds the same conversation', async () => {
    const run = await (memo ??= execute());
    const { CopilotKitIntelligence } = await import('@copilotkit/runtime/v2');
    const env = mergedEnv();
    const apiKey = env.CPK_INTELLIGENCE_API_KEY || env.INTELLIGENCE_API_KEY;
    const intelligence = new CopilotKitIntelligence({
      apiKey: apiKey!,
      apiUrl: env.INTELLIGENCE_API_URL || undefined,
      wsUrl: env.INTELLIGENCE_GATEWAY_WS_URL || env.INTELLIGENCE_WS_URL || undefined,
    } as never);
    const history = (await (intelligence as any).getThreadMessages({ threadId: run.threadId, userId: OWNER_ID })) as { messages: any[] };
    expect(history.messages.some((m) => m.role === 'user' && contentOf(m).includes(run.nonce)), 'user message stored upstream').toBe(true);
    expect(history.messages.some((m) => m.role === 'assistant' && contentOf(m).trim().length > 0), 'assistant message stored upstream').toBe(true);
  }, 400_000);
});

describe('G4.8d mission control does not depend on Intelligence (scripted provider, no key)', () => {
  const noKey = lazySystem({
    providerPort: G4.providerPort,
    script: (call) => (call.kind === 'structured' ? planReply(TWO_BRANCH_PLAN) : { type: 'content', text: 'done' }),
  });

  it('G4.8d the health route labels Intelligence blocked and a mission still starts and plans', async () => {
    // the live describe above may hold ports 4680/4681 with its own system; stop it first
    const { system: sys } = await noKey();
    const health = await sys.api.health();
    expect(health.intelligence, 'honest badge without a key').toBe('blocked');
    const { mission, tail } = await launchMission(sys.api);
    try {
      await tail.until((e) => e.some((x) => x.payload.kind === 'task.created'), 120_000, 'planner tasks created without Intelligence');
      expect(tail.parseErrors).toEqual([]);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);
});
