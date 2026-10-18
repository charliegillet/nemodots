/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAI wire payloads are untyped JSON */
// Gate 4 harness self-check. These tests exercise only verifier-owned code
// (scripted provider, SSE tail, snapshot analysis) with hand-enumerated
// expectations, so a later failure of a product case cannot be blamed on the
// harness. They do not touch production code.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventTail } from './api.js';
import {
  affectedTaskIds,
  fencingMonotonic,
  allMessageTexts,
  findLeaks,
  hasCycle,
  rolesMentioning,
  scanRequestsForLeaks,
  sha256,
  preservedTaskIds,
  treeShape,
  type SnapshotLike,
} from './analysis.js';
import { completionOf, startProvider } from './provider.js';
import {
  alphaProposer,
  lastReceiptId,
  newProposerState,
  planReply,
  receiptIdAt,
  TWO_BRANCH_PLAN,
} from './scenarios.js';
import { SPEC_ROLE_CAPABILITIES, specDigest } from './spec.js';

const R_OLD = randomUUID();
const R_OTHER = randomUUID();
const att = (
  taskId: string,
  n: number,
  token: number,
  read: string[],
  inh: string[] = [],
) => ({
  id: randomUUID(),
  taskId,
  n,
  kind: 'initial',
  status: 'published',
  readSetReceiptIds: read,
  inheritedDependencyVector: inh.map((receiptId) => ({ receiptId })),
  repairOf: null,
  abortReason: null,
  lease: { fencingToken: token },
});
const task = (
  id: string,
  parentId: string | null,
  depth: number,
  prereq: string[] = [],
) => ({
  id,
  parentId,
  depth,
  role: 'investigator',
  title: id,
  capabilities: ['observe'],
  prerequisites: prereq,
  justification: parentId ? 'because' : null,
  createdByModelCallId: null,
  attemptCount: 1,
  status: 'succeeded',
});

describe('g4 harness self-check', () => {
  it('closure: A reads the changed receipt, V inherits A, B is independent (hand enumerated)', () => {
    const snap: SnapshotLike = {
      tasks: [
        task('A', null, 0),
        task('B', null, 0),
        task('V', null, 0, ['A']),
      ],
      attempts: [
        att('A', 1, 1, [R_OLD]),
        att('B', 1, 1, [R_OTHER]),
        att('V', 1, 1, [R_OTHER], [R_OLD]),
      ],
      outputs: [],
      receipts: [],
    };
    expect([...affectedTaskIds(snap, R_OLD)].sort()).toEqual(['A', 'V']);
    expect([...preservedTaskIds(snap, R_OLD)]).toEqual(['B']);
  });

  it('closure: a scheduling-only dependency does not propagate (rule R1)', () => {
    const snap: SnapshotLike = {
      tasks: [task('A', null, 0), task('W', null, 0, ['A'])],
      attempts: [att('A', 1, 1, [R_OLD]), att('W', 1, 1, [R_OTHER])],
      outputs: [],
      receipts: [],
    };
    expect([...affectedTaskIds(snap, R_OLD)]).toEqual(['A']);
  });

  it('shape, cycle and fencing helpers agree with hand-drawn trees', () => {
    const snap: SnapshotLike = {
      tasks: [
        task('r', null, 0),
        task('c1', 'r', 1),
        task('c2', 'r', 1),
        task('g', 'c1', 2),
      ],
      attempts: [
        att('r', 1, 3, []),
        att('r', 2, 4, []),
        att('c1', 1, 1, []),
        att('c1', 2, 1, []),
      ],
      outputs: [],
      receipts: [],
    };
    expect(treeShape(snap)).toEqual({ total: 4, maxDepth: 2, maxBreadth: 2 });
    expect(hasCycle(snap)).toBe(false);
    expect(
      hasCycle({
        ...snap,
        tasks: [task('x', null, 0, ['y']), task('y', null, 0, ['x'])],
      }),
    ).toBe(true);
    expect(fencingMonotonic(snap)).toBe(false); // c1 reused token 1
  });

  it('leak scanner flags diagnosis machinery and ignores ordinary evidence', () => {
    expect(findLeaks(['cache_decode_error expected 7 found 6'])).toEqual([]);
    expect(
      findLeaks(['the injector changed cache.schema_version']).length,
    ).toBeGreaterThan(0);
    expect(findLeaks(['value is 7'], ['7-secret-seed'])).toEqual([]);
  });

  it('SSE tail dedupes by id, keeps commit order and rejects payloads outside the contract', () => {
    const tail = new EventTail('http://127.0.0.1:1/none', 0);
    const missionId = randomUUID();
    const frame = (id: number, extra: Record<string, unknown> = {}) =>
      `id: ${id}\ndata: ${JSON.stringify({ id, missionId, kind: 'heartbeat', at: new Date().toISOString(), payload: { kind: 'heartbeat', ...extra } })}`;
    tail.accept(frame(1));
    tail.accept(frame(2));
    tail.accept(frame(2));
    tail.accept(frame(3, { control: 'leak' }));
    expect(tail.events.map((e) => e.id)).toEqual([1, 2]);
    expect(tail.duplicatesDropped).toBe(1);
    expect(tail.parseErrors).toHaveLength(1);
    expect(tail.outOfOrder).toBe(0);
  });

  it('scripted provider speaks both streaming and non-streaming chat completions', async () => {
    const provider = await startProvider({
      port: 0,
      model: 'stub-model',
      script: (call) =>
        call.kind === 'structured'
          ? planReply(TWO_BRANCH_PLAN)
          : {
              type: 'tool_calls',
              calls: [
                {
                  name: 'observe_source',
                  args: { sourceKey: 'checkout.health' },
                },
              ],
            },
    });
    try {
      const post = (body: object) =>
        fetch(`${provider.url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const plain = await (
        await post({
          model: 'stub-model',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).json();
      expect(JSON.parse(plain.choices[0].message.content).tasks).toHaveLength(
        3,
      );
      const worker = await (
        await post({
          model: 'stub-model',
          messages: [{ role: 'user', content: 'x' }],
          tools: [
            {
              type: 'function',
              function: { name: 'observe_source', parameters: {} },
            },
          ],
        })
      ).json();
      expect(worker.choices[0].message.tool_calls[0].function.name).toBe(
        'observe_source',
      );
      const stream = await (
        await post({
          model: 'stub-model',
          stream: true,
          messages: [
            { role: 'tool', content: JSON.stringify({ receiptId: R_OLD }) },
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'observe_source', parameters: {} },
            },
          ],
        })
      ).text();
      expect(stream).toContain('"tool_calls"');
      expect(stream.trim().endsWith('[DONE]')).toBe(true);
      const models = await (await fetch(`${provider.url}/models`)).json();
      expect(models.data[0].id).toBe('stub-model');
      expect(provider.calls).toHaveLength(3);
      expect(
        lastReceiptId({
          toolMessages: [{ receiptId: R_OLD, revision: 4 }],
        } as never),
      ).toBe(R_OLD);
      expect(lastReceiptId({ toolMessages: [] } as never)).toBeNull();
    } finally {
      await provider.close();
    }
  });

  it('spec digest matches externally computed SHA-256 of the canonical JSON', () => {
    // computed with `shasum -a 256` over the exact canonical text
    expect(specDigest(5)).toBe(
      'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
    );
    expect(specDigest({ b: [true, 'x'], a: 1, z: undefined })).toBe(
      '63e8063d9dc6f0fd5a24b4706818a165fd57c3531b74466cf5dea62bff09b0b6',
    );
  });

  it('spec role table is the CONTRACTS section 4 table (verifier proposes nothing, specialists cannot be created by an investigator)', () => {
    expect(SPEC_ROLE_CAPABILITIES.planner).toEqual([]);
    expect(SPEC_ROLE_CAPABILITIES.verifier).toEqual([
      'observe',
      'publish_finding',
    ]);
    expect(SPEC_ROLE_CAPABILITIES.investigator).not.toContain(
      'propose_config_change',
    );
    expect(SPEC_ROLE_CAPABILITIES.cache_specialist).toContain(
      'propose_cache_flush',
    );
    expect(SPEC_ROLE_CAPABILITIES.routing_specialist).not.toContain(
      'propose_cache_flush',
    );
  });

  it('leak scan covers every role, honours only a digest allowlist, and ignores contract field names', () => {
    const body = (role: string, text: string) => ({
      messages: [{ role, content: text }],
    });
    expect(
      scanRequestsForLeaks([
        body('user', 'ownerId actor provenance owner_edit'),
      ]),
    ).toEqual([]);
    expect(
      scanRequestsForLeaks([body('system', 'the injector rewrote it')]),
    ).toEqual(['system:\\binjector\\b']);
    expect(
      scanRequestsForLeaks(
        [body('system', 'the injector rewrote it')],
        [],
        new Set([sha256('the injector rewrote it')]),
      ),
    ).toEqual([]);
    expect(
      scanRequestsForLeaks([body('assistant', 'see control.runs')]),
    ).toEqual(['assistant:\\bcontrol\\.']);
    const replay = {
      messages: [
        { role: 'system', content: 'static' },
        { role: 'assistant', content: 'earlier saw ' + R_OLD },
        { role: 'tool', content: JSON.stringify({ receiptId: R_OTHER }) },
      ],
    };
    expect(rolesMentioning(replay, [R_OLD])).toEqual(['assistant']);
    expect(allMessageTexts(replay).map((m) => m.role)).toEqual([
      'system',
      'assistant',
      'tool',
    ]);
  });

  it('alphaProposer is admissible by construction: cites both receipts, binds the stored digest, proposes once', () => {
    const state = newProposerState();
    state.value = 6;
    state.currentDigest = specDigest(5);
    const script = alphaProposer(state);
    const call = (toolResults: number, names: string[], tool: unknown[]) =>
      ({
        text: 'ALPHA-cache-branch',
        toolResults,
        toolCallNames: names,
        toolMessages: tool,
      }) as never;
    expect((script(call(0, [], [])) as any).calls[0].args.sourceKey).toBe(
      'checkout.config/cache.schema_version',
    );
    expect(
      (script(call(1, ['observe_source'], [{ receiptId: R_OLD }])) as any)
        .calls[0].args.sourceKey,
    ).toBe('checkout.health');
    const proposal = script(
      call(
        2,
        ['observe_source', 'observe_source'],
        [{ receiptId: R_OLD }, { receiptId: R_OTHER }],
      ),
    ) as any;
    const args = proposal.calls[0].args;
    expect(args.action).toBe('set_config');
    expect(args.payload.expectedCurrentValueDigest).toBe(specDigest(5));
    expect(args.supportingReceiptIds).toEqual([R_OLD, R_OTHER]);
    expect(state.proposals).toBe(1);
    // a later attempt (retry or repair) does not propose again
    expect(
      (script(call(1, ['observe_source'], [{ receiptId: R_OLD }])) as any)
        .calls[0].name,
    ).toBe('publish_finding');
    expect(
      receiptIdAt({ toolMessages: [{ receiptId: R_OLD }] } as never, 1),
    ).toBeNull();
  });

  it('provider honours explicit tool call ids, records X-Request-Id and peak concurrency, and parses both response shapes', async () => {
    const provider = await startProvider({
      port: 0,
      model: 'stub-model',
      script: (call) =>
        call.n <= 2
          ? {
              type: 'tool_calls',
              calls: [
                {
                  id: 'call_fixed',
                  name: 'publish_finding',
                  args: { claim: 'a' },
                },
              ],
              delayMs: 150,
            }
          : { type: 'content', text: 'hello' },
    });
    try {
      const post = (body: object, requestId: string) =>
        fetch(`${provider.url}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-request-id': requestId,
          },
          body: JSON.stringify(body),
        });
      const tools = [
        { type: 'function', function: { name: 'x', parameters: {} } },
      ];
      const base = {
        model: 'stub-model',
        tools,
        messages: [{ role: 'user', content: 'q' }],
      };
      const [first, second] = await Promise.all([
        post(base, 'req-1').then((r) => r.json()),
        post({ ...base, stream: true }, 'req-2').then((r) => r.text()),
      ]);
      expect(first.choices[0].message.tool_calls[0].id).toBe('call_fixed');
      expect(second).toContain('call_fixed');
      expect(provider.peakInFlight, 'two overlapping requests').toBe(2);
      await post({ model: 'stub-model', messages: [] }, 'req-3').then((r) =>
        r.json(),
      );
      expect(provider.calls.map((c) => c.requestId)).toEqual([
        'req-1',
        'req-2',
        'req-3',
      ]);
      expect(provider.inFlight).toBe(0);
      expect(completionOf(provider.calls[0])).toEqual({
        content: '',
        toolCalls: [
          { id: 'call_fixed', name: 'publish_finding', args: { claim: 'a' } },
        ],
      });
      // pass-through shaped records: JSON and an accumulated SSE stream
      const json = {
        ...provider.calls[2],
        scripted: null,
        responseText: JSON.stringify({
          choices: [
            {
              message: {
                content: 'plan',
                tool_calls: [
                  {
                    id: 'c1',
                    function: {
                      name: 'delegate_task',
                      arguments: '{"title":"T"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
      expect(completionOf(json)).toEqual({
        content: 'plan',
        toolCalls: [{ id: 'c1', name: 'delegate_task', args: { title: 'T' } }],
      });
      const sse = {
        ...json,
        responseText: [
          'data: {"choices":[{"delta":{"content":"he"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"llo","tool_calls":[{"index":0,"id":"c9","function":{"name":"observe_source","arguments":"{\\"sourceKey\\":"}}]}}]}',
          '',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"checkout.health\\"}"}}]}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      };
      expect(completionOf(sse)).toEqual({
        content: 'hello',
        toolCalls: [
          {
            id: 'c9',
            name: 'observe_source',
            args: { sourceKey: 'checkout.health' },
          },
        ],
      });
    } finally {
      await provider.close();
    }
  });
});
