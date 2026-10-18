// Single-instance scheduling: one watcher per database holds a session-level
// pg_try_advisory_lock on a dedicated connection, which also carries the LISTEN
// for nemodots_source_changed. A follower retries on every tick, so a dead
// leader's lock (released with its connection) is taken over.
import type pg from 'pg';

export const WATCHER_LOCK_NAME = 'nemodots_source_watcher';
export const SOURCE_CHANGED_CHANNEL = 'nemodots_source_changed';

export interface Scheduler {
  /** Tries to become (or stay) the leader. */
  ensureLeader(): Promise<boolean>;
  isLeader(): boolean;
  release(): Promise<void>;
}

export function createScheduler(options: {
  pool: pg.Pool;
  lockName?: string;
  onNotification: (payload: string) => void;
  onLeaderChange?: (leader: boolean) => void;
}): Scheduler {
  const lockName = options.lockName ?? WATCHER_LOCK_NAME;
  let client: pg.PoolClient | null = null;
  let acquiring: Promise<boolean> | null = null;

  const drop = (destroy: boolean) => {
    const held = client;
    client = null;
    if (held) {
      held.removeAllListeners('notification');
      held.removeAllListeners('error');
      held.release(destroy);
      options.onLeaderChange?.(false);
    }
  };

  async function acquire(): Promise<boolean> {
    if (client) return true;
    const candidate = await options.pool.connect();
    candidate.on('error', () => {
      if (client === candidate) drop(true);
    });
    try {
      const { rows } = await candidate.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockName],
      );
      if (!rows[0]?.locked) {
        candidate.removeAllListeners('error');
        candidate.release();
        return false;
      }
      candidate.on('notification', (message) => {
        if (message.channel === SOURCE_CHANGED_CHANNEL)
          options.onNotification(message.payload ?? '');
      });
      await candidate.query(`LISTEN ${SOURCE_CHANGED_CHANNEL}`);
      client = candidate;
      options.onLeaderChange?.(true);
      return true;
    } catch (error) {
      candidate.removeAllListeners('error');
      candidate.release(true);
      throw error;
    }
  }

  return {
    async ensureLeader() {
      if (client) {
        // A dead connection silently loses the lock; verify it is alive.
        try {
          await client.query('SELECT 1');
          return true;
        } catch {
          drop(true);
        }
      }
      acquiring ??= acquire().finally(() => {
        acquiring = null;
      });
      return acquiring;
    },
    isLeader: () => client !== null,
    async release() {
      const held = client;
      if (!held) return;
      try {
        await held.query(`UNLISTEN ${SOURCE_CHANGED_CHANNEL}`);
        await held.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
        drop(false);
      } catch {
        drop(true);
      }
    },
  };
}
