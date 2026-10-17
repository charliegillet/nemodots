// Fixtures for the ledger integration suites. They run against a migrated
// nemodots_test_<hex> database on the NemoDots instance and write as the app
// role (nemodots_app) through the same pools the server uses.
//
// The checkout authority tables (config_entries / config_collection) and the
// coordinator rows the closure marks belong to other packages' migrations
// (0003/0004). The ledger takes their schema names as options, so these tests
// create private copies in fx_checkout / fx_coordinator that carry only the
// columns the ledger reads or writes. They never depend on another package's
// migration landing.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import type { SourceRef } from '../../../../src/server/nemodots/contracts/index.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import type { LedgerOptions } from '../../../../src/server/nemodots/ledger/options.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';

export const FX: Required<LedgerOptions> = {
  checkoutSchema: 'fx_checkout',
  coordinatorSchema: 'fx_coordinator',
};

const FIXTURE_SQL = `
CREATE SCHEMA fx_checkout AUTHORIZATION nemodots_admin;
GRANT USAGE ON SCHEMA fx_checkout TO nemodots_app, nemodots_verifier;
CREATE TABLE fx_checkout.config_entries (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  caused_by_action_id uuid,
  caused_by_actor text
);
CREATE TABLE fx_checkout.config_collection (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  version integer NOT NULL DEFAULT 1
);
INSERT INTO fx_checkout.config_collection DEFAULT VALUES;
GRANT SELECT, INSERT, UPDATE, DELETE ON fx_checkout.config_entries, fx_checkout.config_collection TO nemodots_app;

CREATE SCHEMA fx_coordinator AUTHORIZATION nemodots_admin;
GRANT USAGE ON SCHEMA fx_coordinator TO nemodots_app, nemodots_verifier;
CREATE TABLE fx_coordinator.tasks (
  id uuid PRIMARY KEY, mission_id uuid NOT NULL, status text NOT NULL,
  transition_version integer NOT NULL DEFAULT 0);
CREATE TABLE fx_coordinator.task_attempts (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, mission_id uuid NOT NULL,
  status text NOT NULL, abort_reason text);
CREATE TABLE fx_coordinator.task_outputs (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, usable boolean NOT NULL DEFAULT true,
  unusable_reason text);
CREATE TABLE fx_coordinator.action_intents (
  id uuid PRIMARY KEY, mission_id uuid NOT NULL, task_id uuid NOT NULL,
  status text NOT NULL, status_version integer NOT NULL DEFAULT 0,
  block_reason text, block_detail text);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fx_coordinator TO nemodots_app;
`;

export interface LedgerDb {
  db: TestDatabase;
  /** nemodots_app pool: every write in these suites goes through it. */
  app: pg.Pool;
  /** nemodots_admin pool: fixture setup and out-of-band inspection only. */
  admin: pg.Pool;
  verifier: pg.Pool;
}

/** One migrated database for a whole describe block; released in afterAll. */
export function useLedgerDb(): () => LedgerDb {
  let current: LedgerDb | undefined;
  let finish!: () => void;
  let running: Promise<void> | undefined;
  beforeAll(async () => {
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ready = new Promise<LedgerDb>((resolve, reject) => {
      running = withTestDatabase(async (db) => {
        const app = createRolePool('app', db.urls.app);
        const admin = createRolePool('admin', db.urls.admin);
        const verifier = createRolePool('verifier', db.urls.verifier);
        try {
          await admin.query(FIXTURE_SQL);
          resolve({ db, app, admin, verifier });
          await done;
        } finally {
          await Promise.all([app.end(), admin.end(), verifier.end()]);
        }
      }).catch(reject);
    });
    current = await ready;
  }, 60_000);
  afterAll(async () => {
    finish?.();
    await running;
  }, 60_000);
  return () => {
    if (!current) throw new Error('ledger test database is not ready');
    return current;
  };
}

/** Runs `fn` in one transaction on a fresh app connection (COMMIT on success). */
export async function inTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface TestScope {
  ownerId: string;
  missionId: string;
  environment: 'dev' | 'test' | 'eval';
  resource: string;
}

/** A scope no other test shares (sources are unique per owner/environment/resource/key). */
export function newScope(
  environment: TestScope['environment'] = 'test',
): TestScope {
  return {
    ownerId: `owner-${randomUUID()}`,
    missionId: randomUUID(),
    environment,
    resource: 'checkout',
  };
}

export function sourceRef(scope: TestScope, key: string): SourceRef {
  const sourceType =
    key === 'checkout.config'
      ? 'controlled_collection'
      : key.startsWith('checkout.config/')
        ? 'controlled_config'
        : key === 'redis.stats' ||
            key === 'checkout.health' ||
            key === 'checkout.metrics'
          ? 'observed_endpoint'
          : 'observed_store';
  return {
    key,
    sourceType,
    authority:
      sourceType === 'controlled_config' ||
      sourceType === 'controlled_collection'
        ? 'controlled'
        : 'observed',
    scope: {
      ownerId: scope.ownerId,
      missionId: scope.missionId,
      spaceId: null,
      environment: scope.environment,
      resource: scope.resource,
    },
  } as unknown as SourceRef;
}

// --- the version authority fixture (mirrors advanceConfig's lock order) -----

export async function resetAuthority(admin: pg.Pool) {
  await admin.query(
    `TRUNCATE fx_checkout.config_entries;
     UPDATE fx_checkout.config_collection SET version = 1`,
  );
  await admin.query(
    `TRUNCATE fx_coordinator.tasks, fx_coordinator.task_attempts,
              fx_coordinator.task_outputs, fx_coordinator.action_intents`,
  );
}

/** Inserts a key (version 1) and bumps the collection, collection row locked first. */
export async function insertConfig(
  client: pg.PoolClient,
  key: string,
  value: unknown,
) {
  await client.query(
    'SELECT version FROM fx_checkout.config_collection FOR UPDATE',
  );
  await client.query(
    'INSERT INTO fx_checkout.config_entries (key, value, version) VALUES ($1, $2::jsonb, 1)',
    [key, JSON.stringify(value)],
  );
  await client.query(
    'UPDATE fx_checkout.config_collection SET version = version + 1',
  );
}

export async function deleteConfig(client: pg.PoolClient, key: string) {
  await client.query(
    'SELECT version FROM fx_checkout.config_collection FOR UPDATE',
  );
  await client.query('DELETE FROM fx_checkout.config_entries WHERE key = $1', [
    key,
  ]);
  await client.query(
    'UPDATE fx_checkout.config_collection SET version = version + 1',
  );
}

/** Value update: member version +1, collection untouched (rev2 C1/D1). */
export async function updateConfig(
  client: pg.PoolClient,
  key: string,
  value: unknown,
): Promise<number> {
  const { rows } = await client.query<{ version: number }>(
    `UPDATE fx_checkout.config_entries SET value = $2::jsonb, version = version + 1
      WHERE key = $1 RETURNING version`,
    [key, JSON.stringify(value)],
  );
  return rows[0].version;
}

export async function seedConfig(
  app: pg.Pool,
  entries: Record<string, unknown>,
) {
  await inTx(app, async (client) => {
    for (const [key, value] of Object.entries(entries))
      await insertConfig(client, key, value);
  });
}

export async function memberState(
  client: pg.PoolClient | pg.Pool,
  key: string,
) {
  const { rows } = await client.query<{ value: unknown; version: number }>(
    'SELECT value, version FROM fx_checkout.config_entries WHERE key = $1',
    [key],
  );
  return rows[0];
}

export async function collectionState(client: pg.PoolClient | pg.Pool) {
  const keys = await client.query<{ key: string }>(
    'SELECT key FROM fx_checkout.config_entries ORDER BY key',
  );
  const version = await client.query<{ version: number }>(
    'SELECT version FROM fx_checkout.config_collection',
  );
  return {
    keys: keys.rows.map((row) => row.key),
    collectionVersion: version.rows[0].version,
  };
}

/** What a watcher reads for a member: normalized value and the version it was read at. */
export async function readMember(client: pg.PoolClient, key: string) {
  const state = await memberState(client, key);
  return {
    normalizedValue: { key, value: state.value, version: state.version },
    version: state.version,
  };
}

export async function count(
  pool: pg.Pool | pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

/**
 * Resolves true once the backend `pid` waits for a lock (pg_locks shows an
 * ungranted request; pg_stat_activity hides other roles' wait events from a
 * non-superuser).
 */
export async function waitsOnLock(
  admin: pg.Pool,
  pid: number,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query(
      'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted',
      [pid],
    );
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  return rows[0].pid;
}
