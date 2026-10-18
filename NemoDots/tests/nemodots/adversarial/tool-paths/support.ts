// W5.3 integration adversary: shared fixture for Dot-turn attacks. Written
// independently of the W3.3 interception tests. A real WorkspaceStore/Store in
// memory, a real DotAgent, and a scripted provider behind a fetch spy: every
// outbound request is recorded (URL + body) so a test can prove which host a
// turn talked to and which tools the model was offered. Expectations come from
// TOOL_COVERAGE.md, CONTRACTS.md and ARCHITECTURE.md, never from these helpers.
import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { vi } from 'vitest';
import { DotAgent } from '../../../../src/server/dot-agent.js';
import type { PlatformConfig } from '../../../../src/server/platform-config.js';
import { Store } from '../../../../src/server/store.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import {
  INCIDENT_ENV,
  resetInterception,
} from '../../../../src/server/nemodots/interception/index.js';
import { completion } from '../../../fixtures/model-stream.js';

const open: Array<{ close(): void }> = [];

export function cleanup() {
  vi.restoreAllMocks();
  delete process.env[INCIDENT_ENV];
  resetInterception();
  open.splice(0).forEach((db) => db.close());
}

export const MODEL_HOST = 'provider.adversary.invalid';
export const MODEL_BASE = `https://${MODEL_HOST}/v1`;

export function baseConfig(
  overrides: Partial<PlatformConfig> = {},
): PlatformConfig {
  return {
    intelligenceKey: 'adversary-intelligence',
    apiKey: 'adversary-provider-key',
    model: 'adversary-model',
    baseUrl: MODEL_BASE,
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    ...overrides,
  } as PlatformConfig;
}

export interface World {
  store: Store;
  workspace: WorkspaceStore;
  dotId: string;
  threadId: string;
  spaceId: string;
  /** Extra Spaces by name (granted to the Dot). */
  spaces: Record<string, string>;
  agent: DotAgent;
}

export function world(
  options: {
    incident?: boolean;
    config?: Partial<PlatformConfig>;
    dot?: Partial<{
      skillDeliveryEnabled: boolean;
      learningContainerId: string | null;
      appsAllowed: boolean;
      researchAllowed: boolean;
      memoryAllowed: boolean;
      /** Extra Spaces created first and granted to the Dot. */
      extraSpaces: string[];
    }>;
    threadId?: string;
    /** A channel (Slack/headless) DotAgent: no client tools, binds the thread. */
    channel?: boolean;
  } = {},
): World {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  open.push(store, workspace);
  const spaceId = workspace.spaces()[0].id;
  const spaces: Record<string, string> = {};
  for (const name of options.dot?.extraSpaces ?? [])
    spaces[name] = workspace.createSpace(name, 'adversary Space').id;
  const dot = workspace.createDot(
    spaceId,
    'Incident Dot',
    'Investigate the checkout incident.',
    options.dot?.researchAllowed ?? false,
    options.dot?.memoryAllowed ?? false,
    [spaceId, ...Object.values(spaces)],
    options.dot?.learningContainerId ?? null,
    options.dot?.skillDeliveryEnabled ?? false,
    options.dot?.appsAllowed ?? false,
  );
  const threadId = options.threadId ?? 'adversary-thread';
  workspace.bindThread(threadId, dot.id, 'Adversary');
  if (options.incident) process.env[INCIDENT_ENV] = dot.id;
  const agent = new DotAgent(
    store,
    workspace,
    baseConfig(options.config),
    dot.id,
    options.channel ?? false,
  );
  return { store, workspace, dotId: dot.id, threadId, spaceId, spaces, agent };
}

export function input(
  w: Pick<World, 'threadId'>,
  message: string,
  tools: RunAgentInput['tools'] = [],
): RunAgentInput {
  return {
    threadId: w.threadId,
    runId: 'adversary-run',
    state: {},
    context: [],
    messages: [{ id: 'user-1', role: 'user', content: message }],
    tools,
    forwardedProps: {},
  };
}

export function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
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

export const say = (content: string) =>
  completion({ role: 'assistant', content });

export interface Wire {
  url: string;
  host: string;
  body: string;
}

/**
 * Replaces global fetch. Each request is recorded; the n-th request gets the
 * n-th scripted response (a fresh Response each time). Requests past the
 * script get a plain text answer so a turn always terminates.
 */
export function provider(script: Array<() => Response>) {
  const wire: Wire[] = [];
  let n = 0;
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (resource, init) => {
      const url =
        typeof resource === 'string'
          ? resource
          : resource instanceof URL
            ? resource.toString()
            : resource.url;
      const body =
        typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? String(init.body)
            : '';
      wire.push({ url, host: new URL(url).host, body });
      const next = script[n++];
      return next ? next() : say('Done.');
    });
  return { wire, spy };
}

/** Tool names the model was offered in one recorded chat request. */
export function offeredTools(entry: Wire): string[] {
  try {
    const parsed = JSON.parse(entry.body) as {
      tools?: { function?: { name?: string }; name?: string }[];
    };
    return (parsed.tools ?? []).map(
      (tool) => tool.function?.name ?? tool.name ?? '',
    );
  } catch {
    return [];
  }
}

export async function run(w: World, message: string, tools = [] as never[]) {
  return lastValueFrom(w.agent.run(input(w, message, tools)).pipe(toArray()));
}

/** The tool result messages the provider received back, as raw strings. */
export function toolResults(wire: Wire[]): string[] {
  const out: string[] = [];
  for (const entry of wire) {
    try {
      const parsed = JSON.parse(entry.body) as {
        messages?: { role: string; content?: unknown }[];
      };
      for (const message of parsed.messages ?? [])
        if (message.role === 'tool') out.push(JSON.stringify(message.content));
    } catch {
      // not a chat request
    }
  }
  return out;
}
