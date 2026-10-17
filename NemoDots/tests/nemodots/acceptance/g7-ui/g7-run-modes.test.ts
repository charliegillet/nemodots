// Gate 7: run-mode labels, setup / blocked state, fixture and live labelling,
// separate Intelligence badge, loading / error / empty states, system health.
// Cases: G7.2, G7.7 (system health), G7.8, G7.11, G7.13 (failed mission).
// The secret scan (G7.17) lives in g7-mission-flow.test.ts because it must run
// after a mission that made model calls and recorded receipts.
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { NemoApi, CONSTRAINTS, GOAL, isTerminal } from './helpers/api.js';
import { liveCredentials, until } from './helpers/env.js';
import { MissionPage, labelled } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import {
  consoleErrors,
  launchChrome,
  newPage,
  statusText,
} from './helpers/ui.js';

let browser: Browser;
beforeAll(async () => {
  browser = await launchChrome();
});
afterAll(async () => {
  await browser?.close();
});

describe('setup state: no Crusoe configuration (mode blocked)', () => {
  let stack: Acc7Stack;
  let api: NemoApi;
  beforeAll(async () => {
    stack = await Acc7Stack.start({ mode: 'blocked' });
    api = new NemoApi(stack.authHeaders);
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('[G7.2] health reports blocked and names (never values) of the missing environment', async () => {
    const health = await api.health();
    expect(health.mode).toBe('blocked');
    expect(health.missingEnv).toEqual(
      expect.arrayContaining([
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'OPENAI_MODEL',
      ]),
    );
    for (const name of health.missingEnv)
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(health.provider.reachable).toBe(false);
    expect(health.intelligence).toBe('blocked');
  });

  it('[G7.2] mission creation is refused with 503 and names only', async () => {
    const res = await api.raw('/missions', {
      method: 'POST',
      json: { goal: GOAL, constraints: CONSTRAINTS },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; missingEnv: string[] };
    expect(body.missingEnv.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/sk-|Bearer|postgres:\/\//);
  });

  it('[G7.2] UI shows the Blocked badge with the missing names, create disabled, no Live label', async () => {
    const { context, page, captured } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.modeBadge).toContainText(/blocked/i);
      await expect(mp.modeBadge).not.toContainText(/\blive\b/i);
      const text = await mp.text();
      for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'])
        expect(text).toContain(name);
      // The create control must be present and disabled, not hidden: hiding it hides the reason.
      await expect(mp.create).toBeVisible();
      await expect(mp.create).toBeDisabled();
      expect(
        consoleErrors(captured).filter((m) => !/401|403|503/.test(m.text)),
      ).toEqual([]);
      expect(captured.pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('[G7.2] Intelligence status is a separate badge from the mission mode', async () => {
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.intelligenceBadge).toContainText(/blocked/i);
      const modeBox = await mp.modeBadge.boundingBox();
      const intelBox = await mp.intelligenceBadge.boundingBox();
      expect(
        modeBox &&
          intelBox &&
          (modeBox.x !== intelBox.x || modeBox.y !== intelBox.y),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  it('[G7.11] loading state: a slow health request shows a loading status, then content', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.route('**/api/nemodots/health', async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.continue();
      });
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(
        mp.main
          .getByRole('status')
          .filter({ hasText: /loading/i })
          .first(),
      ).toBeVisible();
      await expect(mp.modeBadge).toBeVisible({ timeout: 15_000 });
    } finally {
      await context.close();
    }
  });

  it('[G7.11] error state: a failing health endpoint is shown in an alert, not as a fake mode', async () => {
    const { context, page } = await newPage(browser);
    try {
      await page.route('**/api/nemodots/health', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"boom"}',
        }),
      );
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.main.getByRole('alert').first()).toBeVisible();
      await expect(mp.modeBadge).not.toContainText(/\blive\b|\bfixture\b/i);
    } finally {
      await context.close();
    }
  });

  it('[G7.11] empty state: no missions yet shows an explanatory empty message, not a blank page', async () => {
    const { context, page } = await newPage(browser);
    try {
      expect(await api.listMissions()).toEqual([]);
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.main).toContainText(
        /no missions|nothing to show|no mission yet/i,
      );
    } finally {
      await context.close();
    }
  });
});

describe('fixture mode', () => {
  let stack: Acc7Stack;
  let api: NemoApi;
  beforeAll(async () => {
    stack = await Acc7Stack.start({ mode: 'fixture', checkout: true });
    api = new NemoApi(stack.authHeaders);
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('[G7.2] health reports fixture; the UI says Fixture and never Live', async () => {
    const health = await api.health();
    expect(health.mode).toBe('fixture');
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.modeBadge).toContainText(/fixture/i);
      await expect(mp.modeBadge).not.toContainText(/\blive\b/i);
      expect(await mp.text()).not.toMatch(/\bLive mode\b/i);
    } finally {
      await context.close();
    }
  });

  it('[G7.2] a mode that disagrees with the server is refused with 400', async () => {
    const res = await api.raw('/missions', {
      method: 'POST',
      json: { goal: GOAL, mode: 'live' },
    });
    expect(res.status).toBe(400);
    await res.text();
  });

  it('[G7.13] a mission the fixture cannot answer fails explicitly; the UI shows the status text and the reason', async () => {
    const mission = await api.createMission({
      goal: GOAL,
      constraints: CONSTRAINTS,
    });
    expect(mission.mode).toBe('fixture');
    await api.lifecycle(mission.id, 'start');
    const finished = await until(
      'mission reaches a terminal status (the scripted fixture has no entry for the planner request)',
      async () => {
        const s = await api.snapshot(mission.id);
        return isTerminal(s.mission.status) ? s : null;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );
    expect(finished.mission.status).toBe('failed');
    expect(finished.mission.failureReason).toBeTruthy();
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto(`/#/missions/${mission.id}`);
      await mp.expectStatus('failed');
      await expect(mp.main).toContainText(
        finished.mission.failureReason!.slice(0, 60),
      );
      await expect(mp.modeBadge).toContainText(/fixture/i);
      await expect(mp.start).toBeDisabled();
      await expect(mp.pause).toBeDisabled();
      await expect(mp.resume).toBeDisabled();
      await expect(mp.cancel).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  it('[G7.8] reload of a finished mission reconstructs the same structured view (status, task rows, receipt rows)', async () => {
    const [mission] = await api.listMissions();
    expect(mission).toBeDefined();
    const { context, page, captured } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto(`/#/missions/${mission!.id}`);
      await mp.expectStatus(mission!.status);
      const snapshot = await api.snapshot(mission!.id);
      const structure = async () => ({
        mission: await mp.missionStatus.getAttribute('data-status'),
        taskItems: await mp.taskTree.getByRole('listitem').count(),
        taskStatuses: await mp.taskTree
          .locator('[data-status]')
          .evaluateAll((els) =>
            els.map((e) => (e as HTMLElement).dataset.status ?? ''),
          ),
        receiptRows: await mp.ledger.getByRole('row').count(),
        actionItems: await mp.actions.getByRole('listitem').count(),
      });
      const before = await structure();
      expect(before.mission).toBe(snapshot.mission.status);
      expect(before.taskItems).toBe(snapshot.tasks.length);
      await page.reload();
      await mp.expectStatus(mission!.status);
      await until(
        'structured view equals the pre-reload view',
        async () =>
          JSON.stringify(await structure()) === JSON.stringify(before),
      );
      expect(captured.pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('[G7.7] system health panel equals the server HealthStatus: Postgres, Redis, checkout and provider as text', async () => {
    const health = await api.health();
    expect(health.postgres).toBe('ok');
    expect(health.redis).toBe('ok');
    expect(health.checkout.reachable).toBe(true);
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.health).toBeVisible();
      const text = (await mp.health.innerText()).replace(/\s+/g, ' ');
      expect(text).toMatch(labelled(/postgres/, statusText(health.postgres)));
      expect(text).toMatch(labelled(/redis/, statusText(health.redis)));
      expect(text).toMatch(
        labelled(/checkout(?: app)?/, statusText(health.checkout.status!)),
      );
      expect(text).toMatch(
        labelled(
          /provider reachable/,
          health.provider.reachable
            ? /yes|reachable|ok/i
            : /no|unreachable|down/i,
        ),
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.7] a stopped checkout app reads unreachable as text in the System health panel and the server health agrees', async () => {
    await stack.stopChild('checkout');
    const health = await until(
      'server health reports the checkout app unreachable',
      async () => {
        const h = await api.health();
        return h.checkout.reachable ? null : h;
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    expect(health.checkout.reachable).toBe(false);
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.health).toBeVisible();
      const text = (await mp.health.innerText()).replace(/\s+/g, ' ');
      expect(text).toMatch(labelled(/checkout(?: app)?/, /unreachable|down/i));
      expect(text, 'a down checkout is never shown as ok').not.toMatch(
        labelled(/checkout(?: app)?/, /\bok\b/i),
      );
      // Postgres and Redis are still up and still read as such.
      expect(text).toMatch(labelled(/postgres/, statusText('ok')));
    } finally {
      await context.close();
    }
  });
});

describe('live mode label', () => {
  let stack: Acc7Stack;
  let api: NemoApi;
  beforeAll(async () => {
    const creds = liveCredentials();
    if (!creds.ok)
      throw new Error(`BLOCKED: live label needs ${creds.missing.join(', ')}`);
    stack = await Acc7Stack.start({ mode: 'live' });
    api = new NemoApi(stack.authHeaders);
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('[G7.2] health live: provider host and model come from configuration; UI shows Live with that host and model', async () => {
    const health = await api.health();
    const creds = liveCredentials();
    if (!creds.ok) throw new Error('BLOCKED');
    expect(health.mode).toBe('live');
    expect(health.provider.host).toBe(new URL(creds.env.OPENAI_BASE_URL).host);
    expect(health.provider.model).toBe(creds.env.OPENAI_MODEL);
    expect(health.provider.reachable).toBe(true);
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.modeBadge).toContainText(/live/i);
      await expect(mp.modeBadge).not.toContainText(/fixture|blocked/i);
      const label = (await mp.modeBadge.getAttribute('aria-label')) ?? '';
      expect(label).toContain(health.provider.host!);
      expect(label).toContain(health.provider.model!);
      await expect(mp.create).toBeEnabled();
    } finally {
      await context.close();
    }
  });
});
