import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  createHealth,
  fetchCheckoutHealth,
  providerHost,
} from '../../../src/server/nemodots/routes/health.js';
import { HealthStatusSchema } from '../../../src/server/nemodots/contracts/index.js';

const okPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const downPool = {
  query: async () => {
    throw new Error('postgres://user:pw@127.0.0.1:55432/db refused');
  },
} as unknown as pg.Pool;

const liveEnv = {
  OPENAI_API_KEY: 'sk-live-key-value-0000',
  OPENAI_BASE_URL: 'https://inference.example.test/v1',
  OPENAI_MODEL: 'nvidia/test-model',
};

const base = {
  now: () => new Date('2026-10-17T12:00:00.000Z'),
  probeTimeoutMs: 200,
  providerTtlMs: 10_000,
  intelligenceConfigured: () => false,
  incidentDotIds: () => 2,
  checkout: null,
};

describe('health', () => {
  it('blocked: names the missing env, reports the host when the base URL parses, never values', async () => {
    const health = createHealth({
      ...base,
      pool: okPool,
      env: { OPENAI_API_KEY: liveEnv.OPENAI_API_KEY },
    });
    const status = await health();
    expect(HealthStatusSchema.parse(status)).toEqual(status);
    expect(status.mode).toBe('blocked');
    expect(status.missingEnv).toEqual(['OPENAI_BASE_URL', 'OPENAI_MODEL']);
    expect(status.provider.host).toBeNull();
    expect(JSON.stringify(status)).not.toContain(liveEnv.OPENAI_API_KEY);
    expect(status.incidentDotIds).toBe(2);
    expect(status.intelligence).toBe('blocked');
  });

  it('live: lists models once within the TTL and reports host and modelListed', async () => {
    let calls = 0;
    const health = createHealth({
      ...base,
      pool: okPool,
      env: liveEnv,
      listModels: async () => {
        calls += 1;
        return ['nvidia/test-model'];
      },
      pingRedis: async () => true,
    });
    const first = await health();
    await health();
    expect(calls).toBe(1);
    expect(first).toMatchObject({
      mode: 'live',
      missingEnv: [],
      postgres: 'ok',
      redis: 'ok',
      provider: {
        reachable: true,
        modelListed: true,
        model: 'nvidia/test-model',
        host: 'inference.example.test',
        checkedAt: '2026-10-17T12:00:00.000Z',
      },
    });
    expect(JSON.stringify(first)).not.toContain(liveEnv.OPENAI_API_KEY);
  });

  it('live: provider failure and a hung probe degrade to unreachable instead of throwing', async () => {
    const failing = createHealth({
      ...base,
      pool: downPool,
      env: liveEnv,
      listModels: async () => {
        throw new Error('boom');
      },
      pingRedis: () => new Promise(() => {}),
    });
    const status = await failing();
    expect(status.provider).toMatchObject({
      reachable: false,
      modelListed: false,
    });
    expect(status.postgres).toBe('down');
    expect(status.redis).toBe('down');
    expect(JSON.stringify(status)).not.toContain('postgres://');
  });

  it('providerHost ignores credentials and malformed URLs', () => {
    expect(
      providerHost({ OPENAI_BASE_URL: 'https://u:p@api.example.test:8443/v1' }),
    ).toBe('api.example.test:8443');
    expect(providerHost({ OPENAI_BASE_URL: 'not a url' })).toBeNull();
    expect(providerHost({})).toBeNull();
  });
});

describe('fetchCheckoutHealth', () => {
  const at = new Date('2026-10-17T12:00:00.000Z');
  const reply = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

  it('maps the 503 degraded body to the DTO', async () => {
    const result = await fetchCheckoutHealth(
      {
        baseUrl: 'http://127.0.0.1:4510',
        fetch: reply(503, {
          status: 'degraded',
          checks: {
            postgres: true,
            redis: true,
            config_parse: true,
            writes: false,
            cache: true,
            pool: true,
          },
          errors: ['writes_disabled'],
        }),
      },
      500,
      at,
    );
    expect(result).toEqual({
      status: 'degraded',
      postgres: true,
      redis: true,
      config_parse: true,
      writes: false,
      errorClasses: ['writes_disabled'],
      sampledAt: '2026-10-17T12:00:00.000Z',
    });
  });

  it('returns null for unreachable, malformed or unknown-status responses', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(
      await fetchCheckoutHealth({ baseUrl: 'http://x', fetch: down }, 500, at),
    ).toBeNull();
    expect(
      await fetchCheckoutHealth(
        { baseUrl: 'http://x', fetch: reply(200, { hello: 1 }) },
        500,
        at,
      ),
    ).toBeNull();
    expect(
      await fetchCheckoutHealth(
        {
          baseUrl: 'http://x',
          fetch: reply(200, { status: 'weird', checks: {}, errors: [] }),
        },
        500,
        at,
      ),
    ).toBeNull();
  });
});
