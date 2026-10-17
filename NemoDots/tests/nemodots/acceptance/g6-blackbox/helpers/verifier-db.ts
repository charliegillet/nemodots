// Harness-only read access to a trial database plus independent Redis
// observation. The reader is a role the harness provisions for this one trial
// (see Sut.provisionReader): it is NOT present in the app or worker
// environment, so the system under test never holds the credential the
// verifier measures with. Expected values are never derived from production
// helpers.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createClient } from 'redis';
import {
  businessSnapshot,
  type BusinessSnapshot,
} from '../../driver/business-hash.js';
import { G6, redisTrialUrl } from './config.js';
import type {
  CrashStateAtKill,
  LineageCall,
  NormalizedValues,
  RedisEffects,
  TaggedOrder,
} from './record.js';

export interface ConfigEntry {
  key: string;
  value: unknown;
  version: number;
  causedByActionId: string | null;
  causedByActor: string | null;
}
export interface ConfigVersionRow {
  key: string;
  version: number;
  value: unknown;
  causedByActionId: string | null;
  causedByActor: string | null;
  /** now() of the writing transaction: its START time, not its commit time */
  at: string;
  /**
   * pg_xact_commit_timestamp(xmin) when track_commit_timestamp is on. This is
   * the real commit order; `at` is not (a transaction that starts early and
   * commits late has an early `at`).
   */
  commitAt?: string | null;
}

export interface ReaderTarget {
  readerUrl: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export class VerifierDb {
  private constructor(
    private readonly client: pg.Client,
    readonly commitTimestamps: boolean,
  ) {}

  static async connect(target: ReaderTarget): Promise<VerifierDb> {
    const client = new pg.Client({
      connectionString: target.readerUrl,
      application_name: 'acc6-reader',
    });
    await client.connect();
    const tracked = await client
      .query('SHOW track_commit_timestamp')
      .then((shown) => shown.rows[0]?.track_commit_timestamp === 'on')
      .catch(() => false);
    return new VerifierDb(client, tracked);
  }

  close() {
    return this.client.end();
  }

  /** The role this connection runs as (for the separation self-check). */
  async currentUser(): Promise<string> {
    const result = await this.client.query('SELECT current_user AS u');
    return result.rows[0].u as string;
  }

  snapshot(): Promise<BusinessSnapshot> {
    return businessSnapshot(this.client);
  }

  async configEntries(): Promise<Record<string, ConfigEntry>> {
    const result = await this.client.query(
      `SELECT key, value, version::int AS version, caused_by_action_id::text AS "causedByActionId",
              caused_by_actor AS "causedByActor"
         FROM checkout.config_entries ORDER BY key`,
    );
    return Object.fromEntries(
      (result.rows as ConfigEntry[]).map((row) => [row.key, row]),
    );
  }

  async configVersions(): Promise<ConfigVersionRow[]> {
    const commit = this.commitTimestamps
      ? `to_char(pg_xact_commit_timestamp(xmin) AT TIME ZONE 'UTC', ${ISO})`
      : 'NULL';
    const result = await this.client.query(
      `SELECT key, version::int AS version, value, caused_by_action_id::text AS "causedByActionId",
              caused_by_actor AS "causedByActor",
              to_char("at" AT TIME ZONE 'UTC', ${ISO}) AS "at",
              ${commit} AS "commitAt"
         FROM checkout.config_versions ORDER BY "at", key, version`,
    );
    return result.rows as ConfigVersionRow[];
  }

  async inventoryQuantity(sku: string): Promise<number | null> {
    const result = await this.client.query(
      'SELECT quantity::int AS quantity FROM checkout.inventory WHERE sku = $1',
      [sku],
    );
    return result.rowCount ? (result.rows[0].quantity as number) : null;
  }

  async ordersByProbeRun(runId: string) {
    const orders = await this.client.query(
      'SELECT * FROM checkout.orders WHERE probe_run_id = $1',
      [runId],
    );
    const items = await this.client.query(
      `SELECT i.order_id::text AS order_id, i.sku, i.quantity::int AS quantity
         FROM checkout.order_items i JOIN checkout.orders o ON o.id = i.order_id
        WHERE o.probe_run_id = $1`,
      [runId],
    );
    return { orders: orders.rows, items: items.rows };
  }

  /** Every probe-tagged order in the database, whoever created it. */
  async taggedOrders(): Promise<TaggedOrder[]> {
    const orders = await this.client.query(
      `SELECT id::text AS id, probe_run_id AS "probeRunId"
         FROM checkout.orders WHERE probe_run_id IS NOT NULL ORDER BY created_at, id`,
    );
    const items = await this.client.query(
      `SELECT i.order_id::text AS order_id, i.sku, i.quantity::int AS quantity
         FROM checkout.order_items i JOIN checkout.orders o ON o.id = i.order_id
        WHERE o.probe_run_id IS NOT NULL ORDER BY i.order_id, i.sku`,
    );
    return (orders.rows as { id: string; probeRunId: string }[]).map((o) => ({
      id: o.id,
      probeRunId: o.probeRunId,
      items: (
        items.rows as { order_id: string; sku: string; quantity: number }[]
      )
        .filter((i) => i.order_id === o.id)
        .map((i) => ({ sku: i.sku, quantity: i.quantity })),
    }));
  }

  async rowCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of [
      'products',
      'inventory',
      'orders',
      'order_items',
    ] as const) {
      const result = await this.client.query(
        `SELECT count(*)::int AS n FROM checkout.${table}`,
      );
      out[table] = result.rows[0].n as number;
    }
    return out;
  }

  /**
   * checkout.orders.recent and checkout.inventory/<sku> as evidence values with
   * every probe-tagged row excluded (inventory gets the tagged quantities
   * added back), computed here from the tables, not by a production reader.
   */
  async normalizedValues(): Promise<NormalizedValues> {
    const recent = await this.client.query(
      `SELECT id::text AS id FROM checkout.orders
        WHERE probe_run_id IS NULL ORDER BY created_at DESC, id LIMIT 20`,
    );
    const inventory = await this.client.query(
      `SELECT i.sku AS sku,
              (i.quantity + COALESCE((
                 SELECT SUM(oi.quantity) FROM checkout.order_items oi
                   JOIN checkout.orders o ON o.id = oi.order_id
                  WHERE o.probe_run_id IS NOT NULL AND oi.sku = i.sku), 0))::int AS quantity
         FROM checkout.inventory i ORDER BY i.sku`,
    );
    return {
      ordersRecentDigest: sha(
        (recent.rows as { id: string }[]).map((r) => r.id).join(','),
      ),
      inventory: Object.fromEntries(
        (inventory.rows as { sku: string; quantity: number }[]).map((r) => [
          r.sku,
          r.quantity,
        ]),
      ),
    };
  }

  /** Context records of every model call of the mission (read sets, as recorded). */
  async lineage(missionId: string): Promise<LineageCall[]> {
    const result = await this.client.query(
      `SELECT m.id::text AS id, m.task_id::text AS "taskId", m.attempt_id::text AS "attemptId",
              (extract(epoch FROM m.created_at) * 1000)::float8 AS "createdAtMs",
              c.dependency_vector AS "contextVector",
              m.output_dependency_vector AS "outputVector"
         FROM ledger.model_call_records m
         JOIN ledger.context_snapshots c ON c.id = m.context_snapshot_id
        WHERE m.mission_id = $1 ORDER BY m.created_at, m.id`,
      [missionId],
    );
    return result.rows as LineageCall[];
  }

  /** Lease holders of running attempts (the mission's worker identity). */
  async runningAttempts(missionId: string) {
    const result = await this.client.query(
      `SELECT id::text AS id, task_id::text AS "taskId", lease_owner AS "leaseOwner",
              fencing_token::int AS "fencingToken"
         FROM coordinator.task_attempts WHERE mission_id = $1 AND status = 'running'`,
      [missionId],
    );
    return result.rows as CrashStateAtKill['runningAttempts'];
  }

  async outboxState(): Promise<{ pending: number; claimed: number }> {
    const result = await this.client.query(
      `SELECT count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL)::int AS pending,
              count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL
                               AND claimed_by IS NOT NULL AND claimed_until > now())::int AS claimed
         FROM coordinator.outbox`,
    );
    return result.rows[0] as { pending: number; claimed: number };
  }

  /** Attempt rows of one task, for fencing checks (adapter races). */
  async attemptsOfMission(missionId: string) {
    const result = await this.client.query(
      `SELECT id::text AS id, task_id::text AS "taskId", n::int AS n, status,
              fencing_token::int AS "fencingToken", lease_owner AS "leaseOwner"
         FROM coordinator.task_attempts WHERE mission_id = $1 ORDER BY task_id, n`,
      [missionId],
    );
    return result.rows as {
      id: string;
      taskId: string;
      n: number;
      status: string;
      fencingToken: number;
      leaseOwner: string;
    }[];
  }

  async outputsOfMission(missionId: string) {
    const result = await this.client.query(
      `SELECT id::text AS id, task_id::text AS "taskId", attempt_id::text AS "attemptId", usable
         FROM coordinator.task_outputs WHERE mission_id = $1 ORDER BY published_at`,
      [missionId],
    );
    return result.rows as {
      id: string;
      taskId: string;
      attemptId: string;
      usable: boolean;
    }[];
  }
}

/** Counts cache keys under the active namespace whose schema suffix differs from `schema`. */
export async function staleCacheBlobs(
  prefix: string,
  namespace: string,
  schema: number,
): Promise<{ total: number; stale: number }> {
  const client = createClient({ url: redisTrialUrl() });
  await client.connect();
  try {
    let total = 0;
    let stale = 0;
    const pattern = `${prefix}:cache:${namespace}:v*`;
    for await (const keys of client.scanIterator({
      MATCH: pattern,
      COUNT: 200,
    })) {
      for (const key of keys) {
        total += 1;
        const rest = key.slice(`${prefix}:cache:${namespace}:`.length);
        const match = /^v(\d+)/.exec(rest);
        if (!match || Number(match[1]) !== schema) stale += 1;
      }
    }
    return { total, stale };
  } finally {
    await client.quit();
  }
}

/** UNLINKs only keys under this trial's prefix (never FLUSH*). */
export async function unlinkTrialKeys(prefix: string): Promise<number> {
  if (!/^nemodots:acc6:[a-z0-9-]{3,}$/.test(prefix))
    throw new Error('Refusing to unlink by an unusual prefix.');
  const client = createClient({ url: redisTrialUrl() });
  await client.connect();
  try {
    let removed = 0;
    for await (const keys of client.scanIterator({
      MATCH: `${prefix}:*`,
      COUNT: 200,
    })) {
      if (keys.length) removed += await client.unlink(keys);
    }
    return removed;
  } finally {
    await client.quit();
  }
}

/**
 * Writes cache blobs of the other schema under `namespace` so that switching
 * cache.namespace to it reproduces class F1 (a namespace whose blobs this
 * build cannot decode). Verifier-owned fixture data; key and blob layout follow
 * ARCHITECTURE 9.1 (`<prefix>:cache:<namespace>:v<schema>:<name>`).
 */
export async function seedStaleCacheBlobs(
  prefix: string,
  namespace: string,
  currentSchema: number,
): Promise<string[]> {
  if (!/^[a-z0-9-]{1,32}$/.test(namespace))
    throw new Error('stale blob namespace must match ^[a-z0-9-]{1,32}$');
  const staleSchema = currentSchema > 1 ? currentSchema - 1 : currentSchema + 1;
  const client = createClient({ url: redisTrialUrl() });
  await client.connect();
  try {
    const written: string[] = [];
    for (const name of ['products', 'inventory:PROBE-SKU']) {
      const key = `${prefix}:cache:${namespace}:v${staleSchema}:${name}`;
      await client.set(
        key,
        JSON.stringify({
          schema: staleSchema,
          name,
          storedAt: Date.now(),
          data: [],
        }),
        { EX: 3600 },
      );
      written.push(key);
    }
    return written;
  } finally {
    await client.quit();
  }
}

const KEYSPACE_FLAGS = ['K', 'g', '$', 'x'] as const;
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Independent count of real Redis effects: a subscriber on the keyspace
 * notifications of db 7 under the trial prefix. The effect marker of a flush
 * is `SET <prefix>:effect:<actionId> NX`, so one `set` event per action is the
 * only legal number; a second event means the marker was bypassed. Keyspace
 * notifications are switched on (and restored afterwards) on the NemoDots
 * instance's own Redis, never the user's 6379.
 */
export class RedisEffectWatcher {
  private readonly markerSets: Record<string, number> = {};
  private fenceSets = 0;
  private cacheDeletes = 0;
  private totalEvents = 0;
  private previousFlags: string | null = null;
  private subscriber: ReturnType<typeof createClient> | null = null;
  private admin: ReturnType<typeof createClient> | null = null;
  private reason: string | null = null;

  private constructor(private readonly prefix: string) {}

  static async start(prefix: string): Promise<RedisEffectWatcher> {
    const watcher = new RedisEffectWatcher(prefix);
    await watcher.open();
    return watcher;
  }

  private async open() {
    try {
      this.admin = createClient({ url: redisTrialUrl() });
      await this.admin.connect();
      const current = (await this.admin.configGet(
        'notify-keyspace-events',
      )) as Record<string, string>;
      this.previousFlags = current['notify-keyspace-events'] ?? '';
      const wanted = new Set(
        this.previousFlags.replace(/A/g, 'g$lshzxetd').split(''),
      );
      for (const flag of KEYSPACE_FLAGS) wanted.add(flag);
      await this.admin.configSet(
        'notify-keyspace-events',
        [...wanted].join(''),
      );
      this.subscriber = this.admin.duplicate();
      await this.subscriber.connect();
      const effect = new RegExp(
        `^${escapeRegExp(this.prefix)}:effect:([0-9a-f-]{36})$`,
      );
      await this.subscriber.pSubscribe(
        `__keyspace@${G6.redisDb}__:${this.prefix}:*`,
        (event, channel) => {
          this.totalEvents += 1;
          const key = channel.slice(`__keyspace@${G6.redisDb}__:`.length);
          const marker = effect.exec(key);
          if (marker && event === 'set')
            this.markerSets[marker[1]] = (this.markerSets[marker[1]] ?? 0) + 1;
          else if (key.startsWith(`${this.prefix}:fence:`) && event === 'set')
            this.fenceSets += 1;
          else if (key.startsWith(`${this.prefix}:cache:`) && event === 'del')
            this.cacheDeletes += 1;
        },
      );
    } catch (error) {
      this.reason = `keyspace notifications unavailable: ${(error as Error).message}`;
    }
  }

  async stop(): Promise<RedisEffects> {
    try {
      await this.subscriber?.pUnsubscribe();
      await this.subscriber?.quit();
    } catch {
      /* closing */
    }
    try {
      if (this.admin && this.previousFlags !== null)
        await this.admin.configSet(
          'notify-keyspace-events',
          this.previousFlags,
        );
      await this.admin?.quit();
    } catch {
      /* closing */
    }
    return {
      available: this.reason === null,
      reason: this.reason,
      markerSets: { ...this.markerSets },
      fenceSets: this.fenceSets,
      cacheDeletes: this.cacheDeletes,
      totalEvents: this.totalEvents,
    };
  }

  /** Live view, for scenarios that assert while the watcher runs. */
  peek(): RedisEffects {
    return {
      available: this.reason === null,
      reason: this.reason,
      markerSets: { ...this.markerSets },
      fenceSets: this.fenceSets,
      cacheDeletes: this.cacheDeletes,
      totalEvents: this.totalEvents,
    };
  }
}
