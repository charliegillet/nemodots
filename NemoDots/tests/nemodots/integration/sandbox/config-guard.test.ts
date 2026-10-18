// The database itself enforces what version-authority.ts promises about the
// version counter: a member's version only ever grows, by exactly one per value
// change, and a re-inserted key continues above its recorded history. Raw DML
// by any writer role cannot rewind it or change a value under the same version
// (findings C1/G3: a receipt at an old version must stop being current).
// Known limit, documented in 0004_checkout.ts: the existence of the matching
// config_versions row is NOT enforced by the database.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { advanceConfigTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withSandbox, type Sandbox } from './harness.js';

type Role = 'app' | 'injector' | 'admin';
const ROLES: Role[] = ['app', 'injector', 'admin'];

const row = async (s: Sandbox, key = 'db.pool_max') =>
  (
    await s.pools.verifier.query(
      'SELECT value, version FROM checkout.config_entries WHERE key = $1',
      [key],
    )
  ).rows[0];
const history = async (s: Sandbox, key = 'db.pool_max') =>
  (
    await s.pools.verifier.query(
      'SELECT version FROM checkout.config_versions WHERE key = $1 ORDER BY version',
      [key],
    )
  ).rows.map((r) => Number(r.version));

/** Runs statements in one transaction; returns the error message of the failing step or null. */
async function attempt(pool: pg.Pool, statements: string[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      for (const sql of statements) await client.query(sql);
      await client.query('COMMIT');
      return null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      return (error as Error).message;
    }
  } finally {
    client.release();
  }
}

describe.each(ROLES)('raw updates of config_entries as %s', (role) => {
  it('refuses a value change that does not advance the version', async () => {
    await withSandbox(async (s) => {
      const before = await row(s);
      const error = await attempt(s.pools[role], [
        "UPDATE checkout.config_entries SET value = '99'::jsonb WHERE key = 'db.pool_max'",
      ]);
      expect(error).toMatch(/version/);
      expect(await row(s)).toEqual(before);
    });
  });

  it('refuses a version rewind and a jump of more than one', async () => {
    await withSandbox(async (s) => {
      await advanceConfigTx(s.pools.injector, {
        key: 'db.pool_max',
        value: 3,
        expectedVersion: 1,
        causedBy: { actor: 'injector' },
      });
      expect(
        await attempt(s.pools[role], [
          "UPDATE checkout.config_entries SET version = 1 WHERE key = 'db.pool_max'",
        ]),
      ).toMatch(/version/);
      expect(
        await attempt(s.pools[role], [
          "UPDATE checkout.config_entries SET value = '5'::jsonb, version = 4 WHERE key = 'db.pool_max'",
        ]),
      ).toMatch(/version/);
      expect(await row(s)).toEqual({ value: 3, version: '2' });
      expect(await history(s)).toEqual([1, 2]);
    });
  });
});

describe('the guard does not get in the way of the protocol', () => {
  it('advanceConfig still works for every writer role', async () => {
    await withSandbox(async (s) => {
      let version = 1;
      for (const role of ['app', 'injector', 'admin'] as const) {
        const result = await advanceConfigTx(s.pools[role], {
          key: 'db.pool_max',
          value: 20 + version,
          expectedVersion: version,
          causedBy: { actor: role === 'app' ? 'owner' : 'injector' },
        });
        expect(result.versionAfter).toBe(version + 1);
        version += 1;
      }
      expect(await history(s)).toEqual([1, 2, 3, 4]);
    });
  });
});

describe('raw inserts of config_entries', () => {
  it('a re-insert must continue above the recorded history', async () => {
    await withSandbox(async (s) => {
      // delete through the authority: tombstone at version 2
      await advanceConfigTx(s.pools.injector, {
        key: 'ui.banner_text',
        deleteKey: true,
        expectedVersion: 1,
        causedBy: { actor: 'injector' },
      });
      expect(await row(s, 'ui.banner_text')).toBeUndefined();
      for (const role of ['injector', 'admin'] as const) {
        for (const version of [1, 2]) {
          const error = await attempt(s.pools[role], [
            `INSERT INTO checkout.config_entries (key, value, version, caused_by_actor)
             VALUES ('ui.banner_text', '"back"'::jsonb, ${version}, 'injector')`,
          ]);
          expect(error, `${role} v${version}`).toMatch(/version/);
        }
      }
      expect(await row(s, 'ui.banner_text')).toBeUndefined();
      // the authority re-inserts at 3
      const again = await advanceConfigTx(s.pools.injector, {
        key: 'ui.banner_text',
        value: 'back',
        expectedVersion: 0,
        insertIfMissing: true,
        causedBy: { actor: 'injector' },
      });
      expect(again.versionAfter).toBe(3);
      expect(await history(s, 'ui.banner_text')).toEqual([1, 2, 3]);
    });
  });
});
