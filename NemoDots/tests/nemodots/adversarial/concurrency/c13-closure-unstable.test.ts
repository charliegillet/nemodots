// C13 / C14 neighbour, FINDING CW-8: a superseding registration can be starved
// by read-set writers. The ledger pre-locks the coordinator rows of the closure
// (ledger/prelock.ts): preview without locks, lock those rows, take the ledger
// locks, re-read the closure; a reader that committed an edge in between makes
// the round fail and the next round starts, at most MAX_LOCK_ROUNDS = 6 times,
// then ClosureUnstableError("Nothing was written; the caller retries the whole
// step"). ARCHITECTURE 5.2 / 14 C14 only designs the cap path (pause + coarse
// invalidation + register with the closure skipped) for ClosureCapExceeded.
//
// Expected: nothing is lost (no write, the head stays supported, a retry
// succeeds and marks every reader); every caller that can supersede treats the
// error as a lost race. The watcher does (its per-source guard reports an error
// event and the next poll retries). The observe_source executor does not: its
// loop catches only Stale / RevisionMismatch / DigestMismatch, so the error
// leaves observe() untyped (CW-8b, recorded as it.fails).
//
// Deterministic forcing (no sleeps, no production change): each round of the
// registration is held at its FIRST coordinator row lock by a raw transaction
// that holds that attempt row FOR UPDATE; while it waits, one new reader
// commits its edge; releasing the holder lets the round proceed, find the new
// attempt unlocked and fail; the next round blocks on the next holder. After 6
// failed rounds the registration throws. The wait is on a specific
// transaction id in pg_locks, so every step is ordered by PostgreSQL itself.
import { describe, expect, it } from 'vitest';
import type { SourceKey } from '../../../../src/server/nemodots/contracts/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/index.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { recordReadSet } from '../../../../src/server/nemodots/ledger/index.js';
import { createLedgerObserver } from '../../../../src/server/nemodots/team/observer.js';
import {
  OWNER,
  createAttempt,
  emitModelCall,
  observed,
  registerObserved,
  until,
  watcherRig,
  withWorld,
  type Attempt,
  type World,
} from './harness.js';

const HEALTH = 'checkout.health';
const ROUNDS = 6; // MAX_LOCK_ROUNDS of ledger/prelock.ts

/** 7 attempts sorted by id (the registration locks them in id order). */
async function sortedAttempts(world: World): Promise<Attempt[]> {
  const attempts = await Promise.all(
    Array.from({ length: ROUNDS + 1 }, () => createAttempt(world)),
  );
  return attempts.sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
}

/**
 * Drives `register` through ROUNDS failed lock rounds. `receiptId` is the head
 * receipt every reader rests on. Resolves with the registration's outcome.
 */
async function starve<T>(
  world: World,
  attempts: Attempt[],
  receiptId: string,
  register: () => Promise<T>,
) {
  const read = (attempt: Attempt) =>
    withTransaction(world.app, (client) =>
      recordReadSet(client, {
        missionId: attempt.missionId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        receiptIds: [receiptId],
      }),
    );
  await read(attempts[0]);
  // One holder per round: attempt row k FOR UPDATE, remembered with its xid.
  const holders: { release: () => Promise<void>; xid: string }[] = [];
  for (let k = 0; k < ROUNDS; k += 1) {
    const client = await world.admin.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT 1 FROM coordinator.task_attempts WHERE id = $1 FOR UPDATE',
      [attempts[k].attemptId],
    );
    const { rows } = await client.query<{ xid: string }>(
      'SELECT pg_current_xact_id()::xid::text AS xid',
    );
    holders.push({
      xid: rows[0].xid,
      release: async () => {
        try {
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      },
    });
  }
  const settled = register().then(
    (value) => ({ ok: true as const, value }),
    (error: Error & { code?: string }) => ({ ok: false as const, error }),
  );
  for (let k = 0; k < ROUNDS; k += 1) {
    // Round k+1 of the registration is blocked on holder k...
    await until(async () => {
      const { rows } = await world.admin.query(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1`,
        [holders[k].xid],
      );
      return rows.length > 0;
    }, `registration blocked on holder ${k}`);
    // ...so a new reader commits its edge while it holds no ledger lock...
    await read(attempts[k + 1]);
    // ...and the round, once released, finds an attempt it did not lock.
    await holders[k].release();
  }
  return settled;
}

describe('FINDING CW-8: a superseding registration starved by read-set writers', () => {
  it('ledger: six failed lock rounds end in ClosureUnstableError with nothing written; the retry succeeds and marks every reader', async () => {
    await withWorld(async (world) => {
      const attempts = await sortedAttempts(world);
      const head = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const outcome = await starve(world, attempts, head.id, () =>
        registerObserved(world, 'checkout.health', { status: 'ok' }),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toMatchObject({
        name: 'ClosureUnstableError',
        code: 'closure_unstable',
      });
      // Nothing was written: the head is still revision 1 and supported, the
      // readers are still running, no transition row exists.
      const { rows } = await world.admin.query<{
        source_revision: number;
        status: string;
      }>(
        `SELECT r.source_revision, r.status FROM ledger.observation_receipts r
           JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1
          ORDER BY r.source_revision`,
        [HEALTH],
      );
      expect(rows).toEqual([{ source_revision: 1, status: 'supported' }]);
      const running = await world.admin.query(
        `SELECT 1 FROM coordinator.task_attempts WHERE status = 'running' AND id = ANY($1::uuid[])`,
        [attempts.map((a) => a.attemptId)],
      );
      expect(running.rows).toHaveLength(attempts.length);
      // "The caller retries the whole step": with the contention gone it lands
      // and marks every reader.
      const retried = await registerObserved(world, 'checkout.health', {
        status: 'ok',
      });
      expect(retried.newRevision).toBe(true);
      expect(
        retried.invalidation?.perMission
          .flatMap((m) => m.affected.attemptIds)
          .sort(),
      ).toEqual(attempts.map((a) => a.attemptId).sort());
      expect(world.deadlocks()).toEqual([]);
    });
  });

  it('watcher: the starved cycle is reported as an error event and a failed outcome, and the next cycle registers (self-healing)', async () => {
    await withWorld(async (world) => {
      const attempts = await sortedAttempts(world);
      const head = await observed(world, 'checkout.health', {
        status: 'degraded',
      });
      const rig = watcherRig(world, {
        observedSources: [HEALTH as SourceKey],
      });
      const outcome = await starve(world, attempts, head.id, () =>
        rig.watcher.observe([HEALTH]),
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value[0]).toMatchObject({ outcome: 'failed' });
      expect(
        rig.events.filter((e) => e.type === 'error').map((e) => e.message),
      ).toEqual([
        expect.stringContaining('the invalidation closure kept changing'),
      ]);
      const next = await rig.watcher.observe([HEALTH]);
      expect(next[0]).toMatchObject({ outcome: 'registered', revision: 2 });
    });
  });

  it.fails(
    'FINDING CW-8b: observe_source treats a starved registration as a lost race (typed ToolError or retry), not an untyped ClosureUnstableError',
    async () => {
      await withWorld(async (world) => {
        const attempts = await sortedAttempts(world);
        const head = await observed(world, 'checkout.health', {
          status: 'degraded',
        });
        const reader = await createAttempt(world);
        const call = await emitModelCall(world, reader, []);
        const observer = createLedgerObserver({
          pool: world.app,
          readers: {
            read: async () => ({
              normalizedValue: { status: 'ok' }, // differs from the head: a superseding registration
              raw: null,
              revisionHint: null,
            }),
          },
          reader: {
            mission: async () => ({
              scope: {
                ownerId: OWNER,
                missionId: world.missionId,
                spaceId: null,
                environment: 'test',
                resource: 'checkout',
              },
              goal: '',
              constraints: [],
            }),
          } as never,
          events: createEventSink(),
        });
        const outcome = await starve(world, attempts, head.id, () =>
          observer.observe({
            context: reader.context,
            sourceKey: HEALTH as SourceKey,
            toolCallId: call.toolCallId,
            modelCallId: call.modelCallId as never,
          }),
        );
        // Either a receipt (the loop retried) or the executor's typed error.
        if (outcome.ok) return;
        expect(outcome.error).toMatchObject({ name: 'ToolError' });
      });
    },
  );
});
