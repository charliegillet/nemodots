// TEST_PROMPT gate 5 case 5 ("Provider interruption -> retry or block; never
// vendor switch or prerecorded answer") and the limits of ACCEPTANCE_CONTRACT
// section 4.3: <= 4 in flight per model, retries only on rate_limited |
// provider_unavailable | timeout | network, at most 4 per call, 1 s base and
// 30 s cap, no automatic retry otherwise.
//
// Spec ambiguities (jitter form, clamp vs reject, error naming) are settled in
// ACCEPTANCE_CONTRACT.md "Gate 5 clarifications"; these tests assert only what
// the spec guarantees: delays in [0, cap], at most 4 retries, at most N in
// flight, and a missing-env error that names the missing variables.
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
  it('G5.4a two 503s then recovery: 3 attempts to the SAME provider, the recovered call is real inference, backoff within [0, 30 s]', async () => {
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
      // jittered exponential backoff: full, equal or additive jitter all fit,
      // so only the cap is guaranteed (timer slack 500 ms)
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(30_500);
    }
    // the n-th retry's delay can never exceed twice the un-jittered base
    // 1 s * 2^(n-1) (an envelope that covers +100% additive jitter)
    gaps(r.attempts).forEach((g, i) =>
      expect(g).toBeLessThanOrEqual(Math.min(30_000, 2000 * 2 ** i) + 500),
    );
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

  it('G5.4e permanent 503: at most 1 + 4 attempts, at least one retry, outcome failed, NO content, NO tool calls, NO other host contacted, null usage', async () => {
    proxy = await startProxy(live.baseUrl, () => ({
      kind: 'respond',
      status: 503,
      body: body503,
    }));
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('planner'),
    );
    expect(r.outcome).toBe('failed');
    expect(r.finishReason).toBe('error');
    expect(r.content).toBeNull();
    expect(r.toolCalls).toEqual([]);
    // "at most 4 retries" (ACCEPTANCE_CONTRACT 4.3): between 2 and 5 attempts
    expect(r.attempts.length).toBeGreaterThanOrEqual(2);
    expect(r.attempts.length).toBeLessThanOrEqual(5);
    expect(proxy.seen).toHaveLength(r.attempts.length);
    expect(r.modelReturned).toBeNull();
    expect(Object.values(r.usage)).toEqual([null, null, null, null]);
    expect(r.provider.host).toBe(proxy.host);
    for (const a of r.attempts) expect(RETRYABLE).toContain(a.error?.class);
    const g = gaps(r.attempts);
    g.forEach((x, i) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(Math.min(30_000, 2000 * 2 ** i) + 500);
    });
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

  it('G5.4g cancelling during retry backoff aborts the call: outcome aborted and no request is made after the abort settles', async () => {
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
    // abort as soon as the first 503 was served (jitter may make the first
    // backoff arbitrarily short, so no fixed sleep is assumed)
    const t0 = Date.now();
    while (proxy.seen.length < 1 && Date.now() - t0 < 10_000)
      await new Promise((r) => setTimeout(r, 5));
    c.abort();
    const r = await pending;
    expect(r.outcome).toBe('aborted');
    expect(r.content).toBeNull();
    const countAtSettle = proxy.seen.length;
    expect(countAtSettle).toBeLessThanOrEqual(2); // at most one racing retry
    // a live retry loop would fire again within the next backoff window
    await new Promise((r) => setTimeout(r, 4000));
    expect(proxy.seen.length).toBe(countAtSettle);
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
    // Property-based: the error need not carry a particular class name, but it
    // must refuse to build and list the missing variable NAMES (CONTRACTS /
    // ARCHITECTURE section on live mode), never the secret.
    const names = (e: (Error & { missingEnv?: string[] }) | undefined) =>
      [
        ...(Array.isArray(e?.missingEnv) ? e!.missingEnv : []),
        ...(e?.message.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []),
      ];
    const noUrl = attempt({
      OPENAI_API_KEY: live.apiKey,
      OPENAI_MODEL: live.model,
    });
    expect(noUrl, 'adapter must refuse to build without OPENAI_BASE_URL').toBeDefined();
    expect(names(noUrl)).toContain('OPENAI_BASE_URL');
    expect(noUrl!.message).not.toContain(live.apiKey);
    const noKey = attempt({
      OPENAI_BASE_URL: live.baseUrl,
      OPENAI_MODEL: live.model,
    });
    expect(noKey, 'adapter must refuse to build without OPENAI_API_KEY').toBeDefined();
    expect(names(noKey)).toContain('OPENAI_API_KEY');
    expect(noKey!.message).not.toContain(live.apiKey);
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

  it('G5.4j a configured limit above 4 is clamped or rejected, never honoured (ACCEPTANCE_CONTRACT: at most 4 per model)', async () => {
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
      let adapter;
      try {
        adapter = await createAdapter({
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          NEMODOTS_INFERENCE_MAX_IN_FLIGHT: '16',
        });
      } catch (e) {
        // Rejecting the configuration also complies, if it says why.
        if (e instanceof Error && e.name === 'EntryPointMissing') throw e;
        expect((e as Error).message).toMatch(/IN_FLIGHT|in.?flight|4/i);
        return;
      }
      const rs = await Promise.all(
        Array.from({ length: 12 }, () =>
          adapter.complete(chat(live.model, 'x'), ctx('worker')),
        ),
      );
      expect(rs.every((r) => r.outcome === 'completed')).toBe(true);
      expect(max).toBeGreaterThanOrEqual(1);
      expect(max).toBeLessThanOrEqual(4);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

describe('TEST_PROMPT gate 5 bullet 4 timeout class', () => {
  it('G5.4k an upstream that sends no headers for longer than the 60 s call timeout is classified timeout and retried against the same host', async () => {
    // Needs the real 60 s timeout (ARCHITECTURE: "60 s per inference call").
    // No env override exists in createInferenceFromEnv: recorded as a dependency
    // (NEMODOTS_INFERENCE_TIMEOUT_MS) so the case can be shortened later.
    proxy = await startProxy(live.baseUrl, (req) =>
      req.n === 1
        ? { kind: 'forward', headerDelayMs: 65_000 }
        : { kind: 'forward' },
    );
    const adapter = await createAdapter({ OPENAI_BASE_URL: proxy.baseUrl });
    const r = await adapter.complete(
      chat(live.model, 'Reply with exactly: OK'),
      ctx('worker'),
    );
    expect(r.attempts.length).toBeGreaterThanOrEqual(2);
    expect(r.attempts[0].error?.class).toBe('timeout');
    expect(r.attempts[0].httpStatus).toBeNull();
    expect(Object.values(r.attempts[0].usage)).toEqual([null, null, null, null]);
    expect(r.outcome).toBe('completed');
    expect(r.provider.host).toBe(proxy.host);
  }, 170_000);
});
