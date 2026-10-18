// Invalidation versus commit ordering under READ COMMITTED (the design level),
// REPEATABLE READ and SERIALIZABLE. ARCHITECTURE 5.1 says isolation is READ
// COMMITTED and row locks make check-then-write safe, and that the concurrency
// adversary "proves equivalence under SERIALIZABLE". The database default of
// the test database is switched before any pool exists, so the PRODUCTION
// transactions (withTransaction issues a plain BEGIN) run at that level.
//
// Per level, the same scenarios must have the same outcome:
//   writer-first      the authority advances, then the commit: blocked, nothing written
//   commit-first      the commit holds its locks, the writer waits: commit lands at the
//                     expected version, the writer follows at version + 1
//   invalidate-first / commit-first for an observed premise (registration of a new revision)
//   contended commits 12 intents admitted at one expected version race 4 writers: the
//                     parked winner commits exactly once, at its expected version; every
//                     other commit is blocked; nothing else is written (lower bounds on
//                     commits make a vacuous run fail)
// 40001 serialization failures are retried by withTransaction (counted, reported);
// one that ESCAPES the retries is finding CW-2 (medium), reproduced deterministically
// in the second half of this file.
import { describe, expect, it } from 'vitest';
import {
  clearBarriers,
  setBarrier,
} from '../../../../src/server/nemodots/actions/index.js';
import {
  actionHistory,
  authorizations,
  configState,
  externalChange,
  historyRows,
  intentStatus,
  observed,
  park,
  proposePool,
  scenario,
  waitForLockWaiters,
  withWorld,
  type World,
} from './harness.js';

const settleOutcome = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ ok: true as const, value }),
    (error: { code?: string }) => ({
      ok: false as const,
      code: error.code ?? 'error',
    }),
  );

const LEVELS = ['read committed', 'repeatable read', 'serializable'] as const;

describe.each(LEVELS)('invalidation vs commit under %s', (isolation) => {
  const run = <T>(fn: (world: World) => Promise<T>) =>
    withWorld(fn, { isolation });

  it('writer first: the commit is blocked and writes nothing', async () => {
    await run(async (world) => {
      // The production pool really runs at the level under test.
      const shown = await world.app.query('SHOW default_transaction_isolation');
      expect(shown.rows[0].default_transaction_isolation).toBe(isolation);
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      const v = await externalChange(world, 'db.pool_max', 14);
      const result = await world.service.commit(
        intent.id,
        admitted.dispatch!.fence,
      );
      expect(result.status).toBe('blocked');
      expect((await configState(world, 'db.pool_max')).version).toBe(v);
      expect(await actionHistory(world, intent.id)).toHaveLength(0);
      expect(world.failures.filter((f) => f.code === '40P01')).toEqual([]);
    });
  });

  it('commit first: the writer queues behind the commit, lands at version + 1; the action row sits exactly at the expected successor', async () => {
    await run(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      const parked = park('after_lock_before_commit');
      const commit = world.service.commit(intent.id, admitted.dispatch!.fence);
      await parked.arrived;
      const write = externalChange(world, 'db.pool_max', 14);
      await waitForLockWaiters(world, 1);
      parked.release();
      const [committed, writerVersion] = await Promise.all([commit, write]);
      expect(committed.status).toBe('committed');
      expect(writerVersion).toBe(3);
      const rows = await historyRows(world, 'db.pool_max');
      expect(rows.map((r) => [r.version, r.caused_by_action_id])).toEqual([
        [1, null],
        [2, intent.id],
        [3, null],
      ]);
      expect((await configState(world, 'db.pool_max')).value).toBe(14);
    });
  });

  it('observed premise: registration first blocks the commit; commit first (parked) makes the registration wait', async () => {
    await run(async (world) => {
      // registration first
      const s1 = await scenario(world);
      const i1 = await proposePool(world, s1, 20);
      const a1 = await world.service.admit(i1.id, 'dispatcher-a');
      await observed(world, 'checkout.health', {
        status: 'ok',
        checks: { postgres: true },
      });
      const blocked = await world.service.commit(i1.id, a1.dispatch!.fence);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockReason).toBe('stale_version');

      // commit first
      const s2 = await scenario(world);
      const i2 = await proposePool(world, s2, 20);
      const a2 = await world.service.admit(i2.id, 'dispatcher-a');
      const parked = park('after_lock_before_commit');
      const commit = world.service.commit(i2.id, a2.dispatch!.fence);
      await parked.arrived;
      const registration = observed(world, 'checkout.health', {
        status: 'down',
      });
      await waitForLockWaiters(world, 1);
      parked.release();
      const [committed, receipt] = await Promise.all([commit, registration]);
      expect(committed.status).toBe('committed');
      expect(receipt.sourceRevision).toBeGreaterThan(2);
    });
  });

  it('contended commits: 12 admitted intents at one expected version race 4 writers on the row; exactly one action wins, at its expected version; the rest are blocked, nothing else is written', async () => {
    await run(async (world) => {
      const escaped: string[] = [];
      let totalCommitted = 0;
      for (let round = 0; round < 3; round += 1) {
        // All intents are admitted BEFORE any writer starts: the admissions
        // are not the race, the commits are.
        const intents: {
          id: string;
          expected: number;
          fence: number;
        }[] = [];
        for (let i = 0; i < 12; i += 1) {
          const s = await scenario(world, { key: 'db.pool_max' });
          const intent = await proposePool(world, s, 11 + (i % 8));
          const admitted = await world.service.admit(intent.id, `d${i}`);
          expect(admitted.status).toBe('admitted');
          intents.push({
            id: intent.id,
            expected: intent.expectedTargetVersion,
            fence: admitted.dispatch!.fence,
          });
        }
        const winner = (round * 5) % intents.length;
        const commitOf = (i: number) =>
          world.service.commit(intents[i].id as never, intents[i].fence);
        const rejected = (label: string) => (error: { code?: string }) => {
          escaped.push(`${label}: ${error.code ?? error}`);
          return null;
        };
        // The winner parks holding the member row with every write done.
        const parked = park('after_lock_before_commit');
        const winning = commitOf(winner).catch(rejected(`winner ${winner}`));
        await parked.arrived;
        const others = intents
          .map((_, i) => i)
          .filter((i) => i !== winner)
          .map((i) => commitOf(i).catch(rejected(`commit ${i}`)));
        const writers = Array.from({ length: 4 }, (_, w) =>
          externalChange(world, 'db.pool_max', 15 + round * 4 + w).catch(
            rejected(`writer ${w}`),
          ),
        );
        await waitForLockWaiters(world, 4);
        parked.release();
        await Promise.all([winning, ...others, ...writers]);

        const history = await historyRows(world, 'db.pool_max');
        history.forEach((row, i) => expect(row.version).toBe(i + 1)); // gapless
        let committed = 0;
        for (const [i, round_] of intents.entries()) {
          const status = await intentStatus(world, round_.id);
          const wrote = await actionHistory(world, round_.id);
          if (status.status === 'committed') {
            committed += 1;
            expect(i).toBe(winner);
            expect(wrote).toHaveLength(1);
            // CAS: only at the expected version.
            expect(wrote[0].version).toBe(round_.expected + 1);
          } else {
            expect(wrote).toHaveLength(0);
            if (status.status === 'blocked')
              expect(status.blockReason).toBe('stale_version');
            // A commit that was rejected (serialization failure that survived
            // the retries) leaves the intent admitted and retryable.
            else expect(status.status).toBe('admitted');
          }
        }
        totalCommitted += committed;
        // At most one action can win a version.
        expect(committed).toBeLessThanOrEqual(1);
        const sawSerializationFailure = world.failures.some(
          (f) => f.code === '40001',
        );
        // Lower bound: the parked winner committed, unless PostgreSQL itself
        // reported a serialization failure at a stronger isolation level.
        if (isolation === 'read committed') {
          expect(committed).toBe(1);
          expect(escaped).toEqual([]);
        } else expect(committed === 1 || sawSerializationFailure).toBe(true);
        expect(world.failures.filter((f) => f.code === '40P01')).toEqual([]);
      }
      expect(totalCommitted).toBeGreaterThanOrEqual(
        isolation === 'read committed' ? 3 : 1,
      );
      // Anything that escaped the retries may be a serialization failure
      // (finding CW-2) and nothing else.
      for (const reason of escaped) expect(reason).toMatch(/: 40001$/);
    });
  });
});

// FINDING CW-2 (medium): withTransaction retries 40001 five times, then
// rethrows. admit and commit use that budget, so under REPEATABLE READ or
// SERIALIZABLE a persistent serialization failure surfaces as a REJECTED call,
// not as a `blocked` decision: ARCHITECTURE 5.1 says the outcomes are
// equivalent at every level, which is true for safety and false for liveness.
//
// Deterministic forcing: the before_lock barrier runs inside the real
// admission / commit transaction AFTER its first statement (so a snapshot
// exists at the stronger levels) and BEFORE the intent row lock. The handler
// modifies the intent row in another session and commits, which makes
// PostgreSQL itself raise 40001 ("could not serialize access due to concurrent
// update") at the FOR UPDATE of every attempt at REPEATABLE READ and
// SERIALIZABLE. At READ COMMITTED the same hook is harmless: FOR UPDATE reads
// the latest row version (the design level is immune).
describe.each(LEVELS)(
  'CW-2 persistent serialization failure under %s',
  (isolation) => {
    const stronger = isolation !== 'read committed';

    async function touchOnEveryAttempt(
      world: World,
      stage: 'admit' | 'commit',
    ) {
      const attempts: string[] = [];
      setBarrier('before_lock', async (context) => {
        if (context.stage !== stage) return;
        attempts.push(context.actionId);
        await world.admin.query(
          'UPDATE coordinator.action_intents SET status = status WHERE id = $1',
          [context.actionId],
        );
      });
      return attempts;
    }

    it('admit: the escape is a loud rejection after the retry budget; the intent stays proposed, nothing is decided silently', async () => {
      await withWorld(
        async (world) => {
          const s = await scenario(world);
          const intent = await proposePool(world, s, 20);
          const attempts = await touchOnEveryAttempt(world, 'admit');
          const outcome = await settleOutcome(
            world.service.admit(intent.id, 'dispatcher-a'),
          );
          if (!stronger) {
            expect(outcome).toMatchObject({ ok: true });
            expect(attempts).toHaveLength(1);
            expect(world.failures.filter((f) => f.code === '40001')).toEqual(
              [],
            );
            expect((await intentStatus(world, intent.id)).status).toBe(
              'admitted',
            );
            return;
          }
          // The retry budget is spent (withTransaction default of 5 attempts)...
          expect(attempts).toHaveLength(5);
          expect(outcome).toMatchObject({ ok: false, code: '40001' });
          expect(world.failures.filter((f) => f.code === '40001')).toHaveLength(
            5,
          );
          // ...and nothing was decided: not blocked, not admitted, no Authorization.
          expect((await intentStatus(world, intent.id)).status).toBe(
            'proposed',
          );
          expect(await authorizations(world, intent.id)).toHaveLength(0);
          // The rejection is recoverable: once the contention stops, the same
          // call decides normally.
          clearBarriers();
          const retried = await world.service.admit(intent.id, 'dispatcher-a');
          expect(retried.status).toBe('admitted');
        },
        { isolation },
      );
    });

    it('commit: the escape is a loud rejection; the intent stays admitted and claimable, nothing is written', async () => {
      await withWorld(
        async (world) => {
          const s = await scenario(world);
          const intent = await proposePool(world, s, 20);
          const admitted = await world.service.admit(intent.id, 'dispatcher-a');
          expect(admitted.status).toBe('admitted');
          const attempts = await touchOnEveryAttempt(world, 'commit');
          const outcome = await settleOutcome(
            world.service.commit(intent.id, admitted.dispatch!.fence),
          );
          if (!stronger) {
            expect(outcome).toMatchObject({
              ok: true,
              value: { status: 'committed' },
            });
            expect(attempts).toHaveLength(1);
            return;
          }
          expect(attempts).toHaveLength(5); // commit passes maxAttempts: 5 explicitly
          expect(outcome).toMatchObject({ ok: false, code: '40001' });
          expect((await intentStatus(world, intent.id)).status).toBe(
            'admitted',
          );
          expect(await actionHistory(world, intent.id)).toHaveLength(0);
          expect((await configState(world, 'db.pool_max')).value).toBe(10);
          clearBarriers();
          const retried = await world.service.commit(
            intent.id,
            admitted.dispatch!.fence,
          );
          expect(retried.status).toBe('committed');
        },
        { isolation },
      );
    });
  },
);
