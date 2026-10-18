// withTestDatabase: a fresh, migrated `nemodots_test_<rand>` database on the
// NemoDots PostgreSQL instance (port 55432 by default, never 5432), dropped
// afterwards. Returns per-role URLs for the new database so tests connect as
// the role whose grants they exercise.
//
// Role URLs come from the environment (`npm run test:nemodots:db` loads
// roles.env through stack.mjs exec) or, failing that, from
// .local/<NEMODOTS_INSTANCE>/stack/roles.env.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  DEFAULT_PG_PORT,
  PG_ROLES,
  type PgRole,
  assertSafePgUrl,
  pgUrlEnvName,
} from '../../../src/server/nemodots/config/env.js';
import { readRolesFile } from '../../../src/server/nemodots/config/roles-file.js';
import { migrate } from '../../../src/server/nemodots/db/migrate.js';

export type TestDatabaseUrls = Record<PgRole, string>;

export interface TestDatabase {
  name: string;
  urls: TestDatabaseUrls;
}

const NAME_PATTERN = /^nemodots_test_[0-9a-f]+$/;

/** The instance's role URLs (pointing at its main database). */
export function stackRoleUrls(env = process.env): TestDatabaseUrls {
  const fromEnv = PG_ROLES.every((role) => env[pgUrlEnvName(role)]);
  const source: Record<string, string | undefined> = fromEnv
    ? env
    : readRolesFile(process.cwd(), env.NEMODOTS_INSTANCE ?? 'dev');
  const expectedPort = Number(env.NEMODOTS_PG_PORT ?? DEFAULT_PG_PORT);
  const urls = {} as TestDatabaseUrls;
  for (const role of PG_ROLES) {
    const name = pgUrlEnvName(role);
    const value = source[name];
    if (!value) throw new Error(`${name} is not available to the test.`);
    const parsed = assertSafePgUrl(name, value);
    if (parsed.port !== expectedPort)
      throw new Error(
        `${name} does not point at the NemoDots instance port ${expectedPort}.`,
      );
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.host))
      throw new Error(`${name} must point at a loopback host.`);
    urls[role] = value;
  }
  return urls;
}

export function withDatabase(url: string, database: string) {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

export interface WithTestDatabaseOptions {
  /** Apply migrations (default true). */
  migrate?: boolean;
}

export async function withTestDatabase<T>(
  fn: (db: TestDatabase) => Promise<T>,
  options: WithTestDatabaseOptions = {},
): Promise<T> {
  const base = stackRoleUrls();
  const name = `nemodots_test_${randomBytes(6).toString('hex')}`;
  if (!NAME_PATTERN.test(name)) throw new Error('Invalid test database name.');
  const admin = new pg.Client({
    connectionString: base.admin,
    application_name: 'nemodots-test-db',
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER nemodots_admin`);
    const urls = Object.fromEntries(
      PG_ROLES.map((role) => [role, withDatabase(base[role], name)]),
    ) as TestDatabaseUrls;
    try {
      if (options.migrate !== false)
        await migrate({ connectionString: urls.admin });
      return await fn({ name, urls });
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
