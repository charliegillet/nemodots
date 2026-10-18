// Finding TP-01: no implicit provider host. With OPENAI_BASE_URL missing or
// unusable, every Dot turn (incident or ordinary) is refused before any
// request is made: the key is never sent to a host nobody configured.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { readFileSync } from 'node:fs';
import { research } from '../../../src/server/research.js';
import { setupStatus } from '../../../src/server/platform-config.js';
import { DotAgent, providerBaseUrl } from '../../../src/server/dot-agent.js';
import { Store } from '../../../src/server/store.js';
import { WorkspaceStore } from '../../../src/server/workspace.js';
import {
  INCIDENT_ENV,
  resetInterception,
} from '../../../src/server/nemodots/interception/index.js';
import { text } from './support.js';

const resources: { close(): void }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[INCIDENT_ENV];
  resetInterception();
  resources.splice(0).forEach((r) => r.close());
});

function agentWith(baseUrl: string | undefined, incident: boolean) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Provider host');
  if (incident) process.env[INCIDENT_ENV] = dot.id;
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'crusoe-key-that-must-not-leave',
      model: 'custom-model',
      baseUrl: baseUrl as string,
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    dot.id,
  );
  const input = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'u', role: 'user' as const, content: 'Say hi.' }],
    tools: [],
    forwardedProps: {},
  };
  return { agent, input };
}

describe('providerBaseUrl', () => {
  it('accepts only a non-empty http(s) URL', () => {
    expect(providerBaseUrl('https://api.inference.crusoecloud.com/v1')).toBe(
      'https://api.inference.crusoecloud.com/v1',
    );
    expect(providerBaseUrl(' http://127.0.0.1:9/v1 ')).toBe(
      'http://127.0.0.1:9/v1',
    );
    for (const bad of [
      undefined,
      '',
      '   ',
      'not a url',
      'ftp://host/v1',
      'javascript:alert(1)',
      '/v1',
    ])
      expect(providerBaseUrl(bad as string)).toBeNull();
  });
});

describe('a Dot turn without a configured provider host', () => {
  for (const incident of [true, false])
    for (const baseUrl of [
      undefined,
      '',
      '   ',
      'not a url',
      'ftp://example.invalid/v1',
    ]) {
      it(`${incident ? 'incident' : 'ordinary'} Dot, base URL ${JSON.stringify(baseUrl)}: refused, naming the variable, zero outbound requests`, async () => {
        const network = vi
          .spyOn(globalThis, 'fetch')
          .mockResolvedValue(text('should never be requested'));
        const { agent, input } = agentWith(baseUrl, incident);
        const events = await lastValueFrom(agent.run(input).pipe(toArray()));
        const error = events.find((e) => e.type === EventType.RUN_ERROR) as
          { message?: string } | undefined;
        expect(error?.message).toContain('OPENAI_BASE_URL');
        expect(network).not.toHaveBeenCalled();
        expect(
          events.some((e) => e.type === EventType.TEXT_MESSAGE_CHUNK),
        ).toBe(false);
      });
    }

  it('with a configured host the turn goes to exactly that host', async () => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(text('hello'));
    const { agent, input } = agentWith('https://provider.example/v1', false);
    await lastValueFrom(agent.run(input).pipe(toArray()));
    const hosts = new Set(
      network.mock.calls.map((call) => new URL(String(call[0])).host),
    );
    expect(hosts).toEqual(new Set(['provider.example']));
  });
});

describe('setup status and the voice path', () => {
  const complete = {
    intelligenceKey: 'k',
    apiKey: 'a',
    model: 'm',
    baseUrl: 'https://provider.example/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };

  it('setup is incomplete until OPENAI_BASE_URL is set, and names it', () => {
    expect(setupStatus(complete).missing).toEqual([]);
    expect(setupStatus(complete).model).toBe(true);
    // blank is not the only invalid value: an unusable URL is missing too
    for (const baseUrl of [
      undefined,
      '',
      '  ',
      'not a url',
      'ftp://example.invalid/v1',
      '/v1',
    ]) {
      const status = setupStatus({ ...complete, baseUrl: baseUrl as string });
      expect(status.missing).toEqual(['OPENAI_BASE_URL']);
      expect(status.model).toBe(false);
    }
  });

  it('realtime voice authenticates only with VOICE_API_KEY, never the inference key', () => {
    // voice.ts talks to a different, non-Crusoe provider (api.openai.com
    // realtime); it must not be able to send the inference key there.
    const voice = readFileSync('src/server/voice.ts', 'utf8');
    expect(voice).not.toMatch(/config\.apiKey|OPENAI_API_KEY|process\.env/);
    expect(voice).toContain('voiceKey');
  });
});

describe('legacy research completion', () => {
  it('refuses without a base URL and makes no request', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    for (const baseUrl of [undefined, '', '  '])
      await expect(
        research(
          'Read https://example.com/a',
          [],
          {
            mode: 'live',
            apiKey: 'crusoe-key-that-must-not-leave',
            model: 'm',
            baseUrl: baseUrl as string,
            browserUrl: 'http://127.0.0.1:1',
            browserSecret: 'x',
            webSearchProvider: 'browser',
          },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toThrow('OPENAI_BASE_URL is required');
    expect(network).not.toHaveBeenCalled();
  });
});
