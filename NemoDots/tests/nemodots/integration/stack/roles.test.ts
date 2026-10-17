// Role isolation from 0001_bootstrap's grants and default privileges, on a
// fresh migrated database. Tables are created by nemodots_admin (as later
// migrations will be), so the default privileges are what is under test.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  type TestDatabaseUrls,
  withTestDatabase,
} from '../../helpers/test-db.js';

async function as<T>(url: string, fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function denied(url: string, sql: string) {
  return as(url, async (client) => {
    try {
      await client.query(sql);
      return 'allowed';
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

async function createProbeTables(urls: TestDatabaseUrls) {
  await as(urls.admin, async (client) => {
    for (const schema of ['ledger', 'coordinator', 'checkout', 'control'])
      await client.query(
        `CREATE TABLE ${schema}.probe (id bigserial PRIMARY KEY, note text);
         INSERT INTO ${schema}.probe (note) VALUES ('seed')`,
      );
  });
}

describe('0001_bootstrap role isolation', () => {
  it('denies the cross-schema reads the architecture forbids', async () => {
    await withTestDatabase(async ({ urls }) => {
      await createProbeTables(urls);
      // 42501 = insufficient_privilege
      expect(await denied(urls.checkout, 'SELECT * FROM ledger.probe')).toBe(
        '42501',
      );
      expect(
        await denied(urls.checkout, 'SELECT * FROM coordinator.probe'),
      ).toBe('42501');
      expect(await denied(urls.checkout, 'SELECT * FROM control.probe')).toBe(
        '42501',
      );
      expect(await denied(urls.app, 'SELECT * FROM control.probe')).toBe(
        '42501',
      );
      expect(
        await denied(urls.injector, 'SELECT * FROM coordinator.probe'),
      ).toBe('42501');
      expect(await denied(urls.injector, 'SELECT * FROM ledger.probe')).toBe(
        '42501',
      );
      expect(
        await denied(
          urls.verifier,
          "INSERT INTO control.probe (note) VALUES ('x')",
        ),
      ).toBe('42501');
      expect(
        await denied(
          urls.verifier,
          "INSERT INTO ledger.probe (note) VALUES ('x')",
        ),
      ).toBe('42501');
      expect(
        await denied(
          urls.checkout,
          "INSERT INTO checkout.probe (note) VALUES ('x')",
        ),
      ).toBe('42501');
      expect(
        await denied(urls.app, 'CREATE TABLE ledger.sneaky (id int)'),
      ).toBe('42501');
    });
  });

  it('grants what each role needs through default privileges', async () => {
    await withTestDatabase(async ({ urls }) => {
      await createProbeTables(urls);
      for (const schema of ['ledger', 'coordinator'])
        await as(urls.app, async (client) => {
          await client.query(
            `INSERT INTO ${schema}.probe (note) VALUES ('app')`,
          );
          await client.query(
            `UPDATE ${schema}.probe SET note = 'app2' WHERE note = 'app'`,
          );
          await client.query(`DELETE FROM ${schema}.probe WHERE note = 'app2'`);
        });
      expect(await denied(urls.app, 'SELECT note FROM checkout.probe')).toBe(
        'allowed',
      );
      expect(
        await denied(urls.checkout, 'SELECT note FROM checkout.probe'),
      ).toBe('allowed');
      await as(urls.injector, (client) =>
        client.query("INSERT INTO control.probe (note) VALUES ('fault')"),
      );
      for (const schema of ['ledger', 'coordinator', 'checkout', 'control']) {
        const count = await as(urls.verifier, (client) =>
          client.query<{ n: string }>(
            `SELECT count(*) AS n FROM ${schema}.probe`,
          ),
        );
        expect(Number(count.rows[0].n)).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it('lets app and injector LISTEN and receive NOTIFY', async () => {
    await withTestDatabase(async ({ urls }) => {
      for (const role of ['app', 'injector'] as const) {
        const listener = new pg.Client({ connectionString: urls[role] });
        await listener.connect();
        try {
          const received = new Promise<string | undefined>((resolve) =>
            listener.once('notification', (message) =>
              resolve(message.payload),
            ),
          );
          await listener.query('LISTEN nemodots_action_proposed');
          await as(urls.app, (client) =>
            client.query("SELECT pg_notify('nemodots_action_proposed', $1)", [
              `cache.namespace:${role}`,
            ]),
          );
          await expect(received).resolves.toBe(`cache.namespace:${role}`);
        } finally {
          await listener.end();
        }
      }
    });
  });

  it('revokes CONNECT from PUBLIC and keeps schemas owned by nemodots_admin', async () => {
    await withTestDatabase(async ({ urls, name }) => {
      const rows = await as(urls.admin, (client) =>
        client.query<{ nspname: string; owner: string }>(
          `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace
           WHERE nspname IN ('ledger','coordinator','checkout','control') ORDER BY 1`,
        ),
      );
      expect(rows.rows).toEqual(
        ['checkout', 'control', 'coordinator', 'ledger'].map((nspname) => ({
          nspname,
          owner: 'nemodots_admin',
        })),
      );
      const acl = await as(urls.admin, (client) =>
        client.query<{ public_connect: boolean }>(
          `SELECT has_database_privilege('public', $1, 'CONNECT') AS public_connect`,
          [name],
        ),
      );
      expect(acl.rows[0].public_connect).toBe(false);
    });
  });
});
