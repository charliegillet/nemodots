import { describe, expect, it, vi } from 'vitest';
import {
  METRICS_TOKEN_ENV,
  METRICS_URL_ENV,
  TelemetryRedactionError,
  assertRedacted,
  pushSummary,
  resolveMetricsBridge,
  summarizeAttempts,
  ToolSpanSchema,
} from '../../../src/server/nemodots/telemetry/index.js';

describe('assertRedacted', () => {
  it('passes plain telemetry lines', () => {
    expect(() =>
      assertRedacted(
        JSON.stringify({
          kind: 'inference_attempt',
          usage: { promptTokens: 4 },
        }),
        ['super-secret-value'],
      ),
    ).not.toThrow();
  });

  it.each([
    ['sk- key', 'x sk-abcdefghijkl y'],
    ['bearer token', 'Authorization: Bearer abcdefgh12345678'],
    ['authorization header', '{"authorization":"Basic dXNlcjpwYXNz"}'],
    ['connection string', 'url postgres://user:pw@127.0.0.1:55442/db'],
    ['private key', '-----BEGIN PRIVATE KEY-----'],
  ])('refuses a %s', (_name, text) => {
    expect(() => assertRedacted(text)).toThrow(TelemetryRedactionError);
  });

  it('refuses a configured literal secret and ignores empty or short ones', () => {
    expect(() =>
      assertRedacted('value=abc123456789', ['abc123456789']),
    ).toThrow(TelemetryRedactionError);
    expect(() =>
      assertRedacted('value=abc', ['abc', '', undefined]),
    ).not.toThrow();
  });
});

describe('metrics bridge keeps its token separate from the inference key', () => {
  const summary = summarizeAttempts([]);
  const env = {
    [METRICS_URL_ENV]: 'https://metrics.example/ingest',
    [METRICS_TOKEN_ENV]: 'metrics-token-1',
    OPENAI_API_KEY: 'inference-key-1',
  };

  it('is disabled, never falling back to the inference key, when its own settings are missing', () => {
    expect(resolveMetricsBridge({ OPENAI_API_KEY: 'inference-key-1' })).toEqual(
      {
        enabled: false,
        reason: `${METRICS_URL_ENV} is not set`,
      },
    );
    expect(
      resolveMetricsBridge({
        [METRICS_URL_ENV]: 'https://metrics.example/x',
        OPENAI_API_KEY: 'inference-key-1',
        CRUSOE_API_KEY: 'inference-key-2',
      }),
    ).toEqual({ enabled: false, reason: `${METRICS_TOKEN_ENV} is not set` });
  });

  it.each(['OPENAI_API_KEY', 'CRUSOE_API_KEY'])(
    'refuses a metrics token equal to %s',
    (name) => {
      const config = resolveMetricsBridge({
        [METRICS_URL_ENV]: 'https://metrics.example/x',
        [METRICS_TOKEN_ENV]: 'same-value-1',
        [name]: 'same-value-1',
      });
      expect(config).toEqual({
        enabled: false,
        reason: `${METRICS_TOKEN_ENV} must differ from ${name}`,
      });
    },
  );

  it('rejects unsafe URLs', () => {
    for (const url of ['ftp://m.example/x', 'https://u:p@m.example/x', 'nope'])
      expect(
        resolveMetricsBridge({
          [METRICS_URL_ENV]: url,
          [METRICS_TOKEN_ENV]: 't-123456',
        }).enabled,
      ).toBe(false);
  });

  it('sends only the summary with the metrics token, never the inference key', async () => {
    const config = resolveMetricsBridge(env);
    expect(config.enabled).toBe(true);
    const send = vi.fn(async () => new Response('ok'));
    const result = await pushSummary(config, summary, { fetch: send as never });
    expect(result).toEqual({ sent: true, reason: null });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://metrics.example/ingest');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer metrics-token-1',
    );
    expect(JSON.stringify(init)).not.toContain('inference-key-1');
  });

  it('reports failures without throwing and does nothing when disabled', async () => {
    const config = resolveMetricsBridge(env);
    expect(
      await pushSummary(config, summary, {
        fetch: (async () => new Response('no', { status: 503 })) as never,
      }),
    ).toEqual({ sent: false, reason: 'metrics endpoint answered HTTP 503' });
    expect(
      await pushSummary(config, summary, {
        fetch: (async () => {
          throw new Error('down');
        }) as never,
      }),
    ).toEqual({ sent: false, reason: 'metrics endpoint could not be reached' });
    const disabled = resolveMetricsBridge({});
    const send = vi.fn();
    expect(
      (await pushSummary(disabled, summary, { fetch: send as never })).sent,
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ToolSpanSchema', () => {
  const base = {
    missionId: '7d3b1f0e-1111-4a3b-8c5d-0a1b2c3d4e5f',
    taskId: '7d3b1f0e-2222-4a3b-8c5d-0a1b2c3d4e5f',
    attemptId: '7d3b1f0e-3333-4a3b-8c5d-0a1b2c3d4e5f',
    toolCallId: 'call_1',
    toolName: 'observe_source',
    startedAt: '2026-10-18T10:00:00.000Z',
    finishedAt: '2026-10-18T10:00:01.000Z',
    outcome: 'ok' as const,
    argumentsDigest: 'a'.repeat(64),
  };
  it('accepts digests and rejects values, bad order and unknown fields', () => {
    expect(ToolSpanSchema.parse(base)).toMatchObject({ resultDigest: null });
    expect(() =>
      ToolSpanSchema.parse({ ...base, argumentsDigest: '{"a":1}' }),
    ).toThrow();
    expect(() =>
      ToolSpanSchema.parse({ ...base, finishedAt: '2026-10-18T09:00:00.000Z' }),
    ).toThrow();
    expect(() =>
      ToolSpanSchema.parse({ ...base, arguments: { a: 1 } }),
    ).toThrow();
  });
});
