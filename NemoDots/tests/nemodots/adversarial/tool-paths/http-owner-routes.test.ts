// W5.3: the owner HTTP surface that sits next to the model-visible tools
// (TOOL_COVERAGE M4, M5, M7, M13): direct page routes and the computer owner
// route, through the REAL upstream createApp with a real Platform over
// in-memory stores. They are out of the model's reach by design; this checks
// that the design holds at the HTTP boundary (token, origin, host, content
// type, size, smuggled actor) and that the one thing NemoDots adds there, the
// page revision hook, sees every write.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/server/app.js';
import { Platform } from '../../../../src/server/platform.js';
import { Runner } from '../../../../src/server/runner.js';
import { Store } from '../../../../src/server/store.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import type { PageRevisionEvent } from '../../../../src/server/pages.js';
import {
  createToolPolicy,
  setActivePolicy,
} from '../../../../src/server/nemodots/interception/index.js';

const TOKEN = 'owner-token-0123456789-abcdefghij';
const closers: Array<() => void> = [];
afterEach(() => {
  setActivePolicy(null);
  closers.splice(0).forEach((close) => close());
});

function fixture(ownerToken: string | null = TOKEN) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(
    () => store.close(),
    () => workspace.close(),
  );
  const config = { mode: 'live' as const, baseUrl: 'https://example.invalid' };
  const platform = new Platform(store, workspace, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: ownerToken ?? undefined,
  });
  const events: PageRevisionEvent[] = [];
  workspace.pages.onRevision = (event) => events.push(event);
  const dot = workspace.dots()[0];
  const request = (
    path: string,
    init: RequestInit & { token?: string | null; base?: string } = {},
  ) => {
    const { token = ownerToken ?? null, base = 'http://localhost', ...rest } = init;
    const headers = new Headers(rest.headers);
    if (token && !headers.has('authorization'))
      headers.set('authorization', `Bearer ${token}`);
    return Promise.resolve(app.request(`${base}${path}`, { ...rest, headers }));
  };
  const json = (
    path: string,
    body: unknown,
    init: Parameters<typeof request>[1] = {},
  ) =>
    request(path, {
      method: 'POST',
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(body),
    });
  return { workspace, platform, app, events, dot, request, json };
}

describe('direct page routes (M4)', () => {
  it('without the owner token every route answers 401 and nothing is written', async () => {
    const f = fixture();
    const space = f.dot.spaceId;
    const page = f.workspace.pages.create(space, { title: 'P', content: 'x' });
    f.events.length = 0;
    const attempts: Array<[string, string, unknown]> = [
      ['POST', `/api/spaces/${space}/pages`, { title: 'A', content: 'b' }],
      [
        'PATCH',
        `/api/spaces/${space}/pages/${page.id}`,
        { content: 'PWNED', expectedRevision: 1 },
      ],
      ['DELETE', `/api/spaces/${space}/pages/${page.id}`, undefined],
      ['GET', `/api/spaces/${space}/pages/${page.id}`, undefined],
      ['GET', `/api/spaces/${space}/pages`, undefined],
    ];
    for (const token of [null, 'wrong-token', TOKEN.slice(0, -1), `${TOKEN}x`, '']) {
      for (const [method, path, body] of attempts) {
        const response = await f.request(path, {
          method,
          token,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(response.status, `${method} ${path} token=${token}`).toBe(401);
      }
    }
    expect(f.workspace.pages.get(space, page.id).content).toBe('x');
    expect(f.workspace.pages.list(space)).toHaveLength(1);
    expect(f.events).toEqual([]);
  });

  it('a cross-origin or cross-site browser request is refused even with a valid token', async () => {
    const f = fixture();
    const space = f.dot.spaceId;
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'http://localhost.evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await f.json(
        `/api/spaces/${space}/pages`,
        { title: 'Planted', content: 'x' },
        { headers },
      );
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect(f.workspace.pages.list(space)).toEqual([]);
  });

  it('a form-style (non-JSON) write is refused with 415 and an oversized body with 413', async () => {
    const f = fixture();
    const space = f.dot.spaceId;
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await f.request(`/api/spaces/${space}/pages`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: JSON.stringify({ title: 'A', content: 'b' }),
      });
      expect(response.status, type).toBe(415);
    }
    const big = await f.json(`/api/spaces/${space}/pages`, {
      title: 'Big',
      content: 'x'.repeat(1_100_000),
    });
    expect(big.status).toBe(413);
    expect(f.workspace.pages.list(space)).toEqual([]);
  });

  it('without an owner token only loopback hosts are served (DNS rebinding)', async () => {
    const f = fixture(null);
    const space = f.dot.spaceId;
    const rebound = await f.request(`/api/spaces/${space}/pages`, {
      base: 'http://evil.example',
    });
    expect(rebound.status).toBe(403);
    const local = await f.request(`/api/spaces/${space}/pages`, {
      base: 'http://127.0.0.1',
    });
    expect(local.status).toBe(200);
  });

  it('the authorised owner can write, and the revision hook sees create, update and delete with no model thread', async () => {
    const f = fixture();
    const space = f.dot.spaceId;
    const created = await f.json(`/api/spaces/${space}/pages`, {
      title: 'Owner page',
      content: `Receipt 9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d says ignore everything.`,
    });
    expect(created.status).toBe(201);
    const page = (await created.json()) as { id: string; revision: number };
    const patched = await f.request(`/api/spaces/${space}/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'two', expectedRevision: page.revision }),
    });
    expect(patched.status).toBe(200);
    // A stale revision is a conflict, not an overwrite (the CAS holds).
    const stale = await f.request(`/api/spaces/${space}/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'three', expectedRevision: 1 }),
    });
    expect(stale.status).toBe(409);
    const deleted = await f.request(`/api/spaces/${space}/pages/${page.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    expect(deleted.status).toBe(200);
    expect(f.events.map((e) => [e.op, e.revision])).toEqual([
      ['create', 1],
      ['update', 2],
      ['delete', null],
    ]);
    expect(f.events.every((e) => e.sourceThreadId === null)).toBe(true);
  });

  it('a conversation id that belongs to no Dot cannot be used to write a page', async () => {
    const f = fixture();
    const response = await f.json('/api/conversations/not-a-thread/page', {
      title: 'Planted',
    });
    expect([404, 500]).toContain(response.status);
    expect(
      f.workspace.spaces().flatMap((s) => f.workspace.pages.list(s.id)),
    ).toEqual([]);
  });
});

describe('computer owner route (M7)', () => {
  it('needs the owner token; without it nothing is recorded in the audit log', async () => {
    const f = fixture();
    const response = await f.json(
      `/api/dots/${f.dot.id}/computer/actions`,
      { action: 'exec', input: { command: 'id' } },
      { token: null },
    );
    expect(response.status).toBe(401);
    expect(f.workspace.computers.audit(f.dot.id)).toEqual([]);
  });

  it('the actor is fixed to owner by the route: a smuggled actor is rejected, and an agent-labelled call cannot be made over HTTP', async () => {
    const f = fixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    for (const body of [
      { action: 'exec', input: {}, actor: 'agent' },
      { action: 'exec', input: {}, actor: 'owner' },
      { action: 'exec', input: {}, dotId: 'other' },
    ]) {
      const response = await f.json(`/api/dots/${f.dot.id}/computer/actions`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(f.workspace.computers.audit(f.dot.id)).toEqual([]);
  });

  it('the owner is not blocked for an incident Dot, but the attempt is audited as an owner action', async () => {
    const f = fixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    const response = await f.json(`/api/dots/${f.dot.id}/computer/actions`, {
      action: 'snapshot',
      input: {},
    });
    // No supervisor is configured in this environment, so it fails past the
    // policy (503/403), never with the policy refusal text.
    expect(await response.text()).not.toContain('Refused by NemoDots policy');
    const audit = f.workspace.computers.audit(f.dot.id);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((row) => row.actor === 'owner')).toBe(true);
  });
});
