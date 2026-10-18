// One live smoke: a single real mission against Crusoe, driven through the UI.
// It costs real inference, so it stops as soon as the plan is persisted and the
// first model call is recorded (the person cancels from the page), instead of
// running the incident to the end. The full live proof is the live mission
// suite (npm run test:nemodots:live); this checks the browser path to it.
//
// Without the Crusoe variables in .env the run is BLOCKED, never skipped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  dotenv,
  openSession,
  ownerId,
  shot,
  startServer,
  until,
  type RunningServer,
  type Session,
} from './support/env.js';

// NEMODOTS_E2E_LIVE=0 leaves the paid smoke out of a repeat run. It is reported
// as skipped, never as passed.
const SKIPPED = process.env.NEMODOTS_E2E_LIVE === '0';
if (SKIPPED)
  console.error('NOT_RUN: live smoke disabled by NEMODOTS_E2E_LIVE=0');

const CRUSOE = dotenv(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']);
const missing = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].filter(
  (name) => !CRUSOE[name],
);

let server: RunningServer | undefined;
let ses: Session | undefined;
const body = () => ses!.page.locator('body').innerText();
const pill = () => ses!.page.locator('.nd-mission-head .nd-pill').first();

beforeAll(async () => {
  if (SKIPPED) return;
  if (missing.length > 0) {
    console.error(`BLOCKED: ${missing.join(', ')} missing from .env`);
    return;
  }
  server = await startServer({
    name: 'live',
    ownerId: ownerId('live'),
    env: { ...CRUSOE, NEMODOTS_INFERENCE_MODE: 'live', NEMODOTS_WORKERS: '2' },
  });
  ses = await openSession(server.url);
});
afterAll(async () => {
  await ses?.close();
  await server?.stop();
});

describe.skipIf(SKIPPED)('live smoke', () => {
  it('has the Crusoe variables to run against (otherwise the run is BLOCKED)', () => {
    expect(missing, `BLOCKED: ${missing.join(', ')} missing`).toEqual([]);
  });

  it('labels the server Live with the model and host it will use', async () => {
    const host = new URL(CRUSOE.OPENAI_BASE_URL).host;
    await ses!.page.goto('/#/missions');
    await ses!.page.locator('.nd-mode-live').first().waitFor();
    expect(await ses!.page.locator('.nd-mode-fixture').count()).toBe(0);
    expect(await ses!.page.locator('.nd-mode-blocked').count()).toBe(0);
    const health = await apiCall(server!, '/nemodots/health');
    expect(health.body.mode).toBe('live');
    expect(health.body.provider.host).toBe(host);
    expect(health.body.provider.model).toBe(CRUSOE.OPENAI_MODEL);
    await shot(ses!.page, 'live-setup');
  });

  it(
    'creates and starts one mission from the page, shows the persisted plan, then cancels',
    async () => {
      const form = ses!.page.getByRole('form', { name: 'Create mission' });
      await form
        .getByLabel('Goal')
        .fill('Confirm the checkout app is healthy. Make no changes.');
      await form.getByRole('button', { name: 'Create mission' }).click();
      await ses!.page
        .getByRole('group', { name: 'Mission controls' })
        .waitFor();
      await ses!.page.locator('.nd-mission-head .nd-mode-live').waitFor();
      expect(
        await ses!.page.locator('.nd-mission-head .nd-mode-fixture').count(),
      ).toBe(0);
      expect(await body()).not.toContain('FIXTURE mission');
      const facts = await ses!.page.getByLabel('Mission facts').innerText();
      expect(facts).toContain(new URL(CRUSOE.OPENAI_BASE_URL).host);
      expect(facts).toContain(CRUSOE.OPENAI_MODEL);

      await ses!.page
        .getByRole('group', { name: 'Mission controls' })
        .getByRole('button', { name: 'Start' })
        .click();
      await until(
        'Running',
        async () => /running/i.test(await pill().innerText()),
        30_000,
      );

      // the planner's plan is stored: more than the planner task appears
      const tasks = ses!.page
        .getByRole('list', { name: 'Tasks' })
        .locator('li');
      await until(
        'the plan to appear',
        async () => (await tasks.count()) >= 3,
        6 * 60_000,
        2000,
      );
      await shot(ses!.page, 'live-plan');
      const telemetry = ses!.page
        .getByRole('region', { name: /telemetry/i })
        .first();
      await until(
        'a recorded model call',
        async () =>
          /Model calls\s*\n?\s*[1-9]/.test(await telemetry.innerText()),
        60_000,
        1000,
      );

      await ses!.page
        .getByRole('group', { name: 'Mission controls' })
        .getByRole('button', { name: 'Cancel' })
        .click();
      await until(
        'Cancelled',
        async () => /cancel/i.test(await pill().innerText()),
        60_000,
      );
      await shot(ses!.page, 'live-cancelled');
    },
    10 * 60_000,
  );

  it('every model call of the mission went to the configured host and model', async () => {
    const list = await apiCall(server!, '/nemodots/missions');
    expect(list.body).toHaveLength(1);
    const snapshot = await apiCall(
      server!,
      `/nemodots/missions/${list.body[0].id}`,
    );
    expect(snapshot.body.mission.mode).toBe('live');
    expect(snapshot.body.mission.provider.host).toBe(
      new URL(CRUSOE.OPENAI_BASE_URL).host,
    );
    expect(snapshot.body.telemetry.calls).toBeGreaterThan(0);
    const byModel: { model: string }[] = snapshot.body.telemetry.byModel;
    for (const row of byModel) expect(row.model).toBe(CRUSOE.OPENAI_MODEL);
  });
});
