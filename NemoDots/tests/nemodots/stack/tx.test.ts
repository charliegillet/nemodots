// Deterministic checks of withTransaction's control flow with a scripted
// client. The real 40001/40P01 behaviour against PostgreSQL is covered in
// tests/nemodots/integration/stack/tx.test.ts.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  TransactionRolledBackError,
  isRetryable,
  retryDelay,
  withTransaction,
} from '../../../src/server/nemodots/db/tx.js';

function scriptedPool(failRollback = false, commitCommand = 'COMMIT') {
  const log: string[] = [];
  const releases: (Error | undefined)[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          log.push(sql);
          if (sql === 'ROLLBACK' && failRollback)
            throw new Error('connection lost');
          return { rows: [], command: sql === 'COMMIT' ? commitCommand : sql };
        },
        release(error?: Error) {
          releases.push(error);
        },
      } as unknown as pg.PoolClient;
    },
  };
  return { pool, log, releases };
}

const sqlError = (code: string) =>
  Object.assign(new Error(`sqlstate ${code}`), { code });

describe('withTransaction', () => {
  it('throws instead of returning when COMMIT silently rolled back', async () => {
    const { pool, releases } = scriptedPool(false, 'ROLLBACK');
    await expect(
      withTransaction(pool, async () => 'returned-ok'),
    ).rejects.toBeInstanceOf(TransactionRolledBackError);
    expect(releases).toEqual([undefined]);
  });

  it('commits and releases on success, with the requested isolation', async () => {
    const { pool, log, releases } = scriptedPool();
    const result = await withTransaction(pool, async () => 42, {
      isolation: 'serializable',
      readOnly: true,
    });
    expect(result).toBe(42);
    expect(log).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY',
      'COMMIT',
    ]);
    expect(releases).toEqual([undefined]);
  });

  it.each(['40001', '40P01'])(
    'retries %s with jittered backoff and re-runs the callback from the start',
    async (code) => {
      const { pool, log } = scriptedPool();
      const delays: number[] = [];
      const attempts: number[] = [];
      const result = await withTransaction(
        pool,
        async (_client, attempt) => {
          attempts.push(attempt);
          if (attempt < 3) throw sqlError(code);
          return 'ok';
        },
        {
          random: () => 0.5,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      );
      expect(result).toBe('ok');
      expect(attempts).toEqual([1, 2, 3]);
      expect(delays).toEqual([5, 10]);
      expect(log).toEqual([
        'BEGIN',
        'ROLLBACK',
        'BEGIN',
        'ROLLBACK',
        'BEGIN',
        'COMMIT',
      ]);
    },
  );

  it('does not retry other errors and stops after maxAttempts', async () => {
    const { pool } = scriptedPool();
    let calls = 0;
    await expect(
      withTransaction(pool, async () => {
        calls += 1;
        throw sqlError('23505');
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      withTransaction(
        pool,
        async () => {
          calls += 1;
          throw sqlError('40001');
        },
        { maxAttempts: 3, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect(calls).toBe(3);
  });

  it('destroys the connection when ROLLBACK itself fails', async () => {
    const { pool, releases } = scriptedPool(true);
    await expect(
      withTransaction(pool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
  });
});

it('retryDelay is full jitter capped by maxDelayMs', () => {
  expect(retryDelay(1, () => 0.999, 10, 500)).toBe(9);
  expect(retryDelay(4, () => 0.999, 10, 500)).toBe(79);
  expect(retryDelay(20, () => 0.999, 10, 500)).toBe(499);
  expect(retryDelay(3, () => 0, 10, 500)).toBe(0);
  expect(isRetryable(sqlError('40P01'))).toBe(true);
  expect(isRetryable(new Error('x'))).toBe(false);
});
