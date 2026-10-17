// TEST_PROMPT gate 5 cases 1, 2 and 7 (live, through the app adapter):
//  G5.1 endpoint + requested model currently served, provider stamp
//  G5.2 real text, tool call + continuation, streaming, cancellation
//  G5.7 client timing measures first NONEMPTY content
// Every request goes through createInferenceFromEnv (the server's own
// factory). At most MAX_IN_FLIGHT (3) requests are ever in flight: tests in a
// file run sequentially and the adapter semaphore is set to 3.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEAM_TOOL_INPUTS,
  toolSchemaHash,
  toolSchemas,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  EXPECTED_HOST,
  PRIMARY_MODEL,
  assertNoSecret,
  chat,
  createAdapter,
  ctx,
  requireLive,
  startProxy,
  t,
  type Adapter,
  type LiveEnv,
  type Proxy,
} from './support.js';

let live: LiveEnv;
let adapter: Adapter;

beforeAll(async () => {
  live = requireLive();
  adapter = await createAdapter();
});

describe('G5.1 endpoint and model through the app adapter', () => {
  it('G5.1a adapter is live, bound to OPENAI_BASE_URL host (Crusoe), and the requested model is the primary Nemotron', () => {
    expect(adapter.mode).toBe('live');
    expect(adapter.host()).toBe(new URL(live.baseUrl).host);
    expect(adapter.host()).toBe(EXPECTED_HOST);
    expect(live.baseUrl).toBe('https://api.inference.crusoecloud.com/v1');
    expect(live.model).toBe(PRIMARY_MODEL);
  });

  it('G5.1b GET /v1/models lists the requested model; an unknown id is reported absent', async () => {
    const models = await adapter.listModels();
    expect(models).toContain(live.model);
    expect(await adapter.verifyModel(live.model)).toBe(true);
    expect(
      await adapter.verifyModel(
        `nvidia/acc5-no-such-model-${randomBytes(3).toString('hex')}`,
      ),
    ).toBe(false);
  });

  it('G5.1c a completed call is stamped live/Crusoe and returned model == requested model, with no secret in the record', async () => {
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('planner'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.provider).toEqual({ host: EXPECTED_HOST, mode: 'live' });
    expect(r.modelReturned).toBe(live.model);
    assertNoSecret(r, live.apiKey);
  });
});

describe('G5.2 text, tool call + continuation, streaming, cancellation', () => {
  it('G5.2a real text completion: content from the model, finish stop, one attempt, numeric token counts', async () => {
    const nonce = randomBytes(4).toString('hex');
    const r = await adapter.complete(
      chat(
        live.model,
        `Repeat this token exactly and nothing else: ZX-${nonce}`,
      ),
      ctx('worker'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.finishReason).toBe('stop');
    expect(r.content).toContain(`ZX-${nonce}`);
    expect(r.toolCalls).toEqual([]);
    expect(r.attempts).toHaveLength(1);
    const a = r.attempts[0];
    expect(a.httpStatus).toBe(200);
    expect(a.streamed).toBe(false);
    expect(a.error).toBeNull();
    expect(
      Number.isInteger(r.usage.promptTokens) && r.usage.promptTokens! > 0,
    ).toBe(true);
    expect(
      Number.isInteger(r.usage.completionTokens) &&
        r.usage.completionTokens! > 0,
    ).toBe(true);
  });

  it('G5.2b tool call then continuation: the model calls a typed team tool, and the final answer uses the tool result it could not have guessed', async () => {
    const tools = toolSchemas();
    const hash = toolSchemaHash();
    const secretRunbook = `rb-${randomBytes(4).toString('hex')}`;
    const messages: import('../../../../src/server/nemodots/contracts/index.js').ChatMessage[] =
      [
        {
          role: 'system',
          content:
            'You operate through tools. When asked to call a tool, call it and do not answer in text first.',
        },
        {
          role: 'user',
          content: 'Call the list_runbooks tool now with no arguments.',
        },
      ];
    const first = await adapter.complete(
      chat(live.model, '', {
        messages,
        tools,
        toolSchemaHash: hash,
        maxTokens: 256,
      }),
      ctx('worker'),
    );
    expect(first.outcome).toBe('tool_calls');
    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls.length).toBeGreaterThanOrEqual(1);
    const call = first.toolCalls[0];
    expect(call.name).toBe('list_runbooks');
    expect(call.toolCallId).toBeTruthy();
    expect(
      TEAM_TOOL_INPUTS.list_runbooks.safeParse(
        JSON.parse(call.arguments || '{}'),
      ).success,
    ).toBe(true);

    const second = await adapter.complete(
      chat(live.model, '', {
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: first.content,
            toolCalls: first.toolCalls,
          },
          {
            role: 'tool',
            toolCallId: call.toolCallId,
            content: JSON.stringify([
              { id: secretRunbook, title: 'Flush the checkout cache' },
            ]),
          },
          {
            role: 'user',
            content:
              'State the id of the single runbook the tool returned. Reply with the id only.',
          },
        ],
        tools,
        toolSchemaHash: hash,
        maxTokens: 256,
      }),
      ctx('worker'),
    );
    expect(second.outcome).toBe('completed');
    expect(second.finishReason).toBe('stop');
    expect(second.content).toContain(secretRunbook);
    expect(second.toolCalls).toEqual([]);
  });

  it('G5.2c streaming completes with content, usage and streamed=true on the attempt', async () => {
    const r = await adapter.complete(
      chat(
        live.model,
        'List the numbers 1 to 5 separated by commas, nothing else.',
        { stream: true },
      ),
      ctx('worker'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.finishReason).toBe('stop');
    expect(r.content).toMatch(/1\D+2\D+3\D+4\D+5/);
    expect(r.attempts[0].streamed).toBe(true);
    expect(r.attempts[0].httpStatus).toBe(200);
    expect(r.modelReturned).toBe(live.model);
    // stream_options.include_usage: usage must arrive on the stream
    expect(Number.isInteger(r.usage.promptTokens)).toBe(true);
    expect(Number.isInteger(r.usage.completionTokens)).toBe(true);
  });

  it('G5.2d cancellation mid-stream: outcome aborted, finish cancelled, attempt usage ALL null, no retry, no tool calls', async () => {
    // Cancellation can only be judged once a stream is open. Under shared-quota
    // 429s the cancel lands in a rate_limit backoff instead, which is provider
    // saturation, not an adapter result: repeat the scenario (still real inference).
    let r!: Awaited<ReturnType<typeof adapter.complete>>;
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      const pending = adapter.complete(
        chat(
          live.model,
          'Count from 1 to 600, one number per line, no other text.',
          {
            stream: true,
            maxTokens: 2000,
          },
        ),
        ctx('worker', controller.signal),
      );
      setTimeout(() => controller.abort(), 1500);
      r = await pending;
      if (r.attempts[0]?.error?.class !== 'rate_limited') break;
      await new Promise((res) => setTimeout(res, 8000 * (i + 1)));
    }
    expect(r.outcome).toBe('aborted');
    expect(r.finishReason).toBe('cancelled');
    expect(r.toolCalls).toEqual([]);
    expect(r.attempts).toHaveLength(1);
    const a = r.attempts[0];
    expect(a.error?.class).toBe('cancelled');
    expect(a.finishReason).toBe('cancelled');
    expect(Object.values(a.usage)).toEqual([null, null, null, null]);
    expect(Object.values(r.usage)).toEqual([null, null, null, null]);
  });

  it('G5.2e cancellation before send never reaches the network and leaks no slot', async () => {
    const proxy = await startProxy(live.baseUrl);
    try {
      const viaProxy = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
      const pre = new AbortController();
      pre.abort();
      const r0 = await viaProxy.complete(
        chat(live.model, 'hi'),
        ctx('worker', pre.signal),
      );
      expect(r0.outcome).toBe('aborted');
      expect(proxy.seen).toHaveLength(0);
      // adapter still serves a normal request afterwards (slot not leaked)
      const ok = await viaProxy.complete(
        chat(live.model, 'Reply with exactly: OK'),
        ctx('worker'),
      );
      expect(ok.outcome).toBe('completed');
      expect(proxy.seen).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it('G5.2f cancellation tears down the upstream request (client closes the connection promptly) and the adapter stays usable', async () => {
    const proxy = await startProxy(live.baseUrl);
    try {
      const viaProxy = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
      const controller = new AbortController();
      const pending = viaProxy.complete(
        chat(
          live.model,
          'Count from 1 to 600, one number per line, no other text.',
          {
            stream: true,
            maxTokens: 2000,
          },
        ),
        ctx('worker', controller.signal),
      );
      setTimeout(() => controller.abort(), 1500);
      const r = await pending;
      expect(r.outcome).toBe('aborted');
      await new Promise((res) => setTimeout(res, 500));
      expect(proxy.seen).toHaveLength(1);
      expect(proxy.seen[0].clientClosedEarly).toBe(true);
      expect(proxy.current()).toBe(0);
      const ok = await viaProxy.complete(
        chat(live.model, 'Reply with exactly: OK'),
        ctx('worker'),
      );
      expect(ok.outcome).toBe('completed');
    } finally {
      await proxy.close();
    }
  });
});

describe('G5.7 client timing is first NONEMPTY content, per call (not aggregate provider metrics)', () => {
  let proxy: Proxy;
  afterAll(async () => proxy?.close());

  it('G5.7a live stream: startedAt <= headersAt <= firstContentAt <= finishedAt, all client clocks', async () => {
    const r = await adapter.complete(
      chat(live.model, 'Write one short sentence about caches.', {
        stream: true,
        maxTokens: 200,
      }),
      ctx('worker'),
    );
    const a = r.attempts.at(-1)!; // shared-quota 429s can precede the served attempt
    expect(a.firstContentAt).not.toBeNull();
    expect(t(a.startedAt)).toBeLessThanOrEqual(t(a.headersAt));
    expect(t(a.headersAt)).toBeLessThanOrEqual(t(a.firstContentAt));
    expect(t(a.firstContentAt)).toBeLessThanOrEqual(t(a.finishedAt));
  });

  it('G5.7b empty-content deltas and reasoning tokens do NOT count: firstContentAt is not before the first real content byte', async () => {
    proxy = await startProxy(live.baseUrl, () => ({
      kind: 'forward',
      prelude: [
        JSON.stringify({
          id: 'p',
          object: 'chat.completion.chunk',
          model: live.model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({
          id: 'p',
          object: 'chat.completion.chunk',
          model: live.model,
          choices: [
            {
              index: 0,
              delta: { reasoning: 'thinking about it' },
              finish_reason: null,
            },
          ],
        }),
      ],
      preludeDelayMs: 1500,
    }));
    const viaProxy = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await viaProxy.complete(
      chat(live.model, 'Reply with exactly: DONE', { stream: true }),
      ctx('worker'),
    );
    expect(r.outcome).toBe('completed');
    const a = r.attempts.at(-1)!; // shared-quota 429s can precede the served attempt
    // The proxy wrote headers plus the empty/reasoning prelude at once, then held
    // 1.5 s before forwarding any upstream content. Measuring from the client's
    // headersAt (not startedAt) removes Crusoe's own time-to-first-byte from the
    // delta, so a slow upstream cannot mask an adapter that counts the empty delta.
    expect(t(a.firstContentAt) - t(a.headersAt)).toBeGreaterThanOrEqual(1400);
    // Direct check against the proxy's wall clock: firstContentAt must not be
    // earlier than the moment the first content-bearing delta was forwarded
    // (50 ms loopback/clock slack).
    const rec = proxy.seen
      .filter((x) => x.url.endsWith('/chat/completions'))
      .at(-1)!;
    expect(rec.firstContentForwardedAt).not.toBeNull();
    expect(t(a.firstContentAt)).toBeGreaterThanOrEqual(
      rec.firstContentForwardedAt! - 50,
    );
    // and the forwarded content really came after the prelude delay
    expect(
      rec.firstContentForwardedAt! - rec.headersWrittenAt!,
    ).toBeGreaterThanOrEqual(1400);
    expect(r.reasoning).toContain('thinking about it');
  });

  it('G5.7c a non-stream call has no first-content timestamp invented (null)', async () => {
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('worker'),
    );
    expect(r.attempts[0].streamed).toBe(false);
    expect(r.attempts[0].firstContentAt).toBeNull();
  });
});
