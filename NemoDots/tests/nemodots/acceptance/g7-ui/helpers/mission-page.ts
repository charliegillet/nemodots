// Page object for the integrated mission page.
//
// UI contract the suite relies on (from FRONTEND.md sections 8/12, the W3.5
// component aria-labels and the W4.3 brief; nothing here reads CSS classes):
//   - hash route `#/missions/:id?`, a "Missions" navigation entry
//   - lifecycle buttons accessible as Start / Pause / Resume / Cancel; a button
//     the server would refuse (409) is disabled
//   - panels exposed as regions named: "Task tree", "Evidence ledger",
//     "Dependencies", "Actions", "Action inspector", "Recovery timeline",
//     "System health", "Telemetry", "Findings"
//   - the run mode as role=group named "Run mode: <Live|Fixture|Blocked>. ..."
//   - the Intelligence status as a role=group named "Intelligence <state>. ..."
//   - status pills carry data-status and the status as visible text
//   - loading panels use role=status, failed panels role=alert
import type { Locator, Page } from 'playwright';
import { expect } from 'playwright/test';
import type { MissionSnapshot } from '../../../../../src/server/nemodots/contracts/index.js';
import { humanize } from './ui.js';

export class MissionPage {
  constructor(readonly page: Page) {}

  region(name: string | RegExp): Locator {
    return this.page.getByRole('region', { name });
  }
  get taskTree() {
    return this.region('Task tree');
  }
  get ledger() {
    return this.region('Evidence ledger');
  }
  get actions() {
    return this.region(/^Actions$/);
  }
  get inspector() {
    return this.region('Action inspector');
  }
  get recovery() {
    return this.region('Recovery timeline');
  }
  get health() {
    return this.region('System health');
  }
  get telemetry() {
    return this.region('Telemetry');
  }
  get findings() {
    return this.region('Findings');
  }

  button(name: RegExp): Locator {
    return this.page.getByRole('button', { name });
  }
  get start() {
    return this.button(/^start\b/i);
  }
  get pause() {
    return this.button(/^pause\b/i);
  }
  get resume() {
    return this.button(/^resume\b/i);
  }
  get cancel() {
    return this.button(/^cancel\b/i);
  }

  get create() {
    return this.page
      .getByRole('button', { name: /(create|new).{0,12}mission|^create$/i })
      .first();
  }
  get modeBadge() {
    return this.page.getByRole('group', { name: /^Run mode:/ });
  }
  get intelligenceBadge() {
    return this.page.getByRole('group', { name: /^Intelligence/ });
  }

  /** The main mission area (everything outside the app navigation chrome). */
  get main() {
    return this.page.locator('main');
  }

  async text(): Promise<string> {
    return (await this.main.innerText()).replace(/\s+/g, ' ');
  }

  async expectStatus(status: string, timeout = 30_000) {
    await expect(
      this.main
        .locator('[data-status]')
        .filter({ hasText: new RegExp(humanize(status), 'i') })
        .first(),
      `mission page shows status text "${humanize(status)}"`,
    ).toBeVisible({ timeout });
  }

  async tabTo(target: Locator, maxTabs = 200): Promise<number> {
    await this.page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await this.page
      .locator('body')
      .click({ position: { x: 1, y: 1 } })
      .catch(() => undefined);
    for (let i = 1; i <= maxTabs; i += 1) {
      await this.page.keyboard.press('Tab');
      const focused = await target
        .evaluate((el) => el === document.activeElement)
        .catch(() => false);
      if (focused) return i;
    }
    throw new Error(`Not reachable by keyboard within ${maxTabs} Tab presses`);
  }
}

/** Substrings a receipt row/drilldown must show for a snapshot receipt. */
export function receiptFacts(snapshot: MissionSnapshot) {
  return snapshot.receipts.map((r) => ({
    id: r.id,
    shortId: r.id.slice(0, 8),
    sourceKey: r.source.key,
    revision: r.sourceRevision,
    status: r.status,
    trust: r.trust,
    provenanceKind: r.provenance.kind,
    digest: r.contentDigest,
    supersedes: r.supersedes,
  }));
}
