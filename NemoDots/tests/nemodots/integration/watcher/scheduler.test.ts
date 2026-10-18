// Single-instance guard (pg_try_advisory_lock) and graceful stop.
import { describe, expect, it } from 'vitest';
import {
  headOf,
  injectorWrite,
  receiptsOf,
  until,
  withWatcherEnv,
  type WatcherEnv,
} from './harness.js';

const member = (key: string) => `checkout.config/${key}`;

/** pids of the sessions holding a watcher advisory lock in this database. */
async function lockHolders(env: WatcherEnv) {
  const { rows } = await env.app.query<{ pid: number }>(
    `SELECT l.pid FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted
        AND a.application_name = 'nemodots-watcher'
        AND a.datname = current_database()`,
  );
  return rows.map((row) => row.pid);
}

describe('two watcher instances', () => {
  it('exactly one is the leader and exactly one registers a change', async () => {
    await withWatcherEnv(async (env) => {
      const a = env.watcher({ config: { intervalMs: 200 } });
      const b = env.watcher({ config: { intervalMs: 200 } });
      await Promise.all([a.start(), b.start()]);
      expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
      expect(await lockHolders(env)).toHaveLength(1);
      const leader = a.isLeader() ? a : b;
      const standby = a.isLeader() ? b : a;
      await leader.runCycle(); // behind the initial poll
      expect(await receiptsOf(env, member('db.pool_max'))).toHaveLength(1);

      await injectorWrite(env, 'db.pool_max', 14);
      await until(
        async () => (await receiptsOf(env, member('db.pool_max'))).length === 2,
        'the registered revision',
      );
      await new Promise((resolve) => setTimeout(resolve, 600)); // > 2 poll intervals
      const receipts = await receiptsOf(env, member('db.pool_max'));
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      expect(leader.stats().registered).toBeGreaterThan(0);
      // the standby neither polled nor registered anything
      expect(standby.stats()).toEqual({
        cycles: 0,
        registered: 0,
        confirmed: 0,
        staleRejected: 0,
        errors: 0,
      });

      await Promise.all([a.stop(), b.stop()]);
      expect(await lockHolders(env)).toEqual([]);
    });
  });

  it('a graceful stop hands over within one interval and a restart does not re-register', async () => {
    await withWatcherEnv(async (env) => {
      const a = env.watcher({ config: { intervalMs: 150 } });
      const b = env.watcher({ config: { intervalMs: 150 } });
      await a.start();
      await b.start();
      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(false);
      await a.runCycle();
      const before = await receiptsOf(env, member('ui.banner_text'));

      await a.stop();
      expect(a.isLeader()).toBe(false);
      await until(async () => b.isLeader(), 'the standby to take over', 3_000);

      await injectorWrite(env, 'ui.banner_text', 'handover');
      await until(
        async () =>
          (await headOf(env, member('ui.banner_text'))).revision === 2,
        'the new leader to register',
      );
      expect(b.stats().registered).toBeGreaterThan(0);

      // restart the stopped one: it queues behind the lock and registers nothing
      const again = env.watcher({ config: { intervalMs: 150 } });
      await again.start();
      expect(again.isLeader()).toBe(false);
      expect(before).toHaveLength(1);
      expect(await receiptsOf(env, member('ui.banner_text'))).toHaveLength(2);
      await b.stop();
      await until(
        async () => again.isLeader(),
        'the restarted instance to lead',
        3_000,
      );
      // it takes over from the existing state without minting anything
      await again.runCycle();
      expect(await receiptsOf(env, member('ui.banner_text'))).toHaveLength(2);
      expect(await receiptsOf(env, member('db.pool_max'))).toHaveLength(1);
    });
  });

  it('a lost session releases the lock and the other instance takes over', async () => {
    await withWatcherEnv(async (env) => {
      const a = env.watcher({ config: { intervalMs: 150 } });
      const b = env.watcher({ config: { intervalMs: 150 } });
      await a.start();
      await b.start();
      expect(a.isLeader()).toBe(true);
      const [pid] = await lockHolders(env);
      await env.app.query('SELECT pg_terminate_backend($1)', [pid]);

      await until(async () => b.isLeader(), 'the standby to take over', 5_000);
      await until(async () => !a.isLeader(), 'the old leader to notice', 5_000);
      expect(await lockHolders(env)).toHaveLength(1);

      await injectorWrite(env, 'db.pool_max', 15);
      await until(
        async () => (await headOf(env, member('db.pool_max'))).revision === 2,
        'the new leader to register',
      );
    });
  });
});
