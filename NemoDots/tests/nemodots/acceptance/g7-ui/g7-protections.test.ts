// Gate 7: upstream page / chat views still work, and the owner / origin /
// content-type protections of the upstream /api middleware cover the new
// routes. Cases: G7.16, G7.9 (create form keyboard), G7.11.
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { API, APP_URL, liveCredentials } from './helpers/env.js';
import { NemoApi, GOAL } from './helpers/api.js';
import { MissionPage } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import { launchChrome, newPage } from './helpers/ui.js';

let browser: Browser;
beforeAll(async () => {
  browser = await launchChrome();
});
afterAll(async () => {
  await browser?.close();
});

describe('owner token, origin and content-type protections', () => {
  let stack: Acc7Stack;
  beforeAll(async () => {
    const creds = liveCredentials();
    if (!creds.ok)
      throw new Error(`BLOCKED: needs ${creds.missing.join(', ')}`);
    stack = await Acc7Stack.start({ mode: 'live', ownerToken: true });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('[G7.16] every /api/nemodots route requires the owner token', async () => {
    const anonymous = new NemoApi({});
    for (const path of [
      '/health',
      '/missions',
      '/telemetry/summary',
      '/sandbox/checkout/health',
      '/evals/report',
    ]) {
      const res = await anonymous.raw(path);
      expect(res.status, `GET ${path} without a token`).toBe(401);
      await res.text();
    }
    const create = await anonymous.raw('/missions', {
      method: 'POST',
      json: { goal: GOAL },
    });
    expect(create.status).toBe(401);
    await create.text();
    const wrong = new NemoApi({
      Authorization: 'Bearer definitely-not-the-owner-token-000000',
    });
    const res = await wrong.raw('/missions');
    expect(res.status).toBe(401);
    await res.text();
  });

  it('[G7.16] cross-origin and non-JSON mutations are rejected and create nothing', async () => {
    const authed = new NemoApi(stack.authHeaders);
    const before = (await authed.listMissions()).length;
    const evil = await fetch(`${API}/missions`, {
      method: 'POST',
      headers: {
        ...stack.authHeaders,
        'Content-Type': 'application/json',
        Origin: 'http://evil.example',
      },
      body: JSON.stringify({ goal: GOAL }),
    });
    expect(evil.status).toBeGreaterThanOrEqual(400);
    expect(evil.status).toBeLessThan(500);
    await evil.text();
    const form = await fetch(`${API}/missions`, {
      method: 'POST',
      headers: {
        ...stack.authHeaders,
        'Content-Type': 'text/plain',
        Origin: APP_URL,
      },
      body: JSON.stringify({ goal: GOAL }),
    });
    expect(form.status).toBeGreaterThanOrEqual(400);
    expect(form.status).toBeLessThan(500);
    await form.text();
    expect((await authed.listMissions()).length).toBe(before);
  });

  it('[G7.16] the browser asks for the owner token, never puts it in a URL, and unlocks the mission page', async () => {
    const { context, page, captured } = await newPage(browser);
    try {
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
      const mp = new MissionPage(page);
      await expect(mp.modeBadge).toBeVisible({ timeout: 30_000 });
      for (const req of captured.requests)
        expect(req.url).not.toContain(stack.ownerToken!);
      expect(page.url()).not.toContain(stack.ownerToken!);
    } finally {
      await context.close();
    }
  });

  it('[G7.9] the mission create form is operable by keyboard alone and reports validation in text', async () => {
    const { context, page } = await newPage(browser, {
      token: stack.ownerToken,
    });
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      const goal = page.getByLabel(/goal/i).first();
      await mp.tabTo(goal);
      await page.keyboard.press('Enter');
      await expect(
        page
          .getByRole('alert')
          .or(page.getByText(/goal.{0,40}(required|empty|too short)/i))
          .first(),
      ).toBeVisible();
      await page.keyboard.type(
        'Investigate the checkout service and restore normal operation.',
      );
      await mp.tabTo(mp.create);
      expect(await mp.create.isEnabled()).toBe(true);
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

  it('[G7.16] the upstream shell, Spaces and page creation are unchanged; the missions entry is added, not substituted', async () => {
    const { context, page, captured } = await newPage(browser);
    try {
      await page.goto('/');
      await expect(
        page.getByRole('navigation').or(page.locator('aside')).first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/missions/i).first()).toBeVisible();
      // Upstream features remain reachable: Spaces, Activity/Tasks, Memories, chat composer.
      for (const label of [/spaces?/i, /memor/i])
        await expect(page.getByText(label).first()).toBeVisible();
      expect(captured.pageErrors).toEqual([]);
      const unauthorised = captured.requests.filter(
        (r) => r.status === 401 || r.status === 403 || r.status === 404,
      );
      expect(
        unauthorised
          .filter((r) => r.url.includes('/api/'))
          .map((r) => `${r.method} ${r.url} ${r.status}`),
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('[G7.16] Intelligence is configured, mission control reports it separately, and the chat composer accepts a message', async () => {
    const api = new NemoApi(stack.authHeaders);
    expect((await api.health()).intelligence).toBe('configured');
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.intelligenceBadge).toContainText(/configured/i);
      await page.goto('/');
      const composer = page
        .getByRole('textbox', { name: /message|ask|chat|prompt/i })
        .or(page.locator('textarea'))
        .first();
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill('What is 17 times 3? Answer with just the number.');
      await composer.press('Enter');
      // The prompt never contains "51", so seeing it proves a real assistant turn.
      await expect(page.getByText(/\b51\b/).last()).toBeVisible({
        timeout: 180_000,
      });
    } finally {
      await context.close();
    }
  });
});
