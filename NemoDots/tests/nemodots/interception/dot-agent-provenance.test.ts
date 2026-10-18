import { afterEach, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { ConnectionService } from '../../../src/server/connections.js';
import { ComputerService } from '../../../src/server/computer-service.js';
import { tanstackTools } from '../../../src/server/tanstack-tools.js';
import { pageReviewTool } from '../../../src/shared/page-review.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  currentDependencyVector,
  createIncidentPolicy,
  INCIDENT_ENV,
  withToolPolicy,
} from '../../../src/server/nemodots/interception/index.js';
import {
  cleanup,
  collectingSink,
  entryFor,
  fixture,
  text,
  toolCall,
} from './support.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const run = (f: ReturnType<typeof fixture>, message: string, tools = []) =>
  lastValueFrom(f.agent.run(f.input(message, tools)).pipe(toArray()));

it('records a ContextSnapshot with page revision, memory ids, history digests and the tool schema hash', async () => {
  const f = fixture();
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'Notes',
    content: 'hello',
    parentId: null,
  });
  f.workspace.pages.reserveThread(page.id, f.dot.id, 'thread');
  f.workspace.pages.finishThread(page.id, f.dot.id);
  const memory = f.store.saveMemory('prefers short answers');
  const { snapshots, records } = collectingSink();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(text('Hi.'));
  await run(f, 'Say hi.');
  // The prompt keeps its upstream shape: memory texts only.
  expect(String(network.mock.calls[0][1]?.body)).toContain(
    'Preferences: [\\"prefers short answers\\"]',
  );
  expect(snapshots).toHaveLength(1);
  const snapshot = snapshots[0];
  expect(snapshot.contextSchemaVersion).toBe('v1');
  expect(snapshot.toolSchemaHash).toMatch(/^[0-9a-f]{64}$/);
  expect(snapshot.injected.pageSnapshots).toEqual([
    expect.objectContaining({ pageId: page.id, revision: page.revision }),
  ]);
  expect(snapshot.injected.historyItems).toEqual([
    expect.objectContaining({ role: 'user' }),
  ]);
  expect(snapshot.injected.memories).toEqual([
    expect.objectContaining({ id: memory.id }),
  ]);
  // The model call that used the snapshot is recorded, labelled by its mode.
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    contextSnapshotId: snapshot.id,
    provider: { host: 'unused.invalid', mode: 'fixture' },
    model: { requested: 'custom-model', returned: 'custom-model' },
    outcome: 'completed',
  });
  // No usage in the stream: unavailable stays null, never 0.
  expect(records[0].attempts[0]).toMatchObject({
    n: 1,
    httpStatus: 200,
    streamed: true,
    finishReason: 'stop',
    usage: {
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    },
  });
});

it('records one snapshot and call per model iteration, with the tool call that ended it', async () => {
  const f = fixture();
  const { snapshots, records } = collectingSink();
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolCall('c1', 'list_authorized_spaces', {}))
    .mockResolvedValueOnce(text('Done.'));
  await run(f, 'What spaces do I have?');
  expect(snapshots).toHaveLength(2);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    outcome: 'tool_calls',
    toolCalls: [{ toolCallId: 'c1', name: 'list_authorized_spaces' }],
  });
  expect(records[1].outcome).toBe('completed');
  expect(records[0].contextSnapshotId).toBe(snapshots[0].id);
  expect(records[1].contextSnapshotId).toBe(snapshots[1].id);
});

it('read tool results register receipts that join the turn vector', async () => {
  const f = fixture();
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'Notes',
    content: 'x',
    parentId: null,
  });
  const entry = entryFor(page.id, page.revision);
  const seen: string[] = [];
  const { snapshots } = collectingSink({
    registerToolResult: (info) => {
      seen.push(info.toolName);
      return info.toolName === 'read_space_page' ? [entry] : [];
    },
  });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(toolCall('r1', 'read_space_page', { id: page.id }))
    .mockResolvedValueOnce(text('Read.'));
  await run(f, 'Read it.');
  expect(seen).toEqual(['read_space_page']);
  expect(snapshots[0].dependencyVector).toEqual([]);
  expect(snapshots[1].dependencyVector).toEqual([entry]);
});

it('an incident Dot cannot edit a page: tool error, no page change', async () => {
  const f = fixture({ incident: true });
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'Runbook',
    content: 'original',
    parentId: null,
  });
  const { records } = collectingSink();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCall('e1', 'edit_space_page', {
        id: page.id,
        content: 'tampered',
        expectedRevision: page.revision,
      }),
    )
    .mockResolvedValueOnce(text('I could not edit it.'));
  const events = await run(f, 'Edit the runbook.');
  expect(f.workspace.pages.get(f.dot.spaceId, page.id)).toMatchObject({
    content: 'original',
    revision: page.revision,
  });
  const result = events.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT,
  ) as { content?: string } | undefined;
  expect(result?.content).toContain('not available in the incident scope');
  // The continuation request carries the refusal back to the model.
  const continuation = JSON.parse(String(network.mock.calls[1][1]?.body));
  expect(JSON.stringify(continuation.messages)).toContain('incident scope');
  expect(records[0].toolCalls).toEqual([
    expect.objectContaining({ name: 'edit_space_page' }),
  ]);
});

it('an incident Dot may read pages and the same call works for an ordinary Dot', async () => {
  for (const incident of [true, false]) {
    const f = fixture({ incident });
    const page = f.workspace.pages.create(f.dot.spaceId, {
      title: 'N',
      content: 'c',
      parentId: null,
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolCall('r', 'read_space_page', { id: page.id }))
      .mockResolvedValueOnce(text('ok'));
    const events = await run(f, 'read');
    const result = events.find(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    ) as { content?: string };
    expect(result.content).toContain(page.id);
    vi.restoreAllMocks();
    cleanup();
  }
});

it('an ordinary Dot can still edit when no incident list is set', async () => {
  const f = fixture();
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'N',
    content: 'before',
    parentId: null,
  });
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      toolCall('e', 'edit_space_page', {
        id: page.id,
        content: 'after',
        expectedRevision: page.revision,
      }),
    )
    .mockResolvedValueOnce(text('Edited.'));
  await run(f, 'edit');
  expect(f.workspace.pages.get(f.dot.spaceId, page.id).content).toBe('after');
});

it('incident Dots get no memories, so none reach the prompt or the snapshot', async () => {
  const f = fixture({ incident: true });
  f.store.saveMemory('prefers short answers');
  const { snapshots } = collectingSink();
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(text('ok'));
  await run(f, 'hi');
  expect(String(network.mock.calls[0][1]?.body)).not.toContain(
    'prefers short answers',
  );
  expect(snapshots[0].injected.memories).toEqual([]);
});

it('incident Dots get no research, computer, Composio or learned-skill tools in the request', async () => {
  const f = fixture({ incident: true });
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(text('ok'));
  await run(f, 'hello');
  const body = JSON.parse(String(network.mock.calls[0][1]?.body));
  const names = (body.tools ?? []).map(
    (tool: { function: { name: string } }) => tool.function.name,
  );
  expect(names).toEqual(
    expect.arrayContaining(['read_space_page', 'edit_space_page']),
  );
  for (const forbidden of [
    'search_web',
    'read_public_page',
    'copilotkit_load_skill',
  ])
    expect(names).not.toContain(forbidden);
  expect(names.some((name: string) => name.startsWith('computer_'))).toBe(
    false,
  );
});

it('client tools keep no executor and the approval round-trip ends with a pending client call (I7)', async () => {
  const f = fixture({ incident: true });
  const before = f.workspace.pages.list(f.dot.spaceId);
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    toolCall('review-1', pageReviewTool.name, {
      title: 'Draft',
      content: 'body',
      spaceId: f.dot.spaceId,
    }),
  );
  const events = await run(f, 'Review a draft first.', [
    pageReviewTool,
    connectionActionTool,
  ] as never);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: EventType.TOOL_CALL_START,
        toolCallName: pageReviewTool.name,
      }),
    ]),
  );
  expect(
    events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
  ).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(before);

  // And directly: executor-less tools are returned as the same object.
  const clientTool = { name: pageReviewTool.name, description: 'x' } as never;
  const server = tanstackTools([
    defineTool({
      name: 'read_space_page',
      description: 'r',
      parameters: z.object({}),
      execute: async () => ({}),
    }),
  ]);
  const wrapped = withToolPolicy([...server, clientTool], {
    dotId: f.dot.id,
    policy: createIncidentPolicy({ env: { [INCIDENT_ENV]: f.dot.id } }),
    defaultSpaceId: null,
  });
  expect(wrapped[1]).toBe(clientTool);
  expect(wrapped[0]).not.toBe(server[0]);
});

it('the per-turn ConnectionService and ComputerService refuse incident Dots (I5)', async () => {
  const f = fixture({ incident: true });
  const perTurnConnections = new ConnectionService(f.workspace.connections);
  const connection = f.workspace.connections.create(
    f.dot.id,
    { name: 'Mail', url: 'https://mail.example.com/mcp' },
    [
      {
        name: 'search',
        title: 'Search',
        description: '',
        inputSchema: { type: 'object' },
        readOnly: true,
        enabled: true,
        requiresApproval: false,
      },
    ],
  );
  const exposed = perTurnConnections.resolve(f.dot.id, 'mail__search');
  expect(exposed.connection.id).toBe(connection.id);
  expect(await perTurnConnections.call(exposed, {})).toEqual({
    isError: true,
    text: expect.stringContaining('incident'),
  });

  const computer = new ComputerService(
    f.workspace,
    {
      computerSupervisorUrl: 'http://127.0.0.1:9',
      computerSupervisorToken: 't',
      computerToken: 't',
    } as never,
    () => false,
    vi.fn() as never,
  );
  await expect(
    computer.action(f.dot.id, 'snapshot', {}, 'agent'),
  ).rejects.toThrow('incident');
  // audited() allows the owner: the failure is the unreachable service, not policy.
  await expect(
    computer.action(f.dot.id, 'snapshot', {}, 'owner'),
  ).rejects.not.toThrow('incident');
});

it('the provenance scope is gone once the turn ends', async () => {
  const f = fixture();
  collectingSink();
  expect(currentDependencyVector()).toBeNull();
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(text('ok'));
  await run(f, 'hi');
  expect(currentDependencyVector()).toBeNull();
});

it('every executor class is refused for an incident Dot: Composio, MCP, computer, research and learned-skill names', async () => {
  const f = fixture({ incident: true });
  const ran = vi.fn(async () => ({ ok: true }));
  const names = [
    'GMAIL_SEND_EMAIL', // Composio
    'mail__send_mail', // MCP
    'mail__search', // MCP read-only hint is not proof
    'computer_exec',
    'computer_files_write',
    'search_web',
    'read_public_page',
    'copilotkit_load_skill',
    'copilotkit_read_skill_file',
  ];
  const wrapped = withToolPolicy(
    tanstackTools(
      names.map((name) =>
        defineTool({
          name,
          description: name,
          parameters: z.object({}),
          execute: ran,
        }),
      ),
    ),
    {
      dotId: f.dot.id,
      policy: createIncidentPolicy({ env: { [INCIDENT_ENV]: f.dot.id } }),
      defaultSpaceId: f.dot.spaceId,
    },
  );
  for (const tool of wrapped)
    expect(() => tool.execute!({}, undefined)).toThrow('incident scope');
  expect(ran).not.toHaveBeenCalled();
});
