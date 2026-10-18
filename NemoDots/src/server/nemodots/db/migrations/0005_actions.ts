// 0005_actions: the action boundary tables (ARCHITECTURE.md sections 4-5,
// CONTRACTS.md section 5): coordinator.action_intents, authorizations and
// result_receipts, plus the dispatch fence sequence.
//
// - Every status/enum column carries a CHECK generated from the contract enum.
// - The idempotency index is PARTIAL (C5): only live intents reserve a key, so
//   a blocked/failed/cancelled intent never prevents a fresh proposal.
// - The immutable half of an intent (identity, payload, vector, target,
//   policy, key) cannot be updated by anyone, owner included: changing any of
//   it needs a new intent and a new authorization.
// - authorizations are append-only (no UPDATE/DELETE for any role).
// - Inserting a proposed intent NOTIFYs nemodots_action_proposed with the
//   TARGET KEY only (C15): the injector reads no coordinator table.
// - The ledger closure marks live intents with
//   UPDATE ... SET status, status_version, block_reason, block_detail; those
//   columns stay mutable, and the CHECKs below accept its writes.
import type { Migration } from '../migrate.js';
import {
  ActionAdapterSchema,
  ActionKindSchema,
  ActionStatusSchema,
  AuthorizationDecisionSchema,
  AuthorizationStageSchema,
  BlockReasonSchema,
  CapabilitySchema,
  FailureReasonSchema,
} from '../../contracts/index.js';

const list = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');
const inEnum = (column: string, values: readonly string[]) =>
  `CHECK (${column} IN (${list(values)}))`;
const inEnumOrNull = (column: string, values: readonly string[]) =>
  `CHECK (${column} IS NULL OR ${column} IN (${list(values)}))`;

const HEX64 = "'^[0-9a-f]{64}$'";
const LIVE =
  "('proposed', 'admitted', 'committed', 'dispatched', 'outcome_unknown')";

const IMMUTABLE_COLUMNS = [
  'mission_id',
  'task_id',
  'attempt_id',
  'model_call_id',
  'tool_call_id',
  'author_fencing_token',
  'generation',
  'action',
  'adapter',
  'payload',
  'payload_hash',
  'supporting_receipt_ids',
  'target',
  'actor_capability',
  'dependency_vector',
  'required_sources',
  'expected_target_version',
  'policy_version',
  'idempotency_key',
  'expires_at',
  'rationale',
  'proposed_at',
];

const migration: Migration = {
  id: '0005_actions',
  async up(client) {
    const q = (sql: string) => client.query(sql);

    await q('CREATE SEQUENCE coordinator.action_dispatch_seq AS integer');

    await q(`
CREATE TABLE coordinator.action_intents (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  task_id uuid NOT NULL REFERENCES coordinator.tasks (id),
  attempt_id uuid NOT NULL REFERENCES coordinator.task_attempts (id),
  model_call_id uuid NOT NULL,
  tool_call_id text NOT NULL CHECK (char_length(tool_call_id) BETWEEN 1 AND 200),
  author_fencing_token integer NOT NULL CHECK (author_fencing_token >= 0),
  generation integer NOT NULL CHECK (generation >= 0),
  action text NOT NULL ${inEnum('action', ActionKindSchema.options)},
  adapter text NOT NULL ${inEnum('adapter', ActionAdapterSchema.options)},
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ ${HEX64}),
  supporting_receipt_ids uuid[] NOT NULL DEFAULT '{}',
  target jsonb NOT NULL,
  actor_capability text NOT NULL ${inEnum('actor_capability', CapabilitySchema.options)},
  dependency_vector jsonb NOT NULL,
  required_sources text[] NOT NULL,
  expected_target_version integer NOT NULL CHECK (expected_target_version >= 0),
  policy_version text NOT NULL CHECK (policy_version = 'policy-v1'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ ${HEX64}),
  expires_at timestamptz NOT NULL,
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 1000),
  status text NOT NULL ${inEnum('status', ActionStatusSchema.options)},
  status_version integer NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  block_reason text ${inEnumOrNull('block_reason', BlockReasonSchema.options)},
  block_detail text,
  failure_reason text ${inEnumOrNull('failure_reason', FailureReasonSchema.options)},
  dispatch_fence integer CHECK (dispatch_fence IS NULL OR dispatch_fence > 0),
  dispatch_owner text,
  dispatcher_lease_expires_at timestamptz,
  committed_target_version integer,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  admitted_at timestamptz,
  committed_at timestamptz,
  dispatched_at timestamptz,
  verified_at timestamptz,
  failed_at timestamptz,
  CHECK ((status = 'blocked') = (block_reason IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK (
    dispatch_fence IS NULL
    OR (dispatch_owner IS NOT NULL AND dispatcher_lease_expires_at IS NOT NULL)
  ),
  CHECK (status NOT IN ('committed', 'dispatched') OR dispatch_fence IS NOT NULL)
)`);

    // C5: only LIVE intents reserve an idempotency key.
    await q(
      `CREATE UNIQUE INDEX action_intents_live_key_idx
         ON coordinator.action_intents (idempotency_key) WHERE status IN ${LIVE}`,
    );
    await q(
      'CREATE INDEX action_intents_key_idx ON coordinator.action_intents (idempotency_key, payload_hash)',
    );
    await q(
      'CREATE INDEX action_intents_mission_idx ON coordinator.action_intents (mission_id, proposed_at)',
    );
    await q(
      `CREATE INDEX action_intents_open_idx ON coordinator.action_intents (status, dispatcher_lease_expires_at)
         WHERE status IN ('proposed', 'admitted', 'committed', 'dispatched', 'outcome_unknown')`,
    );

    await q(`
CREATE FUNCTION coordinator.action_intents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ${IMMUTABLE_COLUMNS.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join('\n     OR ')} THEN
    RAISE EXCEPTION 'action intent % is immutable except for its lifecycle columns', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status_version <= OLD.status_version THEN
    RAISE EXCEPTION 'action intent % changed status without advancing status_version', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER action_intents_guard BEFORE UPDATE ON coordinator.action_intents
FOR EACH ROW EXECUTE FUNCTION coordinator.action_intents_guard()`);

    // C15: the NOTIFY names the TARGET KEY only.
    await q(`
CREATE FUNCTION coordinator.notify_action_proposed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'nemodots_action_proposed',
    json_build_object('key', regexp_replace(NEW.target ->> 'sourceKey', '^checkout\\.config/', ''))::text
  );
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER action_intents_notify AFTER INSERT ON coordinator.action_intents
FOR EACH ROW WHEN (NEW.status = 'proposed')
EXECUTE FUNCTION coordinator.notify_action_proposed()`);

    await q(`
CREATE TABLE coordinator.authorizations (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES coordinator.action_intents (id),
  stage text NOT NULL ${inEnum('stage', AuthorizationStageSchema.options)},
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision text NOT NULL ${inEnum('decision', AuthorizationDecisionSchema.options)},
  block_reason text ${inEnumOrNull('block_reason', BlockReasonSchema.options)},
  checked_vector jsonb NOT NULL,
  target_version jsonb NOT NULL,
  author_fence jsonb NOT NULL,
  dispatch_fence jsonb,
  policy_version text NOT NULL CHECK (policy_version = 'policy-v1'),
  idempotency_binding text NOT NULL CHECK (idempotency_binding IN ('new', 'same_payload', 'conflict')),
  CHECK ((decision = 'blocked') = (block_reason IS NOT NULL))
)`);
    await q(
      'CREATE INDEX authorizations_action_idx ON coordinator.authorizations (action_id, decided_at)',
    );
    await q(
      'REVOKE UPDATE, DELETE ON coordinator.authorizations FROM nemodots_app',
    );
    await q(`
CREATE FUNCTION coordinator.authorizations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authorizations are append-only' USING ERRCODE = 'integrity_constraint_violation';
END
$$`);
    await q(`
CREATE TRIGGER authorizations_append_only BEFORE UPDATE OR DELETE ON coordinator.authorizations
FOR EACH ROW EXECUTE FUNCTION coordinator.authorizations_append_only()`);

    // One receipt per intent: the commit creates it, dispatch and settlement
    // advance its outcome. Duplicate delivery returns this row (C2).
    await q(`
CREATE TABLE coordinator.result_receipts (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL UNIQUE REFERENCES coordinator.action_intents (id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ ${HEX64}),
  payload_hash text NOT NULL CHECK (payload_hash ~ ${HEX64}),
  outcome text NOT NULL CHECK (outcome IN ('committed', 'dispatched', 'verified', 'failed', 'outcome_unknown')),
  control_plane jsonb,
  external_effect jsonb,
  postcondition jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
)`);
    await q(`
CREATE FUNCTION coordinator.result_receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.action_id IS DISTINCT FROM OLD.action_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.control_plane IS DISTINCT FROM OLD.control_plane THEN
    RAISE EXCEPTION 'the committed part of a result receipt is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER result_receipts_guard BEFORE UPDATE ON coordinator.result_receipts
FOR EACH ROW EXECUTE FUNCTION coordinator.result_receipts_guard()`);
  },
};

export default migration;
