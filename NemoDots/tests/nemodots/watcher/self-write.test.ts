// History classification (ARCHITECTURE 5.4, C7), against port doubles.
import { describe, expect, it } from 'vitest';
import type {
  ActionId,
  SourceKey,
} from '../../../src/server/nemodots/contracts/index.js';
import {
  classifyHistory,
  type HistoryRow,
  type SelfWriteIntentPort,
  type SettleFromHistoryInput,
} from '../../../src/server/nemodots/watcher/index.js';

const KEY = 'checkout.config/cache.schema_version' as SourceKey;
const X = '11111111-1111-4111-8111-111111111111' as ActionId;
const Y = '22222222-2222-4222-8222-222222222222' as ActionId;
const D = (c: string) => c.repeat(64);

function setup(
  known: Record<string, { key?: SourceKey; digest: string | null }>,
) {
  const settled: SettleFromHistoryInput[] = [];
  const told: [string, string][] = [];
  const logs: string[] = [];
  const intents: SelfWriteIntentPort = {
    async find(id) {
      const entry = known[id];
      return entry
        ? {
            id,
            sourceKey: entry.key ?? KEY,
            status: 'committed',
            expectedAfterDigest: entry.digest,
          }
        : null;
    },
    async settleFromHistory(input) {
      settled.push(input);
    },
  };
  const deps = {
    intents,
    recovery: {
      async onInvalidation() {},
      async onSelfWriteSettled(id: ActionId, outcome: 'verified' | 'failed') {
        told.push([id, outcome]);
      },
    },
    log: (entry: { event: string }) => logs.push(entry.event),
  };
  return { deps, settled, told, logs };
}

const row = (
  version: number,
  actionId: string | null,
  afterDigest: string | null,
): HistoryRow => ({ version, actionId, afterDigest });

describe('classifyHistory', () => {
  it('last row a matching action: verified, with the action id, and the intent settled', async () => {
    const { deps, settled, told } = setup({ [X]: { digest: D('a') } });
    const result = await classifyHistory(deps, KEY, [row(2, X, D('a'))]);
    expect(result).toMatchObject({
      selfWrite: 'verified',
      causedByActionId: X,
    });
    expect(settled).toEqual([
      expect.objectContaining({
        actionId: X,
        outcome: 'verified',
        reason: null,
        version: 2,
      }),
    ]);
    expect(told).toEqual([[X, 'verified']]);
  });

  it('a digest mismatch is a mismatch and fails the intent with postcondition_mismatch', async () => {
    const { deps, settled } = setup({ [X]: { digest: D('a') } });
    const result = await classifyHistory(deps, KEY, [row(2, X, D('b'))]);
    expect(result).toMatchObject({
      selfWrite: 'mismatch',
      causedByActionId: X,
    });
    expect(settled[0]).toMatchObject({
      outcome: 'failed',
      reason: 'postcondition_mismatch',
    });
  });

  it('classifies from the LAST row: a later foreign write makes the head none, earlier actions still settle', async () => {
    const { deps, settled } = setup({ [X]: { digest: D('a') } });
    const result = await classifyHistory(deps, KEY, [
      row(2, X, D('a')),
      row(3, null, D('c')),
    ]);
    expect(result).toMatchObject({ selfWrite: 'none', causedByActionId: null });
    expect(result.settled).toEqual([{ actionId: X, outcome: 'verified' }]);
    expect(settled).toHaveLength(1);
  });

  it('two actions in one walk: both settle in order, the last decides', async () => {
    const { deps, told } = setup({
      [X]: { digest: D('a') },
      [Y]: { digest: D('b') },
    });
    const result = await classifyHistory(deps, KEY, [
      row(2, X, D('a')),
      row(3, Y, D('z')),
    ]);
    expect(told).toEqual([
      [X, 'verified'],
      [Y, 'failed'],
    ]);
    expect(result).toMatchObject({
      selfWrite: 'mismatch',
      causedByActionId: Y,
    });
  });

  it('an intent for another source or without an expected digest never verifies', async () => {
    for (const entry of [
      { key: 'checkout.config/db.pool_max' as SourceKey, digest: D('a') },
      { digest: null },
    ]) {
      const { deps, settled } = setup({ [X]: entry });
      const result = await classifyHistory(deps, KEY, [row(2, X, D('a'))]);
      expect(result.selfWrite).toBe('mismatch');
      expect(settled[0].outcome).toBe('failed');
    }
  });

  it('an unknown action excuses nothing and is logged; no intents port means none', async () => {
    const { deps, settled, logs } = setup({});
    expect(await classifyHistory(deps, KEY, [row(2, X, D('a'))])).toMatchObject(
      {
        selfWrite: 'none',
        causedByActionId: null,
      },
    );
    expect(settled).toEqual([]);
    expect(logs).toEqual(['unknown_action']);

    const noPort = await classifyHistory({ ...deps, intents: undefined }, KEY, [
      row(2, X, D('a')),
    ]);
    expect(noPort.selfWrite).toBe('none');
  });

  it('rows without an action id (injector, owner, seed) are none', async () => {
    const { deps, settled } = setup({});
    const result = await classifyHistory(deps, KEY, [
      row(2, null, D('a')),
      row(3, null, D('b')),
    ]);
    expect(result).toMatchObject({ selfWrite: 'none', settled: [] });
    expect(settled).toEqual([]);
  });
});
