// Migration runner. Works under tsx (migrations/*.ts) and from the built
// output (dist/server/server/nemodots/db/migrations/*.js): migrations are
// discovered by listing the directory next to this module and imported
// dynamically. Each module exports `default { id, up }`; `id` must equal the
// file's base name. Applied ids are recorded in public.schema_migrations; a
// session advisory lock serializes concurrent runners on one database.
//
// CLI: `npm run nemodots:migrate` (apply) and `npm run nemodots:migrate -- --check`
// (exit 1 when anything is pending or unknown). Uses NEMODOTS_PG_URL_ADMIN.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  NemoDotsEnvError,
  assertSafePgUrl,
  parseNemoDotsEnv,
  pgUrl,
} from '../config/env.js';

export interface MigrationClient {
  query: pg.ClientBase['query'];
}

export interface Migration {
  id: string;
  up(client: MigrationClient): Promise<void>;
}

export interface MigrationFile {
  id: string;
  file: string;
}

/** Fixed key for pg_advisory_lock; advisory locks are scoped per database. */
export const MIGRATION_LOCK_KEY = 0x6e656d6f; // "nemo"
export const MIGRATION_ROLE = 'nemodots_admin';
const FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.(ts|js)$/;

export const defaultMigrationsDir = () =>
  fileURLToPath(new URL('./migrations/', import.meta.url));

/** Lists migration modules sorted by name, one per id. */
export async function discoverMigrations(
  dir = defaultMigrationsDir(),
  preferredExtension = path.extname(fileURLToPath(import.meta.url)),
): Promise<MigrationFile[]> {
  const byId = new Map<string, MigrationFile & { ext: string }>();
  for (const name of await readdir(dir)) {
    if (name.endsWith('.d.ts')) continue;
    const match = FILE_PATTERN.exec(name);
    if (!match) continue;
    const [, id, ext] = match;
    const existing = byId.get(id);
    if (existing && existing.ext === preferredExtension) continue;
    byId.set(id, { id, file: path.join(dir, name), ext: `.${ext}` });
  }
  return [...byId.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, file }) => ({ id, file }));
}

export async function loadMigration(entry: MigrationFile): Promise<Migration> {
  const module = (await import(pathToFileURL(entry.file).href)) as {
    default?: Partial<Migration>;
  };
  const migration = module.default;
  if (
    !migration ||
    typeof migration.id !== 'string' ||
    typeof migration.up !== 'function'
  )
    throw new Error(
      `Migration ${entry.id} must export default { id, up(client) }.`,
    );
  if (migration.id !== entry.id)
    throw new Error(
      `Migration file ${entry.id} declares id ${migration.id}; they must match.`,
    );
  return migration as Migration;
}

export interface MigrateOptions {
  connectionString: string;
  check?: boolean;
  dir?: string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  pending: string[];
  /** Ids recorded in schema_migrations that no migration file provides. */
  unknown: string[];
  alreadyApplied: number;
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  assertSafePgUrl('NEMODOTS_PG_URL_ADMIN', options.connectionString);
  const log = options.log ?? (() => {});
  const files = await discoverMigrations(options.dir);
  const client = new pg.Client({
    connectionString: options.connectionString,
    application_name: 'nemodots-migrate',
    statement_timeout: 120_000,
  });
  await client.connect();
  try {
    const role = await client.query<{ current_user: string }>(
      'SELECT current_user',
    );
    if (role.rows[0].current_user !== MIGRATION_ROLE)
      throw new Error(
        `Migrations must run as ${MIGRATION_ROLE} so it owns every object.`,
      );
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const exists = await client.query<{ present: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
      );
      if (!exists.rows[0].present && !options.check)
        await client.query(
          `CREATE TABLE public.schema_migrations (
             id text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
      const appliedIds = new Set(
        exists.rows[0].present || !options.check
          ? (
              await client.query<{ id: string }>(
                'SELECT id FROM public.schema_migrations',
              )
            ).rows.map((row) => row.id)
          : [],
      );
      const known = new Set(files.map((file) => file.id));
      const unknown = [...appliedIds].filter((id) => !known.has(id)).sort();
      const pendingFiles = files.filter((file) => !appliedIds.has(file.id));
      const result: MigrateResult = {
        applied: [],
        pending: pendingFiles.map((file) => file.id),
        unknown,
        alreadyApplied: files.length - pendingFiles.length,
      };
      if (options.check) return result;
      if (unknown.length)
        throw new Error(
          `Database has migrations this code does not know: ${unknown.join(', ')}.`,
        );
      for (const file of pendingFiles) {
        const migration = await loadMigration(file);
        const started = Date.now();
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query(
            'INSERT INTO public.schema_migrations (id) VALUES ($1)',
            [migration.id],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        result.applied.push(migration.id);
        log(`applied ${migration.id} (${Date.now() - started} ms)`);
      }
      result.pending = [];
      return result;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function main(argv: string[]) {
  const check = argv.includes('--check');
  const unknownArgs = argv.filter((arg) => arg !== '--check');
  if (unknownArgs.length) {
    console.error(`migrate: unknown arguments: ${unknownArgs.join(' ')}`);
    return 2;
  }
  const config = parseNemoDotsEnv(process.env);
  const result = await migrate({
    connectionString: pgUrl(config, 'admin'),
    check,
    log: (line) => console.log(`migrate: ${line}`),
  });
  if (check) {
    if (result.pending.length || result.unknown.length) {
      if (result.pending.length)
        console.log(`migrate --check: pending ${result.pending.join(', ')}`);
      if (result.unknown.length)
        console.log(`migrate --check: unknown ${result.unknown.join(', ')}`);
      return 1;
    }
    console.log(
      `migrate --check: up to date (${result.alreadyApplied} applied, 0 pending) on database ${config.pg.database}, port ${config.pg.port}`,
    );
    return 0;
  }
  console.log(
    result.applied.length
      ? `migrate: ${result.applied.length} applied, ${result.alreadyApplied} already applied`
      : `migrate: nothing to apply (${result.alreadyApplied} already applied)`,
  );
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked && pathToFileURL(invoked).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message =
        error instanceof NemoDotsEnvError || error instanceof Error
          ? error.message
          : String(error);
      console.error(`migrate: ${message}`);
      process.exit(1);
    },
  );
}
