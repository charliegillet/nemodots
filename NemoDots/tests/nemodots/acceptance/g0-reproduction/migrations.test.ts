// Gate 0 item 4 (migrations half):
//   G0.4a migrations from empty storage, idempotent re-run, concurrent runners
//   G0.4b a supported upgrade path that preserves existing rows (hand-written
//         sentinel fixtures for every table, structure compared with a fresh DB)
//   G0.4c least-privilege roles after migration (exact privilege matrix)
// Database: acc0_<hex> on the NemoDots PostgreSQL (55432), dropped afterwards.
// Expected behaviour comes from STACK.md, ARCHITECTURE.md and CONTRACTS.md,
// not from the migration code. The runner is driven through its documented
// entry points (the `migrate` function and the `nemodots:migrate` CLI).
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createAccDb, query, type AccDb } from './helpers/acc-db.js';
import {
  APP_ROOT,
  SCRATCH,
  appendManifest,
  cleanEnv,
  ensureScratch,
  makeRedactor,
  run,
  sha256,
  sleep,
} from './helpers/common.js';
import { SCHEMA_NAMES, diffPrivilegeMatrix } from './helpers/grant-matrix.js';

const MIGRATE_MODULE = path.join(APP_ROOT, 'src/server/nemodots/db/migrate.ts');
const MIGRATIONS_DIR = path.join(APP_ROOT, 'src/server/nemodots/db/migrations');
const CHILD = path.join(
  APP_ROOT,
  'tests/nemodots/acceptance/g0-reproduction/helpers/migrate-barrier-child.ts',
);
const FIXTURE_FILE = path.join(
  APP_ROOT,
  'tests/nemodots/acceptance/g0-reproduction/fixtures/upgrade-fixtures.json',
);
// Self-freeze of the hand-written fixtures (this file is not part of
// oracle/MANIFEST.sha256). A change needs a reviewed revision of this pin.
const FIXTURE_SHA256 =
  'b3ad6b5798a974554e060eee886a10f60c5d64a1d1f85578a26a411eb26e3ffd';
const SCHEMAS: readonly string[] = SCHEMA_NAMES;

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
  rmSync(path.join(SCRATCH, 'barrier'), { recursive: true, force: true });
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
      db.urls.admin,
      'SELECT id FROM public.schema_migrations ORDER BY id',
    );
    expect(rows.map((r) => r.id)).toEqual(migrationIds());
  }, 300_000);

  it('[G0.4] function: re-running is a no-op that keeps applied_at, and the four schemas are owned by nemodots_admin', async () => {
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
    const schemas = await query<{ schema_name: string; schema_owner: string }>(
      db.urls.verifier,
      `SELECT schema_name, schema_owner FROM information_schema.schemata
        WHERE schema_name = ANY($1) ORDER BY schema_name`,
      [SCHEMAS],
    );
    expect(schemas.map((s) => s.schema_name)).toEqual([...SCHEMAS].sort());
    for (const s of schemas) expect(s.schema_owner).toBe('nemodots_admin');
  }, 300_000);

  it('[G0.4] two runner PROCESSES, released together after both are connected, apply each migration exactly once (5 repetitions)', async () => {
    const REPS = 5;
    let overlapSeen = 0;
    const perRep: { applied: [number, number]; overlap: boolean }[] = [];
    for (let rep = 0; rep < REPS; rep += 1) {
      const db = await createAccDb();
      dbs.push(db);
      const barrier = path.join(ensureScratch('barrier'), db.name);
      mkdirSync(barrier, { recursive: true });
      const redact = makeRedactor([new URL(db.urls.admin).password]);
      const children = ['a', 'b'].map((id) => {
        const child = spawn(
          'node',
          ['--import', 'tsx', CHILD, MIGRATE_MODULE, barrier, id],
          {
            cwd: APP_ROOT,
            env: cleanEnv({ NEMODOTS_PG_URL_ADMIN: db.urls.admin }),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        const done = new Promise<void>((resolve) =>
          child.on('close', () => resolve()),
        );
        return { id, child, done, out: () => out, err: () => err };
      });
      try {
        // Wait until both runners announced readiness AND PostgreSQL shows
        // both sessions: neither can have read schema_migrations yet.
        const deadline = Date.now() + 90_000;
        let connected = 0;
        while (Date.now() < deadline) {
          const ready = ['a', 'b'].filter((id) =>
            existsSync(path.join(barrier, `ready-${id}`)),
          ).length;
          const rows = await query<{ n: string }>(
            db.urls.admin,
            `SELECT count(*)::text AS n FROM pg_stat_activity
              WHERE datname = $1 AND application_name LIKE 'acc0-barrier-%'`,
            [db.name],
          );
          connected = Number(rows[0].n);
          if (ready === 2 && connected === 2) break;
          await sleep(20);
        }
        expect(
          connected,
          `rep ${rep}: both runner sessions must be connected before release; ${redact(children.map((c) => c.err()).join('')).slice(-300)}`,
        ).toBe(2);
        const preTables = await query<{ n: string }>(
          db.urls.admin,
          "SELECT count(*)::text AS n FROM pg_tables WHERE schemaname IN ('ledger','coordinator','checkout','control','public')",
        );
        expect(
          Number(preTables[0].n),
          `rep ${rep}: nothing may be applied before release`,
        ).toBe(0);
        writeFileSync(path.join(barrier, 'go'), 'go');
        let overlap = false;
        let finished = false;
        void Promise.all(children.map((c) => c.done)).then(
          () => (finished = true),
        );
        while (!finished) {
          const rows = await query<{ n: string }>(
            db.urls.admin,
            `SELECT count(*)::text AS n FROM pg_stat_activity
              WHERE datname = $1 AND application_name = 'nemodots-migrate'`,
            [db.name],
          ).catch(() => [{ n: '0' }]);
          if (Number(rows[0].n) >= 2) overlap = true;
          await sleep(5);
        }
        const outcomes = children.map((c) => {
          const line = redact(c.out()).trim().split('\n').pop() ?? '';
          let parsed: { ok?: boolean; applied?: string[]; error?: string } = {};
          try {
            parsed = JSON.parse(line);
          } catch {
            /* reported below */
          }
          return { id: c.id, parsed, err: redact(c.err()).slice(-500) };
        });
        for (const o of outcomes)
          expect(
            o.parsed.ok,
            `rep ${rep} runner ${o.id}: ${o.parsed.error ?? o.err ?? 'no output'}`,
          ).toBe(true);
        const applied = outcomes.flatMap((o) => o.parsed.applied ?? []).sort();
        expect(
          applied,
          `rep ${rep}: every migration applied exactly once across both runners`,
        ).toEqual(migrationIds());
        const count = await query<{ n: string }>(
          db.urls.admin,
          'SELECT count(*)::text AS n FROM public.schema_migrations',
        );
        expect(Number(count[0].n)).toBe(migrationIds().length);
        if (overlap) overlapSeen += 1;
        perRep.push({
          applied: [
            outcomes[0].parsed.applied?.length ?? 0,
            outcomes[1].parsed.applied?.length ?? 0,
          ],
          overlap,
        });
      } finally {
        for (const c of children) if (c.child.exitCode === null) c.child.kill();
      }
    }
    appendManifest({
      gate: 0,
      step: 'concurrent-runners',
      repetitions: REPS,
      overlapObservedIn: overlapSeen,
      perRep,
    });
    expect(
      overlapSeen,
      'the two runners were never seen running at the same time; the test would not detect a missing lock',
    ).toBeGreaterThanOrEqual(1);
  }, 900_000);

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

interface FixtureRow {
  table: string;
  op?: 'insert' | 'update';
  where?: Record<string, unknown>;
  values: Record<string, unknown>;
}
interface FixtureGroup {
  creates: string[];
  reason?: string;
  rows?: FixtureRow[];
}
interface Fixtures {
  version: string;
  groups: Record<string, FixtureGroup>;
  exceptions: Record<string, string>;
}

const loadFixtures = () =>
  JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Fixtures;

async function listTables(client: pg.Client) {
  const { rows } = await client.query<{ s: string; t: string }>(
    `SELECT schemaname AS s, tablename AS t FROM pg_tables
      WHERE schemaname = ANY($1) ORDER BY 1, 2`,
    [SCHEMAS],
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

const pgArrayLiteral = (items: unknown[]) =>
  `{${items
    .map((item) =>
      item === null
        ? 'NULL'
        : `"${String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    )
    .join(',')}}`;

function encode(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'object' && '$jsonb' in (value as object))
    return JSON.stringify((value as { $jsonb: unknown }).$jsonb);
  if (Array.isArray(value)) return pgArrayLiteral(value);
  return value;
}

async function columnTypes(client: pg.Client, table: string) {
  const { rows } = await client.query<{ name: string; type: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    [table],
  );
  return new Map(rows.map((r) => [r.name, r.type]));
}

async function applyFixtureRows(client: pg.Client, rows: FixtureRow[]) {
  await client.query('BEGIN');
  try {
    for (const row of rows) {
      const types = await columnTypes(client, row.table);
      const cols = Object.keys(row.values);
      for (const col of [...cols, ...Object.keys(row.where ?? {})])
        if (!types.has(col))
          throw new Error(`fixture column ${row.table}.${col} does not exist`);
      if ((row.op ?? 'insert') === 'update') {
        const params: unknown[] = [];
        const sets = cols.map((c) => {
          params.push(encode(row.values[c]));
          return `"${c}" = $${params.length}::${types.get(c)}`;
        });
        const wheres = Object.keys(row.where ?? {}).map((c) => {
          params.push(encode(row.where![c]));
          return `"${c}" = $${params.length}::${types.get(c)}`;
        });
        const res = await client.query(
          `UPDATE ${row.table} SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')}`,
          params,
        );
        if (res.rowCount !== 1)
          throw new Error(
            `fixture update of ${row.table} matched ${res.rowCount} rows`,
          );
      } else {
        await client.query(
          `INSERT INTO ${row.table} (${cols.map((c) => `"${c}"`).join(', ')})
           VALUES (${cols.map((c, i) => `$${i + 1}::${types.get(c)}`).join(', ')})`,
          cols.map((c) => encode(row.values[c])),
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Rows captured when a sentinel was written; every one must still be present. */
function checkSentinels(
  sentinels: Record<string, Row[]>,
  now: Record<string, Row[]>,
  when: string,
) {
  let checked = 0;
  for (const [table, expected] of Object.entries(sentinels)) {
    expect(now[table], `${table} vanished ${when}`).toBeDefined();
    for (const old of expected) {
      const match = now[table].some((row) =>
        Object.entries(old).every(([key, value]) => same(row[key], value)),
      );
      expect(match, `sentinel row of ${table} lost or rewritten ${when}`).toBe(
        true,
      );
      checked += 1;
    }
  }
  return checked;
}

async function structureOf(client: pg.Client, database: string) {
  const q = async (sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows;
  const ns = [...SCHEMAS, 'public'];
  return {
    columns: await q(
      `SELECT n.nspname AS s, c.relname AS t, a.attname AS col,
              format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity AS identity,
              a.attgenerated AS generated
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2, 3`,
      [ns],
    ),
    constraints: await q(
      `SELECT conrelid::regclass::text AS t, conname, contype,
              pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = ANY (SELECT oid FROM pg_namespace WHERE nspname = ANY($1))
        ORDER BY 1, 2`,
      [ns],
    ),
    indexes: await q(
      `SELECT schemaname AS s, tablename AS t, indexname, indexdef
         FROM pg_indexes WHERE schemaname = ANY($1) ORDER BY 1, 2, 3`,
      [ns],
    ),
    triggers: await q(
      `SELECT tgrelid::regclass::text AS t, tgname, pg_get_triggerdef(oid) AS def
         FROM pg_trigger WHERE NOT tgisinternal
          AND tgrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY($1))
        ORDER BY 1, 2`,
      [ns],
    ),
    functions: await q(
      `SELECT n.nspname AS s, p.proname, md5(p.prosrc) AS body, p.proacl::text AS acl,
              p.proowner::regrole::text AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY($1) ORDER BY 1, 2`,
      [ns],
    ),
    objectAcls: await q(
      `SELECT n.nspname AS s, c.relname AS name, c.relkind AS kind,
              c.relowner::regrole::text AS owner, c.relacl::text AS acl
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p','S','v','m') ORDER BY 1, 2`,
      [ns],
    ),
    schemaAcls: await q(
      `SELECT nspname, nspowner::regrole::text AS owner, nspacl::text AS acl
         FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1`,
      [ns],
    ),
    defaultAcls: await q(
      `SELECT d.defaclrole::regrole::text AS role, coalesce(n.nspname, '*') AS s,
              d.defaclobjtype AS kind, d.defaclacl::text AS acl
         FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
        ORDER BY 1, 2, 3`,
    ),
    databaseAcl: await q(
      `SELECT datdba::regrole::text AS owner, datacl::text AS acl FROM pg_database WHERE datname = $1`,
      [database],
    ),
    migrations: await q('SELECT id FROM public.schema_migrations ORDER BY id'),
  };
}

describe('G0.4b supported upgrade path preserves existing data', () => {
  it('[G0.4] the fixture file is the frozen one', () => {
    const digest = sha256(readFileSync(FIXTURE_FILE));
    appendManifest({
      gate: 0,
      step: 'upgrade-fixtures',
      sha256: digest,
      pinned: FIXTURE_SHA256,
    });
    expect(digest).toBe(FIXTURE_SHA256);
  });

  it('[G0.4] every migration step leaves a sentinel row in EVERY existing table, none is lost or rewritten later, and the end state equals a fresh database (columns, constraints, indexes, triggers, functions, grants)', async () => {
    const { migrate } = await loadMigrate();
    const fixtures = loadFixtures();
    const ids = migrationIds();
    expect(
      ids.length,
      'fewer than two migrations: no upgrade path exists to test yet',
    ).toBeGreaterThanOrEqual(2);
    const db = await createAccDb();
    dbs.push(db);
    const root = path.join(ensureScratch('upgrade-dirs'), db.name);
    mkdirSync(root, { recursive: true });

    const sentinels: Record<string, Row[]> = {};
    const coverage: Record<
      string,
      { createdBy: string; fixtureRows: number; exception?: string }
    > = {};
    const gaps: string[] = [];
    let preservedRowChecks = 0;
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      let known = new Set<string>();
      for (let k = 0; k < ids.length; k += 1) {
        // Directory holding the first k+1 migrations as symlinks, so their
        // relative imports resolve against the real source tree.
        const dir = path.join(root, `upto-${k + 1}`);
        mkdirSync(dir, { recursive: true });
        for (const id of ids.slice(0, k + 1)) {
          const link = path.join(dir, `${id}.ts`);
          if (!existsSync(link))
            symlinkSync(path.join(MIGRATIONS_DIR, `${id}.ts`), link);
        }
        const stampsBefore = (
          await admin
            .query<{ id: string; applied_at: Date }>(
              'SELECT id, applied_at FROM public.schema_migrations ORDER BY id',
            )
            .catch(() => ({ rows: [] }))
        ).rows;
        const result = await migrate({ connectionString: db.urls.admin, dir });
        expect(result.applied, `step ${k + 1}`).toEqual([ids[k]]);

        // 1. Everything written by earlier steps is still there, unchanged.
        const tablesNow = await listTables(admin);
        preservedRowChecks += checkSentinels(
          sentinels,
          await snapshot(admin, tablesNow),
          `by ${ids[k]}`,
        );
        const stampsAfter = (
          await admin.query<{ id: string; applied_at: Date }>(
            'SELECT id, applied_at FROM public.schema_migrations ORDER BY id',
          )
        ).rows;
        for (const s of stampsBefore)
          expect(stampsAfter.find((x) => x.id === s.id)?.applied_at).toEqual(
            s.applied_at,
          );

        // 2. The fixture group for this migration must exist and name exactly
        //    the tables this step created.
        const created = tablesNow.filter((t) => !known.has(t));
        for (const table of created)
          coverage[table] = { createdBy: ids[k], fixtureRows: 0 };
        const group = fixtures.groups[ids[k]];
        if (!group) {
          gaps.push(
            `${ids[k]}: no fixture group (add hand-written sentinels, or an explicit group with creates [] and a reason)`,
          );
        } else {
          expect(
            [...group.creates].sort(),
            `fixture group ${ids[k]} must list exactly the tables the migration created`,
          ).toEqual([...created].sort());
          if (group.rows?.length) {
            await applyFixtureRows(admin, group.rows);
            const touched = [...new Set(group.rows.map((r) => r.table))];
            const after = await snapshot(admin, touched);
            for (const table of touched) {
              sentinels[table] = after[table];
              if (coverage[table])
                coverage[table].fixtureRows = group.rows.filter(
                  (r) => r.table === table,
                ).length;
            }
          }
        }

        // 3. Before the next step: every table that exists holds a sentinel.
        const nowRows = await snapshot(admin, tablesNow);
        for (const table of tablesNow) {
          const reason = fixtures.exceptions[table];
          if (reason) {
            coverage[table].exception = reason;
            continue;
          }
          const ok =
            (sentinels[table]?.length ?? 0) > 0 &&
            nowRows[table].length >= sentinels[table].length;
          if (!ok)
            gaps.push(
              `after ${ids[k]}: table ${table} holds no sentinel row (created by ${coverage[table]?.createdBy ?? '?'})`,
            );
        }
        known = new Set(tablesNow);
      }

      // 4. Re-run migrate over the full set: a no-op that keeps every
      //    sentinel, including those written after the final migration.
      const again = await migrate({ connectionString: db.urls.admin });
      expect(again.applied).toEqual([]);
      expect(again.pending).toEqual([]);
      const finalTables = await listTables(admin);
      preservedRowChecks += checkSentinels(
        sentinels,
        await snapshot(admin, finalTables),
        'after the final migrate run',
      );

      appendManifest({
        gate: 0,
        step: 'upgrade-coverage',
        fixtureSha256: FIXTURE_SHA256,
        migrations: ids,
        tables: coverage,
        sentinelRowChecks: preservedRowChecks,
        gaps,
      });
      expect(gaps, `upgrade-path coverage gaps:\n${gaps.join('\n')}`).toEqual(
        [],
      );
      expect(Object.keys(coverage).sort()).toEqual([...finalTables].sort());
      expect(preservedRowChecks).toBeGreaterThanOrEqual(finalTables.length);

      // 5. Final state equals a from-scratch migration, structurally.
      const fresh = await createAccDb();
      dbs.push(fresh);
      await migrate({ connectionString: fresh.urls.admin });
      const other = new pg.Client({ connectionString: fresh.urls.admin });
      await other.connect();
      try {
        const left = await structureOf(admin, db.name);
        const right = await structureOf(other, fresh.name);
        for (const key of Object.keys(left) as (keyof typeof left)[])
          expect(left[key], `stepwise vs fresh: ${key} differ`).toEqual(
            right[key],
          );
      } finally {
        await other.end();
      }
    } finally {
      await admin.end();
    }
  }, 900_000);
});

describe('G0.4b the upgrade checks have teeth', () => {
  it('[G0.4] a later migration that rewrites or truncates a sentinel table is detected; an untouched table is not; structure changes are visible', async () => {
    const { migrate } = await loadMigrate();
    const fixtures = loadFixtures();
    const db = await createAccDb();
    dbs.push(db);
    await migrate({ connectionString: db.urls.admin });
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      const sentinels: Record<string, Row[]> = {};
      for (const id of migrationIds()) {
        const rows = fixtures.groups[id]?.rows;
        if (!rows?.length) continue;
        await applyFixtureRows(admin, rows);
        const touched = [...new Set(rows.map((r) => r.table))];
        const after = await snapshot(admin, touched);
        for (const table of touched) sentinels[table] = after[table];
      }
      const dir = path.join(ensureScratch('upgrade-dirs'), `${db.name}-teeth`);
      mkdirSync(dir, { recursive: true });
      for (const id of migrationIds())
        symlinkSync(
          path.join(MIGRATIONS_DIR, `${id}.ts`),
          path.join(dir, `${id}.ts`),
        );
      const fake = (id: string, sql: string) =>
        writeFileSync(
          path.join(dir, `${id}.ts`),
          `export default { id: '${id}', async up(client: { query(sql: string): Promise<unknown> }) { await client.query("${sql}"); } };\n`,
        );
      fake(
        '0998_acc0_rewrite',
        "UPDATE checkout.products SET name = 'rewritten'",
      );
      fake('0999_acc0_truncate', 'TRUNCATE ledger.source_revisions');
      const result = await migrate({ connectionString: db.urls.admin, dir });
      expect(result.applied).toEqual([
        '0998_acc0_rewrite',
        '0999_acc0_truncate',
      ]);
      const now = await snapshot(admin, Object.keys(sentinels));
      const only = (table: string) => ({ [table]: sentinels[table] });
      expect(() =>
        checkSentinels(only('checkout.products'), now, 'by the fake rewrite'),
      ).toThrow(/rewritten/);
      expect(() =>
        checkSentinels(
          only('ledger.source_revisions'),
          now,
          'by the fake truncate',
        ),
      ).toThrow(/lost or rewritten/);
      expect(
        checkSentinels(only('ledger.sources'), now, 'untouched'),
      ).toBeGreaterThan(0);

      const before = await structureOf(admin, db.name);
      await admin.query('CREATE INDEX acc0_extra ON checkout.products (name)');
      await admin.query(
        'ALTER TABLE checkout.products ADD CONSTRAINT acc0_extra CHECK (price_cents < 10000000)',
      );
      await admin.query(
        'GRANT SELECT ON checkout.products TO nemodots_injector',
      );
      const changed = await structureOf(admin, db.name);
      expect(changed.indexes).not.toEqual(before.indexes);
      expect(changed.constraints).not.toEqual(before.constraints);
      expect(changed.objectAcls).not.toEqual(before.objectAcls);
    } finally {
      await admin.end();
    }
  }, 300_000);
});

// -------------------------------------------------------------- privileges

describe('G0.4c least-privilege roles after migration', () => {
  it('[G0.4] every role connects as itself, and the full privilege matrix (role x schema/table/sequence x privilege, schema USAGE/CREATE, database, PUBLIC) equals the one in STACK.md', async () => {
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
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      const diff = await diffPrivilegeMatrix(admin, db.name);
      appendManifest({
        gate: 0,
        step: 'privilege-matrix',
        checked: diff.checked,
        missing: diff.missing.length,
        extra: diff.extra.length,
        tolerated: diff.tolerated,
      });
      expect(diff.checked).toBeGreaterThan(500);
      expect(
        diff.missing,
        `missing grants (${diff.missing.length}): ${diff.missing.slice(0, 20).join('; ')}`,
      ).toEqual([]);
      expect(
        diff.extra,
        `extra grants (${diff.extra.length}): ${diff.extra.slice(0, 20).join('; ')}`,
      ).toEqual([]);
    } finally {
      await admin.end();
    }
  }, 300_000);

  it('[G0.4] the matrix check has teeth: an extra, a missing and a PUBLIC grant injected into a throwaway database are all reported', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    await migrate({ connectionString: db.urls.admin });
    const admin = new pg.Client({ connectionString: db.urls.admin });
    await admin.connect();
    try {
      await admin.query(
        'GRANT INSERT ON checkout.products TO nemodots_injector',
      );
      await admin.query(
        'REVOKE SELECT ON ledger.sources FROM nemodots_verifier',
      );
      await admin.query('GRANT SELECT ON control.scenario_runs TO PUBLIC');
      const diff = await diffPrivilegeMatrix(admin, db.name);
      expect(diff.extra).toContain(
        'nemodots_injector INSERT table checkout.products',
      );
      expect(diff.missing).toContain(
        'nemodots_verifier SELECT table ledger.sources',
      );
      expect(
        diff.extra.some((x) =>
          x.startsWith('PUBLIC SELECT table control.scenario_runs'),
        ),
      ).toBe(true);
    } finally {
      await admin.end();
    }
  }, 300_000);

  it('[G0.4] behaviour: forbidden statements fail with permission denied (42501) and the permitted ones succeed', async () => {
    const { migrate } = await loadMigrate();
    const db = await createAccDb();
    dbs.push(db);
    await migrate({ connectionString: db.urls.admin });
    type R = 'app' | 'checkout' | 'injector' | 'verifier';
    const order =
      "INSERT INTO checkout.orders (id, status, customer, total_cents) VALUES (gen_random_uuid(), 'confirmed', 'acc0', 1)";
    const denied: [R, string][] = [
      ['verifier', order],
      ['verifier', "UPDATE coordinator.missions SET goal = 'x'"],
      ['verifier', 'DELETE FROM ledger.sources'],
      ['verifier', 'TRUNCATE control.scenario_runs'],
      ['injector', order],
      ['injector', 'UPDATE checkout.inventory SET quantity = 0'],
      ['injector', 'DELETE FROM checkout.products'],
      ['injector', 'SELECT 1 FROM ledger.sources'],
      ['injector', 'SELECT 1 FROM coordinator.missions'],
      ['checkout', 'SELECT 1 FROM ledger.sources'],
      ['checkout', 'SELECT 1 FROM coordinator.outbox'],
      ['checkout', 'SELECT 1 FROM control.scenario_runs'],
      [
        'checkout',
        "INSERT INTO checkout.config_entries (key, value, version, caused_by_actor) VALUES ('cache.namespace', '\"x\"', 1, 'action')",
      ],
      [
        'checkout',
        'INSERT INTO ledger.sources (id) VALUES (gen_random_uuid())',
      ],
      ['app', 'SELECT 1 FROM control.scenario_runs'],
      ['app', order],
      ['app', 'DELETE FROM checkout.config_entries'],
      ['app', 'UPDATE checkout.products SET name = name'],
      ['app', 'TRUNCATE ledger.sources'],
    ];
    const allowed: [R, string][] = [
      ['app', 'SELECT count(*) FROM ledger.sources'],
      ['app', 'SELECT count(*) FROM checkout.orders'],
      ['app', 'UPDATE checkout.config_entries SET value = value WHERE false'],
      ['checkout', 'SELECT count(*) FROM checkout.config_entries'],
      ['checkout', order],
      [
        'checkout',
        'UPDATE checkout.inventory SET quantity = quantity WHERE false',
      ],
      [
        'injector',
        "INSERT INTO control.scenario_runs (id, scenario_id, seed, manifest_digest, status) VALUES (gen_random_uuid(), 'acc0', 1, repeat('a', 64), 'running')",
      ],
      [
        'injector',
        'UPDATE checkout.config_entries SET value = value WHERE false',
      ],
      ['verifier', 'SELECT count(*) FROM control.fault_schedules'],
      ['verifier', 'SELECT count(*) FROM coordinator.events'],
      ['verifier', 'SELECT count(*) FROM checkout.config_versions'],
    ];
    const attempt = async (role: R, sql: string) => {
      const client = new pg.Client({ connectionString: db.urls[role] });
      await client.connect();
      try {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          return { ok: true, code: '' };
        } catch (error) {
          return {
            ok: false,
            code: (error as { code?: string }).code ?? '?',
          };
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
        }
      } finally {
        await client.end();
      }
    };
    const wrongDenied: string[] = [];
    for (const [role, sql] of denied) {
      const r = await attempt(role, sql);
      if (r.ok || r.code !== '42501')
        wrongDenied.push(
          `${role}: ${sql.slice(0, 50)} -> ${r.ok ? 'allowed' : r.code}`,
        );
    }
    const wrongAllowed: string[] = [];
    for (const [role, sql] of allowed) {
      const r = await attempt(role, sql);
      if (!r.ok) wrongAllowed.push(`${role}: ${sql.slice(0, 50)} -> ${r.code}`);
    }
    expect(
      wrongDenied,
      `statements that should be permission denied: ${wrongDenied.join('; ')}`,
    ).toEqual([]);
    expect(
      wrongAllowed,
      `statements that should be allowed: ${wrongAllowed.join('; ')}`,
    ).toEqual([]);
  }, 300_000);
});
