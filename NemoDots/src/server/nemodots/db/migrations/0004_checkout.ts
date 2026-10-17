// 0004: the checkout sandbox schema (ARCHITECTURE.md sections 3, 5.1, 9) and
// the control schema used by the private fault injector.
//
// checkout.products / inventory / inventory_replica / orders / order_items
//   Business data written only by the checkout API (nemodots_checkout).
//   inventory_replica is a frozen snapshot that stands in for a lagging read
//   replica (fault class F4); the API never writes it. orders.probe_run_id
//   tags the single acceptance-probe order per run.
// checkout.config_entries / config_versions / config_collection
//   The version authority of the controlled sources (section 5.1). Written
//   only through sandbox/version-authority.ts::advanceConfig. config_versions
//   is append-only history (also the self-write classification history, C7).
//   config_collection is a singleton whose version advances ONLY on key
//   insert/delete (C1).
// control.scenario_runs / fault_schedules
//   Injector bookkeeping, readable by nemodots_verifier only.
//
// Grants beyond the 0001 defaults (nemodots_app: SELECT on checkout; checkout:
// SELECT on checkout; injector: DML on control; verifier: SELECT everywhere):
//   app       UPDATE config_entries, config_collection; INSERT config_versions
//   injector  SELECT/INSERT/UPDATE/DELETE config_entries, config_collection;
//             SELECT/INSERT config_versions (history is append-only)
//   checkout  INSERT orders, order_items; UPDATE inventory (stock decrement)
//
// The BEFORE INSERT OR UPDATE trigger on config_entries and the BEFORE INSERT
// trigger on config_versions null caused_by_action_id unless the writing role
// is nemodots_app (I14): the marker is server-authored only.
import type { Migration } from '../migrate.js';

const migration: Migration = {
  id: '0004_checkout',
  async up(client) {
    await client.query(`
CREATE TABLE checkout.products (
  sku         text PRIMARY KEY CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category    text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  listed      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
)`);
    // No non-negative CHECK on quantity: an oversell caused by stale replica
    // routing (F4) must be representable and visible to the verifier.
    await client.query(`
CREATE TABLE checkout.inventory (
  sku        text PRIMARY KEY REFERENCES checkout.products (sku),
  quantity   integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`);
    await client.query(`
CREATE TABLE checkout.inventory_replica (
  sku           text PRIMARY KEY REFERENCES checkout.products (sku),
  quantity      integer NOT NULL,
  replicated_at timestamptz NOT NULL DEFAULT now()
)`);
    await client.query(`
CREATE TABLE checkout.orders (
  id           uuid PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  customer     text NOT NULL,
  total_cents  integer NOT NULL CHECK (total_cents >= 0),
  probe_run_id text CHECK (probe_run_id IS NULL OR probe_run_id ~ '^[a-z0-9-]{8,64}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
)`);
    await client.query(
      'CREATE INDEX orders_created_at_idx ON checkout.orders (created_at DESC)',
    );
    await client.query(
      'CREATE INDEX orders_probe_run_idx ON checkout.orders (probe_run_id) WHERE probe_run_id IS NOT NULL',
    );
    await client.query(`
CREATE TABLE checkout.order_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES checkout.orders (id),
  sku         text NOT NULL REFERENCES checkout.products (sku),
  quantity    integer NOT NULL CHECK (quantity > 0),
  price_cents integer NOT NULL CHECK (price_cents >= 0)
)`);
    await client.query(
      'CREATE INDEX order_items_order_idx ON checkout.order_items (order_id)',
    );

    await client.query(`
CREATE TABLE checkout.config_entries (
  key                  text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{0,60}$'),
  value                jsonb NOT NULL,
  version              bigint NOT NULL CHECK (version >= 1),
  caused_by_action_id  uuid,
  caused_by_actor      text NOT NULL CHECK (caused_by_actor IN ('action', 'injector', 'owner', 'seed')),
  updated_at           timestamptz NOT NULL DEFAULT now()
)`);
    await client.query(`
CREATE TABLE checkout.config_versions (
  key                  text NOT NULL,
  version              bigint NOT NULL CHECK (version >= 1),
  value                jsonb,
  before_digest        text CHECK (before_digest IS NULL OR before_digest ~ '^[0-9a-f]{64}$'),
  after_digest         text CHECK (after_digest IS NULL OR after_digest ~ '^[0-9a-f]{64}$'),
  caused_by_action_id  uuid,
  caused_by_actor      text NOT NULL CHECK (caused_by_actor IN ('action', 'injector', 'owner', 'seed')),
  at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version)
)`);
    await client.query(`
CREATE TABLE checkout.config_collection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version   bigint NOT NULL CHECK (version >= 1)
)`);
    await client.query(
      'INSERT INTO checkout.config_collection (singleton, version) VALUES (true, 1)',
    );

    await client.query(`
CREATE FUNCTION checkout.null_untrusted_caused_by() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'nemodots_app' THEN
    NEW.caused_by_action_id := NULL;
  END IF;
  RETURN NEW;
END
$$`);
    await client.query(`
CREATE TRIGGER config_entries_caused_by
  BEFORE INSERT OR UPDATE ON checkout.config_entries
  FOR EACH ROW EXECUTE FUNCTION checkout.null_untrusted_caused_by()`);
    await client.query(`
CREATE TRIGGER config_versions_caused_by
  BEFORE INSERT ON checkout.config_versions
  FOR EACH ROW EXECUTE FUNCTION checkout.null_untrusted_caused_by()`);
    await client.query(`
CREATE FUNCTION checkout.config_versions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'checkout.config_versions is append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END
$$`);
    await client.query(`
CREATE TRIGGER config_versions_immutable
  BEFORE UPDATE OR DELETE ON checkout.config_versions
  FOR EACH ROW EXECUTE FUNCTION checkout.config_versions_append_only()`);

    await client.query(`
CREATE TABLE control.scenario_runs (
  id              uuid PRIMARY KEY,
  scenario_id     text NOT NULL,
  seed            integer NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  status          text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
)`);
    await client.query(`
CREATE TABLE control.fault_schedules (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES control.scenario_runs (id) ON DELETE CASCADE,
  step_index     integer NOT NULL CHECK (step_index >= 0),
  kind           text NOT NULL CHECK (kind IN ('set_config', 'insert_config', 'delete_config', 'dependent_change_after_proposal')),
  config_key     text,
  resolved_value jsonb,
  trigger        text NOT NULL CHECK (trigger IN ('immediate', 'delay', 'on_action_proposed')),
  delay_ms       integer CHECK (delay_ms IS NULL OR delay_ms >= 0),
  status         text NOT NULL CHECK (status IN ('pending', 'applied', 'skipped', 'failed')),
  applied_at     timestamptz,
  version_before bigint,
  version_after  bigint,
  error          text,
  UNIQUE (run_id, step_index)
)`);

    const grants = [
      // version authority writers
      'GRANT UPDATE ON checkout.config_entries, checkout.config_collection TO nemodots_app',
      'GRANT INSERT ON checkout.config_versions TO nemodots_app',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON checkout.config_entries, checkout.config_collection TO nemodots_injector',
      'GRANT SELECT, INSERT ON checkout.config_versions TO nemodots_injector',
      // the checkout API: stock decrement and order creation only
      'GRANT UPDATE ON checkout.inventory TO nemodots_checkout',
      'GRANT INSERT ON checkout.orders, checkout.order_items TO nemodots_checkout',
    ];
    for (const statement of grants) await client.query(statement);
  },
};

export default migration;
