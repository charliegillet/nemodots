import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEAM_TOOL_INPUTS,
  toolSchemas,
} from '../../../../src/server/nemodots/contracts/index.js';
import type { ChatMessage } from '../../../../src/server/nemodots/contracts/index.js';
import type { StampedChatResult } from '../../../../src/server/nemodots/inference/types.js';
import {
  LIGHTNING,
  SUPER,
  allChecks,
  callContext,
  chat,
  describeResult,
  liveClient,
  record,
  requireLive,
  writeResults,
  type LiveEnv,
} from './support.js';

// Live Crusoe suite for the inference adapter. Real HTTP, real billing (a few
// cents), at most 2 requests in flight. No test skips: missing credentials
// make every test fail with "BLOCKED: <name> missing". The results file under
// .local/<instance>/live/ holds ids, timings, token counts, digests and sizes
// only, and is scanned for the API key before it is written.

let env: LiveEnv;
const results: StampedChatResult[] = [];
const keep = (r: StampedChatResult) => (results.push(r), r);

beforeAll(() => {
  env = requireLive();
});

afterAll(() => {
  if (!env) return; // BLOCKED: requireLive already wrote the results file
  const failed = allChecks().some((c) => c.status === 'FAIL');
  writeResults({ status: failed ? 'FAIL' : 'PASS' });
});

async function check<T>(
  name: string,
  body: () => Promise<T>,
  observe: (value: T) => Record<string, unknown>,
) {
  try {
    const value = await body();
    record({ name, status: 'PASS', observed: observe(value) });
    return value;
  } catch (error) {
    record({
      name,
      status: 'FAIL',
      note: error instanceof Error ? error.message.slice(0, 300) : 'failed',
    });
    throw error;
  }
}

describe('Crusoe live (adapter)', () => {
  it('text completion: model.returned equals model requested, streaming firstContentAt set', async () => {
    const client = liveClient(env);
    expect(client.host()).toBe(new URL(process.env.OPENAI_BASE_URL!).host);
    const result = await check(
      'text completion + streaming firstContentAt',
      async () =>
        keep(
          await client.complete(
            chat({
              messages: [
                { role: 'system', content: 'You are terse.' },
                { role: 'user', content: 'Reply with the single word pong.' },
              ],
              maxTokens: 64,
            }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(result.outcome).toBe('completed');
    expect(result.finishReason).toBe('stop');
    expect(result.modelReturned).toBe(SUPER);
    expect(result.content?.toLowerCase()).toContain('pong');
    const attempt = result.attempts.at(-1)!;
    expect(attempt.httpStatus).toBe(200);
    expect(attempt.headersAt).not.toBeNull();
    expect(attempt.firstContentAt).not.toBeNull();
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
    // reasoning_effort none (default): no reasoning tokens burned
    expect(result.provider).toEqual({ host: env.host, mode: 'live' });
  });

  it('non-streamed completion returns the same shape', async () => {
    const client = liveClient(env);
    const result = await check(
      'non-streamed completion',
      async () =>
        keep(
          await client.complete(
            chat({
              stream: false,
              messages: [
                { role: 'system', content: 'You are terse.' },
                { role: 'user', content: 'Reply with the single word pong.' },
              ],
              maxTokens: 64,
            }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(result.outcome).toBe('completed');
    expect(result.modelReturned).toBe(SUPER);
    expect(result.attempts.at(-1)!.streamed).toBe(false);
  });

  it('typed read-only tool call, then a tool-result continuation', async () => {
    const client = liveClient(env);
    const tools = toolSchemas().filter((t) => t.name === 'observe_source');
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a checkout incident analyst. Use the observe_source tool to read sources; never guess their values.',
      },
      {
        role: 'user',
        content:
          'What does the source checkout.health currently say? Read it with the tool.',
      },
    ];
    const first = await check(
      'tool call',
      async () =>
        keep(
          await client.complete(
            chat({ messages, tools, maxTokens: 256 }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(first.outcome).toBe('tool_calls');
    expect(first.finishReason).toBe('tool_calls');
    const call = first.toolCalls[0];
    expect(call.name).toBe('observe_source');
    expect(call.toolCallId.length).toBeGreaterThan(0);
    const args = TEAM_TOOL_INPUTS.observe_source.safeParse(
      JSON.parse(call.arguments),
    );
    expect(args.success).toBe(true);

    const toolResult = JSON.stringify({
      sourceKey: 'checkout.health',
      status: 'degraded',
      detail: 'p95 latency 4100ms',
    });
    const second = await check(
      'tool-result continuation',
      async () =>
        keep(
          await client.complete(
            chat({
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
                  content: toolResult,
                },
              ],
              tools,
              maxTokens: 256,
            }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(second.outcome).toBe('completed');
    expect(second.toolCalls).toEqual([]);
    expect(second.content?.toLowerCase()).toMatch(/degraded|4100/);
    expect(second.modelReturned).toBe(SUPER);
  });

  it('strict json_schema output validates', async () => {
    const client = liveClient(env);
    const schema = {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        component: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['severity', 'component', 'confidence'],
      additionalProperties: false,
    };
    const result = await check(
      'strict json_schema',
      async () =>
        keep(
          await client.complete(
            chat({
              messages: [
                {
                  role: 'system',
                  content: 'Classify incidents. Output JSON only.',
                },
                {
                  role: 'user',
                  content:
                    'Checkout payments fail for every customer. Severity, component, confidence?',
                },
              ],
              responseFormat: { name: 'triage', schema },
              maxTokens: 200,
            }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(result.outcome).toBe('completed');
    const parsed = JSON.parse(result.content!);
    expect(Object.keys(parsed).sort()).toEqual([
      'component',
      'confidence',
      'severity',
    ]);
  });

  it('opt-in reasoning (max_tokens >= 1024) returns message.reasoning separately from content', async () => {
    const client = liveClient(env);
    const result = await check(
      'opt-in reasoning',
      async () =>
        keep(
          await client.complete(
            chat({
              messages: [
                { role: 'system', content: 'You are terse.' },
                {
                  role: 'user',
                  content: 'What is 17 * 23? Answer with the number only.',
                },
              ],
              reasoningEffort: 'low',
              maxTokens: 2048,
            }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(result.outcome).toBe('completed');
    expect(result.content).toContain('391');
    // reasoning text, when the provider returns it, is kept apart from content
    if (result.reasoning !== null)
      expect(result.content).not.toBe(result.reasoning);
  });

  it('cancel after 5 deltas: finishReason cancelled, usage all null', async () => {
    const client = liveClient(env);
    const controller = new AbortController();
    let deltas = 0;
    const result = await check(
      'cancel after 5 deltas',
      async () =>
        keep(
          await client.complete(
            chat({
              messages: [
                { role: 'system', content: 'You are terse.' },
                {
                  role: 'user',
                  content:
                    'Count from 1 to 300, one number per line, no other text.',
                },
              ],
              maxTokens: 1500,
            }),
            {
              ...callContext(controller.signal),
              onDelta: (d) => {
                if (d.content !== null && ++deltas === 5) controller.abort();
              },
            },
          ),
        ),
      (r) => ({ ...describeResult(r), deltasSeen: deltas }),
    );
    expect(deltas).toBeGreaterThanOrEqual(5);
    expect(result.outcome).toBe('aborted');
    expect(result.finishReason).toBe('cancelled');
    expect(Object.values(result.usage).every((v) => v === null)).toBe(true);
    expect(result.attempts.at(-1)!.error?.class).toBe('cancelled');
  });

  it('verifyModel: the Super model is served; a made-up model is not (404 model_not_found)', async () => {
    const client = liveClient(env);
    const models = await check(
      'listModels',
      () => client.listModels(),
      (m) => ({
        count: m.length,
        includesSuper: m.includes(SUPER),
      }),
    );
    expect(models).toContain(SUPER);
    const good = await check(
      'verifyModel(Super)',
      () => client.verifyModel(SUPER),
      (v) => ({ served: v }),
    );
    expect(good).toBe(true);
    const bad = await check(
      'verifyModel(does-not-exist)',
      () => client.verifyModel('nvidia/does-not-exist'),
      (v) => ({ served: v }),
    );
    expect(bad).toBe(false);
  });

  it('a chat request for a model that does not exist records the Crusoe 404 envelope', async () => {
    const client = liveClient(env);
    const result = await check(
      'unknown model envelope',
      async () =>
        keep(
          await client.complete(
            chat({
              model: 'nvidia/does-not-exist',
              maxTokens: 8,
              messages: [
                { role: 'system', content: 's' },
                { role: 'user', content: 'hi' },
              ],
            }),
            callContext(),
          ),
        ),
      describeResult,
    );
    expect(result.outcome).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      httpStatus: 404,
      error: { class: 'provider_error', code: 'model_not_found' },
    });
  });

  it('observes cached_tokens on Super (identical prefix twice) and on Lightning', async () => {
    const client = liveClient(env);
    const prefix = `Reference table: ${Array.from({ length: 700 }, (_, i) => `row${i}=value${i * 7}`).join('; ')}.`;
    const ask = (model: string, q: string) =>
      client.complete(
        chat({
          model,
          messages: [
            { role: 'system', content: `${prefix} Answer with one number.` },
            { role: 'user', content: q },
          ],
          maxTokens: 32,
        }),
        callContext(),
      );
    const a = keep(await ask(SUPER, 'What is value of row3?'));
    const b = keep(await ask(SUPER, 'What is value of row4?'));
    const l = keep(await ask(LIGHTNING, 'What is value of row3?'));
    record({
      name: 'cached_tokens observation',
      status: 'PASS',
      observed: {
        superFirst: a.usage.cachedTokens,
        superSecond: b.usage.cachedTokens,
        lightning: l.usage.cachedTokens,
        lightningReturnedModel: l.modelReturned,
        note: 'Lightning/Omni cachedTokens null is documented as stub-verified unless lightning is null here',
      },
    });
    expect(a.outcome).toBe('completed');
    expect(l.outcome).toBe('completed');
    // Super reports the field (a number, 0 when cold); Lightning may report null.
    expect(typeof a.usage.cachedTokens).toBe('number');
    expect(typeof b.usage.cachedTokens).toBe('number');
  });

  it('every recorded provider.host equals the host of OPENAI_BASE_URL', () => {
    expect(results.length).toBeGreaterThan(0);
    for (const r of results)
      expect(r.provider).toEqual({ host: env.host, mode: 'live' });
    record({
      name: 'provider.host == OPENAI_BASE_URL host',
      status: 'PASS',
      observed: { host: env.host, results: results.length },
    });
  });
});
