// The seam between the watcher and the REAL actions package: an intent created
// through propose -> admit -> commit (real constraints, real result receipts)
// is settled by the watcher through actions.settleFromHistory, which refuses a
// settlement without a committed control-plane receipt and a matching history
// row. The coordinator side of the RecoveryPort is a recording double here (the
// coordinator is covered by the other watcher suites); everything else is real.
//
// The second half pins the wiring requirement for system-bootstrap: if
// RecoveryPort.onSelfWriteSettled is wired to the coordinator alone, nothing
// settles the intent, and the watcher must say so instead of failing open.
import { describe, expect, it } from 'vitest';
import { createActionService } from '../../../../src/server/nemodots/actions/index.js';
import type { RecoveryPort } from '../../../../src/server/nemodots/contracts/index.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import {
  createSqlIntentSettlement,
  createWatcher,
  type WatcherEvent,
  type WatcherRecovery,
} from '../../../../src/server/nemodots/watcher/index.js';
import {
  OWNER,
  admitAndCommit,
  configState,
  externalChange,
  historyRows,
  intentRow,
  proposePool,
  results,
  scenario,
  withWorld,
  type World,
} from '../actions/harness.js';

const KEY = 'db.pool_max';
const member = `checkout.config/${KEY}`;

function setup(world: World, wiring: 'actions' | 'coordinator-only') {
  const told: [string, string][] = [];
  const events: WatcherEvent[] = [];
  const paused: string[] = [];
  // the coordinator's half of the port: records what it is told
  const coordinator: RecoveryPort = {
    onInvalidation: async () => {},
    onSelfWriteSettled: async (id, outcome) => {
      told.push([id, outcome]);
    },
  };
  const service = createActionService({ ...world.deps, recovery: coordinator });
  const recovery: WatcherRecovery = {
    onInvalidation: (event) => coordinator.onInvalidation(event),
    onSelfWriteSettled:
      wiring === 'actions'
        ? async (id, outcome) => {
            await service.settleFromHistory(id, outcome);
          }
        : (id, outcome) => coordinator.onSelfWriteSettled(id, outcome),
    async pauseMission(missionId) {
      paused.push(missionId);
    },
  };
  const watcher = createWatcher({
    pool: world.app,
    listenUrl: world.db.urls.app,
    readers: createSourceReaders({
      pg: world.app,
      redisPrefix: 'nemodots:test:none0000',
      checkoutUrl: 'http://checkout.invalid',
      fetch: (() => {
        throw new Error('no HTTP in this suite');
      }) as unknown as typeof fetch,
    }),
    recovery,
    intents: createSqlIntentSettlement({ pool: world.app }),
    config: { ownerId: OWNER, environment: 'test', intervalMs: 60_000 },
    onEvent: (event) => events.push(event),
  });
  return { watcher, told, events, paused };
}

describe('the watcher with the real actions package (wiring: actions.settleFromHistory)', () => {
  it('settles a committed set_config from its history row and registers a verified self-write head', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const { committed } = await admitAndCommit(world, proposed.id);
      expect(committed.status).toBe('committed');
      const { watcher, told, events } = setup(world, 'actions');
      try {
        const [observed] = await watcher.observe([member]);
        expect(observed).toMatchObject({
          outcome: 'registered',
          revision: 2,
          selfWrite: 'verified',
        });
        const row = await intentRow(world, proposed.id);
        expect(row.status).toBe('verified');
        const receipts = await results(world, proposed.id);
        expect(receipts.map((r) => r.outcome)).toEqual([
          'committed',
          'verified',
        ]);
        expect(receipts[1].postcondition).toMatchObject({
          kind: 'history',
          configVersion: 2,
        });
        // the coordinator was told by settleFromHistory, exactly once
        expect(told).toEqual([[proposed.id, 'verified']]);
        expect(events.filter((e) => e.type === 'error')).toEqual([]);
        expect(events.filter((e) => e.type === 'self_write_settled')).toEqual([
          {
            type: 'self_write_settled',
            actionId: proposed.id,
            outcome: 'verified',
          },
        ]);
      } finally {
        await watcher.stop();
      }
    });
  });

  it('C7 with the real path: an injector write lands after the commit, the action is still verified from its own row', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await admitAndCommit(world, proposed.id);
      expect(await externalChange(world, KEY, 3)).toBe(3);
      const { watcher, told, events } = setup(world, 'actions');
      try {
        const [observed] = await watcher.observe([member]);
        expect(observed).toMatchObject({
          outcome: 'registered',
          revision: 3,
          selfWrite: 'none',
        });
        expect((await intentRow(world, proposed.id)).status).toBe('verified');
        expect(told).toEqual([[proposed.id, 'verified']]);
        expect(events.filter((e) => e.type === 'error')).toEqual([]);
        expect(await configState(world, KEY)).toMatchObject({
          value: 3,
          version: 3,
          causedBy: null,
        });
        const rows = await historyRows(world, KEY);
        expect(rows.map((r) => r.caused_by_action_id)).toEqual([
          null,
          proposed.id,
          null,
        ]);
      } finally {
        await watcher.stop();
      }
    });
  });
});

describe('the watcher with onSelfWriteSettled wired to the coordinator alone', () => {
  it('does not fail open: the intent stays committed and the watcher reports it once', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      await admitAndCommit(world, proposed.id);
      const { watcher, told, events } = setup(world, 'coordinator-only');
      try {
        await watcher.observe([member]);
        // the wrong wiring left the intent committed ...
        expect((await intentRow(world, proposed.id)).status).toBe('committed');
        const errors = events.filter((e) => e.type === 'error');
        // ... and the watcher said so, naming the requirement
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          type: 'error',
          where: 'onSelfWriteSettled',
        });
        expect((errors[0] as { message: string }).message).toContain(
          'actions.settleFromHistory',
        );
        expect(events.filter((e) => e.type === 'self_write_settled')).toEqual(
          [],
        );

        // every later poll retries (the sweep) but does not repeat the report
        await watcher.runCycle();
        await watcher.runCycle();
        expect(told.length).toBeGreaterThanOrEqual(3);
        expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
        expect((await intentRow(world, proposed.id)).status).toBe('committed');
        expect(watcher.stats().errors).toBe(1);
      } finally {
        await watcher.stop();
      }
    });
  });
});
