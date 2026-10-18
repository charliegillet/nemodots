import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadFixtureAdapter } from '../../../src/server/nemodots/inference/index.js';
import {
  FIXTURES,
  textRequest,
  toolContinuationRequest,
  toolRequest,
} from '../fixtures/inference/requests.js';
import { ctx } from './stub.js';

const DIR = 'tests/nemodots/fixtures/inference';

describe('committed inference fixtures', () => {
  it.each(Object.entries(FIXTURES))(
    '%s matches its generator and is labelled hand-authored',
    (name, expected) => {
      const onDisk = JSON.parse(readFileSync(`${DIR}/${name}`, 'utf8'));
      expect(onDisk).toEqual(expected);
      expect(onDisk.provenance).toBe('hand-authored');
      expect(onDisk.label).toMatch(/not live evidence/);
    },
  );

  it('replays the text, tool call and continuation fixtures through the adapter', async () => {
    const text = loadFixtureAdapter(`${DIR}/text-completion.fixture.json`);
    expect((await text.complete(textRequest, ctx())).content).toBe('pong');
    const tools = loadFixtureAdapter(`${DIR}/tool-call.fixture.json`);
    const call = await tools.complete(toolRequest, ctx());
    expect(call).toMatchObject({
      outcome: 'tool_calls',
      provider: { mode: 'fixture' },
    });
    expect(call.toolCalls[0].toolCallId).toBe('chatcmpl-tool-fixture0001');
    const done = await tools.complete(toolContinuationRequest, ctx());
    expect(done.content).toMatch(/status ok/);
    await expect(tools.complete(textRequest, ctx())).rejects.toMatchObject({
      errorClass: 'fixture_miss',
    });
  });

  it('fixture files contain no key-shaped strings', () => {
    for (const name of Object.keys(FIXTURES)) {
      const text = readFileSync(`${DIR}/${name}`, 'utf8');
      expect(text).not.toMatch(
        /Bearer |sk-[A-Za-z0-9]{16}|nvapi-|cpk_|OPENAI_API_KEY/,
      );
    }
  });
});
