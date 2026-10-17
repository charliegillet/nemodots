// Browser helpers: system Chrome via Playwright, console/network capture, and
// locators that rely only on accessible names and roles (documented in
// FRONTEND.md section 8 and the component aria-labels), never on CSS classes.
//
// Capture keeps TWO copies of everything the browser produced:
//   - `raw`: untouched, never printed, used only for leak scanning;
//   - the top-level fields: redacted, safe to appear in an assertion message.
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from 'playwright';
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

export interface RawCapture {
  console: string[];
  pageErrors: string[];
  requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    postData: string | null;
  }[];
  responses: {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
  }[];
  /** Event-stream text as the page's fetch delivered it (needs `tapStream`). */
  streamFrames: string[];
}

export interface Captured {
  console: { type: string; text: string }[];
  pageErrors: string[];
  requests: { method: string; url: string; status?: number }[];
  raw: RawCapture;
  /** Waits for in-flight header/body reads so `raw` is complete. */
  settle: () => Promise<void>;
  /** Event ids and Last-Event-ID headers seen on the events stream. */
  eventsRequests: () => Promise<
    { url: string; lastEventId: string | null; authorization: boolean }[]
  >;
}

/**
 * Wraps window.fetch for the mission event stream. It copies every frame into
 * window.__ndFrames, tracks the highest event id delivered in
 * window.__ndMaxEventId, and exposes window.__ndDropStream() to sever the live
 * connection deterministically (the reader errors, as in a network drop).
 */
const STREAM_TAP = `(() => {
  if (window.__ndTap) return;
  window.__ndTap = true;
  window.__ndFrames = [];
  window.__ndMaxEventId = 0;
  window.__ndDrops = [];
  window.__ndDropStream = () => { const n = window.__ndDrops.length; window.__ndDrops.forEach((d) => d()); return n; };
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await original(...args);
    let url = '';
    try { url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url; } catch (e) { return response; }
    if (!/\\/missions\\/[^/?]+\\/events(?:\\?|$)/.test(url) || !response.body) return response;
    const reader = response.body.getReader();
    let pending = '';
    const stream = new ReadableStream({
      start(controller) {
        const decoder = new TextDecoder();
        window.__ndDrops.push(() => {
          try { controller.error(new TypeError('network error (test drop)')); } catch (e) {}
          reader.cancel().catch(() => {});
        });
        (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) { controller.close(); return; }
              controller.enqueue(value);
              const text = decoder.decode(value, { stream: true });
              window.__ndFrames.push(text);
              pending += text;
              const lines = pending.split('\\n');
              pending = lines.pop() || '';
              for (const line of lines) {
                const m = /^id:\\s*(\\d+)/.exec(line);
                if (m) window.__ndMaxEventId = Math.max(window.__ndMaxEventId, Number(m[1]));
              }
            }
          } catch (e) { try { controller.error(e); } catch (e2) {} }
        })();
      },
      cancel() { return reader.cancel(); },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
})();`;

export async function newPage(
  browser: Browser,
  options: {
    token?: string | null;
    viewport?: { width: number; height: number };
    /** Install the event-stream tap (frames, max id, deterministic drop). */
    tapStream?: boolean;
  } = {},
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
  if (options.tapStream) await context.addInitScript(STREAM_TAP);
  const page = await context.newPage();
  const raw: RawCapture = {
    console: [],
    pageErrors: [],
    requests: [],
    responses: [],
    streamFrames: [],
  };
  const pending: Promise<unknown>[] = [];
  const events: {
    url: string;
    lastEventId: Promise<string | null>;
    authorization: Promise<boolean>;
  }[] = [];
  const captured: Captured = {
    console: [],
    pageErrors: [],
    requests: [],
    raw,
    settle: async () => {
      await Promise.allSettled(pending);
      try {
        const frames = await page.evaluate(
          () =>
            (window as unknown as { __ndFrames?: string[] }).__ndFrames ?? [],
        );
        raw.streamFrames = frames;
      } catch {
        // page closed; keep what was captured before
      }
    },
    eventsRequests: async () =>
      Promise.all(
        events.map(async (e) => ({
          url: redact(e.url),
          lastEventId: await e.lastEventId,
          authorization: await e.authorization,
        })),
      ),
  };
  page.on('console', (m) => {
    raw.console.push(m.text());
    captured.console.push({ type: m.type(), text: redact(m.text()) });
  });
  page.on('pageerror', (e) => {
    raw.pageErrors.push(String(e));
    captured.pageErrors.push(redact(String(e)));
  });
  page.on('request', (r) => {
    const entry = { method: r.method(), url: redact(r.url()) };
    captured.requests.push(entry);
    const rawEntry = {
      method: r.method(),
      url: r.url(),
      headers: {} as Record<string, string>,
      postData: r.postData(),
    };
    raw.requests.push(rawEntry);
    const headers = r.allHeaders().then(
      (h) => {
        rawEntry.headers = h;
        return h;
      },
      () => ({}) as Record<string, string>,
    );
    pending.push(headers);
    if (/\/api\/nemodots\/missions\/[^/?]+\/events(?:\?|$)/.test(r.url()))
      events.push({
        url: r.url(),
        lastEventId: headers.then((h) => h['last-event-id'] ?? null),
        authorization: headers.then((h) => /^Bearer\s+\S+/.test(h.authorization ?? '')),
      });
  });
  page.on('response', (r) => {
    const entry = captured.requests.find(
      (x) => x.url === redact(r.url()) && x.status === undefined,
    );
    if (entry) entry.status = r.status();
    const type = r.headers()['content-type'] ?? '';
    if (!r.url().includes('/api/') || type.includes('text/event-stream'))
      return;
    pending.push(
      (async () => {
        try {
          raw.responses.push({
            url: r.url(),
            status: r.status(),
            headers: await r.allHeaders(),
            body: await r.text(),
          });
        } catch {
          // body unavailable (redirect, aborted)
        }
      })(),
    );
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

export const escapeRe = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive regex for a status shown as text ("blocked_provider" -> /blocked provider/i). */
export const statusText = (value: string) =>
  new RegExp(`\\b${escapeRe(humanize(value))}\\b`, 'i');

export function consoleErrors(captured: Captured) {
  return captured.console.filter(
    (m) => m.type === 'error' || m.type === 'assert',
  );
}

/** The highest event id and frames the page's stream tap has seen. */
export async function streamState(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __ndMaxEventId?: number;
      __ndFrames?: string[];
    };
    return { maxEventId: w.__ndMaxEventId ?? 0, frames: w.__ndFrames ?? [] };
  });
}

/** Severs the live event stream; returns how many streams were open. */
export async function dropStream(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __ndDropStream?: () => number }).__ndDropStream?.() ?? 0,
  );
}
