// Browser helpers: system Chrome via Playwright, console/network capture, and
// locators that rely only on accessible names and roles (documented in
// FRONTEND.md section 8 and the component aria-labels), never on CSS classes.
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { APP_URL, redact } from './env.js';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export async function launchChrome(): Promise<Browser> {
  const executablePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!executablePath)
    throw new Error(
      'BLOCKED: system Chrome not found; Gate 7 browser rows cannot run (no substitute is used).',
    );
  return chromium.launch({ executablePath, headless: true });
}

export interface Captured {
  console: { type: string; text: string }[];
  pageErrors: string[];
  requests: { method: string; url: string; status?: number }[];
  responseBodies: string[];
}

export async function newPage(
  browser: Browser,
  options: { token?: string | null; viewport?: { width: number; height: number } } = {},
): Promise<{ context: BrowserContext; page: Page; captured: Captured }> {
  const context = await browser.newContext({
    baseURL: APP_URL,
    viewport: options.viewport ?? { width: 1360, height: 900 },
  });
  if (options.token)
    await context.addInitScript((t) => {
      try {
        sessionStorage.setItem('opendots-token', t);
      } catch {
        // storage unavailable
      }
    }, options.token);
  const page = await context.newPage();
  const captured: Captured = { console: [], pageErrors: [], requests: [], responseBodies: [] };
  page.on('console', (m) => captured.console.push({ type: m.type(), text: redact(m.text()) }));
  page.on('pageerror', (e) => captured.pageErrors.push(redact(String(e))));
  page.on('request', (r) => captured.requests.push({ method: r.method(), url: r.url() }));
  page.on('response', async (r) => {
    const entry = captured.requests.find((x) => x.url === r.url() && x.status === undefined);
    if (entry) entry.status = r.status();
    if (r.url().includes('/api/nemodots/') && !r.url().endsWith('/events')) {
      try {
        captured.responseBodies.push(await r.text());
      } catch {
        // body unavailable (redirect, aborted)
      }
    }
  });
  return { context, page, captured };
}

export const missionHash = (id?: string) => `#/missions/${id ?? ''}`;

export async function openMissionPage(page: Page, id?: string) {
  await page.goto(`/${missionHash(id)}`);
  await page.waitForLoadState('domcontentloaded');
}

/** Visible text of a named panel (role=region from Panel's aria-label). */
export const panel = (page: Page, name: string | RegExp) =>
  page.getByRole('region', { name });

export const humanize = (value: string) => value.replace(/_/g, ' ');

/** Case-insensitive regex for a status shown as text ("blocked_provider" -> /blocked provider/i). */
export const statusText = (value: string) =>
  new RegExp(`\\b${humanize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

export function consoleErrors(captured: Captured) {
  return captured.console.filter((m) => m.type === 'error' || m.type === 'assert');
}
