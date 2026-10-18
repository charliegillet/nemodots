// Verifier-owned pass-through proxy. EVERY trial routes the app's provider
// traffic through it (OPENAI_BASE_URL points here), so the verifier has an
// observation of inference that does not come from the system under test:
// which model requests really reached the upstream host and with which HTTP
// status, timing, body digest and model field. Only provider-disruption trials
// configure a disruption window; all other trials forward everything.
//
// Privacy: request bodies are never stored or logged. Only a SHA-256 of the
// body, the `model` and `stream` fields parsed from it, and timing/status are
// kept. The Authorization header of the first forwarded model call is kept in
// memory only, to let the verifier ask the upstream `GET /models` once; it is
// never written anywhere.
import { createHash } from 'node:crypto';
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
  /** request arrival time (ms since epoch) */
  at: number;
  /** response fully delivered (or connection dropped) */
  endedAt: number | null;
  /** host:port of the upstream actually contacted, null when not forwarded */
  upstreamHost: string | null;
  /** `model` field of the JSON body of a model call */
  model: string | null;
  stream: boolean | null;
  /** sha256 of the request body, to group retries of one call */
  bodyDigest: string | null;
  upstreamError: string | null;
}

export interface ModelsListing {
  checked: boolean;
  status: number | null;
  listed: Record<string, boolean>;
  note: string;
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
  method === 'POST' &&
  /\/(chat\/completions|responses|completions)(\?|$)/.test(path);

export class ProviderProxy {
  readonly log: ProxyLogEntry[] = [];
  private server: Server | null = null;
  private modelCalls = 0;
  private disruptionStartedAt: number | null = null;
  private disruptedRequests = 0;
  private authorization: string | null = null;

  constructor(
    private readonly upstreamBase: string,
    private readonly disruption: Disruption | null,
    private readonly now: () => number = Date.now,
  ) {}

  get upstreamHost(): string {
    return new URL(this.upstreamBase).host;
  }
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

  /**
   * Independent `GET <upstream>/models`: is each requested model listed? Uses
   * the Authorization header the app itself sent (held in memory only).
   */
  async checkModels(requested: string[]): Promise<ModelsListing> {
    const listed: Record<string, boolean> = Object.fromEntries(
      requested.map((m) => [m, false]),
    );
    if (!this.authorization)
      return {
        checked: false,
        status: null,
        listed,
        note: 'no forwarded model request carried an Authorization header',
      };
    try {
      const response = await fetch(this.upstreamUrl('/models'), {
        headers: { authorization: this.authorization },
      });
      const text = await response.text();
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(text) as {
          data?: { id?: unknown }[];
        };
        ids = (parsed.data ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string');
      } catch {
        /* a non-JSON body lists nothing */
      }
      for (const model of requested) listed[model] = ids.includes(model);
      return {
        checked: response.ok,
        status: response.status,
        listed,
        note: response.ok ? 'ok' : `GET /models returned ${response.status}`,
      };
    } catch (error) {
      return {
        checked: false,
        status: null,
        listed,
        note: `GET /models failed: ${(error as Error).name}`,
      };
    }
  }

  private upstreamUrl(suffix: string) {
    const target = new URL(this.upstreamBase);
    return `${target.origin}${target.pathname.replace(/\/$/, '')}${suffix}`;
  }

  private decide(modelCall: boolean): ProxyLogEntry['disposition'] {
    const d = this.disruption;
    if (!d || !modelCall) return 'forwarded';
    // The disruption starts once `startAfterModelCalls` calls have been seen.
    if (this.modelCalls <= d.startAfterModelCalls) return 'forwarded';
    if (this.disruptionStartedAt === null)
      this.disruptionStartedAt = this.now();
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
      endedAt: null,
      upstreamHost: null,
      model: null,
      stream: null,
      bodyDigest: null,
      upstreamError: null,
    };
    this.log.push(entry);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (modelCall) {
      entry.bodyDigest = createHash('sha256').update(body).digest('hex');
      try {
        const parsed = JSON.parse(body.toString('utf8')) as {
          model?: unknown;
          stream?: unknown;
        };
        entry.model = typeof parsed.model === 'string' ? parsed.model : null;
        entry.stream = parsed.stream === true;
      } catch {
        /* unparseable body: model stays null, which the scorer reports */
      }
    }

    if (disposition === 'connection_reset') {
      entry.endedAt = this.now();
      req.socket.destroy();
      return;
    }
    if (disposition === 'http_503' || disposition === 'http_429') {
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
      entry.endedAt = this.now();
      return;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    if (modelCall && this.authorization === null && headers.authorization)
      this.authorization = headers.authorization;
    const abort = new AbortController();
    res.on('close', () => {
      entry.endedAt ??= this.now();
      abort.abort();
    });
    entry.upstreamHost = this.upstreamHost;
    let upstream: Response;
    try {
      upstream = await fetch(
        this.upstreamUrl(path.replace(/^\/v1(?=\/|$)/, '')),
        {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: abort.signal,
        },
      );
    } catch (error) {
      entry.upstreamError = (error as Error).name;
      entry.endedAt ??= this.now();
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
      return;
    }
    entry.upstreamStatus = upstream.status;
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP.has(name) && name !== 'content-encoding') out[name] = value;
    });
    res.writeHead(upstream.status, out);
    if (!upstream.body) {
      res.end();
      entry.endedAt ??= this.now();
      return;
    }
    Readable.fromWeb(upstream.body as never).pipe(res);
  }
}
