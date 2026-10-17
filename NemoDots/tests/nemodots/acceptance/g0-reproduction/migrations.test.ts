// Gate 0 item 4 (migrations half):
//   G0.4a migrations from empty storage, idempotent re-run, concurrent runners
//   G0.4b a supported upgrade path that preserves existing rows
//   G0.4c least-privilege roles after migration
// Database: acc0_<hex> on the NemoDots PostgreSQL (55432), dropped afterwards.
// Expected behaviour comes from STACK.md and ARCHITECTURE.md, not from the
// migration code. The runner is driven through its documented entry points
// (the `migrate` function and the `nemodots:migrate` CLI).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createAccDb, query, type AccDb } from './helpers/acc-db.js';
import {
  APP_ROOT,
  SCRATCH,
  cleanEnv,
  ensureScratch,
  makeRedactor,
  run,
} from './helpers/common.js';

const MIGRATE_MODULE = path.join(APP_ROOT, 'src/server/nemodots/db/migrate.ts');
const MIGRATIONS_DIR = path.join(APP_ROOT, 'src/server/nemodots/db/migrations');
const SCHEMAS = ['ledger', 'coordinator', 'checkout', 'control'];

interface MigrateModule {
  migrate(o: {
    connectionString: string;
    check?: boolean;
    dir?: string;
  }): Promise<{
    applied: string[];
    pending: string[];
    unknown: string[];
    alreadyApplied: number;
  }>;
}
const loadMigrate = async () =>
  (await import(/* @vite-ignore */ MIGRATE_MODULE)) as MigrateModule;

const dbs: AccDb[] = [];
afterAll(async () => {
  for (const db of dbs) await db.drop().catch(() => undefined);
  rmSync(path.join(SCRATCH, 'upgrade-dirs'), { recursive: true, force: true });
});

const migrationIds = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();

describe('G0.4a migrations from empty storage', () => {
  it('[G0.4] CLI: `migrate --check` on empty storage reports pending, then migrate applies all, then --check is clean', async () => {
    const db = await createAccDb();
    dbs.push(db);
    const env = cleanEnv({ NEMODOTS_PG_URL_ADMIN: db.urls.admin });
    const redact = makeRedactor([new URL(db.urls.admin).password]);
    const cli = (args: string[], name: string) =>
      run('node', ['--import', 'tsx', MIGRATE_MODULE, ...args], {
        cwd: APP_ROOT,
        env,
        logName: `g0-migrate-cli-${name}.log`,
        timeoutMs: 120_000,
        redact,
      });
    const before = await cli(['--check'], 'check-empty');
    expect(
      before.code,
      `--check on empty storage must exit 1: ${before.tail}`,
    ).toBe(1);
    expect(before.tail).toMatch(/pending/);
    const apply = await cli([], 'apply');
    expect(apply.code, apply.tail).toBe(0);
    const after = await cli(['--check'], 'check-after');
    expect(after.code, after.tail).toBe(0);
    expect(after.tail).toMatch(/up to date/);
    const rows = await query<{ id: string }>(
      db.urls.verifier,
      'SELECT id FROM public.schema_migrations ORDER BY id',
    ).catch(async () =>
      query<{ id: string }>(
        db.urls.admin,
        'SELECT id FROM public.schema_migrations ORDER BY id',
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(migrationIds());
  }, 300_000);

  it('[G0.4] function: re-running is a no-op that keeps applied_at, and objects the migrations own exist', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    const first = await migrate({ connectionString: db.urls.admin });
    expect(first.applied).toEqual(migrationIds());
    const stamps = await query<{ id: string; applied_at: Date }>(
      db.urls.admin,
      'SELECT id, applied_at FROM public.schema_migrations ORDER BY id',
    );
    const second = await migrate({ connectionString: db.urls.admin });
    expect(second.applied).toEqual([]);
    expect(second.pending).toEqual([]);
    const stampsAfter = await query<{ id: string; applied_at: Date }>(
      db.urls.admin,
      'SELECT id, applied_at FROM public.schema_migrations ORDER BY id',
    );
    expect(stampsAfter).toEqual(stamps);
    // STACK.md: four schemas owned by nemodots_admin.
    const schemas = await query<{ schema_name: string; schema_owner: string }>(
      db.urls.verifier,
      `SELECT schema_name, schema_owner FROM information_schema.schemata
        WHERE schema_name = ANY($1) ORDER BY schema_name`,
      [SCHEMAS],
    );
    expect(schemas.map((s) => s.schema_name)).toEqual([...SCHEMAS].sort());
    for (const s of schemas) expect(s.schema_owner).toBe('nemodots_admin');
  }, 300_000);

  it('[G0.4] two concurrent runners on one empty database apply each migration exactly once', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    const [a, b] = await Promise.all([
      migrate({ connectionString: db.urls.admin }),
      migrate({ connectionString: db.urls.admin }),
    ]);
    const applied = [...a.applied, ...b.applied].sort();
    expect(applied).toEqual(migrationIds());
    const count = await query<{ n: string }>(
      db.urls.admin,
      'SELECT count(*)::text AS n FROM public.schema_migrations',
    );
    expect(Number(count[0].n)).toBe(migrationIds().length);
  }, 300_000);

  it('[G0.4] a database recording an unknown migration is refused and left unmodified', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    await migrate({ connectionString: db.urls.admin });
    await query(
      db.urls.admin,
      "INSERT INTO public.schema_migrations (id) VALUES ('9999_from_the_future')",
    );
    const check = await migrate({
      connectionString: db.urls.admin,
      check: true,
    });
    expect(check.unknown).toEqual(['9999_from_the_future']);
    await expect(migrate({ connectionString: db.urls.admin })).rejects.toThrow(
      /does not know/,
    );
    const rows = await query<{ id: string }>(
      db.urls.admin,
      'SELECT id FROM public.schema_migrations ORDER BY id',
    );
    expect(rows.map((r) => r.id)).toEqual(
      [...migrationIds(), '9999_from_the_future'].sort(),
    );
  }, 300_000);

  it('[G0.4] migrations refuse to run as a role other than nemodots_admin', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    await expect(migrate({ connectionString: db.urls.app })).rejects.toThrow(
      /nemodots_admin/,
    );
  }, 120_000);
});

// ---------------------------------------------------------------- upgrade

type Row = Record<string, unknown>;
const SEED_SCHEMAS = ['ledger', 'coordinator', 'checkout', 'control'];

async function listTables(client: pg.Client) {
  const { rows } = await client.query<{ s: string; t: string }>(
    `SELECT schemaname AS s, tablename AS t FROM pg_tables
      WHERE schemaname = ANY($1) ORDER BY 1, 2`,
    [SEED_SCHEMAS],
  );
  return rows.map((r) => `${r.s}.${r.t}`);
}

async function snapshot(client: pg.Client, tables: string[]) {
  const out: Record<string, Row[]> = {};
  for (const table of tables) {
    const { rows } = await client.query<{ j: Row }>(
      `SELECT to_jsonb(x) AS j FROM ${table} x`,
    );
    out[table] = rows.map((r) => r.j);
  }
  return out;
}

/** Generic sentinel insert: fills only NOT NULL columns without a default. */
async function seedTable(client: pg.Client, qualified: string, n: number) {
  const [schema, table] = qualified.split('.');
  const cols = (
    await client.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
      is_generated: string;
    }>(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity, is_generated
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table],
    )
  ).rows;
  const names: string[] = [];
  const values: unknown[] = [];
  for (const c of cols) {
    if (
      c.is_nullable === 'YES' ||
      c.column_default ||
      c.is_identity === 'YES' ||
      c.is_generated !== 'NEVER'
    )
      continue;
    let v: unknown;
    switch (c.data_type) {
      case 'text':
      case 'character varying':
      case 'character':
        v = `acc0-seed-${table}-${c.column_name}-${n}`;
        break;
      case 'uuid':
        v = crypto.randomUUID();
        break;
      case 'integer':
      case 'bigint':
      case 'smallint':
      case 'numeric':
      case 'real':
      case 'double precision':
        v = n;
        break;
      case 'boolean':
        v = false;
        break;
      case 'jsonb':
      case 'json':
        v = '{}';
        break;
      case 'bytea':
        v = Buffer.from('acc0');
        break;
      case 'timestamp with time zone':
      case 'timestamp without time zone':
        v = new Date('2026-10-17T00:00:00Z');
        break;
      case 'USER-DEFINED': {
        const e = await client.query<{ enumlabel: string }>(
          `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY enumsortorder LIMIT 1`,
          [c.udt_name],
        );
        v = e.rows[0]?.enumlabel ?? null;
        break;
      }
      case 'ARRAY':
        v = '{}';
        break;
      default:
        v = null;
    }
    names.push(`"${c.column_name}"`);
    values.push(v);
  }
  const sql = names.length
    ? `INSERT INTO ${qualified} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`
    : `INSERT INTO ${qualified} DEFAULT VALUES`;
  await client.query('BEGIN');
  try {
    await client.query(sql, values);
    await client.query('COMMIT');
    return true;
  } catch {
    await client.query('ROLLBACK');
    return false;
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

describe('G0.4b supported upgrade path preserves existing data', () => {
  it('[G0.4] applying migrations one at a time never drops or rewrites rows written by earlier ones', async () => {
    const { migrate } = await loadMigrate();
    const ids = migrationIds();
    expect(
      ids.length,
      'fewer than two migrations: no upgrade path exists to test yet',
    ).toBeGreaterThanOrEqual(2);
    const db = await createAccDb();
    dbs.push(db);
    const root = path.join(ensureScratch('upgrade-dirs'), db.name);
    mkdirSync(root, { recursive: true });
    const seeded = new Set<string>();
    let preservedRowChecks = 0;
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      for (let k = 0; k < ids.length; k += 1) {
        // Directory holding the first k+1 migrations as symlinks, so their
        // relative imports resolve against the real source tree.
        const dir = path.join(root, `upto-${k + 1}`);
        mkdirSync(dir, { recursive: true });
        for (const id of ids.slice(0, k + 1)) {
          const target = path.join(MIGRATIONS_DIR, `${id}.ts`);
          const link = path.join(dir, `${id}.ts`);
          if (!existsSync(link)) symlinkSync(target, link);
        }
        const before = await snapshot(admin, await listTables(admin));
        const stampsBefore = (
          await admin
            .query<{ id: string; applied_at: Date }>(
              'SELECT id, applied_at FROM public.schema_migrations ORDER BY id',
            )
            .catch(() => ({ rows: [] }))
        ).rows;
        const result = await migrate({ connectionString: db.urls.admin, dir });
        expect(result.applied, `step ${k + 1}`).toEqual([ids[k]]);
        const after = await snapshot(admin, await listTables(admin));
        for (const [table, rowsBefore] of Object.entries(before)) {
          expect(
            after[table],
            `table ${table} vanished at ${ids[k]}`,
          ).toBeDefined();
          for (const old of rowsBefore) {
            const match = after[table].some((now) =>
              Object.entries(old).every(([key, value]) =>
                same(now[key], value),
              ),
            );
            expect(
              match,
              `row of ${table} lost or rewritten by ${ids[k]}`,
            ).toBe(true);
            preservedRowChecks += 1;
          }
        }
        const stampsAfter = (
          await admin.query<{ id: string; applied_at: Date }>(
            'SELECT id, applied_at FROM public.schema_migrations ORDER BY id',
          )
        ).rows;
        for (const s of stampsBefore)
          expect(stampsAfter.find((x) => x.id === s.id)?.applied_at).toEqual(
            s.applied_at,
          );
        // Seed sentinel rows into every table that exists now and has none.
        for (const table of await listTables(admin)) {
          if (seeded.has(table)) continue;
          for (let pass = 0; pass < 3; pass += 1)
            if (await seedTable(admin, table, k + 1)) {
              seeded.add(table);
              break;
            }
        }
      }
    } finally {
      await admin.end();
    }
    expect(
      seeded.size,
      'no table could be seeded generically (FK/CHECK constraints?); extend the sentinel seeder',
    ).toBeGreaterThan(0);
    expect(
      preservedRowChecks,
      'upgrade path preserved no pre-existing rows',
    ).toBeGreaterThan(0);
    // Final state equals a from-scratch migration at the table level.
    const fresh = await createAccDb();
    dbs.push(fresh);
    await migrate({ connectionString: fresh.urls.admin });
    const a = new pg.Client({ connectionString: db.urls.admin });
    const b = new pg.Client({ connectionString: fresh.urls.admin });
    await Promise.all([a.connect(), b.connect()]);
    try {
      const cols = (c: pg.Client) =>
        c
          .query(
            `SELECT table_schema, table_name, column_name, data_type, is_nullable
               FROM information_schema.columns WHERE table_schema = ANY($1)
              ORDER BY 1, 2, column_name`,
            [SEED_SCHEMAS],
          )
          .then((r) => r.rows);
      expect(await cols(a)).toEqual(await cols(b));
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  }, 600_000);
});

describe('G0.4c least-privilege roles after migration', () => {
  it('[G0.4] every role connects; verifier cannot write; app cannot touch control or write checkout beyond the documented grants', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    await migrate({ connectionString: db.urls.admin });
    for (const role of ['app', 'checkout', 'injector', 'verifier'] as const) {
      const who = await query<{ u: string }>(
        db.urls[role],
        'SELECT current_user AS u',
      );
      expect(who[0].u).toBe(`nemodots_${role}`);
    }
    const tables = await query<{ s: string; t: string }>(
      db.urls.admin,
      `SELECT schemaname AS s, tablename AS t FROM pg_tables WHERE schemaname = ANY($1)`,
      [SCHEMAS],
    );
    const priv = async (role: string, table: string, p: string) =>
      (
        await query<{ ok: boolean }>(
          db.urls.admin,
          'SELECT has_table_privilege($1, $2, $3) AS ok',
          [role, table, p],
        )
      )[0].ok;
    const violations: string[] = [];
    for (const { s, t } of tables) {
      const q = `${s}.${t}`;
      for (const p of ['INSERT', 'UPDATE', 'DELETE'])
        if (await priv('nemodots_verifier', q, p))
          violations.push(`verifier ${p} ${q}`);
      if (s === 'control' && (await priv('nemodots_app', q, 'SELECT')))
        violations.push(`app SELECT ${q}`);
      if (s === 'control' && (await priv('nemodots_checkout', q, 'SELECT')))
        violations.push(`checkout SELECT ${q}`);
      if (s === 'ledger' || s === 'coordinator') {
        if (await priv('nemodots_injector', q, 'SELECT'))
          violations.push(`injector SELECT ${q}`);
        if (await priv('nemodots_checkout', q, 'SELECT'))
          violations.push(`checkout SELECT ${q}`);
      }
      if (s === 'checkout') {
        // STACK.md: app only gets UPDATE on config_entries/config_collection
        // and INSERT on config_versions; no DELETE anywhere.
        if (await priv('nemodots_app', q, 'DELETE'))
          violations.push(`app DELETE ${q}`);
        const appUpdate = ['config_entries', 'config_collection'].includes(t);
        if (!appUpdate && (await priv('nemodots_app', q, 'UPDATE')))
          violations.push(`app UPDATE ${q}`);
        const appInsert = t === 'config_versions';
        if (!appInsert && (await priv('nemodots_app', q, 'INSERT')))
          violations.push(`app INSERT ${q}`);
      }
    }
    expect(
      violations,
      `privilege violations: ${violations.join('; ')}`,
    ).toEqual([]);
    // PUBLIC has no CONNECT on the database (STACK.md).
    const pub = await query<{ granted: boolean }>(
      db.urls.admin,
      `SELECT (d.datacl IS NULL OR EXISTS (
                SELECT 1 FROM aclexplode(d.datacl) a
                 WHERE a.grantee = 0 AND a.privilege_type = 'CONNECT')) AS granted
         FROM pg_database d WHERE d.datname = $1`,
      [db.name],
    );
    expect(pub[0].granted, 'PUBLIC must not hold CONNECT on the database').toBe(
      false,
    );
  }, 300_000);
});
