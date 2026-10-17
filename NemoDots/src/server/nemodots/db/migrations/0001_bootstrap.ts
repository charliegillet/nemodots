// 0001: schemas, roles, grants and default privileges (ARCHITECTURE.md
// section 3). No content tables: later migrations create them as
// nemodots_admin, so the default privileges below apply automatically.
//
// Baseline grants (tables created later by nemodots_admin):
//   ledger, coordinator  app: SELECT/INSERT/UPDATE/DELETE, sequences USAGE/SELECT/UPDATE
//   checkout             app, checkout: SELECT (business-table DML for nemodots_checkout,
//                        config-table writes for nemodots_app/nemodots_injector are granted
//                        per table by the migration that creates the table); checkout:
//                        sequences USAGE/SELECT
//   control              injector: SELECT/INSERT/UPDATE/DELETE, sequences USAGE/SELECT/UPDATE
//   all four schemas     verifier: SELECT, sequences SELECT
// Nothing outside this list: checkout cannot see ledger/coordinator/control,
// app cannot see control, injector cannot see ledger/coordinator.
//
// LISTEN/NOTIFY: PostgreSQL has no LISTEN privilege; any role that may CONNECT
// can LISTEN. CONNECT on the database is granted to app and injector (who
// LISTEN) and to checkout and verifier; PUBLIC loses CONNECT.
//
// Roles are cluster-wide. `stack.mjs start` creates them with passwords
// (stored only in roles.env); this migration creates any that are missing
// (LOGIN, no password) so it also runs against a cluster prepared another way.
import type { Migration } from '../migrate.js';

export const APP_ROLES = [
  'nemodots_app',
  'nemodots_checkout',
  'nemodots_injector',
  'nemodots_verifier',
] as const;
export const SCHEMAS = ['ledger', 'coordinator', 'checkout', 'control'] as const;

const createRole = (role: string) => `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    BEGIN
      CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- created concurrently by another database's migration
    END;
  END IF;
END
$$`;

const DEFAULTS = 'ALTER DEFAULT PRIVILEGES FOR ROLE nemodots_admin IN SCHEMA';

const migration: Migration = {
  id: '0001_bootstrap',
  async up(client) {
    for (const role of APP_ROLES) await client.query(createRole(role));

    for (const schema of SCHEMAS) {
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION nemodots_admin`,
      );
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
    }

    await client.query(`
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO nemodots_app, nemodots_checkout, nemodots_injector, nemodots_verifier',
    current_database());
END
$$`);

    const statements = [
      // app: ledger + coordinator DML, checkout read
      'GRANT USAGE ON SCHEMA ledger, coordinator, checkout TO nemodots_app',
      `${DEFAULTS} ledger, coordinator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nemodots_app`,
      `${DEFAULTS} ledger, coordinator GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO nemodots_app`,
      `${DEFAULTS} checkout GRANT SELECT ON TABLES TO nemodots_app`,
      // checkout API: its own schema only
      'GRANT USAGE ON SCHEMA checkout TO nemodots_checkout',
      `${DEFAULTS} checkout GRANT SELECT ON TABLES TO nemodots_checkout`,
      `${DEFAULTS} checkout GRANT USAGE, SELECT ON SEQUENCES TO nemodots_checkout`,
      // injector: control DML; checkout config writes are granted per table later
      'GRANT USAGE ON SCHEMA checkout, control TO nemodots_injector',
      `${DEFAULTS} control GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nemodots_injector`,
      `${DEFAULTS} control GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO nemodots_injector`,
      // verifier: read everything, write nothing
      'GRANT USAGE ON SCHEMA ledger, coordinator, checkout, control TO nemodots_verifier',
      `${DEFAULTS} ledger, coordinator, checkout, control GRANT SELECT ON TABLES TO nemodots_verifier`,
      `${DEFAULTS} ledger, coordinator, checkout, control GRANT SELECT ON SEQUENCES TO nemodots_verifier`,
    ];
    for (const statement of statements) await client.query(statement);
  },
};

export default migration;
