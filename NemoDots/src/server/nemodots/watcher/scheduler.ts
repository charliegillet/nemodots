import pg from 'pg';

// Single-instance scheduler (ARCHITECTURE 3: one watcher per scope).
//
// One dedicated PostgreSQL session holds both the advisory lock
// (pg_try_advisory_lock) and the LISTEN registration, so they share a lifetime:
// when the session dies the lock is released by the server and the
// notifications stop, and the scheduler immediately stops working and starts
// trying to re-acquire. A second instance on the same lock name stays in
// standby (it does not LISTEN or poll) and takes over within one interval of
// the leader's session ending.
//
// The loop is the only caller of `work`, so work never overlaps with itself.

export interface WorkBatch {
  /** The poll interval elapsed (or leadership was just acquired). */
  full: boolean;
  /** Raw payloads of the notifications received since the last batch. */
  notifications: string[];
}

export interface SchedulerOptions {
  connectionString: string;
  applicationName?: string;
  lockName: string;
  channel: string;
  intervalMs: number;
  /** Standby retry interval (default: intervalMs). */
  retryMs?: number;
  work(batch: WorkBatch): Promise<void>;
  onLeadership?(leader: boolean): void;
  onError?(where: string, error: unknown): void;
  now?: () => number;
}

export interface Scheduler {
  /** Resolves after the first acquisition attempt (leader or standby). */
  start(): Promise<void>;
  /** Waits for the batch in flight, releases the lock and closes the session. */
  stop(): Promise<void>;
  isLeader(): boolean;
  /** Ask the loop to run a full poll now. */
  requestFull(): void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? options.intervalMs;
  const report = (where: string, error: unknown) =>
    options.onError?.(where, error);

  let session: pg.Client | null = null;
  let stopped = true;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let notifications: string[] = [];
  let fullDue = true;
  let lastFullAt = 0;
  let announcedLeader = false;
  let firstAttempt!: () => void;
  const firstAttemptDone = new Promise<void>((resolve) => {
    firstAttempt = resolve;
  });

  const announce = (leader: boolean) => {
    if (announcedLeader === leader) return;
    announcedLeader = leader;
    options.onLeadership?.(leader);
  };

  const poke = () => wake?.();

  function lost(client: pg.Client) {
    if (session !== client) return;
    session = null;
    announce(false);
    poke();
  }

  async function acquire(): Promise<boolean> {
    const client = new pg.Client({
      connectionString: options.connectionString,
      application_name: options.applicationName ?? 'nemodots-watcher',
    });
    client.on('error', (error) => {
      report('session', error);
      lost(client);
    });
    client.on('end', () => lost(client));
    client.on('notification', (message) => {
      if (message.channel !== options.channel) return;
      notifications.push(message.payload ?? '');
      poke();
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
        [options.lockName],
      );
      if (!rows[0]?.ok) {
        await client.end();
        return false;
      }
      await client.query(`LISTEN ${options.channel}`);
    } catch (error) {
      report('acquire', error);
      await client.end().catch(() => {});
      return false;
    }
    session = client;
    fullDue = true;
    return true;
  }

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
      wake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      timer = null;
      wake = null;
    });

  async function run() {
    while (!stopped) {
      if (!session) {
        const leader = await acquire();
        firstAttempt();
        if (stopped) break;
        announce(leader);
        if (!leader) {
          await pause(retryMs);
          continue;
        }
      }
      const due = fullDue || now() - lastFullAt >= options.intervalMs;
      if (due || notifications.length > 0) {
        const batch: WorkBatch = { full: due, notifications };
        notifications = [];
        fullDue = false;
        if (due) lastFullAt = now();
        try {
          await options.work(batch);
        } catch (error) {
          report('work', error);
        }
        if (due) lastFullAt = now();
      }
      if (stopped) break;
      if (notifications.length > 0 || fullDue) continue;
      await pause(lastFullAt + options.intervalMs - now());
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
      await firstAttemptDone;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      poke();
      await loop;
      loop = null;
      const client = session;
      session = null;
      if (client) {
        await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            options.lockName,
          ])
          .catch(() => {});
        await client.end().catch(() => {});
      }
      announce(false);
    },
    isLeader: () => session !== null,
    requestFull() {
      fullDue = true;
      poke();
    },
  };
}
