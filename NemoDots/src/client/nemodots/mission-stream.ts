import type { MissionEvent } from '../../server/nemodots/contracts/index.js';
import { authHeaders } from '../api';

// fetch + ReadableStream reader for GET /api/nemodots/missions/:id/events.
// EventSource cannot send an Authorization header and the owner token must
// never appear in a URL, so the SSE framing is parsed here.

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
  retry: number | null;
}

/** Incremental SSE parser (WHATWG event-stream framing). Feed decoded text chunks. */
export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let retry: number | null = null;
  let lastId: string | null = null;

  const dispatch = () => {
    if (data.length > 0) {
      onMessage({
        id: lastId,
        event: event || 'message',
        data: data.join('\n'),
        retry,
      });
    }
    event = '';
    data = [];
    retry = null;
  };

  const line = (text: string) => {
    if (text === '') return dispatch();
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') {
      if (!value.includes('\0')) lastId = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      // A trailing CR may be the first half of CRLF; wait for the next chunk.
      const end = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length;
      let start = 0;
      for (let i = 0; i < end; i += 1) {
        const char = buffer[i];
        if (char !== '\n' && char !== '\r') continue;
        line(buffer.slice(start, i));
        if (char === '\r' && buffer[i + 1] === '\n') i += 1;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}

const EVENT_KEYS = ['id', 'missionId', 'kind', 'at', 'payload'] as const;

/** Structural guard; the server validates against EventPayloadSchema before sending. */
export function isMissionEvent(value: unknown): value is MissionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!EVENT_KEYS.every((key) => key in record)) return false;
  const payload = record.payload as { kind?: unknown } | null;
  return (
    typeof record.id === 'number' &&
    Number.isSafeInteger(record.id) &&
    record.id > 0 &&
    typeof record.missionId === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.at === 'string' &&
    typeof payload === 'object' &&
    payload !== null &&
    payload.kind === record.kind
  );
}

export interface MissionStreamOptions {
  missionId: string;
  /** resume point; the Last-Event-ID header is sent when greater than 0 */
  lastEventId?: number;
  onEvent: (event: MissionEvent) => void;
  onStatus?: (status: StreamStatus, detail?: string) => void;
  onError?: (error: Error) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** injectable for tests; defaults to globalThis.fetch at call time */
  fetchImpl?: typeof fetch;
  /** injectable for tests; defaults to the OpenDots auth headers */
  headers?: () => Record<string, string>;
  /** returns [0, 1); injectable for deterministic jitter */
  random?: () => number;
}

export interface MissionStreamHandle {
  close: () => void;
  lastEventId: () => number;
}

/** Equal-jitter exponential backoff: half fixed, half random. */
export function reconnectDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

class FatalStreamError extends Error {}

export function missionEventsPath(missionId: string): string {
  return `/api/nemodots/missions/${encodeURIComponent(missionId)}/events`;
}

export function openMissionStream(
  options: MissionStreamOptions,
): MissionStreamHandle {
  const baseDelay = options.baseDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 30000;
  const random = options.random ?? Math.random;
  const controller = new AbortController();
  let lastEventId = Math.max(0, options.lastEventId ?? 0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;

  const status = (value: StreamStatus, detail?: string) => {
    if (!closed || value === 'closed') options.onStatus?.(value, detail);
  };

  const connect = async (): Promise<void> => {
    const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const response = await doFetch(missionEventsPath(options.missionId), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/event-stream',
        ...(options.headers ?? authHeaders)(),
        ...(lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {}),
      },
    });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const message = `Event stream failed (${response.status}).`;
      if (!retryable) throw new FatalStreamError(message);
      throw new Error(message);
    }
    if (!response.body) throw new Error('Event stream has no body.');
    status('open');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        options.onError?.(new Error('Ignored an unparseable stream event.'));
        return;
      }
      if (!isMissionEvent(parsed)) {
        options.onError?.(new Error('Ignored a malformed stream event.'));
        return;
      }
      lastEventId = Math.max(lastEventId, parsed.id);
      options.onEvent(parsed);
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        attempt = 0;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
    } finally {
      reader.releaseLock?.();
    }
  };

  const run = async (): Promise<void> => {
    for (;;) {
      if (closed) return;
      try {
        await connect();
        if (closed) return;
        // A clean end of stream is still a disconnect: resume from lastEventId.
      } catch (error) {
        if (closed || controller.signal.aborted) return;
        if (error instanceof FatalStreamError) {
          options.onError?.(error);
          closed = true;
          options.onStatus?.('closed', error.message);
          return;
        }
        options.onError?.(
          error instanceof Error ? error : new Error('Event stream failed.'),
        );
      }
      if (closed) return;
      status('reconnecting');
      const delay = reconnectDelay(attempt, baseDelay, maxDelay, random);
      attempt += 1;
      await new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = null;
          resolve();
        }, delay);
        controller.signal.addEventListener(
          'abort',
          () => {
            if (timer) clearTimeout(timer);
            timer = null;
            resolve();
          },
          { once: true },
        );
      });
    }
  };

  status('connecting');
  void run();

  return {
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      options.onStatus?.('closed');
    },
    lastEventId: () => lastEventId,
  };
}
