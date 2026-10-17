// Transactions with retry on serialization failure (40001) and deadlock
// (40P01).
//
// RULE: never await non-database work inside the callback. No model calls,
// HTTP requests, Redis effects, timers or file I/O. The callback holds row
// locks for as long as it runs, and a retry re-executes it from the start, so
// anything other than SQL on `client` would either stall other writers or
// happen more than once. Do the slow or external part before or after the
// transaction and pass its result in.
import type pg from 'pg';

export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '40001',
  '40P01',
]);

export type IsolationLevel =
  'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
  /** Total attempts including the first (default 5). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; code: string; delayMs: number }) => void;
}

export function sqlState(error: unknown) {
  return typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function isRetryable(error: unknown) {
  const code = sqlState(error);
  return code !== undefined && RETRYABLE_SQLSTATES.has(code);
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base * 2^(attempt-1))]. */
export function retryDelay(
  attempt: number,
  random: () => number,
  baseDelayMs = 10,
  maxDelayMs = 500,
) {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TransactionPool {
  connect(): Promise<pg.PoolClient>;
}

export async function withTransaction<T>(
  pool: TransactionPool,
  fn: (client: pg.PoolClient, attempt: number) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepFor;
  const begin = [
    'BEGIN',
    options.isolation
      ? `ISOLATION LEVEL ${options.isolation.toUpperCase()}`
      : '',
    options.readOnly ? 'READ ONLY' : '',
  ]
    .filter(Boolean)
    .join(' ');
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    let result: T;
    try {
      await client.query(begin);
      result = await fn(client, attempt);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (rollbackError) {
        // The connection is in an unknown state: destroy it instead of
        // returning it to the pool.
        client.release(rollbackError as Error);
      }
      if (!isRetryable(error) || attempt >= maxAttempts) throw error;
      const delayMs = retryDelay(
        attempt,
        random,
        options.baseDelayMs,
        options.maxDelayMs,
      );
      options.onRetry?.({ attempt, code: sqlState(error)!, delayMs });
      await sleep(delayMs);
      continue;
    }
    client.release();
    return result;
  }
}
