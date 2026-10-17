import pg from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../../../../src/server/nemodots/db/migrate.js';
import { withTestDatabase } from '../../helpers/test-db.js';

it('applies 0001 from empty storage, then nothing; --check reports up to date', async () => {
  await withTestDatabase(
    async ({ urls }) => {
      const before = await migrate({
        connectionString: urls.admin,
        check: true,
      });
      expect(before.pending).toEqual(['0001_bootstrap']);
      const first = await migrate({ connectionString: urls.admin });
      expect(first.applied).toEqual(['0001_bootstrap']);
      const second = await migrate({ connectionString: urls.admin });
      expect(second).toEqual({
        applied: [],
        pending: [],
        unknown: [],
        alreadyApplied: 1,
      });
      const check = await migrate({
        connectionString: urls.admin,
        check: true,
      });
      expect(check.pending).toEqual([]);
      expect(check.unknown).toEqual([]);
    },
    { migrate: false },
  );
});

it('serializes concurrent runners with the advisory lock: exactly one applies', async () => {
  await withTestDatabase(
    async ({ urls }) => {
      const results = await Promise.all(
        [1, 2, 3].map(() => migrate({ connectionString: urls.admin })),
      );
      expect(results.flatMap((result) => result.applied)).toEqual([
        '0001_bootstrap',
      ]);
      const client = new pg.Client({ connectionString: urls.admin });
      await client.connect();
      const rows = await client.query(
        'SELECT id FROM public.schema_migrations',
      );
      await client.end();
      expect(rows.rows).toEqual([{ id: '0001_bootstrap' }]);
    },
    { migrate: false },
  );
});

it('reports ids the code does not know and refuses to run as another role', async () => {
  await withTestDatabase(async ({ urls }) => {
    const client = new pg.Client({ connectionString: urls.admin });
    await client.connect();
    await client.query(
      "INSERT INTO public.schema_migrations (id) VALUES ('9999_from_the_future')",
    );
    await client.end();
    const check = await migrate({ connectionString: urls.admin, check: true });
    expect(check.unknown).toEqual(['9999_from_the_future']);
    await expect(migrate({ connectionString: urls.admin })).rejects.toThrow(
      'migrations this code does not know',
    );
    await expect(migrate({ connectionString: urls.app })).rejects.toThrow(
      'must run as nemodots_admin',
    );
  });
});
