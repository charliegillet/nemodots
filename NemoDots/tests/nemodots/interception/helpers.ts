import { afterEach, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/core';
import { DotAgent } from '../../../src/server/dot-agent.js';
import { Store } from '../../../src/server/store.js';
import { WorkspaceStore } from '../../../src/server/workspace.js';
import type { PlatformConfig } from '../../../src/server/platform-config.js';
import { completion } from '../../fixtures/model-stream.js';
import {
  setActivePolicy,
  setInterceptionRuntime,
  derivedUuid,
  type DependencyEntry,
  type InterceptionRuntime,
  type ModelCallSinkInput,
  type ModelCallSinkTurn,
} from '../../../src/server/nemodots/interception/index.js';

const closers: Array<{ close(): void }> = [];

/** Every test leaves the module-level registries at their upstream defaults. */
export function resetInterceptionState() {
  setActivePolicy(null);
  setInterceptionRuntime(null);
  vi.restoreAllMocks();
  closers.splice(0).forEach((db) => db.close());
}
afterEach(resetInterceptionState);

export function dotFixture(config: Partial<PlatformConfig> = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Interception');
  const agent = new DotAgent(
    store,
    workspace,
    {
      intelligenceKey: 'fixture',
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      ...config,
    },
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'Do the thing.' }],
    tools: [],
    forwardedProps: {},
  };
  return { store, workspace, dot, agent, input };
}

/** Makes `pageId` the page this conversation is attached to (the page-context row). */
export function attachPage(
  f: ReturnType<typeof dotFixture>,
  title = 'Runbook',
  content = '# Runbook\nBody.',
) {
  const page = f.workspace.pages.create(f.dot.spaceId, { title, content });
  f.workspace.pages.reserveThread(page.id, f.dot.id, 'thread');
  f.workspace.pages.finishThread(page.id, f.dot.id);
  return page;
}

export function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}`,
) {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}

export const textResponse = (content: string) =>
  completion({ role: 'assistant', content });

/** A recording sink plus a resolver that gives every page/memory version a stable receipt. */
export function recordingRuntime(
  overrides: Partial<InterceptionRuntime> = {},
) {
  const calls: Array<{ input: ModelCallSinkInput; info: ModelCallSinkTurn }> =
    [];
  const errors: Array<{ error: unknown; where: string }> = [];
  const resolved: DependencyEntry[] = [];
  const runtime: InterceptionRuntime = {
    providerMode: 'fixture',
    recordModelCall: (input, info) => {
      calls.push({ input, info });
    },
    resolveReceipt: (query) => {
      const entry = {
        sourceKey: query.sourceKey,
        sourceRevision: query.sourceRevision ?? 1,
        receiptId: derivedUuid(
          `receipt:${query.sourceKey}:${query.sourceRevision}`,
        ),
      } as DependencyEntry;
      resolved.push(entry);
      return entry;
    },
    onError: (error, where) => errors.push({ error, where }),
    ...overrides,
  };
  return { runtime, calls, errors, resolved };
}
