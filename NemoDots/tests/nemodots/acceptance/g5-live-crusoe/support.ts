// Gate 5 support: environment loading, entry-point resolution, a verifier-owned
// pass-through proxy and request builders. Local to g5-live-crusoe.
//
// Port block (acceptance parallelism): checkout 4700, app 4701, DB prefix
// "acc5_", Redis db index 6 on 56379. Gate 5 itself needs only the inference
// adapter and its own loopback proxy (OS-assigned port); the app-level cases
// (G5.3, G5.5-app, G5.8) talk to the app on 4701.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  InferencePort,
  ModelCallId,
  ModelRole,
} from '../../../../src/server/nemodots/contracts/index.js';

export const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const PORTS = {
  checkout: 4700,
  app: 4701,
  redisDb: 6,
  dbPrefix: 'acc5_',
};
export const EXPECTED_HOST = 'api.inference.crusoecloud.com';
// LEAD_NOTES.md: verified primary model id (BUILD_PROMPT's id is wrong).
export const PRIMARY_MODEL = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
export const MAX_IN_FLIGHT = 3; // task rule for this suite; spec cap is 4
export const RETRYABLE = [
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'network',
];

export class BlockedError extends Error {
  constructor(message: string) {
    super(`BLOCKED: ${message}`);
    this.name = 'BlockedError';
  }
}
export class EntryPointMissing extends Error {
  constructor(entry: string, reason: string) {
    super(`ENTRY POINT MISSING: ${entry} (${reason})`);
    this.name = 'EntryPointMissing';
  }
}

// ---------------------------------------------------------------- env

function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Process env wins; NemoDots/.env fills gaps. Values are never printed. */
export function appEnv(): Record<string, string | undefined> {
  const file = parseDotenv(resolve(APP_ROOT, '.env'));
  return { ...file, ...(process.env as Record<string, string | undefined>) };
}

export interface LiveEnv {
  env: Record<string, string | undefined>;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function requireLive(): LiveEnv {
  const env = appEnv();
  const missing = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].filter(
    (n) => !env[n],
  );
  if (missing.length)
    throw new BlockedError(
      `live Crusoe acceptance needs ${missing.join(', ')} (names only). Gate 5 is BLOCKED, never skipped.`,
    );
  return {
    env,
    baseUrl: env.OPENAI_BASE_URL!.trim().replace(/\/+$/, ''),
    apiKey: env.OPENAI_API_KEY!.trim(),
    model: env.OPENAI_MODEL!.trim(),
  };
}

/** Keys must never appear in anything we serialise or assert on. */
export function assertNoSecret(value: unknown, secret: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (secret && text.includes(secret))
    throw new Error('SECRET LEAK: the API key appears in a record');
}

// ---------------------------------------------------------------- entry points

export async function loadModule<T = Record<string, unknown>>(
  relFromApp: string,
): Promise<T> {
  const url = pathToFileURL(resolve(APP_ROOT, relFromApp)).href;
  try {
    return (await import(/* @vite-ignore */ url)) as T;
  } catch (error) {
    throw new EntryPointMissing(
      relFromApp,
      `module did not load: ${(error as Error).message.split('\n')[0].slice(0, 160)}`,
    );
  }
}

export interface StampedResult extends ChatResult {
  provider: { host: string; mode: 'live' | 'fixture' };
}
export interface Adapter extends InferencePort {
  readonly mode: 'live' | 'fixture';
  complete(
    req: ChatRequest,
    ctx: { signal: AbortSignal; modelCallId: ModelCallId; role: ModelRole },
  ): Promise<StampedResult>;
  verifyModel(model: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * The APP adapter, built the way the server builds it: createInferenceFromEnv
 * (src/server/nemodots/inference/index.ts). Env is passed explicitly so a
 * test can point it at the verifier's proxy.
 */
export async function createAdapter(
  overrides: Record<string, string | undefined> = {},
): Promise<Adapter> {
  const mod = await loadModule<{
    createInferenceFromEnv?: (
      env: Record<string, string | undefined>,
    ) => Adapter;
  }>('src/server/nemodots/inference/index.ts');
  if (typeof mod.createInferenceFromEnv !== 'function')
    throw new EntryPointMissing(
      'inference/index.ts#createInferenceFromEnv',
      'export absent',
    );
  const env = {
    ...appEnv(),
    NEMODOTS_INFERENCE_MODE: 'live',
    NEMODOTS_INFERENCE_MAX_IN_FLIGHT: String(MAX_IN_FLIGHT),
    ...overrides,
  };
  return mod.createInferenceFromEnv(env);
}

export function ctx(role: ModelRole = 'worker', signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    modelCallId: randomUUID() as ModelCallId,
    role,
  };
}

export function chat(
  model: string,
  user: string,
  over: Partial<ChatRequest> = {},
): ChatRequest {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a terse assistant. Follow instructions exactly.',
      },
      { role: 'user', content: user },
    ],
    tools: [],
    toolSchemaHash: null,
    maxTokens: 64,
    reasoningEffort: 'none',
    responseFormat: null,
    stream: false,
    ...over,
  };
}

export const t = (iso: string | null | undefined) =>
  iso ? Date.parse(iso) : Number.NaN;

// ---------------------------------------------------------------- proxy

export interface SeenRequest {
  n: number;
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  bodyText: string;
  hasAuthorization: boolean;
  receivedAt: number;
  clientClosedEarly: boolean;
  closedAt: number | null;
  finishedAt: number | null;
  /** wall clock when the proxy wrote response headers to the client (SSE) */
  headersWrittenAt: number | null;
  /** wall clock when the proxy forwarded the first upstream content-bearing delta */
  firstContentForwardedAt: number | null;
}

export type Action =
  | { kind: 'forward' }
  | {
      kind: 'respond';
      status: number;
      body: string;
      headers?: Record<string, string>;
    }
  | { kind: 'destroy' }
  | {
      kind: 'forward';
      /** transform every parsed JSON body (non-stream) or SSE data event (stream) */
      transform?: (json: Record<string, unknown>) => Record<string, unknown>;
      /** SSE only: events written (with delay) before the first upstream byte */
      prelude?: string[];
      preludeDelayMs?: number;
      /** hold the request this long before contacting upstream (timeout class) */
      headerDelayMs?: number;
      /** SSE only: destroy the socket after this many upstream data events */
      destroyAfterEvents?: number;
    };

export interface Proxy {
  baseUrl: string;
  host: string;
  seen: SeenRequest[];
  maxConcurrent: () => number;
  current: () => number;
  setHandler(h: (req: SeenRequest) => Action | Promise<Action>): void;
  close(): Promise<void>;
}

/** Local pass-through to the real Crusoe endpoint. Never stores credentials. */
export async function startProxy(
  upstreamBase: string,
  handler?: (req: SeenRequest) => Action | Promise<Action>,
): Promise<Proxy> {
  let h = handler ?? (() => ({ kind: 'forward' }) as Action);
  const seen: SeenRequest[] = [];
  let current = 0;
  let max = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> | null = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    const rec: SeenRequest = {
      n: seen.length + 1,
      method: req.method ?? 'GET',
      url: req.url ?? '',
      body,
      bodyText,
      hasAuthorization: Boolean(req.headers.authorization),
      receivedAt: Date.now(),
      clientClosedEarly: false,
      closedAt: null,
      finishedAt: null,
      headersWrittenAt: null,
      firstContentForwardedAt: null,
    };
    seen.push(rec);
    current++;
    max = Math.max(max, current);
    const upstreamAbort = new AbortController();
    let done = false;
    res.on('close', () => {
      if (!done) {
        done = true;
        current--;
      }
      rec.closedAt = Date.now();
      if (!res.writableEnded) {
        rec.clientClosedEarly = true;
        upstreamAbort.abort();
      }
    });
    try {
      await serve(req, res, rec, await h(rec), upstreamBase, upstreamAbort);
    } catch {
      if (!res.writableEnded) res.destroy();
    } finally {
      rec.finishedAt = Date.now();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: `127.0.0.1:${port}`,
    seen,
    maxConcurrent: () => max,
    current: () => current,
    setHandler: (next) => {
      h = next;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  rec: SeenRequest,
  action: Action,
  upstreamBase: string,
  abort: AbortController,
) {
  if (action.kind === 'destroy') {
    res.destroy();
    return;
  }
  if (action.kind === 'respond') {
    res.writeHead(action.status, {
      'content-type': 'application/json',
      ...(action.headers ?? {}),
    });
    res.end(action.body);
    return;
  }
  if ('headerDelayMs' in action && action.headerDelayMs)
    await sleep(action.headerDelayMs);
  const path = rec.url.replace(/^\/v1/, '');
  const headers: Record<string, string> = {
    'content-type':
      (req.headers['content-type'] as string) ?? 'application/json',
    accept: (req.headers.accept as string) ?? '*/*',
  };
  if (req.headers.authorization)
    headers.authorization = req.headers.authorization as string;
  const upstream = await fetch(`${upstreamBase}${path}`, {
    method: rec.method,
    headers,
    body: rec.method === 'GET' ? undefined : rec.bodyText,
    signal: abort.signal,
  });
  const type = upstream.headers.get('content-type') ?? 'application/json';
  const isSse = type.includes('text/event-stream');
  const transform = 'transform' in action ? action.transform : undefined;
  if (!isSse || !upstream.body) {
    const text = await upstream.text();
    let out = text;
    if (transform && upstream.ok) {
      try {
        out = JSON.stringify(transform(JSON.parse(text)));
      } catch {
        out = text;
      }
    }
    res.writeHead(upstream.status, { 'content-type': type });
    res.end(out);
    return;
  }
  res.writeHead(upstream.status, {
    'content-type': type,
    'cache-control': 'no-cache',
  });
  rec.headersWrittenAt = Date.now();
  const prelude = 'prelude' in action ? (action.prelude ?? []) : [];
  const delay = 'preludeDelayMs' in action ? (action.preludeDelayMs ?? 0) : 0;
  const destroyAfter =
    'destroyAfterEvents' in action ? action.destroyAfterEvents : undefined;
  for (const ev of prelude) res.write(`data: ${ev}\n\n`);
  if (prelude.length && delay) await sleep(delay);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let events = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let out = raw;
      const m = /^data: (.*)$/s.exec(raw);
      if (transform && m && m[1].trim() !== '[DONE]') {
        try {
          out = `data: ${JSON.stringify(transform(JSON.parse(m[1])))}`;
        } catch {
          out = raw;
        }
      }
      if (rec.firstContentForwardedAt === null && m) {
        try {
          const c = JSON.parse(m[1])?.choices?.[0]?.delta?.content;
          if (typeof c === 'string' && c.length > 0)
            rec.firstContentForwardedAt = Date.now();
        } catch {
          /* [DONE] or partial */
        }
      }
      res.write(`${out}\n\n`);
      events++;
      if (destroyAfter !== undefined && events >= destroyAfter) {
        abort.abort();
        res.destroy();
        return;
      }
    }
  }
  if (buffer.trim()) res.write(`${buffer}\n\n`);
  res.end();
}

/** Delta chunk with empty content: not a "first nonempty token". */
export const emptyDelta = (model: string) =>
  JSON.stringify({
    id: 'acc5-prelude',
    object: 'chat.completion.chunk',
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
      },
    ],
  });

/** Raw `usage` object the provider returned (from non-stream body or last SSE chunk). */
export function rawUsageFromBody(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(text);
    return j.usage ?? undefined;
  } catch {
    return undefined;
  }
}

export function toolMessages(
  messages: { role: string; content: string; toolCalls?: unknown }[],
): ChatMessage[] {
  return messages as unknown as ChatMessage[];
}

/**
 * The Crusoe quota is shared with other agents in this checkout (observed 429
 * max_requests_limit bursts). A call that exhausted its retries purely on
 * rate_limited is provider saturation, not an adapter defect: repeat the whole
 * call (still real inference) up to `tries` times. Any other failure returns
 * immediately so it is reported.
 */
export async function completeThroughSaturation(
  adapter: Adapter,
  req: ChatRequest,
  role: ModelRole = 'worker',
  tries = 3,
): Promise<StampedResult> {
  let last!: StampedResult;
  for (let i = 0; i < tries; i++) {
    last = await adapter.complete(req, ctx(role));
    const saturated =
      last.outcome === 'failed' &&
      last.attempts.every((a) => a.error?.class === 'rate_limited');
    if (!saturated) return last;
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
  }
  return last;
}
