import { randomUUID } from 'node:crypto';
import type { RunAgentInput } from '@ag-ui/core';
import { DotAgent } from '../../../src/server/dot-agent.js';
import { Store } from '../../../src/server/store.js';
import { WorkspaceStore } from '../../../src/server/workspace.js';
import {
  INCIDENT_ENV,
  resetInterception,
  setInterceptionHooks,
  type ProvenanceSink,
} from '../../../src/server/nemodots/interception/index.js';
import type {
  AttemptId,
  ContextSnapshot,
  DependencyEntry,
  MissionId,
  ModelCallRecord,
  TaskId,
} from '../../../src/server/nemodots/contracts/index.js';
import { completion } from '../../fixtures/model-stream.js';

export const databases: Array<{ close(): void }> = [];

export function cleanup() {
  delete process.env[INCIDENT_ENV];
  resetInterception();
  databases.splice(0).forEach((db) => db.close());
}

export function fixture(options: { incident?: boolean } = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Interception');
  if (options.incident) process.env[INCIDENT_ENV] = dot.id;
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
    },
    dot.id,
  );
  const input = (
    message: string,
    tools: RunAgentInput['tools'] = [],
  ): RunAgentInput => ({
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: message }],
    tools,
    forwardedProps: {},
  });
  return { store, workspace, dot, agent, input };
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

export const text = (content: string) =>
  completion({ role: 'assistant', content });

export function collectingSink(extra: Partial<ProvenanceSink> = {}) {
  const snapshots: ContextSnapshot[] = [];
  const records: ModelCallRecord[] = [];
  const sink: ProvenanceSink = {
    identify: () => ({
      scope: {
        ownerId: 'owner',
        missionId: randomUUID() as MissionId,
        spaceId: null,
        environment: 'test',
        resource: 'checkout',
      },
      taskId: randomUUID() as TaskId,
      attemptId: randomUUID() as AttemptId,
      role: 'worker',
    }),
    recordSnapshot: (snapshot) => void snapshots.push(snapshot),
    recordModelCall: (record) => void records.push(record),
    ...extra,
  };
  setInterceptionHooks({ sink, providerMode: 'fixture' });
  return { sink, snapshots, records };
}

export const entryFor = (
  pageId: string,
  revision: number,
): DependencyEntry => ({
  sourceKey: `opendots.page/${pageId}` as DependencyEntry['sourceKey'],
  sourceRevision: revision,
  receiptId: randomUUID() as DependencyEntry['receiptId'],
});
