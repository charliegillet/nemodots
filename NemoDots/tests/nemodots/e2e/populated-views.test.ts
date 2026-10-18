// The mission page populated by production code. A fixture-mode server runs
// the coordinator outbox, watcher, action admission and acceptance probe; the
// seeder plays only the model (see support/seed.ts). Two fixture missions:
//
//   changed evidence  a proposal waits out its admission delay while the person
//                     edits the same setting through the page, which drives the
//                     real sequence: receipt superseded, action blocked,
//                     recovery scheduled, shown in the recovery timeline.
//   healthy           two read-only tasks; the real acceptance probe settles it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  fixtureFile,
  openSession,
  ownerId,
  shot,
  startServer,
  until,
  type RunningServer,
  type Session,
} from './support/env.js';
import { openSeeder, type Seeder } from './support/seed.js';
import {
  seedChangedEvidenceMission,
  seedHealthyMission,
  type ChangedEvidenceMission,
} from './support/scenarios.js';

const OWNER = ownerId('populated');
let server: RunningServer;
let seeder: Seeder;
let ses: Session;
let changed: ChangedEvidenceMission;
let healthy: { missionId: string; taskIds: string[] };

const body = () => ses.page.locator('body').innerText();
const missionPill = () => ses.page.locator('.nd-mission-head .nd-pill').first();
const section = (name: string | RegExp) =>
  ses.page.getByRole('region', { name });
const timeline = () =>
  ses.page
    .getByRole('list', { name: 'Recovery events in order' })
    .locator('li');

async function open(missionId: string) {
  await ses.page.goto(`/#/missions/${missionId}`);
  await ses.page.getByRole('group', { name: 'Mission controls' }).waitFor();
  await ses.page.getByText('Live updates: Open').waitFor();
}

beforeAll(async () => {
  const fixture = fixtureFile('populated');
  server = await startServer({
    name: 'populated',
    ownerId: OWNER,
    env: {
      NEMODOTS_INFERENCE_MODE: 'fixture',
      NEMODOTS_FIXTURE_PATH: fixture,
      OPENAI_MODEL: 'fixture-model',
      NEMODOTS_WORKERS: '0',
    },
  });
  seeder = await openSeeder({ ownerId: OWNER, fixturePath: fixture });
  await seeder.restoreHealthy();
  const ref = { url: server.url, ownerId: OWNER };
  healthy = await seedHealthyMission(seeder, ref);
  await until(
    'the healthy mission to succeed',
    async () => {
      const snap = await apiCall(
        server,
        `/nemodots/missions/${healthy.missionId}`,
      );
      return snap.body.mission.status === 'succeeded';
    },
    60_000,
  );
  // the proposal waits 45 s for admission: the window for the edit below
  changed = await seedChangedEvidenceMission(seeder, ref, { minAgeMs: 45_000 });
  ses = await openSession(server.url);
});
afterAll(async () => {
  await ses?.close();
  await seeder?.close();
  await server?.stop();
});

describe('changed evidence, before the change', () => {
  it('shows the task tree, findings as claims, and the action as proposed', async () => {
    await open(changed.missionId);
    const tasks = await ses.page
      .getByRole('list', { name: 'Tasks' })
      .innerText();
    for (const title of [
      'Plan the mission',
      'Find what is failing',
      'Propose a configuration fix',
    ])
      expect(tasks).toContain(title);
    expect(tasks.match(/Succeeded/g)?.length).toBe(3);
    expect(tasks).toContain('Database specialist');

    const text = await body();
    expect(text).toContain(
      'Findings are claims made by a model. They are not evidence until backed by a receipt.',
    );
    expect(
      await ses.page.locator('.nd-claim, [data-claim]').count(),
    ).toBeGreaterThanOrEqual(0);
    expect(text).toMatch(/CLAIM/);

    const inspector = await section('Action inspector').innerText();
    expect(inspector).toContain('Proposed');
    expect(inspector).toContain('checkout.config/db.pool_max');
    expect(inspector).toContain('Admission stage: not decided yet');
    await shot(ses.page, 'populated-changed-before');
  });

  it('selecting a task narrows the findings to that task, and selecting it again clears it', async () => {
    const tree = ses.page.getByRole('list', { name: 'Tasks' });
    const finder = tree.getByRole('button', { name: /Find what is failing/ });
    await finder.click();
    expect(await finder.getAttribute('aria-current')).toBe('true');
    const narrowed = await body();
    expect(narrowed).toContain(
      'The connection pool limit is the setting under suspicion.',
    );
    expect(narrowed).not.toContain('Raising db.pool_max is the proposed fix.');
    await finder.click();
    expect(await body()).toContain('Raising db.pool_max is the proposed fix.');
  });

  it('shows the evidence ledger with revisions, status as text and a last-confirmed time that advances', async () => {
    const table = ses.page.getByRole('table', { name: 'Evidence receipts' });
    const rows = table.locator('tbody tr');
    expect(await rows.count()).toBe(2);
    const pool = rows.filter({ hasText: 'checkout.config/db.pool_max' });
    const health = rows.filter({ hasText: 'checkout.health' });
    const poolText = await pool.innerText();
    expect(poolText).toContain('Supported');
    expect(poolText).toContain('Controlled authority');
    expect(poolText).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    const lastConfirmed = async () =>
      (await health.innerText()).match(
        /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/,
      )![0];
    const first = await lastConfirmed();
    // the watcher polls every second and records a confirmation each time the
    // observed value is unchanged
    // (the page re-reads the snapshot every 30 s while the stream is open)
    await until(
      'lastConfirmedAt to advance',
      async () => (await lastConfirmed()) !== first,
      60_000,
      1000,
    );
  });

  it('shows scheduling and evidence dependencies apart, by text', async () => {
    const deps = await section('Dependencies').innerText();
    expect(deps).toContain('Scheduling edges (1)');
    expect(deps).toContain('Evidence edges (6)');
    expect(deps).toMatch(/checkout\.config\/db\.pool_max rev \d+/);
    expect(deps).toContain('is relied on by');
  });
});

describe('changed evidence: the person edits the same setting', () => {
  let beforeEntries = 0;

  it('shows the real recovery sequence, in order, after the manual edit', async () => {
    expect(await timeline().count()).toBe(0);
    const form = ses.page.getByRole('form', { name: 'Manual source edit' });
    await form
      .getByLabel('Source')
      .selectOption({ value: 'checkout.config/db.pool_max' });
    await form.getByLabel('Value type').selectOption('number');
    await form.getByLabel('New value').fill('12');
    await form.getByRole('button', { name: 'Apply edit' }).click();
    await form
      .getByText(
        `checkout.config/db.pool_max is now at version ${changed.proposedFromRevision + 1}.`,
      )
      .waitFor();

    await until(
      'the recovery timeline to fill',
      async () => (await timeline().count()) >= 4,
      30_000,
    );
    const entries = await timeline().allInnerTexts();
    beforeEntries = entries.length;
    const flat = entries.join('\n');
    const at = (needle: RegExp) =>
      entries.findIndex((entry) => needle.test(entry));
    const blocked = at(/admission blocked/i);
    const invalidated = at(
      /Invalidation recorded: newer observation on checkout\.config\/db\.pool_max/,
    );
    const repair = at(/repair scheduled/i);
    const intent = at(/intent blocked/i);
    for (const index of [blocked, invalidated, repair, intent])
      expect(index).toBeGreaterThanOrEqual(0);
    expect(invalidated).toBeLessThan(repair);
    expect(repair).toBeLessThanOrEqual(intent);
    expect(flat).toMatch(/Affects \d+ tasks?, \d+ attempts?, 1 action/);
    // event ids shown as text are ascending
    const ids = entries.map((entry) =>
      Number(/event (\d+)/.exec(entry)?.[1] ?? NaN),
    );
    expect(ids.every((id) => Number.isFinite(id))).toBe(true);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    await shot(ses.page, 'populated-changed-after');
  });

  it('marks the superseded receipt and registers the new revision', async () => {
    const rows = ses.page
      .getByRole('table', { name: 'Evidence receipts' })
      .locator('tbody tr');
    await until(
      'the new revision',
      async () =>
        (await rows
          .filter({ hasText: 'checkout.config/db.pool_max' })
          .count()) >= 1,
      15_000,
    );
    const poolRows = await rows
      .filter({ hasText: 'checkout.config/db.pool_max' })
      .allInnerTexts();
    expect(poolRows.join('\n')).toContain('Superseded');
  });

  it('shows the blocked action with its reason, the live version and a Stale freshness label', async () => {
    const inspector = section('Action inspector');
    await until(
      'Blocked',
      async () => (await inspector.innerText()).includes('Blocked'),
      20_000,
    );
    const text = await inspector.innerText();
    expect(text).toContain('Block reason: Stale version');
    expect(text).toContain(
      `Target version: expected ${changed.proposedFromRevision}, live ${changed.proposedFromRevision + 1}`,
    );
    expect(text).toContain(`rev ${changed.proposedFromRevision + 1} (changed)`);
    expect(text).toContain('Stale');
    expect(text).toContain('Superseded');
    // the stage is a labelled region, so it is reachable without colour
    expect(
      (await ses.page.getByRole('group', { name: /Admission stage/ }).count()) +
        (await ses.page.getByLabel('Admission stage').count()),
    ).toBeGreaterThan(0);
  });

  it('shows the invalidated work as no longer succeeded, and the mission still running', async () => {
    const tasks = await ses.page
      .getByRole('list', { name: 'Tasks' })
      .innerText();
    expect(tasks.match(/Succeeded/g)?.length ?? 0).toBeLessThan(3);
    // repair work was scheduled, so the mission leaves awaiting acceptance
    await until(
      'the mission to be running again',
      async () => /running/i.test((await missionPill().innerText()).trim()),
      30_000,
    );
    expect(await body()).toContain('marked unusable');
  });

  it('rebuilds the same facts from the server snapshot after a refresh, without duplicating entries', async () => {
    await ses.page.reload();
    await ses.page.getByText('Live updates: Open').waitFor();
    const inspector = section('Action inspector');
    await until('Blocked after reload', async () =>
      (await inspector.innerText()).includes('Blocked'),
    );
    const text = await inspector.innerText();
    expect(text).toContain(
      `Target version: expected ${changed.proposedFromRevision}, live ${changed.proposedFromRevision + 1}`,
    );
    await until('timeline rebuilt', async () => (await timeline().count()) > 0);
    const rebuilt = (await timeline().allInnerTexts()).join('\n');
    expect(rebuilt).toMatch(/repair scheduled/i);
    expect(rebuilt).toMatch(/Invalidation recorded/);
    // each recovery event appears at most once
    const eventIds = [...rebuilt.matchAll(/event (\d+)/g)].map((m) => m[1]);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(await timeline().count()).toBeGreaterThanOrEqual(1);
    expect(beforeEntries).toBeGreaterThanOrEqual(4);
  });
});

describe('a succeeded fixture mission', () => {
  it('shows Succeeded with the FIXTURE badge, never Live', async () => {
    await open(healthy.missionId);
    await until(
      'Succeeded',
      async () => /succeeded/i.test(await missionPill().innerText()),
      20_000,
    );
    await ses.page.locator('.nd-mission-head .nd-mode-fixture').waitFor();
    expect(
      await ses.page.locator('.nd-mission-head .nd-mode-live').count(),
    ).toBe(0);
    expect(await body()).toContain(
      'FIXTURE mission: model responses are scripted fixtures',
    );
    for (const name of ['Start', 'Pause', 'Resume', 'Cancel'])
      expect(
        await ses.page
          .getByRole('group', { name: 'Mission controls' })
          .getByRole('button', { name })
          .isDisabled(),
      ).toBe(true);
    await shot(ses.page, 'populated-succeeded');
  });

  it('shows the verification result from the real acceptance probe', async () => {
    const probe = section(/acceptance probe/i);
    await probe.waitFor();
    await until(
      'probe result',
      async () => !(await probe.innerText()).includes('has not run yet'),
      20_000,
    );
    const text = await probe.innerText();
    expect(text).toMatch(/pass/i);
    const invariants = await ses.page
      .getByRole('list', { name: 'Acceptance invariants' })
      .innerText();
    expect(invariants.length).toBeGreaterThan(0);
    await shot(ses.page, 'populated-probe');
  });

  it('shows evidence, empty actions and recovery states honestly', async () => {
    const text = await body();
    expect(text).toContain('No actions proposed yet.');
    expect(text).toContain('No evidence changes or recoveries yet.');
    const rows = ses.page
      .getByRole('table', { name: 'Evidence receipts' })
      .locator('tbody tr');
    expect(await rows.count()).toBe(2);
  });

  it('says unavailable for telemetry the fixture never measured', async () => {
    const telemetry = await section(/telemetry/i)
      .first()
      .innerText();
    expect(telemetry).toMatch(/Cached tokens\s*\n?\s*unavailable/i);
    expect(telemetry).toMatch(/Time to first token\s*\n?\s*unavailable/i);
  });

  it('saves an evidence page with one receipt id and revision per line and links back to it', async () => {
    await ses.page.getByRole('button', { name: 'Save evidence page' }).click();
    const saved = ses.page.getByRole('status').filter({ hasText: /^Saved/ });
    await saved.waitFor();
    await saved.getByRole('link').click();
    await ses.page.waitForURL(/#\/spaces\/[^/]+\/pages\/[^/]+/);
    await ses.page
      .getByText(/ledger fact/)
      .first()
      .waitFor({ timeout: 15_000 });
    const page = await body();
    expect(page).toMatch(/ledger fact [0-9a-f-]{36} rev \d+/);
    expect(page).toContain('checkout.health');
    await shot(ses.page, 'populated-projection');
  });
});
