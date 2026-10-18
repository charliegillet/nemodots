// GET /missions/:id/events. The stream is read from coordinator.events by id:
//   1. replay everything with id > Last-Event-ID (exactly the missing ids),
//   2. then stay open, draining new rows when a NOTIFY wakes it or every
//      pollMs, and send a comment heartbeat when nothing was written for
//      heartbeatMs.
// `id:` is coordinator.events.id, which is commit order (C6). Every payload is
// validated against EventPayloadSchema just before it is written (D4); a row
// that fails, or that belongs to another mission, is skipped and never sent,
// and the cursor still moves past it.
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  EventPayloadSchema,
  type MissionEvent,
  type MissionId,
} from '../contracts/index.js';
import { BadRequestError } from './errors.js';
import type { NemodotsRouteDeps } from './types.js';

export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_BATCH = 200;

export function parseLastEventId(header: string | undefined): number {
  if (header === undefined || header === '') return 0;
  if (!/^\d{1,15}$/.test(header))
    throw new BadRequestError('Last-Event-ID must be a non-negative integer.');
  return Number(header);
}

/** The wire form of one event, or null if it must not be sent. */
export function wireEvent(
  event: MissionEvent,
  missionId: MissionId,
): string | null {
  if (event.missionId !== missionId) return null;
  const payload = EventPayloadSchema.safeParse(event.payload);
  if (!payload.success || payload.data.kind !== event.kind) return null;
  return JSON.stringify({
    id: event.id,
    missionId: event.missionId,
    kind: event.kind,
    at: event.at,
    payload: payload.data,
  });
}

export function eventStream(
  c: Context,
  deps: NemodotsRouteDeps,
  missionId: MissionId,
  lastEventId: number,
) {
  const pollMs = deps.sse?.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = deps.sse?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const batch = deps.sse?.batch ?? DEFAULT_BATCH;
  return streamSSE(c, async (stream) => {
    let closed = false;
    let wake: (() => void) | null = null;
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });
    const unsubscribe = await deps.notifier
      ?.subscribe((message) => {
        if (message.missionId === missionId) wake?.();
      })
      .catch(() => undefined);
    let cursor = lastEventId;
    let lastWrite: number;
    const drain = async () => {
      for (;;) {
        const events = await deps.events.replay(missionId, cursor, batch);
        for (const event of events) {
          cursor = Math.max(cursor, event.id);
          const data = wireEvent(event, missionId);
          if (data === null) {
            deps.onInvalidEvent?.({
              missionId,
              id: event.id,
              kind: event.kind,
            });
            continue;
          }
          await stream.writeSSE({
            id: String(event.id),
            event: event.kind,
            data,
          });
          lastWrite = Date.now();
        }
        if (events.length < batch || closed) return;
      }
    };
    try {
      await stream.write(': ready\n\n');
      lastWrite = Date.now();
      while (!closed) {
        await drain();
        if (closed) break;
        if (Date.now() - lastWrite >= heartbeatMs) {
          await stream.write(': heartbeat\n\n');
          lastWrite = Date.now();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.max(10, Math.min(pollMs, heartbeatMs)),
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      unsubscribe?.();
    }
  });
}
