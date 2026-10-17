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
//   - the MISSION-level status is a pill inside a region named "Mission" (or an
//     element with data-testid="mission-status"); it is the only element the
//     lifecycle assertions read, so a task pill can never stand in for it
//   - loading panels use role=status, failed panels role=alert
import type { Locator, Page } from 'playwright';
import { expect } from 'playwright/test';
import type { MissionSnapshot } from '../../../../../src/server/nemodots/contracts/index.js';
import { escapeRe, humanize, statusText } from './ui.js';

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

  /** The mission-level status pill (never a task, action or receipt pill). */
  get missionStatus(): Locator {
    return this.page
      .getByRole('region', {
        name: /^Mission(?: (?:header|summary|status|overview))?$/i,
      })
      .locator('[data-status]')
      .first()
      .or(this.page.getByTestId('mission-status'))
      .first();
  }

  /** Asserts the mission-level status equals `status` in data-status and in text. */
  async expectStatus(status: string, timeout = 30_000) {
    await expect(
      this.missionStatus,
      `mission-level status is exactly "${status}"`,
    ).toHaveAttribute('data-status', status, { timeout });
    await expect(this.missionStatus).toContainText(statusText(status));
  }

  /** The row element of one task (its own row, not its nested children). */
  taskRow(title: string): Locator {
    return this.taskTree
      .getByRole('listitem')
      .filter({ hasText: title })
      .last()
      .locator(':scope > *')
      .first();
  }

  /** Main-area text with every button label removed (for claim scans). */
  async textWithoutButtons(): Promise<string> {
    return this.main.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll('button, [role="button"], input, select, textarea')
        .forEach((node) => node.remove());
      return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ');
    });
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

/**
 * Text of a table row keyed by lower-cased column header, so a cell can be
 * asserted as "the Revision cell is exactly 32" instead of "32 appears
 * somewhere in the row".
 */
export async function rowCells(row: Locator): Promise<Record<string, string>> {
  return row.evaluate((el) => {
    const table = el.closest('table');
    const heads = Array.from(
      table?.querySelectorAll('thead th') ?? [],
    ).map((th) => (th.textContent ?? '').trim().toLowerCase());
    const cells = Array.from(el.children).map((c) =>
      (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    return Object.fromEntries(heads.map((h, i) => [h, cells[i] ?? '']));
  });
}

/** `label` followed by `value` (labels may be dt/dd, th/td or "Label: value"). */
export function labelled(label: string | RegExp, value: string | RegExp) {
  const l = typeof label === 'string' ? escapeRe(label) : label.source;
  const v = typeof value === 'string' ? escapeRe(value) : value.source;
  return new RegExp(`(?:${l})\\s*:?\\s*(?:${v})`, 'i');
}

/** A test whose live precondition was not produced FAILS with this error. */
export function precondition(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`PRECONDITION NOT PRODUCED: ${message}`);
}

export { humanize };
