import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NemoDotsEnvError,
  assertSafePgUrl,
  liveRequirements,
  parseNemoDotsEnv,
  pgUrl,
  resolveInference,
} from '../../../src/server/nemodots/config/env.js';

const SECRET = 'not-a-real-password-7f3a';
const url = (role: string, port = 55432) =>
  `postgres://nemodots_${role}:${SECRET}@127.0.0.1:${port}/nemodots`;

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error as NemoDotsEnvError;
  }
  throw new Error('expected an error');
}

describe('parseNemoDotsEnv', () => {
  it('applies the documented defaults', () => {
    const config = parseNemoDotsEnv({});
    expect(config.instance).toBe('dev');
    expect(config.pg).toEqual({
      host: '127.0.0.1',
      port: 55432,
      database: 'nemodots',
      urls: {},
    });
    expect(config.redis).toEqual({
      url: 'redis://127.0.0.1:56379/0',
      prefix: 'nemodots:dev',
    });
    expect(config.checkout).toEqual({
      port: 4510,
      url: 'http://127.0.0.1:4510',
    });
    expect(config.inference).toMatchObject({
      requestedMode: 'live',
      maxInFlight: 4,
    });
    expect(config).toMatchObject({
      leaseMs: 30_000,
      dispatchLeaseMs: 30_000,
      maxTasks: 24,
      maxDepth: 3,
      watchIntervalMs: 2_000,
      workers: 2,
      incidentDotIds: [],
      testHooks: [],
    });
  });

  it('selects per-role URLs and names the variable when one is missing', () => {
    const config = parseNemoDotsEnv({
      NEMODOTS_PG_URL_APP: url('app'),
      NEMODOTS_PG_URL_CHECKOUT: url('checkout'),
    });
    expect(pgUrl(config, 'app')).toBe(url('app'));
    expect(pgUrl(config, 'checkout')).toBe(url('checkout'));
    const error = errorOf(() => pgUrl(config, 'verifier'));
    expect(error).toBeInstanceOf(NemoDotsEnvError);
    expect(error.names).toEqual(['NEMODOTS_PG_URL_VERIFIER']);
  });

  it.each([
    ['NEMODOTS_PG_PORT', { NEMODOTS_PG_PORT: '5432' }],
    ['NEMODOTS_PG_PORT', { NEMODOTS_PG_PORT: '6379' }],
    ['NEMODOTS_REDIS_PORT', { NEMODOTS_REDIS_PORT: '6379' }],
    ['NEMODOTS_CHECKOUT_PORT', { NEMODOTS_CHECKOUT_PORT: '5432' }],
    [
      'NEMODOTS_PG_URL_APP',
      { NEMODOTS_PG_PORT: '55432', NEMODOTS_PG_URL_APP: url('app', 5432) },
    ],
    [
      // no port in the URL means the 5432 default: refused
      'NEMODOTS_PG_URL_ADMIN',
      {
        NEMODOTS_PG_URL_ADMIN: `postgres://nemodots_admin:${SECRET}@127.0.0.1/nemodots`,
      },
    ],
    ['NEMODOTS_REDIS_URL', { NEMODOTS_REDIS_URL: 'redis://127.0.0.1:6379/0' }],
    ['NEMODOTS_REDIS_URL', { NEMODOTS_REDIS_URL: 'redis://127.0.0.1/0' }],
  ])('refuses the user-owned ports via %s', (name, env) => {
    const error = errorOf(() => parseNemoDotsEnv(env));
    expect(error).toBeInstanceOf(NemoDotsEnvError);
    expect(error.names).toContain(name);
    expect(error.message).not.toContain(SECRET);
  });

  it('rejects a role URL that does not use the instance port, without echoing it', () => {
    const error = errorOf(() =>
      parseNemoDotsEnv({
        NEMODOTS_PG_PORT: '55432',
        NEMODOTS_PG_URL_APP: url('app', 55433),
      }),
    );
    expect(error.names).toEqual(['NEMODOTS_PG_URL_APP', 'NEMODOTS_PG_PORT']);
    expect(error.message).not.toContain(SECRET);
  });

  it('parses exactly the checkout child environment on a non-default PostgreSQL port', () => {
    // The name set stack.mjs checkoutEnv() hands the checkout API (finding I3):
    // no NEMODOTS_PG_PORT.
    const config = parseNemoDotsEnv({
      NEMODOTS_PG_URL_CHECKOUT: url('checkout', 55433),
      NEMODOTS_REDIS_URL: 'redis://127.0.0.1:56380/0',
      NEMODOTS_REDIS_PREFIX: 'nemodots:ci-b',
      NEMODOTS_CHECKOUT_PORT: '4511',
      NEMODOTS_PROBE_SECRET: 's',
      LC_ALL: 'C',
      PATH: '/usr/bin',
    });
    expect(config.pg.port).toBe(55433);
    expect(pgUrl(config, 'checkout')).toBe(url('checkout', 55433));
  });

  it('requires role URLs to agree on the port when NEMODOTS_PG_PORT is unset', () => {
    const error = errorOf(() =>
      parseNemoDotsEnv({
        NEMODOTS_PG_URL_APP: url('app', 55433),
        NEMODOTS_PG_URL_ADMIN: url('admin', 55434),
      }),
    );
    expect(error.names).toEqual([
      'NEMODOTS_PG_URL_APP',
      'NEMODOTS_PG_URL_ADMIN',
    ]);
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    '?port=5432',
    '?host=localhost&port=5432',
    '?hostaddr=127.0.0.1',
    '?HOST=/var/run/postgresql',
    '?service=mine',
  ])('refuses overriding query parameters %s', (query) => {
    const value = `postgres://nemodots_app:${SECRET}@127.0.0.1:55432/nemodots${query}`;
    expect(() => assertSafePgUrl('NEMODOTS_PG_URL_APP', value)).toThrow(
      NemoDotsEnvError,
    );
    const error = errorOf(() =>
      parseNemoDotsEnv({ NEMODOTS_PG_URL_APP: value }),
    );
    expect(error.names).toEqual(['NEMODOTS_PG_URL_APP']);
    expect(error.message).not.toContain(SECRET);
  });

  it('allows harmless query parameters', () => {
    expect(
      assertSafePgUrl(
        'X',
        `postgres://u:${SECRET}@127.0.0.1:55432/nemodots?sslmode=disable`,
      ).port,
    ).toBe(55432);
  });

  it('rejects malformed values by name', () => {
    expect(
      errorOf(() => parseNemoDotsEnv({ NEMODOTS_MAX_DEPTH: 'deep' })).names,
    ).toEqual(['NEMODOTS_MAX_DEPTH']);
    expect(
      errorOf(() => parseNemoDotsEnv({ NEMODOTS_INSTANCE: '../etc' })).names,
    ).toEqual(['NEMODOTS_INSTANCE']);
    expect(
      errorOf(() => parseNemoDotsEnv({ NEMODOTS_INFERENCE_MODE: 'openai' }))
        .names,
    ).toEqual(['NEMODOTS_INFERENCE_MODE']);
    expect(
      errorOf(() =>
        parseNemoDotsEnv({ NEMODOTS_INFERENCE_MAX_IN_FLIGHT: '16' }),
      ).names,
    ).toEqual(['NEMODOTS_INFERENCE_MAX_IN_FLIGHT']);
  });

  it('parses comma lists', () => {
    const config = parseNemoDotsEnv({
      NEMODOTS_INCIDENT_DOT_IDS: ' dot-a, ,dot-b ',
    });
    expect(config.incidentDotIds).toEqual(['dot-a', 'dot-b']);
  });
});

describe('liveRequirements (finding I1)', () => {
  it('reports OPENAI_BASE_URL missing when only the key and model are set', () => {
    expect(
      liveRequirements({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }).missingEnv,
    ).toEqual(['OPENAI_BASE_URL']);
  });

  it('treats empty values as missing and lists every missing name in order', () => {
    expect(
      liveRequirements({ OPENAI_API_KEY: ' ', OPENAI_BASE_URL: '' }),
    ).toEqual({
      satisfied: false,
      missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
      invalidEnv: [],
    });
  });

  it('flags a malformed base URL as invalid rather than guessing a host', () => {
    expect(
      liveRequirements({
        OPENAI_API_KEY: 'k',
        OPENAI_BASE_URL: 'api.inference.crusoecloud.com',
        OPENAI_MODEL: 'm',
      }),
    ).toEqual({
      satisfied: false,
      missingEnv: [],
      invalidEnv: ['OPENAI_BASE_URL'],
    });
  });
});

describe('resolveInference', () => {
  const live = {
    OPENAI_API_KEY: 'k',
    OPENAI_BASE_URL: 'https://api.inference.crusoecloud.com/v1',
    OPENAI_MODEL: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  };

  it('is blocked, never defaulted, when the base URL is absent', () => {
    const resolved = resolveInference({
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'm',
    });
    expect(resolved).toEqual({
      mode: 'blocked',
      missingEnv: ['OPENAI_BASE_URL'],
      invalidEnv: [],
      reason: 'missing_env',
    });
    expect(JSON.stringify(resolved)).not.toContain('openai.com');
  });

  it('resolves live with the configured host and per-role model defaults', () => {
    expect(resolveInference(live)).toEqual({
      mode: 'live',
      missingEnv: [],
      provider: {
        baseUrl: live.OPENAI_BASE_URL,
        host: 'api.inference.crusoecloud.com',
        model: live.OPENAI_MODEL,
        plannerModel: live.OPENAI_MODEL,
        workerModel: live.OPENAI_MODEL,
      },
    });
  });

  it('requires a fixture path in fixture mode and honours an explicit block', () => {
    expect(resolveInference({ NEMODOTS_INFERENCE_MODE: 'fixture' })).toEqual({
      mode: 'blocked',
      missingEnv: ['NEMODOTS_FIXTURE_PATH'],
      invalidEnv: [],
      reason: 'missing_env',
    });
    expect(
      resolveInference({
        NEMODOTS_INFERENCE_MODE: 'fixture',
        NEMODOTS_FIXTURE_PATH: 'evals/x.jsonl',
      }),
    ).toEqual({
      mode: 'fixture',
      missingEnv: [],
      fixturePath: 'evals/x.jsonl',
    });
    expect(
      resolveInference({ ...live, NEMODOTS_INFERENCE_MODE: 'blocked' }),
    ).toMatchObject({ mode: 'blocked', reason: 'requested', missingEnv: [] });
  });
});

describe('.env.example (finding I1)', () => {
  it('never resolves live inference to a non-Crusoe host', () => {
    const values: Record<string, string> = {};
    for (const line of readFileSync('.env.example', 'utf8').split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (match) values[match[1]!] = match[2]!;
    }
    const resolved = resolveInference({
      ...values,
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'm',
      NEMODOTS_INFERENCE_MODE: 'live',
    });
    if (resolved.mode === 'live')
      expect(resolved.provider.host).toMatch(/crusoecloud\.com$/);
    else expect(resolved.missingEnv).toEqual(['OPENAI_BASE_URL']);
  });
});
