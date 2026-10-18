// W5.3 (I1): a missing OPENAI_BASE_URL must yield `blocked` and never a request
// to another host. Network-free: global fetch is replaced by a recorder that
// fails the test if anything is requested, and the one subprocess talks only
// to its own loopback port.
//
// Tests titled FINDING encode the documented behaviour and fail while the
// implementation deviates (docs/nemodots/review/TOOL_PATH_REVIEW.md).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInferenceFromEnv,
  resolveMode,
  InferenceBlockedError,
} from '../../../../src/server/nemodots/inference/index.js';
import { resolveInference } from '../../../../src/server/nemodots/config/env.js';

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const KEY = 'sk-adversary-not-a-real-key-0123456789';

afterEach(() => vi.restoreAllMocks());

const recorder = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(`unexpected request to ${String(input)}`);
  });

describe('live mode needs a base URL; there is no default host', () => {
  it('key and model without OPENAI_BASE_URL: blocked, naming exactly the base URL, no request', async () => {
    const network = recorder();
    const env = { OPENAI_API_KEY: KEY, OPENAI_MODEL: 'nvidia/some-model' };
    for (const mode of [undefined, 'live']) {
      const resolved = resolveMode({ ...env, NEMODOTS_INFERENCE_MODE: mode });
      expect(resolved).toMatchObject({
        mode: 'blocked',
        missingEnv: ['OPENAI_BASE_URL'],
      });
      expect(() =>
        createInferenceFromEnv({ ...env, NEMODOTS_INFERENCE_MODE: mode }),
      ).toThrow(InferenceBlockedError);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('an empty, blank or malformed base URL is blocked as well; no value is echoed', () => {
    for (const OPENAI_BASE_URL of [
      '',
      '   ',
      'not a url',
      'file:///etc/passwd',
      'ftp://api.openai.com/v1',
      'javascript:alert(1)',
      '//api.openai.com/v1',
      'api.openai.com/v1',
    ]) {
      const resolved = resolveMode({
        OPENAI_API_KEY: KEY,
        OPENAI_MODEL: 'm',
        OPENAI_BASE_URL,
      });
      expect(resolved.mode, JSON.stringify(OPENAI_BASE_URL)).toBe('blocked');
      expect(JSON.stringify(resolved)).not.toContain(KEY);
      if (OPENAI_BASE_URL.trim())
        expect(JSON.stringify(resolved)).not.toContain(OPENAI_BASE_URL.trim());
    }
  });

  it('every missing live variable is named, and none is defaulted', () => {
    expect(resolveMode({})).toMatchObject({
      mode: 'blocked',
      missingEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
    });
    for (const [drop, rest] of [
      [
        'OPENAI_API_KEY',
        { OPENAI_BASE_URL: 'https://inference.example.test/v1', OPENAI_MODEL: 'm' },
      ],
      [
        'OPENAI_MODEL',
        { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://inference.example.test/v1' },
      ],
    ] as const) {
      const resolved = resolveMode({ ...rest });
      expect(resolved).toMatchObject({ mode: 'blocked', missingEnv: [drop] });
    }
  });

  it('an unrecognised NEMODOTS_INFERENCE_MODE is an error, not a silent live', () => {
    for (const mode of ['LIVE', 'Live', 'true', 'openai', 'fallback']) {
      expect(
        () =>
          resolveInference({
            NEMODOTS_INFERENCE_MODE: mode,
            OPENAI_API_KEY: KEY,
            OPENAI_BASE_URL: 'https://inference.example.test/v1',
            OPENAI_MODEL: 'm',
          }),
        JSON.stringify(mode),
      ).toThrow();
    }
  });

  it('mode=blocked stays blocked even when every live variable is present', () => {
    const resolved = resolveMode({
      NEMODOTS_INFERENCE_MODE: 'blocked',
      OPENAI_API_KEY: KEY,
      OPENAI_BASE_URL: 'https://inference.example.test/v1',
      OPENAI_MODEL: 'm',
    });
    expect(resolved.mode).toBe('blocked');
  });

  it('live mode reports the configured host as the provider host, so a record can be checked against it', () => {
    const resolved = resolveMode({
      OPENAI_API_KEY: KEY,
      OPENAI_BASE_URL: 'https://inference.example.test/v1',
      OPENAI_MODEL: 'm',
    });
    expect(resolved).toMatchObject({
      mode: 'live',
      host: 'inference.example.test',
    });
  });

  it('fixture mode never touches the network, with or without live variables', () => {
    const network = recorder();
    for (const live of [{}, { OPENAI_API_KEY: KEY, OPENAI_MODEL: 'm' }]) {
      expect(() =>
        createInferenceFromEnv({
          ...live,
          NEMODOTS_INFERENCE_MODE: 'fixture',
          NEMODOTS_FIXTURE_PATH: join(tmpdir(), 'nemodots-no-such-fixture.json'),
        }),
      ).toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe('FINDING F-03 (I1): the OpenDots server entry point', () => {
  it('reports a missing OPENAI_BASE_URL as setup that is required, so Dot turns do not start against a default host', async () => {
    // The real src/server/index.ts, started with a key and a model but no base
    // URL, no Intelligence key and a throw-away database. It is only asked
    // what it considers missing; no model request is possible from here.
    const dir = mkdtempSync(join(tmpdir(), 'nemodots-i1-'));
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server/index.ts'],
      {
        cwd: APP_ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          HOST: '127.0.0.1',
          PORT: String(port),
          DATABASE_PATH: join(dir, 'i1.sqlite'),
          OPENAI_API_KEY: KEY,
          OPENAI_MODEL: 'nvidia/some-model',
          DO_NOT_TRACK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    try {
      const deadline = Date.now() + 40_000;
      while (!output.includes('listening')) {
        if (child.exitCode !== null)
          throw new Error(`server exited early: ${output.slice(0, 400)}`);
        if (Date.now() > deadline) throw new Error('server did not start');
        await new Promise((r) => setTimeout(r, 100));
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      const body = (await response.json()) as {
        setup: { missing: string[] };
      };
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(body.setup.missing).toContain('OPENAI_BASE_URL');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve(undefined);
        child.once('exit', resolve);
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve(undefined);
        }, 5_000);
      });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
