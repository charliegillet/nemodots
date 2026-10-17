import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolSchemas } from '../../../src/server/nemodots/contracts/index.js';
import {
  FIXTURE_FORMAT,
  FixtureInference,
  RecordingInference,
  createInferenceFromEnv,
  fixtureKey,
  fixtureRequestInfo,
  loadFixtureAdapter,
  parseFixtureFile,
  redactSecrets,
  resolveMode,
  CrusoeInferenceClient,
  InferenceBlockedError,
  type FixtureFile,
} from '../../../src/server/nemodots/inference/index.js';
import {
  API_KEY,
  MODEL,
  client,
  ctx,
  request,
  startStub,
  textStream,
  type Stub,
} from './stub.js';

function without<T extends Record<string, string>>(obj: T, key: keyof T) {
  const copy: Record<string, string> = { ...obj };
  delete copy[key as string];
  return copy;
}

describe('mode resolution (I1: no default base URL)', () => {
  const full = {
    OPENAI_API_KEY: 'k-123456',
    OPENAI_BASE_URL: 'https://example.invalid/v1',
    OPENAI_MODEL: MODEL,
  };
  it('live when key, base URL and model are all set', () => {
    expect(resolveMode(full)).toMatchObject({
      mode: 'live',
      host: 'example.invalid',
      model: MODEL,
    });
  });
  it('key + model without base URL -> blocked, missingEnv [OPENAI_BASE_URL]', () => {
    const env = without(full, 'OPENAI_BASE_URL');
    expect(resolveMode(env)).toMatchObject({
      mode: 'blocked',
      missingEnv: ['OPENAI_BASE_URL'],
    });
  });
  it('no key -> blocked, missingEnv [OPENAI_API_KEY]', () => {
    const env = without(full, 'OPENAI_API_KEY');
    expect(resolveMode(env)).toMatchObject({
      mode: 'blocked',
      missingEnv: ['OPENAI_API_KEY'],
    });
  });
  it('lists every absent name and treats blanks as absent', () => {
    expect(resolveMode({ OPENAI_API_KEY: '  ' })).toMatchObject({
      mode: 'blocked',
      missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
    });
  });
  it('a malformed base URL is blocked as invalid', () => {
    expect(resolveMode({ ...full, OPENAI_BASE_URL: 'nonsense' })).toMatchObject(
      {
        mode: 'blocked',
        invalidEnv: ['OPENAI_BASE_URL'],
      },
    );
  });
  it('requested blocked and fixture-without-path are blocked', () => {
    expect(
      resolveMode({ ...full, NEMODOTS_INFERENCE_MODE: 'blocked' }),
    ).toMatchObject({ mode: 'blocked', reason: 'requested' });
    expect(resolveMode({ NEMODOTS_INFERENCE_MODE: 'fixture' })).toMatchObject({
      mode: 'blocked',
      missingEnv: ['NEMODOTS_FIXTURE_PATH'],
    });
  });
  it('the module names no default provider host', () => {
    for (const file of [
      'mode.ts',
      'client.ts',
      'index.ts',
      'health.ts',
      'fixture.ts',
    ])
      expect(
        readFileSync(`src/server/nemodots/inference/${file}`, 'utf8'),
      ).not.toMatch(/api\.openai\.com|crusoecloud/);
  });
  it('createInferenceFromEnv fails closed instead of choosing a provider', () => {
    const env = without(full, 'OPENAI_BASE_URL');
    try {
      createInferenceFromEnv(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceBlockedError);
      expect((error as InferenceBlockedError).missingEnv).toEqual([
        'OPENAI_BASE_URL',
      ]);
      expect(String(error)).not.toContain('k-123456');
    }
    expect(() =>
      createInferenceFromEnv({ ...full, NEMODOTS_INFERENCE_MODE: 'blocked' }),
    ).toThrow(InferenceBlockedError);
    const live = createInferenceFromEnv(full);
    expect(live).toBeInstanceOf(CrusoeInferenceClient);
    expect(live.host()).toBe('example.invalid');
    expect(live.mode).toBe('live');
  });
});

const dirs: string[] = [];
let stub: Stub | undefined;
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await stub?.close();
  stub = undefined;
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'nemodots-inf-'));
  dirs.push(d);
  return d;
}

function fixtureFor(req = request()): FixtureFile {
  return {
    format: FIXTURE_FORMAT,
    label: 'unit-test fixture (hand-authored, not live evidence)',
    provenance: 'hand-authored',
    host: 'fixture.local',
    models: [MODEL],
    entries: [
      {
        key: fixtureKey(req),
        request: fixtureRequestInfo(req),
        response: {
          modelReturned: MODEL,
          content: 'pong',
          reasoning: null,
          toolCalls: [],
          finishReason: 'stop',
          usage: {
            promptTokens: 30,
            completionTokens: 3,
            cachedTokens: null,
            reasoningTokens: null,
          },
          outcome: 'completed',
        },
      },
    ],
  };
}

describe('fixture adapter', () => {
  it('replays a recorded response, stamps provider.mode fixture, and does not claim provider timings', async () => {
    const adapter = new FixtureInference(fixtureFor());
    const result = await adapter.complete(request(), ctx());
    expect(result).toMatchObject({
      content: 'pong',
      outcome: 'completed',
      provider: { mode: 'fixture', host: 'fixture.local' },
    });
    expect(result.attempts[0]).toMatchObject({
      httpStatus: null,
      headersAt: null,
      firstContentAt: null,
      streamed: false,
    });
    expect(adapter.mode).toBe('fixture');
    expect(adapter.host()).toBe('fixture.local');
  });

  it('refuses keys it does not hold: any change to model, system, messages or tool schema hash', async () => {
    const adapter = new FixtureInference(fixtureFor());
    const variants = [
      request({ model: 'nvidia/other' }),
      request({
        messages: [
          { role: 'system', content: 'different' },
          { role: 'user', content: 'ping' },
        ],
      }),
      request({
        messages: [
          { role: 'system', content: 'You are a test.' },
          { role: 'user', content: 'pong' },
        ],
      }),
      request({ tools: toolSchemas().slice(0, 1) }),
      request({ toolSchemaHash: 'a'.repeat(64) }),
    ];
    for (const req of variants)
      await expect(adapter.complete(req, ctx())).rejects.toMatchObject({
        errorClass: 'fixture_miss',
      });
  });

  it('is keyed by content, not by sampling parameters', () => {
    expect(fixtureKey(request({ maxTokens: 10 }))).toBe(
      fixtureKey(request({ maxTokens: 99, stream: false })),
    );
  });

  it('fixture without a path is an error; unreadable or invalid files are errors', () => {
    expect(() => loadFixtureAdapter(undefined)).toThrow(
      /NEMODOTS_FIXTURE_PATH/,
    );
    expect(() => loadFixtureAdapter('/nonexistent/fixture.json')).toThrow(
      /cannot be read/,
    );
    const dir = tmp();
    writeFileSync(join(dir, 'bad.json'), '{"format":"x"}');
    expect(() => loadFixtureAdapter(join(dir, 'bad.json'))).toThrow(/invalid/);
    writeFileSync(join(dir, 'notjson.json'), 'nope');
    expect(() => loadFixtureAdapter(join(dir, 'notjson.json'))).toThrow(
      /not JSON/,
    );
  });

  it('rejects duplicate keys and unknown fields', () => {
    const f = fixtureFor();
    expect(() =>
      parseFixtureFile(
        JSON.stringify({ ...f, entries: [f.entries[0], f.entries[0]] }),
      ),
    ).toThrow(/duplicate/);
    expect(() => parseFixtureFile(JSON.stringify({ ...f, extra: 1 }))).toThrow(
      /invalid/,
    );
  });

  it('createInferenceFromEnv loads the fixture adapter in fixture mode and never needs OPENAI_*', async () => {
    const path = join(tmp(), 'f.json');
    writeFileSync(path, JSON.stringify(fixtureFor()));
    const adapter = createInferenceFromEnv({
      NEMODOTS_INFERENCE_MODE: 'fixture',
      NEMODOTS_FIXTURE_PATH: path,
    });
    expect(adapter.mode).toBe('fixture');
    expect(await adapter.verifyModel(MODEL)).toBe(true);
    expect(await adapter.verifyModel('nvidia/does-not-exist')).toBe(false);
    expect(await adapter.listModels()).toEqual([MODEL]);
  });

  it('honours an already-aborted signal', async () => {
    const adapter = new FixtureInference(fixtureFor());
    const c = new AbortController();
    c.abort();
    const result = await adapter.complete(request(), ctx(c.signal));
    expect(result).toMatchObject({
      outcome: 'aborted',
      finishReason: 'cancelled',
    });
  });
});

describe('fixture recording with secret stripping', () => {
  it('records live responses, never stores request content, and strips secrets', async () => {
    stub = await startStub((_req, res) =>
      textStream(
        res,
        [
          `the key is ${API_KEY} and Bearer abcdefghijklmnop12345 and sk-abcdefghijklmnopqrstuv`,
        ],
        {
          prompt_tokens: 9,
          completion_tokens: 4,
        },
      ),
    );
    const { client: live } = client(stub);
    const recorder = new RecordingInference(live, {
      label: 'recorded in test',
      secrets: [API_KEY],
    });
    const req = request({
      messages: [
        { role: 'system', content: 'sys SECRETPROMPT' },
        { role: 'user', content: 'u SECRETUSER' },
      ],
    });
    await recorder.complete(req, ctx());
    const path = join(tmp(), 'out', 'rec.json');
    recorder.flush(path);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('abcdefghijklmnop12345');
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuv');
    expect(text).not.toContain('SECRETPROMPT');
    expect(text).not.toContain('SECRETUSER');
    expect(text).toContain('[REDACTED]');
    const replay = loadFixtureAdapter(path);
    const result = await replay.complete(req, ctx());
    expect(result.provider.mode).toBe('fixture');
    expect(result.content).toContain('[REDACTED]');
    expect(JSON.parse(text)).toMatchObject({
      provenance: 'recorded-live',
      host: stub.host,
    });
  });

  it('does not record failed or aborted calls', async () => {
    stub = await startStub((_req, res) => {
      res.writeHead(404).end('{"code":"model_not_found"}');
    });
    const { client: live } = client(stub);
    const recorder = new RecordingInference(live, {
      label: 'x',
      secrets: [API_KEY],
    });
    await recorder.complete(request(), ctx());
    expect(recorder.toFile().entries).toEqual([]);
  });

  it('redactSecrets handles explicit values, bearer tokens and connection strings', () => {
    expect(
      redactSecrets(
        'a Bearer abcdefgh12345678 b postgres://u:p@h/db c mykey-1234',
        ['mykey-1234'],
      ),
    ).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });
});
