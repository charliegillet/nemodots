import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import pg from 'pg';
import {
  MissionEventSchema,
  type MissionEvent,
  type MissionId,
} from '../contracts/index.js';
import { EVENTS_CHANNEL, replayEvents } from '../coordinator/events.js';

// GET /missions/:id/events (ARCHITECTURE.md section 8, CONTRACTS.md section 8).
//
//   - replay `id > Last-Event-ID` for the path's mission, then tail;
//   - tailing wakes on LISTEN nemodots_events and polls every pollMs as the
//     fallback, so a missed NOTIFY (or no listener at all) only costs latency;
//   - a heartbeat comment every heartbeatMs keeps idle connections alive;
//   - every event is validated against MissionEventSchema (which contains
//     EventPayloadSchema) immediately before it is written (D4). An event that
//     fails is never written; it is reported to onInvalidEvent by id and kind;
//   - writes are awaited one at a time and a write that stalls longer than
//     writeTimeoutMs ends the stream, so a client that stops reading cannot
//     make the server buffer without bound. It reconnects with Last-Event-ID.

export interface EventStreamOptions {
  pollMs: number;
  heartbeatMs: number;
  writeTimeoutMs: number;
  batchSize: number;
  /** Consecutive replay failures after which the stream ends (client reconnects). */
  maxReplayFailures: number;
}

export const DEFAULT_EVENT_STREAM_OPTIONS: EventStreamOptions = {
  pollMs: 2_000,
  heartbeatMs: 15_000,
  writeTimeoutMs: 30_000,
  batchSize: 200,
  maxReplayFailures: 5,
};

/** One shared LISTEN connection for every open stream; closed with the last one. */
export class EventHub {
  private readonly subscribers = new Map<string, Set<() => void>>();
  private client: pg.Client | null = null;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private count = 0;

  constructor(
    private readonly listenUrl: string | (() => string) | undefined,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly reconnectMs = 1_000,
  ) {}

  get size() {
    return this.count;
  }

  subscribe(missionId: string, wake: () => void): () => void {
    let set = this.subscribers.get(missionId);
    if (!set) this.subscribers.set(missionId, (set = new Set()));
    set.add(wake);
    this.count += 1;
    void this.ensure();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.subscribers.get(missionId);
      if (current?.delete(wake)) this.count -= 1;
      if (current?.size === 0) this.subscribers.delete(missionId);
      if (this.count === 0) void this.close();
    };
  }

  private wake(missionId?: string) {
    const sets = missionId
      ? [this.subscribers.get(missionId)]
      : [...this.subscribers.values()];
    for (const set of sets) for (const wake of [...(set ?? [])]) wake();
  }

  private async ensure() {
    if (!this.listenUrl || this.client || this.connecting || this.count === 0)
      return;
    this.connecting = true;
    const client = new pg.Client({
      connectionString:
        typeof this.listenUrl === 'function'
          ? this.listenUrl()
          : this.listenUrl,
      application_name: 'nemodots-sse-listen',
    });
    let dropped = false;
    const drop = (error?: unknown) => {
      if (dropped) return;
      dropped = true;
      if (error) this.onError(error);
      if (this.client === client) this.client = null;
      void client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on('error', drop);
    client.on('end', () => drop());
    client.on('notification', (message) => {
      if (message.channel !== EVENTS_CHANNEL) return;
      try {
        const parsed = JSON.parse(message.payload ?? '') as {
          missionId?: unknown;
        };
        if (typeof parsed.missionId === 'string') this.wake(parsed.missionId);
      } catch {
        this.wake(); // unreadable payload: let everyone poll
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (error) {
      this.connecting = false;
      drop(error);
      return;
    }
    this.connecting = false;
    if (this.count === 0) {
      dropped = true;
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    // Notifications that fell into a connection gap are gone: poll once.
    this.wake();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.count === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensure();
    }, this.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  async close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }
}

/** The event as it may be written: whole-event schema, scope and kind checks. */
export function checkEvent(
  event: MissionEvent,
  missionId: string,
): MissionEvent | null {
  const parsed = MissionEventSchema.safeParse(event);
  if (!parsed.success) return null;
  if (parsed.data.missionId !== missionId) return null;
  return parsed.data;
}

export interface MissionEventStreamDeps {
  pool: pg.Pool;
  hub: EventHub;
  options: EventStreamOptions;
  now: () => number;
  /** Receives id and kind of an event that failed validation (never the payload). */
  onInvalidEvent: (info: { eventId: number; kind: string }) => void;
  onError: (error: unknown) => void;
}

class WriteTimeoutError extends Error {}

export function missionEventStream(
  c: Context,
  deps: MissionEventStreamDeps,
  missionId: MissionId,
  afterId: number,
) {
  const { options } = deps;
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    let closed = false;
    let signalled = false;
    let wakeWaiter: (() => void) | null = null;
    const poke = () => {
      signalled = true;
      wakeWaiter?.();
    };
    stream.onAbort(() => {
      closed = true;
      poke();
    });
    const unsubscribe = deps.hub.subscribe(missionId, poke);

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        if (signalled || closed) {
          signalled = false;
          return resolve();
        }
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wakeWaiter = null;
          signalled = false;
          resolve();
        }
        wakeWaiter = done;
      });

    const guarded = async (write: () => Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          write(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new WriteTimeoutError()),
              options.writeTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      let cursor = afterId;
      let lastWrite = deps.now();
      let failures = 0;
      // Flushes the response head so proxies and fetch() resolve immediately.
      await guarded(() => stream.write(': connected\n\n'));
      while (!closed && !stream.aborted) {
        let batch: MissionEvent[];
        try {
          batch = await replayEvents(
            deps.pool,
            missionId,
            cursor,
            options.batchSize,
          );
          failures = 0;
        } catch (error) {
          deps.onError(error);
          failures += 1;
          if (failures >= options.maxReplayFailures) break;
          await wait(options.pollMs);
          continue;
        }
        for (const event of batch) {
          if (closed || stream.aborted) break;
          cursor = Math.max(cursor, event.id);
          const checked = checkEvent(event, missionId);
          if (!checked) {
            deps.onInvalidEvent({ eventId: event.id, kind: event.kind });
            continue;
          }
          await guarded(() =>
            stream.writeSSE({
              id: String(checked.id),
              event: checked.kind,
              data: JSON.stringify(checked),
            }),
          );
          lastWrite = deps.now();
        }
        if (batch.length >= options.batchSize) continue;
        const untilHeartbeat = options.heartbeatMs - (deps.now() - lastWrite);
        if (untilHeartbeat <= 0) {
          await guarded(() => stream.write(': heartbeat\n\n'));
          lastWrite = deps.now();
        }
        await wait(
          Math.max(
            1,
            Math.min(
              options.pollMs,
              options.heartbeatMs - (deps.now() - lastWrite),
            ),
          ),
        );
      }
    } catch (error) {
      // A stalled or broken client write ends the stream; others are reported.
      if (!(error instanceof WriteTimeoutError) && !closed) deps.onError(error);
    } finally {
      unsubscribe();
      closed = true;
      if (!stream.aborted) stream.abort();
    }
  });
}
