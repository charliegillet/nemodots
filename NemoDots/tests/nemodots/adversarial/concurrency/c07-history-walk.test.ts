// C7 (medium): self-writes are classified against the config_versions HISTORY,
// not the head; an acting intent must not stay `committed` after a watcher
// outage or when a foreign write landed last.
// Expected (ARCHITECTURE 5.4, 14 C7): when the watcher observes head r+n while
// the ledger holds r it reads rows r+1..r+n; every row with a
// caused_by_action_id settles that intent (after_digest == expected ->
// verified); the head receipt's selfWrite derives from the LAST row (verified,
// mismatch or none); an injector/owner write last means full invalidation.
import { describe, expect, it } from 'vitest';
import {
  actionHistory,
  admitAndCommit,
  configState,
  createAttempt,
  externalChange,
  intentStatus,
  memberReceipt,
  proposePool,
  scenario,
  watcherRig,
  withWorld,
} from './harness.js';

const KEY = 'checkout.config/db.pool_max';

describe('C7 stopped-watcher history walk', () => {
  it('action commit then a foreign write while the watcher was stopped: the action is verified from its row, the head receipt is selfWrite none', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const { committed } = await admitAndCommit(world, intent.id);
      expect(committed.status).toBe('committed');
      await externalChange(world, 'db.pool_max', 15); // v3, foreign, last
      expect((await configState(world, 'db.pool_max')).version).toBe(3);
      expect(await actionHistory(world, intent.id)).toHaveLength(1);

      const rig = watcherRig(world);
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ outcome: 'registered', revision: 3, selfWrite: 'none' });
      expect(rig.settled).toEqual([{ actionId: intent.id, outcome: 'verified' }]);
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
      // The foreign write invalidated the readers of the old revision.
      expect(rig.invalidations.length).toBeGreaterThan(0);
    });
  });

  it('action commit with the watcher alive afterwards (head is the action row): selfWrite verified and the intent verified', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      await admitAndCommit(world, intent.id);
      const rig = watcherRig(world);
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ outcome: 'registered', revision: 2, selfWrite: 'verified' });
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
      const { rows } = await world.admin.query(
        `SELECT r.caused_by_action_id, r.self_write FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
          WHERE s.key = $1 AND r.source_revision = 2`,
        [KEY],
      );
      expect(rows[0]).toMatchObject({ caused_by_action_id: intent.id, self_write: 'verified' });
    });
  });

  it('two actions on one key and a stopped watcher (first row already known to the ledger): both settle, head classification from the last row', async () => {
    await withWorld(async (world) => {
      const s1 = await scenario(world);
      const a = await proposePool(world, s1, 20);
      await admitAndCommit(world, a.id);
      // A tool registered revision 2 (provenance without a classification).
      await memberReceipt(world, 'db.pool_max');
      const s2 = await scenario(world, { attempt: await createAttempt(world) });
      const b = await proposePool(world, s2, 18);
      expect(b.status).toBe('proposed');
      const admitted = await admitAndCommit(world, b.id);
      expect(admitted.committed.status).toBe('committed');
      expect((await configState(world, 'db.pool_max')).version).toBe(3);

      const rig = watcherRig(world);
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ revision: 3, selfWrite: 'verified' });
      // B's row is in the walked range; A's row is at or below the revision a
      // tool registered, so the settlement sweep of the next cycle settles it.
      expect((await intentStatus(world, b.id)).status).toBe('verified');
      await rig.watcher.runCycle();
      expect((await intentStatus(world, a.id)).status).toBe('verified');
      expect(rig.settled.map((x) => x.actionId).sort()).toEqual([a.id, b.id].sort());
    });
  });

  it('a version bump without a history row (raw DML by the trusted app role) is a gap: fail closed to selfWrite none and a history_gap event', async () => {
    await withWorld(async (world) => {
      await memberReceipt(world, 'db.pool_max');
      await world.app.query(
        "UPDATE checkout.config_entries SET value = '99'::jsonb, version = version + 1 WHERE key = 'db.pool_max'",
      );
      const rig = watcherRig(world);
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ outcome: 'registered', selfWrite: 'none' });
      expect(rig.events.some((e) => e.type === 'history_gap')).toBe(true);
    });
  });

  it('settlement is idempotent: observing again, or a second watcher cycle, changes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      await admitAndCommit(world, intent.id);
      const rig = watcherRig(world);
      await rig.watcher.observe([KEY]);
      const again = await rig.watcher.observe([KEY]);
      await rig.watcher.runCycle();
      expect(again[0].outcome).not.toBe('registered');
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
      expect(rig.settled).toHaveLength(1);
    });
  });
});
