// Typed HTTP client for /api/nemodots (CONTRACTS section 9). Every response is
// validated against the shared contract schemas, so this client is also an
// independent check that the server speaks the contract.
import {
  HealthStatusSchema,
  MissionEventSchema,
  MissionSchema,
  MissionSnapshotSchema,
  type HealthStatus,
  type Mission,
  type MissionEvent,
  type MissionLifecycleAction,
  type MissionSnapshot,
  type TelemetrySummary,
  TelemetrySummarySchema,
} from '../../../../../src/server/nemodots/contracts/index.js';
import { API, until } from './env.js';

export class NemoApi {
  constructor(private readonly headers: Record<string, string> = {}) {}

  async raw(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<Response> {
    const { json, ...rest } = init;
    return fetch(`${API}${path}`, {
      ...rest,
      headers: {
        ...this.headers,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  }

  private async body<T>(res: Response, parse: (v: unknown) => T): Promise<T> {
    const text = await res.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(
        `${res.url} returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok)
      throw new HttpError(res.status, value, `${res.url} -> ${res.status}`);
    return parse(value);
  }

  async health(): Promise<HealthStatus> {
    return this.body(await this.raw('/health'), (v) =>
      HealthStatusSchema.parse(v),
    );
  }

  async createMission(input: {
    goal: string;
    constraints?: string[];
    mode?: 'live' | 'fixture';
    admission?: { minAgeMs: number };
  }): Promise<Mission> {
    return this.body(
      await this.raw('/missions', { method: 'POST', json: input }),
      (v) => MissionSchema.parse(v),
    );
  }

  async listMissions(): Promise<Mission[]> {
    return this.body(await this.raw('/missions'), (v) =>
      MissionSchema.array().parse(v),
    );
  }

  async snapshot(id: string): Promise<MissionSnapshot> {
    return this.body(await this.raw(`/missions/${id}`), (v) =>
      MissionSnapshotSchema.parse(v),
    );
  }

  async lifecycle(
    id: string,
    action: MissionLifecycleAction,
  ): Promise<Mission> {
    return this.body(
      await this.raw(`/missions/${id}/${action}`, { method: 'POST', json: {} }),
      (v) => MissionSchema.parse(v),
    );
  }

  async lifecycleStatus(id: string, action: MissionLifecycleAction) {
    const res = await this.raw(`/missions/${id}/${action}`, {
      method: 'POST',
      json: {},
    });
    await res.text();
    return res.status;
  }

  async telemetry(missionId?: string): Promise<TelemetrySummary> {
    const qs = missionId ? `?missionId=${encodeURIComponent(missionId)}` : '';
    return this.body(await this.raw(`/telemetry/summary${qs}`), (v) =>
      TelemetrySummarySchema.parse(v),
    );
  }

  async injectorRun(scenarioClass: string): Promise<{ runId: string }> {
    return this.body(
      await this.raw('/sandbox/injector/run', {
        method: 'POST',
        json: { scenarioClass },
      }),
      (v) => v as { runId: string },
    );
  }

  /** Raw event-stream text (for leak scanning), replayed from `lastEventId`. */
  async rawEventText(
    id: string,
    options: { lastEventId?: number; maxMs?: number } = {},
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.maxMs ?? 4000);
    let text = '';
    try {
      const res = await this.raw(`/missions/${id}/events`, {
        signal: controller.signal,
        headers: { 'Last-Event-ID': String(options.lastEventId ?? 0) },
      });
      if (!res.ok || !res.body) throw new Error(`events -> ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') throw error;
    } finally {
      clearTimeout(timer);
    }
    return text;
  }

  /** Reads the durable SSE stream until `stopWhen` or the idle/timeout budget. */
  async events(
    id: string,
    options: {
      lastEventId?: number;
      maxMs?: number;
      stopWhen?: (e: MissionEvent[]) => boolean;
    } = {},
  ): Promise<MissionEvent[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.maxMs ?? 4000);
    const out: MissionEvent[] = [];
    try {
      const res = await this.raw(`/missions/${id}/events`, {
        signal: controller.signal,
        headers:
          options.lastEventId !== undefined
            ? { 'Last-Event-ID': String(options.lastEventId) }
            : {},
      });
      if (!res.ok || !res.body) throw new Error(`events -> ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data) continue;
          const parsed = MissionEventSchema.safeParse(JSON.parse(data));
          if (!parsed.success)
            throw new Error(
              `event failed MissionEventSchema: ${parsed.error.message}`,
            );
          out.push(parsed.data);
          if (options.stopWhen?.(out)) {
            controller.abort();
            return out;
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') throw error;
    } finally {
      clearTimeout(timer);
    }
    return out;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export const TERMINAL_MISSION = ['succeeded', 'failed', 'cancelled'] as const;
export const isTerminal = (status: string) =>
  (TERMINAL_MISSION as readonly string[]).includes(status);

/** Mission lifecycle table transcribed from CONTRACTS section 4 (not production code). */
export const MISSION_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  created: ['running', 'blocked_provider', 'cancelled'],
  blocked_provider: ['created', 'cancelled'],
  running: ['paused', 'awaiting_acceptance', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  awaiting_acceptance: ['succeeded', 'running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const GOAL =
  'Investigate the checkout service and restore normal operation if anything is wrong. Acceptance: a fresh order succeeds, inventory stays consistent and health stays ok.';
export const CONSTRAINTS = [
  'Change checkout configuration only through proposed actions.',
  'Do not change anything that the evidence does not show is broken.',
];

export async function waitForSnapshot(
  api: NemoApi,
  id: string,
  describe: string,
  predicate: (s: MissionSnapshot) => boolean,
  timeoutMs = 120_000,
): Promise<MissionSnapshot> {
  return until(
    describe,
    async () => {
      const s = await api.snapshot(id);
      return predicate(s) ? s : null;
    },
    { timeoutMs, intervalMs: 1000 },
  );
}
