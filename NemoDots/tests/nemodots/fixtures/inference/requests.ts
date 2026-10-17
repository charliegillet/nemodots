import {
  toolSchemas,
  type ChatRequest,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  FIXTURE_FORMAT,
  fixtureKey,
  fixtureRequestInfo,
  type FixtureFile,
} from '../../../../src/server/nemodots/inference/fixture.js';

// Hand-authored inference fixtures. They are labelled as such inside each
// file (provenance "hand-authored") and are replay data for deterministic
// tests only: never live evidence. `npx tsx tests/nemodots/fixtures/inference/build.ts`
// regenerates the JSON; the test suite fails when the committed files drift.

export const FIXTURE_MODEL = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B';
const SYSTEM = 'You are a NemoDots fixture assistant. Answer tersely.';

const base = (over: Partial<ChatRequest>): ChatRequest => ({
  model: FIXTURE_MODEL,
  messages: [{ role: 'system', content: SYSTEM }],
  tools: [],
  toolSchemaHash: null,
  maxTokens: null,
  reasoningEffort: null,
  responseFormat: null,
  stream: true,
  ...over,
});

export const textRequest = base({
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Reply with the single word pong.' },
  ],
});

export const toolRequest = base({
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Read the checkout health source.' },
  ],
  tools: toolSchemas(),
});

export const toolContinuationRequest = base({
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Read the checkout health source.' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          toolCallId: 'chatcmpl-tool-fixture0001',
          name: 'observe_source',
          arguments: '{"sourceKey":"checkout.health"}',
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'chatcmpl-tool-fixture0001',
      content: '{"status":"ok"}',
    },
  ],
  tools: toolSchemas(),
});

export const FIXTURES: Record<string, FixtureFile> = {
  'text-completion.fixture.json': file(
    'Hand-authored text completion fixture (not live evidence)',
    [
      [
        textRequest,
        {
          content: 'pong',
          finishReason: 'stop',
          outcome: 'completed',
          usage: {
            promptTokens: 30,
            completionTokens: 3,
            cachedTokens: 0,
            reasoningTokens: null,
          },
          toolCalls: [],
        },
      ],
    ],
  ),
  'tool-call.fixture.json': file(
    'Hand-authored tool call + continuation fixture (not live evidence)',
    [
      [
        toolRequest,
        {
          content: null,
          finishReason: 'tool_calls',
          outcome: 'tool_calls',
          usage: {
            promptTokens: 337,
            completionTokens: 30,
            cachedTokens: null,
            reasoningTokens: null,
          },
          toolCalls: [
            {
              toolCallId: 'chatcmpl-tool-fixture0001',
              name: 'observe_source',
              arguments: '{"sourceKey":"checkout.health"}',
            },
          ],
        },
      ],
      [
        toolContinuationRequest,
        {
          content: 'Checkout health reports status ok.',
          finishReason: 'stop',
          outcome: 'completed',
          usage: {
            promptTokens: 421,
            completionTokens: 16,
            cachedTokens: null,
            reasoningTokens: null,
          },
          toolCalls: [],
        },
      ],
    ],
  ),
};

type Response = Omit<
  FixtureFile['entries'][number]['response'],
  'modelReturned' | 'reasoning'
>;
function file(label: string, pairs: [ChatRequest, Response][]): FixtureFile {
  return {
    format: FIXTURE_FORMAT,
    label,
    provenance: 'hand-authored',
    host: 'fixture.local',
    models: [FIXTURE_MODEL],
    entries: pairs
      .map(([req, response]) => ({
        key: fixtureKey(req),
        request: fixtureRequestInfo(req),
        response: {
          modelReturned: FIXTURE_MODEL,
          reasoning: null,
          ...response,
        },
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}
