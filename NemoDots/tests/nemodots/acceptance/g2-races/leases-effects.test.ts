// TEST_PROMPT gate 2 cases 9-12 and 15: fencing, duplicate delivery, crash
// recovery, lost-reply external effects, separate lease lifecycles.
import { describe, expect, it } from 'vitest';
import { SETUP_CONFIG } from '../oracle/admission.js';
import {
  POOL,
  authSummary,
  barrier,
  errText,
  withWorld,
  type Rec,
  type World,
} from './harness.js';

const SETUP_POOL = SETUP_CONFIG['db.pool_max'];
const fence = (i: { dispatch: { fence: number } | null }) => i.dispatch!.fence;
class Crash extends Error {
  constructor(at: string) {
    super(`CRASH_SIMULATED at ${at}`);
  }
}
const crashAt = (w: World, point: Parameters<World['onHook']>[0]) =>
  w.onHook(point, () => {
    throw new Crash(point);
  });

describe('G2 leases, duplicates, recovery: cases 9-12, 15', () => {
  it('G2-09 lease fencing: stale-token publish, delegate, renew and propose fail; stale dispatch fence cannot commit', async () => {
    await withWorld(async (w) => {
      const stale = await w.seedAttempt('database_specialist', w.mission);
      await w.expireAuthorLease(stale);
      const ops = await w.staleOps(stale);
      for (const name of ['publish', 'delegate', 'renew']) {
        const err = await ops[name]().then(
          () => null,
          (e) => errText(e),
        );
        expect(err, `${name} with a stale token must fail`).toMatch(/Fence/i);
      }
      const err = await w
        .propose({ ...w.poolSpec('tc-stale'), attempt: stale })
        .then(
          () => null,
          (e) => errText(e),
        );
      expect(err).toMatch(/Fence|author_fence_invalid/i);
      expect(
        (
          await w.admin.query(
            'SELECT count(*)::int n FROM coordinator.action_intents WHERE tool_call_id=$1',
            ['tc-stale'],
          )
        ).rows[0].n,
      ).toBe(0);

      // wrong / stale dispatch fence at commit writes nothing
      const v1 = (await w.cfg(POOL)).version;
      const i = await w.proposeAdmit(w.poolSpec('tc-1'));
      const out = await w.actions.commit(i.id, fence(i) - 1).then(
        () => 'returned',
        (e) => errText(e),
      );
      expect(out).toMatch(/DispatchFence|dispatch_fence_invalid/i);
      expect((await w.intent(i.id)).status).toBe('admitted');
      expect(await w.cfg(POOL)).toMatchObject({
        version: v1,
        value: SETUP_POOL,
      });
      expect(await w.actionRows()).toBe(0);
      expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
        'admitted',
      ]);
    });
  });

  describe('G2-10 duplicate delivery', () => {
    it('G2-10a two simultaneous identical commits at the lock boundary produce one effect and one receipt for both callers', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        const gate = barrier(2);
        w.onHook('before_lock', () => gate.arrive()); // both callers parked, then released together
        const [a, b] = await Promise.all([
          w.actions.commit(i.id, fence(i)),
          w.actions.commit(i.id, fence(i)),
        ]);
        expect(gate.arrived).toBe(2);
        expect([a.status, b.status]).toEqual(['committed', 'committed']);
        const receipts = await w.resultReceipts(i.id);
        expect(receipts.length).toBe(1);
        const commitAuths = (await authSummary(w, i.id)).filter(
          (x) => x.stage === 'commit',
        );
        expect(commitAuths).toEqual([
          { stage: 'commit', decision: 'committed', blockReason: null },
        ]);
        expect(await w.cfg(POOL)).toMatchObject({
          version: v1 + 1,
          value: 12,
          causedBy: i.id,
        });
        expect(await w.actionRows()).toBe(1);
        // a later delivery returns the original receipt and writes nothing
        await w.clearHooks();
        const c = await w.actions.commit(i.id, fence(i));
        expect(c.status).toBe('committed');
        expect((await w.resultReceipts(i.id)).map((r) => r.id)).toEqual(
          receipts.map((r) => r.id),
        );
        expect(
          (await authSummary(w, i.id)).filter((x) => x.stage === 'commit')
            .length,
        ).toBe(1);
        expect((await w.cfg(POOL)).version).toBe(v1 + 1);
      });
    });

    it('G2-10b two simultaneous identical proposals (same tool call) yield one intent', async () => {
      await withWorld(async (w) => {
        const [a, b] = await Promise.all([
          w.propose(w.poolSpec('tc-dup')),
          w.propose(w.poolSpec('tc-dup')),
        ]);
        expect(a.id).toBe(b.id);
        expect(
          (
            await w.admin.query(
              'SELECT count(*)::int n FROM coordinator.action_intents WHERE tool_call_id=$1',
              ['tc-dup'],
            )
          ).rows[0].n,
        ).toBe(1);
      });
    });
  });

  describe('G2-11 crash recovery distinguishes uncommitted, committed and unknown', () => {
    it('G2-11a crash after leased/admitted: lease expiry lets a new dispatcher commit once; the old dispatcher cannot', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const i = await w.proposeAdmit(w.poolSpec('tc-1')); // dispatcher-1 "crashes" here
        const oldFence = fence(i);
        await w.expireDispatcherLease(i.id);
        const r = await w.actions.reclaim(i.id, 'dispatcher-2');
        expect(fence(r)).toBeGreaterThan(oldFence);
        const late = await w.actions.commit(i.id, oldFence).then(
          () => 'returned',
          (e) => errText(e),
        );
        expect(late).toMatch(/DispatchFence|dispatch_fence_invalid/i);
        expect(await w.actionRows()).toBe(0);
        await w.actions.commit(i.id, fence(r));
        expect((await w.intent(i.id)).status).toBe('committed');
        expect(await w.cfg(POOL)).toMatchObject({
          version: v1 + 1,
          value: 12,
          causedBy: i.id,
        });
        expect(await w.actionRows()).toBe(1);
      });
    });

    it('G2-11b crash after the lock, before the commit: rolled back entirely, recovery commits exactly once', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        crashAt(w, 'after_lock_before_commit');
        const out = await w.actions.commit(i.id, fence(i)).then(
          () => 'returned',
          (e) => errText(e),
        );
        expect(out).toContain('CRASH_SIMULATED');
        // uncommitted: no mutation, no commit authorization, no receipt, still admitted
        expect((await w.intent(i.id)).status).toBe('admitted');
        expect(await w.cfg(POOL)).toMatchObject({
          version: v1,
          value: SETUP_POOL,
        });
        expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
          'admitted',
        ]);
        expect((await w.resultReceipts(i.id)).length).toBe(0);
        await w.clearHooks();
        await w.actions.commit(i.id, fence(i));
        expect((await w.intent(i.id)).status).toBe('committed');
        expect((await w.cfg(POOL)).version).toBe(v1 + 1);
        expect(await w.actionRows()).toBe(1);
      });
    });

    it('G2-11c crash after commit, before dispatch (flush): committed, no Redis effect; dispatch afterwards applies exactly once', async () => {
      await withWorld(async (w) => {
        const keys = await w.plantCache(4);
        const i = await w.proposeAdmit(w.flushSpec('tc-f'));
        await w.actions.commit(i.id, fence(i));
        crashAt(w, 'after_commit_before_dispatch');
        const out = await w.actions.dispatch(i.id, fence(i)).then(
          () => 'returned',
          (e) => errText(e),
        );
        expect(out).toContain('CRASH_SIMULATED');
        expect((await w.intent(i.id)).status).toBe('committed');
        expect(await w.cacheKeysLeft(keys)).toBe(4);
        expect(await w.markerPresent(i.id)).toBe(false);
        await w.clearHooks();
        const d = await w.actions.dispatch(i.id, fence(i));
        expect(['dispatched', 'verified']).toContain(d.status);
        expect(await w.cacheKeysLeft(keys)).toBe(0);
        expect(await w.markerPresent(i.id)).toBe(true);
      });
    });

    it('G2-11d crash after the effect, before it is recorded: reconcile finds the marker; no second effect, no blind duplicate', async () => {
      await withWorld(async (w) => {
        const keys = await w.plantCache(4);
        const i = await w.proposeAdmit(w.flushSpec('tc-f'));
        await w.actions.commit(i.id, fence(i));
        crashAt(w, 'after_effect_before_record');
        const out = await w.actions.dispatch(i.id, fence(i)).then(
          () => 'returned',
          (e) => errText(e),
        );
        expect(out).toContain('CRASH_SIMULATED');
        expect(await w.cacheKeysLeft(keys)).toBe(0); // the effect really happened
        expect(await w.markerPresent(i.id)).toBe(true);
        expect(['committed', 'dispatched', 'outcome_unknown']).toContain(
          (await w.intent(i.id)).status,
        );
        await w.clearHooks();
        // new data written by someone else after the first effect must survive a replayed dispatch
        const fresh = await w.plantCache(2, 'acc-ns-a');
        await w.actions.dispatch(i.id, fence(i)).catch(() => {});
        expect(await w.cacheKeysLeft(fresh)).toBe(2);
        const r = await w.actions.reconcile(i.id);
        expect(r.status).toBe('verified');
        expect(await w.cacheKeysLeft(fresh)).toBe(2);
      });
    });
  });

  describe('G2-12 lost response after a real external effect', () => {
    it('G2-12a reply lost after the Redis effect: outcome_unknown until reconcile reads the marker back; never re-applied', async () => {
      await withWorld(async (w) => {
        const keys = await w.plantCache(3);
        const i = await w.proposeAdmit(w.flushSpec('tc-f'));
        await w.actions.commit(i.id, fence(i));
        w.redisMode.current = 'drop_reply';
        await w.actions.dispatch(i.id, fence(i)).catch(() => {});
        w.redisMode.current = 'ok';
        const unknown = await w.intent(i.id);
        expect(unknown.status).toBe('outcome_unknown');
        expect(await w.cacheKeysLeft(keys)).toBe(0); // effect happened despite the lost reply
        const fresh = await w.plantCache(2);
        const r = await w.actions.reconcile(i.id);
        expect(r.status).toBe('verified');
        expect(await w.cacheKeysLeft(fresh)).toBe(2); // reconcile did not flush again
        const rr = (await w.resultReceipts(i.id)).at(-1) as Rec;
        expect(rr.outcome).toBe('verified');
      });
    });

    it('G2-12b request never reached Redis: no effect happened, reconcile settles failed(effect_not_applied) and does not re-run it', async () => {
      await withWorld(async (w) => {
        const keys = await w.plantCache(3);
        const i = await w.proposeAdmit(w.flushSpec('tc-f'));
        await w.actions.commit(i.id, fence(i));
        w.redisMode.current = 'fail_before';
        await w.actions.dispatch(i.id, fence(i)).catch(() => {});
        w.redisMode.current = 'ok';
        expect(['outcome_unknown', 'failed', 'committed']).toContain(
          (await w.intent(i.id)).status,
        );
        expect(await w.cacheKeysLeft(keys)).toBe(3);
        const r = await w.actions.reconcile(i.id);
        expect(r.status).toBe('failed');
        expect((await w.intent(i.id)).failure_reason).toBe(
          'effect_not_applied',
        );
        expect(await w.cacheKeysLeft(keys)).toBe(3); // reconcile never re-runs the effect
        expect(await w.markerPresent(i.id)).toBe(false);
      });
    });
  });

  it('G2-15 separate lease lifecycles: a completed author’s proposal executes under a new dispatch lease; an expired author cannot publish; an expired dispatcher cannot commit', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const author = await w.seedAttempt('database_specialist', w.mission);
      const i = await w.propose({ ...w.poolSpec('tc-1'), attempt: author });
      await w.completeAuthor(author); // author finished: its authoring lease is over
      const admitted = await w.actions.admit(i.id, 'dispatcher-1');
      await w.actions.commit(i.id, fence(admitted));
      expect((await w.intent(i.id)).status).toBe('committed');
      expect(await w.cfg(POOL)).toMatchObject({
        version: v1 + 1,
        value: 12,
        causedBy: i.id,
      });

      // an author whose lease expired cannot publish a new proposal
      const expired = await w.seedAttempt('database_specialist', w.mission);
      await w.expireAuthorLease(expired);
      const out = await w
        .propose({
          ...w.poolSpec('tc-2', 8, ['member:db.pool_max', 'health']),
          attempt: expired,
        })
        .then(
          () => 'returned',
          (e) => errText(e),
        );
      expect(out).toMatch(/Fence|author_fence_invalid/i);

      // an expired dispatcher cannot commit
      const j = await w.proposeAdmit({
        action: 'set_config',
        payload: { key: 'db.statement_timeout_ms', value: 120 },
        cites: ['member:db.statement_timeout_ms', 'health'],
        toolCallId: 'tc-3',
      });
      await w.expireDispatcherLease(j.id);
      const late = await w.actions.commit(j.id, fence(j)).then(
        () => 'returned',
        (e) => errText(e),
      );
      expect(late).toMatch(/DispatchFence|dispatch_fence_invalid|expired/i);
      expect((await w.intent(j.id)).status).toBe('admitted');
      expect((await w.cfg('db.statement_timeout_ms')).value).toBe(
        SETUP_CONFIG['db.statement_timeout_ms'],
      );
      expect(await w.actionRows()).toBe(1);
    });
  });
});
