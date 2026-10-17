// Verifier-owned pass-through proxy for provider-disruption trials. The app's
// OPENAI_BASE_URL points here; requests are forwarded unchanged to the real
// provider except while a disruption window is active. It never reads, stores
// or logs request bodies or Authorization headers.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import type { Disruption } from './frozen.js';

export interface ProxyLogEntry {
  n: number;
  method: string;
  path: string;
  modelCall: boolean;
  disposition: 'forwarded' | 'http_503' | 'http_429' | 'connection_reset';
  upstreamStatus: number | null;
  at: number;
}

const HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
]);

const isModelCall = (method: string, path: string) =>
  method === 'POST' && /\/(chat\/completions|responses|completions)(\?|$)/.test(path);

export class ProviderProxy {
  readonly log: ProxyLogEntry[] = [];
  private server: Server | null = null;
  private modelCalls = 0;
  private disruptionStartedAt: number | null = null;
  private disruptedRequests = 0;

  constructor(
    private readonly upstreamBase: string,
    private readonly disruption: Disruption | null,
    private readonly now: () => number = Date.now,
  ) {}

  get modelCallCount() {
    return this.modelCalls;
  }
  get disruptedCount() {
    return this.log.filter((entry) => entry.disposition !== 'forwarded').length;
  }

  async listen(port: number, host = '127.0.0.1'): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
  }

  get port(): number {
    const address = this.server?.address();
    if (!address || typeof address === 'string')
      throw new Error('Proxy is not listening.');
    return address.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private decide(modelCall: boolean): ProxyLogEntry['disposition'] {
    const d = this.disruption;
    if (!d || !modelCall) return 'forwarded';
    // The disruption starts once `startAfterModelCalls` calls have been seen.
    if (this.modelCalls <= d.startAfterModelCalls) return 'forwarded';
    if (this.disruptionStartedAt === null) this.disruptionStartedAt = this.now();
    if (d.requests !== undefined) {
      if (this.disruptedRequests >= d.requests) return 'forwarded';
      this.disruptedRequests += 1;
    } else if (
      d.durationMs !== undefined &&
      this.now() - this.disruptionStartedAt >= d.durationMs
    ) {
      return 'forwarded';
    }
    return d.mode;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const modelCall = isModelCall(method, path);
    if (modelCall) this.modelCalls += 1;
    const n = this.log.length + 1;
    const disposition = this.decide(modelCall);
    const entry: ProxyLogEntry = {
      n,
      method,
      path: path.split('?')[0],
      modelCall,
      disposition,
      upstreamStatus: null,
      at: this.now(),
    };
    this.log.push(entry);

    if (disposition === 'connection_reset') {
      req.resume();
      req.socket.destroy();
      return;
    }
    if (disposition === 'http_503' || disposition === 'http_429') {
      req.resume();
      const status = disposition === 'http_503' ? 503 : 429;
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(status === 429 ? { 'retry-after': '1' } : {}),
      });
      res.end(
        JSON.stringify({
          error: {
            message:
              status === 503
                ? 'verifier-injected provider outage'
                : 'verifier-injected rate limit',
            code: status === 503 ? 'service_unavailable' : 'max_requests_limit',
          },
        }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const target = new URL(this.upstreamBase);
    const suffix = path.replace(/^\/v1(?=\/|$)/, '');
    const url = `${target.origin}${target.pathname.replace(/\/$/, '')}${suffix}`;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: abort.signal,
    });
    entry.upstreamStatus = upstream.status;
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP.has(name) && name !== 'content-encoding') out[name] = value;
    });
    res.writeHead(upstream.status, out);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as never).pipe(res);
  }
}
