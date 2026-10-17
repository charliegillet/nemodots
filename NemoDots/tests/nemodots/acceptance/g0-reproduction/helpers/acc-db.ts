// Throwaway databases named acc0_<hex> on the NemoDots PostgreSQL instance.
// Only databases created by this process are ever dropped.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  NAME_PATTERN,
  DB_PREFIX,
  ROLES,
  loadStack,
  withDb,
  type Role,
  type StackInstance,
} from './common.js';

export interface AccDb {
  name: string;
  stack: StackInstance;
  urls: Record<Role, string>;
  drop(): Promise<void>;
}

const created = new Set<string>();

export async function createAccDb(): Promise<AccDb> {
  const stack = loadStack();
  const name = `${DB_PREFIX}${randomBytes(6).toString('hex')}`;
  if (!NAME_PATTERN.test(name)) throw new Error('bad database name');
  const admin = new pg.Client({
    connectionString: stack.roleUrls.admin,
    application_name: 'acc0-g0',
  });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `NemoDots PostgreSQL on 55432 is not reachable as nemodots_admin (${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '[url]')}); start it with \`npm run nemodots:stack -- start\`.`,
    );
  }
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER nemodots_admin`);
    created.add(name);
  } finally {
    await admin.end();
  }
  const urls = Object.fromEntries(
    ROLES.map((r) => [r, withDb(stack.roleUrls[r], name)]),
  ) as Record<Role, string>;
  return {
    name,
    stack,
    urls,
    async drop() {
      if (!created.has(name) || !NAME_PATTERN.test(name)) return;
      const client = new pg.Client({ connectionString: stack.roleUrls.admin });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        created.delete(name);
      } finally {
        await client.end();
      }
    },
  };
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  sql: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
