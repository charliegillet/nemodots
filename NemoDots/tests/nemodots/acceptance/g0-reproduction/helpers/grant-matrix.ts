// Expected privilege matrix, transcribed from docs/nemodots/STACK.md
// ("Database roles and grants") and the per-table statement there ("Per-table
// rights beyond these defaults ..."). It is NOT derived from the migrations.
//
// Convention: a privilege that is not listed is expected to be ABSENT. The
// test compares the full actual matrix with this one in both directions, so a
// missing grant and an extra grant are both reported.
import type pg from 'pg';

export const ROLE_NAMES = [
  'nemodots_app',
  'nemodots_checkout',
  'nemodots_injector',
  'nemodots_verifier',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const SCHEMA_NAMES = [
  'ledger',
  'coordinator',
  'checkout',
  'control',
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

export const TABLE_PRIVS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;
export const SEQ_PRIVS = ['USAGE', 'SELECT', 'UPDATE'] as const;
export const SCHEMA_PRIVS = ['USAGE', 'CREATE'] as const;

const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Schema-level default table rights per role (STACK.md table). */
const DEFAULT_TABLE: Record<RoleName, Partial<Record<SchemaName, string[]>>> = {
  nemodots_app: { ledger: DML, coordinator: DML, checkout: ['SELECT'] },
  nemodots_checkout: { checkout: ['SELECT'] },
  nemodots_injector: { control: DML },
  nemodots_verifier: {
    ledger: ['SELECT'],
    coordinator: ['SELECT'],
    checkout: ['SELECT'],
    control: ['SELECT'],
  },
};

/** Sequence rights per role and schema (STACK.md: sequences follow the table rights). */
const DEFAULT_SEQ: Record<RoleName, Partial<Record<SchemaName, string[]>>> = {
  nemodots_app: {
    ledger: ['USAGE', 'SELECT', 'UPDATE'],
    coordinator: ['USAGE', 'SELECT', 'UPDATE'],
  },
  nemodots_checkout: { checkout: ['USAGE', 'SELECT'] },
  nemodots_injector: { control: ['USAGE', 'SELECT', 'UPDATE'] },
  nemodots_verifier: {
    ledger: ['SELECT'],
    coordinator: ['SELECT'],
    checkout: ['SELECT'],
    control: ['SELECT'],
  },
};

/** Schema USAGE (STACK.md "Schema usage" column). CREATE is never granted. */
const SCHEMA_USAGE: Record<RoleName, SchemaName[]> = {
  nemodots_app: ['ledger', 'coordinator', 'checkout'],
  nemodots_checkout: ['checkout'],
  nemodots_injector: ['checkout', 'control'],
  nemodots_verifier: ['ledger', 'coordinator', 'checkout', 'control'],
};

/**
 * Per-table additions beyond the schema defaults, as listed in STACK.md:
 * business-table DML for nemodots_checkout; UPDATE on config_entries and
 * config_collection plus INSERT on config_versions for nemodots_app and
 * nemodots_injector. The injector's config rights are the "config grants"
 * STACK.md and the task description refer to: DML on the two mutable config
 * tables and SELECT+INSERT (append-only history) on config_versions.
 */
const TABLE_EXTRA: Record<RoleName, Record<string, string[]>> = {
  nemodots_app: {
    'checkout.config_entries': ['UPDATE'],
    'checkout.config_collection': ['UPDATE'],
    'checkout.config_versions': ['INSERT'],
  },
  nemodots_checkout: {
    'checkout.orders': ['INSERT'],
    'checkout.order_items': ['INSERT'],
    'checkout.inventory': ['UPDATE'],
  },
  nemodots_injector: {
    'checkout.config_entries': ['INSERT', 'UPDATE', 'DELETE'],
    'checkout.config_collection': ['INSERT', 'UPDATE', 'DELETE'],
    'checkout.config_versions': ['INSERT'],
  },
  nemodots_verifier: {},
};

/**
 * Exceptions documented as grant REVOKEs (coordinator.events is append-only:
 * ARCHITECTURE.md section 3 "status changes are appended"; the stream relies on
 * stable ids). Listed here with the reason so they are not silent.
 */
const TABLE_REMOVE: Record<RoleName, Record<string, string[]>> = {
  nemodots_app: { 'coordinator.events': ['UPDATE', 'DELETE'] },
  nemodots_checkout: {},
  nemodots_injector: {},
  nemodots_verifier: {},
};

export function expectedTablePrivs(
  role: RoleName,
  schema: string,
  table: string,
): Set<string> {
  const granted = new Set<string>(
    DEFAULT_TABLE[role][schema as SchemaName] ?? [],
  );
  for (const p of TABLE_EXTRA[role][`${schema}.${table}`] ?? []) granted.add(p);
  for (const p of TABLE_REMOVE[role][`${schema}.${table}`] ?? [])
    granted.delete(p);
  return granted;
}

/**
 * Privileges the two spec documents leave open. STACK.md is the stricter text;
 * ARCHITECTURE.md section 3 says "DML on checkout business tables" for
 * nemodots_checkout and "UPDATE/INSERT/DELETE on config_entries,
 * config_collection, config_versions" for nemodots_injector, and an UPDATE or
 * ON CONFLICT statement needs SELECT on the same table. Such a privilege is
 * tolerated (not an error) but is reported in the manifest as "tolerated".
 */
const TABLE_OPTIONAL: Record<RoleName, Record<string, string[]>> = {
  nemodots_app: {},
  nemodots_checkout: {
    'checkout.products': ['INSERT', 'UPDATE', 'DELETE'],
    'checkout.inventory': ['INSERT', 'DELETE'],
    'checkout.orders': ['UPDATE', 'DELETE'],
    'checkout.order_items': ['UPDATE', 'DELETE'],
  },
  nemodots_injector: {
    'checkout.config_entries': ['SELECT'],
    'checkout.config_collection': ['SELECT'],
    'checkout.config_versions': ['SELECT', 'UPDATE', 'DELETE'],
  },
  nemodots_verifier: {},
};

export function optionalTablePrivs(
  role: RoleName,
  schema: string,
  table: string,
): Set<string> {
  return new Set<string>(TABLE_OPTIONAL[role][`${schema}.${table}`] ?? []);
}

export function expectedSeqPrivs(role: RoleName, schema: string) {
  return new Set<string>(DEFAULT_SEQ[role][schema as SchemaName] ?? []);
}

export function expectedSchemaPrivs(role: RoleName, schema: string) {
  return new Set<string>(
    SCHEMA_USAGE[role].includes(schema as SchemaName) ? ['USAGE'] : [],
  );
}

export interface MatrixDiff {
  missing: string[];
  extra: string[];
  tolerated: string[];
  checked: number;
}

/**
 * Reads the actual privileges with has_*_privilege (so role membership and
 * default privileges are all resolved by PostgreSQL) and the PUBLIC pseudo-role
 * through aclexplode, then diffs against the expected matrix.
 */
export async function diffPrivilegeMatrix(
  client: pg.Client,
  database: string,
): Promise<MatrixDiff> {
  const out: MatrixDiff = { missing: [], extra: [], tolerated: [], checked: 0 };
  const note = (
    label: string,
    expected: boolean,
    actual: boolean,
    optional = false,
  ): void => {
    out.checked += 1;
    if (expected && !actual) out.missing.push(label);
    if (!expected && actual) (optional ? out.tolerated : out.extra).push(label);
  };

  const tables = (
    await client.query<{ s: string; t: string }>(
      `SELECT n.nspname AS s, c.relname AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p') ORDER BY 1, 2`,
      [SCHEMA_NAMES],
    )
  ).rows;
  const sequences = (
    await client.query<{ s: string; t: string }>(
      `SELECT n.nspname AS s, c.relname AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind = 'S' ORDER BY 1, 2`,
      [SCHEMA_NAMES],
    )
  ).rows;

  for (const role of ROLE_NAMES) {
    for (const schema of [...SCHEMA_NAMES, 'public']) {
      const expected = expectedSchemaPrivs(role, schema);
      for (const p of SCHEMA_PRIVS) {
        const actual = (
          await client.query<{ ok: boolean }>(
            'SELECT has_schema_privilege($1, $2, $3) AS ok',
            [role, schema, p],
          )
        ).rows[0].ok;
        // The public schema: not part of the STACK.md matrix; USAGE comes from
        // PUBLIC by PostgreSQL default and is allowed, CREATE must be absent.
        if (schema === 'public') {
          if (p === 'CREATE') note(`${role} ${p} schema public`, false, actual);
          continue;
        }
        note(`${role} ${p} schema ${schema}`, expected.has(p), actual);
      }
    }
    for (const { s, t } of tables) {
      const expected = expectedTablePrivs(role, s, t);
      const optional = optionalTablePrivs(role, s, t);
      for (const p of TABLE_PRIVS) {
        const actual = (
          await client.query<{ ok: boolean }>(
            'SELECT has_table_privilege($1, $2, $3) AS ok',
            [role, `${s}.${t}`, p],
          )
        ).rows[0].ok;
        note(
          `${role} ${p} table ${s}.${t}`,
          expected.has(p),
          actual,
          optional.has(p),
        );
      }
    }
    for (const { s, t } of sequences) {
      const expected = expectedSeqPrivs(role, s);
      for (const p of SEQ_PRIVS) {
        const actual = (
          await client.query<{ ok: boolean }>(
            'SELECT has_sequence_privilege($1, $2, $3) AS ok',
            [role, `${s}.${t}`, p],
          )
        ).rows[0].ok;
        note(`${role} ${p} sequence ${s}.${t}`, expected.has(p), actual);
      }
    }
    // Database level: CONNECT is granted to the four roles; no CREATE/TEMP.
    for (const [p, expected] of [
      ['CONNECT', true],
      ['CREATE', false],
      ['TEMPORARY', false],
    ] as const) {
      const actual = (
        await client.query<{ ok: boolean }>(
          'SELECT has_database_privilege($1, $2, $3) AS ok',
          [role, database, p],
        )
      ).rows[0].ok;
      note(`${role} ${p} database`, expected, actual);
    }
  }

  // PUBLIC: nothing on the four schemas, their tables or sequences, nor on the database.
  const publicGrants = await client.query<{ what: string }>(
    `SELECT format('PUBLIC %s schema %s', a.privilege_type, n.nspname) AS what
       FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, '{}')) a
      WHERE n.nspname = ANY($1) AND a.grantee = 0
     UNION ALL
     SELECT format('PUBLIC %s %s %s.%s', a.privilege_type,
                   CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END, n.nspname, c.relname)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
            LATERAL aclexplode(coalesce(c.relacl, '{}')) a
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND a.grantee = 0
     UNION ALL
     SELECT format('PUBLIC %s database', a.privilege_type)
       FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, '{}')) a
      WHERE d.datname = $2 AND a.grantee = 0
     UNION ALL
     SELECT format('PUBLIC %s function %s.%s', a.privilege_type, n.nspname, p.proname)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
            LATERAL aclexplode(coalesce(p.proacl, '{}')) a
      WHERE n.nspname = ANY($1) AND a.grantee = 0 AND p.proacl IS NOT NULL`,
    [SCHEMA_NAMES, database],
  );
  out.checked += publicGrants.rows.length + 1;
  for (const row of publicGrants.rows) out.extra.push(row.what);

  // PUBLIC EXECUTE on functions with a NULL proacl is the PostgreSQL default and is
  // reported separately: the migrations create trigger functions only.
  return out;
}
