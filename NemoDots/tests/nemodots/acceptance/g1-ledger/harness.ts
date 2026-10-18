// Gate 1 harness: isolated database, entry-point resolution and a small
// schema-introspecting row inserter. Local to g1-ledger.
//
// Isolation (task assignment): port block checkout 4620 / app 4621, database
// name prefix "acc1_", Redis db index 2 on the NemoDots Redis. Gate 1 needs no
// checkout server or Redis traffic, so only the database name is exercised;
// the constants are still the single source for this suite.
//
// Nothing here imports production logic except the migration runner, the
// coordinator event sink every registration must be given (ledger/options.ts
// requireEventSink, W2-R5) and the documented test helpers (infrastructure,
// not behaviour under test).
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  stackRoleUrls,
  withDatabase,
  type TestDatabaseUrls,
} from '../../helpers/test-db.js';
import { migrate } from '../../../../src/server/nemodots/db/migrate.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';

const EVENT_SINK = createEventSink();

/** RegisterOptions plus `ledger.events`, which every production registration requires. */
export function withLedgerEvents(
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  const ledger = (options.ledger ?? {}) as Record<string, unknown>;
  return { ...options, ledger: { ...ledger, events: EVENT_SINK } };
}

export const PORT_BLOCK = { checkout: 4620, app: 4621 } as const;
export const DB_PREFIX = 'acc1_';
export const REDIS_DB_INDEX = 2;
export const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// ---------------------------------------------------------------- entries

export class EntryPointMissing extends Error {
  constructor(entry: string, reason: string) {
    super(
      `ENTRY POINT MISSING: ${entry} (${reason}). Gate 1 cannot run without it (docs/nemodots/ACCEPTANCE_CONTRACT.md section 6).`,
    );
    this.name = 'EntryPointMissing';
  }
}

/** Dynamic import of src/server/nemodots/<rel>; missing file or export is a hard failure, never a skip. */
export async function entry<T = unknown>(
  rel: string,
  names: readonly string[],
): Promise<T> {
  const file = resolve(APP_ROOT, 'src/server/nemodots', rel);
  const label = `src/server/nemodots/${rel}#${names.join('|')}`;
  if (!existsSync(file))
    throw new EntryPointMissing(label, 'module file does not exist');
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new EntryPointMissing(
      label,
      `module failed to load: ${(error as Error).message}`,
    );
  }
  for (const name of names) if (name in mod) return mod[name] as T;
  throw new EntryPointMissing(
    label,
    `module exports none of: ${Object.keys(mod).join(', ') || '(nothing)'}`,
  );
}

// --------------------------------------------------------------- database

export interface AccDb {
  name: string;
  urls: TestDatabaseUrls;
}

export async function withAccDatabase<T>(
  fn: (db: AccDb) => Promise<T>,
): Promise<T> {
  const base = stackRoleUrls();
  const name = `${DB_PREFIX}${randomBytes(6).toString('hex')}`;
  if (!/^acc1_[0-9a-f]{12}$/.test(name)) throw new Error('bad database name');
  const admin = new pg.Client({
    connectionString: base.admin,
    application_name: 'acc1-admin',
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER nemodots_admin`);
    const urls = Object.fromEntries(
      (Object.keys(base) as (keyof TestDatabaseUrls)[]).map((role) => [
        role,
        withDatabase(base[role], name),
      ]),
    ) as TestDatabaseUrls;
    try {
      await migrate({ connectionString: urls.admin });
      return await fn({ name, urls });
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

export function pool(url: string, max = 6): pg.Pool {
  const p = new pg.Pool({
    connectionString: url,
    max,
    application_name: 'acc1-g1',
  });
  p.on('error', () => {});
  return p;
}

// ------------------------------------------------------ schema introspection

type Col = {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
};
type Fk = { column: string; table: string; refColumn: string };

export class Schema {
  private cols = new Map<string, Col[]>();
  private fks = new Map<string, Fk[]>();
  private checks = new Map<string, string[]>();
  constructor(private readonly db: pg.Pool) {}

  static split(table: string): [string, string] {
    const [schema, name] = table.split('.');
    return [schema, name];
  }

  async exists(table: string): Promise<boolean> {
    const [s, t] = Schema.split(table);
    const r = await this.db.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2',
      [s, t],
    );
    return r.rowCount === 1;
  }

  async columns(table: string): Promise<Col[]> {
    const hit = this.cols.get(table);
    if (hit) return hit;
    const [s, t] = Schema.split(table);
    const r = await this.db.query(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity
         FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
      [s, t],
    );
    const cols = r.rows.map((row) => ({
      name: row.column_name as string,
      type:
        row.data_type === 'USER-DEFINED' || row.data_type === 'ARRAY'
          ? (row.udt_name as string)
          : (row.data_type as string),
      notNull: row.is_nullable === 'NO',
      hasDefault: row.column_default !== null || row.is_identity === 'YES',
      generated: row.is_generated === 'ALWAYS',
    }));
    this.cols.set(table, cols);
    return cols;
  }

  /** First candidate column that exists on the table, or null. */
  async pick(
    table: string,
    candidates: readonly string[],
  ): Promise<string | null> {
    const names = new Set((await this.columns(table)).map((c) => c.name));
    return candidates.find((c) => names.has(c)) ?? null;
  }

  async need(table: string, candidates: readonly string[]): Promise<string> {
    const hit = await this.pick(table, candidates);
    if (!hit) {
      throw new Error(
        `SCHEMA BINDING: ${table} has none of the columns [${candidates.join(', ')}] (has: ${(await this.columns(table)).map((c) => c.name).join(', ')})`,
      );
    }
    return hit;
  }

  async foreignKeys(table: string): Promise<Fk[]> {
    const hit = this.fks.get(table);
    if (hit) return hit;
    const [s, t] = Schema.split(table);
    const r = await this.db.query(
      `SELECT a.attname AS col, cn.nspname || '.' || c.relname AS ref_table, af.attname AS ref_col
         FROM pg_constraint k
         JOIN pg_class r ON r.oid = k.conrelid JOIN pg_namespace rn ON rn.oid = r.relnamespace
         JOIN pg_class c ON c.oid = k.confrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
         JOIN LATERAL unnest(k.conkey, k.confkey) AS u(ck, fk) ON true
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.ck
         JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = u.fk
        WHERE k.contype = 'f' AND rn.nspname = $1 AND r.relname = $2 AND array_length(k.conkey, 1) = 1`,
      [s, t],
    );
    const fks = r.rows.map((row) => ({
      column: row.col as string,
      table: row.ref_table as string,
      refColumn: row.ref_col as string,
    }));
    this.fks.set(table, fks);
    return fks;
  }

  /** Quoted string literals of CHECK constraints that mention the column, in declaration order. */
  async checkLiterals(table: string, column: string): Promise<string[]> {
    const key = `${table}.${column}`;
    const hit = this.checks.get(key);
    if (hit) return hit;
    const [s, t] = Schema.split(table);
    const r = await this.db.query(
      `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k
         JOIN pg_class r ON r.oid = k.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE k.contype = 'c' AND n.nspname = $1 AND r.relname = $2`,
      [s, t],
    );
    const lits: string[] = [];
    for (const row of r.rows) {
      const def = row.def as string;
      if (!new RegExp(`\\(?\\b${column}\\b`).test(def)) continue;
      for (const m of def.matchAll(/'([^']*)'::/g)) lits.push(m[1]);
    }
    this.checks.set(key, lits);
    return lits;
  }
}

// --------------------------------------------------------------- row insert

const filler: Record<string, () => unknown> = {
  uuid: () => randomUUID(),
  text: () => 'acc1',
  'character varying': () => 'acc1',
  integer: () => 0,
  bigint: () => 0,
  smallint: () => 0,
  numeric: () => 0,
  boolean: () => false,
  jsonb: () => ({}),
  json: () => ({}),
  'timestamp with time zone': () => new Date(),
  'timestamp without time zone': () => new Date(),
  bytea: () => Buffer.from('acc1'),
  _text: () => '{}',
  _uuid: () => '{}',
};

export interface InsertOptions {
  /** Table -> id column to reuse when a not-null FK points at it (shared parents). */
  parents?: Record<string, unknown>;
}

/**
 * Inserts one row. Columns not provided are left to defaults; NOT NULL columns
 * without defaults get a type-based filler (first CHECK literal for enums, a
 * parent row for foreign keys). Returns the inserted row. The goal is to seed
 * rows for graph tests without hard-coding column lists the builders own;
 * every explicitly given column is exactly what the case needs.
 */
export async function insertRow(
  db: pg.Pool,
  schema: Schema,
  table: string,
  given: Record<string, unknown>,
  options: InsertOptions & { depth?: number } = {},
): Promise<Record<string, unknown>> {
  const values = await fillRow(db, schema, table, given, options);
  return insertValues(db, table, [values]).then((rows) => rows[0]);
}

const toParam = (v: unknown) =>
  v !== null &&
  typeof v === 'object' &&
  !(v instanceof Date) &&
  !Buffer.isBuffer(v)
    ? JSON.stringify(v)
    : v;

/** One multi-row INSERT of rows that share the same column set. */
export async function insertValues(
  db: pg.Pool,
  table: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!rows.length) return [];
  const names = Object.keys(rows[0]);
  if (!names.length)
    return (await db.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING *`))
      .rows;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < rows.length; from += 1000) {
    const chunk = rows.slice(from, from + 1000);
    const params: unknown[] = [];
    const tuples = chunk.map(
      (row) =>
        `(${names
          .map((n) => {
            params.push(toParam(row[n]));
            return `$${params.length}`;
          })
          .join(', ')})`,
    );
    const r = await db.query(
      `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`,
      params,
    );
    out.push(...r.rows);
  }
  return out;
}

/** Column values for one row: the given ones plus fillers for NOT NULL columns without defaults. */
export async function fillRow(
  db: pg.Pool,
  schema: Schema,
  table: string,
  given: Record<string, unknown>,
  options: InsertOptions & { depth?: number } = {},
): Promise<Record<string, unknown>> {
  const depth = options.depth ?? 0;
  if (depth > 4)
    throw new Error(
      `SCHEMA BINDING: foreign key chain too deep seeding ${table}`,
    );
  const cols = await schema.columns(table);
  const fks = await schema.foreignKeys(table);
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(given)) {
    if (!cols.some((c) => c.name === k)) {
      throw new Error(
        `SCHEMA BINDING: ${table} has no column "${k}" (has: ${cols.map((c) => c.name).join(', ')})`,
      );
    }
    values[k] = v;
  }
  for (const col of cols) {
    if (col.name in values || col.generated) continue;
    if (!col.notNull || col.hasDefault) continue;
    const fk = fks.find((f) => f.column === col.name);
    if (fk) {
      const shared = options.parents?.[fk.table];
      if (shared !== undefined) values[col.name] = shared;
      else {
        const parent = await insertRow(
          db,
          schema,
          fk.table,
          {},
          { ...options, depth: depth + 1 },
        );
        values[col.name] = parent[fk.refColumn];
      }
      continue;
    }
    const lits = await schema.checkLiterals(table, col.name);
    if (lits.length) values[col.name] = lits[0];
    else {
      const make = filler[col.type];
      if (!make)
        throw new Error(
          `SCHEMA BINDING: cannot fill ${table}.${col.name} (${col.type})`,
        );
      values[col.name] = make();
    }
  }
  return values;
}
