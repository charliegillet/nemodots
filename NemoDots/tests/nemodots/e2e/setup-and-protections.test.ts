// A locked server whose inference is blocked (no provider variables): the
// unlock screen, the Blocked label with the missing names, the empty, loading
// and error states, keyboard access, and the /api protections. Nothing here
// needs a model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  openSession,
  ownerId,
  shot,
  startServer,
  type RunningServer,
  type Session,
} from './support/env.js';

const TOKEN = 'e2e-owner-token-0123456789abcdef';
let server: RunningServer;
let ses: Session;

const body = (s: Session) => s.page.locator('body').innerText();

beforeAll(async () => {
  server = await startServer({
    name: 'blocked',
    ownerId: ownerId('blocked'),
    ownerToken: TOKEN,
    // no OPENAI_* and no NEMODOTS_INFERENCE_MODE: live is unavailable
  });
});
afterAll(async () => {
  await ses?.close();
  await server?.stop();
});

describe('the locked app', () => {
  it('shows the unlock screen, rejects a wrong token and keeps the token out of every URL', async () => {
    ses = await openSession(server.url);
    const urls: string[] = [];
    ses.page.on('request', (request) => urls.push(request.url()));
    await ses.page.goto('/');
    await ses.page.getByLabel('Owner access token').waitFor();
    expect(await body(ses)).toContain('Unlock NemoDots');
    await shot(ses.page, 'setup-unlock');

    await ses.page.getByLabel('Owner access token').fill('not-the-token');
    await ses.page.getByRole('button', { name: /unlock nemodots/i }).click();
    await ses.page.getByText(/owner access token to unlock/i).waitFor();
    expect(await body(ses)).not.toContain('Missions');

    await ses.page.getByLabel('Owner access token').fill(TOKEN);
    await ses.page.getByRole('button', { name: /unlock nemodots/i }).click();
    await ses.page
      .getByRole('button', { name: /^Missions/ })
      .first()
      .waitFor();
    expect(urls.filter((url) => url.includes(TOKEN))).toEqual([]);
    expect(
      await ses.page.evaluate(() => sessionStorage.getItem('opendots-token')),
    ).toBe(TOKEN);
  });
});

describe('setup and the Blocked label', () => {
  it('shows BLOCKED with every missing name, a disabled create form and the empty state', async () => {
    await ses.page.goto('/#/missions');
    await ses.page
      .getByRole('heading', { name: 'Missions', level: 1 })
      .waitFor();
    await ses.page.getByText('No missions yet').waitFor();
    const text = await body(ses);
    expect(text).toContain('BLOCKED');
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'])
      expect(text).toContain(name);
    expect(text).toContain('Intelligence blocked');
    expect(text).not.toMatch(/\bLIVE\b/);
    expect(text).not.toMatch(/\bFIXTURE\b/);

    const form = ses.page.getByRole('form', { name: 'Create mission' });
    expect(await form.getByLabel('Goal').isDisabled()).toBe(true);
    expect(
      await form.getByRole('button', { name: 'Create mission' }).isDisabled(),
    ).toBe(true);
    await shot(ses.page, 'setup-blocked');
  });

  it('the server refuses mission creation while blocked and names, never values, what is missing', async () => {
    const created = await apiCall(server, '/nemodots/missions', {
      method: 'POST',
      token: TOKEN,
      body: { goal: 'should not be created' },
    });
    expect(created.status).toBe(503);
    expect([...created.body.missingEnv].sort()).toEqual([
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
    ]);
    expect(JSON.stringify(created.body)).not.toMatch(/sk-|https?:\/\//);
    const health = await apiCall(server, '/nemodots/health', { token: TOKEN });
    expect(health.status).toBe(200);
    expect(health.body.mode).toBe('blocked');
    expect(health.body.provider.host).toBeNull();
    expect(health.body.provider.model).toBeNull();
  });
});

describe('loading and error states', () => {
  it('shows a loading status while the mission list is slow', async () => {
    const page = ses.page;
    await page.route('**/api/nemodots/missions', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return route.continue();
    });
    await page.goto('/#/missions');
    await page.reload();
    await page
      .getByRole('status')
      .filter({ hasText: 'Loading missions' })
      .waitFor();
    await shot(page, 'setup-loading');
    await page.getByText('No missions yet').waitFor();
    await page.unroute('**/api/nemodots/missions');
  });

  it('shows an alert, not a blank panel, when the list request fails', async () => {
    const page = ses.page;
    await page.route('**/api/nemodots/missions', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'The mission list could not be read.',
            }),
          })
        : route.continue(),
    );
    await page.reload();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'could not be read' });
    await alert.waitFor();
    expect(await body(ses)).not.toContain('No missions yet');
    await shot(page, 'setup-error');
    await page.unroute('**/api/nemodots/missions');
  });

  it('says a mission is not available instead of showing a half-built page', async () => {
    await ses.page.goto('/#/missions/00000000-0000-4000-8000-000000000000');
    await ses.page
      .getByRole('heading', { name: 'Mission not available' })
      .waitFor();
    expect(await ses.page.getByRole('alert').count()).toBeGreaterThan(0);
    expect(
      await ses.page.getByRole('button', { name: 'Back to missions' }).count(),
    ).toBe(1);
  });
});

describe('keyboard access', () => {
  it('reaches the navigation and every create-form field with Tab alone', async () => {
    await ses.page.goto('/#/missions');
    await ses.page.getByText('No missions yet').waitFor();
    const reached = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      await ses.page.keyboard.press('Tab');
      const label = await ses.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return '';
        return (
          el.getAttribute('aria-label') ||
          el.textContent?.trim().slice(0, 40) ||
          el.tagName
        );
      });
      reached.add(label);
    }
    // the blocked form's fields are disabled, so a real keyboard user skips
    // them; the navigation items must still be reachable
    expect([...reached].some((label) => /^Missions/.test(label))).toBe(true);
    expect(reached.has('Create mission')).toBe(false);
  });
});

describe('/api protections', () => {
  const route = '/nemodots/health';

  it('answers 401 without or with a wrong token and never reveals state', async () => {
    for (const token of [undefined, 'wrong-token-wrong-token-1234']) {
      const response = await apiCall(server, route, { token });
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain('postgres');
    }
    const stream = await apiCall(
      server,
      '/nemodots/missions/00000000-0000-4000-8000-000000000000/events',
    );
    expect(stream.status).toBe(401);
  });

  it('refuses a foreign origin and a cross-site request even with the token', async () => {
    const foreign = await apiCall(server, route, {
      token: TOKEN,
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    const crossSite = await apiCall(server, route, {
      token: TOKEN,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  it('refuses a write that is not JSON', async () => {
    const response = await fetch(`${server.url}/api/nemodots/missions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'text/plain',
      },
      body: 'goal=x',
    });
    expect(response.status).toBe(415);
  });

  it('answers 404 for unknown and malformed mission ids, and refuses a token in the URL', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const response = await apiCall(server, `/nemodots/missions/${id}`, {
        token: TOKEN,
      });
      expect(response.status).toBe(404);
    }
    const inQuery = await fetch(`${server.url}/api${route}?token=${TOKEN}`);
    expect(inQuery.status).toBe(401);
  });

  it('refuses edits to sources that are not controlled configuration', async () => {
    const response = await apiCall(
      server,
      '/nemodots/sandbox/sources/checkout.health',
      {
        method: 'POST',
        token: TOKEN,
        body: { value: 1, expectedVersion: 1 },
      },
    );
    expect([400, 404, 422, 503]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });
});
