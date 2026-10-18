// Concurrency properties of the boundary under real contention (gate 2 item
// 3): competing commits of one version, cross-linked vectors across keys
// (lock order, no deadlock) and writers racing the pipeline. Invariants are
// read from the history, not from return values.
import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '../../../../src/server/nemodots/contracts/index.js';
import {
  configState,
  createAttempt,
  emitModelCall,
  externalChange,
  historyRows,
  intentRow,
  memberReceipt,
  observed,
  setConfigInput,
  withWorld,
  type World,
} from './harness.js';

async function committedHistoryRows(world: World) {
  const { rows } = await world.admin.query<{
    key: string;
    version: string;
    caused_by_action_id: string | null;
    expected: string | null;
  }>(
    `SELECT v.key, v.version, v.caused_by_action_id, i.expected_target_version AS expected
       FROM checkout.config_versions v
       LEFT JOIN coordinator.action_intents i ON i.id = v.caused_by_action_id
      WHERE v.caused_by_action_id IS NOT NULL`,
  );
  return rows.map((row) => ({
    key: row.key,
    version: Number(row.version),
    actionId: row.caused_by_action_id!,
    expected: Number(row.expected),
  }));
}

describe('competing commits', () => {
  it('eight attempts proposing different values against one version: exactly one wins, the rest are blocked', async () => {
    await withWorld(async (world) => {
      const member = await memberReceipt(world, 'db.pool_max');
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const proposals: ActionIntent[] = [];
      for (let i = 0; i < 8; i += 1) {
        const attempt = await createAttempt(world);
        const call = await emitModelCall(world, attempt, [member, health]);
        proposals.push(
          await world.service.propose(
            setConfigInput(world, { value: 10 }, { value: 11 + i }),
            { ...attempt.context, ...call } as never,
          ),
        );
      }
      expect(proposals.every((p) => p.status === 'proposed')).toBe(true);
      const outcomes = await Promise.all(
        proposals.map((p, i) => world.service.process(p.id, `dispatcher-${i}`)),
      );
      const committed = outcomes.filter((o) => o.status === 'committed');
      const blocked = outcomes.filter((o) => o.status === 'blocked');
      expect(committed).toHaveLength(1);
      expect(blocked).toHaveLength(7);
      expect(blocked.every((o) => o.blockReason === 'stale_version')).toBe(
        true,
      );

      const winner = committed[0];
      const state = await configState(world, 'db.pool_max');
      expect(state.version).toBe(2);
      expect(state.causedBy).toBe(winner.id);
      expect(state.value).toBe((winner.payload as { value: number }).value);
      // Every mutation by an action was made at exactly expected + 1.
      const rows = await committedHistoryRows(world);
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe(rows[0].expected + 1);
      const history = await historyRows(world, 'db.pool_max');
      expect(history.map((row) => row.version)).toEqual([1, 2]);
    });
  }, 60_000);
});

describe('cross-linked vectors across keys under an injector storm', () => {
  it('no deadlock, no mutation under an old version, history stays sequential', async () => {
    await withWorld(async (world) => {
      const keys = ['db.pool_max', 'db.statement_timeout_ms', 'ui.banner_text'];
      const values: Record<string, (i: number) => string | number> = {
        'db.pool_max': (i) => 11 + i,
        'db.statement_timeout_ms': (i) => 6000 + i,
        'ui.banner_text': (i) => `banner ${i}`,
      };
      const members = Object.fromEntries(
        await Promise.all(
          keys.map(
            async (key) => [key, await memberReceipt(world, key)] as const,
          ),
        ),
      );
      const health = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const proposals: ActionIntent[] = [];
      for (let i = 0; i < 12; i += 1) {
        const key = keys[i % keys.length];
        const attempt = await createAttempt(world);
        // Each vector holds all three members: overlapping lock sets, key order.
        const call = await emitModelCall(world, attempt, [
          ...Object.values(members),
          health,
        ]);
        const current = await configState(world, key);
        proposals.push(
          await world.service.propose(
            setConfigInput(world, current, {
              key,
              value: values[key](i),
            }),
            { ...attempt.context, ...call } as never,
          ),
        );
      }
      const storm = (async () => {
        for (let n = 0; n < 6; n += 1) {
          await externalChange(world, keys[n % keys.length], `storm ${n}`);
        }
      })();
      const outcomes = await Promise.all([
        ...proposals.map((p, i) => world.service.process(p.id, `d-${i}`)),
        storm.then(() => null),
      ]);
      const finals = outcomes.filter((o): o is ActionIntent => o !== null);
      expect(finals).toHaveLength(12);
      for (const intent of finals)
        expect(['committed', 'blocked']).toContain(intent.status);

      // Invariants from the history.
      for (const key of keys) {
        const history = await historyRows(world, key);
        history.forEach((row, i) => expect(row.version).toBe(i + 1));
      }
      for (const row of await committedHistoryRows(world))
        expect(row.version).toBe(row.expected + 1);
      // A blocked intent never wrote.
      for (const intent of finals.filter((o) => o.status === 'blocked')) {
        const stored = await intentRow(world, intent.id);
        expect(stored.committed_target_version).toBeNull();
      }
    });
  }, 90_000);
});
