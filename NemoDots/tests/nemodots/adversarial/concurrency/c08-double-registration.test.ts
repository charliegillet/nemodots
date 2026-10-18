// C8 (medium): concurrent registerObservation on one source must not double
// mint. Expected (ARCHITECTURE 5.2, 14 C8): the ledger.sources row is locked
// FOR UPDATE first; the same normalized digest becomes a confirmation, never a
// new revision; different digests become strictly consecutive revisions with
// exactly one supported head; a controlled source has one receipt per version.
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import {
  countRows,
  externalChange,
  latch,
  memberReceipt,
  observed,
  registerObserved,
  sourceRef,
  withWorld,
  type World,
} from './harness.js';

async function receiptsOf(world: World, key: string) {
  const { rows } = await world.admin.query<{
    source_revision: string;
    status: string;
    n: string;
  }>(
    `SELECT r.source_revision, r.status,
            (SELECT count(*) FROM ledger.receipt_confirmations c WHERE c.receipt_id = r.id) AS n
       FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
      WHERE s.key = $1 ORDER BY r.source_revision`,
    [key],
  );
  return rows.map((r) => ({
    revision: Number(r.source_revision),
    status: r.status,
    confirmations: Number(r.n),
  }));
}

describe('C8 double registration', () => {
  it('eight first-ever registrations of the same value: one revision, seven confirmations', async () => {
    await withWorld(async (world) => {
      const missionId = crypto.randomUUID();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          registerObserved(
            world,
            'checkout.health',
            { status: 'ok' },
            undefined,
            {
              missionId,
            },
          ),
        ),
      );
      expect(results.filter((r) => r.newRevision)).toHaveLength(1);
      const rows = await receiptsOf(world, 'checkout.health');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ revision: 1, status: 'supported' });
      expect(rows[0].confirmations).toBe(7);
    });
  });

  it('six different values at once: consecutive revisions 1..6, one supported head, five superseded', async () => {
    await withWorld(async (world) => {
      const missionId = crypto.randomUUID();
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          registerObserved(world, 'redis.stats', { n: i }, undefined, {
            missionId,
          }),
        ),
      );
      const rows = await receiptsOf(world, 'redis.stats');
      expect(rows.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows.filter((r) => r.status === 'supported')).toHaveLength(1);
      expect(rows.at(-1)!.status).toBe('supported');
      expect(rows.filter((r) => r.status === 'superseded')).toHaveLength(5);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('a registration parked after its preliminary read loses to a concurrent identical one: it confirms, it does not mint', async () => {
    await withWorld(async (world) => {
      const missionId = crypto.randomUUID();
      await observed(world, 'checkout.metrics', { v: 0 }, undefined, {
        missionId,
      });
      const parked = latch();
      const release = latch();
      const slow = withTransaction(world.app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef('checkout.metrics', missionId),
            normalizedValue: { v: 1 },
            provenance: { kind: 'watcher' },
          },
          {
            hooks: {
              async afterPreliminaryRead() {
                parked.open(undefined);
                await release.promise;
              },
            },
          },
        ),
      );
      await parked.promise;
      const fast = await registerObserved(
        world,
        'checkout.metrics',
        { v: 1 },
        undefined,
        {
          missionId,
        },
      );
      expect(fast.newRevision).toBe(true);
      release.open(undefined);
      const late = await slow;
      expect(late.newRevision).toBe(false);
      expect(late.confirmation).not.toBeNull();
      const rows = await receiptsOf(world, 'checkout.metrics');
      expect(rows.map((r) => r.revision)).toEqual([1, 2]);
    });
  });

  it('a controlled version registered by six watchers at once: one receipt for that version', async () => {
    await withWorld(async (world) => {
      await externalChange(world, 'db.pool_max', 12);
      const missionId = crypto.randomUUID();
      void missionId;
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => memberReceipt(world, 'db.pool_max')),
      );
      for (const r of results) expect(r.status).toBe('fulfilled');
      const rows = await receiptsOf(world, 'checkout.config/db.pool_max');
      expect(rows).toHaveLength(1);
      expect(rows[0].revision).toBe(2);
      expect(
        await countRows(
          world,
          'ledger.observation_receipts',
          "status = 'supported'",
        ),
      ).toBe(1);
    });
  });
});
