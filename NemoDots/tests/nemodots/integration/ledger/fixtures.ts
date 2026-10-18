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
import { registerObservation } from '../../../../src/server/nemodots/ledger/receipts.js';
import type {
  LedgerOptions,
  RegistrationLedgerOptions,
} from '../../../../src/server/nemodots/ledger/options.js';
import type { EventSinkPort } from '../../../../src/server/nemodots/contracts/index.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';

/**
 * A recording EventSinkPort for ledger-only tests: the fixture schemas have no
 * coordinator.events table, so the events are kept in memory.
 */
export const recordedEvents: { missionId: string; payload: unknown }[] = [];
export const recordingSink: EventSinkPort = {
  async append(_client, event) {
    recordedEvents.push({
      missionId: event.missionId,
      payload: event.payload,
    });
    return recordedEvents.length;
  },
};

/** Ledger options of the fixture schemas, with a recording event sink. */
export const FX: RegistrationLedgerOptions &
  Required<Pick<LedgerOptions, 'checkoutSchema' | 'coordinatorSchema'>> = {
  checkoutSchema: 'fx_checkout',
  coordinatorSchema: 'fx_coordinator',
  events: recordingSink,
};

/** Default-schema ledger options with a recording sink (real coordinator tables, no events table use). */
export const REAL: RegistrationLedgerOptions = { events: recordingSink };

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
CREATE TABLE fx_coordinator.missions (
  id uuid PRIMARY KEY, owner_id text NOT NULL, environment text NOT NULL,
  space_id text, resource text NOT NULL);
CREATE TABLE fx_coordinator.task_outputs (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, usable boolean NOT NULL DEFAULT true,
  unusable_reason text, dependency_vector jsonb NOT NULL DEFAULT '[]'::jsonb);
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
let active: LedgerDb | undefined;

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
    active = current;
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
  await flushMissions();
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
/**
 * Every scope handed out by newScope() is a mission: its row is written to
 * both fx_coordinator.missions and coordinator.missions before the next
 * ledger call (inTx / inMission), because the ledger establishes a mission's
 * scope from its row and refuses an unknown mission (F4).
 */
const pendingMissions = new Map<string, TestScope>();

export async function flushMissions() {
  if (pendingMissions.size === 0 || !active) return;
  const batch = [...pendingMissions.values()];
  pendingMissions.clear();
  for (const scope of batch) {
    await active.admin.query(
      `INSERT INTO fx_coordinator.missions (id, owner_id, environment, space_id, resource)
       VALUES ($1, $2, $3, NULL, $4) ON CONFLICT (id) DO NOTHING`,
      [scope.missionId, scope.ownerId, scope.environment, scope.resource],
    );
    await active.admin.query(
      `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
       VALUES ($1, $2, $3, $4, 'ledger fixture', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [scope.missionId, scope.ownerId, scope.environment, scope.resource],
    );
  }
}

export function newScope(
  environment: TestScope['environment'] = 'test',
): TestScope {
  const scope = {
    ownerId: `owner-${randomUUID()}`,
    missionId: randomUUID(),
    environment,
    resource: 'checkout',
  };
  pendingMissions.set(scope.missionId, scope);
  return scope;
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
    `TRUNCATE fx_coordinator.missions, fx_coordinator.tasks, fx_coordinator.task_attempts,
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

/** The mission scope of a TestScope (ledger fixtures have no coordinator.missions row). */
export function missionScope(scope: TestScope) {
  return {
    ownerId: scope.ownerId,
    environment: scope.environment,
    spaceId: null,
    resource: scope.resource,
  };
}

/**
 * assertCurrent options bound to the mission the receipt was registered for:
 * the scope check is mandatory (F4), and these fixtures have no
 * coordinator.missions row, so the scope of the receipt's own source is
 * claimed alongside the mission id.
 */
export async function inMission<T extends object>(
  receiptIds: string | string[],
  opts: T,
) {
  await flushMissions();
  const { rows } = await active!.admin.query<{
    mission_id: string;
    owner_id: string;
    environment: string;
    space_id: string | null;
    resource: string;
  }>(
    `SELECT r.mission_id, s.owner_id, s.environment, s.space_id, s.resource
       FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
      WHERE r.id = ANY($1::uuid[]) LIMIT 1`,
    [Array.isArray(receiptIds) ? receiptIds : [receiptIds]],
  );
  // an unknown id is rejected before the scope check; any mission will do
  const row = rows[0] ?? {
    mission_id: randomUUID(),
    owner_id: 'none',
    environment: 'test',
    space_id: null,
    resource: 'checkout',
  };
  return {
    ...opts,
    missionId: row.mission_id,
    scope: {
      ownerId: row.owner_id,
      environment: row.environment as 'dev' | 'test' | 'eval',
      spaceId: row.space_id,
      resource: row.resource,
    },
  };
}

/** registerObservation against the default schemas with a recording event sink. */
export const registerReal = (
  client: pg.PoolClient,
  input: Parameters<typeof registerObservation>[1],
) => registerObservation(client, input, { ledger: REAL });

/** Writes a mission row (both fixture and default coordinator schemas). */
export async function ensureMission(
  missionId: string,
  scope: {
    ownerId: string;
    environment: 'dev' | 'test' | 'eval';
    spaceId?: string | null;
    resource: string;
  },
) {
  await active!.admin.query(
    `INSERT INTO fx_coordinator.missions (id, owner_id, environment, space_id, resource)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [
      missionId,
      scope.ownerId,
      scope.environment,
      scope.spaceId ?? null,
      scope.resource,
    ],
  );
  await active!.admin.query(
    `INSERT INTO coordinator.missions (id, owner_id, environment, space_id, resource, goal, mode, status, budgets, provider)
     VALUES ($1, $2, $3, $4, $5, 'ledger fixture', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      missionId,
      scope.ownerId,
      scope.environment,
      scope.spaceId ?? null,
      scope.resource,
    ],
  );
}
