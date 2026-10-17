// advanceConfig: the lock protocol of ARCHITECTURE.md section 5.1 against real
// PostgreSQL row locks.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  ConfigVersionError,
  advanceConfig,
  advanceConfigTx,
  advanceConfigUnconditionally,
  configValueDigest,
  lockConfigRows,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withTransaction } from '../../../../src/server/nemodots/db/tx.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import { withSandbox, type Pools } from './harness.js';

const versionOf = async (pool: pg.Pool, key: string) =>
  Number(
    (
      await pool.query(
        'SELECT version FROM checkout.config_entries WHERE key = $1',
        [key],
      )
    ).rows[0].version,
  );
const collectionVersion = async (pool: pg.Pool) =>
  Number(
    (await pool.query('SELECT version FROM checkout.config_collection')).rows[0]
      .version,
  );

/** Waits until some backend is blocked on a lock (the other transaction really is waiting). */
async function waitForLockWaiter(pool: pg.Pool) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // pg_locks is visible to every role; pg_stat_activity hides other roles' wait events
    const waiting = await pool.query(
      "SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')",
    );
    if (waiting.rows.length) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no backend ever waited for a lock');
}

const caused = { actor: 'owner' } as const;

describe('compare-and-set', () => {
  it('a wrong expectedVersion fails with stale_version and leaves the version, value and history unchanged', async () => {
    await withSandbox(async ({ pools }) => {
      const before = await versionOf(pools.app, 'db.pool_max');
      const error = await advanceConfigTx(pools.app, {
        key: 'db.pool_max',
        value: 4,
        expectedVersion: before + 5,
        causedBy: caused,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigVersionError);
      expect(error).toMatchObject({
        code: 'stale_version',
        currentVersion: before,
        expectedVersion: before + 5,
      });
      expect(await versionOf(pools.app, 'db.pool_max')).toBe(before);
      const row = await pools.app.query(
        "SELECT value FROM checkout.config_entries WHERE key = 'db.pool_max'",
      );
      expect(row.rows[0].value).toBe(10);
      const history = await pools.app.query(
        "SELECT count(*) AS n FROM checkout.config_versions WHERE key = 'db.pool_max'",
      );
      expect(history.rows[0].n).toBe('1');
    });
  });

  it('a successful update advances by one and records both digests', async () => {
    await withSandbox(async ({ pools }) => {
      const result = await advanceConfigTx(pools.app, {
        key: 'db.pool_max',
        value: 4,
        expectedVersion: 1,
        causedBy: caused,
      });
      expect(result).toMatchObject({
        key: 'db.pool_max',
        versionBefore: 1,
        versionAfter: 2,
        beforeDigest: configValueDigest(10),
        afterDigest: configValueDigest(4),
        membershipChanged: false,
        operation: 'update',
      });
      const history = await pools.app.query(
        "SELECT version, value, caused_by_actor FROM checkout.config_versions WHERE key = 'db.pool_max' ORDER BY version",
      );
      expect(history.rows).toEqual([
        { version: '1', value: 10, caused_by_actor: 'seed' },
        { version: '2', value: 4, caused_by_actor: 'owner' },
      ]);
    });
  });

  it('two concurrent advances of one key serialize: exactly one wins, the other gets stale_version', async () => {
    await withSandbox(async ({ pools }) => {
      const first = await pools.app.connect();
      const proceed = latch();
      try {
        await first.query('BEGIN');
        await advanceConfig(first, {
          key: 'db.pool_max',
          value: 3,
          expectedVersion: 1,
          causedBy: caused,
        });
        // the second writer read version 1 as well and now blocks on the row lock
        const second = advanceConfigTx(pools.injector, {
          key: 'db.pool_max',
          value: 5,
          expectedVersion: 1,
          causedBy: { actor: 'injector' },
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await waitForLockWaiter(pools.verifier);
        proceed.open();
        await first.query('COMMIT');
        const outcome = await second;
        expect(outcome.ok).toBe(false);
        expect((outcome as { error: ConfigVersionError }).error.code).toBe(
          'stale_version',
        );
      } finally {
        first.release();
      }
      expect(await versionOf(pools.app, 'db.pool_max')).toBe(2);
      const row = await pools.app.query(
        "SELECT value FROM checkout.config_entries WHERE key = 'db.pool_max'",
      );
      expect(row.rows[0].value).toBe(3);
    });
  });

  it('rejects malformed input before touching the database', async () => {
    await withSandbox(async ({ pools }) => {
      const run = (input: Parameters<typeof advanceConfigTx>[1]) =>
        advanceConfigTx(pools.app, input).catch(
          (e: unknown) => e as ConfigVersionError,
        );
      expect(
        (
          await run({
            key: 'Bad Key',
            value: 1,
            expectedVersion: 1,
            causedBy: caused,
          })
        ).code,
      ).toBe('invalid_key');
      expect(
        (
          await run({
            key: 'db.pool_max',
            value: 1,
            expectedVersion: -1,
            causedBy: caused,
          })
        ).code,
      ).toBe('invalid_input');
      expect(
        (
          await run({
            key: 'db.pool_max',
            value: { nested: true } as unknown as number,
            expectedVersion: 1,
            causedBy: caused,
          })
        ).code,
      ).toBe('invalid_input');
      expect(
        (
          await run({
            key: 'db.pool_max',
            value: 1,
            expectedVersion: 1,
            deleteKey: true,
            causedBy: caused,
          })
        ).code,
      ).toBe('invalid_input');
      expect(
        (
          await run({
            key: 'missing.key',
            value: 1,
            expectedVersion: 1,
            causedBy: caused,
          })
        ).code,
      ).toBe('missing_key');
      expect(await versionOf(pools.app, 'db.pool_max')).toBe(1);
    });
  });
});

describe('collection version is membership-only (C1)', () => {
  it('a value update does not bump config_collection.version; insert and delete do', async () => {
    await withSandbox(async ({ pools }) => {
      const base = await collectionVersion(pools.app);
      // 7 baseline keys were inserted by the seed on top of the initial row
      expect(base).toBe(8);
      await advanceConfigTx(pools.injector, {
        key: 'ui.banner_text',
        value: 'x',
        expectedVersion: 1,
        causedBy: { actor: 'injector' },
      });
      await advanceConfigTx(pools.app, {
        key: 'db.pool_max',
        value: 6,
        expectedVersion: 1,
        causedBy: caused,
      });
      expect(await collectionVersion(pools.app)).toBe(base);

      const inserted = await advanceConfigTx(pools.injector, {
        key: 'experiment.flag',
        value: true,
        expectedVersion: 0,
        insertIfMissing: true,
        causedBy: { actor: 'injector' },
      });
      expect(inserted).toMatchObject({
        operation: 'insert',
        versionBefore: 0,
        versionAfter: 1,
        beforeDigest: null,
        membershipChanged: true,
        collectionVersion: base + 1,
      });
      expect(await collectionVersion(pools.app)).toBe(base + 1);

      const deleted = await advanceConfigTx(pools.injector, {
        key: 'experiment.flag',
        expectedVersion: 1,
        deleteKey: true,
        causedBy: { actor: 'injector' },
      });
      expect(deleted).toMatchObject({
        operation: 'delete',
        versionAfter: 2,
        afterDigest: null,
        membershipChanged: true,
        collectionVersion: base + 2,
      });
      expect(await collectionVersion(pools.app)).toBe(base + 2);
      const gone = await pools.app.query(
        "SELECT 1 FROM checkout.config_entries WHERE key = 'experiment.flag'",
      );
      expect(gone.rows).toHaveLength(0);

      // a re-insert continues the key's version line instead of restarting at 1
      const again = await advanceConfigTx(pools.injector, {
        key: 'experiment.flag',
        value: false,
        expectedVersion: 0,
        insertIfMissing: true,
        causedBy: { actor: 'injector' },
      });
      expect(again.versionAfter).toBe(3);

      // a stale insert (key exists) does not bump the collection
      const duplicate = await advanceConfigTx(pools.injector, {
        key: 'experiment.flag',
        value: true,
        expectedVersion: 0,
        insertIfMissing: true,
        causedBy: { actor: 'injector' },
      }).catch((e: unknown) => e as ConfigVersionError);
      expect(duplicate.code).toBe('stale_version');
      expect(await collectionVersion(pools.app)).toBe(base + 3);
    });
  });

  it('concurrent writes on two different keys do not block each other, nor does an insert block a value update', async () => {
    await withSandbox(async ({ pools }) => {
      const holder = await pools.app.connect();
      try {
        // A: updates key one and stays open (holds its row lock)
        await holder.query('BEGIN');
        await advanceConfig(holder, {
          key: 'db.pool_max',
          value: 6,
          expectedVersion: 1,
          causedBy: caused,
        });
        // B: a different key commits while A is open
        const b = await withTimeout(
          advanceConfigTx(pools.injector, {
            key: 'ui.banner_text',
            value: 'other',
            expectedVersion: 1,
            causedBy: { actor: 'injector' },
          }),
          3_000,
          'update of a different key must not wait for the open transaction',
        );
        expect(b.versionAfter).toBe(2);
        await holder.query('COMMIT');
      } finally {
        holder.release();
      }

      const inserter = await pools.injector.connect();
      try {
        // C: an insert holds the collection row lock and stays open
        await inserter.query('BEGIN');
        await advanceConfig(inserter, {
          key: 'new.key',
          value: 1,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
        // D: a value update of an existing key does not need the collection row
        const d = await withTimeout(
          advanceConfigTx(pools.app, {
            key: 'cache.namespace',
            value: 'catalog-b',
            expectedVersion: 1,
            causedBy: caused,
          }),
          3_000,
          'a value update must not wait for the collection lock',
        );
        expect(d.versionAfter).toBe(2);
        await inserter.query('COMMIT');
      } finally {
        inserter.release();
      }
    });
  });

  it('two inserts of different keys serialize on the collection row and both succeed', async () => {
    await withSandbox(async ({ pools }) => {
      const first = await pools.injector.connect();
      try {
        await first.query('BEGIN');
        await advanceConfig(first, {
          key: 'k.one',
          value: 1,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
        const second = advanceConfigTx(pools.injector, {
          key: 'k.two',
          value: 2,
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
        await waitForLockWaiter(pools.verifier);
        await first.query('COMMIT');
        const result = await second;
        expect(result.collectionVersion).toBe(10);
      } finally {
        first.release();
      }
      expect(await collectionVersion(pools.app)).toBe(10);
    });
  });
});

describe('caused_by_action_id is server-authored (I14)', () => {
  const actionId = randomUUID();
  const write = (pool: pg.Pool, key: string, expected: number) =>
    advanceConfigTx(pool, {
      key,
      value: expected + 100,
      expectedVersion: expected,
      causedBy: { actor: 'owner', actionId },
    });

  it('the trigger nulls the marker for injector and admin and keeps it for the app role', async () => {
    await withSandbox(async ({ pools }) => {
      const head = async (key: string) =>
        (
          await pools.verifier.query(
            'SELECT caused_by_action_id AS a FROM checkout.config_entries WHERE key = $1',
            [key],
          )
        ).rows[0].a as string | null;
      const history = async (key: string, version: number) =>
        (
          await pools.verifier.query(
            'SELECT caused_by_action_id AS a FROM checkout.config_versions WHERE key = $1 AND version = $2',
            [key, version],
          )
        ).rows[0].a as string | null;
      await write(pools.injector, 'db.pool_max', 1);
      expect(await head('db.pool_max')).toBeNull();
      expect(await history('db.pool_max', 2)).toBeNull();
      await write(pools.admin, 'db.statement_timeout_ms', 1);
      expect(await head('db.statement_timeout_ms')).toBeNull();
      expect(await history('db.statement_timeout_ms', 2)).toBeNull();
      await write(pools.app, 'ui.banner_text', 1).catch(() => {});
      // (banner is a string: use a numeric key for the app role)
      await advanceConfigTx(pools.app, {
        key: 'cache.schema_version',
        value: 2,
        expectedVersion: 1,
        causedBy: { actor: 'action', actionId },
      });
      expect(await head('cache.schema_version')).toBe(actionId);
      expect(await history('cache.schema_version', 2)).toBe(actionId);
      // a later write by another role clears the marker again (last writer wins)
      await advanceConfigTx(pools.injector, {
        key: 'cache.schema_version',
        value: 3,
        expectedVersion: 2,
        causedBy: { actor: 'injector', actionId },
      });
      expect(await head('cache.schema_version')).toBeNull();
    });
  });
});

describe('notification and lock helper', () => {
  it('emits nemodots_source_changed on commit with the source key and version, no value or actor', async () => {
    await withSandbox(async ({ pools, db }) => {
      const listener = new pg.Client({ connectionString: db.urls.app });
      await listener.connect();
      const payloads: string[] = [];
      listener.on('notification', (m) => {
        if (m.channel === 'nemodots_source_changed')
          payloads.push(m.payload ?? '');
      });
      await listener.query('LISTEN nemodots_source_changed');
      try {
        await advanceConfigTx(pools.injector, {
          key: 'db.pool_max',
          value: 7,
          expectedVersion: 1,
          causedBy: { actor: 'injector' },
        });
        await advanceConfigTx(pools.injector, {
          key: 'brand.new',
          value: 'secret-value',
          expectedVersion: 0,
          insertIfMissing: true,
          causedBy: { actor: 'injector' },
        });
        const deadline = Date.now() + 3_000;
        while (payloads.length < 2 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        expect(payloads.map((p) => JSON.parse(p))).toEqual([
          {
            key: 'checkout.config/db.pool_max',
            version: 2,
            membershipChanged: false,
            collectionVersion: null,
          },
          {
            key: 'checkout.config/brand.new',
            version: 1,
            membershipChanged: true,
            collectionVersion: 9,
          },
        ]);
        expect(payloads.join('')).not.toMatch(/secret-value|injector/);
      } finally {
        await listener.end();
      }
    });
  });

  it('a rolled-back advance emits nothing and changes nothing', async () => {
    await withSandbox(async ({ pools, db }) => {
      const listener = new pg.Client({ connectionString: db.urls.app });
      await listener.connect();
      let received = 0;
      listener.on('notification', () => {
        received += 1;
      });
      await listener.query('LISTEN nemodots_source_changed');
      try {
        await expect(
          withTransaction(pools.app, async (client) => {
            await advanceConfig(client, {
              key: 'db.pool_max',
              value: 9,
              expectedVersion: 1,
              causedBy: caused,
            });
            throw new Error('abort');
          }),
        ).rejects.toThrow('abort');
        await new Promise((r) => setTimeout(r, 200));
        expect(received).toBe(0);
        expect(await versionOf(pools.app, 'db.pool_max')).toBe(1);
      } finally {
        await listener.end();
      }
    });
  });

  it('lockConfigRows locks the collection first and returns member versions in key order', async () => {
    await withSandbox(async ({ pools }: { pools: Pools }) => {
      await withTransaction(pools.app, async (client) => {
        const locked = await lockConfigRows(client, {
          keys: [
            'routing.inventory_source',
            'cache.namespace',
            'cache.namespace',
            'absent.key',
          ],
          collection: true,
        });
        expect(locked.collectionVersion).toBe(8);
        expect([...locked.versions.entries()]).toEqual([
          ['cache.namespace', 1],
          ['routing.inventory_source', 1],
        ]);
        // re-entrant: advancing a row this transaction already locked cannot deadlock
        const result = await advanceConfig(client, {
          key: 'cache.namespace',
          value: 'catalog-c',
          expectedVersion: 1,
          causedBy: caused,
        });
        expect(result.versionAfter).toBe(2);
      });
    });
  });

  it('advanceConfigUnconditionally reads the version under lock (injector/seed)', async () => {
    await withSandbox(async ({ pools }) => {
      await advanceConfigTx(pools.app, {
        key: 'db.pool_max',
        value: 2,
        expectedVersion: 1,
        causedBy: caused,
      });
      const result = await withTransaction(pools.injector, (client) =>
        advanceConfigUnconditionally(client, {
          key: 'db.pool_max',
          value: 3,
          causedBy: { actor: 'injector' },
        }),
      );
      expect(result).toMatchObject({ versionBefore: 2, versionAfter: 3 });
    });
  });
});
