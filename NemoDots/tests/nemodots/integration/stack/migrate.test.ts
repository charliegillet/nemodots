import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../../../../src/server/nemodots/db/migrate.js';
import { withTestDatabase } from '../../helpers/test-db.js';

// Every migration on disk, listed independently of the runner's discovery.
// Later waves add migrations, so the expected set is read from the directory
// rather than hard-coded; 0001 must still be first.
const MIGRATION_IDS = [
  ...new Set(
    readdirSync(
      fileURLToPath(
        new URL(
          '../../../../src/server/nemodots/db/migrations/',
          import.meta.url,
        ),
      ),
    )
      .map((name) => /^(\d{4}_[a-z0-9_]+)\.ts$/.exec(name)?.[1])
      .filter((id): id is string => id !== undefined),
  ),
].sort();

it('lists 0001_bootstrap as the first migration on disk', () => {
  expect(MIGRATION_IDS[0]).toBe('0001_bootstrap');
});

it('applies every migration from empty storage, then nothing; --check reports up to date', async () => {
  await withTestDatabase(
    async ({ urls }) => {
      const before = await migrate({
        connectionString: urls.admin,
        check: true,
      });
      expect(before.pending).toEqual(MIGRATION_IDS);
      const first = await migrate({ connectionString: urls.admin });
      expect(first.applied).toEqual(MIGRATION_IDS);
      const second = await migrate({ connectionString: urls.admin });
      expect(second).toEqual({
        applied: [],
        pending: [],
        unknown: [],
        alreadyApplied: MIGRATION_IDS.length,
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
      expect(results.flatMap((result) => result.applied)).toEqual(
        MIGRATION_IDS,
      );
      const client = new pg.Client({ connectionString: urls.admin });
      await client.connect();
      const rows = await client.query(
        'SELECT id FROM public.schema_migrations ORDER BY id',
      );
      await client.end();
      expect(rows.rows).toEqual(MIGRATION_IDS.map((id) => ({ id })));
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
