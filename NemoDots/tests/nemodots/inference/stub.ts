import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  ChatRequest,
  ModelCallId,
} from '../../../src/server/nemodots/contracts/index.js';
import { CrusoeInferenceClient } from '../../../src/server/nemodots/inference/client.js';

// A local Node http stub standing in for Crusoe. Every fact it emits is taken
// from CRUSOE_SMOKE_PRE.md; tests using it are stub-verified, never live.

export interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
}
export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  seen: Seen,
  index: number,
) => void | Promise<void>;

export interface Stub {
  baseUrl: string;
  host: string;
  seen: Seen[];
  maxConcurrent: () => number;
  close: () => Promise<void>;
}

export async function startStub(handler: Handler): Promise<Stub> {
  const seen: Seen[] = [];
  let active = 0;
  let max = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) body = JSON.parse(text);
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      const index = seen.push(entry) - 1;
      active++;
      max = Math.max(max, active);
      res.on('close', () => active--);
      void handler(req, res, entry, index);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    host: `127.0.0.1:${port}`,
    seen,
    maxConcurrent: () => max,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const API_KEY = 'test-key-not-a-real-secret-0123456789';

export function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`;
}

export function usageChunk(usage: Record<string, unknown>) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-x',
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    choices: [],
    usage,
  })}\n\n`;
}

export const DONE = 'data: [DONE]\n\n';

export function sse(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** A normal streamed text answer. */
export function textStream(res: ServerResponse, words: string[], usage: Record<string, unknown> | null = { prompt_tokens: 30, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } }) {
  sse(res);
  res.write(chunk({ role: 'assistant', content: '' }));
  for (const w of words) res.write(chunk({ content: w }));
  res.write(chunk({}, 'stop'));
  if (usage) res.write(usageChunk(usage));
  res.write(DONE);
  res.end();
}

export const MODEL = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';

export function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'ping' },
    ],
    tools: [],
    toolSchemaHash: null,
    maxTokens: null,
    reasoningEffort: null,
    responseFormat: null,
    stream: true,
    ...over,
  };
}

export function ctx(signal: AbortSignal = new AbortController().signal) {
  return { signal, modelCallId: randomUUID() as ModelCallId, role: 'worker' as const };
}

export function client(stub: Stub, over: Partial<ConstructorParameters<typeof CrusoeInferenceClient>[0]> = {}) {
  const sleeps: number[] = [];
  const instance = new CrusoeInferenceClient({
    baseUrl: stub.baseUrl,
    apiKey: API_KEY,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...over,
  });
  return { client: instance, sleeps };
}
