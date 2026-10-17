// Gate 7: run-mode labels, setup / blocked state, fixture and live labelling,
// separate Intelligence badge, loading / error / empty states, secret hygiene.
// Cases: G7.2, G7.11, G7.13 (failed mission), G7.17.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { NemoApi, CONSTRAINTS, GOAL, isTerminal } from './helpers/api.js';
import {
  APP_ROOT,
  liveCredentials,
  readLocalSecrets,
  until,
} from './helpers/env.js';
import { MissionPage } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import { consoleErrors, launchChrome, newPage } from './helpers/ui.js';

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

  it('[G7.8] reload of a finished mission reconstructs the same view from the snapshot', async () => {
    const [mission] = await api.listMissions();
    expect(mission).toBeDefined();
    const { context, page } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto(`/#/missions/${mission!.id}`);
      await mp.expectStatus(mission!.status);
      const before = await mp.text();
      await page.reload();
      await mp.expectStatus(mission!.status);
      expect(await mp.text()).toBe(before);
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

  it('[G7.17] no secret value appears in the DOM, network responses, console or built assets', async () => {
    const creds = liveCredentials();
    if (!creds.ok) throw new Error('BLOCKED');
    const secrets = Object.values(
      readLocalSecrets([
        'OPENAI_API_KEY',
        'CRUSOE_API_KEY',
        'CPK_INTELLIGENCE_API_KEY',
      ]),
    );
    secrets.push(creds.env.OPENAI_API_KEY);
    const needles = [...new Set(secrets)].filter((v) => v.length >= 8);
    const { context, page, captured } = await newPage(browser);
    try {
      const mp = new MissionPage(page);
      await page.goto('/#/missions/');
      await expect(mp.modeBadge).toBeVisible();
      const html = await page.content();
      const haystacks = [
        html,
        ...captured.responseBodies,
        ...captured.console.map((m) => m.text),
      ];
      for (const needle of needles)
        for (const hay of haystacks) expect(hay.includes(needle)).toBe(false);
      // Control-plane and prompt data never serialised to the client.
      for (const body of captured.responseBodies)
        expect(body).not.toMatch(
          /"control"\s*:|fault_schedules|NEMODOTS_PROBE_SECRET|postgres:\/\//,
        );
    } finally {
      await context.close();
    }
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)],
      );
    for (const file of walk(resolve(APP_ROOT, 'dist/client'))) {
      if (statSync(file).size > 20_000_000) continue;
      const content = readFileSync(file, 'utf8');
      for (const needle of needles)
        expect(
          content.includes(needle),
          `built asset ${file} contains a secret value`,
        ).toBe(false);
    }
  });
});
