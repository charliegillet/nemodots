import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChatRequest,
  ModelCallId,
} from '../../../../src/server/nemodots/contracts/index.js';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import { CrusoeInferenceClient } from '../../../../src/server/nemodots/inference/client.js';
import { resolveMode } from '../../../../src/server/nemodots/inference/mode.js';
import type { StampedChatResult } from '../../../../src/server/nemodots/inference/types.js';

// Live-suite support: .env loading inside this process only, the BLOCKED
// gate, redacted result recording, and the secret scan. Nothing here prints a
// value from .env.

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const LIVE_NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];

/** Fills OPENAI_* from NemoDots/.env for names that are undefined (an empty value stays empty). */
export function loadDotEnv(file = join(APP_ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !LIVE_NAMES.includes(match[1])) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
export const LIGHTNING = 'nvidia/Nemotron-3.5-Lightning-30B-A3B';

export interface LiveEnv {
  apiKey: string;
  baseUrl: string;
  host: string;
}

/** Fails loudly (never skips) when live requirements are unmet. */
export function requireLive(): LiveEnv {
  loadDotEnv();
  const mode = resolveMode(process.env);
  if (mode.mode !== 'live') {
    const names = mode.missingEnv.length
      ? mode.missingEnv
      : mode.invalidEnv.length
        ? mode.invalidEnv
        : ['live mode'];
    const message = `BLOCKED: ${names.join(', ')} missing`;
    console.error(message);
    writeResults({ status: 'BLOCKED', blocked: message, checks: [] });
    throw new Error(message);
  }
  const baseUrl = process.env.OPENAI_BASE_URL!.trim();
  return {
    apiKey: process.env.OPENAI_API_KEY!.trim(),
    baseUrl,
    host: new URL(baseUrl).host,
  };
}

export function liveClient(
  env: LiveEnv,
  over: Partial<ConstructorParameters<typeof CrusoeInferenceClient>[0]> = {},
) {
  return new CrusoeInferenceClient({
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    maxInFlight: 2, // the live suite stays within 2 in flight
    ...over,
  });
}

export function callContext(
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    signal,
    modelCallId: randomUUID() as ModelCallId,
    role: 'worker' as const,
  };
}

export function chat(over: Partial<ChatRequest>): ChatRequest {
  return {
    model: SUPER,
    messages: [{ role: 'system', content: 'You are terse.' }],
    tools: [],
    toolSchemaHash: null,
    maxTokens: 256,
    reasoningEffort: null,
    responseFormat: null,
    stream: true,
    ...over,
  };
}

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'NOT_RUN';
  /** Redacted observations: ids, timings, token counts, digests and sizes. Never content. */
  observed?: Record<string, unknown>;
  note?: string;
}

const checks: Check[] = [];
export function record(check: Check) {
  checks.push(check);
}

/** Digest and size of model text, never the text. */
export function describeText(text: string | null) {
  return text === null
    ? null
    : { bytes: Buffer.byteLength(text), digest: digest(text) };
}

export function describeResult(result: StampedChatResult) {
  return {
    outcome: result.outcome,
    finishReason: result.finishReason,
    modelReturned: result.modelReturned,
    provider: result.provider,
    usage: result.usage,
    content: describeText(result.content),
    reasoning: describeText(result.reasoning),
    toolCalls: result.toolCalls.map((c) => ({
      idPrefix: c.toolCallId.slice(0, 14),
      name: c.name,
      argumentsBytes: Buffer.byteLength(c.arguments),
    })),
    attempts: result.attempts.map((a) => ({
      n: a.n,
      httpStatus: a.httpStatus,
      streamed: a.streamed,
      startedAt: a.startedAt,
      headersAt: a.headersAt,
      firstContentAt: a.firstContentAt,
      finishedAt: a.finishedAt,
      finishReason: a.finishReason,
      error: a.error,
      retryAfterMs: a.retryAfterMs,
      usage: a.usage,
    })),
  };
}

export function resultsDir() {
  const instance = process.env.NEMODOTS_INSTANCE ?? 'dev';
  return join(APP_ROOT, '.local', instance, 'live');
}

/** Writes the redacted results file and refuses to leave one containing the key. */
export function writeResults(extra: {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  blocked?: string;
  checks?: Check[];
}) {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const body = {
    suite: 'inference-live',
    at: new Date().toISOString(),
    status: extra.status,
    blocked: extra.blocked ?? null,
    host: safeHost(),
    checks: extra.checks ?? checks,
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key && key.length >= 6 && text.includes(key))
    throw new Error('secret found in live results; file not written');
  writeFileSync(join(dir, 'inference.json'), text, { mode: 0o600 });
  return join(dir, 'inference.json');
}

function safeHost() {
  try {
    return new URL(process.env.OPENAI_BASE_URL ?? '').host;
  } catch {
    return null;
  }
}

export function allChecks() {
  return checks;
}
