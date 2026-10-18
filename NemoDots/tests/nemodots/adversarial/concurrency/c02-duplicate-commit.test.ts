// C2 (high): a duplicate delivery of admitAndCommit must not record a bogus
// `blocked` for a committed intent and must not write twice.
// Expected (ARCHITECTURE 5.1 step 2, section 14 C2): the commit transaction
// locks the intent row first; committed | dispatched | verified returns the
// stored ResultReceipt and writes NOTHING; exactly one commit Authorization
// exists; the version advances once.
import { describe, expect, it } from 'vitest';
import {
  actionHistory,
  admitAndCommit,
  authorizations,
  configState,
  countRows,
  historyRows,
  intentStatus,
  park,
  proposePool,
  resultOutcomes,
  scenario,
  waitForLockWaiters,
  withWorld,
} from './harness.js';

describe('C2 duplicate commit', () => {
  it('a second commit that queues behind the first returns the stored receipt and writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const before = await configState(world, 'db.pool_max');
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      const fence = admitted.dispatch!.fence;

      const parked = park('after_lock_before_commit');
      const first = world.service.commit(intent.id, fence);
      await parked.arrived;
      // The duplicate delivery, same fence, while the first holds every lock.
      const second = world.service.commit(intent.id, fence);
      await waitForLockWaiters(world, 1);
      parked.release();
      const [a, b] = await Promise.all([first, second]);

      expect(a.status).toBe('committed');
      expect(b.status).toBe('committed');
      expect(b.id).toBe(a.id);
      const after = await configState(world, 'db.pool_max');
      expect(after.value).toBe(20);
      expect(after.version).toBe(before.version + 1);
      expect(after.causedBy).toBe(intent.id);
      // The oracle: exactly one commit Authorization, none blocked, one receipt, one history row.
      const authz = await authorizations(world, intent.id);
      expect(authz.filter((row) => row.stage === 'commit')).toEqual([
        expect.objectContaining({ decision: 'committed', block_reason: null }),
      ]);
      expect(authz.filter((row) => row.decision === 'blocked')).toHaveLength(0);
      expect(
        (await resultOutcomes(world, intent.id)).filter(
          (o) => o === 'committed',
        ),
      ).toHaveLength(1);
      expect(await actionHistory(world, intent.id)).toHaveLength(1);
      expect((await historyRows(world, 'db.pool_max')).at(-1)?.version).toBe(
        before.version + 1,
      );
      expect(world.deadlocks()).toHaveLength(0);
    });
  });

  it('eight simultaneous deliveries of one commit: one write, one Authorization, every caller sees committed', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const before = await configState(world, 'db.pool_max');
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      const fence = admitted.dispatch!.fence;
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => world.service.commit(intent.id, fence)),
      );
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled')
          expect(result.value.status).toBe('committed');
      }
      expect((await configState(world, 'db.pool_max')).version).toBe(
        before.version + 1,
      );
      expect(
        await countRows(
          world,
          'coordinator.authorizations',
          "action_id = $1 AND decision = 'committed'",
          [intent.id],
        ),
      ).toBe(1);
      expect(
        await countRows(
          world,
          'coordinator.authorizations',
          "action_id = $1 AND decision = 'blocked'",
          [intent.id],
        ),
      ).toBe(0);
      expect(await actionHistory(world, intent.id)).toHaveLength(1);
    });
  });

  it('a late duplicate after the commit, with the right or a wrong fence, is a no-op (the predicates are false by then, which must not block it)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const { admitted, committed } = await admitAndCommit(world, intent.id);
      expect(committed.status).toBe('committed');
      const version = (await configState(world, 'db.pool_max')).version;
      const again = await world.service.commit(
        intent.id,
        admitted.dispatch!.fence,
      );
      const wrongFence = await world.service.commit(
        intent.id,
        admitted.dispatch!.fence + 1000,
      );
      expect(again.status).toBe('committed');
      expect(wrongFence.status).toBe('committed');
      expect((await configState(world, 'db.pool_max')).version).toBe(version);
      expect(
        await countRows(world, 'coordinator.authorizations', 'action_id = $1', [
          intent.id,
        ]),
      ).toBe(2); // admission + commit, nothing else
      expect(await intentStatus(world, intent.id)).toMatchObject({
        status: 'committed',
        blockReason: null,
      });
    });
  });

  it('two dispatchers admitting the same proposed intent at once: one admission, one fence, one lease owner', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const results = await Promise.all([
        world.service.admit(intent.id, 'dispatcher-a'),
        world.service.admit(intent.id, 'dispatcher-b'),
        world.service.admit(intent.id, 'dispatcher-c'),
      ]);
      for (const result of results) expect(result.status).toBe('admitted');
      const fences = new Set(results.map((r) => r.dispatch!.fence));
      const owners = new Set(results.map((r) => r.dispatch!.owner));
      expect(fences.size).toBe(1);
      expect(owners.size).toBe(1);
      expect(
        await countRows(
          world,
          'coordinator.authorizations',
          "action_id = $1 AND stage = 'admission' AND decision = 'admitted'",
          [intent.id],
        ),
      ).toBe(1);
    });
  });
});
