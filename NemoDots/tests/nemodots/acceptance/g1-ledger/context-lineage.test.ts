// Gate 1 items 6 and 7: context compilation lineage and stale-premise
// re-entry. The pure compiler is driven with inputs written here (not the
// builders' fixtures); the DB-backed test then uses real receipts, a real
// supersession, and the ledger's support check on the snapshot's own vector.
import { describe, expect, it } from 'vitest';
import {
  compileContext,
  selectInheritedArtifacts,
  selectReceiptsForTask,
  type CompileContextInput,
  type ContextReceipt,
} from '../../../../src/server/nemodots/context/index.js';
import type {
  ContextSnapshotId,
  DependencyEntry,
  InvalidationEventId,
  ReceiptId,
  SourceKey,
} from '../../../../src/server/nemodots/contracts/index.js';
import { World } from './driver.js';
import { withAccDatabase } from './harness.js';

const HEX = (n: number) => n.toString(16).padStart(64, '0');
const uuid = (n: number) =>
  `a1b2c3d4-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-10-17T18:00:00.000Z';

function receipt(
  n: number,
  key: string,
  revision: number,
  value: unknown,
  extra: Partial<ContextReceipt> = {},
): ContextReceipt {
  return {
    id: uuid(n) as ReceiptId,
    source: { key: key as SourceKey },
    sourceRevision: revision,
    collectionRevision: null,
    observedAt: NOW,
    lastConfirmedAt: NOW,
    contentDigest: HEX(n),
    normalizedValue: value,
    status: 'supported',
    trust: 'controlled_authority',
    negative: null,
    ...extra,
  };
}
const dep = (r: ContextReceipt): DependencyEntry => ({
  sourceKey: r.source.key,
  sourceRevision: r.sourceRevision,
  receiptId: r.id,
});

function input(overrides: Partial<CompileContextInput> = {}): CompileContextInput {
  return {
    snapshotId: uuid(900) as ContextSnapshotId,
    layout: 'cache_aware',
    nowIso: NOW,
    commonInstructions: 'You are an incident responder.',
    roleInstructions: 'Role: investigator.',
    task: { title: 'Find the cause', question: 'Why do checkouts fail?' },
    runbooks: [],
    receipts: [],
    inheritedArtifacts: [],
    pageSnapshots: [],
    memories: [],
    invalidations: [],
    history: [],
    ...overrides,
  };
}

describe('[G1.6] context compilation records every injected premise', () => {
  const pool = receipt(1, 'checkout.config/db.pool_max', 3, { value: 3 });
  const health = receipt(2, 'checkout.health', 4, { status: 'degraded' }, { trust: 'observed_tool' });
  const hidden = receipt(3, 'checkout.metrics', 2, { errorClasses: ['pool_timeout'] }, { trust: 'observed_tool' });

  const compiled = compileContext(
    input({
      runbooks: [{ id: 'pool-runbook', title: 'Pools', text: 'Raise pool_max carefully.' }],
      receipts: [pool, health],
      inheritedArtifacts: [
        { kind: 'handoff', id: 'h-1', digest: HEX(11), text: 'handoff text', usable: true, dependencyVector: [dep(pool)] },
        { kind: 'summary', id: 's-1', digest: HEX(12), text: 'summary text', usable: true, dependencyVector: [dep(health)] },
        { kind: 'finding', id: 'f-1', digest: HEX(13), text: 'finding text', usable: true, dependencyVector: [dep(pool)] },
        { kind: 'task_output', id: 'o-1', digest: HEX(14), text: 'output text', usable: true, dependencyVector: [dep(health)] },
      ],
      pageSnapshots: [{ pageId: 'page-7', revision: 5, text: 'page prose', dependencyVector: [] }],
      memories: [{ id: 'mem-1', text: 'a remembered fact', dependencyVector: [] }],
      invalidations: [{ id: HEX(77) as InvalidationEventId, summary: 'pool_max changed' }],
      history: [
        { role: 'user', content: 'start', dependencyVector: [] },
        { role: 'assistant', content: 'calling', toolCalls: [{ id: 'tc1', name: 'observe_source', arguments: '{}' }], dependencyVector: [dep(pool)] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'tc1', toolName: 'observe_source', dependencyVector: [dep(pool)] },
      ],
      // Read by the attempt but never injected (e.g. dropped by the byte budget):
      readSetVector: [dep(hidden)],
    }),
  );
  const inj = compiled.snapshot.injected;

  it('[G1.6] every injected observation is listed with its source revision and digest', () => {
    expect(inj.receipts.map((r) => [r.id, r.sourceKey, r.sourceRevision, r.contentDigest]).sort()).toEqual(
      [
        [pool.id, 'checkout.config/db.pool_max', 3, pool.contentDigest],
        [health.id, 'checkout.health', 4, health.contentDigest],
      ].sort(),
    );
  });

  it('[G1.6] inherited handoff, summary, finding and task output are each recorded with digest and receipt dependencies', () => {
    const byId = Object.fromEntries(inj.inheritedArtifacts.map((a) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(['f-1', 'h-1', 'o-1', 's-1']);
    expect(byId['h-1']).toMatchObject({ kind: 'handoff', digest: HEX(11), dependencyReceiptIds: [pool.id] });
    expect(byId['s-1']).toMatchObject({ kind: 'summary', digest: HEX(12), dependencyReceiptIds: [health.id] });
    expect(byId['f-1']).toMatchObject({ kind: 'finding', digest: HEX(13) });
    expect(byId['o-1']).toMatchObject({ kind: 'task_output', digest: HEX(14) });
  });

  it('[G1.6] page snapshot, memory, runbook, invalidation event and history items are recorded', () => {
    expect(inj.pageSnapshots).toEqual([expect.objectContaining({ pageId: 'page-7', revision: 5 })]);
    expect(inj.memories.map((m) => m.id)).toEqual(['mem-1']);
    expect(inj.runbooks.map((r) => r.id)).toEqual(['pool-runbook']);
    expect(inj.invalidationEvents).toEqual([HEX(77)]);
    expect(inj.historyItems.map((h) => h.role)).toEqual(['user', 'assistant', 'tool']);
    for (const h of inj.historyItems) expect(h.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(inj.historyItems[2].dependencyReceiptIds).toEqual([pool.id]);
  });

  it('[G1.6] a premise that was read but never injected or cited stays in the dependency vector', () => {
    const ids = compiled.snapshot.dependencyVector.map((d) => d.receiptId);
    expect(ids).toContain(hidden.id);
    expect(inj.receipts.map((r) => r.id)).not.toContain(hidden.id);
    expect(compiled.system).not.toContain(hidden.id);
    // The vector is the union: injected receipts, artifact and history dependencies, and the read set.
    expect(new Set(ids)).toEqual(new Set([pool.id, health.id, hidden.id]));
  });

  it('[G1.6] the rendered request contains exactly what the snapshot lists (record matches text)', () => {
    for (const r of inj.receipts) expect(compiled.system).toContain(r.id);
    expect(compiled.system).toContain('page prose');
    expect(compiled.system).toContain('handoff text');
    expect(compiled.system).toContain('summary text');
    expect(compiled.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('[G1.6] the ordinary layout records the same premises (layout cannot hide lineage)', () => {
    const ordinary = compileContext(input({ layout: 'ordinary', receipts: [pool, health], readSetVector: [dep(hidden)] }));
    expect(ordinary.snapshot.injected.receipts.map((r) => r.id).sort()).toEqual([health.id, pool.id].sort());
    expect(ordinary.snapshot.dependencyVector.map((d) => d.receiptId)).toContain(hidden.id);
  });
});

describe('[G1.7] stale history, old handoff output and stale summary cannot reenter as current support', () => {
  const oldPool = receipt(21, 'checkout.config/db.pool_max', 3, { value: 3 }, { status: 'superseded' });
  const newPool = receipt(22, 'checkout.config/db.pool_max', 4, { value: 8 });

  it('[G1.7] a superseded receipt is dropped by scope selection even when the readset and the inherited vector name it', () => {
    const picked = selectReceiptsForTask({
      candidates: [oldPool, newPool],
      readSetReceiptIds: [oldPool.id],
      inheritedVector: [dep(oldPool)],
      requestedKeys: [],
      maxReceipts: 10,
    });
    expect(picked.receipts.map((r) => r.id)).not.toContain(oldPool.id);
    expect(picked.dropped).toContainEqual(expect.objectContaining({ id: oldPool.id, reason: 'not_current' }));
  });

  it('[G1.7] an unusable (invalidated) handoff, output or summary is dropped and cannot be compiled in', () => {
    const artifacts = (['handoff', 'task_output', 'summary'] as const).map((kind, i) => ({
      kind,
      id: `old-${kind}`,
      digest: HEX(30 + i),
      text: `stale ${kind}`,
      usable: false,
      dependencyVector: [dep(oldPool)],
    }));
    const sel = selectInheritedArtifacts(artifacts, 10);
    expect(sel.artifacts).toEqual([]);
    expect(sel.dropped.map((d) => d.reason)).toEqual(['unusable', 'unusable', 'unusable']);
    for (const a of artifacts) expect(() => compileContext(input({ inheritedArtifacts: [a] }))).toThrow();
  });

  it('[G1.7] replayed history that depended on the old receipt is recorded with that dependency, so the premise is visible in the request record', () => {
    const c = compileContext(
      input({
        receipts: [newPool],
        history: [{ role: 'tool', content: '{"value":3}', toolCallId: 'tc9', toolName: 'observe_source', dependencyVector: [dep(oldPool)] }],
      }),
    );
    expect(c.snapshot.injected.historyItems[0].dependencyReceiptIds).toEqual([oldPool.id]);
    expect(c.snapshot.dependencyVector.map((d) => d.receiptId)).toContain(oldPool.id);
    // Current evidence for the same key is the new receipt only.
    expect(c.snapshot.injected.receipts.map((r) => r.id)).toEqual([newPool.id]);
  });
});

describe('[G1.7][G1.6] against real receipts: the snapshot vector of a stale call fails the ledger support check', () => {
  it('[G1.7] register -> compile context -> authority moves -> support check over the snapshot vector rejects', async () => {
    await withAccDatabase(async (db) => {
      const w = new World(db);
      try {
        await w.seedConfig('db.pool_max', 3);
        await w.snapshotBases();
        const r1 = await w.register({ op: 'register', label: 'r1', sourceKey: 'checkout.config/db.pool_max' });
        expect(r1.ok, `register failed: ${r1.error}`).toBe(true);
        const id = w.labels.get('r1')!;
        const row = await w.receiptById(id);
        const stale = receipt(0, 'checkout.config/db.pool_max', row!.revision, { value: 3 });
        const snapshotInput = input({
          receipts: [{ ...stale, id: id as ReceiptId, contentDigest: row!.digest ?? HEX(1) }],
          history: [{ role: 'tool', content: '{"value":3}', toolCallId: 't1', toolName: 'observe_source', dependencyVector: [{ sourceKey: stale.source.key, sourceRevision: stale.sourceRevision, receiptId: id as ReceiptId }] }],
        });
        const { snapshot } = compileContext(snapshotInput);
        const vector = snapshot.dependencyVector.map((d) => d.receiptId);
        expect(vector).toEqual([id]);

        // Fresh: supports.
        const ok = await w.assertCurrent({ op: 'assert_current', labels: ['r1'], lockMode: 'share' });
        expect(ok, `fresh vector must pass: ${ok.error}`).toMatchObject({ ok: true });

        await w.advance({ op: 'advance_config', key: 'db.pool_max', value: 8, actor: 'injector' });
        const r2 = await w.register({ op: 'register', label: 'r2', sourceKey: 'checkout.config/db.pool_max' });
        expect(r2.ok, `register failed: ${r2.error}`).toBe(true);

        // The repaired call must not be able to rely on the old vector.
        const bad = await w.assertCurrent({ op: 'assert_current', labels: ['r1'], lockMode: 'share' });
        expect(bad.ok).toBe(false);
        expect(bad.error).toBe('stale_version');
        const good = await w.assertCurrent({ op: 'assert_current', labels: ['r2'], lockMode: 'share' });
        expect(good.ok).toBe(true);
      } finally {
        await w.close();
      }
    });
  });
});
