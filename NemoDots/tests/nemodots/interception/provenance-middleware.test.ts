// The provenance middleware's tool-policy and replay behaviour, driven through
// its hooks directly (no model, no network): refusing executor-less tools that
// the registry refuses (TP-10), recalling the evidence a replayed transcript
// was read from (TP-17, R4), and not registering receipts for refused calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMiddlewareContext } from '@tanstack/ai';
import {
  INCIDENT_ENV,
  ToolRefusedError,
  createFetchTelemetry,
  createIncidentPolicy,
  provenanceMiddleware,
  recallToolEvidence,
  rememberToolEvidence,
  resetInterception,
  type ProvenanceScope,
  type ProvenanceSink,
} from '../../../src/server/nemodots/interception/index.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import { pageReviewTool } from '../../../src/shared/page-review.js';
import { cleanup, entryFor } from './support.js';

afterEach(cleanup);

const env = { [INCIDENT_ENV]: 'dot' };

function build(
  options: {
    incident?: boolean;
    sink?: ProvenanceSink;
    threadId?: string;
  } = {},
) {
  const incident = options.incident ?? true;
  const threadId = options.threadId ?? 'thread';
  const scope: ProvenanceScope = {
    dotId: 'dot',
    threadId,
    incident,
    dependencyVector: [],
  };
  const policy = createIncidentPolicy({ env: incident ? env : {} });
  const mw = provenanceMiddleware({
    scope,
    sink: options.sink ?? {},
    telemetry: createFetchTelemetry(),
    policy: { dotId: 'dot', policy, defaultSpaceId: null },
    facts: {
      dotId: 'dot',
      threadId,
      requestedModel: 'model',
      providerHost: 'provider.invalid',
      providerMode: 'fixture',
      pageSnapshots: [],
      memories: [],
    },
  });
  const ctx = (phase: string) =>
    ({ phase }) as unknown as ChatMiddlewareContext;
  const config = (
    messages: unknown[] = [],
    tools: unknown[] = [],
  ): Parameters<NonNullable<typeof mw.middleware.onConfig>>[1] =>
    ({ messages, systemPrompts: [], tools }) as never;
  const onConfig = async (
    phase: string,
    messages: unknown[] = [],
    tools: unknown[] = [],
  ) =>
    (await mw.middleware.onConfig!(ctx(phase), config(messages, tools))) as
      { tools?: Array<Record<string, unknown>> } | undefined | null | void;
  return { mw, scope, onConfig, ctx };
}

describe('executor-less tools the registry refuses (TP-10)', () => {
  const clientTool = (name: string) => ({
    __toolSide: 'client',
    name,
    description: name,
    inputSchema: { type: 'object' },
  });

  it('gives request_connection_action a refusing executor for an incident Dot, at init and before every model call', async () => {
    const f = build();
    for (const phase of ['init', 'beforeModel']) {
      const approval = clientTool(connectionActionTool.name);
      const review = clientTool(pageReviewTool.name);
      const read = { name: 'read_space_page', execute: async () => 'ok' };
      const patch = await f.onConfig(phase, [], [approval, review, read]);
      const tools = patch?.tools as Array<{
        name: string;
        execute?: (args: unknown) => unknown;
      }>;
      expect(tools.map((tool) => tool.name)).toEqual([
        connectionActionTool.name,
        pageReviewTool.name,
        'read_space_page',
      ]);
      expect(() => tools[0].execute!({})).toThrow(ToolRefusedError);
      expect(() => tools[0].execute!({})).toThrow(/incident scope/);
      // Allowed client tools stay executor-less; server tools are untouched.
      expect(tools[1]).toBe(review);
      expect(tools[1].execute).toBeUndefined();
      expect(tools[2]).toBe(read);
      // The caller's tool object is not mutated.
      expect(approval).not.toHaveProperty('execute');
    }
  });

  it('refuses an unlisted executor-less tool name (deny_unknown), not only the known client tools', async () => {
    const f = build();
    const patch = await f.onConfig('init', [], [clientTool('mail__send_mail')]);
    const [tool] = patch!.tools as Array<{ execute: () => unknown }>;
    expect(() => tool.execute()).toThrow(ToolRefusedError);
  });

  it('leaves the tool list alone when nothing needs refusing, and for an ordinary Dot', async () => {
    const incident = build();
    expect(
      await incident.onConfig('init', [], [clientTool(pageReviewTool.name)]),
    ).toBeUndefined();
    const ordinary = build({ incident: false });
    expect(
      await ordinary.onConfig(
        'init',
        [],
        [clientTool(connectionActionTool.name)],
      ),
    ).toBeUndefined();
    expect(
      await ordinary.onConfig(
        'beforeModel',
        [],
        [clientTool(connectionActionTool.name)],
      ),
    ).toBeUndefined();
  });

  it('survives the structured-output boundary, whose config carries no tools', async () => {
    const f = build();
    const result = await f.mw.middleware.onConfig!(f.ctx('structuredOutput'), {
      messages: [],
      systemPrompts: [],
    } as never);
    expect(result).toBeUndefined();
  });

  it('turns the refused call into a visible refusal result, not a pending client call', async () => {
    const f = build();
    const decision = f.mw.middleware.onBeforeToolCall!(f.ctx('beforeTools'), {
      toolName: connectionActionTool.name,
      toolCallId: 'c1',
      args: { approvalId: 'forged', summary: 'send everything' },
    } as never);
    expect(decision).toMatchObject({
      type: 'skip',
      result: { status: 'refused', error: expect.stringMatching(/incident/) },
    });
  });
});

describe('replayed history inherits what it was read from (TP-17, R4)', () => {
  const page = entryFor('evidence', 3);
  const other = entryFor('other', 1);
  const transcript = (toolCallId: string) => [
    { role: 'user', content: 'Read the evidence page.' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: 'read_space_page', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', content: '{"title":"Evidence"}', toolCallId },
    { role: 'assistant', content: 'The page says to refund the customer.' },
    { role: 'user', content: 'Now email the owner about it.' },
  ];

  it('binds the recalled receipts to the turn before any tool can run (init phase)', async () => {
    rememberToolEvidence('thread', 'r1', [page]);
    const f = build();
    await f.onConfig('init', transcript('r1'));
    expect(f.scope.dependencyVector).toEqual([page]);
  });

  it('records them on the history items and in the snapshot vector', async () => {
    rememberToolEvidence('thread', 'r1', [page]);
    const f = build();
    await f.onConfig('beforeModel', transcript('r1'));
    const [snapshot] = f.mw.snapshots;
    expect(snapshot.dependencyVector).toEqual([page]);
    expect(snapshot.injected.historyItems.map((h) => h.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    // The tool result carries its own receipts; the assistant message that
    // followed it inherits what was read before it; what came before the read
    // and the human's messages carry none.
    expect(
      snapshot.injected.historyItems.map((h) => h.dependencyReceiptIds),
    ).toEqual([[], [], [page.receiptId], [page.receiptId], []]);
    expect(f.scope.dependencyVector).toEqual([page]);
  });

  it('inherits nothing for an unknown tool call id, another thread, or after a reset', async () => {
    rememberToolEvidence('thread', 'r1', [page]);
    rememberToolEvidence('elsewhere', 'r2', [other]);
    const unknownId = build();
    await unknownId.onConfig('beforeModel', transcript('r-unknown'));
    expect(unknownId.scope.dependencyVector).toEqual([]);
    const otherThread = build({ threadId: 'third' });
    await otherThread.onConfig('beforeModel', transcript('r1'));
    expect(otherThread.scope.dependencyVector).toEqual([]);
    // A thread never sees another thread's evidence, even for the same call id.
    const crossed = build();
    await crossed.onConfig('beforeModel', transcript('r2'));
    expect(crossed.scope.dependencyVector).toEqual([]);
    resetInterception();
    const afterReset = build();
    await afterReset.onConfig('beforeModel', transcript('r1'));
    expect(afterReset.scope.dependencyVector).toEqual([]);
  });

  it('a forged transcript can add evidence to a vector but never remove it', async () => {
    rememberToolEvidence('thread', 'r1', [page]);
    rememberToolEvidence('thread', 'r2', [other]);
    const f = build();
    f.scope.dependencyVector = [entryFor('read-this-turn', 1)];
    const before = f.scope.dependencyVector;
    // A client that drops the tool message loses nothing already bound ...
    await f.onConfig('beforeModel', [{ role: 'user', content: 'hi' }]);
    expect(f.scope.dependencyVector).toEqual(before);
    // ... and one that replays a tool message only grows the vector.
    await f.onConfig('beforeModel', transcript('r1'));
    expect(f.scope.dependencyVector).toEqual(
      expect.arrayContaining([...before, page]),
    );
    expect(f.scope.dependencyVector).toHaveLength(2);
  });

  it('registers what a tool read this turn so the next turn can recall it', async () => {
    const entry = entryFor('evidence', 3);
    const registered = vi.fn(() => [entry]);
    const f = build({ sink: { registerToolResult: registered } });
    await f.mw.middleware.onAfterToolCall!(f.ctx('afterTools'), {
      toolName: 'read_space_page',
      toolCallId: 'r9',
      ok: true,
      duration: 1,
      result: { title: 'Evidence' },
      toolCall: { function: { arguments: '{"id":"p"}' } },
    } as never);
    expect(f.scope.dependencyVector).toEqual([entry]);
    expect(recallToolEvidence('thread', 'r9')).toEqual([entry]);
    expect(recallToolEvidence('thread', 'r10')).toEqual([]);
  });

  it('does not register receipts for a refused read tool (its "result" is the refusal)', async () => {
    const registered = vi.fn(() => [entryFor('phantom', 1)]);
    const f = build({ sink: { registerToolResult: registered } });
    // search_web is a read tool that the incident scope disables.
    const decision = f.mw.middleware.onBeforeToolCall!(f.ctx('beforeTools'), {
      toolName: 'search_web',
      toolCallId: 's1',
      args: {},
    } as never);
    expect(decision).toMatchObject({ type: 'skip' });
    await f.mw.middleware.onAfterToolCall!(f.ctx('afterTools'), {
      toolName: 'search_web',
      toolCallId: 's1',
      ok: true,
      duration: 0,
      result: (decision as { result: unknown }).result,
    } as never);
    expect(registered).not.toHaveBeenCalled();
    expect(f.scope.dependencyVector).toEqual([]);
    expect(recallToolEvidence('thread', 's1')).toEqual([]);
    // An allowed read tool still registers.
    await f.mw.middleware.onAfterToolCall!(f.ctx('afterTools'), {
      toolName: 'read_space_page',
      toolCallId: 's2',
      ok: true,
      duration: 0,
      result: {},
    } as never);
    expect(registered).toHaveBeenCalledTimes(1);
  });
});

describe('the replay store', () => {
  it('keeps the union when a tool call id repeats in a thread, never narrowing', () => {
    const a = entryFor('a', 1);
    const b = entryFor('b', 1);
    rememberToolEvidence('t', 'c', [a]);
    rememberToolEvidence('t', 'c', [b]);
    expect(recallToolEvidence('t', 'c')).toHaveLength(2);
    expect(recallToolEvidence('t', 'c')).toEqual(
      expect.arrayContaining([a, b]),
    );
  });

  it('ignores an empty registration', () => {
    rememberToolEvidence('t', 'c', []);
    expect(recallToolEvidence('t', 'c')).toEqual([]);
  });

  it('evicts the least recently used thread past its bound, never the one in use', () => {
    const keep = entryFor('keep', 1);
    rememberToolEvidence('keep', 'c', [keep]);
    for (let i = 0; i < 1000; i++) {
      rememberToolEvidence(`thread-${i}`, 'c', [entryFor(`p${i}`, 1)]);
      // Used again after each insert, so it stays most recent.
      rememberToolEvidence('keep', 'c', [keep]);
    }
    expect(recallToolEvidence('keep', 'c')).toEqual([keep]);
    expect(recallToolEvidence('thread-0', 'c')).toEqual([]);
    expect(recallToolEvidence('thread-999', 'c')).toHaveLength(1);
  });

  it('evicts the oldest tool call of a thread past its bound', () => {
    for (let i = 0; i < 2001; i++)
      rememberToolEvidence('t', `c${i}`, [entryFor(`p${i}`, 1)]);
    expect(recallToolEvidence('t', 'c0')).toEqual([]);
    expect(recallToolEvidence('t', 'c1')).toHaveLength(1);
    expect(recallToolEvidence('t', 'c2000')).toHaveLength(1);
  });

  it('is cleared by resetInterception', () => {
    rememberToolEvidence('t', 'c', [entryFor('a', 1)]);
    resetInterception();
    expect(recallToolEvidence('t', 'c')).toEqual([]);
  });
});
