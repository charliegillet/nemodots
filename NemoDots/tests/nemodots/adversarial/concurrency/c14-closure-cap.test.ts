// C14 (low): a closure over the cap must not abort the registration forever.
// Expected (ARCHITECTURE 5.2, 14 C14): the closure is aborted; in a fresh
// transaction the affected missions are paused (reason closure_cap_exceeded), a
// coarse InvalidationEvent (affected = every non-terminal attempt/intent of
// those missions, closure.capped = true) is recorded, and the receipt is
// registered with the closure skipped. The source stays observable: the next
// change registers normally and the same revision is not retried in a loop.
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { recordReadSet, registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import {
  createAttempt,
  externalChange,
  memberReceipt,
  sourceRef,
  watcherRig,
  withWorld,
} from './harness.js';

const KEY = 'checkout.config/db.pool_max';

describe('C14 closure cap', () => {
  it('the ledger refuses a registration whose closure exceeds the cap and writes nothing', async () => {
    await withWorld(async (world) => {
      const r1 = await memberReceipt(world, 'db.pool_max');
      for (let i = 0; i < 4; i += 1) {
        const a = await createAttempt(world);
        await withTransaction(world.app, (c) =>
          recordReadSet(c, {
            missionId: a.missionId,
            taskId: a.taskId,
            attemptId: a.attemptId,
            receiptIds: [r1.id],
          }),
        );
      }
      await externalChange(world, 'db.pool_max', 12);
      const before = await world.admin.query('SELECT count(*) n FROM ledger.observation_receipts');
      await expect(
        withTransaction(world.app, async (client) => {
          const { rows } = await client.query('SELECT value, version FROM checkout.config_entries WHERE key = $1', ['db.pool_max']);
          return registerObservation(
            client,
            {
              source: sourceRef(KEY),
              normalizedValue: { key: 'db.pool_max', value: rows[0].value, version: Number(rows[0].version) },
              provenance: { kind: 'watcher' },
            },
            { limits: { maxDepth: 64, maxNodes: 2 } },
          );
        }),
      ).rejects.toMatchObject({ name: 'ClosureCapExceeded' });
      const after = await world.admin.query('SELECT count(*) n FROM ledger.observation_receipts');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  it('the watcher takes the cap path: missions paused, coarse event capped, receipt registered, no retry loop', async () => {
    await withWorld(async (world) => {
      const r1 = await memberReceipt(world, 'db.pool_max');
      const attempts = [];
      for (let i = 0; i < 5; i += 1) {
        const a = await createAttempt(world);
        attempts.push(a);
        await withTransaction(world.app, (c) =>
          recordReadSet(c, {
            missionId: a.missionId,
            taskId: a.taskId,
            attemptId: a.attemptId,
            receiptIds: [r1.id],
          }),
        );
      }
      await externalChange(world, 'db.pool_max', 12);
      const rig = watcherRig(world, { closureLimits: { maxDepth: 64, maxNodes: 3 } });
      const out = await rig.watcher.observe([KEY]);
      expect(out[0]).toMatchObject({ outcome: 'registered', revision: 2, closureCapped: true });
      expect(rig.paused).toEqual([world.missionId]);
      const event = out[0].invalidationId
        ? rig.invalidations.find((e) => e.id === out[0].invalidationId)
        : undefined;
      expect(event?.reason).toBe('closure_cap_exceeded');
      expect(event?.closure.capped).toBe(true);
      const affected = new Set(event?.affected.attemptIds);
      for (const a of attempts) expect(affected.has(a.attemptId as never)).toBe(true);
      // New revision is the supported head; the old one is superseded.
      const { rows } = await world.admin.query(
        `SELECT r.source_revision, r.status FROM ledger.observation_receipts r
           JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1 ORDER BY 1`,
        [KEY],
      );
      expect(rows.map((r) => [Number(r.source_revision), r.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      // The next observation neither re-pauses nor loops.
      const again = await rig.watcher.observe([KEY]);
      expect(again[0].outcome).not.toBe('registered');
      expect(rig.paused).toHaveLength(1);
      // And the source stays observable: a further change registers normally.
      await externalChange(world, 'db.pool_max', 13);
      const next = await rig.watcher.observe([KEY]);
      expect(next[0]).toMatchObject({ outcome: 'registered', revision: 3, closureCapped: false });
    });
  });
});
