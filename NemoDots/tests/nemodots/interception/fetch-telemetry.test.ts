import { describe, expect, it } from 'vitest';
import {
  createFetchTelemetry,
  normalizeRawUsage,
  toInferenceAttempt,
} from '../../../src/server/nemodots/interception/index.js';
import { InferenceAttemptSchema } from '../../../src/server/nemodots/contracts/index.js';

const sse = (chunks: unknown[], headers: Record<string, string> = {}) =>
  new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream', ...headers } },
  );

const content = {
  id: 'x',
  model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
};
const stop = {
  id: 'x',
  model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
};
const usage = {
  id: 'x',
  model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  choices: [],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 64 },
    completion_tokens_details: { reasoning_tokens: 12 },
  },
};

describe('normalizeRawUsage', () => {
  it('keeps unavailable fields null instead of coercing them to zero', () => {
    expect(normalizeRawUsage(null)).toEqual({
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
    expect(
      normalizeRawUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: null,
      }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: null,
      reasoningTokens: null,
    });
    // A provider-reported zero is a zero.
    expect(
      normalizeRawUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
      }).cachedTokens,
    ).toBe(0);
  });
});

describe('FetchTelemetry', () => {
  it('captures status, returned model, raw usage and timings from a stream without touching the response', async () => {
    const telemetry = createFetchTelemetry({
      base: async () => sse([content, stop, usage], { 'x-request-id': 'req-1' }),
    });
    telemetry.beginCall();
    const response = await telemetry.fetch('https://example.invalid/v1/x', {
      method: 'POST',
      body: JSON.stringify({ secret: 'never recorded' }),
      headers: { Authorization: 'Bearer should-not-be-stored' },
    });
    // The consumer still gets the full, readable stream.
    const text = await response.text();
    expect(text).toContain('"content":"hi"');
    const [exchange] = await telemetry.takeCall();
    expect(exchange).toMatchObject({
      httpStatus: 200,
      streamed: true,
      modelReturned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      finishReason: 'stop',
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        cachedTokens: 64,
        reasoningTokens: 12,
      },
      error: null,
    });
    expect(exchange.headersAt).toBeTruthy();
    expect(exchange.firstContentAt).toBeTruthy();
    expect(exchange.finishedAt).toBeTruthy();
    expect(JSON.stringify(exchange)).not.toContain('should-not-be-stored');
    expect(JSON.stringify(exchange)).not.toContain('never recorded');
    expect(
      InferenceAttemptSchema.safeParse(toInferenceAttempt(exchange, 1)).success,
    ).toBe(true);
  });

  it('records usage as unavailable when the provider sends none', async () => {
    const telemetry = createFetchTelemetry({
      base: async () => sse([content, stop]),
    });
    telemetry.beginCall();
    await (await telemetry.fetch('https://example.invalid/')).text();
    const [exchange] = await telemetry.takeCall();
    expect(exchange.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
    expect(exchange.rawUsage).toBeNull();
  });

  it('parses a non-streamed JSON completion', async () => {
    const telemetry = createFetchTelemetry({
      base: async () =>
        new Response(
          JSON.stringify({
            model: 'm',
            choices: [{ message: { content: 'x' }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    });
    telemetry.beginCall();
    await telemetry.fetch('https://example.invalid/');
    const [exchange] = await telemetry.takeCall();
    expect(exchange).toMatchObject({
      streamed: false,
      modelReturned: 'm',
      finishReason: 'tool_calls',
      usage: { promptTokens: 5, completionTokens: 1, cachedTokens: null },
    });
  });

  it('classifies HTTP failures and reads retry-after', async () => {
    const telemetry = createFetchTelemetry({
      base: async () =>
        new Response(JSON.stringify({ error: { code: 'max_requests_limit' } }), {
          status: 429,
          headers: { 'retry-after': '2', 'x-request-id': 'req-9' },
        }),
    });
    telemetry.beginCall();
    await telemetry.fetch('https://example.invalid/');
    const [exchange] = await telemetry.takeCall();
    expect(exchange).toMatchObject({
      httpStatus: 429,
      retryAfterMs: 2000,
      error: {
        class: 'rate_limited',
        code: 'max_requests_limit',
        errorId: 'req-9',
      },
    });
    const attempt = toInferenceAttempt(exchange, 1);
    expect(attempt.finishReason).toBe('error');
    expect(InferenceAttemptSchema.safeParse(attempt).success).toBe(true);
  });

  it('records a cancelled request with null usage and rethrows', async () => {
    const telemetry = createFetchTelemetry({
      base: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    telemetry.beginCall();
    await expect(telemetry.fetch('https://example.invalid/')).rejects.toThrow(
      'aborted',
    );
    const [exchange] = await telemetry.takeCall();
    expect(exchange.error?.class).toBe('cancelled');
    const attempt = toInferenceAttempt(exchange, 1);
    expect(attempt.finishReason).toBe('cancelled');
    expect(Object.values(attempt.usage).every((v) => v === null)).toBe(true);
    expect(InferenceAttemptSchema.safeParse(attempt).success).toBe(true);
  });

  it('classifies a network failure and groups retried exchanges under one call', async () => {
    let n = 0;
    const telemetry = createFetchTelemetry({
      base: async () => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return sse([content, stop, usage]);
      },
    });
    telemetry.beginCall();
    await expect(telemetry.fetch('https://example.invalid/')).rejects.toThrow();
    await (await telemetry.fetch('https://example.invalid/')).text();
    telemetry.beginCall();
    await (await telemetry.fetch('https://example.invalid/')).text();
    const first = await telemetry.takeCall(1);
    expect(first.map((e) => e.error?.class ?? 'ok')).toEqual(['network', 'ok']);
    expect(await telemetry.takeCall(2)).toHaveLength(1);
    expect(telemetry.all()).toHaveLength(3);
  });

  it('delegates to globalThis.fetch at call time by default', async () => {
    const original = globalThis.fetch;
    let seen = false;
    globalThis.fetch = (async () => {
      seen = true;
      return sse([content, stop]);
    }) as typeof fetch;
    try {
      const telemetry = createFetchTelemetry();
      telemetry.beginCall();
      await (await telemetry.fetch('https://example.invalid/')).text();
      expect(seen).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
