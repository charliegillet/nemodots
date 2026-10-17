// Migration 0004 from empty storage: tables, grants per ARCHITECTURE section 3,
// and the append-only history.
import pg from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../../../../src/server/nemodots/db/migrate.js';
import { withTestDatabase } from '../../helpers/test-db.js';

it('applies 0004_checkout on an empty database, once, and creates the checkout and control tables', async () => {
  await withTestDatabase(
    async ({ urls }) => {
      const first = await migrate({ connectionString: urls.admin });
      expect(first.applied).toContain('0004_checkout');
      expect(first.applied.indexOf('0001_bootstrap')).toBeLessThan(
        first.applied.indexOf('0004_checkout'),
      );
      const second = await migrate({ connectionString: urls.admin });
      expect(second.applied).toEqual([]);
      const client = new pg.Client({ connectionString: urls.admin });
      await client.connect();
      try {
        const tables = await client.query<{
          table_schema: string;
          table_name: string;
        }>(
          `SELECT table_schema, table_name FROM information_schema.tables
            WHERE table_schema IN ('checkout', 'control') ORDER BY 1, 2`,
        );
        expect(
          tables.rows.map((r) => `${r.table_schema}.${r.table_name}`),
        ).toEqual([
          'checkout.config_collection',
          'checkout.config_entries',
          'checkout.config_versions',
          'checkout.inventory',
          'checkout.inventory_replica',
          'checkout.order_items',
          'checkout.orders',
          'checkout.products',
          'control.fault_schedules',
          'control.scenario_runs',
        ]);
        const collection = await client.query(
          'SELECT singleton, version FROM checkout.config_collection',
        );
        expect(collection.rows).toEqual([{ singleton: true, version: '1' }]);
        const columns = await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'checkout' AND table_name = 'orders'`,
        );
        expect(columns.rows.map((r) => r.column_name)).toContain(
          'probe_run_id',
        );
      } finally {
        await client.end();
      }
    },
    { migrate: false },
  );
});

it('grants exactly the documented privileges per role', async () => {
  await withTestDatabase(async ({ urls }) => {
    const client = new pg.Client({ connectionString: urls.admin });
    await client.connect();
    try {
      const can = async (role: string, table: string, privilege: string) =>
        (
          await client.query<{ ok: boolean }>(
            'SELECT has_table_privilege($1, $2, $3) AS ok',
            [role, table, privilege],
          )
        ).rows[0].ok;
      // app: read checkout, update the version authority tables, append history
      expect(
        await can('nemodots_app', 'checkout.config_entries', 'SELECT'),
      ).toBe(true);
      expect(
        await can('nemodots_app', 'checkout.config_entries', 'UPDATE'),
      ).toBe(true);
      expect(
        await can('nemodots_app', 'checkout.config_entries', 'INSERT'),
      ).toBe(false);
      expect(
        await can('nemodots_app', 'checkout.config_collection', 'UPDATE'),
      ).toBe(true);
      expect(
        await can('nemodots_app', 'checkout.config_versions', 'INSERT'),
      ).toBe(true);
      expect(
        await can('nemodots_app', 'checkout.config_versions', 'UPDATE'),
      ).toBe(false);
      expect(await can('nemodots_app', 'checkout.orders', 'INSERT')).toBe(
        false,
      );
      expect(await can('nemodots_app', 'control.scenario_runs', 'SELECT')).toBe(
        false,
      );
      // injector: full control of config tables and control.*, history append-only
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        expect(
          await can('nemodots_injector', 'checkout.config_entries', privilege),
        ).toBe(true);
      expect(
        await can('nemodots_injector', 'checkout.config_collection', 'UPDATE'),
      ).toBe(true);
      expect(
        await can('nemodots_injector', 'checkout.config_versions', 'INSERT'),
      ).toBe(true);
      expect(
        await can('nemodots_injector', 'checkout.config_versions', 'UPDATE'),
      ).toBe(false);
      expect(
        await can('nemodots_injector', 'control.fault_schedules', 'INSERT'),
      ).toBe(true);
      expect(await can('nemodots_injector', 'checkout.orders', 'INSERT')).toBe(
        false,
      );
      // checkout: its business tables only, no config writes, no control
      expect(
        await can('nemodots_checkout', 'checkout.config_entries', 'SELECT'),
      ).toBe(true);
      expect(
        await can('nemodots_checkout', 'checkout.config_entries', 'UPDATE'),
      ).toBe(false);
      expect(
        await can('nemodots_checkout', 'checkout.config_versions', 'INSERT'),
      ).toBe(false);
      expect(await can('nemodots_checkout', 'checkout.orders', 'INSERT')).toBe(
        true,
      );
      expect(
        await can('nemodots_checkout', 'checkout.order_items', 'INSERT'),
      ).toBe(true);
      expect(
        await can('nemodots_checkout', 'checkout.inventory', 'UPDATE'),
      ).toBe(true);
      expect(
        await can('nemodots_checkout', 'checkout.inventory_replica', 'UPDATE'),
      ).toBe(false);
      expect(
        await can('nemodots_checkout', 'checkout.products', 'UPDATE'),
      ).toBe(false);
      expect(
        await can('nemodots_checkout', 'control.scenario_runs', 'SELECT'),
      ).toBe(false);
      // verifier: read everything including control, write nothing
      expect(
        await can('nemodots_verifier', 'control.fault_schedules', 'SELECT'),
      ).toBe(true);
      expect(await can('nemodots_verifier', 'checkout.orders', 'SELECT')).toBe(
        true,
      );
      expect(await can('nemodots_verifier', 'checkout.orders', 'INSERT')).toBe(
        false,
      );
    } finally {
      await client.end();
    }
  });
});

it('nemodots_checkout cannot read control.* through a real connection', async () => {
  await withTestDatabase(async ({ urls }) => {
    const client = new pg.Client({ connectionString: urls.checkout });
    await client.connect();
    try {
      await expect(
        client.query('SELECT 1 FROM control.scenario_runs'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query('SELECT 1 FROM control.fault_schedules'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        client.query("UPDATE checkout.config_entries SET value = '1'::jsonb"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

it('config_versions is append-only even for its owner', async () => {
  await withTestDatabase(async ({ urls }) => {
    const client = new pg.Client({ connectionString: urls.admin });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO checkout.config_versions (key, version, value, caused_by_actor)
         VALUES ('x.y', 1, '1'::jsonb, 'seed')`,
      );
      await expect(
        client.query("UPDATE checkout.config_versions SET value = '2'::jsonb"),
      ).rejects.toThrow(/append-only/);
      await expect(
        client.query('DELETE FROM checkout.config_versions'),
      ).rejects.toThrow(/append-only/);
    } finally {
      await client.end();
    }
  });
});
