import { describe, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { pageReviewTool } from '../../../src/shared/page-review.js';
import { connectionActionTool } from '../../../src/shared/connection-types.js';
import {
  ContextSnapshotSchema,
  ModelCallRecordSchema,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  createToolPolicy,
  derivedUuid,
  setActivePolicy,
  setInterceptionRuntime,
  type ActivePolicy,
} from '../../../src/server/nemodots/interception/index.js';
import {
  attachPage,
  dotFixture,
  recordingRuntime,
  textResponse,
  toolCallResponse,
} from './helpers.js';

const run = (f: ReturnType<typeof dotFixture>, input = f.input) =>
  lastValueFrom(f.agent.run(input).pipe(toArray())) as Promise<BaseEvent[]>;

describe('provenance snapshot recording', () => {
  it('records a snapshot with page revision, memory ids, history digests and tool schema hash', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    f.store.saveMemory('Prefer short answers.', 'memory-1');
    const { runtime, calls, errors } = recordingRuntime();
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(textResponse('Done.'));

    await run(f);

    expect(errors).toEqual([]);
    expect(calls).toHaveLength(1);
    const { record, snapshot } = calls[0].input;
    // The contracts accept what was recorded.
    expect(ModelCallRecordSchema.safeParse(record).success).toBe(true);
    expect(ContextSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(record.contextSnapshotId).toBe(snapshot.id);
    expect(record.provider).toEqual({
      host: 'unused.invalid',
      mode: 'fixture',
    });
    expect(record.model).toEqual({
      requested: 'custom-model',
      returned: 'custom-model',
    });
    expect(record.outcome).toBe('completed');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({
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
    expect(record.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.scope.resource).toBe(`opendots.dot/${f.dot.id}`);

    expect(snapshot.injected.pageSnapshots).toEqual([
      {
        pageId: page.id,
        revision: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(snapshot.injected.memories).toEqual([
      { id: 'memory-1', digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(snapshot.injected.historyItems).toEqual([
      {
        role: 'user',
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        dependencyReceiptIds: [],
      },
    ]);
    expect(snapshot.toolSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.prefixDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.prefixLength).toBeLessThanOrEqual(snapshot.contextLength);
    // The receipts behind the page and the memory are in the vector.
    expect(snapshot.dependencyVector.map((e) => e.sourceKey).sort()).toEqual(
      [`opendots.memory/memory-1`, `opendots.page/${page.id}`].sort(),
    );
    expect(snapshot.injected.receipts.map((r) => r.id).sort()).toEqual(
      snapshot.dependencyVector.map((e) => e.receiptId).sort(),
    );
    expect(record.outputDependencyVector).toEqual(snapshot.dependencyVector);
    expect(calls[0].info.incident).toBe(false);
    expect(calls[0].info.unresolved).toEqual([]);
  });

  it('records one call per model iteration and chains tool reads into the next snapshot', async () => {
    const f = dotFixture();
    const { runtime, calls } = recordingRuntime();
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toolCallResponse('create_space_page', {
          title: 'Notes',
          content: '# Notes',
        }),
      )
      .mockResolvedValueOnce(textResponse('Created.'));

    await run(f);

    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => c.input);
    expect(first.record.outcome).toBe('tool_calls');
    expect(first.record.toolCalls).toEqual([
      {
        toolCallId: 'call-create_space_page',
        name: 'create_space_page',
        argumentsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(second.record.outcome).toBe('completed');
    const created = f.workspace.pages
      .list(f.dot.spaceId)
      .find((p) => p.title === 'Notes')!;
    // The page the model just created is evidence for the second call, and
    // it arrives as the tool message of the history.
    expect(second.snapshot.dependencyVector.map((e) => e.sourceKey)).toContain(
      `opendots.page/${created.id}`,
    );
    const toolItem = second.snapshot.injected.historyItems.find(
      (item) => item.role === 'tool',
    );
    expect(toolItem?.dependencyReceiptIds).toEqual([
      derivedUuid(`receipt:opendots.page/${created.id}:1`),
    ]);
    expect(first.snapshot.id).not.toBe(second.snapshot.id);
    expect(calls[1].info.toolActivity).toEqual([
      expect.objectContaining({
        toolName: 'create_space_page',
        ok: true,
        refused: false,
        resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        argumentsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it('marks evidence without a receipt as unresolved instead of claiming a binding', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    const { runtime, calls } = recordingRuntime({ resolveReceipt: () => null });
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(textResponse('Done.'));
    await run(f);
    expect(calls[0].input.snapshot.dependencyVector).toEqual([]);
    expect(calls[0].info.unresolved).toContain(`opendots.page/${page.id}`);
  });

  it('keeps the turn alive when the sink or the resolver fails', async () => {
    const f = dotFixture();
    attachPage(f);
    const { runtime, errors } = recordingRuntime({
      recordModelCall: () => {
        throw new Error('ledger down');
      },
      resolveReceipt: () => {
        throw new Error('resolver down');
      },
    });
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(textResponse('Done.'));
    const events = await run(f);
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(errors.map((e) => e.where)).toEqual(
      expect.arrayContaining(['resolveReceipt', 'recordModelCall']),
    );
  });
});

describe('receipt queries', () => {
  it('give the prompt page and the read_space_page result the same digest for an unchanged revision', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    const queries: Array<{ sourceKey: string; contentDigest: string }> = [];
    const { runtime } = recordingRuntime({
      resolveReceipt: (query) => {
        queries.push(query);
        return null;
      },
    });
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toolCallResponse('read_space_page', { id: page.id }),
      )
      .mockResolvedValueOnce(textResponse('Read it.'));
    await run(f);
    const digests = queries
      .filter((q) => q.sourceKey === `opendots.page/${page.id}`)
      .map((q) => q.contentDigest);
    expect(digests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(digests).size).toBe(1);
  });
});

describe('incident Dot tool refusal', () => {
  const editCall = (page: { id: string; revision: number }) =>
    toolCallResponse('edit_space_page', {
      id: page.id,
      content: 'Overwritten by the model.',
      expectedRevision: page.revision,
    });

  it('gives edit_space_page a visible tool error and leaves the page unchanged', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    const { runtime, calls } = recordingRuntime();
    setInterceptionRuntime(runtime);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(editCall(page))
      .mockResolvedValueOnce(textResponse('I could not edit the page.'));

    const events = await run(f);

    const after = f.workspace.pages.get(f.dot.spaceId, page.id);
    expect(after.revision).toBe(page.revision);
    expect(after.content).toBe(page.content);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: 'call-edit_space_page',
          content: expect.stringContaining('Refused by NemoDots policy'),
        }),
      ]),
    );
    // The model sees the refusal in its next request.
    const continuation = JSON.parse(String(network.mock.calls[1][1]?.body));
    expect(continuation.messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call-edit_space_page',
        content: expect.stringContaining('Refused by NemoDots policy'),
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].info.incident).toBe(true);
    expect(calls[1].info.refusals).toEqual([
      expect.objectContaining({
        toolName: 'edit_space_page',
        code: 'policy_checked_refused',
        layer: 'middleware',
      }),
    ]);
    expect(calls[1].info.toolActivity[0]).toMatchObject({
      toolName: 'edit_space_page',
      refused: true,
    });
  });

  it('refuses at the executor layer even when no runtime is installed', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(editCall(page))
      .mockResolvedValueOnce(textResponse('Refused.'));
    const events = await run(f);
    expect(f.workspace.pages.get(f.dot.spaceId, page.id).content).toBe(
      page.content,
    );
    expect(
      events.find((e) => e.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({
      content: expect.stringContaining('Refused by NemoDots'),
    });
  });

  it('still lets an incident Dot read pages', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toolCallResponse('read_space_page', { id: page.id }),
      )
      .mockResolvedValueOnce(textResponse('Read it.'));
    const events = await run(f);
    expect(
      events.find((e) => e.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({ content: expect.stringContaining('Runbook') });
  });

  it('applies to listed Dots only: the same edit succeeds for another Dot', async () => {
    const f = dotFixture();
    const page = attachPage(f);
    setActivePolicy(createToolPolicy({ incidentDotIds: ['some-other-dot'] }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(editCall(page))
      .mockResolvedValueOnce(textResponse('Edited.'));
    await run(f);
    expect(f.workspace.pages.get(f.dot.spaceId, page.id)).toMatchObject({
      content: 'Overwritten by the model.',
      revision: 2,
    });
  });
});

describe('zero impact when NemoDots is absent or idle', () => {
  const scenario = async (install: () => void) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
    try {
      const f = dotFixture();
      install();
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          toolCallResponse('create_space_page', {
            title: 'Same',
            content: 'x',
          }),
        )
        .mockResolvedValueOnce(textResponse('Created.'));
      const events = await run(f);
      return {
        events: events.map((e) => {
          const rest: Record<string, unknown> = { ...e };
          delete rest.timestamp;
          return rest as { type: string };
        }),
        // Space and page ids are random per fixture; everything else must match.
        bodies: network.mock.calls.map((c) =>
          String(c[1]?.body).replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
            '<uuid>',
          ),
        ),
        pages: f.workspace.pages.list(f.dot.spaceId).map((p) => p.title),
      };
    } finally {
      vi.useRealTimers();
      network_restore();
    }
  };
  const network_restore = () => vi.restoreAllMocks();

  it('sends byte-identical model requests and events with an idle policy and runtime', async () => {
    const baseline = await scenario(() => {});
    const idle = await scenario(() => {
      setActivePolicy(createToolPolicy({ incidentDotIds: [] }));
      setInterceptionRuntime(recordingRuntime().runtime);
    });
    expect(idle.pages).toEqual(baseline.pages);
    expect(idle.bodies).toEqual(baseline.bodies);
    expect(idle.events.map((e) => e.type)).toEqual(
      baseline.events.map((e) => e.type),
    );
    expect(baseline.pages).toContain('Same');
  });
});

describe('client tools stay client tools (I7)', () => {
  it('ends with a pending client tool call and no executor result', async () => {
    const f = dotFixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    const { runtime, calls } = recordingRuntime();
    setInterceptionRuntime(runtime);
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        toolCallResponse(
          'review_space_page',
          { title: 'Draft', content: '# Draft', spaceId: f.dot.spaceId },
          'review-1',
        ),
      );
    const before = f.workspace.pages.list(f.dot.spaceId);
    const events = await run(f, {
      ...f.input,
      tools: [{ name: pageReviewTool.name, description: 'x', parameters: {} }],
    });
    expect(network).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: 'review-1',
          toolCallName: pageReviewTool.name,
        }),
        expect.objectContaining({ type: EventType.RUN_FINISHED }),
      ]),
    );
    // Nothing executed it server-side: no result, no refusal, no page.
    expect(events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(
      false,
    );
    expect(f.workspace.pages.list(f.dot.spaceId)).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(calls[0].info.refusals).toEqual([]);
    expect(calls[0].input.record.outcome).toBe('tool_calls');
    expect(calls[0].input.record.toolCalls[0].name).toBe(pageReviewTool.name);
  });

  it('offers the approval tool as a client tool with a policy installed', async () => {
    const f = dotFixture();
    setActivePolicy(createToolPolicy({ incidentDotIds: [f.dot.id] }));
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(textResponse('Ready.'));
    await run(f, {
      ...f.input,
      tools: [
        { name: connectionActionTool.name, description: 'x', parameters: {} },
      ],
    });
    // The client tool is forwarded as the browser's tool, not given an executor.
    const body = JSON.parse(String(network.mock.calls[0][1]?.body)) as {
      tools: { function: { name: string } }[];
    };
    expect(body.tools.map((t) => t.function.name)).toContain(
      connectionActionTool.name,
    );
  });
});

describe('per-turn services consult the module-level policy (I5)', () => {
  // A policy that lets the tool layers through and refuses only at the
  // service boundary, so the test proves the per-turn instances ask it.
  const boundaryOnly = (dotId: string): ActivePolicy => {
    const real = createToolPolicy({ incidentDotIds: [dotId] });
    return { ...real, decideTool: () => ({ allow: true }) };
  };

  it('refuses a direct connected-service call on the per-turn ConnectionService', async () => {
    const f = dotFixture();
    f.workspace.connections.create(
      f.dot.id,
      { name: 'Mail', url: 'https://mail.example.invalid/mcp' },
      [
        {
          name: 'search_mail',
          title: 'Search',
          description: 'Search mail.',
          inputSchema: { type: 'object', properties: {} },
          readOnly: true,
          enabled: true,
          requiresApproval: false,
        },
      ],
    );
    setActivePolicy(boundaryOnly(f.dot.id));
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolCallResponse('mail__search_mail', {}))
      .mockResolvedValueOnce(textResponse('Refused.'));
    const events = await run(f);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as
      { content: string } | undefined;
    expect(result?.content).toContain('Refused by NemoDots policy');
    // No MCP request left the process: only the two model requests happened.
    expect(network).toHaveBeenCalledTimes(2);
    for (const call of network.mock.calls)
      expect(String(call[0])).toContain('unused.invalid/v1/chat/completions');
  });

  it('refuses a computer action on the per-turn ComputerService', async () => {
    const f = dotFixture({
      computerSupervisorUrl: 'https://supervisor.invalid',
      computerSupervisorToken: 'fixture',
      computerToken: 'fixture',
    });
    setActivePolicy(boundaryOnly(f.dot.id));
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(toolCallResponse('computer_snapshot', {}))
      .mockResolvedValueOnce(textResponse('Refused.'));
    const events = await run(f);
    const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT) as
      { content: string } | undefined;
    expect(result?.content).toContain('Refused by NemoDots policy');
    for (const call of network.mock.calls)
      expect(String(call[0])).not.toContain('supervisor.invalid');
    // Refused before the audit receipt was opened.
    expect(f.workspace.computers.audit(f.dot.id)).toEqual([]);
  });
});
