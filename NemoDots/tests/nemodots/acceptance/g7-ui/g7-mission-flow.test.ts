// Gate 7 against one real live mission on Crusoe/Nemotron plus the injected
// checkout fault, driven through system Chrome. The server snapshot, events
// and typed contracts are the oracle; the UI must show what they say.
// Cases: G7.1 lifecycle, G7.3 evidence, G7.4 task tree, G7.5 action inspector,
// G7.6 recovery timeline, G7.7 verification, G7.8 reconnect/dedup, G7.9
// keyboard, G7.10 non-colour text, G7.12 bounded rendering, G7.13 terminal
// states, G7.14 page projection, G7.15 telemetry.
//
// A scenario that never produces an action or an invalidation makes the
// dependent UI case FAIL with that reason (not skip): the gate needs a trial
// where the team actually proposed and recovered.
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { MissionSnapshot } from '../../../../src/server/nemodots/contracts/index.js';
import {
  CONSTRAINTS,
  GOAL,
  MISSION_ALLOWED,
  NemoApi,
  isTerminal,
  waitForSnapshot,
} from './helpers/api.js';
import { liveCredentials, until } from './helpers/env.js';
import { MissionPage, receiptFacts } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import { humanize, launchChrome, newPage } from './helpers/ui.js';

// Scenario class names are the ids of the injector manifests; the injector is
// a builder module, so this name is recorded as a dependency of this suite.
const SCENARIO_FAULT = 'repairable-checkout-fault';
const LONG = 10 * 60_000;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let browser: Browser;
let stack: Acc7Stack;
let api: NemoApi;
let missionId: string;

beforeAll(async () => {
  const creds = liveCredentials();
  if (!creds.ok)
    throw new Error(
      `BLOCKED: live mission flow needs ${creds.missing.join(', ')}`,
    );
  browser = await launchChrome();
  stack = await Acc7Stack.start({ mode: 'live' });
  api = new NemoApi(stack.authHeaders);
  const mission = await api.createMission({
    goal: GOAL,
    constraints: CONSTRAINTS,
    mode: 'live',
    // Gives a scenario-driven dependent change time to land before admission.
    admission: { minAgeMs: 3000 },
  });
  missionId = mission.id;
});
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

/** Opens the mission page in a fresh context. The caller closes the context. */
async function open(id = missionId) {
  const handle = await newPage(browser);
  const mp = new MissionPage(handle.page);
  await handle.page.goto(`/#/missions/${id}`);
  return { ...handle, mp };
}

describe('lifecycle controls (G7.1)', () => {
  it('[G7.1] a created mission offers Start and Cancel; Pause and Resume are disabled; status is text', async () => {
    const { context, mp } = await open();
    try {
      await mp.expectStatus('created');
      await expect(mp.start).toBeEnabled();
      await expect(mp.cancel).toBeEnabled();
      await expect(mp.pause).toBeDisabled();
      await expect(mp.resume).toBeDisabled();
      await expect(mp.main).toContainText(/min(imum)? age|admission/i);
    } finally {
      await context.close();
    }
  });

  it('[G7.1] Start from the UI moves the server mission to running (fault injected first)', async () => {
    await api.injectorRun(SCENARIO_FAULT);
    const { context, mp } = await open();
    try {
      await mp.start.click();
      await until(
        'server mission running',
        async () =>
          (await api.snapshot(missionId)).mission.status === 'running',
      );
      await mp.expectStatus('running');
      await expect(mp.start).toBeDisabled();
      await expect(mp.pause).toBeEnabled();
      await expect(mp.cancel).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  it('[G7.1] Pause then Resume from the UI match server state and follow the transition table; illegal transitions are 409', async () => {
    const { context, mp } = await open();
    try {
      await mp.pause.click();
      const paused = await until('server mission paused', async () => {
        const s = await api.snapshot(missionId);
        return s.mission.status === 'paused' ? s : null;
      });
      await mp.expectStatus('paused');
      expect(MISSION_ALLOWED.paused).toContain('running');
      await expect(mp.resume).toBeEnabled();
      await expect(mp.pause).toBeDisabled();
      expect(await api.lifecycleStatus(missionId, 'pause')).toBe(409);
      expect(await api.lifecycleStatus(missionId, 'start')).toBe(409);
      await mp.resume.click();
      const resumed = await until('server mission running again', async () => {
        const s = await api.snapshot(missionId);
        return s.mission.status === 'running' ? s : null;
      });
      await mp.expectStatus('running');
      expect(resumed.mission.transitionVersion).toBeGreaterThan(
        paused.mission.transitionVersion,
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.1] a server refusal (409) is shown as an alert and the UI does not pretend the transition happened', async () => {
    const { context, page, mp } = await open();
    try {
      await page.route(`**/api/nemodots/missions/${missionId}/pause`, (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: '{"error":"Mission cannot be paused right now."}',
        }),
      );
      await mp.pause.click();
      await expect(mp.main.getByRole('alert').first()).toContainText(
        /cannot be paused/i,
      );
      await mp.expectStatus((await api.snapshot(missionId)).mission.status);
    } finally {
      await context.close();
    }
  });
});

describe('task tree (G7.4)', () => {
  it('[G7.4] every server task is listed with role and status text, nested under its parent with the delegation justification', async () => {
    await waitForSnapshot(
      api,
      missionId,
      'planner output: at least 2 tasks',
      (s) => s.tasks.length >= 2,
      180_000,
    );
    const { context, mp } = await open();
    try {
      const live = await api.snapshot(missionId);
      for (const task of live.tasks)
        await expect(
          mp.taskTree
            .getByText(task.title.slice(0, 60), { exact: false })
            .first(),
          `task "${task.title}"`,
        ).toBeVisible();
      const text = (await mp.taskTree.innerText()).toLowerCase();
      for (const task of live.tasks) {
        expect(text, `role text for ${task.title}`).toContain(
          humanize(task.role).toLowerCase(),
        );
      }
      for (const child of live.tasks.filter((t) => t.parentId !== null)) {
        const parent = live.tasks.find((t) => t.id === child.parentId)!;
        await expect(
          mp.taskTree.getByRole('list', {
            name: `Subtasks of ${parent.title}`,
          }),
          `child "${child.title}" nested under "${parent.title}"`,
        ).toContainText(child.title.slice(0, 40));
        expect(
          child.justification,
          'a delegated task carries a justification',
        ).toBeTruthy();
        await expect(mp.taskTree).toContainText(
          child.justification!.slice(0, 40),
        );
      }
    } finally {
      await context.close();
    }
  });
});

describe('evidence ledger and drilldown (G7.3)', () => {
  it('[G7.3] every receipt row shows source key, revision, status, trust; Enter on a row opens a typed drilldown', async () => {
    await waitForSnapshot(
      api,
      missionId,
      'first receipts',
      (s) => s.receipts.length >= 1,
      240_000,
    );
    const { context, page, mp } = await open();
    try {
      const facts = receiptFacts(await api.snapshot(missionId));
      const rows = mp.ledger.getByRole('row');
      for (const f of facts) {
        const row = rows
          .filter({ hasText: f.sourceKey })
          .filter({ hasText: f.shortId })
          .first();
        await expect(
          row,
          `receipt ${f.shortId} for ${f.sourceKey}`,
        ).toBeVisible();
        await expect(row).toContainText(String(f.revision));
        await expect(row).toContainText(new RegExp(humanize(f.status), 'i'));
        await expect(row).toContainText(new RegExp(humanize(f.trust), 'i'));
      }
      const first = facts[0]!;
      const trigger = mp.ledger
        .getByRole('button', { name: new RegExp(esc(first.sourceKey)) })
        .first();
      await mp.tabTo(trigger);
      await page.keyboard.press('Enter');
      const detail = page
        .getByRole('dialog')
        .or(mp.region(/receipt/i))
        .or(page.getByRole('complementary', { name: /receipt/i }))
        .first();
      await expect(
        detail,
        'a receipt detail is shown after Enter',
      ).toBeVisible();
      await expect(detail).toContainText(first.id.slice(0, 8));
      await expect(detail).toContainText(first.digest.slice(0, 12));
      await expect(detail).toContainText(
        new RegExp(humanize(first.trust), 'i'),
      );
      await expect(detail).toContainText(
        new RegExp(humanize(first.provenanceKind), 'i'),
      );
      await expect(detail).toContainText(String(first.revision));
    } finally {
      await context.close();
    }
  });

  it('[G7.3] model claims are labelled "claim" and never appear in the receipt table', async () => {
    await waitForSnapshot(
      api,
      missionId,
      'a published finding or a terminal mission',
      (s) => s.findings.length >= 1 || isTerminal(s.mission.status),
      LONG,
    );
    const snap = await api.snapshot(missionId);
    const { context, mp } = await open();
    try {
      if (snap.findings.length === 0) {
        await expect(mp.findings).toContainText(
          /no findings|nothing to show|no claims/i,
        );
      } else {
        const claim = (snap.findings[0]!.claim ?? '').slice(0, 50);
        await expect(mp.findings).toContainText(/claim/i);
        await expect(mp.findings).toContainText(claim);
        expect(await mp.ledger.innerText()).not.toContain(claim);
      }
    } finally {
      await context.close();
    }
  });
});

describe('telemetry (G7.15)', () => {
  it('[G7.15] telemetry equals the server summary; unavailable values read "unavailable"; no invented prices or savings', async () => {
    await waitForSnapshot(
      api,
      missionId,
      'model calls recorded',
      (s) => s.telemetry.calls >= 1,
      180_000,
    );
    const summary = await api.telemetry(missionId);
    const { context, mp } = await open();
    try {
      const text = (await mp.telemetry.innerText()).replace(/\s+/g, ' ');
      expect(text).toMatch(/model calls\s*[\d,]+/i);
      if (!summary.tokens.cached.available)
        expect(text).toMatch(/cached tokens\s*unavailable/i);
      else expect(text).toMatch(/cached tokens\s*[\d,]+/i);
      if (summary.ttftMs === null)
        expect(text).toMatch(/time to first token\s*unavailable/i);
      // TelemetrySummary carries no prices or savings, so none may be displayed.
      expect(await mp.text()).not.toMatch(
        /\$\s?\d|\bsav(?:e|ed|ing|ings)\b|cheaper|cost reduction|% (?:faster|fewer|less)/i,
      );
    } finally {
      await context.close();
    }
  });
});

describe('action inspector (G7.5) and recovery timeline (G7.6)', () => {
  it('[G7.5] each proposed action shows kind, status text and payload hash; selecting one shows every authorization stage, decision, block reason, versions, checked vector, fence and script result', async () => {
    await waitForSnapshot(
      api,
      missionId,
      'at least one proposed action (the team must attempt a repair)',
      (s) => s.actions.length >= 1,
      LONG,
    );
    await until(
      'an authorization for the first action',
      async () => {
        const s = await api.snapshot(missionId);
        return s.authorizations.some((a) => a.actionId === s.actions[0]!.id);
      },
      { timeoutMs: 120_000 },
    );
    const snapshot = await api.snapshot(missionId);
    const { context, page, mp } = await open();
    try {
      for (const action of snapshot.actions) {
        const item = mp.actions
          .getByRole('listitem')
          .filter({ hasText: action.payloadHash.slice(0, 8) })
          .first();
        await expect(
          item,
          `action ${action.id.slice(0, 8)} listed`,
        ).toBeVisible();
        await expect(item).toContainText(
          new RegExp(humanize(action.status), 'i'),
        );
        await expect(item).toContainText(
          new RegExp(humanize(action.action), 'i'),
        );
      }
      const action = snapshot.actions[0]!;
      const select = mp.actions
        .getByRole('button', { name: new RegExp(action.id.slice(0, 8)) })
        .first();
      await mp.tabTo(select);
      await page.keyboard.press('Enter');
      const decisions = snapshot.authorizations.filter(
        (a) => a.actionId === action.id,
      );
      expect(decisions.length).toBeGreaterThan(0);
      for (const d of decisions) {
        await expect(
          mp.inspector.getByText(new RegExp(humanize(d.stage), 'i')).first(),
          `stage ${d.stage}`,
        ).toBeVisible();
        await expect(mp.inspector).toContainText(
          new RegExp(humanize(d.decision), 'i'),
        );
        if (d.blockReason)
          await expect(mp.inspector).toContainText(
            new RegExp(humanize(d.blockReason), 'i'),
          );
        await expect(mp.inspector).toContainText(
          String(d.targetVersion.expected),
        );
        await expect(mp.inspector).toContainText(String(d.targetVersion.live));
        if (d.dispatchFence !== null)
          await expect(mp.inspector).toContainText(/fence/i);
      }
      const checked = decisions[decisions.length - 1]!.checkedVector;
      if (Array.isArray(checked) && checked.length > 0)
        await expect(
          mp.inspector
            .getByRole('table', { name: 'Checked dependency vector' })
            .getByRole('row'),
        ).toHaveCount(checked.length + 1);
      const result = snapshot.results.find((r) => r.actionId === action.id);
      if (result?.externalEffect)
        await expect(mp.inspector).toContainText(
          new RegExp(
            humanize(result.externalEffect.scriptResult ?? 'unknown'),
            'i',
          ),
        );
      for (const blocked of snapshot.actions.filter(
        (x) => x.status === 'blocked',
      ))
        expect(
          blocked.blockReason,
          'a blocked action has a reason on the server',
        ).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  it('[G7.6] the recovery timeline lists invalidated sources and recovery steps in server order, naming the preserved branches', async () => {
    await waitForSnapshot(
      api,
      missionId,
      'an invalidation or recovery (the dependent change must be detected)',
      (s) => s.invalidations.length >= 1 || s.recoveries.length >= 1,
      LONG,
    );
    const snapshot = await api.snapshot(missionId);
    const { context, mp } = await open();
    try {
      const items = mp.recovery
        .getByRole('list', { name: 'Recovery events in order' })
        .getByRole('listitem');
      await expect(items.first()).toBeVisible();
      const joined = (await items.allInnerTexts())
        .map((t) => t.replace(/\s+/g, ' '))
        .join(' | ');
      for (const inv of snapshot.invalidations)
        if (inv.sourceKey) expect(joined).toContain(inv.sourceKey);
      let cursor = -1;
      for (const rec of [...snapshot.recoveries].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      )) {
        const at = joined
          .toLowerCase()
          .indexOf(humanize(rec.kind).toLowerCase(), Math.max(cursor, 0));
        expect(
          at,
          `recovery step "${humanize(rec.kind)}" appears in order`,
        ).toBeGreaterThanOrEqual(0);
        cursor = at;
      }
      const events = await api.events(missionId, {
        lastEventId: 0,
        maxMs: 6000,
      });
      for (const e of events) {
        if (
          e.payload.kind === 'invalidation.recorded' &&
          e.payload.preserved.taskIds.length > 0
        )
          expect(joined).toMatch(/preserved|kept|unaffected/i);
        if (e.payload.kind === 'attempt.started' && e.payload.repairOf !== null)
          expect(joined, 'a repair attempt appears in the timeline').toMatch(
            /repair/i,
          );
      }
    } finally {
      await context.close();
    }
  });
});

describe('reconnect, dedup and reconstruction (G7.8)', () => {
  it('[G7.8] a reload mid-run reconstructs the same tasks and receipts as the server snapshot', async () => {
    const { context, page, mp } = await open();
    try {
      const before = await api.snapshot(missionId);
      await page.reload();
      await expect(mp.taskTree).toBeVisible();
      for (const task of before.tasks)
        await expect(mp.taskTree).toContainText(task.title.slice(0, 40));
      for (const f of receiptFacts(before))
        await expect(mp.ledger).toContainText(f.shortId);
    } finally {
      await context.close();
    }
  });

  it('[G7.8] duplicated and reversed stream frames never double-count tasks, receipts or recovery items', async () => {
    const snap = await api.snapshot(missionId);
    const events = await api.events(missionId, { lastEventId: 0, maxMs: 6000 });
    expect(events.length).toBeGreaterThan(0);
    const frames = (list: typeof events) =>
      list.map((e) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const hostile = [...events, ...events, ...[...events].reverse()];
    const { context, page, mp } = await open();
    try {
      await page.route(
        `**/api/nemodots/missions/${missionId}/events`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: frames(hostile),
          }),
      );
      await page.reload();
      await expect(mp.taskTree).toBeVisible();
      await expect(mp.ledger.getByRole('row')).toHaveCount(
        snap.receipts.length + 1,
      ); // header + one per receipt
      const once = await open();
      try {
        const baseline = await once.mp.recovery.getByRole('listitem').count();
        expect(await mp.recovery.getByRole('listitem').count()).toBe(baseline);
        const baselineTasks = await once.mp.taskTree
          .getByRole('listitem')
          .count();
        expect(await mp.taskTree.getByRole('listitem').count()).toBe(
          baselineTasks,
        );
      } finally {
        await once.context.close();
      }
    } finally {
      await context.close();
    }
  });

  it('[G7.8] a dropped connection reads "reconnecting"; the resumed request carries Last-Event-ID', async () => {
    const { context, page, mp } = await open();
    try {
      await expect(mp.main).toContainText(
        /live updates|connected|streaming|stream open/i,
        { timeout: 30_000 },
      );
      const seen: (string | undefined)[] = [];
      page.on('request', (req) => {
        if (/\/missions\/[^/]+\/events/.test(req.url()))
          seen.push(req.headers()['last-event-id']);
      });
      await context.setOffline(true);
      await expect(mp.main).toContainText(
        /reconnect|offline|disconnected|connection lost/i,
        { timeout: 30_000 },
      );
      await context.setOffline(false);
      await until(
        'a resumed events request with Last-Event-ID',
        async () => seen.some((id) => id !== undefined && Number(id) >= 0),
        { timeoutMs: 60_000 },
      );
      await expect(mp.main).toContainText(
        /live updates|connected|streaming|stream open/i,
        { timeout: 60_000 },
      );
    } finally {
      await context.close();
    }
  });
});

describe('keyboard and non-colour status text (G7.9, G7.10)', () => {
  it('[G7.9] lifecycle controls and the first receipt control are reachable by keyboard and show a focus indicator', async () => {
    const { context, mp } = await open();
    try {
      const targets = [
        mp.start.or(mp.pause).or(mp.resume).or(mp.cancel).first(),
        mp.cancel,
        mp.ledger.getByRole('button').first(),
      ];
      for (const target of targets) {
        await mp.tabTo(target);
        const style = await target.evaluate((el) => {
          const s = getComputedStyle(el);
          return { outline: s.outlineStyle, shadow: s.boxShadow };
        });
        expect(
          style.outline !== 'none' || style.shadow !== 'none',
          'focused control shows a focus indicator',
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it('[G7.10] every status pill carries its status as text, never colour alone', async () => {
    const { context, mp } = await open();
    try {
      await expect(mp.taskTree).toBeVisible();
      const pills = mp.main.locator('[data-status]');
      const n = await pills.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i += 1) {
        const pill = pills.nth(i);
        const status = (await pill.getAttribute('data-status')) ?? '';
        const text = ((await pill.innerText()) || '').trim();
        expect(text.length, `pill ${status} has visible text`).toBeGreaterThan(
          0,
        );
        expect(text.toLowerCase(), `pill text for ${status}`).toContain(
          humanize(status).split(' ')[0]!.slice(0, 4).toLowerCase(),
        );
      }
    } finally {
      await context.close();
    }
  });
});

describe('bounded rendering (G7.12)', () => {
  it('[G7.12] 3,000+ receipts render a bounded DOM and the page says how many exist', async () => {
    const snap = await api.snapshot(missionId);
    expect(snap.receipts.length).toBeGreaterThan(0);
    const template = snap.receipts[0]!;
    const many = Array.from({ length: 3000 }, (_, i) => ({
      ...template,
      id: crypto.randomUUID(),
      source: { ...template.source, key: `${template.source.key}.bulk${i}` },
      supersedes: null,
      supersededBy: null,
      sourceRevision: i + 1,
    }));
    const big = { ...snap, receipts: [...snap.receipts, ...many] };
    const { context, page, mp } = await open();
    try {
      await page.route(`**/api/nemodots/missions/${missionId}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(big),
        }),
      );
      await page.route(
        `**/api/nemodots/missions/${missionId}/events`,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: ': idle\n\n',
          }),
      );
      await page.reload();
      await expect(mp.ledger).toBeVisible({ timeout: 60_000 });
      const nodes = await page.evaluate(
        () => document.getElementsByTagName('*').length,
      );
      expect(nodes, 'DOM stays bounded for 3,000+ receipts').toBeLessThan(
        15_000,
      );
      const total = big.receipts.length;
      await expect(mp.ledger).toContainText(
        new RegExp(`${total.toLocaleString('en-US')}|${total}`),
      );
    } finally {
      await context.close();
    }
  });
});

describe('verification, terminal state and projection (G7.7, G7.13, G7.14)', () => {
  let final: MissionSnapshot;
  it('[G7.13] when the mission ends the UI shows the terminal status, disabled controls, and the acceptance receipt (success) or reason (failure)', async () => {
    final = await waitForSnapshot(
      api,
      missionId,
      'a terminal mission',
      (s) => isTerminal(s.mission.status),
      LONG,
    );
    const { context, mp } = await open();
    try {
      await mp.expectStatus(final.mission.status);
      for (const button of [mp.start, mp.pause, mp.resume, mp.cancel])
        await expect(button).toBeDisabled();
      if (final.mission.status === 'succeeded') {
        expect(final.mission.acceptanceReceiptId).toBeTruthy();
        await expect(mp.main).toContainText(
          final.mission.acceptanceReceiptId!.slice(0, 8),
        );
      } else if (final.mission.status === 'failed') {
        await expect(mp.main).toContainText(
          final.mission.failureReason!.slice(0, 60),
        );
      }
    } finally {
      await context.close();
    }
  });

  it('[G7.7] the verification result shows the probe verdict, each invariant as pass/fail text and the health sample counts; no probe means no pass claim', async () => {
    const { context, mp } = await open();
    try {
      const events = await api.events(missionId, {
        lastEventId: 0,
        maxMs: 6000,
      });
      const probe = [...events]
        .reverse()
        .find((e) => e.payload.kind === 'probe.recorded');
      const main = await mp.text();
      if (!probe || probe.payload.kind !== 'probe.recorded') {
        expect(final.probe).toBeNull();
        expect(main).not.toMatch(
          /acceptance (?:passed|verified)|verdict:? pass/i,
        );
        return;
      }
      const p = probe.payload;
      expect(main.toLowerCase()).toContain(p.verdict);
      for (const inv of p.invariants) expect(main).toContain(inv.name);
      expect(main).toMatch(
        new RegExp(`${p.healthOk}\\s*(?:/|of)\\s*${p.healthSamples}`),
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.14] "Save evidence page" projects every receipt with id and revision and links back; the ledger is unchanged', async () => {
    const before = await api.snapshot(missionId);
    const { context, page, mp } = await open();
    try {
      await mp.button(/save evidence page/i).click();
      const link = page
        .getByRole('link', {
          name: /open (?:the )?(?:evidence )?page|view page|evidence page/i,
        })
        .first();
      await expect(link).toBeVisible({ timeout: 30_000 });
      await link.click();
      await expect(page.locator('main')).toContainText(
        /projection of|receipt/i,
        { timeout: 30_000 },
      );
      const body = (await page.locator('main').innerText()).replace(
        /\s+/g,
        ' ',
      );
      for (const r of receiptFacts(before)) {
        expect(body, `page line for receipt ${r.shortId}`).toContain(r.shortId);
        expect(body).toMatch(
          new RegExp(
            `${r.shortId}.{0,80}rev(?:ision)?\\.? ?${r.revision}|rev(?:ision)?\\.? ?${r.revision}.{0,80}${r.shortId}`,
            'i',
          ),
        );
      }
      const after = await api.snapshot(missionId);
      const key = (s: MissionSnapshot) =>
        s.receipts.map((r) => [
          r.id,
          r.sourceRevision,
          r.contentDigest,
          r.status,
        ]);
      expect(key(after)).toEqual(key(before));
    } finally {
      await context.close();
    }
  });
});

describe('cancel by keyboard (G7.1, G7.9)', () => {
  it('[G7.1] Cancel on a running mission ends it as cancelled, lists committed effects and is irreversible', async () => {
    const second = await api.createMission({
      goal: GOAL,
      constraints: CONSTRAINTS,
      mode: 'live',
    });
    await api.lifecycle(second.id, 'start');
    const { context, page, mp } = await open(second.id);
    try {
      await mp.expectStatus('running');
      await mp.tabTo(mp.cancel);
      await page.keyboard.press('Enter');
      const confirm = page.getByRole('button', {
        name: /^(?:confirm|yes).{0,24}cancel|^cancel mission$/i,
      });
      if (await confirm.count()) await confirm.first().click();
      const snap = await until(
        'server mission cancelled',
        async () => {
          const s = await api.snapshot(second.id);
          return s.mission.status === 'cancelled' ? s : null;
        },
        { timeoutMs: 60_000 },
      );
      expect(snap.mission.cancellation).not.toBeNull();
      await mp.expectStatus('cancelled');
      for (const id of snap.mission.cancellation!.committedEffects)
        await expect(mp.main).toContainText(id.slice(0, 8));
      await expect(mp.cancel).toBeDisabled();
      expect(await api.lifecycleStatus(second.id, 'resume')).toBe(409);
    } finally {
      await context.close();
    }
  });
});
