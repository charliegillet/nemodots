// Gate 7: upstream page / chat views still work, and the owner / origin /
// content-type protections of the upstream /api middleware cover the new
// routes. Cases: G7.16, G7.9 (create form keyboard), G7.11.
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { API, APP_URL, liveCredentials, until } from './helpers/env.js';
import { NemoApi, GOAL } from './helpers/api.js';
import { MissionPage } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import { escapeRe, launchChrome, newPage } from './helpers/ui.js';

let browser: Browser;
beforeAll(async () => {
  browser = await launchChrome();
});
afterAll(async () => {
  await browser?.close();
});

describe('owner token, origin and content-type protections', () => {
  let stack: Acc7Stack;
  let authed: NemoApi;
  beforeAll(async () => {
    // Fixture mode is enough: these rows test the middleware and the client,
    // not inference.
    stack = await Acc7Stack.start({
      mode: 'fixture',
      checkout: true,
      ownerToken: true,
    });
    authed = new NemoApi(stack.authHeaders);
  });
  afterAll(async () => {
    await stack?.stop();
  });

  const post = (path: string, headers: Record<string, string>, body = '{}') =>
    fetch(`${API}${path}`, { method: 'POST', headers, body });

  it('[G7.16] every CONTRACTS section 9 route requires the owner token, with none or a wrong one, and a refused call changes nothing', async () => {
    const mission = await authed.createMission({ goal: GOAL });
    const before = {
      list: (await authed.listMissions()).length,
      status: (await authed.snapshot(mission.id)).mission.status,
    };
    const m = `/missions/${mission.id}`;
    const routes: { method: 'GET' | 'POST'; path: string }[] = [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/missions' },
      { method: 'GET', path: m },
      { method: 'GET', path: `${m}/events` },
      ...['tasks', 'evidence', 'actions', 'recovery', 'telemetry'].map(
        (leaf) => ({ method: 'GET' as const, path: `${m}/${leaf}` }),
      ),
      { method: 'GET', path: '/telemetry/summary' },
      { method: 'GET', path: '/sandbox/checkout/health' },
      { method: 'GET', path: '/evals/report' },
      { method: 'POST', path: '/missions' },
      ...['start', 'pause', 'resume', 'cancel'].map((leaf) => ({
        method: 'POST' as const,
        path: `${m}/${leaf}`,
      })),
      { method: 'POST', path: '/sandbox/injector/run' },
      {
        method: 'POST',
        path: `/sandbox/sources/${encodeURIComponent('checkout.config/cache.namespace')}`,
      },
    ];
    const credentials: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer definitely-not-the-owner-token-000000' },
    ];
    for (const headers of credentials)
      for (const { method, path } of routes) {
        const res =
          method === 'GET'
            ? await fetch(`${API}${path}`, { headers })
            : await post(path, {
                ...headers,
                'Content-Type': 'application/json',
                Origin: APP_URL,
              });
        const label = `${method} ${path.replace(mission.id, ':id')} ${
          'Authorization' in headers ? 'with a wrong token' : 'without a token'
        }`;
        expect(res.status, label).toBe(401);
        await res.arrayBuffer().catch(() => undefined);
      }
    expect((await authed.listMissions()).length).toBe(before.list);
    expect((await authed.snapshot(mission.id)).mission.status).toBe(
      before.status,
    );
  });

  it('[G7.16] cross-origin and non-JSON mutations (create and every lifecycle POST, and fault injection) are rejected and leave the server state unchanged', async () => {
    const mission = await authed.createMission({ goal: GOAL });
    const count = (await authed.listMissions()).length;
    const statusOf = async () =>
      (await authed.snapshot(mission.id)).mission.status;
    expect(await statusOf()).toBe('created');
    const evil = {
      ...stack.authHeaders,
      'Content-Type': 'application/json',
      Origin: 'http://evil.example',
    };
    const plain = {
      ...stack.authHeaders,
      'Content-Type': 'text/plain',
      Origin: APP_URL,
    };
    const attempts: [string, string, Record<string, string>][] = [
      ['create cross-origin', '/missions', evil],
      ['create non-JSON', '/missions', plain],
      ...(['start', 'cancel', 'pause', 'resume'] as const).flatMap(
        (leaf): [string, string, Record<string, string>][] => [
          [`${leaf} cross-origin`, `/missions/${mission.id}/${leaf}`, evil],
          [`${leaf} non-JSON`, `/missions/${mission.id}/${leaf}`, plain],
        ],
      ),
      ['injector cross-origin', '/sandbox/injector/run', evil],
      ['injector non-JSON', '/sandbox/injector/run', plain],
    ];
    for (const [label, path, headers] of attempts) {
      const res = await post(
        path,
        headers,
        path === '/missions'
          ? JSON.stringify({ goal: GOAL })
          : path.includes('injector')
            ? JSON.stringify({ scenarioClass: 'repairable-checkout-fault' })
            : '{}',
      );
      expect(res.status, label).toBeGreaterThanOrEqual(400);
      expect(res.status, label).toBeLessThan(500);
      await res.arrayBuffer().catch(() => undefined);
      expect(await statusOf(), `mission status after ${label}`).toBe('created');
    }
    expect((await authed.listMissions()).length).toBe(count);
    // Positive control: the same mission is cancellable from the real origin,
    // so the refusals above were caused by the origin / content type.
    const ok = await post(`/missions/${mission.id}/cancel`, {
      ...stack.authHeaders,
      'Content-Type': 'application/json',
      Origin: APP_URL,
    });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    expect(await statusOf()).toBe('cancelled');
  });

  it('[G7.16] the browser asks for the token, sends it in an Authorization header on the event stream and on lifecycle calls, and never puts it in any URL', async () => {
    const mission = await authed.createMission({ goal: GOAL });
    const { context, page, captured } = await newPage(browser, {
      tapStream: true,
    });
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      const field = page.getByLabel(/token|access/i).first();
      await expect(
        field,
        'the unlock screen asks for the owner token',
      ).toBeVisible();
      await field.fill(stack.ownerToken!);
      await page
        .getByRole('button', { name: /unlock|continue|sign in|submit/i })
        .first()
        .click();
      await expect(mp.modeBadge).toBeVisible({ timeout: 30_000 });
      // Open the mission page after unlocking (in-page navigation keeps the token).
      await page.evaluate((id) => {
        window.location.hash = `#/missions/${id}`;
      }, mission.id);
      await mp.expectStatus('created');
      await until(
        'the events request was made and answered 200',
        async () => {
          await captured.settle();
          const events = await captured.eventsRequests();
          const answered = captured.requests.some(
            (r) => /\/events(?:\?|$)/.test(r.url) && r.status === 200,
          );
          return events.length > 0 && answered;
        },
        { timeoutMs: 30_000, intervalMs: 500 },
      );
      const events = await captured.eventsRequests();
      for (const request of events)
        expect(
          request.authorization,
          'the event stream carries the token in an Authorization header',
        ).toBe(true);
      // A lifecycle call from the UI carries it too.
      await mp.start.click();
      await until('the UI Start call reached the server', async () => {
        const s = await authed.snapshot(mission.id);
        return s.mission.status !== 'created';
      });
      await captured.settle();
      const starts = captured.raw.requests.filter(
        (r) => r.method === 'POST' && r.url.endsWith(`/${mission.id}/start`),
      );
      expect(starts.length).toBeGreaterThan(0);
      for (const r of starts)
        expect(r.headers.authorization).toBe(`Bearer ${stack.ownerToken}`);
      // Never in a URL: not in any request URL, the page URL or a referrer.
      for (const r of captured.raw.requests) {
        expect(
          r.url.includes(stack.ownerToken!),
          `request URL ${new URL(r.url).pathname} contains the token`,
        ).toBe(false);
        expect(
          (r.headers.referer ?? '').includes(stack.ownerToken!),
          'a referer contains the token',
        ).toBe(false);
      }
      expect(page.url().includes(stack.ownerToken!)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it('[G7.9] the mission create form is operable by keyboard alone: validation is text inside the form, and Enter / Space on Create make the server list the new mission and open it', async () => {
    const { context, page } = await newPage(browser, {
      token: stack.ownerToken,
    });
    try {
      const mp = new MissionPage(page);
      const known = new Set((await authed.listMissions()).map((m) => m.id));
      await page.goto('/#/missions/');
      const goalField = page.getByLabel(/goal/i).first();
      await expect(goalField).toBeVisible({ timeout: 30_000 });
      const form = page.locator('form').filter({ has: goalField });
      await expect(form).toHaveCount(1);
      // Empty submit by keyboard: an error in text, scoped to this form, nothing created.
      await mp.tabTo(mp.create);
      await page.keyboard.press('Enter');
      await expect(
        form
          .getByRole('alert')
          .or(form.getByText(/goal.{0,40}(required|empty|too short|enter)/i))
          .first(),
      ).toBeVisible();
      expect((await authed.listMissions()).length).toBe(known.size);
      for (const key of ['Enter', 'Space'] as const) {
        await page.goto('/#/missions/');
        const goal = `Keyboard-created mission via ${key} ${Date.now()}`;
        const field = page.getByLabel(/goal/i).first();
        await mp.tabTo(field);
        await page.keyboard.type(goal);
        await mp.tabTo(mp.create);
        expect(await mp.create.isEnabled()).toBe(true);
        await page.keyboard.press(key === 'Space' ? ' ' : 'Enter');
        const created = await until(
          `the server lists the mission created with ${key}`,
          async () =>
            (await authed.listMissions()).find(
              (m) => !known.has(m.id) && m.goal === goal,
            ),
          { timeoutMs: 30_000, intervalMs: 500 },
        );
        known.add(created.id);
        await expect(page).toHaveURL(
          new RegExp(`#/missions/${escapeRe(created.id)}`),
        );
        await mp.expectStatus('created');
      }
    } finally {
      await context.close();
    }
  });
});

describe('upstream OpenDots surfaces still work next to mission control', () => {
  let stack: Acc7Stack;
  beforeAll(async () => {
    const creds = liveCredentials();
    if (!creds.ok)
      throw new Error(`BLOCKED: needs ${creds.missing.join(', ')}`);
    stack = await Acc7Stack.start({ mode: 'live', intelligence: true });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('[G7.16] the upstream shell and Spaces render without errors; the missions entry is added, not substituted', async () => {
    const { context, page, captured } = await newPage(browser);
    try {
      await page.goto('/');
      await expect(
        page.getByRole('navigation').or(page.locator('aside')).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/missions/i).first()).toBeVisible();
      for (const label of [/spaces?/i, /memor/i])
        await expect(page.getByText(label).first()).toBeVisible();
      expect(captured.pageErrors).toEqual([]);
      const refused = captured.requests.filter(
        (r) => r.status === 401 || r.status === 403 || r.status === 404,
      );
      expect(
        refused
          .filter((r) => r.url.includes('/api/'))
          .map((r) => `${r.method} ${r.url} ${r.status}`),
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('[G7.16] a page created through the upstream UI is saved by the server and still there after a reload', async () => {
    const res = await fetch(`${APP_URL}/api/workspace`);
    const workspace = (await res.json()) as {
      spaces: { id: string; name: string }[];
    };
    expect(workspace.spaces.length).toBeGreaterThan(0);
    const space = workspace.spaces[0]!;
    const title = `G7 acceptance page ${Date.now().toString(36)}`;
    const listPages = async () =>
      (await (
        await fetch(`${APP_URL}/api/spaces/${space.id}/pages`)
      ).json()) as { id: string; title: string }[];
    const { context, page } = await newPage(browser);
    try {
      await page.goto('/');
      await page
        .getByRole('button', { name: new RegExp(escapeRe(space.name)) })
        .or(page.getByText(space.name, { exact: true }))
        .first()
        .click();
      await page
        .getByRole('button', { name: /new page/i })
        .first()
        .click();
      const titleField = page.getByLabel('Page title');
      await expect(titleField).toBeVisible({ timeout: 30_000 });
      await titleField.fill(title);
      await titleField.press('Tab');
      const saved = await until(
        'the server stores the new page',
        async () => (await listPages()).find((p) => p.title === title),
        { timeoutMs: 30_000, intervalMs: 500 },
      );
      await page.reload();
      await page
        .getByRole('button', { name: new RegExp(escapeRe(space.name)) })
        .or(page.getByText(space.name, { exact: true }))
        .first()
        .click();
      await expect(
        page.getByText(title).first(),
        'the page is listed after a reload',
      ).toBeVisible({ timeout: 30_000 });
      expect((await listPages()).some((p) => p.id === saved.id)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('[G7.16] Intelligence is configured, mission control reports it separately, and a real chat turn is answered in a new assistant message', async () => {
    const api = new NemoApi(stack.authHeaders);
    expect((await api.health()).intelligence).toBe('configured');
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.intelligenceBadge).toContainText(/configured/i);
      await page.goto('/');
      const composer = page
        .getByRole('textbox', {
          name: /message your dot|message|ask|chat|prompt/i,
        })
        .or(page.locator('textarea'))
        .first();
      await expect(composer).toBeVisible({ timeout: 30_000 });
      const assistant = page.locator('.chat-bubble.assistant');
      const before = await assistant.count();
      await composer.fill('What is 17 times 3? Answer with just the number.');
      await composer.press('Enter');
      // The prompt never contains "51", so seeing it in a NEW assistant
      // message (not a timestamp or a count elsewhere on the page) proves a
      // real assistant turn.
      await expect(assistant).toHaveCount(before + 1, { timeout: 180_000 });
      await expect(assistant.last()).toContainText(
        /(?:^|[^\d:.,/-])51(?:[^\d:]|$)/,
        { timeout: 180_000 },
      );
    } finally {
      await context.close();
    }
  });
});
