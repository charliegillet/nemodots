// HTTP client for the documented /api/nemodots routes (CONTRACTS.md section 9).
// Responses are validated with the strict contract schemas, so a drifting or
// leaking payload fails here rather than being silently tolerated.
import {
  type CreateMissionRequest,
  type HealthStatus,
  HealthStatusSchema,
  type Mission,
  type MissionEvent,
  MissionEventSchema,
  MissionSchema,
  type MissionSnapshot,
  MissionSnapshotSchema,
  SourceEditResponseSchema,
} from '../../../../src/server/nemodots/contracts/index.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    label: string,
  ) {
    super(`${label} -> HTTP ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
}

export class NemoApi {
  constructor(readonly base: string) {}

  private async call(
    method: string,
    path: string,
    body?: unknown,
    expect: number[] = [200, 201],
  ) {
    const response = await fetch(`${this.base}/api/nemodots${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!expect.includes(response.status))
      throw new HttpError(response.status, json, `${method} ${path}`);
    return { status: response.status, json };
  }

  async health(): Promise<HealthStatus> {
    return HealthStatusSchema.parse((await this.call('GET', '/health')).json);
  }
  /** Goal-only mission creation: the body never names a fault, key or value. */
  async createMission(request: CreateMissionRequest): Promise<Mission> {
    return MissionSchema.parse(
      (await this.call('POST', '/missions', request, [201])).json,
    );
  }
  async createMissionRaw(request: unknown) {
    return this.call('POST', '/missions', request, [200, 201, 400, 503]);
  }
  async lifecycle(
    id: string,
    action: 'start' | 'pause' | 'resume' | 'cancel',
    expect: number[] = [200],
  ) {
    const { status, json } = await this.call(
      'POST',
      `/missions/${id}/${action}`,
      {},
      expect,
    );
    return {
      status,
      mission: status === 200 ? MissionSchema.parse(json) : null,
      json,
    };
  }
  async snapshot(id: string): Promise<MissionSnapshot> {
    return MissionSnapshotSchema.parse(
      (await this.call('GET', `/missions/${id}`)).json,
    );
  }
  async editSource(
    key: string,
    value: string | number | boolean,
    expectedVersion: number,
  ) {
    const { json } = await this.call(
      'POST',
      `/sandbox/sources/${encodeURIComponent(key)}`,
      { value, expectedVersion },
    );
    return SourceEditResponseSchema.parse(json);
  }
  async editSourceRaw(key: string, value: unknown, expectedVersion: number) {
    return this.call(
      'POST',
      `/sandbox/sources/${encodeURIComponent(key)}`,
      { value, expectedVersion },
      [200, 400, 409],
    );
  }

  tail(missionId: string, lastEventId = 0) {
    return new EventTail(
      `${this.base}/api/nemodots/missions/${missionId}/events`,
      lastEventId,
    );
  }
}

type Kind = MissionEvent['payload']['kind'];

/** Durable SSE consumer: dedupes by id and verifies commit order == id order. */
export class EventTail {
  readonly events: MissionEvent[] = [];
  readonly parseErrors: string[] = [];
  private seen = new Set<number>();
  private controller: AbortController | null = null;
  private done: Promise<void> | null = null;
  duplicatesDropped = 0;
  outOfOrder = 0;

  constructor(
    private readonly url: string,
    private lastEventId: number,
  ) {}

  start() {
    this.controller = new AbortController();
    this.done = this.pump(this.controller.signal).catch(() => undefined);
    return this;
  }

  private async pump(signal: AbortSignal) {
    const response = await fetch(this.url, {
      headers: {
        accept: 'text/event-stream',
        ...(this.lastEventId
          ? { 'last-event-id': String(this.lastEventId) }
          : {}),
      },
      signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`SSE HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        this.accept(frame);
      }
    }
  }

  /** Feed one raw SSE frame (also used by the harness self-check). */
  accept(frame: string) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.parseErrors.push('non-JSON SSE data frame');
      return;
    }
    const result = MissionEventSchema.safeParse(parsed);
    if (!result.success) {
      this.parseErrors.push(
        result.error.issues
          .slice(0, 2)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      );
      return;
    }
    const event = result.data;
    if (this.seen.has(event.id)) {
      this.duplicatesDropped += 1;
      return;
    }
    const last = this.events.at(-1);
    if (last && event.id < last.id) this.outOfOrder += 1;
    this.seen.add(event.id);
    this.events.push(event);
    this.lastEventId = Math.max(this.lastEventId, event.id);
  }

  get last() {
    return this.lastEventId;
  }
  of<K extends Kind>(kind: K) {
    return this.events.filter(
      (e) => e.payload.kind === kind,
    ) as (MissionEvent & {
      payload: Extract<MissionEvent['payload'], { kind: K }>;
    })[];
  }
  async until(
    predicate: (events: readonly MissionEvent[]) => boolean,
    timeoutMs: number,
    label: string,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (Date.now() > deadline)
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for ${label}; ${this.events.length} events seen (${[...new Set(this.events.map((e) => e.payload.kind))].join(', ')})`,
        );
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  async stop() {
    this.controller?.abort();
    await this.done;
  }
}

export async function waitForMission(
  api: NemoApi,
  id: string,
  predicate: (snapshot: MissionSnapshot) => boolean,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await api.snapshot(id);
    if (predicate(last)) return last;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${label}; mission status ${last.mission.status}, tasks ${last.tasks.map((t) => t.status).join(',')}`,
      );
    await new Promise((r) => setTimeout(r, 400));
  }
}

export const isTerminal = (status: string) =>
  ['succeeded', 'failed', 'cancelled'].includes(status);
