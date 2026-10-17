// Gate 7 rendering rows driven by CONTRACT-SHAPED FULFILLED SNAPSHOTS.
//
// The page is served a synthetic mission whose every value is chosen in
// helpers/synthetic.ts (validated by the shared contract schemas), so each
// assertion compares the UI with a known, independent expected value and a case
// can never pass because a live run happened not to produce the data. These
// rows test the CLIENT only (they are the "mocked" rows in the handoff); the
// live rows in g7-mission-flow.test.ts test the product.
//
// Cases: G7.3 G7.4 G7.5 G7.6 G7.7 G7.8 G7.10 G7.12 G7.13 G7.15.
import type { Browser } from 'playwright';
import { expect } from 'playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  MissionSnapshotSchema,
  type MissionSnapshot,
} from '../../../../src/server/nemodots/contracts/index.js';
import { checkReceiptDrilldown, checkReceiptRow } from './helpers/checks.js';
import { MissionPage, labelled, rowCells } from './helpers/mission-page.js';
import { Acc7Stack } from './helpers/stack.js';
import {
  type Scenario,
  type ScenarioOptions,
  FAILURE_REASON,
  TITLES,
  buildScenario,
  serveScenario,
  shortId,
} from './helpers/synthetic.js';
import {
  escapeRe,
  humanize,
  launchChrome,
  newPage,
  statusText,
} from './helpers/ui.js';

let browser: Browser;
let stack: Acc7Stack;
beforeAll(async () => {
  browser = await launchChrome();
  // The fixture stack only serves the built client and /api/nemodots/health;
  // the mission itself is fulfilled by the test.
  stack = await Acc7Stack.start({ mode: 'fixture', checkout: false });
});
afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

async function openScenario(
  options: ScenarioOptions = {},
  setup?: (scenario: Scenario) => Parameters<typeof serveScenario>[2],
) {
  const scenario = buildScenario(options);
  const handle = await newPage(browser);
  await serveScenario(handle.page, scenario, setup?.(scenario));
  const mp = new MissionPage(handle.page);
  await handle.page.goto(`/#/missions/${scenario.snapshot.mission.id}`);
  return { ...handle, mp, scenario };
}

describe('task tree and dependencies (G7.4)', () => {
  it('[G7.4] (fulfilled snapshot) every task row shows its own role and status; children nest under their parent with the delegation justification', async () => {
    const { context, mp, scenario } = await openScenario();
    try {
      const { tasks } = scenario.snapshot;
      for (const task of tasks) {
        const row = mp.taskRow(task.title);
        await expect(row, `row for "${task.title}"`).toBeVisible();
        await expect(row).toContainText(
          new RegExp(escapeRe(humanize(task.role)), 'i'),
        );
        const pill = row.locator('[data-status]').first();
        await expect(pill).toHaveAttribute('data-status', task.status);
        await expect(pill).toContainText(statusText(task.status));
      }
      const root = tasks.find((t) => t.parentId === null)!;
      const children = tasks.filter((t) => t.parentId === root.id);
      expect(children.length).toBeGreaterThan(0);
      const nested = mp.taskTree.getByRole('list', {
        name: `Subtasks of ${root.title}`,
      });
      await expect(nested).toBeVisible();
      await expect(nested).not.toContainText(root.title);
      for (const child of children) {
        await expect(nested).toContainText(child.title);
        const item = mp.taskTree
          .getByRole('listitem')
          .filter({ hasText: child.title })
          .last();
        await expect(item).toContainText(child.justification!);
      }
      // A task with no children has no "Subtasks of" list of its own.
      await expect(
        mp.taskTree.getByRole('list', { name: `Subtasks of ${TITLES.cache}` }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  it('[G7.4] (fulfilled snapshot) the Dependencies view lists scheduling and evidence edges that match the snapshot', async () => {
    const { context, mp, scenario } = await openScenario();
    try {
      const deps = mp.region('Dependencies');
      await expect(deps).toBeVisible();
      const scheduling = deps.getByRole('list', { name: /scheduling edges/i });
      const evidence = deps.getByRole('list', { name: /evidence edges/i });
      await expect(scheduling.getByRole('listitem')).toHaveCount(
        scenario.expectedEdges.scheduling,
      );
      await expect(evidence.getByRole('listitem')).toHaveCount(
        scenario.expectedEdges.evidence,
      );
      // T3 waits for both T1 and T2 (prerequisites in the snapshot).
      await expect(
        scheduling.getByRole('listitem').filter({ hasText: TITLES.verify }),
      ).toHaveCount(2);
      // The repair attempt of T2 relied on the superseding cache receipt.
      await expect(
        evidence
          .getByRole('listitem')
          .filter({ hasText: 'checkout.config/cache.namespace' })
          .filter({ hasText: TITLES.cache }),
      ).not.toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

describe('evidence ledger and claims (G7.3)', () => {
  it('[G7.3] (fulfilled snapshot) each receipt row shows exact source key, revision, status and trust in its own cells', async () => {
    const { context, mp, scenario } = await openScenario();
    try {
      for (const r of scenario.snapshot.receipts) await checkReceiptRow(mp, r);
    } finally {
      await context.close();
    }
  });

  it('[G7.3] (fulfilled snapshot) Enter on a receipt opens a typed drilldown that was absent before, named for the receipt', async () => {
    const { context, page, mp, scenario } = await openScenario();
    try {
      const r = scenario.snapshot.receipts.find((x) => x.supersedes !== null)!;
      const older = scenario.snapshot.receipts.find(
        (x) => x.id === r.supersedes,
      )!;
      await checkReceiptDrilldown(page, mp, r, older);
    } finally {
      await context.close();
    }
  });

  it('[G7.3] (fulfilled snapshot) a model finding is labelled as a claim with its citations and is never in the receipt table', async () => {
    const { context, mp, scenario } = await openScenario();
    try {
      const finding = scenario.snapshot.findings[0]!;
      const item = mp.findings.getByRole('listitem').first();
      await expect(item).toContainText(/claim/i);
      await expect(item).toContainText(finding.claim);
      await expect(item).toContainText(
        new RegExp(`${finding.supportingReceiptIds.length}\\s+receipts?`, 'i'),
      );
      expect(await mp.ledger.innerText()).not.toContain(finding.claim);
    } finally {
      await context.close();
    }
  });
});

describe('action inspector (G7.5)', () => {
  it('[G7.5] (fulfilled snapshot) selecting an action by keyboard shows each stage with its own decision, versions, fence and checked vector', async () => {
    const { context, page, mp, scenario } = await openScenario();
    try {
      const { snapshot } = scenario;
      for (const action of snapshot.actions) {
        const item = mp.actions
          .getByRole('listitem')
          .filter({ hasText: action.target.sourceKey });
        await expect(item).toHaveCount(1);
        await expect(item).toContainText(
          new RegExp(escapeRe(humanize(action.action)), 'i'),
        );
        await expect(item.locator('[data-status]').first()).toHaveAttribute(
          'data-status',
          action.status,
        );
      }
      const act1 = snapshot.actions.find((a) => a.status === 'verified')!;
      const select = mp.actions.getByRole('button', {
        name: new RegExp(escapeRe(act1.target.sourceKey)),
      });
      await mp.tabTo(select);
      await page.keyboard.press('Enter');
      await expect(mp.inspector).toContainText(act1.payloadHash.slice(0, 8));
      for (const stage of ['admission', 'commit', 'dispatch'] as const) {
        const decision = snapshot.authorizations.find(
          (a) => a.actionId === act1.id && a.stage === stage,
        )!;
        const region = mp.inspector.getByRole('region', {
          name: new RegExp(`^${stage} stage`, 'i'),
        });
        await expect(region, `${stage} stage region`).toBeVisible();
        await expect(region.locator('[data-status]').first()).toHaveAttribute(
          'data-status',
          decision.decision,
        );
        await expect(region).toContainText(
          labelled(
            /expected/,
            new RegExp(
              `${decision.targetVersion.expected},?\\s*live\\s*${decision.targetVersion.live}\\b`,
            ),
          ),
        );
        if (decision.dispatchFence)
          await expect(region).toContainText(
            labelled(
              /fence/,
              new RegExp(`(?:token\\s*)?${decision.dispatchFence.token}\\b`),
            ),
          );
        else await expect(region).not.toContainText(/dispatch fence/i);
        const table = region.getByRole('table', {
          name: 'Checked dependency vector',
        });
        await expect(table.getByRole('row')).toHaveCount(
          decision.checkedVector.length + 1,
        );
        const first = decision.checkedVector[0]!;
        const cells = await rowCells(
          table.getByRole('row').filter({ hasText: first.sourceKey }),
        );
        expect(cells.recorded).toContain(String(first.recordedRevision));
        expect(cells.live).toContain(String(first.liveRevision));
      }
      const result = snapshot.results.find((r) => r.actionId === act1.id)!;
      await expect(mp.inspector).toContainText(
        labelled(
          /script result/,
          new RegExp(
            escapeRe(humanize(result.externalEffect!.scriptResult!)),
            'i',
          ),
        ),
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.5] (fulfilled snapshot) a blocked action shows its block reason, the stale version pair and the failed freshness in the right stage only', async () => {
    const { context, page, mp, scenario } = await openScenario();
    try {
      const { snapshot } = scenario;
      const blocked = snapshot.actions.find((a) => a.status === 'blocked')!;
      const decision = snapshot.authorizations.find(
        (a) => a.actionId === blocked.id,
      )!;
      const select = mp.actions.getByRole('button', {
        name: new RegExp(escapeRe(blocked.target.sourceKey)),
      });
      await mp.tabTo(select);
      await page.keyboard.press('Enter');
      const admission = mp.inspector.getByRole('region', {
        name: /^admission stage/i,
      });
      await expect(admission.locator('[data-status]').first()).toHaveAttribute(
        'data-status',
        'blocked',
      );
      await expect(admission).toContainText(
        new RegExp(escapeRe(humanize(decision.blockReason!)), 'i'),
      );
      await expect(admission).toContainText(
        labelled(
          /expected/,
          new RegExp(
            `${decision.targetVersion.expected},?\\s*live\\s*${decision.targetVersion.live}\\b`,
          ),
        ),
      );
      // Later stages are reported as not decided, not invented.
      for (const stage of ['commit', 'dispatch'])
        await expect(mp.inspector).toContainText(
          new RegExp(`${stage}\\s+stage:?\\s+not decided`, 'i'),
        );
      const row = admission
        .getByRole('table', { name: 'Checked dependency vector' })
        .getByRole('row')
        .nth(1);
      await expect(row.locator('[data-status]').first()).toHaveAttribute(
        'data-status',
        'superseded',
      );
    } finally {
      await context.close();
    }
  });
});

describe('recovery timeline (G7.6)', () => {
  it('[G7.6] (fulfilled snapshot) items follow server order, repeated kinds stay distinct, and invalidated and preserved branches are named by title', async () => {
    const { context, mp, scenario } = await openScenario();
    try {
      const items = mp.recovery
        .getByRole('list', { name: 'Recovery events in order' })
        .getByRole('listitem');
      await expect(items.first()).toBeVisible();
      const texts = (await items.allInnerTexts()).map((t) =>
        t.replace(/\s+/g, ' '),
      );
      // Each recovery id maps to exactly one item (unique detail text), and the
      // item order equals the server order, including two intent_blocked rows.
      const positions = scenario.recoveryDetails.map((detail) => {
        const hits = texts
          .map((t, i) => (t.includes(detail) ? i : -1))
          .filter((i) => i >= 0);
        expect(hits, `exactly one item for "${detail}"`).toHaveLength(1);
        return hits[0]!;
      });
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(new Set(positions).size).toBe(positions.length);
      const invalidation = scenario.snapshot.invalidations[0]!;
      const invalidationItems = texts
        .map((t, i) => ({ t, i }))
        .filter(
          ({ t }) => t.includes(invalidation.sourceKey) && /invalidat/i.test(t),
        );
      expect(
        invalidationItems.length,
        'an item for the invalidated source',
      ).toBeGreaterThan(0);
      const entry = invalidationItems[0]!;
      expect(
        entry.i,
        'the invalidation precedes its recovery steps',
      ).toBeLessThan(positions[0]!);
      const invalidatedTitles = scenario.snapshot.tasks
        .filter((t) => invalidation.affected.taskIds.includes(t.id))
        .map((t) => t.title);
      const preservedTitles = scenario.snapshot.tasks
        .filter((t) =>
          invalidation.perMission[0]!.preserved.taskIds.includes(t.id),
        )
        .map((t) => t.title);
      expect(invalidatedTitles.length).toBeGreaterThan(0);
      expect(preservedTitles.length).toBeGreaterThan(0);
      for (const title of invalidatedTitles)
        expect(entry.t, `invalidated task "${title}" is named`).toContain(
          title,
        );
      for (const title of preservedTitles)
        expect(entry.t, `preserved task "${title}" is named`).toContain(title);
      // The repair attempt appears and is after the invalidation.
      const repair = texts.findIndex((t) => /repair attempt/i.test(t));
      expect(repair).toBeGreaterThan(entry.i);
    } finally {
      await context.close();
    }
  });
});

describe('verification (G7.7)', () => {
  const probeText = async (mp: MissionPage) => mp.text();
  const near = (text: string, name: string) => {
    const humanized = humanize(name);
    const at = Math.max(
      text.toLowerCase().indexOf(name.toLowerCase()),
      text.toLowerCase().indexOf(humanized.toLowerCase()),
    );
    return at < 0 ? null : text.slice(at, at + name.length + 40);
  };

  for (const verdict of ['pass', 'fail'] as const)
    it(`[G7.7] (fulfilled snapshot) a ${verdict} probe shows the verdict, each invariant as pass or fail text and the health sample counts`, async () => {
      const { context, mp } = await openScenario({
        status: verdict === 'pass' ? 'awaiting_acceptance' : 'running',
        probe: verdict,
      });
      try {
        const text = await probeText(mp);
        expect(text).toMatch(new RegExp(`\\b${verdict}(?:ed)?\\b`, 'i'));
        const expected = [
          ['fresh_order_succeeds', true],
          ['inventory_consistent', true],
          ['health_stays_ok', verdict === 'pass'],
        ] as const;
        for (const [name, ok] of expected) {
          const window = near(text, name);
          expect(window, `invariant ${name} is shown`).not.toBeNull();
          if (ok) expect(window).toMatch(/pass|ok|holds|true/i);
          else {
            expect(window).toMatch(/fail|violat|false/i);
            expect(window).not.toMatch(/\bpass(?:ed)?\b/i);
          }
        }
        const healthOk = verdict === 'pass' ? 12 : 9;
        expect(text).toMatch(new RegExp(`\\b${healthOk}\\s*(?:/|of)\\s*12\\b`));
      } finally {
        await context.close();
      }
    });

  it('[G7.7] (fulfilled snapshot) with no probe the page makes no pass claim', async () => {
    const { context, mp, scenario } = await openScenario({ probe: null });
    try {
      expect(scenario.snapshot.probe).toBeNull();
      await expect(mp.missionStatus).toBeVisible();
      const text = await mp.textWithoutButtons();
      expect(text).not.toMatch(
        /acceptance (?:passed|verified)|verdict:? pass|probe passed/i,
      );
      expect(text).not.toMatch(/fresh_order_succeeds|fresh order succeeds/i);
    } finally {
      await context.close();
    }
  });
});

describe('reconnect and dedup with injected events (G7.8)', () => {
  it('[G7.8] (fulfilled snapshot) new events above the cursor, duplicated and reversed, render exactly once; counts come from server data plus the injected events', async () => {
    const scenario = buildScenario();
    const { context, page, mp } = await (async () => {
      const handle = await newPage(browser);
      const hostile = [
        ...[...scenario.late].reverse(),
        ...scenario.late,
        ...scenario.events.slice(0, 5),
        ...scenario.late,
      ];
      await serveScenario(handle.page, scenario, { stream: hostile });
      const mp = new MissionPage(handle.page);
      await handle.page.goto(`/#/missions/${scenario.snapshot.mission.id}`);
      return { ...handle, mp };
    })();
    try {
      const { snapshot } = scenario;
      const injectedTask = TITLES.late;
      await expect(mp.taskTree).toContainText(injectedTask, {
        timeout: 30_000,
      });
      await expect(
        mp.taskTree.getByRole('listitem'),
        'snapshot tasks + 1 injected',
      ).toHaveCount(snapshot.tasks.length + 1);
      await expect(mp.taskTree.getByText(injectedTask)).toHaveCount(1);
      await expect(mp.ledger.getByRole('row')).toHaveCount(
        snapshot.receipts.length + 1 + 1,
      ); // header + snapshot receipts + the one injected receipt
      await expect(
        mp.ledger.getByRole('row').filter({ hasText: 'checkout.metrics' }),
      ).toHaveCount(1);
      const items = mp.recovery
        .getByRole('list', { name: 'Recovery events in order' })
        .getByRole('listitem')
        .filter({ hasText: 'rec-6 late recovery' });
      await expect(items).toHaveCount(1);
      // Replayed pre-cursor events add nothing: the first recovery is still one item.
      await expect(
        mp.recovery
          .getByRole('listitem')
          .filter({ hasText: scenario.recoveryDetails[0]! }),
      ).toHaveCount(1);
      await page.reload();
      await expect(mp.taskTree.getByText(injectedTask)).toHaveCount(1, {
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }
  });

  it('[G7.8] (fulfilled snapshot) a reload reconstructs the same structured view (statuses, ids, counts) from the snapshot', async () => {
    const { context, page, mp } = await openScenario({ status: 'failed' });
    try {
      const structure = async () => ({
        mission: await mp.missionStatus.getAttribute('data-status'),
        tasks: await mp.taskTree
          .locator('[data-status]')
          .evaluateAll((els) =>
            els.map((e) => (e as HTMLElement).dataset.status ?? ''),
          ),
        taskItems: await mp.taskTree.getByRole('listitem').count(),
        receiptRows: await mp.ledger.getByRole('row').count(),
        receiptCells: await mp.ledger
          .getByRole('row')
          .evaluateAll((rows) =>
            rows.map(
              (r) =>
                (r.textContent ?? '').match(/receipt\s+([0-9a-f]{8})/)?.[1] ??
                '',
            ),
          ),
        actionItems: await mp.actions.getByRole('listitem').count(),
        recoveryItems: await mp.recovery.getByRole('listitem').count(),
      });
      await expect(mp.missionStatus).toBeVisible();
      await expect(mp.ledger).toBeVisible();
      const before = await structure();
      expect(before.receiptRows).toBeGreaterThan(1);
      await page.reload();
      await expect(mp.missionStatus).toBeVisible();
      await expect(mp.ledger.getByRole('row')).toHaveCount(before.receiptRows);
      expect(await structure()).toEqual(before);
    } finally {
      await context.close();
    }
  });
});

describe('status text (G7.10)', () => {
  it('[G7.10] (fulfilled snapshot) every status pill across tasks, receipts, actions and stages carries its status as text', async () => {
    const { context, mp } = await openScenario();
    try {
      await expect(mp.taskTree).toBeVisible();
      await mp.actions.getByRole('button').first().click();
      const pills = mp.main.locator('[data-status]');
      const n = await pills.count();
      expect(n).toBeGreaterThan(8);
      const statuses = new Set<string>();
      for (let i = 0; i < n; i += 1) {
        const pill = pills.nth(i);
        const status = (await pill.getAttribute('data-status')) ?? '';
        statuses.add(status);
        const text = ((await pill.innerText()) || '').trim().toLowerCase();
        expect(text.length, `pill ${status} has visible text`).toBeGreaterThan(
          0,
        );
        const word = humanize(status).split(' ')[0]!.slice(0, 4).toLowerCase();
        const overridden = status === 'down' && /unreach|down/.test(text);
        expect(
          text.includes(word) || overridden,
          `pill text "${text}" for status ${status}`,
        ).toBe(true);
      }
      expect(
        statuses.size,
        'a variety of statuses was rendered',
      ).toBeGreaterThan(4);
    } finally {
      await context.close();
    }
  });
});

describe('bounded rendering (G7.12)', () => {
  it('[G7.12] (fulfilled snapshot) 3,000+ receipts render a bounded DOM and the page states how many exist', async () => {
    const scenario = buildScenario();
    const template = scenario.snapshot.receipts[0]!;
    const many = Array.from({ length: 3000 }, (_, i) => ({
      ...template,
      id: crypto.randomUUID(),
      source: {
        ...template.source,
        key: `checkout.inventory/sku-${i}`,
        sourceType: 'observed_store',
      },
      supersedes: null,
      supersededBy: null,
      sourceRevision: i + 1,
    }));
    const big: MissionSnapshot = MissionSnapshotSchema.parse({
      ...scenario.snapshot,
      receipts: [...scenario.snapshot.receipts, ...many],
    });
    const { context, page, mp } = await (async () => {
      const handle = await newPage(browser);
      await serveScenario(handle.page, scenario, {
        snapshot: big,
        stream: [],
      });
      const mp = new MissionPage(handle.page);
      await handle.page.goto(`/#/missions/${big.mission.id}`);
      return { ...handle, mp };
    })();
    try {
      await expect(mp.ledger).toBeVisible({ timeout: 60_000 });
      const nodes = await page.evaluate(
        () => document.getElementsByTagName('*').length,
      );
      expect(nodes, 'DOM stays bounded for 3,000+ receipts').toBeLessThan(
        15_000,
      );
      const total = big.receipts.length;
      await expect(mp.ledger).toContainText(
        new RegExp(`${total.toLocaleString('en-US')}|\\b${total}\\b`),
      );
    } finally {
      await context.close();
    }
  });
});

describe('terminal states (G7.13)', () => {
  it('[G7.13] (fulfilled snapshot) a succeeded mission shows the exact status, the acceptance receipt id and the passing probe; every control is disabled', async () => {
    const { context, mp, scenario } = await openScenario({
      status: 'succeeded',
    });
    try {
      await mp.expectStatus('succeeded');
      const receiptId = scenario.snapshot.mission.acceptanceReceiptId!;
      await expect(mp.main).toContainText(shortId(receiptId));
      await expect(mp.main).not.toContainText(FAILURE_REASON.slice(0, 40));
      for (const button of [mp.start, mp.pause, mp.resume, mp.cancel])
        await expect(button).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  it('[G7.13] (fulfilled snapshot) a failed mission shows the exact status and its failure reason, with no acceptance claim', async () => {
    const { context, mp } = await openScenario({
      status: 'failed',
      probe: 'fail',
    });
    try {
      await mp.expectStatus('failed');
      await expect(mp.main).toContainText(FAILURE_REASON.slice(0, 60));
      expect(await mp.textWithoutButtons()).not.toMatch(
        /acceptance (?:passed|verified)|mission succeeded/i,
      );
      for (const button of [mp.start, mp.pause, mp.resume, mp.cancel])
        await expect(button).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  it('[G7.13] (fulfilled snapshot) a cancelled mission lists the committed effects that cannot be undone', async () => {
    const { context, mp, scenario } = await openScenario({
      status: 'cancelled',
      cancelledWithEffects: true,
    });
    try {
      await mp.expectStatus('cancelled');
      const effects = scenario.snapshot.mission.cancellation!.committedEffects;
      expect(effects.length).toBeGreaterThan(0);
      for (const id of effects)
        await expect(mp.main).toContainText(shortId(id));
      await expect(mp.main).toContainText(
        /cannot be undone|irreversible|not undone|remain/i,
      );
      for (const button of [mp.start, mp.pause, mp.resume, mp.cancel])
        await expect(button).toBeDisabled();
    } finally {
      await context.close();
    }
  });
});

describe('telemetry (G7.15)', () => {
  it('[G7.15] (fulfilled snapshot) shown values equal the summary; unavailable cached tokens and TTFT read "unavailable"; no prices or savings', async () => {
    const { context, mp, scenario } = await openScenario({
      telemetry: 'unavailable',
    });
    try {
      const t = scenario.snapshot.telemetry;
      expect(t.tokens.cached.available).toBe(false);
      const text = (await mp.telemetry.innerText()).replace(/\s+/g, ' ');
      expect(text).toMatch(labelled(/model calls/, /14(?![\d,])/));
      expect(text).toMatch(labelled(/orphaned calls/, /1(?![\d,])/));
      expect(text).toMatch(
        labelled(/(?:prompt|input) tokens/, /12,?840(?![\d,])/),
      );
      expect(text).toMatch(
        labelled(/(?:completion|output) tokens/, /3,?150(?![\d,])/),
      );
      expect(text).toMatch(labelled(/cached tokens/, /unavailable/));
      expect(text).toMatch(
        labelled(/(?:time to first token|ttft)/, /unavailable/),
      );
      expect(text).toMatch(labelled(/retries/, /2(?![\d,])/));
      expect(text).toMatch(labelled(/errors/, /1(?![\d,])/));
      expect(text).not.toMatch(/\bnan\b|undefined|null/i);
      expect(await mp.textWithoutButtons()).not.toMatch(
        /\$\s?\d|\bsaved?\s+\d|\d\s?%\s+(?:cheaper|faster|fewer|less|savings)|\bcheaper\b|cost reduction|\bsavings\b/i,
      );
    } finally {
      await context.close();
    }
  });

  it('[G7.15] (fulfilled snapshot) available cached tokens and TTFT percentiles are shown with their real numbers', async () => {
    const { context, mp } = await openScenario({ telemetry: 'available' });
    try {
      const text = (await mp.telemetry.innerText()).replace(/\s+/g, ' ');
      expect(text).toMatch(labelled(/cached tokens/, /9,?000(?![\d,])/));
      expect(text).not.toMatch(labelled(/cached tokens/, /unavailable/));
      expect(text).toMatch(
        labelled(
          /(?:time to first token|ttft)/,
          /[^.]{0,20}412\s*ms[^.]{0,40}(?:1\.2\s*s|1,?180\s*ms)/,
        ),
      );
      expect(text).not.toMatch(
        labelled(/(?:time to first token|ttft)/, /unavailable/),
      );
    } finally {
      await context.close();
    }
  });
});
