// The history classification of ARCHITECTURE 5.4 (finding C7), without a
// database: which rows settle which intents and what the head receipt carries.
import { describe, expect, it } from 'vitest';
import type { ActionId } from '../../../src/server/nemodots/contracts/index.js';
import { configValueDigest } from '../../../src/server/nemodots/sandbox/version-authority.js';
import {
  applySettlements,
  classifyHistory,
  createSettlementCheck,
  type HistoryRow,
} from '../../../src/server/nemodots/watcher/self-write.js';
import type {
  ExpectedWrite,
  WatcherEvent,
} from '../../../src/server/nemodots/watcher/types.js';

const X = '11111111-1111-4111-8111-111111111111' as ActionId;
const Y = '22222222-2222-4222-8222-222222222222' as ActionId;
const KEY = 'cache.namespace';
const digestOf = (value: string) => configValueDigest(value);

const row = (
  version: number,
  value: string | null,
  action: ActionId | null = null,
): HistoryRow => ({
  version,
  afterDigest: value === null ? null : digestOf(value),
  causedByActionId: action,
});
const expectation = (
  actionId: ActionId,
  value: string,
  overrides: Partial<ExpectedWrite> = {},
): [string, ExpectedWrite] => [
  actionId,
  {
    actionId,
    key: KEY,
    afterDigest: digestOf(value),
    settled: false,
    ...overrides,
  },
];

describe('classifyHistory', () => {
  it('a verified action row is the head: selfWrite verified, intent settled verified', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 2,
      rows: [row(2, 'catalog-b', X)],
      expected: new Map([expectation(X, 'catalog-b')]),
    });
    expect(result).toEqual({
      selfWrite: 'verified',
      causedByActionId: X,
      settlements: [
        { actionId: X, version: 2, outcome: 'verified', alreadySettled: false },
      ],
      gap: false,
    });
  });

  it('a row whose after digest differs from the intent is a mismatch and fails the intent', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 2,
      rows: [row(2, 'something-else', X)],
      expected: new Map([expectation(X, 'catalog-b')]),
    });
    expect(result.selfWrite).toBe('mismatch');
    expect(result.causedByActionId).toBe(X);
    expect(result.settlements).toEqual([
      { actionId: X, version: 2, outcome: 'failed', alreadySettled: false },
    ]);
  });

  it('C7: an action row followed by a foreign write settles the action but the head is none', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 3,
      rows: [row(2, 'catalog-b', X), row(3, 'injected', null)],
      expected: new Map([expectation(X, 'catalog-b')]),
    });
    expect(result.selfWrite).toBe('none');
    expect(result.causedByActionId).toBeNull();
    expect(result.settlements).toEqual([
      { actionId: X, version: 2, outcome: 'verified', alreadySettled: false },
    ]);
  });

  it('a foreign write followed by an action row classifies the head from the action row', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 3,
      rows: [row(2, 'injected', null), row(3, 'catalog-b', X)],
      expected: new Map([expectation(X, 'catalog-b')]),
    });
    expect(result.selfWrite).toBe('verified');
    expect(result.causedByActionId).toBe(X);
  });

  it('two actions in the range settle in history order; the head follows the last row', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 0,
      headVersion: 2,
      rows: [row(1, 'a', X), row(2, 'wrong', Y)],
      expected: new Map([expectation(X, 'a'), expectation(Y, 'b')]),
    });
    expect(result.settlements.map((s) => [s.actionId, s.outcome])).toEqual([
      [X, 'verified'],
      [Y, 'failed'],
    ]);
    expect(result.selfWrite).toBe('mismatch');
    expect(result.causedByActionId).toBe(Y);
  });

  it('an action id the actions package does not know is not a self-write', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 2,
      rows: [row(2, 'catalog-b', X)],
      expected: new Map(),
    });
    expect(result).toMatchObject({
      selfWrite: 'none',
      causedByActionId: null,
      settlements: [],
    });
  });

  it('an intent for another key never verifies a row of this key', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 2,
      rows: [row(2, 'catalog-b', X)],
      expected: new Map([
        expectation(X, 'catalog-b', { key: 'ui.banner_text' }),
      ]),
    });
    expect(result.selfWrite).toBe('mismatch');
    expect(result.settlements[0].outcome).toBe('failed');
  });

  it('a deleted value (null after digest) fails the intent', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 2,
      rows: [row(2, null, X)],
      expected: new Map([expectation(X, 'catalog-b')]),
    });
    expect(result.settlements[0].outcome).toBe('failed');
  });

  it('a gap in the history fails closed: the head is none even when the last row is an action', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 4,
      rows: [row(2, 'x', null), row(4, 'catalog-b', X)],
      expected: new Map([expectation(X, 'catalog-b')]),
    });
    expect(result.gap).toBe(true);
    expect(result.selfWrite).toBe('none');
    expect(result.causedByActionId).toBeNull();
  });

  it('no rows at all (head not above the ledger) is none without a gap', () => {
    expect(
      classifyHistory({
        key: KEY,
        ledgerRevision: 3,
        headVersion: 3,
        rows: [],
        expected: new Map(),
      }),
    ).toEqual({
      selfWrite: 'none',
      causedByActionId: null,
      settlements: [],
      gap: false,
    });
  });

  it('marks settlements of intents that already left committed', () => {
    const result = classifyHistory({
      key: KEY,
      ledgerRevision: 1,
      headVersion: 2,
      rows: [row(2, 'catalog-b', X)],
      expected: new Map([expectation(X, 'catalog-b', { settled: true })]),
    });
    expect(result.settlements[0].alreadySettled).toBe(true);
    expect(result.selfWrite).toBe('verified');
  });
});

describe('applySettlements', () => {
  const settlement = (actionId: ActionId, alreadySettled = false) => ({
    actionId,
    version: 2,
    outcome: 'verified' as const,
    alreadySettled,
  });

  it('calls the port once per unsettled intent and skips settled ones', async () => {
    const calls: [string, string][] = [];
    const events: WatcherEvent[] = [];
    const done = await applySettlements(
      {
        onSelfWriteSettled: async (id, outcome) => {
          calls.push([id, outcome]);
        },
      },
      [settlement(X), settlement(Y, true)],
      (event) => events.push(event),
    );
    expect(calls).toEqual([[X, 'verified']]);
    expect(done).toEqual([{ actionId: X, outcome: 'verified' }]);
    expect(events.map((e) => e.type)).toEqual(['self_write_settled']);
  });

  it('reports a failing settle and carries on with the next one', async () => {
    const calls: string[] = [];
    const events: WatcherEvent[] = [];
    const done = await applySettlements(
      {
        onSelfWriteSettled: async (id) => {
          calls.push(id);
          if (id === X) throw new Error('database unavailable');
        },
      },
      [settlement(X), settlement(Y)],
      (event) => events.push(event),
    );
    expect(calls).toEqual([X, Y]);
    expect(done.map((d) => d.actionId)).toEqual([Y]);
    expect(events.map((e) => e.type)).toEqual(['error', 'self_write_settled']);
  });

  describe('with a settlement check', () => {
    const intentsWhere = (settled: boolean) => ({
      async expectedWrites(ids: readonly ActionId[]) {
        return new Map(
          ids.map((id) => [id, expectation(id, 'catalog-b', { settled })[1]]),
        );
      },
    });

    it('counts a call that settled the intent', async () => {
      const events: WatcherEvent[] = [];
      const done = await applySettlements(
        { onSelfWriteSettled: async () => {} },
        [settlement(X)],
        (event) => events.push(event),
        createSettlementCheck(intentsWhere(true)),
      );
      expect(done).toEqual([{ actionId: X, outcome: 'verified' }]);
      expect(events.map((e) => e.type)).toEqual(['self_write_settled']);
    });

    it('reports a call that returned but left the intent committed, once per action', async () => {
      const events: WatcherEvent[] = [];
      const check = createSettlementCheck(intentsWhere(false));
      const run = () =>
        applySettlements(
          { onSelfWriteSettled: async () => {} },
          [settlement(X)],
          (event) => events.push(event),
          check,
        );
      expect(await run()).toEqual([]);
      expect(await run()).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        where: 'onSelfWriteSettled',
      });
      expect((events[0] as { message: string }).message).toContain(
        'actions.settleFromHistory',
      );
    });

    it('reports again after the intent was settled and later is seen committed', async () => {
      const events: WatcherEvent[] = [];
      let settled = false;
      const check = createSettlementCheck({
        async expectedWrites(ids) {
          return new Map(
            ids.map((id) => [id, expectation(id, 'x', { settled })[1]]),
          );
        },
      });
      const port = { onSelfWriteSettled: async () => {} };
      const emit = (event: WatcherEvent) => events.push(event);
      await applySettlements(port, [settlement(X)], emit, check);
      settled = true;
      await applySettlements(port, [settlement(X)], emit, check);
      settled = false;
      await applySettlements(port, [settlement(X)], emit, check);
      expect(events.map((e) => e.type)).toEqual([
        'error',
        'self_write_settled',
        'error',
      ]);
    });
  });
});
