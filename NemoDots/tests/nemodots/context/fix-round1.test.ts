import { describe, expect, it } from 'vitest';
import { compileContext } from '../../../src/server/nemodots/context/compile.js';
import { outputDependencyVector } from '../../../src/server/nemodots/context/provenance.js';
import {
  baseInput,
  cacheReceipt,
  entry,
  healthReceipt,
  poolReceipt,
  receipt,
} from './fixtures.js';

describe('fix round 1', () => {
  it('attempt readset and inherited vectors stay in the snapshot vector even when not injected', () => {
    const [a, b, c] = [cacheReceipt(), poolReceipt(), healthReceipt()];
    const compiled = compileContext(
      baseInput({
        receipts: [a],
        readSetVector: [entry(a), entry(b)],
        inheritedVector: [entry(c)],
      }),
    );
    expect(compiled.snapshot.injected.receipts).toHaveLength(1);
    expect(
      compiled.snapshot.dependencyVector.map((e) => e.receiptId).sort(),
    ).toEqual([a.id, b.id, c.id].sort());
    const vector = outputDependencyVector({
      snapshot: compiled.snapshot,
      attempt: {
        readSetReceiptIds: [a.id, b.id],
        inheritedDependencyVector: [entry(c)],
      },
      cited: [],
    });
    expect(vector).toHaveLength(3);
  });

  it('redacts, caps and counts assistant tool call arguments', () => {
    const secret = `nvapi-${'a'.repeat(40)}`;
    const big = `{"k":"${secret}","pad":"${'x'.repeat(100_000)}"}`;
    const compiled = compileContext(
      baseInput({
        history: [
          {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 'call1', name: 'observe', arguments: big }],
            dependencyVector: [],
          },
        ],
      }),
    );
    const calls = compiled.messages.flatMap((m) =>
      m.role === 'assistant' ? (m.toolCalls ?? []) : [],
    );
    expect(calls[0].arguments).not.toContain('nvapi-');
    expect(calls[0].arguments.length).toBeLessThanOrEqual(4096);
    expect(compiled.truncations.map((t) => t.item)).toContain(
      'history:toolcall:call1',
    );
    expect(compiled.redactions).toBeGreaterThan(0);
    expect(compiled.snapshot.contextLength).toBeGreaterThan(4096);
  });

  it('redacts JSON-keyed secrets in receipt values', () => {
    const r = receipt(7, 'checkout.config/db.pool_size', 1, {
      OPENAI_API_KEY: 'plainSecretValue1234567890',
      apiKey: 'zzzzSECRETzzzz',
      nested: { password: 'hunter2hunter2', ok: 'visible' },
    });
    const compiled = compileContext(baseInput({ receipts: [r] }));
    expect(compiled.system).not.toContain('plainSecretValue1234567890');
    expect(compiled.system).not.toContain('zzzzSECRETzzzz');
    expect(compiled.system).not.toContain('hunter2hunter2');
    expect(compiled.system).toContain('visible');
    expect(compiled.redactions).toBeGreaterThanOrEqual(3);
  });

  it('redacts a quoted env name inside free text', () => {
    const compiled = compileContext(
      baseInput({
        memories: [
          {
            id: 'm1',
            text: '{"CRUSOE_API_KEY":"abcdefghijklmnop1234"}',
          },
        ],
      }),
    );
    expect(compiled.system).not.toContain('abcdefghijklmnop1234');
  });

  it('records a plan distinctly from a task_output with the same id', () => {
    const mk = (kind: 'plan' | 'task_output', deps: boolean) => ({
      kind,
      id: 'p1',
      digest: `${(kind === 'plan' ? 'a' : 'b').repeat(64)}`,
      text: kind,
      usable: true,
      dependencyVector: deps ? [entry(cacheReceipt())] : [],
    });
    const compiled = compileContext(
      baseInput({
        receipts: [cacheReceipt()],
        inheritedArtifacts: [mk('plan', false), mk('task_output', true)],
      }),
    );
    const ids = compiled.snapshot.injected.inheritedArtifacts.map((a) => a.id);
    expect(ids.sort()).toEqual(['p1', 'plan:p1']);
    expect(
      compiled.snapshot.injected.inheritedArtifacts.find(
        (a) => a.id === 'plan:p1',
      )?.dependencyReceiptIds,
    ).toEqual([]);
  });
});
