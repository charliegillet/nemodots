// Shared UI assertions used by both the live rows and the fulfilled-snapshot
// rows, so the two kinds of row hold the same standard.
import type { Page } from 'playwright';
import { expect } from 'playwright/test';
import type {
  Authorization,
  MissionSnapshot,
  ObservationReceipt,
} from '../../../../../src/server/nemodots/contracts/index.js';
import { MissionPage, labelled, rowCells } from './mission-page.js';
import { escapeRe, humanize, statusText } from './ui.js';

export const short = (id: string) => id.slice(0, 8);

export function receiptRow(mp: MissionPage, r: ObservationReceipt) {
  return mp.ledger
    .getByRole('row')
    .filter({ hasText: r.source.key })
    .filter({ hasText: short(r.id) });
}

/** One ledger row: exact cells for revision, status, trust and source. */
export async function checkReceiptRow(mp: MissionPage, r: ObservationReceipt) {
  const row = receiptRow(mp, r);
  await expect(row, `ledger row for receipt ${short(r.id)}`).toHaveCount(1);
  const cells = await rowCells(row);
  expect(cells.revision, `Revision cell of receipt ${short(r.id)}`).toBe(
    String(r.sourceRevision),
  );
  expect(cells.status, `Status cell of receipt ${short(r.id)}`).toMatch(
    statusText(r.status),
  );
  expect(
    cells.trust?.toLowerCase(),
    `Trust cell of receipt ${short(r.id)}`,
  ).toContain(humanize(r.trust));
  expect(cells.source).toContain(r.source.key);
}

/**
 * Enter on the receipt's own trigger opens a drilldown that did not exist
 * before; it is a dialog or complementary landmark named for the receipt.
 */
export async function checkReceiptDrilldown(
  page: Page,
  mp: MissionPage,
  r: ObservationReceipt,
  older: ObservationReceipt | null,
) {
  const name = new RegExp(
    `${escapeRe(short(r.id))}|${escapeRe(r.id)}|${escapeRe(r.source.key)}`,
    'i',
  );
  const detail = page
    .getByRole('dialog', { name })
    .or(page.getByRole('complementary', { name }))
    .first();
  await expect(detail, 'no drilldown before Enter').toBeHidden();
  const trigger = receiptRow(mp, r).getByRole('button').first();
  await mp.tabTo(trigger);
  await page.keyboard.press('Enter');
  await expect(
    detail,
    `drilldown for ${short(r.id)} after Enter`,
  ).toBeVisible();
  await expect(detail).toContainText(short(r.id));
  await expect(detail).toContainText(r.contentDigest.slice(0, 12));
  await expect(detail).toContainText(
    new RegExp(escapeRe(humanize(r.trust)), 'i'),
  );
  await expect(detail).toContainText(
    new RegExp(escapeRe(humanize(r.provenance.kind)), 'i'),
  );
  await expect(detail).toContainText(statusText(r.status));
  await expect(detail).toContainText(
    labelled(/revision/, new RegExp(`${r.sourceRevision}(?!\\d)`)),
  );
  if (older)
    await expect(
      detail
        .getByRole('link', { name: new RegExp(short(older.id)) })
        .or(detail.getByRole('button', { name: new RegExp(short(older.id)) }))
        .first(),
      'link to the superseded receipt',
    ).toBeVisible();
}

/** The version pair of one decision, as "expected N, live M" in its own stage. */
export function versionPair(decision: Authorization) {
  return labelled(
    /expected/,
    new RegExp(
      `${decision.targetVersion.expected}\\b,?\\s*live\\s*${decision.targetVersion.live}\\b`,
    ),
  );
}

/** Every stage decision of one selected action, each in its own stage region. */
export async function checkActionStages(
  mp: MissionPage,
  snapshot: MissionSnapshot,
  actionId: string,
) {
  const decisions = snapshot.authorizations.filter(
    (a) => a.actionId === actionId,
  );
  expect(
    decisions.length,
    'the action has authorization decisions',
  ).toBeGreaterThan(0);
  for (const d of decisions) {
    const region = mp.inspector.getByRole('region', {
      name: new RegExp(`^${d.stage} stage`, 'i'),
    });
    await expect(region, `${d.stage} stage region`).toBeVisible();
    await expect(region.locator('[data-status]').first()).toHaveAttribute(
      'data-status',
      d.decision,
    );
    await expect(region).toContainText(versionPair(d));
    if (d.blockReason)
      await expect(region).toContainText(
        new RegExp(escapeRe(humanize(d.blockReason)), 'i'),
      );
    if (d.dispatchFence)
      await expect(region).toContainText(
        labelled(
          /fence/,
          new RegExp(`(?:token\\s*)?${d.dispatchFence.token}\\b`),
        ),
      );
    if (d.checkedVector.length > 0)
      await expect(
        region
          .getByRole('table', { name: 'Checked dependency vector' })
          .getByRole('row'),
      ).toHaveCount(d.checkedVector.length + 1);
  }
}
