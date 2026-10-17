// withTransaction against real PostgreSQL failures, and the role pool settings.
import pg from 'pg';
import { expect, it } from 'vitest';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { barrier } from '../../helpers/barrier.js';
import { withTestDatabase } from '../../helpers/test-db.js';

async function adminExec(url: string, sql: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

it('role pools carry application_name and the 15 s statement timeout', async () => {
  await withTestDatabase(async ({ urls }) => {
    const pool = createRolePool('app', urls.app);
    try {
      const { rows } = await pool.query<{
        application_name: string;
        statement_timeout: string;
        current_user: string;
      }>(
        "SELECT current_setting('application_name') AS application_name, current_setting('statement_timeout') AS statement_timeout, current_user",
      );
      expect(rows[0]).toEqual({
        application_name: 'nemodots-app',
        statement_timeout: '15s',
        current_user: 'nemodots_app',
      });
    } finally {
      await pool.end();
    }
    expect(() => createRolePool('app', urls.app, { max: 20 })).toThrow(
      RangeError,
    );
  });
});

it('retries a real serialization failure (40001) until both writers commit', async () => {
  await withTestDatabase(async ({ urls }) => {
    await adminExec(
      urls.admin,
      `CREATE TABLE ledger.counter (id int PRIMARY KEY, n int NOT NULL);
       INSERT INTO ledger.counter VALUES (1, 0)`,
    );
    const pool = createRolePool('app', urls.app);
    try {
      const bothRead = barrier(2);
      const retries: string[] = [];
      const increment = () =>
        withTransaction(
          pool,
          async (client, attempt) => {
            const { rows } = await client.query<{ n: number }>(
              'SELECT n FROM ledger.counter WHERE id = 1',
            );
            if (attempt === 1) await bothRead.arrive();
            await client.query(
              'UPDATE ledger.counter SET n = $1 WHERE id = 1',
              [rows[0].n + 1],
            );
            return attempt;
          },
          {
            isolation: 'serializable',
            onRetry: ({ code }) => retries.push(code),
          },
        );
      const attempts = await Promise.all([increment(), increment()]);
      expect(retries).toEqual(['40001']);
      expect(attempts.sort()).toEqual([1, 2]);
      const { rows } = await pool.query('SELECT n FROM ledger.counter');
      expect(rows[0].n).toBe(2);
    } finally {
      await pool.end();
    }
  });
});

it('retries the victim of a real deadlock (40P01)', async () => {
  await withTestDatabase(async ({ urls }) => {
    await adminExec(
      urls.admin,
      `CREATE TABLE coordinator.locks (id int PRIMARY KEY, n int NOT NULL);
       INSERT INTO coordinator.locks VALUES (1, 0), (2, 0)`,
    );
    const pool = createRolePool('app', urls.app);
    try {
      const firstLocks = barrier(2);
      const retries: string[] = [];
      const run = (first: number, second: number) =>
        withTransaction(
          pool,
          async (client, attempt) => {
            await client.query(
              'UPDATE coordinator.locks SET n = n + 1 WHERE id = $1',
              [first],
            );
            if (attempt === 1) await firstLocks.arrive();
            await client.query(
              'UPDATE coordinator.locks SET n = n + 1 WHERE id = $1',
              [second],
            );
          },
          { onRetry: ({ code }) => retries.push(code) },
        );
      await Promise.all([run(1, 2), run(2, 1)]);
      expect(retries).toEqual(['40P01']);
      const { rows } = await pool.query(
        'SELECT id, n FROM coordinator.locks ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, n: 2 },
        { id: 2, n: 2 },
      ]);
    } finally {
      await pool.end();
    }
  });
});
