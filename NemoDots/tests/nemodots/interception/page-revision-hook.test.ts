import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../src/server/store.js';
import { WorkspaceStore } from '../../../src/server/workspace.js';
import { PageService } from '../../../src/server/page-service.js';
import { Platform } from '../../../src/server/platform.js';
import { Runner } from '../../../src/server/runner.js';
import { createApp } from '../../../src/server/app.js';
import {
  setInterceptionHooks,
  type PageRevisionEvent,
} from '../../../src/server/nemodots/interception/index.js';
import {
  cleanup as resetState,
  fixture as agentFixture,
  text,
  toolCall,
} from './support.js';
import { lastValueFrom, toArray } from 'rxjs';

const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
  resetState();
});

function owner() {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  closers.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
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
  });
  const events: PageRevisionEvent[] = [];
  setInterceptionHooks({ pageRevision: (event) => void events.push(event) });
  const json = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ws, app, events, json, space: ws.spaces()[0].id };
}

it('fires for the owner routes: create, update and delete (with child reparenting)', async () => {
  const o = owner();
  const path = `/api/spaces/${o.space}/pages`;
  const parent = (await (
    await o.app.request(path, o.json({ title: 'Parent', content: 'p' }))
  ).json()) as { id: string; revision: number };
  const child = (await (
    await o.app.request(
      path,
      o.json({ title: 'Child', content: 'c', parentId: parent.id }),
    )
  ).json()) as { id: string };
  expect(o.events).toEqual([
    { kind: 'create', spaceId: o.space, pageId: parent.id, revision: 1 },
    { kind: 'create', spaceId: o.space, pageId: child.id, revision: 1 },
  ]);
  o.events.length = 0;
  await o.app.request(
    `${path}/${parent.id}`,
    o.json({ content: 'p2', expectedRevision: 1 }, 'PATCH'),
  );
  expect(o.events).toEqual([
    { kind: 'update', spaceId: o.space, pageId: parent.id, revision: 2 },
  ]);
  o.events.length = 0;
  expect(
    (await o.app.request(`${path}/${parent.id}`, o.json({}, 'DELETE'))).status,
  ).toBe(200);
  expect(o.events).toEqual([
    { kind: 'reparent', spaceId: o.space, pageId: child.id, revision: 2 },
    { kind: 'delete', spaceId: o.space, pageId: parent.id, revision: null },
  ]);
});

it('does not fire for a rejected write (stale revision)', async () => {
  const o = owner();
  const page = o.ws.pages.create(o.space, {
    title: 'P',
    content: 'c',
    parentId: null,
  });
  o.events.length = 0;
  const response = await o.app.request(
    `/api/spaces/${o.space}/pages/${page.id}`,
    o.json({ content: 'x', expectedRevision: 99 }, 'PATCH'),
  );
  expect(response.status).toBe(409);
  expect(o.events).toEqual([]);
});

it('fires for the reviewed-page path, once per tool call even when retried', async () => {
  const o = owner();
  o.ws.bindThread('review', o.ws.dots()[0].id, 'Review');
  const path = '/api/conversations/review/reviewed-page';
  const body = {
    toolCallId: 'call-1',
    spaceId: o.space,
    title: 'Reviewed',
    content: 'body',
  };
  const first = await o.app.request(path, o.json(body));
  expect(first.status).toBe(201);
  const page = (await first.json()) as { id: string };
  expect(o.events).toEqual([
    { kind: 'create', spaceId: o.space, pageId: page.id, revision: 1 },
  ]);
  await o.app.request(path, o.json(body));
  expect(o.events).toHaveLength(1);
});

it('fires for the save-conversation path', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  closers.push(() => ws.close());
  const events: PageRevisionEvent[] = [];
  setInterceptionHooks({ pageRevision: (event) => void events.push(event) });
  const dot = ws.dots()[0];
  ws.bindThread('save', dot.id, 'Save me');
  const service = new PageService(ws, () => ({
    getOrCreateThread: async () => {},
    getThreadMessages: async () => ({
      messages: [{ role: 'assistant', content: 'Saved text' }],
    }),
  }));
  const page = await service.saveConversation('save', 'Saved', null);
  expect(events).toEqual([
    { kind: 'create', spaceId: page.spaceId, pageId: page.id, revision: 1 },
  ]);
});

it('fires for the agent tool path', async () => {
  const f = agentFixture();
  const events: PageRevisionEvent[] = [];
  setInterceptionHooks({ pageRevision: (event) => void events.push(event) });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCall('c', 'create_space_page', { title: 'Made', content: 'x' }),
    )
    .mockResolvedValueOnce(text('Created.'));
  await lastValueFrom(f.agent.run(f.input('Make a page.')).pipe(toArray()));
  expect(events).toEqual([
    expect.objectContaining({ kind: 'create', revision: 1 }),
  ]);
});

it('an instance hook wins over the module-level hook', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  closers.push(() => ws.close());
  const moduleLevel = vi.fn();
  const instance = vi.fn();
  setInterceptionHooks({ pageRevision: moduleLevel });
  ws.pages.onRevision = instance;
  ws.pages.create(ws.spaces()[0].id, {
    title: 'T',
    content: '',
    parentId: null,
  });
  expect(instance).toHaveBeenCalledOnce();
  expect(moduleLevel).not.toHaveBeenCalled();
});

it('a hook that throws inside a transaction rolls the write back', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  closers.push(() => ws.close());
  const space = ws.spaces()[0].id;
  const page = ws.pages.create(space, {
    title: 'T',
    content: 'a',
    parentId: null,
  });
  ws.pages.onRevision = () => {
    throw new Error('sink down');
  };
  expect(() =>
    ws.pages.update(space, page.id, { content: 'b', expectedRevision: 1 }),
  ).toThrow('sink down');
  ws.pages.onRevision = undefined;
  expect(ws.pages.get(space, page.id)).toMatchObject({
    content: 'a',
    revision: 1,
  });
});
