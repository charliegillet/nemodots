import { describe, expect, it } from 'vitest';
import {
  type DependencyEntry,
  type ReceiptId,
  type SourceKey,
} from '../../../src/server/nemodots/contracts/index.js';
import { compileContext } from '../../../src/server/nemodots/context/compile.js';
import {
  CitationOutOfScopeError,
  DependencyRemovedError,
  assertCarriesInputs,
  citationInScope,
  citationsOutOfScope,
  inheritDependencies,
  outputDependencyVector,
} from '../../../src/server/nemodots/context/provenance.js';
import {
  createRunbookCatalogue,
  UnknownRunbookError,
} from '../../../src/server/nemodots/context/runbooks.js';
import {
  selectInheritedArtifacts,
  selectReceiptsForTask,
} from '../../../src/server/nemodots/context/scope.js';
import {
  baseInput,
  cacheReceipt,
  entry,
  healthReceipt,
  poolReceipt,
  receipt,
} from './fixtures.js';

const key = (k: string) => k as SourceKey;

describe('selectReceiptsForTask', () => {
  const metrics = receipt(4, 'checkout.metrics', 2, { hits: 1 });
  const foreign = receipt(5, 'checkout.inventory/sku-1', 1, { qty: 3 });
  const stale = receipt(
    6,
    'checkout.config/cache.ttl',
    1,
    { value: 1 },
    { status: 'superseded' },
  );
  const candidates = [
    foreign,
    stale,
    metrics,
    healthReceipt(),
    poolReceipt(),
    cacheReceipt(),
  ];

  it('selects readset, inherited and requested receipts and records every drop', () => {
    const result = selectReceiptsForTask({
      candidates,
      readSetReceiptIds: [poolReceipt().id, stale.id],
      inheritedVector: [entry(healthReceipt())],
      requestedKeys: [key('checkout.metrics')],
      maxReceipts: 10,
    });
    expect(result.receipts.map((r) => r.id).sort()).toEqual(
      [poolReceipt().id, healthReceipt().id, metrics.id].sort(),
    );
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        {
          id: foreign.id,
          key: 'checkout.inventory/sku-1',
          reason: 'not_in_scope',
        },
        {
          id: cacheReceipt().id,
          key: 'checkout.config/cache.namespace',
          reason: 'not_in_scope',
        },
        {
          id: stale.id,
          key: 'checkout.config/cache.ttl',
          reason: 'not_current',
        },
      ]),
    );
  });

  it('is permutation-independent and truncates deterministically with a record', () => {
    const args = {
      readSetReceiptIds: [poolReceipt().id, cacheReceipt().id],
      inheritedVector: [entry(healthReceipt())],
      requestedKeys: [key('checkout.metrics')],
      maxReceipts: 2,
    };
    const a = selectReceiptsForTask({ ...args, candidates });
    const b = selectReceiptsForTask({
      ...args,
      candidates: [...candidates].reverse(),
    });
    expect(b).toEqual(a);
    // requested first, then readset (key order); inherited and the rest are cut.
    expect(a.receipts.map((r) => r.id).sort()).toEqual(
      [metrics.id, cacheReceipt().id].sort(),
    );
    expect(
      a.dropped
        .filter((d) => d.reason === 'over_limit')
        .map((d) => d.id)
        .sort(),
    ).toEqual([healthReceipt().id, poolReceipt().id].sort());
  });

  it('honours a byte budget', () => {
    const r = selectReceiptsForTask({
      candidates,
      readSetReceiptIds: [cacheReceipt().id, poolReceipt().id],
      inheritedVector: [],
      requestedKeys: [],
      maxReceipts: 10,
      maxBytes: 1,
    });
    expect(r.receipts).toEqual([]);
    expect(r.dropped.filter((d) => d.reason === 'over_limit')).toHaveLength(2);
  });

  it('feeds compileContext without out-of-scope evidence', () => {
    const scoped = selectReceiptsForTask({
      candidates,
      readSetReceiptIds: [cacheReceipt().id],
      inheritedVector: [],
      requestedKeys: [],
      maxReceipts: 5,
    });
    const out = compileContext(baseInput({ receipts: scoped.receipts }));
    expect(out.snapshot.dependencyVector.map((e) => e.receiptId)).toEqual([
      cacheReceipt().id,
    ]);
    expect(out.system).not.toContain(foreign.id);
  });
});

describe('selectInheritedArtifacts', () => {
  it('drops unusable outputs and caps deterministically', () => {
    const items = [
      { kind: 'handoff', id: 'b', usable: true },
      { kind: 'handoff', id: 'a', usable: true },
      { kind: 'summary', id: 'z', usable: false },
      { kind: 'finding', id: 'c', usable: true },
    ];
    const r = selectInheritedArtifacts(items, 2);
    expect(r.artifacts.map((a) => a.id)).toEqual(['c', 'a']);
    expect(r.dropped).toEqual([
      { id: 'z', key: 'summary', reason: 'unusable' },
      { id: 'b', key: 'handoff', reason: 'over_limit' },
    ]);
  });
});

describe('provenance', () => {
  const inputA: DependencyEntry[] = [entry(cacheReceipt())];
  const inputB: DependencyEntry[] = [
    entry(poolReceipt()),
    entry(cacheReceipt()),
  ];

  it('outputs carry at least the union of inputs; citations add', () => {
    const cited = entry(healthReceipt());
    const vector = inheritDependencies({ dependencyVector: [cited] }, [
      inputA,
      inputB,
    ]);
    expect(vector.map((e) => e.receiptId).sort()).toEqual(
      [cacheReceipt().id, poolReceipt().id, healthReceipt().id].sort(),
    );
    expect(() => assertCarriesInputs(vector, [inputA, inputB])).not.toThrow();
  });

  it('removing an input dependency from a derived output fails', () => {
    const vector = inheritDependencies({}, [inputA, inputB]);
    const tampered = vector.filter((e) => e.receiptId !== poolReceipt().id);
    expect(() => assertCarriesInputs(tampered, [inputA, inputB])).toThrow(
      DependencyRemovedError,
    );
    try {
      assertCarriesInputs(tampered, [inputA, inputB]);
    } catch (error) {
      expect(
        (error as DependencyRemovedError).missing.map((e) => e.receiptId),
      ).toEqual([poolReceipt().id]);
    }
  });

  it('rejects one receipt appearing at two revisions', () => {
    const clash = { ...entry(cacheReceipt()), sourceRevision: 99 };
    expect(() => inheritDependencies({}, [inputA, [clash]])).toThrow(
      RangeError,
    );
  });

  describe('citationInScope (I8)', () => {
    const snapshot = compileContext(
      baseInput({ receipts: [cacheReceipt()] }),
    ).snapshot;
    const attempt = {
      readSetReceiptIds: [poolReceipt().id],
      inheritedDependencyVector: [entry(healthReceipt())],
    };
    it('accepts snapshot, readset and inherited receipts', () => {
      expect(citationInScope(cacheReceipt().id, snapshot, attempt)).toBe(true);
      expect(citationInScope(poolReceipt().id, snapshot, attempt)).toBe(true);
      expect(citationInScope(healthReceipt().id, snapshot, attempt)).toBe(true);
    });
    it('rejects a foreign receipt id', () => {
      const foreign = '99999999-9999-4999-8999-999999999999' as ReceiptId;
      expect(citationInScope(foreign, snapshot, attempt)).toBe(false);
      expect(
        citationsOutOfScope([cacheReceipt().id, foreign], snapshot, attempt),
      ).toEqual([foreign]);
      expect(() =>
        outputDependencyVector({
          snapshot,
          attempt,
          cited: [
            {
              sourceKey: key('checkout.metrics'),
              sourceRevision: 1,
              receiptId: foreign,
            },
          ],
        }),
      ).toThrow(CitationOutOfScopeError);
    });
    it('unions snapshot vector with in-scope citations', () => {
      const vector = outputDependencyVector({
        snapshot,
        attempt,
        cited: [entry(poolReceipt())],
      });
      expect(vector.map((e) => e.receiptId).sort()).toEqual(
        [cacheReceipt().id, poolReceipt().id].sort(),
      );
    });
  });
});

describe('runbooks catalogue (I13)', () => {
  const catalogue = createRunbookCatalogue(
    {
      cache: { path: 'cache.md', title: 'Cache' },
      'pool-sizing': { path: 'db/pool.md', title: 'Pool' },
    },
    'src/server/nemodots/team/runbooks',
  );

  it('resolves only mapped ids', () => {
    expect(catalogue.resolve('cache')).toBe(
      'src/server/nemodots/team/runbooks/cache.md',
    );
    expect(catalogue.list()).toEqual([
      { id: 'cache', title: 'Cache' },
      { id: 'pool-sizing', title: 'Pool' },
    ]);
  });

  it.each([
    '../../.env',
    '../x',
    '/etc/passwd',
    'cache/../../.env',
    'cache.md',
    'unknown',
    '__proto__',
    'constructor',
    'toString',
    '',
    'cache\0',
  ])('rejects %j', (id) => {
    expect(() => catalogue.resolve(id)).toThrow(UnknownRunbookError);
    expect(catalogue.has(id)).toBe(false);
  });

  it('rejects non-string ids and unsafe catalogue entries', () => {
    expect(() => catalogue.resolve(undefined)).toThrow(UnknownRunbookError);
    expect(() => catalogue.resolve({ toString: () => 'cache' })).toThrow(
      UnknownRunbookError,
    );
    for (const path of ['../.env', '/abs.md', 'a/../b.md', 'x.txt', 'a\\b.md'])
      expect(() =>
        createRunbookCatalogue({ bad: { path, title: 't' } }),
      ).toThrow(RangeError);
    expect(() =>
      createRunbookCatalogue({ '../bad': { path: 'a.md', title: 't' } }),
    ).toThrow(RangeError);
  });
});
