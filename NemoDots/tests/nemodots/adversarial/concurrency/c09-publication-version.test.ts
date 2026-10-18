// C9 (medium): G2 without row locks lets a publication land under an
// already-advanced version.
// Expected (ARCHITECTURE 4 G2, 14 C9, 5.2): SupportValidator.assertCurrent
// runs inside the publishing transaction with the controlled rows of its
// vector locked FOR SHARE, so a concurrent writer's FOR UPDATE waits until the
// publication commits (the publication is then correctly ordered BEFORE the
// advance), and a publication that starts after an uncommitted advance waits,
// then fails closed: nothing is written, the attempt is invalidated (C13).
import { describe, expect, it } from 'vitest';
import { supportValidator } from '../../../../src/server/nemodots/ledger/index.js';
import {
  configState,
  countRows,
  createAttempt,
  externalChange,
  latch,
  memberReceipt,
  sleep,
  waitForLockWaiters,
  withWorld,
} from './harness.js';

describe('C9 publication under an advancing version', () => {
  it('a publication holding FOR SHARE makes an injector write wait; the publication lands first and the write follows', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const parked = latch();
      const release = latch();
      const coordinator = world.coordinator({
        validator: {
          async assertCurrent(client, ids, opts) {
            const checked = await supportValidator.assertCurrent(
              client,
              ids,
              opts,
            );
            parked.open(undefined);
            await release.promise; // locks still held inside the publication tx
            return checked;
          },
        },
      });
      const publication = coordinator.publishOutput(attempt.context, {
        kind: 'finding',
        content: { note: 'pool is too small' },
        dependencyVector: [
          {
            sourceKey: member.source.key,
            sourceRevision: member.sourceRevision,
            receiptId: member.id,
          },
        ],
      } as never);
      await parked.promise;
      const write = externalChange(world, 'db.pool_max', 14);
      await waitForLockWaiters(world, 1);
      // Not yet advanced: the writer is queued behind the publication's share lock.
      expect((await configState(world, 'db.pool_max')).version).toBe(1);
      release.open(undefined);
      const [published, version] = await Promise.all([publication, write]);
      expect(published.outputId).toBeTruthy();
      expect(version).toBe(2);
      expect(
        await countRows(world, 'coordinator.task_outputs', 'attempt_id = $1', [
          attempt.attemptId,
        ]),
      ).toBe(1);
    });
  });

  it('a publication that starts behind an uncommitted advance waits, then fails closed: no output, attempt invalidated', async () => {
    await withWorld(async (world) => {
      const attempt = await createAttempt(world);
      const member = await memberReceipt(world, 'db.pool_max');
      const coordinator = world.coordinator();
      const client = await world.injector.connect();
      let outcome: unknown;
      try {
        await client.query('BEGIN');
        await client.query(
          "UPDATE checkout.config_entries SET value = '14'::jsonb, version = version + 1 WHERE key = 'db.pool_max'",
        );
        await client.query(
          `INSERT INTO checkout.config_versions (key, version, value, before_digest, after_digest, caused_by_actor)
           VALUES ('db.pool_max', 2, '14'::jsonb, NULL, NULL, 'injector')`,
        );
        const publication = coordinator
          .publishOutput(attempt.context, {
            kind: 'finding',
            content: { note: 'stale' },
            dependencyVector: [
              {
                sourceKey: member.source.key,
                sourceRevision: member.sourceRevision,
                receiptId: member.id,
              },
            ],
          } as never)
          .then(
            (value) => value,
            (error: unknown) => error,
          );
        await waitForLockWaiters(world, 1);
        await sleep(100);
        await client.query('COMMIT');
        outcome = await publication;
      } finally {
        client.release();
      }
      expect((outcome as Error).name).toBe('SupportError');
      expect(
        await countRows(world, 'coordinator.task_outputs', 'attempt_id = $1', [
          attempt.attemptId,
        ]),
      ).toBe(0);
      const { rows } = await world.admin.query(
        'SELECT status FROM coordinator.task_attempts WHERE id = $1',
        [attempt.attemptId],
      );
      expect(rows[0].status).toBe('invalidated');
      expect(world.deadlocks()).toEqual([]);
    });
  });
});
