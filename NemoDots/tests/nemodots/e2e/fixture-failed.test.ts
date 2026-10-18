// A fixture-mode server WITH a worker and a fixture file that holds no
// recorded responses. Fixture mode never improvises, so the planner's request
// has no entry and the mission fails for real: a failed FIXTURE mission, with
// its failure reason, produced by the production worker and coordinator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminRows,
  fixtureFile,
  openSession,
  ownerId,
  shot,
  startServer,
  until,
  type RunningServer,
  type Session,
} from './support/env.js';

let server: RunningServer;
let ses: Session;
const body = () => ses.page.locator('body').innerText();
const pill = () => ses.page.locator('.nd-mission-head .nd-pill').first();

beforeAll(async () => {
  server = await startServer({
    name: 'failed',
    ownerId: ownerId('failed'),
    env: {
      NEMODOTS_INFERENCE_MODE: 'fixture',
      NEMODOTS_FIXTURE_PATH: fixtureFile('failed'),
      OPENAI_MODEL: 'fixture-model',
      NEMODOTS_WORKERS: '1',
    },
  });
  ses = await openSession(server.url);
});
afterAll(async () => {
  await ses?.close();
  await server?.stop();
});

describe('a failed fixture mission', () => {
  it('fails honestly when the fixture has no answer, and says FIXTURE throughout', async () => {
    await ses.page.goto('/#/missions');
    const form = ses.page.getByRole('form', { name: 'Create mission' });
    await form
      .getByLabel('Goal')
      .fill('Restore checkout: fixture has no answer');
    await form.getByRole('button', { name: 'Create mission' }).click();
    await ses.page.getByRole('group', { name: 'Mission controls' }).waitFor();
    await ses.page.locator('.nd-mission-head .nd-mode-fixture').waitFor();
    await ses.page.getByRole('button', { name: 'Start' }).click();

    await until(
      'the mission to fail',
      async () => /failed/i.test((await pill().innerText()).trim()),
      60_000,
    );
    await ses.page.locator('.nd-mission-head .nd-mode-fixture').waitFor();
    expect(
      await ses.page.locator('.nd-mission-head .nd-mode-live').count(),
    ).toBe(0);
    expect(await body()).toContain(
      'FIXTURE mission: model responses are scripted fixtures',
    );

    // the reason is shown as text
    const facts = await ses.page.getByLabel('Mission facts').innerText();
    expect(facts).toContain('Failure reason');
    expect(facts).toMatch(/task [0-9a-f-]{36} failed/);
    await shot(ses.page, 'failed-fixture-mission');

    // why it failed: the fixture had no answer. The API does not expose an
    // attempt's failure text, so read it from storage.
    const missionId = ses.page.url().split('/#/missions/')[1];
    const reasons = await adminRows<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM coordinator.task_attempts WHERE mission_id = $1`,
      [missionId],
    );
    expect(reasons.length).toBeGreaterThan(0);
    for (const row of reasons)
      expect(row.failure_reason).toMatch(/no fixture for key/);
  });

  it('shows the failed planner task, no invented progress, and disabled controls with reasons', async () => {
    const tasks = ses.page.getByRole('list', { name: 'Tasks' });
    await tasks.waitFor();
    const text = await tasks.innerText();
    expect(text).toContain('Planner');
    expect(text).toMatch(/Failed/);
    expect(await tasks.locator('li').count()).toBe(1);
    const text2 = await body();
    expect(text2).toContain('No evidence changes or recoveries yet.');
    expect(text2).toContain('The acceptance probe has not run yet.');
    expect(text2).toContain('No actions proposed yet.');
    const controls = ses.page.getByRole('group', { name: 'Mission controls' });
    for (const name of ['Start', 'Pause', 'Resume', 'Cancel']) {
      const button = controls.getByRole('button', { name });
      expect(await button.isDisabled()).toBe(true);
      expect(await button.getAttribute('title')).toMatch(/failed/);
    }
  });

  it('survives a refresh and appears in the list as a failed Fixture mission', async () => {
    await ses.page.reload();
    await until('Failed after reload', async () =>
      /failed/i.test((await pill().innerText()).trim()),
    );
    await ses.page.goto('/#/missions');
    const row = ses.page
      .getByRole('list', { name: 'Mission list' })
      .getByRole('link')
      .filter({ hasText: 'fixture has no answer' });
    const text = await row.innerText();
    expect(text).toMatch(/failed/i);
    expect(text).toContain('Fixture');
  });
});
