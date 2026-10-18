// Leak scanning. The raw haystacks (console, page errors, request URLs and
// headers, response bodies, event-stream frames, the DOM) are scanned with the
// raw secret values. Only the NAME of a haystack that leaks is ever reported,
// never the value, so a failing scan cannot print a secret.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT, rawSecretValues, readLocalSecrets } from './env.js';
import type { RawCapture } from './ui.js';

export interface Haystack {
  name: string;
  text: string;
}

/**
 * Values that must never reach a browser: the Crusoe and Intelligence keys,
 * the stack's probe secret, database role URLs and their passwords. The owner
 * token is deliberately NOT here: it is legitimately sent in an Authorization
 * header (it is checked separately and must never be in a URL).
 */
export function serverSecretNeedles(extra: readonly string[] = []): string[] {
  const local = Object.values(
    readLocalSecrets([
      'OPENAI_API_KEY',
      'CRUSOE_API_KEY',
      'CPK_INTELLIGENCE_API_KEY',
    ]),
  );
  const all = [...local, ...extra, ...rawSecretValues()];
  const expanded = all.flatMap((v) => [v, encodeURIComponent(v)]);
  return [...new Set(expanded)].filter((v) => v.length >= 8);
}

/** Names (never values) of the haystacks that contain any needle. */
export function findLeaks(
  haystacks: readonly Haystack[],
  needles: readonly string[],
): string[] {
  const leaking = new Set<string>();
  for (const { name, text } of haystacks)
    if (needles.some((needle) => text.includes(needle))) leaking.add(name);
  return [...leaking].sort();
}

export function captureHaystacks(
  raw: RawCapture,
  extra: readonly Haystack[] = [],
): Haystack[] {
  return [
    { name: 'console', text: raw.console.join('\n') },
    { name: 'pageerror', text: raw.pageErrors.join('\n') },
    {
      name: 'request-urls',
      text: raw.requests.map((r) => r.url).join('\n'),
    },
    {
      name: 'request-headers',
      text: raw.requests.map((r) => JSON.stringify(r.headers)).join('\n'),
    },
    {
      name: 'request-bodies',
      text: raw.requests.map((r) => r.postData ?? '').join('\n'),
    },
    {
      name: 'response-headers',
      text: raw.responses.map((r) => JSON.stringify(r.headers)).join('\n'),
    },
    {
      name: 'response-bodies',
      text: raw.responses.map((r) => r.body).join('\n'),
    },
    { name: 'event-stream-frames', text: raw.streamFrames.join('') },
    ...extra,
  ];
}

/** Built client assets that contain a needle (relative names only). */
export function leakingBuiltAssets(needles: readonly string[]): string[] {
  const root = resolve(APP_ROOT, 'dist/client');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)],
    );
  const out: string[] = [];
  for (const file of walk(root)) {
    if (statSync(file).size > 20_000_000) continue;
    const content = readFileSync(file, 'latin1');
    if (needles.some((n) => content.includes(n)))
      out.push(file.slice(root.length + 1));
  }
  return out;
}
