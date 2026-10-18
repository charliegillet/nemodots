import { afterEach, describe, expect, it } from 'vitest';
import { toolSchemas } from '../../../src/server/nemodots/contracts/index.js';
import { CrusoeInferenceClient } from '../../../src/server/nemodots/inference/client.js';
import { InferenceError } from '../../../src/server/nemodots/inference/types.js';
import {
  API_KEY,
  DONE,
  MODEL,
  chunk,
  client,
  ctx,
  json,
  request,
  sse,
  startStub,
  textStream,
  usageChunk,
  type Stub,
} from './stub.js';

let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('request shaping (stub-verified)', () => {
  it('sends exactly the documented body keys, headers and URL', async () => {
    stub = await startStub((_req, res) => textStream(res, ['po', 'ng']));
    const { client: c } = client(stub);
    const call = ctx();
    const result = await c.complete(
      request({
        tools: toolSchemas().slice(0, 2),
        maxTokens: 64,
        responseFormat: null,
      }),
      call,
    );
    expect(result.outcome).toBe('completed');
    const seen = stub.seen[0];
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/v1/chat/completions');
    expect(Object.keys(seen.body!)).toEqual([
      'model',
      'messages',
      'stream',
      'stream_options',
      'tools',
      'tool_choice',
      'reasoning_effort',
      'max_tokens',
    ]);
    expect(seen.body).toMatchObject({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      reasoning_effort: 'none',
      max_tokens: 64,
    });
    expect(seen.headers['x-request-id']).toBe(call.modelCallId);
    expect(seen.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const tools = seen.body!.tools as {
      type: string;
      function: { name: string };
    }[];
    expect(tools.map((t) => t.function.name)).toEqual([
      'observe_source',
      'list_runbooks',
    ]);
    expect(tools.every((t) => t.type === 'function')).toBe(true);
  });

  it('omits tools, tool_choice, max_tokens and response_format when unset; sends strict json_schema when set', async () => {
    stub = await startStub((_req, res) => textStream(res, ['{}']));
    const { client: c } = client(stub);
    await c.complete(request(), ctx());
    expect(Object.keys(stub.seen[0].body!)).toEqual([
      'model',
      'messages',
      'stream',
      'stream_options',
      'reasoning_effort',
    ]);
    await c.complete(
      request({ responseFormat: { name: 'out', schema: { type: 'object' } } }),
      ctx(),
    );
    expect(stub.seen[1].body!.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', strict: true, schema: { type: 'object' } },
    });
  });

  it('non-streaming requests carry no stream_options', async () => {
    stub = await startStub((_req, res) =>
      json(res, 200, {
        model: MODEL,
        choices: [
          {
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
    );
    const { client: c } = client(stub);
    const result = await c.complete(request({ stream: false }), ctx());
    expect(stub.seen[0].body).not.toHaveProperty('stream_options');
    expect(stub.seen[0].body!.stream).toBe(false);
    expect(result).toMatchObject({
      content: 'pong',
      outcome: 'completed',
      finishReason: 'stop',
    });
    expect(result.attempts[0].streamed).toBe(false);
  });

  it('reasoning is off by default and opt-in needs max_tokens >= 1024', async () => {
    stub = await startStub((_req, res) => textStream(res, ['ok']));
    const { client: c } = client(stub);
    await expect(
      c.complete(request({ reasoningEffort: 'medium', maxTokens: 512 }), ctx()),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
    expect(stub.seen).toHaveLength(0);
    await c.complete(
      request({ reasoningEffort: 'medium', maxTokens: 1024 }),
      ctx(),
    );
    expect(stub.seen[0].body).toMatchObject({
      reasoning_effort: 'medium',
      max_tokens: 1024,
    });
  });

  it('rejects malformed conversations before any network call', async () => {
    stub = await startStub((_req, res) => textStream(res, ['x']));
    const { client: c } = client(stub);
    const bad = [
      request({ messages: [{ role: 'user', content: 'no system' }] }),
      request({
        messages: [
          { role: 'system', content: 'a' },
          { role: 'system', content: 'b' },
        ],
      }),
      request({
        messages: [
          { role: 'system', content: 'a' },
          { role: 'tool', toolCallId: 'chatcmpl-tool-unknown', content: '{}' },
        ],
      }),
    ];
    for (const req of bad)
      await expect(c.complete(req, ctx())).rejects.toBeInstanceOf(
        InferenceError,
      );
    expect(stub.seen).toHaveLength(0);
  });

  it('shapes a tool-result continuation: assistant tool_calls before the tool message', async () => {
    stub = await startStub((_req, res) => textStream(res, ['done']));
    const { client: c } = client(stub);
    await c.complete(
      request({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'order?' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                toolCallId: 'chatcmpl-tool-aaa',
                name: 'observe_source',
                arguments: '{"sourceKey":"checkout.health"}',
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'chatcmpl-tool-aaa',
            content: '{"ok":true}',
          },
        ],
        tools: toolSchemas().slice(0, 1),
      }),
      ctx(),
    );
    expect(stub.seen[0].body!.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'order?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'chatcmpl-tool-aaa',
            type: 'function',
            function: {
              name: 'observe_source',
              arguments: '{"sourceKey":"checkout.health"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'chatcmpl-tool-aaa',
        content: '{"ok":true}',
      },
    ]);
  });
});

describe('streaming and telemetry (stub-verified)', () => {
  it('parses SSE split across arbitrary chunk boundaries, including inside a multi-byte character', async () => {
    const payload = [
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning: 'thinking ' }),
      chunk({ content: 'héllo ' }),
      chunk({ content: 'wörld ✓' }),
      chunk({}, 'stop'),
      usageChunk({
        prompt_tokens: 11,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
      DONE,
    ].join('');
    const bytes = Buffer.from(payload, 'utf8');
    stub = await startStub(async (_req, res) => {
      sse(res);
      for (let i = 0; i < bytes.length; i += 7) {
        res.write(bytes.subarray(i, i + 7));
        await new Promise((r) => setTimeout(r, 0));
      }
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(result).toMatchObject({
      content: 'héllo wörld ✓',
      reasoning: 'thinking ',
      finishReason: 'stop',
      outcome: 'completed',
      modelReturned: MODEL,
      usage: {
        promptTokens: 11,
        completionTokens: 5,
        cachedTokens: 0,
        reasoningTokens: 2,
      },
    });
    const attempt = result.attempts[0];
    expect(attempt.streamed).toBe(true);
    expect(attempt.httpStatus).toBe(200);
    expect(attempt.headersAt).not.toBeNull();
    expect(attempt.firstContentAt).not.toBeNull();
    expect(attempt.finishedAt).not.toBeNull();
  });

  it('firstContentAt ignores reasoning-only deltas', async () => {
    stub = await startStub(async (_req, res) => {
      sse(res);
      res.write(chunk({ reasoning: 'hmm' }));
      await new Promise((r) => setTimeout(r, 60));
      res.write(chunk({ content: 'x' }));
      res.write(chunk({}, 'stop'));
      res.write(DONE);
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    const a = result.attempts[0];
    expect(
      Date.parse(a.firstContentAt!) - Date.parse(a.headersAt!),
    ).toBeGreaterThanOrEqual(40);
  });

  it('accumulates streamed tool calls and preserves the provider tool call ids', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(
        chunk({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'chatcmpl-tool-9f1',
              type: 'function',
              function: { name: 'observe_source', arguments: '' },
            },
          ],
        }),
      );
      res.write(
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '{"sourceKey":' } }],
        }),
      );
      res.write(
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'chatcmpl-tool-2c7',
              type: 'function',
              function: { name: 'list_runbooks', arguments: '{}' },
            },
          ],
        }),
      );
      res.write(
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: '"checkout.health"}' } },
          ],
        }),
      );
      res.write(chunk({}, 'tool_calls'));
      res.write(
        usageChunk({
          prompt_tokens: 337,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 256 },
        }),
      );
      res.write(DONE);
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request({ tools: toolSchemas() }), ctx());
    expect(result.outcome).toBe('tool_calls');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      {
        toolCallId: 'chatcmpl-tool-9f1',
        name: 'observe_source',
        arguments: '{"sourceKey":"checkout.health"}',
      },
      {
        toolCallId: 'chatcmpl-tool-2c7',
        name: 'list_runbooks',
        arguments: '{}',
      },
    ]);
    expect(result.usage.cachedTokens).toBe(256);
  });

  it('parses a non-streamed tool call with message.reasoning', async () => {
    stub = await startStub((_req, res) =>
      json(res, 200, {
        model: MODEL,
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              reasoning: 'need the order',
              tool_calls: [
                {
                  id: 'chatcmpl-tool-abc',
                  type: 'function',
                  function: {
                    name: 'observe_source',
                    arguments: '{"sourceKey":"checkout.metrics"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
    const { client: c } = client(stub);
    const result = await c.complete(
      request({ stream: false, tools: toolSchemas() }),
      ctx(),
    );
    expect(result).toMatchObject({
      outcome: 'tool_calls',
      reasoning: 'need the order',
      toolCalls: [{ toolCallId: 'chatcmpl-tool-abc', name: 'observe_source' }],
    });
  });

  it('cachedTokens: null when prompt_tokens_details is absent or null, 0 when 0, the number when reported', async () => {
    const variants: [Record<string, unknown>, number | null][] = [
      [{ prompt_tokens: 1, completion_tokens: 1 }, null],
      [
        { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: null },
        null,
      ],
      [
        { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: {} },
        null,
      ],
      [
        {
          prompt_tokens: 1,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        0,
      ],
      [
        {
          prompt_tokens: 5336,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4608 },
        },
        4608,
      ],
    ];
    let i = 0;
    stub = await startStub((_req, res) =>
      textStream(res, ['a'], variants[i++][0]),
    );
    const { client: c } = client(stub);
    for (const [, expected] of variants) {
      const result = await c.complete(request(), ctx());
      expect(result.usage.cachedTokens).toBe(expected);
      expect(result.attempts[0].usage.cachedTokens).toBe(expected);
    }
  });

  it('records usage as all-null when the provider sends none', async () => {
    stub = await startStub((_req, res) => textStream(res, ['a'], null));
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
  });

  it('empty content with finish length stays a visible length finish (reasoning ate the budget)', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(chunk({ reasoning: 'a long thought' }));
      res.write(chunk({}, 'length'));
      res.write(usageChunk({ prompt_tokens: 3, completion_tokens: 40 }));
      res.write(DONE);
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request({ maxTokens: 40 }), ctx());
    expect(result).toMatchObject({
      content: null,
      reasoning: 'a long thought',
      finishReason: 'length',
    });
  });

  it('a stream that closes before any finish reason is a retryable network failure', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(chunk({ content: 'half' }));
      res.end();
    });
    const { client: c } = client(stub, { retry: { maxRetries: 1 } });
    const result = await c.complete(request(), ctx());
    expect(result.outcome).toBe('failed');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].error).toMatchObject({
      class: 'network',
      code: 'stream_truncated',
    });
  });

  it('an in-band stream error object is classified, not treated as content', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(
        `data: ${JSON.stringify({ error: { message: 'busy', code: 'rate_limit_exceeded' } })}\n\n`,
      );
      res.end();
    });
    const { client: c } = client(stub, { retry: { maxRetries: 0 } });
    const result = await c.complete(request(), ctx());
    expect(result.attempts[0].error).toMatchObject({
      class: 'rate_limited',
      code: 'rate_limit_exceeded',
    });
  });
});

describe('stream observer (stub-verified)', () => {
  it('reports each content/reasoning delta and survives a throwing observer', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(chunk({ reasoning: 'r' }));
      res.write(chunk({ content: 'a' }));
      res.write(chunk({ content: '' }));
      res.write(chunk({ content: 'b' }));
      res.write(chunk({}, 'stop'));
      res.write(DONE);
      res.end();
    });
    const { client: c } = client(stub);
    const seen: unknown[] = [];
    const result = await c.complete(request(), {
      ...ctx(),
      onDelta: (d) => {
        seen.push(d);
        throw new Error('observer bug');
      },
    });
    expect(result.content).toBe('ab');
    expect(seen).toEqual([
      { content: null, reasoning: 'r' },
      { content: 'a', reasoning: null },
      { content: 'b', reasoning: null },
    ]);
  });

  it('a stream truncated mid-way then retried leaves observer output equal to result.content', async () => {
    stub = await startStub((_req, res, _s, i) => {
      if (i === 0) {
        sse(res);
        res.write(chunk({ content: 'Hel' }));
        res.write(chunk({ reasoning: 'think' }));
        res.end(); // truncated: no finish reason
        return;
      }
      textStream(res, ['Hel', 'lo']);
    });
    const { client: c } = client(stub, { retry: { maxRetries: 1 } });
    let text = '';
    let thought = '';
    const attempts: number[] = [];
    const resets: number[] = [];
    const result = await c.complete(request(), {
      ...ctx(),
      onDelta: (d, attempt) => {
        text += d.content ?? '';
        thought += d.reasoning ?? '';
        attempts.push(attempt);
      },
      onAttemptReset: (next) => {
        resets.push(next);
        text = '';
        thought = '';
      },
    });
    expect(result.outcome).toBe('completed');
    expect(result.attempts).toHaveLength(2);
    expect(resets).toEqual([2]);
    expect(attempts).toEqual([1, 1, 2, 2]);
    expect(text).toBe(result.content);
    expect(thought).toBe('');
  });

  it('no reset is signalled when the failed attempt delivered nothing', async () => {
    stub = await startStub((_req, res, _s, i) => {
      if (i === 0) return json(res, 503, { error: { message: 'x' } });
      textStream(res, ['ok']);
    });
    const { client: c } = client(stub, { retry: { maxRetries: 1 } });
    const resets: number[] = [];
    await c.complete(request(), {
      ...ctx(),
      onDelta: () => undefined,
      onAttemptReset: (n) => resets.push(n),
    });
    expect(resets).toEqual([]);
  });
});

describe('structured output (stub-verified)', () => {
  const schema = {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['low', 'high'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['severity', 'confidence'],
    additionalProperties: false,
  };
  it.each([
    ['valid', '{"severity":"high","confidence":0.9}', 'completed'],
    [
      'enum violation',
      '{"severity":"urgent","confidence":0.9}',
      'invalid_output',
    ],
    [
      'extra key',
      '{"severity":"low","confidence":0.9,"x":1}',
      'invalid_output',
    ],
    ['not JSON', 'sure, here it is', 'invalid_output'],
    ['empty', '', 'invalid_output'],
  ])('%s -> %s', async (_name, content, outcome) => {
    stub = await startStub((_req, res) => textStream(res, [content]));
    const { client: c } = client(stub);
    const result = await c.complete(
      request({ responseFormat: { name: 'triage', schema } }),
      ctx(),
    );
    expect(result.outcome).toBe(outcome);
    expect(result.content).toBe(content === '' ? null : content);
  });
});

describe('cancellation (stub-verified)', () => {
  it('cancel mid-stream -> finishReason cancelled, outcome aborted, every usage field null', async () => {
    stub = await startStub(async (_req, res) => {
      sse(res);
      for (let i = 0; i < 100 && !res.destroyed; i++) {
        res.write(chunk({ content: `w${i} ` }));
        await new Promise((r) => setTimeout(r, 10));
      }
      res.end();
    });
    const { client: c } = client(stub);
    const controller = new AbortController();
    const pending = c.complete(request(), ctx(controller.signal));
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    const result = await pending;
    expect(result.finishReason).toBe('cancelled');
    expect(result.outcome).toBe('aborted');
    expect(result.usage).toEqual({
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      finishReason: 'cancelled',
      error: { class: 'cancelled' },
    });
    expect(
      Object.values(result.attempts[0].usage).every((v) => v === null),
    ).toBe(true);
    expect(result.content).toContain('w0');
  });

  it('an already-aborted signal makes no request', async () => {
    stub = await startStub((_req, res) => textStream(res, ['x']));
    const { client: c } = client(stub);
    const controller = new AbortController();
    controller.abort();
    const result = await c.complete(request(), ctx(controller.signal));
    expect(result.outcome).toBe('aborted');
    expect(stub.seen).toHaveLength(0);
  });

  it('cancel while waiting in backoff stops retrying', async () => {
    stub = await startStub((_req, res) =>
      json(res, 429, {
        code: 'max_requests_limit',
        message: 'x',
        error_id: 'e1',
      }),
    );
    const controller = new AbortController();
    const { client: c } = client(stub, {
      sleep: (_ms, signal) =>
        new Promise((_, reject) => {
          queueMicrotask(() => controller.abort());
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const result = await c.complete(request(), ctx(controller.signal));
    expect(result.outcome).toBe('aborted');
    expect(stub.seen).toHaveLength(1);
  });
});

describe('errors, retries and backoff (stub-verified)', () => {
  it('429 then 200 -> exactly one retry with a backoff of at least 1s', async () => {
    stub = await startStub((_req, res, _seen, i) =>
      i === 0
        ? json(res, 429, {
            code: 'max_requests_limit',
            message: 'orchestrator',
            error_id: 'err-1',
          })
        : textStream(res, ['ok']),
    );
    const { client: c, sleeps } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(result.outcome).toBe('completed');
    expect(stub.seen).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(30_000);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      n: 1,
      httpStatus: 429,
      error: {
        class: 'rate_limited',
        code: 'max_requests_limit',
        errorId: 'err-1',
      },
    });
    expect(result.attempts[1]).toMatchObject({
      n: 2,
      httpStatus: 200,
      error: null,
    });
    expect(
      Object.values(result.attempts[0].usage).every((v) => v === null),
    ).toBe(true);
  });

  it('honours retry-after (seconds) when it exceeds the computed backoff, up to the cap', async () => {
    stub = await startStub((_req, res, _seen, i) =>
      i === 0
        ? json(res, 429, { code: 'rate_limited' }, { 'retry-after': '7' })
        : textStream(res, ['ok']),
    );
    const { client: c, sleeps } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(sleeps).toEqual([7000]);
    expect(result.attempts[0].retryAfterMs).toBe(7000);
  });

  it('503 x5 -> failed with provider_unavailable after 4 retries (5 attempts) and exponential backoff', async () => {
    stub = await startStub((_req, res) =>
      json(res, 503, {
        code: 'service_unavailable',
        message: 'down',
        error_id: 'e',
      }),
    );
    const { client: c, sleeps } = client(stub, { random: () => 0 });
    const result = await c.complete(request(), ctx());
    expect(result.outcome).toBe('failed');
    expect(result.finishReason).toBe('error');
    expect(stub.seen).toHaveLength(5);
    expect(result.attempts).toHaveLength(5);
    expect(
      result.attempts.every((a) => a.error?.class === 'provider_unavailable'),
    ).toBe(true);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(result.usage.promptTokens).toBeNull();
  });

  it('backoff is capped at 30s', async () => {
    stub = await startStub((_req, res) => json(res, 503, {}));
    const { client: c, sleeps } = client(stub, {
      random: () => 1,
      retry: { baseMs: 20_000, maxRetries: 3 },
    });
    await c.complete(request(), ctx());
    expect(sleeps).toEqual([25_000, 30_000, 30_000]);
  });

  it('Crusoe 404 envelope -> provider_error / model_not_found, never retried', async () => {
    stub = await startStub((_req, res) =>
      json(res, 404, {
        code: 'model_not_found',
        message: 'Model not found: nvidia/does-not-exist',
        error_id: 'abc-123',
      }),
    );
    const { client: c, sleeps } = client(stub);
    const result = await c.complete(
      request({ model: 'nvidia/does-not-exist' }),
      ctx(),
    );
    expect(result.outcome).toBe('failed');
    expect(stub.seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result.attempts[0]).toMatchObject({
      httpStatus: 404,
      error: {
        class: 'provider_error',
        code: 'model_not_found',
        errorId: 'abc-123',
      },
    });
  });

  it('OpenAI {error:{}} envelope is parsed', async () => {
    stub = await startStub((_req, res) =>
      json(res, 401, {
        error: {
          message: 'bad key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    );
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(result.attempts[0].error).toMatchObject({
      class: 'provider_error',
      code: 'invalid_api_key',
      errorId: null,
    });
    expect(stub.seen).toHaveLength(1);
  });

  it('the error message body (which can echo request content) is never stored', async () => {
    stub = await startStub((_req, res) =>
      json(res, 400, {
        code: 'bad_request',
        message: 'secret-echo-ABC',
        error_id: 'i',
      }),
    );
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(JSON.stringify(result)).not.toContain('secret-echo-ABC');
  });

  it('a non-JSON error body still classifies by status', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    });
    const { client: c } = client(stub, { retry: { maxRetries: 0 } });
    const result = await c.complete(request(), ctx());
    expect(result.attempts[0].error).toEqual({
      class: 'provider_unavailable',
      code: null,
      errorId: null,
    });
  });

  it('a timed-out attempt is classified timeout and retried', async () => {
    stub = await startStub((_req, res, _s, i) => {
      if (i === 0) return; // never answer
      textStream(res, ['late ok']);
    });
    const { client: c, sleeps } = client(stub, { timeoutMs: 100 });
    const result = await c.complete(request(), ctx());
    expect(result.outcome).toBe('completed');
    expect(result.attempts[0].error).toMatchObject({ class: 'timeout' });
    expect(sleeps).toHaveLength(1);
  });

  it('the timeout also bounds silence in the middle of a stream', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(chunk({ content: 'x' }));
    });
    const { client: c } = client(stub, {
      timeoutMs: 100,
      retry: { maxRetries: 0 },
    });
    const result = await c.complete(request(), ctx());
    expect(result.attempts[0].error).toMatchObject({
      class: 'timeout',
      code: 'client_timeout',
    });
  });

  it('keepalive comments do not defeat the overall deadline (slots are freed)', async () => {
    stub = await startStub((_req, res, _s, i) => {
      if (i > 0) return textStream(res, ['ok']);
      sse(res);
      const drip = setInterval(() => res.write(': keepalive\n\n'), 20);
      res.on('close', () => clearInterval(drip));
    });
    const { client: c } = client(stub, {
      timeoutMs: 300,
      deadlineMs: 200,
      maxInFlight: 1,
      retry: { maxRetries: 0 },
    });
    const started = Date.now();
    const result = await c.complete(request(), ctx());
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.outcome).toBe('failed');
    expect(result.attempts[0].error).toMatchObject({
      class: 'timeout',
      code: 'client_deadline',
    });
    // the single slot is free again: a second call is not stuck behind it
    const next = await c.complete(request(), ctx());
    expect(next.outcome).toBe('completed');
  });

  it('a trickle of tokens is bounded by the overall deadline too', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      const drip = setInterval(() => res.write(chunk({ content: 'x' })), 20);
      res.on('close', () => clearInterval(drip));
    });
    const { client: c } = client(stub, {
      timeoutMs: 300,
      deadlineMs: 200,
      retry: { maxRetries: 0 },
    });
    const result = await c.complete(request(), ctx());
    expect(result.attempts[0].error).toMatchObject({ code: 'client_deadline' });
  });

  it('a dropped connection is a retryable network error', async () => {
    stub = await startStub((req, res, _s, i) => {
      if (i === 0) return void req.socket.destroy();
      textStream(res, ['back']);
    });
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(result.attempts[0].error?.class).toBe('network');
    expect(result.outcome).toBe('completed');
  });

  it('a malformed SSE payload is invalid_response and is not retried', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write('data: {not json}\n\n');
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request(), ctx());
    expect(result.outcome).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].error).toMatchObject({
      class: 'invalid_response',
    });
  });

  it('a tool call without an id is invalid_response (ids are preserved, never invented)', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(
        chunk({
          tool_calls: [
            { index: 0, function: { name: 'observe_source', arguments: '{}' } },
          ],
        }),
      );
      res.write(chunk({}, 'tool_calls'));
      res.write(DONE);
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request({ tools: toolSchemas() }), ctx());
    expect(result.outcome).toBe('failed');
    expect(result.attempts[0].error).toMatchObject({
      class: 'invalid_response',
      code: 'tool_call_incomplete',
    });
  });

  it('truncated tool-call arguments (finish length) are invalid_output', async () => {
    stub = await startStub((_req, res) => {
      sse(res);
      res.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'chatcmpl-tool-1',
              function: { name: 'observe_source', arguments: '{"sour' },
            },
          ],
        }),
      );
      res.write(chunk({}, 'length'));
      res.write(DONE);
      res.end();
    });
    const { client: c } = client(stub);
    const result = await c.complete(request({ tools: toolSchemas() }), ctx());
    expect(result.outcome).toBe('invalid_output');
  });
});

describe('throttle (stub-verified)', () => {
  it('holds at most 4 requests in flight per model by default', async () => {
    stub = await startStub(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 40));
      textStream(res, ['ok']);
    });
    const { client: c } = client(stub);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => c.complete(request(), ctx())),
    );
    expect(results.every((r) => r.outcome === 'completed')).toBe(true);
    expect(stub.maxConcurrent()).toBe(4);
    expect(c.load(MODEL)).toEqual({ inFlight: 0, queued: 0 });
  });

  it('honours a lower configured limit and counts models separately', async () => {
    stub = await startStub(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 40));
      textStream(res, ['ok']);
    });
    const { client: c } = client(stub, { maxInFlight: 2 });
    await Promise.all(
      Array.from({ length: 6 }, () => c.complete(request(), ctx())),
    );
    expect(stub.maxConcurrent()).toBe(2);
    await Promise.all([
      ...Array.from({ length: 2 }, () => c.complete(request(), ctx())),
      ...Array.from({ length: 2 }, () =>
        c.complete(request({ model: 'nvidia/other' }), ctx()),
      ),
    ]);
    expect(stub.maxConcurrent()).toBe(4);
  });

  it('a retry releases its slot while it backs off', async () => {
    let first = true;
    stub = await startStub((_req, res) => {
      if (first) {
        first = false;
        return json(res, 429, { code: 'max_requests_limit' });
      }
      textStream(res, ['ok']);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client: c } = client(stub, { maxInFlight: 1, sleep: () => gate });
    const a = c.complete(request(), ctx());
    await new Promise((r) => setTimeout(r, 50));
    // a is asleep in backoff holding no slot, so b can run to completion
    const b = await c.complete(request(), ctx());
    expect(b.outcome).toBe('completed');
    release();
    expect((await a).outcome).toBe('completed');
  });
});

describe('provider identity, no default host (I1)', () => {
  it('requests go to the configured base URL host only; host() reports it', async () => {
    stub = await startStub((_req, res) => textStream(res, ['ok']));
    const { client: c } = client(stub);
    expect(c.host()).toBe(stub.host);
    expect(c.host()).toBe(new URL(stub.baseUrl).host);
    const result = await c.complete(request(), ctx());
    expect(result.provider).toEqual({ host: stub.host, mode: 'live' });
    expect(stub.seen[0].headers.host).toBe(stub.host);
    expect(c.host()).not.toBe('api.openai.com');
  });

  it('refuses to construct without a base URL, a valid URL or a key (no default provider)', () => {
    expect(
      () => new CrusoeInferenceClient({ baseUrl: '', apiKey: API_KEY }),
    ).toThrow(/OPENAI_BASE_URL/);
    expect(
      () =>
        new CrusoeInferenceClient({ baseUrl: 'not a url', apiKey: API_KEY }),
    ).toThrow(/OPENAI_BASE_URL/);
    expect(
      () =>
        new CrusoeInferenceClient({ baseUrl: 'ftp://x/v1', apiKey: API_KEY }),
    ).toThrow(/http/);
    expect(
      () => new CrusoeInferenceClient({ baseUrl: 'http://x/v1', apiKey: '' }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(
      () =>
        new CrusoeInferenceClient({
          baseUrl: 'http://x/v1',
          apiKey: API_KEY,
          maxInFlight: 0,
        }),
    ).toThrow(RangeError);
  });

  it('does not follow redirects to another host', async () => {
    const other = await startStub((_req, res) => textStream(res, ['leaked']));
    stub = await startStub((_req, res) => {
      res.writeHead(307, { location: `${other.baseUrl}/chat/completions` });
      res.end();
    });
    const { client: c } = client(stub, { retry: { maxRetries: 0 } });
    const result = await c.complete(request(), ctx());
    expect(result.outcome).toBe('failed');
    expect(other.seen).toHaveLength(0);
    await other.close();
  });
});
