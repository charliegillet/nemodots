// W5.2: the controlled-commit boundary (G1, ARCHITECTURE 4 and 5.1) under
// deterministic races. Barriers are the action test hooks and pg_locks
// waiters, never sleeps.
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  DispatchFenceError,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { barrier, latch, withTimeout } from '../../helpers/barrier.js';
import {
  authorizations,
  configVersions,
  createWorld,
  injectConfig,
  intentRow,
  liveConfig,
  observeMember,
  observeObserved,
  proposeSetConfig,
  settle,
  waitForDbClockPast,
  waitForLockWaiters,
  withEnv,
  type Env,
} from './harness.js';

afterEach(() => clearHooks());

const STALE = ['stale_version', 'stale_pending_observation'];

async function admitted(env: Env, actionId: string, dispatcher = 'd1') {
  const intent = await env.actions.admit(actionId as never, dispatcher);
  expect(intent.status).toBe('admitted');
  return (intent as unknown as { dispatch: { fence: number } }).dispatch.fence;
}

describe('stale commits', () => {
  it('cleared: target advanced between admission and commit blocks the commit, value untouched', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await admitted(env, sc.intent.id);
      await injectConfig(env, 'db.pool_max', 33);

      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent.status).toBe('blocked');
      expect(STALE).toContain(result.intent.blockReason);
      expect(await liveConfig(env, 'db.pool_max')).toMatchObject({ value: 33 });
      const rows = await configVersions(env, 'db.pool_max');
      expect(rows.some((r) => r.caused_by_action_id === sc.intent.id)).toBe(
        false,
      );
      expect(
        (await authorizations(env, sc.intent.id)).map(
          (a) => `${a.stage}:${a.decision}`,
        ),
      ).toEqual(['admission:admitted', 'commit:blocked']);
    }));

  it('cleared: a write landing after the preliminary (unlocked) read is caught under lock', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await admitted(env, sc.intent.id);
      setHook('after_preliminary_read', async ({ actionId }) => {
        if (actionId === sc.intent.id)
          await injectConfig(env, 'db.pool_max', 44);
      });
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent.status).toBe('blocked');
      expect(STALE).toContain(result.intent.blockReason);
      expect(await liveConfig(env, 'db.pool_max')).toMatchObject({ value: 44 });
      expect(
        (await configVersions(env, 'db.pool_max')).filter(
          (r) => r.caused_by_action_id,
        ),
      ).toEqual([]);
    }));

  it('cleared: a writer arriving after the commit passed its checks waits and applies on top', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await admitted(env, sc.intent.id);
      const before = (await liveConfig(env, 'db.pool_max'))!.version;
      const parked = latch();
      const release = latch();
      setHook('after_lock_before_commit', async ({ actionId }) => {
        if (actionId !== sc.intent.id) return;
        parked.open();
        await release.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await withTimeout(parked.promise, 5_000, 'commit parked');
      let injectorDone = false;
      const injector = injectConfig(env, 'db.pool_max', 55).then((r) => {
        injectorDone = true;
        return r;
      });
      await waitForLockWaiters(env, 1);
      expect(injectorDone).toBe(false);
      release.open();
      expect((await commit).intent.status).toBe('committed');
      await injector;
      const rows = (await configVersions(env, 'db.pool_max')).filter(
        (r) => r.version > before,
      );
      // commit order: the action's row, then the injector's on top of it
      expect(rows.map((r) => [r.version, r.caused_by_actor])).toEqual([
        [before + 1, 'action'],
        [before + 2, 'injector'],
      ]);
      expect(rows[0].caused_by_action_id).toBe(sc.intent.id);
    }));
});

describe('duplicate delivery', () => {
  it('cleared: two simultaneous commits with one fence apply once and return one receipt', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await admitted(env, sc.intent.id);
      const both = barrier(2);
      setHook('before_lock', async ({ actionId, attempt }) => {
        if (actionId === sc.intent.id && attempt === 1) await both.arrive();
      });
      const [a, b] = await Promise.all([
        env.actions.commitDetailed(sc.intent.id, fence),
        env.actions.commitDetailed(sc.intent.id, fence),
      ]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.receipt?.id).toBeDefined();
      expect(a.receipt?.id).toBe(b.receipt?.id);
      const rows = (await configVersions(env, 'db.pool_max')).filter(
        (r) => r.caused_by_action_id === sc.intent.id,
      );
      expect(rows).toHaveLength(1);
      const commits = (await authorizations(env, sc.intent.id)).filter(
        (x) => x.stage === 'commit',
      );
      expect(commits).toHaveLength(1);
    }));
});

describe('dispatcher leases and fences', () => {
  it('cleared: a zombie dispatcher whose lease was re-claimed writes nothing', () =>
    withEnv(
      async (env) => {
        const sc = await proposeSetConfig(env);
        const old = await admitted(env, sc.intent.id, 'd1');
        const row = await intentRow(env, sc.intent.id);
        await waitForDbClockPast(env, row.dispatcher_lease_expires_at as Date);
        const reclaimed = await env.actions.reclaim(sc.intent.id, 'd2');
        const fresh = (reclaimed as unknown as { dispatch: { fence: number } })
          .dispatch.fence;
        expect(fresh).toBeGreaterThan(old);
        const authBefore = (await authorizations(env, sc.intent.id)).length;

        const zombie = await settle(env.actions.commit(sc.intent.id, old));
        expect(zombie.ok).toBe(false);
        expect(!zombie.ok && zombie.error).toBeInstanceOf(DispatchFenceError);
        expect((await authorizations(env, sc.intent.id)).length).toBe(
          authBefore,
        );
        expect(
          (await configVersions(env, 'db.pool_max')).filter(
            (r) => r.caused_by_action_id,
          ),
        ).toEqual([]);

        const ok = await env.actions.commit(sc.intent.id, fresh);
        expect(ok.status).toBe('committed');
      },
      { dispatchLeaseMs: 300 },
    ));

  // C-04 (low): REPRODUCED on the first run (2026-10-18 05:49), then fixed
  // in the working tree (admit.ts, 05:53). admit.ts mixed clock_timestamp()
  // (the expiry check) with now() (the transaction start) in the re-claim
  // UPDATE's guard: a re-claim whose transaction began before the lease
  // expired and checked it after expiry decided "expired", ran every
  // predicate, matched no row and threw ActionNotFoundError for an intent that
  // exists. Kept as the regression test.
  it('C-04 regression: a re-claim straddling the lease expiry does not report the intent as missing', () =>
    withEnv(
      async (env) => {
        const sc = await proposeSetConfig(env);
        await admitted(env, sc.intent.id, 'd1');
        const row = await intentRow(env, sc.intent.id);
        const expiry = row.dispatcher_lease_expires_at as Date;
        setHook('before_lock', async ({ actionId }) => {
          // inside the re-claim's transaction: BEGIN already ran
          if (actionId === sc.intent.id) await waitForDbClockPast(env, expiry);
        });
        const result = await settle(env.actions.reclaim(sc.intent.id, 'd2'));
        clearHooks();
        if (!result.ok)
          expect(result.error.name).not.toBe('ActionNotFoundError');
        expect(result.ok).toBe(true);
        const after = await intentRow(env, sc.intent.id);
        expect(after.status).toBe('admitted');
        expect(after.dispatch_owner).toBe('d2');
      },
      { dispatchLeaseMs: 1_500 },
    ));

  // C-05 (low): REPRODUCED (failing 06:05), then fixed in the working tree
  // (clock_timestamp() leases in admit.ts, rows.ts, dispatch.ts, 06:12-06:21).
  // Before the fix the re-claimed lease is computed from now(), the
  // transaction START (admit.ts:114, and transition() setIntervalMs in
  // rows.ts for first admission): a re-claim whose transaction waited (here
  // for the row lock window, in production behind a busy commit or a closure)
  // hands the new dispatcher a lease that is already expired or nearly so.
  // Its commit then fails DispatchFenceError(lease_expired) and the intent is
  // re-claimable again at once. ARCHITECTURE 6: the dispatcher lease is
  // NEMODOTS_DISPATCH_LEASE_MS from the grant. Expected: the new lease is
  // live when the re-claim returns and the new dispatcher can commit.
  it('C-05 regression: a re-claimed lease is live for the new dispatcher', () =>
    withEnv(
      async (env) => {
        const sc = await proposeSetConfig(env);
        await admitted(env, sc.intent.id, 'd1');
        const row = await intentRow(env, sc.intent.id);
        const expiry = row.dispatcher_lease_expires_at as Date;
        setHook('before_lock', async ({ actionId }) => {
          if (actionId === sc.intent.id) await waitForDbClockPast(env, expiry);
        });
        const reclaimed = await env.actions.reclaim(sc.intent.id, 'd2');
        clearHooks();
        const fence = (reclaimed as unknown as { dispatch: { fence: number } })
          .dispatch.fence;
        const { rows } = await env.admin.query<{ live: boolean }>(
          `SELECT dispatcher_lease_expires_at > clock_timestamp() AS live
             FROM coordinator.action_intents WHERE id = $1`,
          [sc.intent.id],
        );
        expect(rows[0].live).toBe(true);
        const committed = await settle(env.actions.commit(sc.intent.id, fence));
        expect(committed.ok).toBe(true);
      },
      { dispatchLeaseMs: 1_500 },
    ));
});

describe('ABA source revisions', () => {
  it('cleared: controlled value A -> B -> A still blocks the intent made against the first A', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const original = (await liveConfig(env, 'db.pool_max'))!.value;
      await injectConfig(env, 'db.pool_max', 77);
      await injectConfig(env, 'db.pool_max', original);
      // same value digest as the receipt, different version
      const blocked = await env.actions.admit(sc.intent.id, 'd1');
      expect(blocked.status).toBe('blocked');
      expect(STALE).toContain(blocked.blockReason);
      // once the watcher registers v+2 the original receipt is superseded
      const again = await observeMember(env, sc.world, 'db.pool_max');
      expect(again.sourceRevision).toBe(sc.member.sourceRevision + 2);
      const { rows } = await env.admin.query(
        'SELECT status FROM ledger.observation_receipts WHERE id = $1',
        [sc.member.id],
      );
      expect(rows[0].status).toBe('superseded');
    }));

  it('cleared: observed health ok -> degraded -> ok supersedes the first ok receipt', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      await observeObserved(env, sc.world, 'checkout.health', {
        status: 'degraded',
      });
      const back = await observeObserved(env, sc.world, 'checkout.health', {
        status: 'ok',
      });
      expect(back.newRevision).toBe(true);
      expect(back.receipt.sourceRevision).toBe(sc.health.sourceRevision + 2);
      const decided = await env.actions.admit(sc.intent.id, 'd1');
      expect(decided.status).toBe('blocked');
      expect(await liveConfig(env, 'db.pool_max')).toMatchObject({ value: 10 });
    }));
});

describe('cross-resource races', () => {
  it('cleared: a non-target key in the vector changing during the commit blocks it', () =>
    withEnv(async (env) => {
      const world = await createWorld(env);
      const other = await observeMember(env, world, 'db.statement_timeout_ms');
      const sc = await proposeSetConfig(env, {
        world,
        extraReceipts: [other],
      });
      const fence = await admitted(env, sc.intent.id);
      setHook('after_preliminary_read', async ({ actionId }) => {
        if (actionId === sc.intent.id)
          await injectConfig(env, 'db.statement_timeout_ms', 9_000);
      });
      const result = await env.actions.commitDetailed(sc.intent.id, fence);
      expect(result.intent.status).toBe('blocked');
      expect(STALE).toContain(result.intent.blockReason);
      expect(await liveConfig(env, 'db.pool_max')).toMatchObject({ value: 10 });
    }));

  it('cleared: an unrelated key is writable while a commit holds its own rows', () =>
    withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      const fence = await admitted(env, sc.intent.id);
      const parked = latch();
      const release = latch();
      setHook('after_lock_before_commit', async ({ actionId }) => {
        if (actionId !== sc.intent.id) return;
        parked.open();
        await release.promise;
      });
      const commit = env.actions.commitDetailed(sc.intent.id, fence);
      await withTimeout(parked.promise, 5_000, 'commit parked');
      // must not wait for the parked commit (per-resource versions)
      await withTimeout(
        injectConfig(env, 'ui.banner_text', 'unrelated'),
        5_000,
        'unrelated injector write',
      );
      release.open();
      expect((await commit).intent.status).toBe('committed');
    }));
});

describe.each(['read committed', 'serializable'] as const)(
  'invalidation versus commit ordering (%s)',
  (isolation) => {
    it('cleared: commit first, then the invalidating registration waits and the applied action stays historical', () =>
      withEnv(
        async (env) => {
          const level = await env.app.query('SHOW transaction_isolation');
          expect(level.rows[0].transaction_isolation).toBe(isolation);
          const sc = await proposeSetConfig(env);
          const fence = await admitted(env, sc.intent.id);
          const parked = latch();
          const release = latch();
          setHook('after_lock_before_commit', async ({ actionId, attempt }) => {
            if (actionId !== sc.intent.id || attempt !== 1) return;
            parked.open();
            await release.promise;
          });
          const commit = env.actions.commitDetailed(sc.intent.id, fence);
          await withTimeout(parked.promise, 5_000, 'commit parked');
          let registered = false;
          const registration = observeObserved(
            env,
            sc.world,
            'checkout.health',
            {
              status: 'degraded',
            },
          ).then((r) => {
            registered = true;
            return r;
          });
          await waitForLockWaiters(env, 1);
          expect(registered).toBe(false);
          release.open();
          expect((await commit).intent.status).toBe('committed');
          const reg = await registration;
          expect(reg.supersededReceiptId).toBe(sc.health.id);
          // committed history is not rewritten by the later invalidation
          expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
          expect(await liveConfig(env, 'db.pool_max')).toMatchObject({
            value: 20,
          });
        },
        { isolation },
      ));

    it('cleared: invalidation first, then the commit is blocked and mutates nothing', () =>
      withEnv(
        async (env) => {
          const sc = await proposeSetConfig(env);
          const fence = await admitted(env, sc.intent.id);
          setHook('after_preliminary_read', async ({ actionId }) => {
            if (actionId === sc.intent.id)
              await observeObserved(env, sc.world, 'checkout.health', {
                status: 'degraded',
              });
          });
          const result = await env.actions.commitDetailed(sc.intent.id, fence);
          expect(result.intent.status).toBe('blocked');
          expect(result.receipt).toBeNull();
          expect(await liveConfig(env, 'db.pool_max')).toMatchObject({
            value: 10,
          });
        },
        { isolation },
      ));
  },
);
