// Setup file for the DB suites (vitest.integration.config.ts). A pg.Pool or
// pg.Client with no 'error' listener turns a connection error (for example
// 57P01 when withTestDatabase force-drops its database, or a test terminating
// a backend) into an unhandled error, and vitest's reporter then serializes
// hidden fields, including the client's password, into the run output. Give
// every pool and client a default listener that reports only the error code
// and message. A test's own listeners still receive the event, and a failed
// query still rejects its promise.
import pg from 'pg';

const guarded = new WeakSet<pg.Pool | pg.Client>();
const originalConnect = pg.Pool.prototype.connect;
const originalQuery = pg.Pool.prototype.query;
const originalClientConnect = pg.Client.prototype.connect;

function guard(target: pg.Pool | pg.Client, label: string): void {
  if (guarded.has(target)) return;
  guarded.add(target);
  (target as unknown as NodeJS.EventEmitter).on(
    'error',
    (error: Error & { code?: string }) => {
      process.stderr.write(
        `[pg ${label} error] ${error.code ?? 'no-code'}: ${error.message}\n`,
      );
    },
  );
}

pg.Client.prototype.connect = function (this: pg.Client, ...args: never[]) {
  guard(this, 'client');
  return (originalClientConnect as (...a: never[]) => unknown).apply(
    this,
    args,
  );
} as typeof originalClientConnect;

// Pools are guarded on first use, so every construction path is covered
// without replacing the constructor.
pg.Pool.prototype.connect = function (this: pg.Pool, ...args: never[]) {
  guard(this, 'pool');
  return (originalConnect as (...a: never[]) => unknown).apply(this, args);
} as typeof originalConnect;

pg.Pool.prototype.query = function (this: pg.Pool, ...args: never[]) {
  guard(this, 'pool');
  return (originalQuery as (...a: never[]) => unknown).apply(this, args);
} as typeof originalQuery;
