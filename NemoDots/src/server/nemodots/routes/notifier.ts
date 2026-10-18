// LISTEN nemodots_events on one shared connection, fanned out to the SSE
// streams. Notifications only wake a stream: it still reads from
// coordinator.events by id, so a dropped notification costs at most one poll.
import pg from 'pg';
import { EVENTS_CHANNEL } from '../coordinator/events.js';
import type { EventNotification, EventNotifier } from './types.js';

export function createPgEventNotifier(
  connectionString: string | (() => string),
  options: { reconnectMs?: number } = {},
): EventNotifier & { close(): Promise<void> } {
  const handlers = new Set<(message: EventNotification) => void>();
  let client: pg.Client | null = null;
  let connecting: Promise<void> | null = null;
  let closed = false;
  const reconnectMs = options.reconnectMs ?? 1000;

  const connect = () => {
    if (client || connecting || closed) return connecting ?? Promise.resolve();
    connecting = (async () => {
      const next = new pg.Client({
        connectionString:
          typeof connectionString === 'function'
            ? connectionString()
            : connectionString,
        application_name: 'nemodots-events-listener',
      });
      next.on('notification', (message) => {
        if (message.channel !== EVENTS_CHANNEL || !message.payload) return;
        try {
          const parsed = JSON.parse(
            message.payload,
          ) as Partial<EventNotification>;
          if (
            typeof parsed.missionId !== 'string' ||
            typeof parsed.id !== 'number'
          )
            return;
          for (const handler of handlers)
            handler({ missionId: parsed.missionId, id: parsed.id });
        } catch {
          /* a malformed notification only loses a wake-up */
        }
      });
      const lost = () => {
        if (client === next) client = null;
        if (!closed && handlers.size > 0)
          setTimeout(() => void connect(), reconnectMs).unref();
      };
      next.on('error', lost);
      next.on('end', lost);
      try {
        await next.connect();
        await next.query(`LISTEN ${EVENTS_CHANNEL}`);
        client = next;
      } catch {
        await next.end().catch(() => undefined);
        lost();
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  return {
    async subscribe(handler) {
      handlers.add(handler);
      void connect();
      return () => {
        handlers.delete(handler);
      };
    },
    async close() {
      closed = true;
      handlers.clear();
      const current = client;
      client = null;
      await current?.end().catch(() => undefined);
    },
  };
}
