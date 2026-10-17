import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({ Authorization: 'Bearer test-token' }),
}));

import {
  createSseParser,
  isMissionEvent,
  missionEventsPath,
  openMissionStream,
  reconnectDelay,
  type SseMessage,
  type StreamStatus,
} from '../../../src/client/nemodots/mission-stream';
import { ev, ids, payload } from './helpers';

const encoder = new TextEncoder();

function sse(event: ReturnType<typeof ev>): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A Response whose body emits the given chunks, then ends or stays open. */
function streamResponse(chunks: string[], options: { end?: boolean } = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.end ?? true) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const initOf = (mock: { mock: { calls: unknown[][] } }, call: number) =>
  mock.mock.calls[call][1] as RequestInit;

describe('createSseParser', () => {
  const collect = (chunks: string[]) => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    for (const chunk of chunks) parser.push(chunk);
    return messages;
  };

  it('joins multi-line data with newlines and strips one leading space', () => {
    const [message] = collect(['id: 7\nevent: x\ndata: {"a":\ndata:  1}\n\n']);
    expect(message).toMatchObject({ id: '7', event: 'x', data: '{"a":\n 1}' });
  });

  it('handles CRLF split across chunks, comments and unterminated tails', () => {
    const messages = collect([
      ': keep-alive\r\n',
      'data: one\r',
      '\n\r\ndata: tw',
      'o\n\n',
      'data: never-terminated',
    ]);
    expect(messages.map((m) => m.data)).toEqual(['one', 'two']);
  });

  it('ignores events without data and invalid retry values', () => {
    expect(collect(['event: ping\n\n', 'retry: soon\ndata: x\n\n'])).toEqual([
      { id: null, event: 'message', data: 'x', retry: null },
    ]);
  });
});

describe('isMissionEvent', () => {
  it('accepts a valid event and rejects shape violations', () => {
    const event = ev(1, payload('task.created'));
    expect(isMissionEvent(event)).toBe(true);
    expect(isMissionEvent({ ...event, id: 0 })).toBe(false);
    expect(isMissionEvent({ ...event, kind: 'heartbeat' })).toBe(false);
    expect(isMissionEvent({ ...event, payload: null })).toBe(false);
    expect(isMissionEvent(null)).toBe(false);
  });
});

describe('reconnectDelay', () => {
  it('grows exponentially, is capped, and stays within the jitter band', () => {
    expect(reconnectDelay(0, 1000, 30000, () => 0)).toBe(500);
    expect(reconnectDelay(0, 1000, 30000, () => 0.999)).toBe(1000);
    expect(reconnectDelay(3, 1000, 30000, () => 0)).toBe(4000);
    expect(reconnectDelay(10, 1000, 30000, () => 0)).toBe(15000);
    expect(reconnectDelay(10, 1000, 30000, () => 0.999)).toBeLessThanOrEqual(
      30000,
    );
  });
});

describe('openMissionStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never puts the token in the URL and sends auth headers', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([], { end: false }));
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: () => {},
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    const url = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url[0]).toBe(missionEventsPath(ids.mission));
    expect(url[0]).not.toContain('test-token');
    expect(url[0]).not.toContain('?');
    const init = initOf(fetchImpl, 0);
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      Accept: 'text/event-stream',
    });
    expect(init.headers).not.toHaveProperty('Last-Event-ID');
    handle.close();
  });

  it('parses multi-line SSE from a mocked body split mid-event', async () => {
    const first = ev(1, payload('task.created'));
    const second = ev(2, payload('task.status', { to: 'running' }));
    const text = sse(first) + sse(second);
    const cut = Math.floor(text.length / 3);
    const fetchImpl = vi.fn(async () =>
      streamResponse([text.slice(0, cut), text.slice(cut), ': hb\n\n'], {
        end: false,
      }),
    );
    const received: number[] = [];
    const statuses: StreamStatus[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: (e) => received.push(e.id),
      onStatus: (s) => statuses.push(s),
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([1, 2]);
    expect(handle.lastEventId()).toBe(2);
    expect(statuses).toEqual(['connecting', 'open']);
    handle.close();
  });

  it('reassembles pretty-printed JSON spread over several data lines', async () => {
    const event = ev(3, payload('task.created'));
    const lines = JSON.stringify(event, null, 1)
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n');
    const fetchImpl = vi.fn(async () =>
      streamResponse([`id: 3\n${lines}\n\n`], { end: false }),
    );
    const received: number[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: (e) => received.push(e.id),
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([3]);
    handle.close();
  });

  it('reconnects with a jittered delay and Last-Event-ID, then stops on close', async () => {
    const e1 = ev(1, payload('task.created'));
    const e2 = ev(5, payload('task.status', { to: 'running' }));
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => streamResponse([sse(e1), sse(e2)]))
      .mockImplementationOnce(async () => streamResponse([], { end: false }));
    const statuses: StreamStatus[] = [];
    const received: number[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: (e) => received.push(e.id),
      onStatus: (s) => statuses.push(s),
      fetchImpl,
      random: () => 0,
      baseDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = initOf(fetchImpl, 1);
    expect(init.headers).toMatchObject({ 'Last-Event-ID': '5' });
    expect(received).toEqual([1, 5]);
    expect(statuses.at(-1)).toBe('open');
    handle.close();
    expect(statuses.at(-1)).toBe('closed');
    expect((init.signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resumes from the lastEventId option', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([], { end: false }));
    const handle = openMissionStream({
      missionId: ids.mission,
      lastEventId: 17,
      onEvent: () => {},
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(initOf(fetchImpl, 0).headers).toMatchObject({
      'Last-Event-ID': '17',
    });
    handle.close();
  });

  it('close() during the reconnect wait cancels the retry', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([]));
    const statuses: StreamStatus[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      fetchImpl,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('reconnecting');
    handle.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statuses.filter((s) => s === 'closed')).toHaveLength(1);
  });

  it('aborts an in-flight read on close()', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const statuses: StreamStatus[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toBe('open');
    handle.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('retries 5xx with backoff but stops on a non-retryable status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const statuses: StreamStatus[] = [];
    const errors: string[] = [];
    openMissionStream({
      missionId: ids.mission,
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e.message),
      fetchImpl,
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['connecting', 'reconnecting']);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('closed');
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([
      'Event stream failed (503).',
      'Event stream failed (401).',
    ]);
  });

  it('skips malformed events without dropping the stream', async () => {
    const good = ev(2, payload('task.created'));
    const fetchImpl = vi.fn(async () =>
      streamResponse(['data: {not json\n\n', 'data: {"id":1}\n\n', sse(good)], {
        end: false,
      }),
    );
    const received: number[] = [];
    const errors: string[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: (e) => received.push(e.id),
      onError: (e) => errors.push(e.message),
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([2]);
    expect(errors).toHaveLength(2);
    handle.close();
  });

  it('treats a 200 with a non-SSE content type as a failure with growing backoff', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>spa</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const statuses: StreamStatus[] = [];
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: () => undefined,
      onStatus: (s) => statuses.push(s),
      onError: () => undefined,
      fetchImpl,
      random: () => 0,
      baseDelayMs: 500,
      maxDelayMs: 30000,
    });
    await vi.advanceTimersByTimeAsync(60000);
    // delays 250, 500, 1000, ... capped at 15000: far fewer than the 121 fetches of a flat 500 ms loop
    expect(fetchImpl.mock.calls.length).toBeLessThan(15);
    expect(statuses).not.toContain('open');
    handle.close();
  });

  it('keeps growing the backoff when a stream sends bytes but no valid event', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([': keep-alive\n\n', 'data: not json\n\n']),
    );
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: () => undefined,
      onError: () => undefined,
      fetchImpl,
      random: () => 0,
      baseDelayMs: 500,
      maxDelayMs: 30000,
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchImpl.mock.calls.length).toBeLessThan(15);
    handle.close();
  });

  it('resets the backoff after a valid event', async () => {
    const e1 = ev(1, payload('task.created'));
    const fetchImpl = vi.fn(async () => streamResponse([sse(e1)]));
    const handle = openMissionStream({
      missionId: ids.mission,
      onEvent: () => undefined,
      fetchImpl,
      random: () => 0,
      baseDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(5000);
    // every connection delivered a valid event, so the delay stays at the 500 ms floor
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(9);
    handle.close();
  });

  it('rejects an unknown event kind in the structural guard', () => {
    const raw = {
      id: 5,
      missionId: ids.mission,
      kind: 'agent.spawned',
      at: new Date().toISOString(),
      payload: { kind: 'agent.spawned' },
    };
    expect(isMissionEvent(raw)).toBe(false);
  });
});
