// The upstream chat experience with CopilotKit Intelligence configured. This
// only LOADS the app and reads what it shows: it sends no prompt and creates no
// conversation thread, so nothing is written to the Intelligence service.
// Intelligence is separate from the Crusoe key; the mission page reports it
// separately and does not depend on it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dotenv,
  fixtureFile,
  openSession,
  ownerId,
  shot,
  startServer,
  type RunningServer,
  type Session,
} from './support/env.js';

// Upstream setup is complete only with Intelligence AND the provider variables
// (Dot turns need them). The server stays in fixture mode for missions, and no
// Dot turn is started, so the provider is never called.
const KEYS = dotenv([
  'INTELLIGENCE_API_KEY',
  'CPK_INTELLIGENCE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
]);
const present =
  !!(KEYS.INTELLIGENCE_API_KEY || KEYS.CPK_INTELLIGENCE_API_KEY) &&
  !!KEYS.OPENAI_API_KEY &&
  !!KEYS.OPENAI_BASE_URL &&
  !!KEYS.OPENAI_MODEL;

let server: RunningServer | undefined;
let ses: Session | undefined;
const body = () => ses!.page.locator('body').innerText();

beforeAll(async () => {
  if (!present) {
    console.error(
      'BLOCKED: .env needs INTELLIGENCE_API_KEY (or CPK_INTELLIGENCE_API_KEY), OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL',
    );
    return;
  }
  server = await startServer({
    name: 'chat',
    ownerId: ownerId('chat'),
    env: {
      ...KEYS,
      NEMODOTS_INFERENCE_MODE: 'fixture',
      NEMODOTS_FIXTURE_PATH: fixtureFile('chat'),
      NEMODOTS_WORKERS: '0',
    },
  });
  ses = await openSession(server.url);
});
afterAll(async () => {
  await ses?.close();
  await server?.stop();
});

describe('upstream chat with Intelligence configured', () => {
  it('has the keys to run against (otherwise the run is BLOCKED)', () => {
    expect(present, 'BLOCKED: Intelligence key missing').toBe(true);
  });

  it('renders the chat view as set up, not as "setup required"', async () => {
    await ses!.page.goto('/');
    await ses!.page.getByText('NemoDots').first().waitFor();
    // the badge is hidden at some widths, so read it from the DOM
    const badge = ses!.page.locator('.mode-badge');
    await badge.waitFor({ state: 'attached', timeout: 30_000 });
    expect(await badge.textContent()).toBe('SELF-HOSTED');
    const text = await body();
    expect(text).not.toContain('SETUP REQUIRED');
    expect(text).not.toContain('Set up text chat to begin');
    expect(
      await ses!.page
        .getByRole('button', { name: /new chat/i })
        .first()
        .isEnabled(),
    ).toBe(true);
    await shot(ses!.page, 'chat-configured');
  });

  it('reports Intelligence apart from the run mode on the mission page', async () => {
    await ses!.page.goto('/#/missions');
    await ses!.page
      .getByRole('heading', { name: 'Missions', level: 1 })
      .waitFor();
    await ses!.page.getByText('Intelligence configured').first().waitFor();
    // the mission page does not need Intelligence: it is a fixture server
    expect(await ses!.page.locator('.nd-mode-fixture').count()).toBeGreaterThan(
      0,
    );
    expect(
      await ses!.page.locator('.nd-intel-configured').count(),
    ).toBeGreaterThan(0);
    await shot(ses!.page, 'chat-missions-intelligence');
  });

  it('keeps the upstream views reachable next to Missions', async () => {
    await ses!.page
      .getByRole('button', { name: /Scheduled & activity/ })
      .first()
      .click();
    await ses!.page
      .getByText(/activity|scheduled/i)
      .first()
      .waitFor();
    await ses!.page
      .getByRole('button', { name: /Memories/ })
      .first()
      .click();
    await ses!.page.getByText(/memor/i).first().waitFor();
    await ses!.page
      .getByRole('button', { name: /^Missions/ })
      .first()
      .click();
    await ses!.page
      .getByRole('heading', { name: 'Missions', level: 1 })
      .waitFor();
  });
});
