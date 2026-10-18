// Lease overlap at the expiry boundary (ARCHITECTURE 5.1, 6).
// Expected: an admitted intent's dispatcher lease is renewable only by a
// re-admission after it expired; "an expired dispatcher cannot admit or
// commit"; the intent row lock serializes the lease check with every state
// change, so two dispatchers can never both commit one action, and the fence
// recorded with the commit is the fence stored on the intent.
//
// Stated residual (not a defect): the lease is evaluated with the database
// clock when the intent row is first read UNDER ITS LOCK. A commit that passed
// that check may finish a few milliseconds after the stated expiry, and a commit
// that already holds the row lock when the lease lapses completes; no other
// dispatcher can interleave because it must wait for the same row lock.
import { describe, expect, it } from 'vitest';
import {
  actionHistory,
  authorizations,
  configState,
  createAttempt,
  expireDispatcherLease,
  intentStatus,
  park,
  proposePool,
  scenario,
  sleep,
  valueDigest,
  waitForLockWaiters,
  withWorld,
} from './harness.js';

describe('lease overlap at the expiry boundary', () => {
  it('a commit that reaches its row lock after the lease lapsed is refused even though the call began before', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const a = await world.service.admit(intent.id, 'dispatcher-a');
      const parked = park('before_lock', (c) => c.stage === 'commit');
      const commit = world.service.commit(intent.id, a.dispatch!.fence).then(
        (v) => v,
        (e: unknown) => e,
      );
      await parked.arrived; // the call began with a valid lease
      await expireDispatcherLease(world, intent.id); // ...which lapses before the lock
      parked.release();
      const outcome = (await commit) as Error;
      expect(outcome.name).toBe('DispatchFenceError');
      expect((await configState(world, 'db.pool_max')).version).toBe(1);
      expect((await intentStatus(world, intent.id)).status).toBe('admitted');
    });
  });

  it('a commit already holding the row lock when the lease lapses completes; the competing re-admission waits and then finds it committed', async () => {
    await withWorld(
      async (world) => {
        const s = await scenario(world);
        const intent = await proposePool(world, s, 20);
        const a = await world.service.admit(intent.id, 'dispatcher-a');
        const parked = park('after_lock_before_commit');
        const commit = world.service.commit(intent.id, a.dispatch!.fence);
        await parked.arrived;
        await sleep(900); // the 600 ms lease lapses while the commit holds every lock
        const readmit = world.service.admit(intent.id, 'dispatcher-b');
        await waitForLockWaiters(world, 1);
        parked.release();
        const [committed, b] = await Promise.all([commit, readmit]);
        expect(committed.status).toBe('committed');
        expect(b.status).toBe('committed'); // unchanged: B did not take a new fence
        expect(await actionHistory(world, intent.id)).toHaveLength(1);
        const fences = (await authorizations(world, intent.id))
          .map((x) => x.dispatch_fence_token)
          .filter(Boolean);
        expect(new Set(fences).size).toBe(1);
      },
      { dispatchLeaseMs: 600 },
    );
  });

  it('randomized boundary: A commits while B re-admits around the expiry instant, 24 times: never two commits, committer fence == stored fence', async () => {
    await withWorld(
      async (world) => {
        const tally = { aWon: 0, bWon: 0, neither: 0 };
        for (let i = 0; i < 24; i += 1) {
          const attempt = await createAttempt(world);
          const s = await scenario(world, { attempt, key: 'ui.banner_text' });
          const state = await configState(world, 'ui.banner_text');
          const intent = await world.service.propose(
            {
              action: 'set_config',
              payload: {
                key: 'ui.banner_text',
                value: `banner-${i}`,
                expectedCurrentValueDigest: valueDigest(state.value as string),
              },
              supportingReceiptIds: [],
              rationale: 'boundary',
            } as never,
            {
              ...s.attempt.context,
              modelCallId: s.modelCallId,
              toolCallId: s.toolCallId,
            } as never,
          );
          const a = await world.service.admit(intent.id, 'dispatcher-a');
          expect(a.status).toBe('admitted');
          const { rows } = await world.admin.query<{ ms: number }>(
            `SELECT extract(epoch FROM (dispatcher_lease_expires_at - clock_timestamp())) * 1000 AS ms
               FROM coordinator.action_intents WHERE id = $1`,
            [intent.id],
          );
          const remaining = Number(rows[0].ms);
          const jitter = (k: number) => ((i * 7 + k * 13) % 41) - 20; // -20..+20 ms
          const aRun = (async () => {
            await sleep(Math.max(0, remaining + jitter(1)));
            return world.service.commit(intent.id, a.dispatch!.fence).then(
              (v) => v,
              (e: unknown) => e as Error,
            );
          })();
          const bRun = (async () => {
            await sleep(Math.max(0, remaining + jitter(2)));
            const admitted = await world.service.admit(
              intent.id,
              'dispatcher-b',
            );
            if (
              admitted.status !== 'admitted' ||
              admitted.dispatch!.owner !== 'dispatcher-b'
            )
              return admitted;
            return world.service
              .commit(intent.id, admitted.dispatch!.fence)
              .then(
                (v) => v,
                (e: unknown) => e as Error,
              );
          })();
          await Promise.all([aRun, bRun]);

          const writes = await actionHistory(world, intent.id);
          expect(writes.length).toBeLessThanOrEqual(1);
          const commitAuthz = (await authorizations(world, intent.id)).filter(
            (x) => x.decision === 'committed',
          );
          expect(commitAuthz.length).toBe(writes.length);
          const status = await intentStatus(world, intent.id);
          if (writes.length === 1) {
            expect(status.status).toBe('committed');
            expect(Number(commitAuthz[0].dispatch_fence_token)).toBe(
              status.fence,
            );
            if (status.fence === a.dispatch!.fence) tally.aWon += 1;
            else tally.bWon += 1;
          } else tally.neither += 1;
        }
        expect(tally.aWon + tally.bWon + tally.neither).toBe(24);
        expect(world.deadlocks()).toEqual([]);
      },
      { dispatchLeaseMs: 250 },
    );
  });
});
