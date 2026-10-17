import { describe, expect, it } from 'vitest';
import {
  configuredSecrets,
  findRedactionViolation,
} from '../../../src/server/nemodots/telemetry/export.js';
import {
  TelemetryError,
  recordToolSpan,
} from '../../../src/server/nemodots/telemetry/spans.js';

describe('findRedactionViolation', () => {
  it('passes clean telemetry lines', () => {
    const line = JSON.stringify({
      type: 'inference_attempt',
      modelRequested: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      providerHost: 'api.inference.crusoecloud.com',
      usage: { promptTokens: 12, cachedTokens: null },
    });
    expect(findRedactionViolation(line, ['abcd1234efgh5678'])).toBeNull();
  });
  it('flags sk- keys, bearer tokens and secret-shaped values without returning them', () => {
    expect(findRedactionViolation('x sk-abcdefghijklmnopqrstuv')).toBe(
      'sk- prefix',
    );
    expect(findRedactionViolation('authorization: Bearer abc')).toBe(
      'Bearer token',
    );
    expect(findRedactionViolation('postgres://u:p@h:5432/db')).toBe(
      'secret-shaped value',
    );
  });
  it('flags a configured secret and its 8-character prefix', () => {
    const secret = 'zz9-test-secret-value-1234';
    expect(findRedactionViolation(`a ${secret} b`, [secret])).toBe(
      'configured secret',
    );
    expect(findRedactionViolation('a zz9-test- b', [secret])).toBe(
      'configured secret prefix',
    );
  });
  it('reads secrets from the named environment variables only, ignoring short values', () => {
    expect(
      configuredSecrets({
        OPENAI_API_KEY: 'longenoughvalue',
        CRUSOE_API_KEY: 'short',
        OTHER: 'longenoughvalue2',
      }),
    ).toEqual(['longenoughvalue']);
  });
});

describe('recordToolSpan validation', () => {
  const client = {
    query: async () => {
      throw new Error('must not reach the database');
    },
  };
  const base = {
    missionId: '2f6c1b0e-2a9d-4c6b-8f0e-1b2a3c4d5e6f',
    toolName: 'observe_source',
    startedAt: '2026-10-17T10:00:00.000Z',
    finishedAt: '2026-10-17T10:00:01.000Z',
    outcome: 'ok' as const,
  };
  it('rejects bad names, digests and reversed times before touching the database', async () => {
    await expect(
      recordToolSpan(client, { ...base, toolName: 'bad name' }),
    ).rejects.toThrow(TelemetryError);
    await expect(
      recordToolSpan(client, { ...base, argsDigest: 'abc' }),
    ).rejects.toThrow(TelemetryError);
    await expect(
      recordToolSpan(client, {
        ...base,
        finishedAt: '2026-10-17T09:59:59.000Z',
      }),
    ).rejects.toThrow(/precedes/);
    await expect(
      recordToolSpan(client, { ...base, outcome: 'weird' as never }),
    ).rejects.toThrow(TelemetryError);
  });
});
