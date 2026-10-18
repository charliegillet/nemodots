// Live W3.3 check: one incident Dot, one real conversation turn through
// /api/copilotkit with the Crusoe model. Needs the CopilotKit Intelligence key
// and the Crusoe OPENAI_* values; without them it prints BLOCKED and FAILS
// (it never skips). In-process app, no port is opened; at most one model call
// is in flight at a time.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Store } from '../../../../src/server/store.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import { Platform } from '../../../../src/server/platform.js';
import { Runner } from '../../../../src/server/runner.js';
import { createApp } from '../../../../src/server/app.js';
import { intelligenceApiKeyFromEnv } from '../../../../src/server/platform-config.js';
import {
  INCIDENT_ENV,
  resetInterception,
  setInterceptionHooks,
} from '../../../../src/server/nemodots/interception/index.js';
import type {
  AttemptId,
  MissionId,
  ModelCallRecord,
  TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
];

const SECRET_NAMES = [
  'OPENAI_API_KEY',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
];

function loadDotEnv() {
  const file = join(APP_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !NAMES.includes(match[1])) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const checks: Record<string, unknown>[] = [];
let blocked: string | null = null;

function writeResults(status: 'PASS' | 'FAIL' | 'BLOCKED') {
  const dir = join(
    APP_ROOT,
    '.local',
    process.env.NEMODOTS_INSTANCE ?? 'dev',
    'live',
  );
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(
    {
      suite: 'interception-live',
      at: new Date().toISOString(),
      status,
      blocked,
      checks,
    },
    null,
    2,
  )}\n`;
  for (const name of SECRET_NAMES) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 6 && text.includes(value))
      throw new Error('secret found in live results; file not written');
  }
  writeFileSync(join(dir, 'interception.json'), text, { mode: 0o600 });
}

let failed = false;
afterAll(() => {
  resetInterception();
  delete process.env[INCIDENT_ENV];
  writeResults(blocked ? 'BLOCKED' : failed ? 'FAIL' : 'PASS');
});

beforeAll(() => {
  loadDotEnv();
  const missing = [
    ...(process.env.OPENAI_API_KEY?.trim() ? [] : ['OPENAI_API_KEY']),
    ...(process.env.OPENAI_BASE_URL?.trim() ? [] : ['OPENAI_BASE_URL']),
    ...(process.env.OPENAI_MODEL?.trim() ? [] : ['OPENAI_MODEL']),
    ...(intelligenceApiKeyFromEnv(process.env)
      ? []
      : ['CPK_INTELLIGENCE_API_KEY']),
  ];
  if (missing.length) {
    blocked = `BLOCKED: ${missing.join(', ')} missing`;
    console.error(blocked);
    throw new Error(blocked);
  }
});

it('an incident Dot turn records a live ModelCallRecord and its page edit is refused', async () => {
  failed = true;
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const baseUrl = process.env.OPENAI_BASE_URL!.trim();
    const model = process.env.OPENAI_MODEL!.trim();
    const config = {
      mode: 'live' as const,
      apiKey: process.env.OPENAI_API_KEY!.trim(),
      model,
      baseUrl,
      intelligenceKey: intelligenceApiKeyFromEnv(process.env),
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    };
    const platform = new Platform(store, workspace, config);
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
    });
    const json = (body: unknown, method = 'POST') => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // 1. Create the Dot through the owner API.
    const space = workspace.spaces()[0];
    const created = await app.request(
      '/api/dots',
      json({
        name: 'Incident editor',
        instructions:
          'You edit pages when asked. Always call the edit_space_page tool.',
        researchAllowed: false,
        memoryAllowed: false,
        spaceId: space.id,
      }),
    );
    expect(created.status).toBe(201);
    const dot = (await created.json()) as { id: string };

    // 2. List it as an incident Dot and install the recording sink.
    process.env[INCIDENT_ENV] = dot.id;
    const records: ModelCallRecord[] = [];
    setInterceptionHooks({
      providerMode: 'live',
      sink: {
        identify: () => ({
          scope: {
            ownerId: 'owner',
            missionId: randomUUID() as MissionId,
            spaceId: null,
            environment: 'test',
            resource: 'checkout',
          },
          taskId: randomUUID() as TaskId,
          attemptId: randomUUID() as AttemptId,
          role: 'worker',
        }),
        recordModelCall: (record) => void records.push(record),
      },
    });

    // 3. One conversation turn through /api/copilotkit.
    const conversation = await app.request(
      '/api/conversations',
      json({ dotId: dot.id, title: 'Interception live' }),
    );
    expect(conversation.status).toBe(201);
    const thread = (await conversation.json()) as { id: string };
    const page = workspace.pages.create(space.id, {
      title: 'Runbook',
      content: 'original',
      parentId: null,
    });
    const startedAt = Date.now();
    const run = await app.request(
      `/api/copilotkit/agent/${dot.id}/run`,
      json({
        threadId: thread.id,
        runId: randomUUID(),
        state: {},
        context: [],
        tools: [],
        forwardedProps: {},
        messages: [
          {
            id: randomUUID(),
            role: 'user',
            content: `Call edit_space_page now with id "${page.id}", spaceId "${space.id}", content "tampered" and expectedRevision ${page.revision}. Do not ask questions.`,
          },
        ],
      }),
    );
    expect(run.status).toBe(200);
    // Intelligence accepts the run and the agent executes in this process;
    // events travel over its realtime channel, so observe the turn through the
    // recording sink and the persisted thread messages instead of the response.
    const ack = (await run.json()) as { runId?: string };
    expect(ack.runId).toBeTruthy();
    const deadline = Date.now() + 90_000;
    while (
      Date.now() < deadline &&
      !records.some((record) => record.outcome === 'completed')
    )
      await new Promise((resolve) => setTimeout(resolve, 500));
    const elapsedMs = Date.now() - startedAt;
    const history = await app.request(
      `/api/copilotkit/threads/${thread.id}/messages`,
    );
    const historyText = history.ok ? await history.text() : '';

    // 4. The edit was refused and the page is untouched.
    expect(
      records.some((record) =>
        record.toolCalls.some((call) => call.name === 'edit_space_page'),
      ),
    ).toBe(true);
    expect(workspace.pages.get(space.id, page.id)).toMatchObject({
      content: 'original',
      revision: page.revision,
    });
    expect(historyText).toContain('not available in the incident scope');

    // 5. The provider exchange was recorded as live, against the configured host.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.provider).toEqual({
        host: new URL(baseUrl).host,
        mode: 'live',
      });
      expect(record.model.requested).toBe(model);
      expect(record.attempts[0].httpStatus).toBe(200);
    }
    checks.push({
      name: 'incident Dot turn',
      status: 'PASS',
      elapsedMs,
      modelCalls: records.map((record) => ({
        outcome: record.outcome,
        modelReturned: record.model.returned,
        provider: record.provider,
        attempts: record.attempts.map((attempt) => ({
          httpStatus: attempt.httpStatus,
          startedAt: attempt.startedAt,
          headersAt: attempt.headersAt,
          firstContentAt: attempt.firstContentAt,
          finishedAt: attempt.finishedAt,
          finishReason: attempt.finishReason,
          usage: attempt.usage,
        })),
        toolCalls: record.toolCalls.map((call) => call.name),
      })),
      editRefused: true,
      pageUnchanged: true,
    });
    failed = false;
  } finally {
    await platform_stop(store, workspace);
  }
});

async function platform_stop(store: Store, workspace: WorkspaceStore) {
  store.close();
  workspace.close();
}
