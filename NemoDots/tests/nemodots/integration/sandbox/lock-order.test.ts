// Lock-order regressions of the version authority (ARCHITECTURE.md 5.1 steps
// 4-5): the collection row is ALWAYS locked before member rows, by every
// writer (injector, seed, action commit, owner edit), so overlapping writers
// serialize without deadlock. Each interleaving is built from real row locks;
// the second lock request of the "protocol-ordered" writer carries a 500 ms
// lock_timeout, so an inverted order surfaces as 55P03 well before PostgreSQL's
// 1 s deadlock detector would pick a victim.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import {
  ConfigVersionError,
  advanceConfig,
  advanceConfigTx,
  advanceConfigUnconditionally,
  lockConfigRows,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withSandbox } from './harness.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until at least `count` backends of this database wait for a lock. */
async function waitForWaiters(admin: pg.Pool, count = 1) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await admin.query<{ n: number }>(
      `SELECT count(DISTINCT l.pid)::int AS n
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (waiting.rows[0].n >= count) return;
    await sleep(15);
  }
  throw new Error(`fewer than ${count} backend(s) ever waited for a lock`);
}

const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
const code = (error: unknown) =>
  typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : String(error);

describe('injector writes take the collection lock before the member row', () => {
  it('an unconditional delete does not deadlock against a collection-first vector lock', async () => {
    await withSandbox(async ({ pools }) => {
      const action = await pools.app.connect();
      try {
        await action.query('BEGIN');
        await action.query("SET LOCAL lock_timeout = '500ms'");
        // action commit step 4: the collection row first
        await lockConfigRows(action, { keys: [], collection: true });
        // the injector deletes a key: it must queue on the COLLECTION without
        // holding the member row yet
        const injector = outcome(
          withTransaction(
            pools.injector,
            (client) =>
              advanceConfigUnconditionally(client, {
                key: 'ui.banner_text',
                deleteKey: true,
                causedBy: { actor: 'injector' },
              }),
            { maxAttempts: 1 },
          ),
        );
        await waitForWaiters(pools.admin);
        // action commit step 5: the member row. Inverted injector order would
        // make this wait on the injector (and the injector on the collection).
        await lockConfigRows(action, { keys: ['ui.banner_text'] });
        await action.query('COMMIT');
        const result = await injector;
        expect(result.ok).toBe(true);
      } finally {
        action.release();
      }
    });
  });

  it('an unconditional update (no membership change) never needs the collection row', async () => {
    await withSandbox(async ({ pools }) => {
      const action = await pools.app.connect();
      try {
        await action.query('BEGIN');
        await lockConfigRows(action, { keys: [], collection: true });
        const result = await withTransaction(
          pools.injector,
          (client) =>
            advanceConfigUnconditionally(client, {
              key: 'ui.banner_text',
              value: 'no collection lock',
              causedBy: { actor: 'injector' },
            }),
          { maxAttempts: 1 },
        );
        expect(result).toMatchObject({
          operation: 'update',
          membershipChanged: false,
        });
        await action.query('COMMIT');
      } finally {
        action.release();
      }
    });
  });

  it('an unconditional write advances from the version found under the lock, inserts a missing key and reports a missing one', async () => {
    await withSandbox(async ({ pools }) => {
      await advanceConfigTx(pools.app, {
        key: 'db.pool_max',
        value: 4,
        expectedVersion: 1,
        causedBy: { actor: 'owner' },
      });
      const updated = await withTransaction(pools.injector, (client) =>
        advanceConfigUnconditionally(client, {
          key: 'db.pool_max',
          value: 7,
          causedBy: { actor: 'injector' },
        }),
      );
      expect(updated).toMatchObject({ versionBefore: 2, versionAfter: 3 });
      const inserted = await withTransaction(pools.injector, (client) =>
        advanceConfigUnconditionally(client, {
          key: 'fresh.key',
          value: true,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        }),
      );
      expect(inserted).toMatchObject({
        operation: 'insert',
        versionBefore: 0,
        versionAfter: 1,
        membershipChanged: true,
      });
      const missing = await withTransaction(
        pools.injector,
        (client) =>
          advanceConfigUnconditionally(client, {
            key: 'never.there',
            value: 1,
            causedBy: { actor: 'injector' },
          }),
        { maxAttempts: 1 },
      ).catch((error: unknown) => error);
      expect(missing).toMatchObject({ code: 'missing_key' });
    });
  });
});

describe('an insert that lost a race with a delete is a stale_version', () => {
  it('two inserters queued behind a delete: one wins, the other gets stale_version, never a unique violation', async () => {
    await withSandbox(async ({ pools }) => {
      const deleter = await pools.injector.connect();
      try {
        await deleter.query('BEGIN');
        await advanceConfig(deleter, {
          key: 'ui.banner_text',
          deleteKey: true,
          expectedVersion: 1,
          causedBy: { actor: 'injector' },
        });
        const insert = () =>
          outcome(
            advanceConfigTx(
              pools.injector,
              {
                key: 'ui.banner_text',
                value: 'back',
                expectedVersion: 0,
                insertIfMissing: true,
                causedBy: { actor: 'injector' },
              },
              { maxAttempts: 1 },
            ),
          );
        // both peek the still-visible row and block on its member lock
        const a = insert();
        const b = insert();
        await waitForWaiters(pools.admin, 2);
        await deleter.query('COMMIT');
        const results = await Promise.all([a, b]);
        const wins = results.filter((r) => r.ok);
        const losses = results.filter((r) => !r.ok);
        expect(wins).toHaveLength(1);
        expect(losses).toHaveLength(1);
        const error = (losses[0] as { error: unknown }).error;
        expect(error).toBeInstanceOf(ConfigVersionError);
        expect(error).toMatchObject({ code: 'stale_version' });
        expect(code(error)).not.toBe('23505');
        // the loser reports the version that now exists
        expect((error as ConfigVersionError).currentVersion).toBe(3);
      } finally {
        deleter.release();
      }
      const row = await pools.verifier.query(
        "SELECT value, version FROM checkout.config_entries WHERE key = 'ui.banner_text'",
      );
      expect(row.rows).toEqual([{ value: 'back', version: '3' }]);
    });
  });
});

describe('seed --reset-config locks in protocol order', () => {
  it('does not deadlock with a writer that holds one baseline key and then takes another in sorted order', async () => {
    await withSandbox(async ({ pools }) => {
      const writer = await pools.app.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '500ms'");
        // the writer already holds a late-sorted baseline key
        await lockConfigRows(writer, { keys: ['orders.write_enabled'] });
        const seeded = outcome(
          seedCheckout(pools.admin, { restoreConfig: true }),
        );
        await waitForWaiters(pools.admin);
        // the writer's vector continues with a key the seed would have locked
        // earlier in its (formerly unsorted) object order
        await lockConfigRows(writer, { keys: ['routing.inventory_source'] });
        await writer.query('COMMIT');
        const result = await seeded;
        expect(result.ok).toBe(true);
      } finally {
        writer.release();
      }
    });
  });

  it('inserts a missing baseline key under the collection lock taken first', async () => {
    await withSandbox(async ({ pools }) => {
      // a key vanished (injector delete scenario), then the seed is re-run
      await advanceConfigTx(pools.injector, {
        key: 'ui.banner_text',
        deleteKey: true,
        expectedVersion: 1,
        causedBy: { actor: 'injector' },
      });
      const writer = await pools.app.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '500ms'");
        await lockConfigRows(writer, { keys: [], collection: true });
        const seeded = outcome(seedCheckout(pools.admin));
        await waitForWaiters(pools.admin);
        // the seed must be queued on the collection, holding no member row yet
        await lockConfigRows(writer, {
          keys: ['cache.namespace', 'routing.inventory_source'],
        });
        await writer.query('COMMIT');
        const result = await seeded;
        expect(result.ok).toBe(true);
        expect(
          (result as { value: { configInserted: string[] } }).value
            .configInserted,
        ).toEqual(['ui.banner_text']);
      } finally {
        writer.release();
      }
    });
  });
});
