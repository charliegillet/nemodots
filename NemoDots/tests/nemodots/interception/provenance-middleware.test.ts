import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import {
  addToScopeVector,
  createProvenanceMiddleware,
  createTurnScope,
  currentDependencyVector,
  runInTurnScope,
  safeDigest,
  setInterceptionRuntime,
  toolSchemaHash,
  ALLOW_ALL_POLICY,
  createToolPolicy,
} from '../../../src/server/nemodots/interception/index.js';
import { dotFixture, recordingRuntime, textResponse } from './helpers.js';

const entry = (n: number) => ({
  sourceKey: 'checkout.health' as never,
  sourceRevision: n,
  receiptId: `5d6c7e0e-6f6a-4a55-9a64-0d1d4f5b7a${String(10 + n)}` as never,
});

describe('provenance scope', () => {
  it('is null outside a scope and carries the vector inside it', async () => {
    expect(currentDependencyVector()).toBeNull();
    const scope = createTurnScope({ dotId: 'd', threadId: 't', runId: 'r' });
    addToScopeVector(scope, [entry(2), entry(1)]);
    const seen = await runInTurnScope(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentDependencyVector();
    });
    expect(seen).toEqual([entry(1), entry(2)]);
    expect(currentDependencyVector()).toBeNull();
  });

  it('never shrinks, and is null while evidence is unresolved', () => {
    const scope = createTurnScope({ dotId: 'd', threadId: 't', runId: 'r' });
    addToScopeVector(scope, [entry(1)]);
    addToScopeVector(scope, [entry(1), entry(2)]);
    addToScopeVector(scope, []);
    expect(scope.vector).toEqual([entry(1), entry(2)]);
    scope.unresolved = ['opendots.page/x'];
    expect(runInTurnScope(scope, currentDependencyVector)).toBeNull();
  });

  it('isolates concurrent turns', async () => {
    const a = createTurnScope({ dotId: 'a', threadId: 't', runId: 'r' });
    const b = createTurnScope({ dotId: 'b', threadId: 't', runId: 'r' });
    addToScopeVector(a, [entry(1)]);
    addToScopeVector(b, [entry(2)]);
    const [va, vb] = await Promise.all([
      runInTurnScope(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentDependencyVector();
      }),
      runInTurnScope(b, async () => currentDependencyVector()),
    ]);
    expect(va).toEqual([entry(1)]);
    expect(vb).toEqual([entry(2)]);
  });
});

describe('toolSchemaHash', () => {
  const tool = (name: string, schema: z.ZodType) =>
    toolDefinition({ name, description: name, inputSchema: schema });
  it('is stable across order and changes with any schema change', () => {
    const a = tool('a', z.object({ x: z.string() }));
    const b = tool('b', z.object({}));
    expect(toolSchemaHash([a, b])).toBe(toolSchemaHash([b, a]));
    expect(toolSchemaHash([a, b])).not.toBe(
      toolSchemaHash([tool('a', z.object({ x: z.number() })), b]),
    );
    expect(toolSchemaHash([a])).not.toBe(toolSchemaHash([a, b]));
    expect(toolSchemaHash([a])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('safeDigest', () => {
  it('is canonical and tolerates undefined and cycles', () => {
    expect(safeDigest({ a: 1, b: 2 })).toBe(safeDigest({ b: 2, a: 1 }));
    expect(safeDigest(undefined)).toMatch(/^[0-9a-f]{64}$/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(safeDigest(cycle)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('model call outcomes through DotAgent', () => {
  it('records both HTTP attempts of a retried request under one model call', async () => {
    const f = dotFixture();
    const { runtime, calls } = recordingRuntime();
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'max_requests_limit' } }),
          {
            status: 429,
            headers: { 'retry-after': '0', 'x-request-id': 'req-1' },
          },
        ),
      )
      .mockResolvedValueOnce(textResponse('Second try worked.'));
    await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(calls).toHaveLength(1);
    const { attempts, outcome } = calls[0].input.record;
    expect(outcome).toBe('completed');
    expect(attempts.map((a) => [a.n, a.httpStatus])).toEqual([
      [1, 429],
      [2, 200],
    ]);
    expect(attempts[0]).toMatchObject({
      finishReason: 'error',
      error: { class: 'rate_limited', code: 'max_requests_limit' },
    });
  });

  it('records a failed call when the provider keeps failing', async () => {
    const f = dotFixture();
    const { runtime, calls } = recordingRuntime();
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 'boom' } }), {
          status: 500,
        }),
    );
    // The upstream agent surfaces the provider failure to its subscriber.
    await expect(
      lastValueFrom(f.agent.run(f.input).pipe(toArray())),
    ).rejects.toThrow('500');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = calls[calls.length - 1].input.record;
    expect(last.outcome).toBe('failed');
    expect(last.attempts.every((a) => a.httpStatus === 500)).toBe(true);
    expect(last.attempts[0].error?.class).toBe('provider_error');
  });

  it('records an aborted call with cancelled attempts and null usage when the owner pauses work', async () => {
    const f = dotFixture();
    const { runtime, calls } = recordingRuntime();
    setInterceptionRuntime(runtime);
    const started = new Promise<void>((ready) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('Expected an abort signal');
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
            ready();
          }),
      );
    });
    const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    await started;
    f.store.updateSettings({ paused: true });
    await finished;
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { record } = calls[0].input;
    expect(record.outcome).toBe('aborted');
    expect(record.attempts[0]).toMatchObject({
      finishReason: 'cancelled',
      usage: {
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
      },
    });
  });

  it('marks the provider mode the runtime declares, never a guessed one', async () => {
    const f = dotFixture();
    const { runtime, calls } = recordingRuntime({ providerMode: 'live' });
    setInterceptionRuntime(runtime);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(textResponse('x'));
    await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(calls[0].input.record.provider.mode).toBe('live');
  });

  it('records nothing without a runtime, even with a policy installed', async () => {
    const f = dotFixture();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(textResponse('x'));
    const handle = createProvenanceMiddleware({
      turn: {
        dotId: f.dot.id,
        threadId: 't',
        runId: 'r',
        model: 'm',
        providerHost: 'h',
      },
      scope: createTurnScope({ dotId: f.dot.id, threadId: 't', runId: 'r' }),
      policy: () => createToolPolicy({ incidentDotIds: [f.dot.id] }),
      pages: [],
      memories: [],
    });
    expect(handle.records).toEqual([]);
    expect(handle.middleware.onConfig).toBeTypeOf('function');
    // Enforcement still works in policy-only mode.
    const decision = await handle.middleware.onBeforeToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      args: {},
      toolName: 'edit_space_page',
      toolCallId: 'c1',
    });
    expect(decision).toMatchObject({ type: 'skip' });
  });

  it('lets everything through under the allow-all policy', async () => {
    const handle = createProvenanceMiddleware({
      turn: {
        dotId: 'd',
        threadId: 't',
        runId: 'r',
        model: 'm',
        providerHost: 'h',
      },
      scope: createTurnScope({ dotId: 'd', threadId: 't', runId: 'r' }),
      policy: () => ALLOW_ALL_POLICY,
      pages: [],
      memories: [],
    });
    expect(
      await handle.middleware.onBeforeToolCall!({} as never, {
        toolCall: {} as never,
        tool: undefined,
        args: {},
        toolName: 'anything_at_all',
        toolCallId: 'c1',
      }),
    ).toBeUndefined();
  });
});
