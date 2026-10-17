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
  findLeaks,
  hasCycle,
  preservedTaskIds,
  treeShape,
  type SnapshotLike,
} from './analysis.js';
import { startProvider } from './provider.js';
import { lastReceiptId, planReply, TWO_BRANCH_PLAN } from './scenarios.js';

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
});
