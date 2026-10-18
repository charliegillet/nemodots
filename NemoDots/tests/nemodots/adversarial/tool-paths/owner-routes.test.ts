// W5.3: the upstream owner surfaces (TOOL_COVERAGE M3, M4, M7, M13) served by
// createApp with a real Platform. They are outside the model's reach by
// design; the hypotheses are that (a) nothing is reachable without the owner
// token, (b) owner page writes still feed the NemoDots page hook
// (instrumented), (c) the computer owner route is not mistaken for an agent
// action, and (d) the reviewed-page route for an incident Dot creates nothing
// without the owner's explicit request.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/server/app.js';
import { Platform } from '../../../../src/server/platform.js';
import { Runner } from '../../../../src/server/runner.js';
import { Store } from '../../../../src/server/store.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import {
  INCIDENT_ENV,
  resetInterception,
  setInterceptionHooks,
  type PageRevisionEvent,
} from '../../../../src/server/nemodots/interception/index.js';
import { baseConfig } from './support.js';

const TOKEN = 'adversary-owner-token-0123456789';
const open: { close(): void }[] = [];
afterEach(() => {
  delete process.env[INCIDENT_ENV];
  resetInterception();
  open.splice(0).forEach((db) => db.close());
});

function surface(options: { incident?: boolean } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  open.push(store, workspace);
  const config = baseConfig({
    intelligenceKey: undefined,
    computerSupervisorUrl: 'https://supervisor.adversary.invalid',
    computerSupervisorToken: 'adversary-supervisor',
  });
  const platform = new Platform(store, workspace, config);
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'live', baseUrl: config.baseUrl }),
    config: { mode: 'live', baseUrl: config.baseUrl },
    platform,
    ownerToken: TOKEN,
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('owner-thread', dot.id, 'Owner');
  if (options.incident) process.env[INCIDENT_ENV] = dot.id;
  const call = (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    const token = init.token === undefined ? TOKEN : init.token;
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    // upstream requires application/json on every non-GET request
    if (init.method && init.method !== 'GET')
      headers.set('content-type', 'application/json');
    return Promise.resolve(
      app.request(`http://localhost${path}`, { ...init, headers }),
    );
  };
  return { store, workspace, dot, call, spaceId: dot.spaceId };
}

describe('owner surfaces need the owner token', () => {
  it('TP-80 page, conversation, connection, computer and Dot routes all answer 401 without it', async () => {
    const s = surface({ incident: true });
    const page = s.workspace.pages.create(s.spaceId, {
      title: 'P',
      content: 'x',
      parentId: null,
    });
    const routes: [string, string, unknown?][] = [
      ['GET', `/api/spaces/${s.spaceId}/pages`],
      ['POST', `/api/spaces/${s.spaceId}/pages`, { title: 'T', content: 'c' }],
      [
        'PATCH',
        `/api/spaces/${s.spaceId}/pages/${page.id}`,
        { content: 'c', expectedRevision: 1 },
      ],
      ['DELETE', `/api/spaces/${s.spaceId}/pages/${page.id}`],
      [
        'POST',
        '/api/conversations/owner-thread/reviewed-page',
        { toolCallId: 't', title: 'T', content: 'c', spaceId: s.spaceId },
      ],
      ['POST', '/api/conversations/owner-thread/page', { spaceId: s.spaceId }],
      [
        'POST',
        '/api/conversations/owner-thread/connection-actions',
        { toolCallId: 't', approvalId: 'a' },
      ],
      [
        'POST',
        `/api/dots/${s.dot.id}/connections`,
        { name: 'x', url: 'https://x.example/mcp' },
      ],
      [
        'POST',
        `/api/dots/${s.dot.id}/computer/actions`,
        { action: 'exec', input: {} },
      ],
      ['PATCH', `/api/dots/${s.dot.id}/computer/permissions`, {}],
      ['PUT', `/api/dots/${s.dot.id}`, {}],
      ['POST', '/api/dots', {}],
    ];
    for (const [method, path, body] of routes) {
      const response = await s.call(path, {
        method,
        token: null,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(s.workspace.pages.get(s.spaceId, page.id).content).toBe('x');
  });
});

describe('owner page writes stay instrumented (M4/M3)', () => {
  it('TP-81 create, update and delete through the owner routes each emit a page revision', async () => {
    const s = surface({ incident: true });
    const events: PageRevisionEvent[] = [];
    setInterceptionHooks({ pageRevision: (event) => void events.push(event) });
    const created = await s.call(`/api/spaces/${s.spaceId}/pages`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Owner page', content: 'a' }),
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; revision: number };
    await s.call(`/api/spaces/${s.spaceId}/pages/${page.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'b', expectedRevision: page.revision }),
    });
    await s.call(`/api/spaces/${s.spaceId}/pages/${page.id}`, {
      method: 'DELETE',
    });
    expect(events.map((e) => [e.kind, e.pageId])).toEqual([
      ['create', page.id],
      ['update', page.id],
      ['delete', page.id],
    ]);
  });

  it('TP-82 the reviewed-page route for an incident Dot thread is owner-mediated and instrumented', async () => {
    const s = surface({ incident: true });
    const events: PageRevisionEvent[] = [];
    setInterceptionHooks({ pageRevision: (event) => void events.push(event) });
    const response = await s.call(
      '/api/conversations/owner-thread/reviewed-page',
      {
        method: 'POST',
        body: JSON.stringify({
          toolCallId: 'review-1',
          title: 'Reviewed',
          content: 'approved by the owner',
          spaceId: s.spaceId,
        }),
      },
    );
    expect(response.status).toBe(201);
    expect(events.map((e) => e.kind)).toEqual(['create']);
    // Replaying the same toolCallId with a different draft cannot write again.
    const replay = await s.call(
      '/api/conversations/owner-thread/reviewed-page',
      {
        method: 'POST',
        body: JSON.stringify({
          toolCallId: 'review-1',
          title: 'Reviewed (tampered)',
          content: 'different',
          spaceId: s.spaceId,
        }),
      },
    );
    expect(replay.status).not.toBe(201);
    expect(
      s.workspace.pages
        .list(s.spaceId)
        .filter((p) => p.title.startsWith('Reviewed')),
    ).toHaveLength(1);
  });
});

describe('computer owner route (M7)', () => {
  it('TP-83 an owner computer action for an incident Dot is not refused as an agent action', async () => {
    const s = surface({ incident: true });
    const response = await s.call(`/api/dots/${s.dot.id}/computer/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'screenshot', input: {} }),
    });
    const body = (await response.json()) as { error?: string };
    expect(body.error ?? '').not.toMatch(/incident agents/);
  });
});
