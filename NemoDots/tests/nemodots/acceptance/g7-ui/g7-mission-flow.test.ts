// Gate 7 against one real LIVE mission on Crusoe/Nemotron plus the injected
// checkout fault, driven through system Chrome. The server snapshot, events
// and typed contracts are the oracle; the UI must show what they say.
//
// These are the "live" rows. A live row whose precondition was not produced by
// the run (no delegated child, no finding, no action, no invalidation, no
// probe) FAILS with "PRECONDITION NOT PRODUCED", it never passes by asserting
// nothing. The matching rendering of every such case is exercised separately
// with contract-shaped fulfilled snapshots in g7-render-fixtures.test.ts.
//
// Cases: G7.1 lifecycle, G7.3 evidence, G7.4 task tree, G7.5 action inspector,
// G7.6 recovery timeline, G7.7 verification, G7.8 reload/reconnect, G7.9
// keyboard, G7.10 non-colour text, G7.13 terminal states, G7.14 page
// projection, G7.15 telemetry, G7.17 secrets.
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type {
  MissionEvent,
  MissionSnapshot,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  CONSTRAINTS,
  GOAL,
  MISSION_ALLOWED,
  NemoApi,
  isTerminal,
  waitForSnapshot,
} from './helpers/api.js';
import {
  checkActionStages,
  checkReceiptDrilldown,
  checkReceiptRow,
  short,
} from './helpers/checks.js';
import { liveCredentials, until } from './helpers/env.js';
import {
  captureHaystacks,
  findLeaks,
  leakingBuiltAssets,
  serverSecretNeedles,
} from './helpers/leaks.js';
import { MissionPage, labelled, precondition } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import {
  consoleErrors,
  dropStream,
  escapeRe,
  humanize,
  launchChrome,
  newPage,
  statusText,
  streamState,
} from './helpers/ui.js';

// Scenario class names are the ids of the injector manifests; the injector is
// a builder module, so this name is recorded as a dependency of this suite.
const SCENARIO_FAULT = 'repairable-checkout-fault';
const LONG = 10 * 60_000;

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
async function open(id = missionId, tapStream = false) {
  const handle = await newPage(browser, { tapStream });
  const mp = new MissionPage(handle.page);
  await handle.page.goto(`/#/missions/${id}`);
  return { ...handle, mp };
}

/**
 * Waits until `predicate` holds or the mission is terminal, then FAILS with an
 * explicit message when the predicate still does not hold.
 */
async function produced(
  what: string,
  predicate: (s: MissionSnapshot) => boolean,
  timeoutMs = LONG,
): Promise<MissionSnapshot> {
  const snapshot = await waitForSnapshot(
    api,
    missionId,
    what,
    (s) => predicate(s) || isTerminal(s.mission.status),
    timeoutMs,
  ).catch((error: Error) => {
    throw new Error(
      `PRECONDITION NOT PRODUCED: ${what} (${error.message.slice(0, 160)})`,
    );
  });
  precondition(
    predicate(snapshot),
    `${what}; the live mission ended ${snapshot.mission.status} without it`,
  );
  return snapshot;
}

const countRe = (n: number) =>
  new RegExp(`(?:${n.toLocaleString('en-US')}|${n})(?![\\d,])`);

async function allEvents(): Promise<MissionEvent[]> {
  return api.events(missionId, { lastEventId: 0, maxMs: 6000 });
}

describe('lifecycle controls (G7.1)', () => {
  it('[G7.1] (live) a created mission offers Start and Cancel; Pause and Resume are disabled; the mission status is text', async () => {
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

  it('[G7.1] (live) Start from the UI moves the server mission to running (fault injected first)', async () => {
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
});

// Reload and reconnect run immediately after Start, while the server reports a
// non-terminal status, so they test a stream that is still live.
describe('reload and reconnect mid-run (G7.8)', () => {
  it('[G7.8] (live) a reload while the mission is running shows exactly the server tasks and receipts', async () => {
    const before = await api.snapshot(missionId);
    precondition(
      !isTerminal(before.mission.status),
      `the mission is already ${before.mission.status}; a mid-run reload cannot be tested`,
    );
    const { context, page, mp } = await open();
    try {
      await page.reload();
      await expect(mp.taskTree).toBeVisible();
      await until(
        'the reloaded view equals the server tasks and receipts',
        async () => {
          const [uiTasks, uiRows, server] = await Promise.all([
            mp.taskTree.getByRole('listitem').count(),
            mp.ledger.getByRole('row').count(),
            api.snapshot(missionId),
          ]);
          const uiReceipts = uiRows > 0 ? uiRows - 1 : 0;
          if (
            uiTasks === server.tasks.length &&
            uiReceipts === server.receipts.length
          )
            return true;
          throw new Error(
            `ui tasks ${uiTasks}/receipts ${uiReceipts}; server tasks ${server.tasks.length}/receipts ${server.receipts.length}`,
          );
        },
        { timeoutMs: 45_000, intervalMs: 500 },
      );
      const now = await api.snapshot(missionId);
      await expect(mp.missionStatus).toHaveAttribute(
        'data-status',
        now.mission.status,
        { timeout: 30_000 },
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.8] (live) a dropped stream reads "reconnecting" and the resumed request carries the highest event id the client received', async () => {
    precondition(
      !isTerminal((await api.snapshot(missionId)).mission.status),
      'the mission is already terminal; a live stream cannot be dropped',
    );
    const { context, page, mp, captured } = await open(missionId, true);
    try {
      await expect(mp.main).toContainText(
        /live updates|connected|streaming|stream open/i,
        { timeout: 30_000 },
      );
      await captured.settle();
      const cursorOf = () => {
        const bodies = captured.raw.responses.filter((r) =>
          new RegExp(`/missions/${missionId}(?:\\?.*)?$`).test(r.url),
        );
        const last = bodies[bodies.length - 1];
        return last
          ? (JSON.parse(last.body) as { lastEventId: number }).lastEventId
          : 0;
      };
      const requestsBefore = (await captured.eventsRequests()).length;
      expect(
        requestsBefore,
        'the page opened the events stream',
      ).toBeGreaterThan(0);
      expect(
        await dropStream(page),
        'one live stream was severed',
      ).toBeGreaterThan(0);
      await context.setOffline(true);
      await expect(mp.main).toContainText(
        /reconnect|offline|disconnected|connection lost/i,
        { timeout: 30_000 },
      );
      await captured.settle();
      const delivered = (await streamState(page)).maxEventId;
      const expected = Math.max(delivered, cursorOf());
      expect(expected, 'events were delivered before the drop').toBeGreaterThan(
        0,
      );
      await context.setOffline(false);
      await until(
        'a resumed events request',
        async () => (await captured.eventsRequests()).length > requestsBefore,
        { timeoutMs: 60_000 },
      );
      const resumed = (await captured.eventsRequests()).slice(requestsBefore);
      for (const request of resumed)
        expect(
          request.lastEventId,
          'Last-Event-ID equals the highest id received before the drop',
        ).toBe(String(expected));
      await expect(mp.main).toContainText(
        /live updates|connected|streaming|stream open/i,
        { timeout: 60_000 },
      );
    } finally {
      await context.close();
    }
  });
});

describe('pause, resume and refusals (G7.1)', () => {
  it('[G7.1] (live) Pause then Resume from the UI match server state and follow the transition table; illegal transitions are 409', async () => {
    precondition(
      (await api.snapshot(missionId)).mission.status === 'running',
      'the mission must still be running to pause it from the UI',
    );
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

  it('[G7.1] (live) a server refusal (409) is an alert; the MISSION status is not flipped to paused and the server is unchanged', async () => {
    const before = await api.snapshot(missionId);
    precondition(
      before.mission.status === 'running',
      `the mission must be running to offer Pause (it is ${before.mission.status})`,
    );
    const { context, page, mp } = await open();
    try {
      await mp.expectStatus('running');
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
      const after = await api.snapshot(missionId);
      expect(after.mission.status, 'the server never paused').not.toBe(
        'paused',
      );
      // The mission-level status follows the server, never the refused click.
      await expect(mp.missionStatus).not.toHaveAttribute(
        'data-status',
        'paused',
      );
      await until(
        'the mission-level status equals the server status',
        async () => {
          const server = (await api.snapshot(missionId)).mission.status;
          const shown = await mp.missionStatus.getAttribute('data-status');
          if (server === shown) return true;
          throw new Error(`server ${server}, page ${shown}`);
        },
        { timeoutMs: 30_000, intervalMs: 500 },
      );
    } finally {
      await context.close();
    }
  });
});

describe('task tree (G7.4)', () => {
  it('[G7.4] (live) every server task is listed with its own role and status; delegated children nest under their parent with the justification', async () => {
    await produced(
      'planner output: at least 2 tasks',
      (s) => s.tasks.length >= 2,
      180_000,
    );
    // A delegated child is part of the gate: the team must delegate at least once.
    await produced(
      'a delegated child task (the team must delegate dynamically)',
      (s) => s.tasks.some((t) => t.parentId !== null),
    );
    const { context, mp } = await open();
    try {
      const live = await api.snapshot(missionId);
      for (const task of live.tasks) {
        const row = mp.taskRow(task.title);
        await expect(row, `row for "${task.title}"`).toBeVisible();
        await expect(row).toContainText(
          new RegExp(escapeRe(humanize(task.role)), 'i'),
        );
      }
      // Statuses move during the run: compare against a fresh read per task.
      for (const task of live.tasks) {
        const fresh = (await api.snapshot(missionId)).tasks.find(
          (t) => t.id === task.id,
        )!;
        await expect(
          mp.taskRow(task.title).locator('[data-status]').first(),
        ).toHaveAttribute('data-status', fresh.status, { timeout: 30_000 });
      }
      const children = live.tasks.filter((t) => t.parentId !== null);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        const parent = live.tasks.find((t) => t.id === child.parentId)!;
        await expect(
          mp.taskTree.getByRole('list', {
            name: `Subtasks of ${parent.title}`,
          }),
          `child "${child.title}" nested under "${parent.title}"`,
        ).toContainText(child.title);
        expect(
          child.justification,
          'a delegated task carries a justification',
        ).toBeTruthy();
        await expect(
          mp.taskTree
            .getByRole('listitem')
            .filter({ hasText: child.title })
            .last(),
        ).toContainText(child.justification!);
      }
    } finally {
      await context.close();
    }
  });
});

describe('evidence ledger and drilldown (G7.3)', () => {
  it('[G7.3] (live) every receipt row shows exact source key, revision, status and trust; Enter opens a typed drilldown', async () => {
    await produced('first receipts', (s) => s.receipts.length >= 1, 240_000);
    const { context, page, mp } = await open();
    try {
      const snapshot = await api.snapshot(missionId);
      await expect(mp.ledger).toBeVisible();
      for (const r of snapshot.receipts) await checkReceiptRow(mp, r);
      const target =
        snapshot.receipts.find((r) => r.supersedes !== null) ??
        snapshot.receipts[0]!;
      const older = target.supersedes
        ? (snapshot.receipts.find((r) => r.id === target.supersedes) ?? null)
        : null;
      await checkReceiptDrilldown(page, mp, target, older);
    } finally {
      await context.close();
    }
  });

  it('[G7.3] (live) a published model claim is labelled "claim" and never appears in the receipt table', async () => {
    const snap = await produced(
      'a published finding (the team must publish a claim)',
      (s) => s.findings.length >= 1,
    );
    const { context, mp } = await open();
    try {
      const claim = snap.findings[0]!.claim;
      await expect(mp.findings).toContainText(/claim/i);
      await expect(mp.findings).toContainText(claim.slice(0, 50));
      expect(await mp.ledger.innerText()).not.toContain(claim.slice(0, 50));
    } finally {
      await context.close();
    }
  });
});

describe('action inspector (G7.5) and recovery timeline (G7.6)', () => {
  it('[G7.5] (live) each proposed action is listed with kind and status; the selected one shows every stage with its own decision, versions, fence and checked vector', async () => {
    await produced(
      'at least one proposed action (the team must attempt a repair)',
      (s) => s.actions.length >= 1,
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
        const fresh = (await api.snapshot(missionId)).actions.find(
          (a) => a.id === action.id,
        )!;
        const item = mp.actions
          .getByRole('listitem')
          .filter({ hasText: action.target.sourceKey })
          .first();
        await expect(item, `action ${short(action.id)} listed`).toBeVisible();
        await expect(item).toContainText(
          new RegExp(escapeRe(humanize(action.action)), 'i'),
        );
        await expect(item.locator('[data-status]').first()).toHaveAttribute(
          'data-status',
          fresh.status,
          { timeout: 30_000 },
        );
      }
      const action = snapshot.actions.find((a) =>
        snapshot.authorizations.some((d) => d.actionId === a.id),
      )!;
      const select = mp.actions
        .getByRole('button', {
          name: new RegExp(escapeRe(action.target.sourceKey)),
        })
        .first();
      await mp.tabTo(select);
      await page.keyboard.press('Enter');
      await expect(mp.inspector).toContainText(action.payloadHash.slice(0, 8));
      await checkActionStages(mp, snapshot, action.id);
      const result = snapshot.results.find((r) => r.actionId === action.id);
      if (result?.externalEffect?.scriptResult)
        await expect(mp.inspector).toContainText(
          labelled(
            /script result/,
            new RegExp(
              escapeRe(humanize(result.externalEffect.scriptResult)),
              'i',
            ),
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

  it('[G7.6] (live) the recovery timeline keeps server order for repeated kinds and names the invalidated and preserved tasks by title', async () => {
    await produced(
      'an invalidation (the dependent change must be detected)',
      (s) => s.invalidations.length >= 1,
    );
    const snapshot = await api.snapshot(missionId);
    const events = await allEvents();
    const { context, mp } = await open();
    try {
      const items = mp.recovery
        .getByRole('list', { name: 'Recovery events in order' })
        .getByRole('listitem');
      await expect(items.first()).toBeVisible();
      const texts = (await items.allInnerTexts()).map((t) =>
        t.replace(/\s+/g, ' ').toLowerCase(),
      );
      // Walk recovery events in event-id order. Each must match an item AFTER
      // the previous match, so repeated kinds cannot reuse one occurrence.
      let cursor = -1;
      const recoveries = events.flatMap((e) =>
        e.payload.kind === 'recovery.recorded' ? [e.payload.recovery] : [],
      );
      for (const rec of recoveries) {
        const kind = humanize(rec.kind).toLowerCase();
        const detail = rec.detail.trim().toLowerCase();
        const at = texts.findIndex(
          (t, i) =>
            i > cursor && t.includes(kind) && (!detail || t.includes(detail)),
        );
        expect(
          at,
          `recovery "${kind}" appears after position ${cursor}`,
        ).toBeGreaterThan(cursor);
        cursor = at;
      }
      for (const inv of events.flatMap((e) =>
        e.payload.kind === 'invalidation.recorded' ? [e.payload] : [],
      )) {
        const item = texts.find(
          (t) => t.includes(inv.sourceKey.toLowerCase()) && /invalidat/.test(t),
        );
        expect(
          item,
          `an item for the invalidated source ${inv.sourceKey}`,
        ).toBeTruthy();
        for (const id of inv.affected.taskIds) {
          const title = snapshot.tasks.find((t) => t.id === id)?.title;
          if (title)
            expect(item, `invalidated task "${title}" is named`).toContain(
              title.toLowerCase(),
            );
        }
        for (const id of inv.preserved.taskIds) {
          const title = snapshot.tasks.find((t) => t.id === id)?.title;
          if (title)
            expect(item, `preserved task "${title}" is named`).toContain(
              title.toLowerCase(),
            );
        }
        expect(
          inv.affected.taskIds.length + inv.preserved.taskIds.length,
          'the invalidation touched at least one task',
        ).toBeGreaterThan(0);
      }
      for (const e of events)
        if (e.payload.kind === 'attempt.started' && e.payload.repairOf !== null)
          expect(
            texts.some((t) => /repair attempt/.test(t)),
            'a repair attempt appears in the timeline',
          ).toBe(true);
    } finally {
      await context.close();
    }
  });
});

describe('keyboard and non-colour status text (G7.9, G7.10)', () => {
  it('[G7.9] (live) lifecycle controls and the first receipt control are reachable by keyboard and show a focus indicator', async () => {
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

  it('[G7.10] (live) every status pill carries its status as text, never colour alone', async () => {
    const { context, mp } = await open();
    try {
      await expect(mp.taskTree).toBeVisible();
      const pills = mp.main.locator('[data-status]');
      const n = await pills.count();
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i += 1) {
        const pill = pills.nth(i);
        const status = (await pill.getAttribute('data-status')) ?? '';
        const text = ((await pill.innerText()) || '').trim().toLowerCase();
        expect(text.length, `pill ${status} has visible text`).toBeGreaterThan(
          0,
        );
        const word = humanize(status).split(' ')[0]!.slice(0, 4).toLowerCase();
        expect(
          text.includes(word) || (status === 'down' && /unreach/.test(text)),
          `pill text "${text}" for ${status}`,
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });
});

describe('terminal state, verification, telemetry and projection (G7.7, G7.13, G7.14, G7.15)', () => {
  let final: MissionSnapshot;

  it('[G7.13] (live) when the mission ends the UI shows the exact terminal status, disabled controls, and the acceptance receipt (success) or reason (failure)', async () => {
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
          short(final.mission.acceptanceReceiptId!),
        );
      } else if (final.mission.status === 'failed') {
        expect(final.mission.failureReason).toBeTruthy();
        await expect(mp.main).toContainText(
          final.mission.failureReason!.slice(0, 60),
        );
      }
    } finally {
      await context.close();
    }
  });

  it('[G7.7] (live) the verification result shows the probe verdict, each invariant as pass or fail text and the health sample counts', async () => {
    const events = await allEvents();
    const probe = [...events]
      .reverse()
      .find((e) => e.payload.kind === 'probe.recorded');
    precondition(
      probe && probe.payload.kind === 'probe.recorded',
      `no probe was recorded; the live mission ended ${final.mission.status} without reaching acceptance`,
    );
    expect(probe.payload.invariants.length).toBeGreaterThan(0);
    const { context, mp } = await open();
    try {
      const p = probe.payload;
      const text = await mp.text();
      expect(text).toMatch(new RegExp(`\\b${p.verdict}(?:ed)?\\b`, 'i'));
      for (const inv of p.invariants) {
        const at = Math.max(
          text.toLowerCase().indexOf(inv.name.toLowerCase()),
          text.toLowerCase().indexOf(humanize(inv.name).toLowerCase()),
        );
        expect(at, `invariant ${inv.name} is shown`).toBeGreaterThanOrEqual(0);
        const window = text.slice(at, at + inv.name.length + 40);
        if (inv.ok) expect(window).toMatch(/pass|ok|holds|true/i);
        else expect(window).toMatch(/fail|violat|false/i);
      }
      expect(text).toMatch(
        new RegExp(`\\b${p.healthOk}\\s*(?:/|of)\\s*${p.healthSamples}\\b`),
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.15] (live) telemetry shown after the mission ended equals the server summary; unavailable fields read "unavailable"; no prices or savings', async () => {
    const snapshot = await api.snapshot(missionId);
    precondition(
      isTerminal(snapshot.mission.status),
      'telemetry is compared only against a stable (terminal) summary',
    );
    const summary = await api.telemetry(missionId);
    precondition(summary.calls >= 1, 'the live run recorded model calls');
    const { context, mp } = await open();
    try {
      const text = (await mp.telemetry.innerText()).replace(/\s+/g, ' ');
      expect(text).toMatch(labelled(/model calls/, countRe(summary.calls)));
      expect(text).toMatch(
        labelled(/(?:prompt|input) tokens/, countRe(summary.tokens.prompt)),
      );
      expect(text).toMatch(
        labelled(
          /(?:completion|output) tokens/,
          countRe(summary.tokens.completion),
        ),
      );
      expect(text).toMatch(labelled(/retries/, countRe(summary.retries)));
      expect(text).toMatch(labelled(/errors/, countRe(summary.errors)));
      if (summary.tokens.cached.available)
        expect(text).toMatch(
          labelled(/cached tokens/, countRe(summary.tokens.cached.total!)),
        );
      else expect(text).toMatch(labelled(/cached tokens/, /unavailable/));
      if (summary.ttftMs === null)
        expect(text).toMatch(
          labelled(/(?:time to first token|ttft)/, /unavailable/),
        );
      else {
        const forms = (ms: number) =>
          `${Math.round(ms)}\\s*ms|${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}\\s*s`;
        expect(text).toMatch(
          labelled(
            /(?:time to first token|ttft)/,
            new RegExp(
              `[^.]{0,30}(?:${forms(summary.ttftMs.p50)})[^.]{0,40}(?:${forms(summary.ttftMs.p95)})`,
            ),
          ),
        );
      }
      expect(await mp.textWithoutButtons()).not.toMatch(
        /\$\s?\d|\bsaved?\s+\d|\d\s?%\s+(?:cheaper|faster|fewer|less|savings)|\bcheaper\b|cost reduction|\bsavings\b/i,
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.14] (live) "Save evidence page" projects every receipt with id and revision and links back; the ledger is unchanged', async () => {
    const before = await api.snapshot(missionId);
    precondition(
      before.receipts.length > 0,
      'the mission has receipts to project',
    );
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
      for (const r of before.receipts) {
        const id = short(r.id);
        expect(body, `page line for receipt ${id}`).toContain(id);
        expect(body).toMatch(
          new RegExp(
            `${id}.{0,80}rev(?:ision)?\\.? ?${r.sourceRevision}(?!\\d)|rev(?:ision)?\\.? ?${r.sourceRevision}(?!\\d).{0,80}${id}`,
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

describe('secrets and control data (G7.17)', () => {
  it('[G7.17] (live) after a mission with model calls, receipts and telemetry no secret reaches the DOM, console, page errors, request URLs or headers, response bodies, event-stream frames or built assets', async () => {
    const snapshot = await api.snapshot(missionId);
    precondition(
      snapshot.telemetry.calls > 0 && snapshot.receipts.length > 0,
      'the scan needs a mission that made model calls and recorded receipts',
    );
    const needles = serverSecretNeedles([
      stack.probeSecretValue,
      ...stack.credentialValues,
    ]);
    expect(needles.length, 'secrets to scan for are known').toBeGreaterThan(3);
    const { context, page, mp, captured } = await open(missionId, true);
    try {
      await expect(mp.ledger).toBeVisible();
      // Make the DOM show as much as it can: a drilldown and an inspector.
      const trigger = mp.ledger.getByRole('button').first();
      if (await trigger.count()) await trigger.click();
      if (snapshot.actions.length > 0)
        await mp.actions.getByRole('button').first().click();
      await page.waitForTimeout(1500);
      await captured.settle();
      const dom = await page.evaluate(() => ({
        html: document.documentElement.outerHTML,
        text: document.body.innerText,
        storage: JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      }));
      const serverFrames = await api.rawEventText(missionId, {
        lastEventId: 0,
        maxMs: 5000,
      });
      const haystacks = captureHaystacks(captured.raw, [
        { name: 'dom-html', text: dom.html },
        { name: 'dom-text', text: dom.text },
        { name: 'browser-storage', text: dom.storage },
        { name: 'server-event-stream', text: serverFrames },
        { name: 'snapshot-json', text: JSON.stringify(snapshot) },
      ]);
      expect(
        captured.raw.streamFrames.length,
        'the page received event-stream frames to scan',
      ).toBeGreaterThan(0);
      // Only haystack names are reported, never a value.
      expect(
        findLeaks(haystacks, needles),
        'haystacks containing a secret',
      ).toEqual([]);
      expect(
        leakingBuiltAssets(needles),
        'built assets containing a secret',
      ).toEqual([]);
      const control =
        /"control"\s*:|fault_schedules|NEMODOTS_PROBE_SECRET|postgres(?:ql)?:\/\//;
      expect(
        captured.raw.responses
          .filter((r) => control.test(r.body))
          .map((r) => new URL(r.url).pathname),
        'responses carrying control-plane data',
      ).toEqual([]);
      expect(
        control.test(serverFrames),
        'event stream carries control data',
      ).toBe(false);
      expect(captured.pageErrors).toEqual([]);
      expect(consoleErrors(captured).map((m) => m.text.slice(0, 120))).toEqual(
        [],
      );
    } finally {
      await context.close();
    }
  });
});

describe('cancel by keyboard (G7.1, G7.9)', () => {
  it('[G7.1] (live) Cancel on a running mission ends it as cancelled, shows committed effects (or says there are none) and is irreversible', async () => {
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
      const effects = snap.mission.cancellation!.committedEffects;
      if (effects.length > 0)
        for (const id of effects)
          await expect(mp.main).toContainText(short(id));
      else
        await expect(
          mp.main,
          'a cancellation with no committed effects says so',
        ).toContainText(
          /no (?:committed )?effects|(?:committed|applied) effects?\W+(?:none|0)\b|nothing (?:was )?committed/i,
        );
      await expect(mp.main).toContainText(statusText('cancelled'));
      await expect(mp.cancel).toBeDisabled();
      expect(await api.lifecycleStatus(second.id, 'resume')).toBe(409);
    } finally {
      await context.close();
    }
  });
});
