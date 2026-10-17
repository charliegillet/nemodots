import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/server/store.js';
import { WorkspaceStore } from '../../../src/server/workspace.js';
import { Platform } from '../../../src/server/platform.js';
import { Runner } from '../../../src/server/runner.js';
import { createApp } from '../../../src/server/app.js';
import { pageAccess, pageTools } from '../../../src/server/page-tools.js';
import type {
  PageRevisionEvent,
  Pages,
} from '../../../src/server/pages.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture() {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
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
  const events: Array<PageRevisionEvent & { inTransaction: boolean }> = [];
  const inTransaction = () =>
    (ws.pages as unknown as { db: { isTransaction: boolean } }).db
      .isTransaction;
  ws.pages.onRevision = (event) =>
    events.push({ ...event, inTransaction: inTransaction() });
  return { ws, app, events, dot: ws.dots()[0] };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Pages.onRevision', () => {
  it('is absent by default and changes nothing', () => {
    const ws = new WorkspaceStore(':memory:', 'owner');
    cleanup.push(() => ws.close());
    expect(ws.pages.onRevision).toBeUndefined();
    const space = ws.dots()[0].spaceId;
    const page = ws.pages.create(space, { title: 'A' });
    ws.pages.update(space, page.id, { content: 'x', expectedRevision: 1 });
    expect(ws.pages.delete(space, page.id)).toBe(true);
  });

  it('fires for the agent tool path (create then edit), inside the write transaction', async () => {
    const f = fixture();
    f.ws.bindThread('t', f.dot.id, 'T');
    const tools = pageTools(
      pageAccess(f.ws, f.dot.spaceId, 't', () => {}),
    );
    const run = (name: string, input: unknown) =>
      tools.find((t) => t.name === name)!.execute!(input as never);
    const created = (await run('create_space_page', {
      title: 'Tool page',
      content: 'one',
    })) as { id: string };
    await run('edit_space_page', {
      id: created.id,
      content: 'two',
      expectedRevision: 1,
    });
    expect(f.events.map((e) => [e.op, e.revision])).toEqual([
      ['create', 1],
      ['update', 2],
    ]);
    expect(f.events.every((e) => e.inTransaction)).toBe(true);
    expect(f.events[1].page).toMatchObject({ id: created.id, content: 'two' });
    expect(f.events[0]).toMatchObject({
      spaceId: f.dot.spaceId,
      pageId: created.id,
      review: null,
    });
  });

  it('fires for the owner routes (create, patch, delete)', async () => {
    const f = fixture();
    const base = `/api/spaces/${f.dot.spaceId}/pages`;
    const created = (await (
      await f.app.request(base, json({ title: 'Owner page', content: 'a' }))
    ).json()) as { id: string };
    expect(
      (
        await f.app.request(
          `${base}/${created.id}`,
          json({ content: 'b', expectedRevision: 1 }, 'PATCH'),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.app.request(`${base}/${created.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(200);
    expect(f.events.map((e) => [e.op, e.revision])).toEqual([
      ['create', 1],
      ['update', 2],
      ['delete', null],
    ]);
    expect(f.events[2]).toMatchObject({ page: null, pageId: created.id });
  });

  it('fires once for the reviewed-page path and not again on an idempotent retry', async () => {
    const f = fixture();
    f.ws.bindThread('review', f.dot.id, 'Review');
    const body = {
      title: 'Reviewed',
      content: '# Reviewed',
      spaceId: f.dot.spaceId,
      toolCallId: 'call-1',
    };
    const path = '/api/conversations/review/reviewed-page';
    const first = await f.app.request(path, json(body));
    expect(first.status).toBe(201);
    const second = await f.app.request(path, json(body));
    expect(second.status).toBe(201);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({
      op: 'create_reviewed',
      revision: 1,
      sourceThreadId: 'review',
      review: { threadId: 'review', toolCallId: 'call-1' },
      inTransaction: true,
    });
    expect(f.ws.pages.list(f.dot.spaceId)).toHaveLength(1);
  });

  it('reports children re-parented by a delete with their new revisions', () => {
    const f = fixture();
    const space = f.dot.spaceId;
    const parent = f.ws.pages.create(space, { title: 'Parent' });
    const child = f.ws.pages.create(space, {
      title: 'Child',
      parentId: parent.id,
    });
    f.events.length = 0;
    f.ws.pages.delete(space, parent.id);
    expect(f.events).toHaveLength(1);
    expect(f.events[0].reparented).toEqual([
      { pageId: child.id, revision: 2 },
    ]);
    expect(f.ws.pages.get(space, child.id).revision).toBe(2);
  });

  it('does not fire when the write is rejected (revision conflict, missing page)', () => {
    const f = fixture();
    const space = f.dot.spaceId;
    const page = f.ws.pages.create(space, { title: 'P' });
    f.events.length = 0;
    expect(() =>
      f.ws.pages.update(space, page.id, { content: 'x', expectedRevision: 9 }),
    ).toThrow(/changed/);
    expect(f.ws.pages.delete(space, 'missing')).toBe(false);
    expect(f.events).toEqual([]);
  });

  it('rolls the write back when the hook throws', () => {
    const f = fixture();
    const space = f.dot.spaceId;
    const page = f.ws.pages.create(space, { title: 'P', content: 'old' });
    const pages: Pages = f.ws.pages;
    pages.onRevision = () => {
      throw new Error('outbox unavailable');
    };
    expect(() =>
      pages.update(space, page.id, { content: 'new', expectedRevision: 1 }),
    ).toThrow('outbox unavailable');
    expect(() => pages.create(space, { title: 'Q' })).toThrow(
      'outbox unavailable',
    );
    expect(() => pages.delete(space, page.id)).toThrow('outbox unavailable');
    pages.onRevision = undefined;
    expect(pages.get(space, page.id)).toMatchObject({
      content: 'old',
      revision: 1,
    });
    expect(pages.list(space)).toHaveLength(1);
  });

  it('accepts the hook as a constructor argument', async () => {
    const { Pages: PagesClass } = await import('../../../src/server/pages.js');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    const seen: string[] = [];
    const pages = new PagesClass(db, () => true, (event) => {
      seen.push(event.op);
    });
    pages.create('space', { title: 'X' });
    expect(seen).toEqual(['create']);
  });
});
