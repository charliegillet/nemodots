import { describe, expect, it } from 'vitest';
import { digest } from '../../../src/server/nemodots/contracts/index.js';
import {
  LayoutInformationMismatch,
  assertSameInformation,
  compileBothLayouts,
  contextLayoutFor,
  isLayoutName,
} from '../../../src/server/nemodots/evals/layouts.js';
import { LAYOUT_NAMES } from '../../../src/server/nemodots/evals/types.js';

const receipt = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000` as never,
  sourceRevision: n,
  collectionRevision: null,
  observedAt: '2026-10-18T10:00:00.000Z',
  lastConfirmedAt: '2026-10-18T10:00:00.000Z',
  contentDigest: digest({ n }),
  normalizedValue: { n },
  status: 'supported' as const,
  trust: 'observed_tool' as const,
  negative: null,
  source: { key: `checkout.${n === 1 ? 'health' : 'metrics'}` as never },
});

const input = {
  snapshotId: '11111111-1111-4111-8111-111111111111' as never,
  nowIso: '2026-10-18T10:05:00.000Z',
  commonInstructions: 'common',
  roleInstructions: 'role',
  mission: { goal: 'goal', constraints: [] },
  task: { title: 't', question: 'q' },
  runbooks: [
    { id: 'rb-a', title: 'A', text: 'runbook a text' },
    { id: 'rb-b', title: 'B', text: 'runbook b text' },
  ],
  receipts: [receipt(1), receipt(2)],
  inheritedArtifacts: [],
  pageSnapshots: [],
  memories: [],
  invalidations: [],
  history: [],
};

describe('layouts for the 2x2', () => {
  it('there are exactly two, named like the compiler layouts', () => {
    expect([...LAYOUT_NAMES]).toEqual(['ordinary', 'cache_aware']);
    for (const name of LAYOUT_NAMES) {
      expect(isLayoutName(name)).toBe(true);
      expect(contextLayoutFor(name)).toBe(name);
    }
    expect(isLayoutName('fancy')).toBe(false);
  });

  it('carry identical information and differ in ordering and prefix', () => {
    const both = compileBothLayouts(input);
    assertSameInformation(both.cache_aware, both.ordinary);
    expect(both.cache_aware.system).not.toBe(both.ordinary.system);
    expect(both.cache_aware.snapshot.layout).toBe('cache_aware');
    expect(both.ordinary.snapshot.layout).toBe('ordinary');
    expect(both.cache_aware.snapshot.prefixDigest).not.toBe(
      both.ordinary.snapshot.prefixDigest,
    );
    expect(both.cache_aware.snapshot.contextDigest).not.toBe(
      both.ordinary.snapshot.contextDigest,
    );
    // same injected evidence, runbooks and tools
    expect(both.cache_aware.snapshot.injected).toEqual(
      both.ordinary.snapshot.injected,
    );
    expect(both.cache_aware.snapshot.toolSchemaHash).toBe(
      both.ordinary.snapshot.toolSchemaHash,
    );
  });

  it('the cache-aware prefix is stable across the volatile time; the ordinary one is not', () => {
    const early = compileBothLayouts(input);
    const later = compileBothLayouts({
      ...input,
      nowIso: '2026-10-18T10:09:00.000Z',
    });
    expect(later.cache_aware.snapshot.prefixDigest).toBe(
      early.cache_aware.snapshot.prefixDigest,
    );
    expect(later.ordinary.snapshot.prefixDigest).not.toBe(
      early.ordinary.snapshot.prefixDigest,
    );
  });

  it('a layout that dropped or added information is rejected', () => {
    const both = compileBothLayouts(input);
    const fewer = compileBothLayouts({ ...input, receipts: [receipt(1)] });
    expect(() =>
      assertSameInformation(both.cache_aware, fewer.ordinary),
    ).toThrow(LayoutInformationMismatch);
    const otherRunbook = compileBothLayouts({
      ...input,
      runbooks: [
        { id: 'rb-a', title: 'A', text: 'different' },
        input.runbooks[1],
      ],
    });
    expect(() =>
      assertSameInformation(both.cache_aware, otherRunbook.ordinary),
    ).toThrow(LayoutInformationMismatch);
  });
});
