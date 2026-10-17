// Gate 7 (frontend and observability) shared constants and secret handling.
// Port block 4740 (checkout) / 4741 (app), DB name prefix acc7_, Redis db 8 on
// 56379, so this suite can run beside the other acceptance suites.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
export const WORKTREE_ROOT = resolve(APP_ROOT, '..');
export const SCRATCH = resolve(APP_ROOT, '.local/acceptance/g7');

export const CHECKOUT_PORT = 4740;
export const APP_PORT = 4741;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;
export const CHECKOUT_URL = `http://127.0.0.1:${CHECKOUT_PORT}`;
export const API = `${APP_URL}/api/nemodots`;
export const DB_PREFIX = 'acc7_';
export const REDIS_DB_INDEX = 8;

/** TEST_PROMPT gate 7 case numbering used in test titles: [G7.n]. */
export const G7_CASES = {
  1: 'mission lifecycle: start / pause / resume / cancel from the UI, matching server state',
  2: 'run-mode labels: setup (blocked) / live / fixture; Intelligence badge separate',
  3: 'evidence drilldown to typed receipts (rev, digest, trust, provenance, status)',
  4: 'task tree reflects server tasks, parents, depth, delegation justification',
  5: 'action inspector: stage, decision, checked vector, block reason, dispatch fence, script result',
  6: 'recovery timeline in causal order (receipt, block, repair attempt, invalidation, resolved)',
  7: 'verification results: probe verdict / invariants / health samples',
  8: 'refresh / reconnect mid-run: dedup by event id, reconstruction from snapshot',
  9: 'keyboard access to every control and drilldown',
  10: 'non-colour status text for every status',
  11: 'empty / error / loading states',
  12: 'bounded rendering for large missions',
  13: 'successful and failed missions both render their terminal state and reason',
  14: 'page projections link to typed facts (receipt id + revision)',
  15: 'telemetry shows "unavailable" instead of invented numbers or savings',
  16: 'upstream page / chat views still work and owner / auth / origin protections are preserved',
  17: 'no secret values, control data or prompts reach the DOM, network or built assets',
} as const;
export type G7Case = keyof typeof G7_CASES;

// ---------------------------------------------------------------- secrets

const secretValues = new Set<string>();

/** Registers a value so every log line this suite prints has it replaced. */
export function registerSecret(value: string | undefined) {
  if (value && value.length >= 6) secretValues.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const value of secretValues) out = out.split(value).join('[redacted]');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[redacted]@');
}

function parseDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) out[match[1]!] = value;
  }
  return out;
}

/** Values from the gitignored .env files, only the names asked for. Never printed. */
export function readLocalSecrets(names: readonly string[]) {
  const merged = {
    ...parseDotenv(resolve(WORKTREE_ROOT, '.env')),
    ...parseDotenv(resolve(APP_ROOT, '.env')),
  };
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name] || merged[name];
    if (value) {
      out[name] = value;
      registerSecret(value);
    }
  }
  return out;
}

export interface LiveCredentials {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
}

/** Crusoe credentials for live-mode runs, or the names that are missing. */
export function liveCredentials():
  | { ok: true; env: LiveCredentials }
  | { ok: false; missing: string[] } {
  const found = readLocalSecrets([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
    'CRUSOE_API_KEY',
  ]);
  const key = found.OPENAI_API_KEY ?? found.CRUSOE_API_KEY;
  const baseUrl =
    found.OPENAI_BASE_URL ?? 'https://api.inference.crusoecloud.com/v1';
  const model = found.OPENAI_MODEL ?? 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
  const missing = key ? [] : ['OPENAI_API_KEY'];
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    env: {
      OPENAI_API_KEY: key!,
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: model,
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

export async function until<T>(
  describe: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value as T;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for: ${describe}${
          lastError ? ` (last error: ${redact(String(lastError))})` : ''
        }`,
      );
    await sleep(options.intervalMs ?? 250);
  }
}
