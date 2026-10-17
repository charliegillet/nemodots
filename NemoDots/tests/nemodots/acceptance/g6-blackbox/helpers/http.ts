// Plain HTTP drivers: the public NemoDots API (Bearer owner token), the
// checkout API, an SSE collector and the verifier's own load/health samplers.
import { apiBase, checkoutBase } from './config.js';

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  text: string;
}

export class NemoApi {
  constructor(private readonly token: string) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body kept as text */
    }
    return { status: response.status, body: parsed as T, text };
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body);
  }

  authHeader() {
    return { authorization: `Bearer ${this.token}` };
  }
}

export interface CollectedEvent {
  id: number;
  kind: string;
  receivedAt: number;
  data: Record<string, unknown>;
}

/** Streams GET /missions/:id/events, reconnecting with Last-Event-ID, deduplicating by id. */
export class EventCollector {
  readonly events: CollectedEvent[] = [];
  private readonly seen = new Set<number>();
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private lastId = 0;
  private listeners: ((event: CollectedEvent) => void)[] = [];
  reconnects = 0;
  duplicatesDropped = 0;

  constructor(
    private readonly api: NemoApi,
    private readonly missionId: string,
  ) {}

  onEvent(fn: (event: CollectedEvent) => void) {
    this.listeners.push(fn);
  }

  start() {
    this.running = this.loop();
  }

  async stop() {
    this.abort.abort();
    await this.running?.catch(() => undefined);
  }

  private async loop() {
    while (!this.abort.signal.aborted) {
      try {
        const response = await fetch(
          `${apiBase}/missions/${this.missionId}/events`,
          {
            headers: {
              ...this.api.authHeader(),
              accept: 'text/event-stream',
              ...(this.lastId ? { 'last-event-id': String(this.lastId) } : {}),
            },
            signal: this.abort.signal,
          },
        );
        if (!response.ok || !response.body) {
          await response.arrayBuffer().catch(() => undefined);
          await sleep(1000);
          continue;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            this.ingest(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 2);
          }
        }
      } catch {
        if (this.abort.signal.aborted) return;
      }
      this.reconnects += 1;
      await sleep(500);
    }
  }

  private ingest(block: string) {
    let id = 0;
    let kind = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim());
      else if (line.startsWith('event:')) kind = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!id || !data.length) return;
    if (this.seen.has(id)) {
      this.duplicatesDropped += 1;
      return;
    }
    this.seen.add(id);
    this.lastId = Math.max(this.lastId, id);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.join('\n')) as Record<string, unknown>;
    } catch {
      parsed = { unparseable: data.join('\n') };
    }
    const event: CollectedEvent = {
      id,
      kind: kind || String((parsed.payload as { kind?: string })?.kind ?? ''),
      receivedAt: Date.now(),
      data: parsed,
    };
    this.events.push(event);
    for (const fn of this.listeners) fn(event);
  }

  find(predicate: (event: CollectedEvent) => boolean) {
    return this.events.find(predicate);
  }
}

/** payload of a MissionEvent as {kind, ...fields} */
export function payloadOf(event: CollectedEvent): Record<string, unknown> {
  const payload = event.data.payload;
  return (
    payload && typeof payload === 'object' ? payload : event.data
  ) as Record<string, unknown>;
}

export interface CheckoutResult {
  status: number;
  body: unknown;
  text: string;
}

export async function checkoutRequest(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<CheckoutResult> {
  const response = await fetch(`${checkoutBase}${path}`, {
    method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: response.status, body, text };
}

export interface HealthSample {
  at: number;
  status: number;
  health: string | null;
  errorClasses: string[];
}

/** Verifier health window: GET /health every intervalMs for windowMs. */
export async function sampleHealthWindow(
  windowMs: number,
  intervalMs = 2000,
): Promise<HealthSample[]> {
  const samples: HealthSample[] = [];
  const end = Date.now() + windowMs;
  let next = Date.now();
  while (Date.now() < end) {
    const started = Date.now();
    try {
      const result = await checkoutRequest('GET', '/health');
      const body = (result.body ?? {}) as {
        status?: string;
        errorClasses?: string[];
      };
      samples.push({
        at: started,
        status: result.status,
        health: typeof body.status === 'string' ? body.status : null,
        errorClasses: body.errorClasses ?? [],
      });
    } catch {
      samples.push({ at: started, status: 0, health: null, errorClasses: [] });
    }
    next += intervalMs;
    await sleep(Math.max(0, next - Date.now()));
  }
  return samples;
}

/** Read-only background load: concurrent GETs only, never a write. */
export class ReadLoad {
  requests = 0;
  failures = 0;
  private stopped = false;
  private workers: Promise<void>[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly sku: string,
  ) {}

  start() {
    const paths = ['/health', '/ready', '/products', `/inventory/${this.sku}`];
    for (let w = 0; w < this.concurrency; w += 1)
      this.workers.push(
        (async () => {
          let n = w;
          while (!this.stopped) {
            try {
              const result = await checkoutRequest(
                'GET',
                paths[n % paths.length],
              );
              this.requests += 1;
              if (result.status >= 500) this.failures += 1;
            } catch {
              this.failures += 1;
            }
            n += 1;
            await sleep(250);
          }
        })(),
      );
  }

  async stop() {
    this.stopped = true;
    await Promise.all(this.workers);
  }
}

export interface LoadSampleResult {
  requests: number;
  status: Record<string, number>;
  poolTimeout503: number;
  otherFailures: number;
}

/** Verifier-driven concurrent read sample (kind load_sample). */
export async function loadSample(
  requests: number,
  concurrency: number,
  sku: string,
): Promise<LoadSampleResult> {
  const result: LoadSampleResult = {
    requests,
    status: {},
    poolTimeout503: 0,
    otherFailures: 0,
  };
  let issued = 0;
  const paths = ['/products', `/inventory/${sku}`];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < requests) {
        const n = issued;
        issued += 1;
        try {
          const response = await checkoutRequest(
            'GET',
            paths[n % paths.length],
          );
          const key = String(response.status);
          result.status[key] = (result.status[key] ?? 0) + 1;
          if (response.status === 503 && /pool_timeout/.test(response.text))
            result.poolTimeout503 += 1;
          else if (response.status >= 500) result.otherFailures += 1;
        } catch {
          result.status.error = (result.status.error ?? 0) + 1;
          result.otherFailures += 1;
        }
      }
    }),
  );
  return result;
}
