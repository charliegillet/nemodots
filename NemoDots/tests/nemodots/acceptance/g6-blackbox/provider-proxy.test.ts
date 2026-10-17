// Deterministic adapter checks of the verifier-owned provider proxy used by the
// provider-disruption trials (G6.10). The upstream here is a local stub: this
// proves the disruption instrument behaves as the frozen manifest describes. It
// says nothing about live inference, which only the autonomous trials establish.
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderProxy } from './helpers/provider-proxy.js';
import { sleep } from './helpers/http.js';

let upstream: Server;
let upstreamPort = 0;
let seen: {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}[] = [];
let proxy: ProviderProxy | null = null;

beforeEach(async () => {
  seen = [];
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url?.includes('stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      await sleep(400);
      res.end('data: two\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as { port: number }).port;
});

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function start(
  disruption: ConstructorParameters<typeof ProviderProxy>[1],
) {
  proxy = new ProviderProxy(`http://127.0.0.1:${upstreamPort}/v1`, disruption);
  await proxy.listen(0);
  return `http://127.0.0.1:${proxy.port}/v1`;
}
const chat = (base: string) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });

describe('G6.10 provider proxy (deterministic adapter)', () => {
  it('G6.10 forwards unchanged when no disruption is configured, keeping path, body and auth', async () => {
    const base = await start(null);
    const response = await chat(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      path: '/v1/chat/completions',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      auth: 'Bearer test-token',
    });
    expect(seen[0].body).toContain('"model":"m"');
    expect(proxy!.modelCallCount).toBe(1);
    expect(proxy!.disruptedCount).toBe(0);
  });

  it('G6.10 http_503 starts after N model calls, lasts durationMs, never touches non-model routes', async () => {
    const base = await start({
      mode: 'http_503',
      startAfterModelCalls: 2,
      durationMs: 700,
    });
    expect((await chat(base)).status).toBe(200);
    expect((await chat(base)).status).toBe(200);
    const models = await fetch(`${base}/models`);
    expect(models.status).toBe(200);
    await models.arrayBuffer();
    const third = await chat(base);
    expect(third.status).toBe(503);
    await third.arrayBuffer();
    expect((await chat(base)).status).toBe(503);
    await sleep(800);
    expect((await chat(base)).status).toBe(200);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(3); // disrupted calls never reached upstream
    expect(proxy!.disruptedCount).toBe(2);
  });

  it('G6.10 http_429 answers exactly the configured number of requests with Retry-After', async () => {
    const base = await start({
      mode: 'http_429',
      startAfterModelCalls: 1,
      requests: 3,
    });
    expect((await chat(base)).status).toBe(200);
    for (let n = 0; n < 3; n += 1) {
      const limited = await chat(base);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('1');
      await limited.arrayBuffer();
    }
    expect((await chat(base)).status).toBe(200);
    expect(proxy!.disruptedCount).toBe(3);
  });

  it('G6.10 connection_reset drops the connection during the window then recovers', async () => {
    const base = await start({
      mode: 'connection_reset',
      startAfterModelCalls: 1,
      durationMs: 500,
    });
    expect((await chat(base)).status).toBe(200);
    await expect(chat(base)).rejects.toThrow();
    await sleep(600);
    expect((await chat(base)).status).toBe(200);
  });

  it('G6.10 streams pass through incrementally (first chunk before the stream ends)', async () => {
    const base = await start(null);
    const response = await fetch(`${base}/stream/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    const reader = response.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    const firstAfter = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain('one');
    expect(firstAfter).toBeLessThan(350);
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('two');
  });
});
