// C5 (high): idempotency is bound to the emitting TOOL CALL.
// Expected (CONTRACTS 5, ARCHITECTURE 14 C5): key = sha256(mission, task,
// attempt, action, expectedTargetVersion, toolCallId) with the payload hash
// bound beside it. A replayed tool call with an identical payload returns the
// stored intent; with a tampered payload it is blocked(idempotency_conflict);
// blocked/failed/cancelled intents do not reserve keys, so a fresh proposal
// from a NEW tool call after a block is a normal live proposal.
import { describe, expect, it } from 'vitest';
import {
  admitAndCommit,
  configState,
  countRows,
  externalChange,
  intentStatus,
  proposeCtx,
  proposePool,
  scenario,
  setConfigInput,
  withWorld,
  type ConfigScalar,
} from './harness.js';

describe('C5 replayed tool call and re-proposal', () => {
  it('eight concurrent replays of one identical proposal create exactly one intent', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => proposePool(world, s, 20)),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(
        await countRows(world, 'coordinator.action_intents', 'attempt_id = $1', [
          s.attempt.attemptId,
        ]),
      ).toBe(1);
    });
  });

  it('a replay with a tampered value is blocked(idempotency_conflict); the original stays live and the tampered one can never commit', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const original = await proposePool(world, s, 20);
      const tampered = await proposePool(world, s, 1);
      expect(tampered.id).not.toBe(original.id);
      expect(tampered.status).toBe('blocked');
      expect(tampered.blockReason).toBe('idempotency_conflict');
      expect((await intentStatus(world, original.id)).status).toBe('proposed');
      const { committed } = await admitAndCommit(world, tampered.id);
      expect(committed.status).toBe('blocked');
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
      const good = await admitAndCommit(world, original.id);
      expect(good.committed.status).toBe('committed');
      expect((await configState(world, 'db.pool_max')).value).toBe(20);
    });
  });

  it('the original and a tampered replay racing each other: exactly one live intent, never two writes', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const [a, b] = await Promise.all([
        proposePool(world, s, 20),
        proposePool(world, s, 2),
      ]);
      const live = [a, b].filter((i) => i.status === 'proposed');
      const blocked = [a, b].filter((i) => i.status === 'blocked');
      expect(live).toHaveLength(1);
      expect(blocked).toHaveLength(1);
      expect(blocked[0].blockReason).toBe('idempotency_conflict');
      expect(
        await countRows(world, 'coordinator.action_intents',
          "attempt_id = $1 AND status IN ('proposed','admitted','committed','dispatched','outcome_unknown')",
          [s.attempt.attemptId]),
      ).toBe(1);
    });
  });

  it('after a block, a proposal from a NEW tool call (fresh evidence) is live and commits; the blocked intent reserved nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const first = await proposePool(world, s, 20);
      await externalChange(world, 'db.pool_max', 11);
      const { committed } = await admitAndCommit(world, first.id);
      expect(committed.status).toBe('blocked');

      // The closure invalidated the proposing attempt (it read the old receipt);
      // the repair is a NEW attempt with fresh evidence and its own tool call.
      const repair = await scenario(world);
      expect(
        (await world.admin.query(
          'SELECT status FROM coordinator.task_attempts WHERE id = $1',
          [s.attempt.attemptId],
        )).rows[0].status,
      ).toBe('invalidated');
      const state = await configState(world, 'db.pool_max');
      const second = await world.service.propose(
        setConfigInput(20, state.value as ConfigScalar),
        proposeCtx(repair),
      );
      expect(second.status).toBe('proposed');
      expect(second.expectedTargetVersion).toBe(state.version);
      const done = await admitAndCommit(world, second.id);
      expect(done.committed.status).toBe('committed');
      expect((await configState(world, 'db.pool_max')).value).toBe(20);
    });
  });

  it('replaying the blocked proposal with its own tool call id and identical payload returns the stored blocked intent (no new row, no resurrection)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const first = await proposePool(world, s, 20);
      await externalChange(world, 'db.pool_max', 11);
      await admitAndCommit(world, first.id);
      const rows = await countRows(world, 'coordinator.action_intents');
      const replay = await world.service.propose(
        setConfigInput(20, 10, { key: 'db.pool_max' }),
        proposeCtx(s),
      );
      expect(replay.id).toBe(first.id);
      expect(replay.status).toBe('blocked');
      expect(await countRows(world, 'coordinator.action_intents')).toBe(rows);
    });
  });

  it('two different tool calls proposing against one target at one version: both may be live, exactly one commits, the other is blocked stale_version', async () => {
    await withWorld(async (world) => {
      const s1 = await scenario(world);
      const s2 = await scenario(world);
      const [a, b] = [await proposePool(world, s1, 20), await proposePool(world, s2, 15)];
      expect(a.status).toBe('proposed');
      expect(b.status).toBe('proposed');
      const results = await Promise.all([
        admitAndCommit(world, a.id, 'da'),
        admitAndCommit(world, b.id, 'db'),
      ]);
      const statuses = results.map((r) => r.committed.status).sort();
      expect(statuses).toEqual(['blocked', 'committed']);
      const v = (await configState(world, 'db.pool_max')).version;
      expect(v).toBe(2);
      expect(world.deadlocks()).toEqual([]);
    });
  });
});
