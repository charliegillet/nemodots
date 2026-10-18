// Author fences at the proposal boundary, idempotent self-write settlement, and
// a mixed stress of every writer of the authority and the ledger at once.
// Expected (ARCHITECTURE 6): an expired or taken-over author cannot publish a
// proposal; a proposal published by a still-valid author stays valid for
// dispatch after the author's lease ends; the settlement of a committed
// set_config is idempotent per action; and the lock orders of commit, closure,
// publication and injector do not form a cycle (no 40P01 observed before the
// transaction retry).
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { recordReadSet } from '../../../../src/server/nemodots/ledger/index.js';
import { advanceConfigUnconditionally } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import {
  actionHistory,
  admitAndCommit,
  configState,
  countRows,
  createAttempt,
  emitModelCall,
  externalChange,
  intentStatus,
  memberReceipt,
  observed,
  park,
  proposeCtx,
  proposePool,
  resultOutcomes,
  scenario,
  setConfigInput,
  sleep,
  waitForLockWaiters,
  withWorld,
  type ConfigScalar,
} from './harness.js';

describe('author fence at propose', () => {
  it('a takeover (fence bumped) that commits while a proposal waits for the attempt row: the proposal is refused, nothing written', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const state = await configState(world, 'db.pool_max');
      const client = await world.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT 1 FROM coordinator.task_attempts WHERE id = $1 FOR UPDATE',
          [s.attempt.attemptId],
        );
        const proposal = world.service
          .propose(
            setConfigInput(20, state.value as ConfigScalar),
            proposeCtx(s),
          )
          .then(
            (v) => v,
            (e: unknown) => e as Error,
          );
        await waitForLockWaiters(world, 1);
        // The reaper takes over: attempt expired, task fence bumped.
        await client.query(
          "UPDATE coordinator.task_attempts SET status = 'expired' WHERE id = $1",
          [s.attempt.attemptId],
        );
        await client.query(
          'UPDATE coordinator.tasks SET fence_seq = fence_seq + 1 WHERE id = $1',
          [s.attempt.taskId],
        );
        await client.query('COMMIT');
        const outcome = await proposal;
        expect((outcome as Error).name).toBe('FenceError');
      } finally {
        client.release();
      }
      expect(await countRows(world, 'coordinator.action_intents')).toBe(0);
    });
  });

  it('an expired author lease cannot publish a proposal', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      await world.admin.query(
        "UPDATE coordinator.task_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [s.attempt.attemptId],
      );
      const state = await configState(world, 'db.pool_max');
      await expect(
        world.service.propose(
          setConfigInput(20, state.value as ConfigScalar),
          proposeCtx(s),
        ),
      ).rejects.toMatchObject({ name: 'FenceError' });
      expect(await countRows(world, 'coordinator.action_intents')).toBe(0);
    });
  });

  it('a proposal published while the author was valid remains admissible after the author lease ends', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      await world.admin.query(
        "UPDATE coordinator.task_attempts SET status = 'published', lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [s.attempt.attemptId],
      );
      const { committed } = await admitAndCommit(world, intent.id);
      expect(committed.status).toBe('committed');
    });
  });
});

describe('settlement idempotency', () => {
  it('six concurrent settleFromHistory(verified) calls: one transition, one verified receipt', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      await admitAndCommit(world, intent.id);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          world.service.settleFromHistory(intent.id, 'verified'),
        ),
      );
      for (const r of results) expect(r.status).toBe('fulfilled');
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
      expect(
        (await resultOutcomes(world, intent.id)).filter(
          (o) => o === 'verified',
        ),
      ).toHaveLength(1);
      // A late contradictory verdict does not rewrite a settled intent.
      await world.service
        .settleFromHistory(intent.id, 'failed')
        .catch(() => undefined);
      expect((await intentStatus(world, intent.id)).status).toBe('verified');
    });
  });
});

// Mixed stress of every writer of the authority and the ledger at once.
//   stage A: three intents that nothing in the stage can invalidate (their
//     member rows and the health value are never changed) MUST commit; around
//     them run health confirmations (same value: receipt-row locks shared with
//     the commits), supersessions of redis.stats whose closures mark attempts
//     that read it (coordinator rows first, then ledger), publications citing
//     the health receipt (G2 share locks), injector updates of ui.banner_text,
//     and a key insert plus delete (collection row).
//   stage B: two more intents race a real supersession of the health receipt
//     (a different value) and more publications: each ends committed or
//     blocked, never half done.
// "parked": the first stage-A commit parks after its last write, holding its
// member row, the mission share lock and the receipt rows, while every writer
// queues behind it; "free": staggered start, no barrier.
describe.each(['parked', 'free'] as const)(
  'mixed stress (%s): commits, closures, publications, injector writes',
  (mode) => {
    it('zero deadlocks, stage A commits, every stage-B outcome consistent, no running attempt on a superseded receipt', async () => {
      await withWorld(async (world) => {
        const propose = async (key: string, value: ConfigScalar) => {
          const s = await scenario(world, { key });
          const state = await configState(world, key);
          const intent = await world.service.propose(
            setConfigInput(value, state.value as ConfigScalar, { key }),
            proposeCtx(s),
          );
          const admitted = await world.service.admit(intent.id, `d-${key}`);
          expect(admitted.status, key).toBe('admitted');
          return { intent, fence: admitted.dispatch!.fence };
        };
        const stageA = [
          await propose('cache.schema_version', 3),
          await propose('db.pool_max', 12),
          await propose('routing.inventory_source', 'replica_stale'),
        ];
        const stageB = [
          await propose('db.statement_timeout_ms', 7000),
          await propose('orders.write_enabled', false),
        ];
        const commit = (entry: (typeof stageA)[number]) =>
          world.service.commit(entry.intent.id, entry.fence);

        const coordinator = world.coordinator();
        // A publisher cites the health receipt and, optionally, the ui.banner_text
        // member that the injector keeps changing (that one may be refused).
        const publisher = async (withUi: boolean) => {
          const attempt = await createAttempt(world);
          const health = await observed(world, 'checkout.health');
          const cited = withUi
            ? [health, await memberReceipt(world, 'ui.banner_text')]
            : [health];
          const call = await emitModelCall(world, attempt, cited);
          return { attempt, vector: call.vector };
        };
        const publish = (p: Awaited<ReturnType<typeof publisher>>) =>
          coordinator
            .publishOutput(p.attempt.context, {
              kind: 'finding',
              content: { note: 'stress' },
              dependencyVector: p.vector,
            } as never)
            .catch((error: Error) => error.name); // SupportError is a legitimate outcome
        const publishersA = await Promise.all(
          [false, false, true, true].map((withUi) => publisher(withUi)),
        );
        const redisReaders = await Promise.all(
          Array.from({ length: 3 }, () => createAttempt(world)),
        );
        const redisHead = await observed(world, 'redis.stats', { n: 0 });
        for (const reader of redisReaders)
          await withTransaction(world.app, (client) =>
            recordReadSet(client, {
              missionId: reader.missionId,
              taskId: reader.taskId,
              attemptId: reader.attemptId,
              receiptIds: [redisHead.id],
            }),
          );

        // --- stage A
        const parked =
          mode === 'parked' ? park('after_lock_before_commit') : null;
        const work: Promise<unknown>[] = [];
        if (parked) {
          work.push(commit(stageA[0]));
          await parked.arrived;
        }
        const stagger = (n: number) =>
          mode === 'free' ? sleep((n * 3) % 7) : Promise.resolve();
        const later = <T>(n: number, run: () => Promise<T>) =>
          stagger(n).then(run);
        for (let n = 0; n < 4; n += 1)
          work.push(later(n, () => observed(world, 'checkout.health')));
        for (let n = 1; n <= 3; n += 1)
          work.push(later(n, () => observed(world, 'redis.stats', { n })));
        const publishedA = publishersA.map((p, n) =>
          later(n, () => publish(p)),
        );
        work.push(...publishedA);
        for (let n = 0; n < 3; n += 1)
          work.push(
            later(n, () => externalChange(world, 'ui.banner_text', `b${n}`)),
          );
        work.push(
          later(5, async () => {
            await withTransaction(world.injector, (client) =>
              advanceConfigUnconditionally(client, {
                key: 'adv.tmp',
                value: 1,
                insertIfMissing: true,
                causedBy: { actor: 'injector' },
              }),
            );
            return withTransaction(world.injector, (client) =>
              advanceConfigUnconditionally(client, {
                key: 'adv.tmp',
                deleteKey: true,
                causedBy: { actor: 'injector' },
              }),
            );
          }),
        );
        stageA.forEach((entry, i) => {
          if (parked && i === 0) return;
          work.push(later(i + 2, () => commit(entry)));
        });
        if (parked) {
          await waitForLockWaiters(world, 3);
          parked.release();
        }
        const settledA = await Promise.allSettled(work);
        expect(
          settledA
            .filter((r) => r.status === 'rejected')
            .map((r) => String((r as PromiseRejectedResult).reason)),
        ).toEqual([]);
        // Publications that cite only the health receipt (never superseded in
        // stage A) must land; the ones citing ui.banner_text may be refused.
        expect(await Promise.all(publishedA.slice(0, 2))).not.toContain(
          'SupportError',
        );
        for (const entry of stageA) {
          expect((await intentStatus(world, entry.intent.id)).status).toBe(
            'committed',
          );
          const rows = await actionHistory(world, entry.intent.id);
          expect(rows).toHaveLength(1);
          expect(rows[0].version).toBe(entry.intent.expectedTargetVersion + 1);
        }
        // The redis.stats closures ran and marked every reader.
        for (const reader of redisReaders)
          expect(
            (
              await world.admin.query<{ status: string }>(
                'SELECT status FROM coordinator.task_attempts WHERE id = $1',
                [reader.attemptId],
              )
            ).rows[0].status,
          ).toBe('invalidated');

        // --- stage B
        const publishersB = await Promise.all(
          [false, false].map((withUi) => publisher(withUi)),
        );
        const racing: Promise<unknown>[] = [
          observed(world, 'checkout.health', { status: 'down' }),
          ...publishersB.map((p, n) => later(n + 1, () => publish(p))),
          ...stageB.map((entry, i) => later(i, () => commit(entry))),
        ];
        const settledB = await Promise.allSettled(racing);
        expect(
          settledB
            .filter((r) => r.status === 'rejected')
            .map((r) => String((r as PromiseRejectedResult).reason)),
        ).toEqual([]);
        for (const entry of stageB) {
          const status = (await intentStatus(world, entry.intent.id)).status;
          const rows = await actionHistory(world, entry.intent.id);
          expect(['committed', 'blocked']).toContain(status);
          expect(rows).toHaveLength(status === 'committed' ? 1 : 0);
        }
        expect(world.deadlocks()).toEqual([]);
        const unmarked = await world.admin.query(
          `SELECT a.id FROM coordinator.task_attempts a
             JOIN ledger.dependency_edges e ON e.to_kind = 'attempt' AND e.to_id = a.id
                  AND e.from_kind = 'receipt' AND e.kind = 'evidence'
             JOIN ledger.observation_receipts r ON r.id = e.from_id
            WHERE a.status = 'running' AND r.status = 'superseded'`,
        );
        expect(unmarked.rows).toEqual([]);
      });
    });
  },
);
