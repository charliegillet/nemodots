// Verifier-role access (nemodots_verifier, SELECT only) to a trial database,
// plus the independent Redis read-back. Expected values are never derived
// from production helpers.
import pg from 'pg';
import { createClient } from 'redis';
import {
  businessSnapshot,
  type BusinessSnapshot,
} from '../../driver/business-hash.js';
import { redisTrialUrl, roleUrl, withDatabase } from './config.js';

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
  at: string;
}

export class VerifierDb {
  private readonly client: pg.Client;
  private constructor(client: pg.Client) {
    this.client = client;
  }

  static async connect(database: string): Promise<VerifierDb> {
    const client = new pg.Client({
      connectionString: withDatabase(roleUrl('verifier'), database),
      application_name: 'acc6-verifier',
    });
    await client.connect();
    return new VerifierDb(client);
  }

  close() {
    return this.client.end();
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
    const result = await this.client.query(
      `SELECT key, version::int AS version, value, caused_by_action_id::text AS "causedByActionId",
              caused_by_actor AS "causedByActor", "at"::text AS "at"
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
