// C13 (low): a closure racing a concurrent observe_source (read-set edge
// insert) must not leave an attempt unmarked; a G2 rejection must not be
// retried blindly. Expected (ARCHITECTURE 5.2, 14 C13): the sources row lock
// serializes the edge insert with the registration. The read-set write holds
// FOR SHARE on the registry/receipt rows, so a supersession either waits and
// then sees the edge (the attempt is marked invalidated), or ran first and the
// read set is refused (SupportError). The invariant: after both commit, no
// RUNNING attempt keeps an evidence edge from a superseded receipt.
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import {
  recordReadSet,
  registerObservation,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  createAttempt,
  latch,
  observed,
  registerObserved,
  sourceRef,
  sleep,
  waitForLockWaiters,
  withWorld,
  type World,
} from './harness.js';

async function attemptStatus(world: World, attemptId: string) {
  const { rows } = await world.admin.query<{ status: string }>(
    'SELECT status FROM coordinator.task_attempts WHERE id = $1',
    [attemptId],
  );
  return rows[0].status;
}

/** Running attempts holding an evidence edge from a superseded receipt (must be empty). */
async function unmarkedReaders(world: World) {
  const { rows } = await world.admin.query<{ attempt_id: string }>(
    `SELECT a.id AS attempt_id
       FROM coordinator.task_attempts a
       JOIN ledger.dependency_edges e ON e.to_kind = 'attempt' AND e.to_id = a.id
            AND e.from_kind = 'receipt' AND e.kind = 'evidence'
       JOIN ledger.observation_receipts r ON r.id = e.from_id
      WHERE a.status = 'running' AND r.status = 'superseded'`,
  );
  return rows.map((r) => r.attempt_id);
}

const readSet = (
  attempt: Awaited<ReturnType<typeof createAttempt>>,
  receiptId: string,
) => ({
  missionId: attempt.missionId,
  taskId: attempt.taskId,
  attemptId: attempt.attemptId,
  receiptIds: [receiptId],
});

describe('C13 closure versus observe_source', () => {
  it('a read-set write in flight (edge uncommitted, locks held) makes the superseding registration wait, then mark the attempt', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const r1 = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const client = await world.app.connect();
      try {
        await client.query('BEGIN');
        await recordReadSet(client, readSet(attempt, r1.id));
        const registration = registerObserved(world, 'checkout.health', {
          status: 'ok',
        });
        await waitForLockWaiters(world, 1);
        await client.query('COMMIT');
        const result = await registration;
        expect(result.newRevision).toBe(true);
        expect(
          result.invalidation?.perMission.flatMap((m) => m.affected.attemptIds),
        ).toContain(attempt.attemptId);
      } finally {
        client.release();
      }
      expect(await attemptStatus(world, attempt.attemptId)).toBe('invalidated');
      expect(await unmarkedReaders(world)).toEqual([]);
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('supersession first: the late read-set write is refused (SupportError) and writes no edge', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const r1 = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      await observed(world, 'checkout.health', { status: 'ok' });
      await expect(
        withTransaction(world.app, (client) =>
          recordReadSet(client, readSet(attempt, r1.id)),
        ),
      ).rejects.toMatchObject({ name: 'SupportError' });
      const { rows } = await world.admin.query(
        "SELECT 1 FROM ledger.dependency_edges WHERE to_kind = 'attempt' AND to_id = $1",
        [attempt.attemptId],
      );
      expect(rows).toHaveLength(0);
      expect(await attemptStatus(world, attempt.attemptId)).toBe('running');
    });
  });

  it('a registration parked after its preliminary read while a reader commits its edge: the closure still marks that reader', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const r1 = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const parked = latch();
      const release = latch();
      const registration = withTransaction(world.app, (client) =>
        registerObservation(
          client,
          {
            source: sourceRef('checkout.health'),
            normalizedValue: { status: 'ok' },
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
      await withTransaction(world.app, (client) =>
        recordReadSet(client, readSet(attempt, r1.id)),
      );
      release.open(undefined);
      await registration;
      expect(await attemptStatus(world, attempt.attemptId)).toBe('invalidated');
      expect(await unmarkedReaders(world)).toEqual([]);
    });
  });

  it('property: 24 randomly interleaved read-set writes and supersessions never leave a running attempt resting on a superseded receipt', async () => {
    await withWorld(async (world) => {
      let value = 0;
      for (let round = 0; round < 8; round += 1) {
        const current = await observed(world, 'checkout.health', {
          status: `s${(value += 1)}`,
        });
        const attempts = await Promise.all(
          Array.from({ length: 3 }, () => createAttempt(world)),
        );
        await Promise.allSettled([
          ...attempts.map(async (attempt, i) => {
            await sleep((round + i) % 4);
            await withTransaction(world.app, (client) =>
              recordReadSet(client, readSet(attempt, current.id)),
            );
          }),
          (async () => {
            await sleep(round % 3);
            await observed(world, 'checkout.health', {
              status: `s${(value += 1)}`,
            });
          })(),
        ]);
        expect(await unmarkedReaders(world)).toEqual([]);
      }
      expect(world.deadlocks()).toEqual([]);
    });
  });
});
