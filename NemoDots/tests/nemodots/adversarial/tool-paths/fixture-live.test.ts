// W5.3: provider selection for the NemoDots team (I1) and fixture honesty.
// No silent fallback provider: a missing or unusable OPENAI_BASE_URL is
// BLOCKED and nothing is fetched; fixture output is stamped fixture even when
// the fixture file claims the Crusoe host; a fixture miss never improvises.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInferenceFromEnv,
  FIXTURE_FORMAT,
  FixtureInference,
  fixtureKey,
  InferenceBlockedError,
  parseFixtureFile,
  resolveMode,
} from '../../../../src/server/nemodots/inference/index.js';
import type { ChatRequest } from '../../../../src/server/nemodots/contracts/index.js';

afterEach(() => vi.restoreAllMocks());

const LIVE = {
  OPENAI_API_KEY: 'adversary-key-0123456789',
  OPENAI_MODEL: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
};

describe('I1: no base URL, no provider', () => {
  it.each([
    ['unset', undefined, 'missing'],
    ['empty', '', 'missing'],
    ['whitespace', '   ', 'missing'],
    ['not a URL', 'api.inference.crusoecloud.com/v1', 'invalid'],
    ['ftp scheme', 'ftp://api.inference.crusoecloud.com/v1', 'invalid'],
    ['javascript scheme', 'javascript:alert(1)', 'invalid'],
    ['file scheme', 'file:///etc/passwd', 'invalid'],
  ])(
    'TP-50 OPENAI_BASE_URL %s -> blocked, adapter refused, nothing fetched',
    (_l, value, kind) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const env = { ...LIVE, OPENAI_BASE_URL: value };
      const mode = resolveMode(env);
      expect(mode.mode).toBe('blocked');
      if (mode.mode === 'blocked')
        expect(kind === 'missing' ? mode.missingEnv : mode.invalidEnv).toEqual([
          'OPENAI_BASE_URL',
        ]);
      expect(() => createInferenceFromEnv(env)).toThrow(InferenceBlockedError);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['Live', 'openai', 'LIVE', 'fallback'])(
    'TP-50b NEMODOTS_INFERENCE_MODE=%j is rejected, never read as live',
    (value) => {
      expect(() =>
        resolveMode({
          ...LIVE,
          OPENAI_BASE_URL: 'https://api.inference.crusoecloud.com/v1',
          NEMODOTS_INFERENCE_MODE: value,
        }),
      ).toThrow();
    },
  );

  it('TP-50c fixture mode without NEMODOTS_FIXTURE_PATH is blocked, not live', () => {
    const mode = resolveMode({
      ...LIVE,
      OPENAI_BASE_URL: 'https://api.inference.crusoecloud.com/v1',
      NEMODOTS_INFERENCE_MODE: 'fixture',
    });
    expect(mode).toMatchObject({
      mode: 'blocked',
      missingEnv: ['NEMODOTS_FIXTURE_PATH'],
    });
  });
});

describe('fixture output is never presented as live', () => {
  const request: ChatRequest = {
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ],
    tools: [],
    toolSchemaHash: null,
    maxTokens: 64,
    reasoningEffort: 'none',
    responseFormat: null,
    stream: false,
  } as unknown as ChatRequest;

  const file = parseFixtureFile(
    JSON.stringify({
      format: FIXTURE_FORMAT,
      label: 'adversary: a fixture that claims the Crusoe host',
      provenance: 'recorded-live',
      host: 'api.inference.crusoecloud.com',
      entries: [
        {
          key: fixtureKey(request),
          request: {
            model: request.model,
            systemDigest: 'a'.repeat(64),
            messageCount: 1,
            toolSchemaHash: null,
          },
          response: {
            modelReturned: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
            content: 'hi',
            reasoning: null,
            toolCalls: [],
            finishReason: 'stop',
            usage: {
              promptTokens: 10,
              completionTokens: 2,
              cachedTokens: 8,
              reasoningTokens: null,
            },
            outcome: 'completed',
          },
        },
      ],
    }),
  );

  it('TP-51 a replay is stamped mode fixture with no HTTP status, even if the file names the Crusoe host', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new FixtureInference(file);
    const result = await adapter.complete(request, {
      signal: new AbortController().signal,
    } as never);
    expect(result.provider.mode).toBe('fixture');
    expect(result.attempts.every((a) => a.httpStatus === null)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Residual: the host string is copied from the file. Consumers must key on
    // provider.mode, never on host + model alone (see TOOL_PATH_REVIEW.md).
    expect(result.provider.host).toBe('api.inference.crusoecloud.com');
  });

  it('TP-51b a fixture miss fails closed and never reaches a network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new FixtureInference(file);
    await expect(
      adapter.complete(
        {
          ...request,
          messages: [...request.messages, { role: 'user', content: 'x' }],
        } as never,
        { signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow(/never improvises/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
