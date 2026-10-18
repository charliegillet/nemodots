import { expect, it } from 'vitest';
import { createFetchTelemetry } from '../../../src/server/nemodots/interception/index.js';

const URL_CHAT = 'https://crusoe.example/v1/chat/completions';
const sse = (chunks: unknown[]) =>
  new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
const chunk = (delta: object, finish: string | null = null, extra = {}) => ({
  id: 'x',
  model: 'nvidia/returned',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

it('records timing, returned model, finish reason and usage of a streamed call', async () => {
  const telemetry = createFetchTelemetry({
    baseFetch: async () =>
      sse([
        chunk({ role: 'assistant' }),
        chunk({ content: 'Hi' }),
        chunk({}, 'stop', {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      ]),
  });
  const response = await telemetry.fetch(URL_CHAT, { method: 'POST' });
  // The caller still receives the whole body.
  expect(await response.text()).toContain('Hi');
  await telemetry.settled();
  const [request] = telemetry.requests;
  expect(request).toMatchObject({
    host: 'crusoe.example',
    httpStatus: 200,
    streamed: true,
    finishReason: 'stop',
    modelReturned: 'nvidia/returned',
    error: null,
    // 0 is a real zero from the provider; reasoning tokens were absent -> null.
    usage: {
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 0,
      reasoningTokens: null,
    },
  });
  expect(request.headersAt).not.toBeNull();
  expect(request.firstContentAt).not.toBeNull();
  expect(request.finishedAt).not.toBeNull();
});

it('cached tokens stay null when prompt_tokens_details is absent', async () => {
  const telemetry = createFetchTelemetry({
    baseFetch: async () =>
      sse([
        chunk({ content: 'a' }, 'stop', {
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        }),
      ]),
  });
  await (await telemetry.fetch(URL_CHAT, {})).text();
  await telemetry.settled();
  expect(telemetry.requests[0].usage.cachedTokens).toBeNull();
});

it('classifies a 429 and keeps the provider code and error id, never the message', async () => {
  const telemetry = createFetchTelemetry({
    baseFetch: async () =>
      new Response(
        JSON.stringify({
          code: 'rate_limit_error',
          message: 'secret prompt echo',
          error_id: 'abc',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
  });
  const response = await telemetry.fetch(URL_CHAT, {});
  expect(response.status).toBe(429);
  await telemetry.settled();
  expect(telemetry.requests[0]).toMatchObject({
    httpStatus: 429,
    finishReason: 'error',
    error: { class: 'rate_limited', code: 'rate_limit_error', errorId: 'abc' },
  });
  expect(JSON.stringify(telemetry.requests)).not.toContain('secret prompt');
});

it('a cancelled stream records usage as all null', async () => {
  const controller = new AbortController();
  const telemetry = createFetchTelemetry({
    baseFetch: async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(
                chunk({ content: 'x' }, null, {
                  usage: { prompt_tokens: 5, completion_tokens: 1 },
                }),
              )}\n\n`,
            ),
          );
          controller.signal.addEventListener('abort', () =>
            c.error(new Error('aborted')),
          );
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const response = await telemetry.fetch(URL_CHAT, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => undefined);
  await telemetry.settled();
  expect(telemetry.requests[0]).toMatchObject({
    finishReason: 'cancelled',
    error: { class: 'cancelled' },
    usage: {
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    },
  });
});

it('a network failure is recorded and rethrown; other URLs pass through unobserved', async () => {
  const failing = createFetchTelemetry({
    baseFetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await expect(failing.fetch(URL_CHAT, {})).rejects.toThrow();
  expect(failing.requests[0]).toMatchObject({
    httpStatus: null,
    error: { class: 'network' },
  });
  const other = createFetchTelemetry({
    baseFetch: async () => new Response('ok'),
  });
  await other.fetch('https://crusoe.example/v1/models', {});
  expect(other.requests).toEqual([]);
});

it('non-streamed responses are observed from a clone', async () => {
  const telemetry = createFetchTelemetry({
    baseFetch: async () =>
      new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ finish_reason: 'stop', message: { content: 'x' } }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            prompt_tokens_details: { cached_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  const response = await telemetry.fetch(URL_CHAT, {});
  expect(((await response.json()) as { model: string }).model).toBe('m');
  await telemetry.settled();
  expect(telemetry.requests[0]).toMatchObject({
    streamed: false,
    modelReturned: 'm',
    finishReason: 'stop',
    usage: { cachedTokens: 2, reasoningTokens: 0 },
  });
});
