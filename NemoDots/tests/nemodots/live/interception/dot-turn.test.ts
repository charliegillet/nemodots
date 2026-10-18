import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/server/app.js';
import { Platform } from '../../../../src/server/platform.js';
import { Runner } from '../../../../src/server/runner.js';
import { Store } from '../../../../src/server/store.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import type { PlatformConfig } from '../../../../src/server/platform-config.js';
import {
  ContextSnapshotSchema,
  ModelCallRecordSchema,
  type ContextSnapshot,
  type ModelCallRecord,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  createToolPolicy,
  parseIncidentDotIds,
  setActivePolicy,
  setInterceptionRuntime,
  type ModelCallSinkTurn,
} from '../../../../src/server/nemodots/interception/index.js';

// W3.3 live proof (TOOL_COVERAGE.md section 6): with the CopilotKit
// Intelligence key and the Crusoe model, one incident Dot turn through
// /api/copilotkit records a ModelCallRecord with provider.mode='live' and the
// model's attempt to edit a page is refused. Nothing is mocked: the model is
// Nemotron on Crusoe, the conversation lives in hosted Intelligence.
//
// Never skips. Without the keys it prints BLOCKED and fails. No value from
// .env is printed or written; the results file holds ids, counts and digests.

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_URL',
  'INTELLIGENCE_GATEWAY_WS_URL',
  'INTELLIGENCE_WS_URL',
];

/** Fills only the names this suite needs from NemoDots/.env, only where undefined. */
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

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

// Only the credentials: the host and model name are meant to appear in results.
const SECRET_NAMES = [
  'OPENAI_API_KEY',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
];
const secrets = () =>
  SECRET_NAMES.map((name) => process.env[name]?.trim()).filter(
    (value): value is string => !!value && value.length >= 8,
  );

const closers: Array<() => Promise<void> | void> = [];
const recorded: Array<{
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
  info: ModelCallSinkTurn;
}> = [];

let app: ReturnType<typeof createApp>;
let platform: Platform;
let workspace: WorkspaceStore;
let baseUrl: string;
let model: string;

beforeAll(async () => {
  loadDotEnv();
  const intelligenceKey =
    process.env.CPK_INTELLIGENCE_API_KEY?.trim() ||
    process.env.INTELLIGENCE_API_KEY?.trim();
  const missing = [
    ['OPENAI_API_KEY', process.env.OPENAI_API_KEY],
    ['OPENAI_BASE_URL', process.env.OPENAI_BASE_URL],
    ['OPENAI_MODEL', process.env.OPENAI_MODEL],
    ['CPK_INTELLIGENCE_API_KEY', intelligenceKey],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    const message = `BLOCKED: ${missing.join(', ')} missing`;
    console.error(message);
    throw new Error(message);
  }
  baseUrl = process.env.OPENAI_BASE_URL!.trim();
  model = process.env.OPENAI_MODEL!.trim();

  const port = await freePort();
  const store = new Store(':memory:');
  workspace = new WorkspaceStore(':memory:', 'nemodots-live-interception');
  closers.push(
    () => store.close(),
    () => workspace.close(),
  );
  const config: PlatformConfig = {
    intelligenceKey,
    intelligenceApiUrl: process.env.INTELLIGENCE_API_URL?.trim() || undefined,
    intelligenceWsUrl:
      process.env.INTELLIGENCE_GATEWAY_WS_URL?.trim() ||
      process.env.INTELLIGENCE_WS_URL?.trim() ||
      undefined,
    apiKey: process.env.OPENAI_API_KEY!.trim(),
    model,
    baseUrl,
    agentRunTimeoutMs: 240_000,
    // Everything outside the incident scope stays off.
    webSearchProvider: 'disabled',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: `http://127.0.0.1:${port}/api/copilotkit`,
  };
  platform = new Platform(store, workspace, config);
  const researchConfig = {
    mode: 'live' as const,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    webSearchProvider: 'disabled' as const,
  };
  app = createApp({
    store,
    runner: new Runner(store, researchConfig),
    config: researchConfig,
    platform,
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (
          server as unknown as { closeAllConnections?: () => void }
        ).closeAllConnections?.();
      }),
  );

  // The policy reads the id list lazily, like bootstrap would from the env.
  setActivePolicy(
    createToolPolicy({
      incidentDotIds: () =>
        parseIncidentDotIds(process.env.NEMODOTS_INCIDENT_DOT_IDS),
    }),
  );
  setInterceptionRuntime({
    providerMode: 'live',
    recordModelCall: ({ record, snapshot }, info) => {
      recorded.push({ record, snapshot, info });
    },
    onError: (error, where) => {
      throw new Error(
        `interception ${where} failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    },
  });
}, 60_000);

afterAll(async () => {
  setActivePolicy(null);
  setInterceptionRuntime(null);
  delete process.env.NEMODOTS_INCIDENT_DOT_IDS;
  for (const close of closers.splice(0).reverse()) await close();
}, 60_000);

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('incident Dot turn through /api/copilotkit (live)', () => {
  it('records a live ModelCallRecord and refuses the model-requested page edit', async () => {
    // 1. A Dot created through the owner API, like any user would.
    const created = await app.request(
      '/api/dots',
      json({
        name: 'Incident Dot',
        instructions:
          'You maintain Markdown pages. When asked to edit a page you must call the edit_space_page tool; do not ask clarifying questions.',
        researchAllowed: false,
        memoryAllowed: false,
        spaceId: workspace.spaces()[0].id,
      }),
    );
    expect(created.status).toBe(201);
    const dot = (await created.json()) as { id: string; spaceId: string };

    // 2. Listed as an incident Dot, the way the operator would.
    process.env.NEMODOTS_INCIDENT_DOT_IDS = dot.id;

    // 3. A conversation in hosted Intelligence, attached to the page.
    const original = '# Runbook\nCache flushes need an approved action.';
    const page = workspace.pages.create(dot.spaceId, {
      title: 'Incident runbook',
      content: original,
    });
    const thread = await platform.createConversation(dot.id, 'W3.3 live');
    workspace.pages.reserveThread(page.id, dot.id, thread.id);
    workspace.pages.finishThread(page.id, dot.id);

    // 4. One real turn.
    const reply = await platform.turn(
      thread.id,
      `Call edit_space_page now for page id ${page.id} with expectedRevision ${page.revision} and content "TAMPERED BY THE MODEL". Make the tool call immediately.`,
      AbortSignal.timeout(240_000),
    );
    expect(typeof reply).toBe('string');

    // The edit did not happen.
    const after = workspace.pages.get(dot.spaceId, page.id);
    expect(after.revision).toBe(page.revision);
    expect(after.content).toBe(original);

    // Live model calls were recorded with their snapshots.
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    const host = new URL(baseUrl).host;
    for (const { record, snapshot } of recorded) {
      expect(ModelCallRecordSchema.safeParse(record).success).toBe(true);
      expect(ContextSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(record.provider).toEqual({ host, mode: 'live' });
      expect(record.model.requested).toBe(model);
      expect(record.model.returned).toEqual(expect.any(String));
      expect(record.attempts.at(-1)?.httpStatus).toBe(200);
      expect(record.attempts.at(-1)?.usage.promptTokens).toEqual(
        expect.any(Number),
      );
      expect(record.contextSnapshotId).toBe(snapshot.id);
      expect(snapshot.injected.pageSnapshots).toEqual([
        expect.objectContaining({ pageId: page.id, revision: 1 }),
      ]);
    }

    // The model asked for the edit and the policy refused it.
    const asked = recorded.filter(({ record }) =>
      record.toolCalls.some((call) => call.name === 'edit_space_page'),
    );
    expect(asked.length).toBeGreaterThanOrEqual(1);
    const refusals = recorded.flatMap(({ info }) => info.refusals);
    expect(refusals).toContainEqual(
      expect.objectContaining({
        toolName: 'edit_space_page',
        code: 'policy_checked_refused',
        layer: 'middleware',
      }),
    );
    expect(recorded.every(({ info }) => info.incident)).toBe(true);
    // No ledger is attached here, so the page evidence is reported as
    // unresolved rather than claimed as bound.
    expect(recorded[0].info.unresolved).toContain(`opendots.page/${page.id}`);

    // Redacted results: ids, counts, digests. Never content or keys.
    const summary = {
      suite: 'interception-dot-turn-live',
      at: new Date().toISOString(),
      status: 'PASS',
      host,
      modelRequested: model,
      modelReturned: recorded.at(-1)!.record.model.returned,
      modelCalls: recorded.map(({ record }) => ({
        outcome: record.outcome,
        providerMode: record.provider.mode,
        attempts: record.attempts.length,
        httpStatus: record.attempts.at(-1)?.httpStatus,
        usage: record.attempts.at(-1)?.usage,
        toolCalls: record.toolCalls.map((call) => call.name),
      })),
      refusals: recorded.at(-1)!.info.refusals,
      pageRevisionAfter: after.revision,
    };
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    for (const secret of secrets()) expect(text.includes(secret)).toBe(false);
    const dir = join(
      APP_ROOT,
      '.local',
      process.env.NEMODOTS_INSTANCE ?? 'dev',
      'live',
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'interception-dot-turn.json'), text, {
      mode: 0o600,
    });
  }, 300_000);
});
