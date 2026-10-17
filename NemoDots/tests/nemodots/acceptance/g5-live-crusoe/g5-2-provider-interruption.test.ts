// TEST_PROMPT gate 5 case 5 ("Provider interruption -> retry or block; never
// vendor switch or prerecorded answer") and the limits of ACCEPTANCE_CONTRACT
// section 4.3: <= 4 in flight per model, retries only on rate_limited |
// provider_unavailable | timeout | network, at most 4 per call, 1 s base and
// 30 s cap, no automatic retry otherwise.
//
// Faults come from a verifier-owned pass-through proxy in front of the real
// Crusoe endpoint (the contract allows OPENAI_BASE_URL to point at it). A
// recovered call is real inference; an unrecovered one must yield no content.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  RETRYABLE,
  chat,
  completeThroughSaturation,
  createAdapter,
  ctx,
  loadModule,
  requireLive,
  startProxy,
  t,
  type LiveEnv,
  type Proxy,
} from './support.js';

let live: LiveEnv;
let proxy: Proxy | undefined;
beforeAll(() => {
  live = requireLive();
});
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});

const body503 = JSON.stringify({
  code: 'service_unavailable',
  message: 'upstream down',
  error_id: 'acc5',
});
const body429 = JSON.stringify({
  code: 'max_requests_limit',
  message: 'slow down',
  error_id: 'acc5',
});

function gaps(attempts: { startedAt: string; finishedAt: string | null }[]) {
  return attempts
    .slice(1)
    .map((a, i) => t(a.startedAt) - t(attempts[i].finishedAt));
}

describe('G5.4 provider interruption: retry or block, never switch vendors, never invent an answer', () => {
  it('G5.4a two 503s then recovery: 3 attempts to the SAME provider, the recovered call is real inference, backoff within [1 s, 30 s]', async () => {
    proxy = await startProxy(live.baseUrl, (req) =>
      req.n <= 2
        ? { kind: 'respond', status: 503, body: body503 }
        : { kind: 'forward' },
    );
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: RECOVERED'),
      ctx('planner'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.content).toContain('RECOVERED');
    expect(r.attempts).toHaveLength(3);
    expect(r.attempts.map((a) => a.httpStatus)).toEqual([503, 503, 200]);
    expect(r.attempts.slice(0, 2).map((a) => a.error?.class)).toEqual([
      'provider_unavailable',
      'provider_unavailable',
    ]);
    expect(r.attempts[2].error).toBeNull();
    // never a different host: every attempt hit the one configured base URL
    expect(proxy.seen).toHaveLength(3);
    expect(r.provider).toEqual({ host: proxy.host, mode: 'live' });
    expect(r.modelReturned).toBe(live.model);
    for (const g of gaps(r.attempts)) {
      expect(g).toBeGreaterThanOrEqual(900); // base 1 s (timer slack)
      expect(g).toBeLessThanOrEqual(30_500); // cap 30 s
    }
    // failed attempts carry null usage, only the success carries counts
    expect(Object.values(r.attempts[0].usage)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(r.attempts[2].usage.promptTokens).not.toBeNull();
  }, 120_000);

  it('G5.4b 429 rate limiting is retried and classified rate_limited', async () => {
    proxy = await startProxy(live.baseUrl, (req) =>
      req.n === 1
        ? { kind: 'respond', status: 429, body: body429 }
        : { kind: 'forward' },
    );
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('worker'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.attempts.map((a) => a.httpStatus)).toEqual([429, 200]);
    expect(r.attempts[0].error?.class).toBe('rate_limited');
  }, 120_000);

  it('G5.4c a dropped connection (socket destroyed) is retried as network', async () => {
    proxy = await startProxy(live.baseUrl, (req) =>
      req.n === 1 ? { kind: 'destroy' } : { kind: 'forward' },
    );
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('worker'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.attempts[0].error?.class).toBe('network');
    expect(r.attempts[0].httpStatus).toBeNull();
    expect(r.attempts).toHaveLength(2);
  }, 120_000);

  it('G5.4d a stream cut mid-way is retried and the partial text is NOT concatenated into the final answer', async () => {
    proxy = await startProxy(live.baseUrl, (req) =>
      req.n === 1
        ? { kind: 'forward', destroyAfterEvents: 3 }
        : { kind: 'forward' },
    );
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await adapter.complete(
      chat(
        live.model,
        'Reply with exactly this and nothing else: ALPHA-BRAVO-CHARLIE',
        { stream: true },
      ),
      ctx('worker'),
    );
    expect(r.outcome).toBe('completed');
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].error?.class).toBe('network');
    expect(r.content?.trim()).toBe('ALPHA-BRAVO-CHARLIE');
  }, 120_000);

  it('G5.4e permanent 503: exactly 1 + 4 attempts, outcome failed, NO content, NO tool calls, NO other host contacted, null usage', async () => {
    proxy = await startProxy(live.baseUrl, () => ({
      kind: 'respond',
      status: 503,
      body: body503,
    }));
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const started = Date.now();
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('planner'),
    );
    expect(r.outcome).toBe('failed');
    expect(r.finishReason).toBe('error');
    expect(r.content).toBeNull();
    expect(r.toolCalls).toEqual([]);
    expect(r.attempts).toHaveLength(5);
    expect(proxy.seen).toHaveLength(5);
    expect(r.modelReturned).toBeNull();
    expect(Object.values(r.usage)).toEqual([null, null, null, null]);
    expect(r.provider.host).toBe(proxy.host);
    for (const a of r.attempts) expect(RETRYABLE).toContain(a.error?.class);
    // 1 + 2 + 4 + 8 s base delays => at least ~15 s of backoff
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
    const g = gaps(r.attempts);
    for (const x of g) expect(x).toBeLessThanOrEqual(30_500);
    // exponential growth: the last gap is larger than the first
    expect(g[3]).toBeGreaterThan(g[0]);
  }, 180_000);

  it('G5.4f non-retryable provider errors (400, 401, 404) are attempted exactly once', async () => {
    for (const status of [400, 401, 404]) {
      const p = await startProxy(live.baseUrl, () => ({
        kind: 'respond',
        status,
        body: JSON.stringify({ code: 'bad', message: 'no', error_id: 'acc5' }),
      }));
      try {
        const adapter = await createAdapter({ OPENAI_BASE_URL: p.baseUrl });
        const r = await adapter.complete(
          chat(live.model, 'Reply with exactly: OK'),
          ctx('worker'),
        );
        expect(r.outcome, `status ${status}`).toBe('failed');
        expect(r.attempts, `status ${status}`).toHaveLength(1);
        expect(p.seen, `status ${status}`).toHaveLength(1);
        expect(RETRYABLE).not.toContain(r.attempts[0].error?.class);
        expect(r.content).toBeNull();
      } finally {
        await p.close();
      }
    }
  }, 60_000);

  it('G5.4g cancelling during the backoff wait aborts the call (no further attempt), outcome aborted', async () => {
    proxy = await startProxy(live.baseUrl, () => ({
      kind: 'respond',
      status: 503,
      body: body503,
    }));
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const c = new AbortController();
    const pending = adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('worker', c.signal),
    );
    setTimeout(() => c.abort(), 400);
    const r = await pending;
    expect(r.outcome).toBe('aborted');
    expect(proxy.seen).toHaveLength(1);
    expect(r.content).toBeNull();
  }, 60_000);

  it('G5.4h no vendor switch: with a dead primary there is no fallback host; with no base URL or key the adapter refuses to exist', async () => {
    // (1) dead local port: every attempt fails against that one host, no answer appears
    const dead = createServer();
    await new Promise<void>((res) => dead.listen(0, '127.0.0.1', res));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((res) => dead.close(() => res()));
    const adapter = await createAdapter({
      OPENAI_BASE_URL: `http://127.0.0.1:${deadPort}/v1`,
    });
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('worker'),
    );
    expect(r.outcome).toBe('failed');
    expect(r.content).toBeNull();
    expect(r.provider.host).toBe(`127.0.0.1:${deadPort}`);
    expect(r.attempts.length).toBeLessThanOrEqual(5);
    for (const a of r.attempts) expect(a.error?.class).toBe('network');

    // (2) no default provider: unset base URL is BLOCKED, not Crusoe-by-default
    const mod = await loadModule<{
      createInferenceFromEnv: (
        env: Record<string, string | undefined>,
      ) => unknown;
    }>('src/server/nemodots/inference/index.ts');
    const attempt = (env: Record<string, string | undefined>) => {
      try {
        mod.createInferenceFromEnv(env);
      } catch (e) {
        return e as Error & { missingEnv?: string[] };
      }
      return undefined;
    };
    const noUrl = attempt({
      OPENAI_API_KEY: live.apiKey,
      OPENAI_MODEL: live.model,
    });
    expect(noUrl?.name).toBe('InferenceBlockedError');
    expect(noUrl?.missingEnv).toContain('OPENAI_BASE_URL');
    expect(noUrl?.message).not.toContain(live.apiKey);
    const noKey = attempt({
      OPENAI_BASE_URL: live.baseUrl,
      OPENAI_MODEL: live.model,
    });
    expect(noKey?.name).toBe('InferenceBlockedError');
    expect(noKey?.missingEnv).toContain('OPENAI_API_KEY');
  }, 120_000);
});

describe('ACCEPTANCE_CONTRACT 4.3 in-flight cap', () => {
  it('G5.4i with the suite cap of 3, six concurrent live requests never exceed 3 in flight and all complete', async () => {
    proxy = await startProxy(live.baseUrl);
    const adapter = await createAdapter({
      OPENAI_BASE_URL: proxy.baseUrl,
      NEMODOTS_INFERENCE_MAX_IN_FLIGHT: '3',
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        completeThroughSaturation(
          adapter,
          chat(live.model, `Reply with exactly: N${i}`, { maxTokens: 32 }),
        ),
      ),
    );
    expect(results.every((r) => r.outcome === 'completed')).toBe(true);
    expect(proxy.maxConcurrent()).toBeLessThanOrEqual(3);
    expect(proxy.maxConcurrent()).toBeGreaterThanOrEqual(2);
    expect(proxy.seen.length).toBeGreaterThanOrEqual(6); // retries under shared-quota 429s add requests
  }, 180_000);

  it('G5.4j a configured limit above 4 is clamped to 4 (ACCEPTANCE_CONTRACT: at most 4 per model)', async () => {
    // Local responder: an adapter limiter check only, not an inference claim.
    let inFlight = 0;
    let max = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        inFlight++;
        max = Math.max(max, inFlight);
        setTimeout(() => {
          inFlight--;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'x',
              model: live.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 1 },
            }),
          );
        }, 300);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const adapter = await createAdapter({
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        NEMODOTS_INFERENCE_MAX_IN_FLIGHT: '16',
      });
      const rs = await Promise.all(
        Array.from({ length: 12 }, () =>
          adapter.complete(chat(live.model, 'x'), ctx('worker')),
        ),
      );
      expect(rs.every((r) => r.outcome === 'completed')).toBe(true);
      expect(max).toBeLessThanOrEqual(4);
      expect(max).toBe(4);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
