import { describe, expect, it } from 'vitest';
import {
  parseErrorEnvelope,
  parseRetryAfter,
  classifyStatus,
} from '../../../src/server/nemodots/inference/errors.js';
import { SseParser } from '../../../src/server/nemodots/inference/sse.js';
import {
  Semaphore,
  backoffMs,
} from '../../../src/server/nemodots/inference/throttle.js';
import { validateStrictOutput } from '../../../src/server/nemodots/inference/request.js';

describe('SseParser', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('handles CRLF, comments, multi-line data and a missing final blank line', () => {
    const p = new SseParser();
    expect(
      p.push(
        enc(
          ': keepalive\r\ndata: {"a":1}\r\n\r\ndata: x\r\ndata: y\r\n\r\ndata: [DONE]',
        ),
      ),
    ).toEqual(['{"a":1}', 'x\ny']);
    expect(p.end()).toEqual(['[DONE]']);
  });
  it('is invariant to every possible two-way split of the bytes', () => {
    const text = 'data: {"c":"héllo ✓"}\r\n\r\ndata: [DONE]\n\n';
    const bytes = enc(text);
    for (let i = 0; i <= bytes.length; i++) {
      const p = new SseParser();
      const got = [
        ...p.push(bytes.subarray(0, i)),
        ...p.push(bytes.subarray(i)),
        ...p.end(),
      ];
      expect(got).toEqual(['{"c":"héllo ✓"}', '[DONE]']);
    }
  });
  it('a CR split from its LF across chunks does not create an extra event', () => {
    const p = new SseParser();
    const got = [
      ...p.push(enc('data: a\r')),
      ...p.push(enc('\n\r')),
      ...p.push(enc('\ndata: b\r\n\r\n')),
      ...p.end(),
    ];
    expect(got).toEqual(['a', 'b']);
  });
});

describe('error envelopes', () => {
  it('parses Crusoe and OpenAI shapes', () => {
    expect(
      parseErrorEnvelope(
        '{"code":"model_not_found","message":"m","error_id":"id1"}',
      ),
    ).toEqual({ code: 'model_not_found', errorId: 'id1' });
    expect(
      parseErrorEnvelope({
        error: { message: 'm', type: 't', code: 'c', error_id: 'i' },
      }),
    ).toEqual({ code: 'c', errorId: 'i' });
    expect(parseErrorEnvelope({ error: { type: 'server_error' } })).toEqual({
      code: 'server_error',
      errorId: null,
    });
    expect(parseErrorEnvelope('<html>')).toEqual({ code: null, errorId: null });
    expect(parseErrorEnvelope(null)).toEqual({ code: null, errorId: null });
  });
  it('classifies statuses', () => {
    expect(
      [429, 503, 502, 504, 408, 500, 404, 401, 400].map(classifyStatus),
    ).toEqual([
      'rate_limited',
      'provider_unavailable',
      'provider_unavailable',
      'timeout',
      'timeout',
      'provider_error',
      'provider_error',
      'provider_error',
      'provider_error',
    ]);
  });
  it('parses retry-after seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('backoff and semaphore', () => {
  it('jittered exponential from 1s, capped at 30s', () => {
    const lo = [1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, { random: () => 0 }));
    const hi = [1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, { random: () => 1 }));
    expect(lo).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(hi).toEqual([1250, 2500, 5000, 10000, 20000, 30000]);
  });
  it('queues beyond the limit in FIFO order and supports abort while queued', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const order: number[] = [];
    const p2 = s.acquire().then((r) => (order.push(2), r));
    const controller = new AbortController();
    const p3 = s.acquire(controller.signal).catch(() => order.push(-3));
    const p4 = s.acquire().then((r) => (order.push(4), r));
    controller.abort();
    await p3;
    r1();
    (await p2)();
    (await p4)();
    expect(order).toEqual([-3, 2, 4]);
    expect(s.inFlight).toBe(0);
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
  it('release is idempotent', async () => {
    const s = new Semaphore(1);
    const r = await s.acquire();
    r();
    r();
    expect(s.inFlight).toBe(0);
  });
});

describe('strict output validation', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'integer' } },
    required: ['a'],
    additionalProperties: false,
  };
  it('accepts and rejects', () => {
    expect(validateStrictOutput(schema, '{"a":1}')).toMatchObject({
      ok: true,
      value: { a: 1 },
    });
    expect(validateStrictOutput(schema, '{"a":"1"}').ok).toBe(false);
    expect(validateStrictOutput(schema, null).ok).toBe(false);
    expect(validateStrictOutput(schema, '{"a":1,"b":2}').ok).toBe(false);
  });
});
