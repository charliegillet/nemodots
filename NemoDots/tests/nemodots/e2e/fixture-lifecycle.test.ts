// A fixture-mode server with no workers: missions are created and started
// through the UI and sit in `running` because nothing claims their planner
// task. That is exactly what the lifecycle controls, the FIXTURE labels, the
// reconnect behaviour and keyboard access need, with no model involved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  fixtureFile,
  openSession,
  ownerId,
  shot,
  sleep,
  startServer,
  until,
  type RunningServer,
  type Session,
} from './support/env.js';

let server: RunningServer;
let ses: Session;

const body = () => ses.page.locator('body').innerText();
const pill = () => ses.page.locator('.nd-mission-head .nd-pill').first();
const statusIs = async (label: RegExp) =>
  label.test((await pill().innerText()).trim());
const button = (name: string) =>
  ses.page
    .getByRole('group', { name: 'Mission controls' })
    .getByRole('button', { name });

async function createThroughForm(
  goal: string,
  constraints: string[],
  minAgeMs: number,
) {
  await ses.page.goto('/#/missions');
  const form = ses.page.getByRole('form', { name: 'Create mission' });
  await form.getByLabel('Goal').waitFor();
  await form.getByLabel('Goal').fill(goal);
  await form.getByLabel(/Constraints/).fill(constraints.join('\n'));
  await form.getByLabel(/Admission delay/).fill(String(minAgeMs));
  await form.getByRole('button', { name: 'Create mission' }).click();
  await ses.page.getByRole('group', { name: 'Mission controls' }).waitFor();
  return ses.page.url().split('/#/missions/')[1];
}

const serverEnv = {
  NEMODOTS_INFERENCE_MODE: 'fixture',
  NEMODOTS_FIXTURE_PATH: fixtureFile('lifecycle'),
  OPENAI_MODEL: 'fixture-model',
  NEMODOTS_WORKERS: '0',
};

beforeAll(async () => {
  server = await startServer({
    name: 'lifecycle',
    ownerId: ownerId('lifecycle'),
    env: serverEnv,
  });
  ses = await openSession(server.url);
});
afterAll(async () => {
  await ses?.close();
  await server?.stop();
});

describe('the Fixture label', () => {
  it('labels the server FIXTURE, never Live, and says what fixture means', async () => {
    await ses.page.goto('/#/missions');
    await ses.page
      .getByRole('heading', { name: 'Missions', level: 1 })
      .waitFor();
    await ses.page.locator('.nd-mode-fixture').first().waitFor();
    expect(await ses.page.locator('.nd-mode-live').count()).toBe(0);
    expect(await ses.page.locator('.nd-mode-blocked').count()).toBe(0);
    const text = await body();
    expect(text).toContain('Fixture');
    expect(text).toContain('scripted model responses, not a live model');
    // fixture mode needs no key, so the create form is usable
    const form = ses.page.getByRole('form', { name: 'Create mission' });
    expect(await form.getByLabel('Goal').isEnabled()).toBe(true);
    await shot(ses.page, 'fixture-setup');
  });
});

describe('lifecycle controls', () => {
  let missionId: string;

  it('creates a mission from the form with goal, constraints and an admission delay', async () => {
    missionId = await createThroughForm(
      'Restore checkout: lifecycle walk-through',
      ['Change only what the evidence supports.', 'Do not flush caches.'],
      1500,
    );
    expect(missionId).toMatch(/^[0-9a-f-]{36}$/);
    const head = ses.page.getByLabel('Mission summary');
    await head
      .getByRole('heading', {
        name: 'Restore checkout: lifecycle walk-through',
      })
      .waitFor();
    expect(await head.innerText()).toContain(
      'Restore checkout: lifecycle walk-through',
    );
    const constraints = await head.getByLabel('Constraints').innerText();
    expect(constraints).toContain('Do not flush caches.');
    expect(await head.getByLabel('Mission facts').innerText()).toContain(
      '1,500 ms',
    );
    await ses.page.locator('.nd-mission-head .nd-mode-fixture').waitFor();
    expect(
      await ses.page.locator('.nd-mission-head .nd-mode-live').count(),
    ).toBe(0);
    expect(await body()).toContain(
      'FIXTURE mission: model responses are scripted fixtures',
    );
    await until('status Created', () => statusIs(/created/i));
    await shot(ses.page, 'lifecycle-created');
  });

  it('enables only what applies to the status and says why the rest are unavailable', async () => {
    expect(await button('Start').isEnabled()).toBe(true);
    expect(await button('Cancel').isEnabled()).toBe(true);
    for (const name of ['Pause', 'Resume']) {
      expect(await button(name).isDisabled()).toBe(true);
      expect(await button(name).getAttribute('title')).toMatch(
        /applies to a (running|paused) mission/,
      );
    }
  });

  it('start, pause, resume and cancel each change the status shown as text', async () => {
    await button('Start').click();
    await until('Running', () => statusIs(/running/i));
    expect(await button('Pause').isEnabled()).toBe(true);
    expect(await button('Start').isDisabled()).toBe(true);

    await button('Pause').click();
    await until('Paused', () => statusIs(/paused/i));
    expect(await button('Resume').isEnabled()).toBe(true);
    await shot(ses.page, 'lifecycle-paused');

    await button('Resume').click();
    await until('Running again', () => statusIs(/running/i));

    await button('Cancel').click();
    await until('Cancelled', () => statusIs(/cancel/i));
    for (const name of ['Start', 'Pause', 'Resume', 'Cancel'])
      expect(await button(name).isDisabled()).toBe(true);
    await shot(ses.page, 'lifecycle-cancelled');
  });

  it('keeps the final state across a refresh and lists the mission with its Fixture marker', async () => {
    await ses.page.reload();
    await ses.page.getByRole('group', { name: 'Mission controls' }).waitFor();
    await until('Cancelled after reload', () => statusIs(/cancel/i));
    await ses.page.goto('/#/missions');
    const list = ses.page.getByRole('list', { name: 'Mission list' });
    await list.waitFor();
    const row = list
      .getByRole('link')
      .filter({ hasText: 'lifecycle walk-through' });
    const text = await row.innerText();
    expect(text).toMatch(/cancel/i);
    expect(text).toContain('Fixture');
  });
});

describe('refresh, reconnect and deduplication', () => {
  let missionId: string;
  const taskRows = () =>
    ses.page.getByRole('list', { name: 'Tasks' }).locator('li');

  it('reconnects after the server vanishes and returns, catches up once, and does not duplicate rows', async () => {
    const created = await apiCall(server, '/nemodots/missions', {
      method: 'POST',
      body: { goal: 'Restore checkout: reconnect walk-through' },
    });
    expect(created.status).toBe(201);
    missionId = created.body.id;
    await apiCall(server, `/nemodots/missions/${missionId}/start`, {
      method: 'POST',
      body: {},
    });

    await ses.page.goto(`/#/missions/${missionId}`);
    await ses.page.getByText('Live updates: Open').waitFor();
    await taskRows().first().waitFor();
    const before = await taskRows().count();
    expect(before).toBe(1);
    expect(await body()).toContain('Plan the mission');
    await until('Running', () => statusIs(/running/i));

    // The process disappears without a goodbye (SIGKILL). The page must say so.
    await server.kill();
    await ses.page
      .getByText(/Live updates: Reconnecting/)
      .waitFor({ timeout: 30_000 });
    expect(await body()).toContain('refreshing from storage every 3 seconds');
    await shot(ses.page, 'reconnect-server-down');

    // It comes back on the same port; state lives in PostgreSQL, not in the process.
    server = await startServer({
      name: 'lifecycle',
      ownerId: server.ownerId,
      port: server.port,
      appendLog: true,
      env: serverEnv,
    });
    const paused = await apiCall(
      server,
      `/nemodots/missions/${missionId}/pause`,
      {
        method: 'POST',
        body: {},
      },
    );
    expect(paused.status).toBe(200);

    await ses.page.getByText('Live updates: Open').waitFor({ timeout: 45_000 });
    await until(
      'the pause shows after reconnect',
      () => statusIs(/paused/i),
      20_000,
    );
    // the replayed events did not create a second planner row
    expect(await taskRows().count()).toBe(before);
    await shot(ses.page, 'reconnect-recovered');
  });

  it('rebuilds the same page from the server snapshot after a refresh', async () => {
    const live = {
      tasks: await taskRows().allInnerTexts(),
      status: (await pill().innerText()).trim(),
    };
    await ses.page.reload();
    await ses.page.getByText('Live updates: Open').waitFor();
    await taskRows().first().waitFor();
    expect(await taskRows().allInnerTexts()).toEqual(live.tasks);
    expect((await pill().innerText()).trim()).toBe(live.status);
  });
});

describe('keyboard access and telemetry', () => {
  it('starts a mission with the keyboard alone', async () => {
    const created = await apiCall(server, '/nemodots/missions', {
      method: 'POST',
      body: { goal: 'Restore checkout: keyboard walk-through' },
    });
    await ses.page.goto(`/#/missions/${created.body.id}`);
    await ses.page.getByRole('group', { name: 'Mission controls' }).waitFor();
    await until('Created', () => statusIs(/created/i));
    let focused = '';
    for (let i = 0; i < 40 && focused !== 'Start'; i += 1) {
      await ses.page.keyboard.press('Tab');
      focused = await ses.page.evaluate(
        () =>
          (document.activeElement as HTMLElement | null)?.textContent?.trim() ??
          '',
      );
    }
    expect(focused).toBe('Start');
    await ses.page.keyboard.press('Enter');
    await until('Running', () => statusIs(/running/i));
    await ses.page.keyboard.press('Shift+Tab');
    await sleep(100);
  });

  it('says unavailable, not zero, for figures that were never measured', async () => {
    const panel = ses.page.getByRole('region', { name: /telemetry/i }).first();
    await panel.waitFor();
    const text = await panel.innerText();
    expect(text).toMatch(/Cached tokens\s*\n?\s*unavailable/i);
    expect(text).toMatch(/Time to first token\s*\n?\s*unavailable/i);
    await shot(ses.page, 'telemetry-unavailable');
  });

  it('gives every status in the mission page a text label, not only a colour', async () => {
    const pills = ses.page.locator('.nd-pill');
    const count = await pills.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1)
      expect((await pills.nth(i).innerText()).trim().length).toBeGreaterThan(0);
  });
});
