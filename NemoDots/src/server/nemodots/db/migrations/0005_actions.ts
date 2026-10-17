// 0005: the action boundary (ARCHITECTURE.md sections 4-6, CONTRACTS.md
// section 5): action_intents, authorizations, result_receipts and the dispatch
// fence sequence.
//
// coordinator.action_intents
//   One row per proposal. The row is the unit the admission and commit
//   transactions lock first (FOR UPDATE), so duplicate deliveries serialise on
//   it (C2). Columns beyond the contract DTO:
//     model_call_id, tool_call_id   the emitting call (C5, C10)
//     dispatch_fence / dispatch_owner / dispatcher_lease_expires_at
//                                   the dispatch lease granted at admission and
//                                   re-granted by re-admission or claimDispatch (C4)
//     committed_target_version      the target version after the commit (set_config:
//                                   the new version; flush: the unchanged
//                                   cache.namespace version claimDispatch
//                                   compares, C11)
//     compensates_action_id         set only on compensation intents
//   Immutable once inserted (trigger): everything that binds the decision to a
//   payload (payload, payload_hash, target, vector, expected version, policy,
//   idempotency key, identity columns). The status column only moves along
//   ACTION_TRANSITIONS (generated from the contract, so SQL and code cannot
//   drift).
//   Partial unique index on idempotency_key WHERE status IN LIVE_STATUSES (C5):
//   blocked, failed, cancelled and verified intents do not reserve their key.
//   AFTER INSERT of a `proposed` row notifies nemodots_action_proposed with the
//   target config key only (the injector's "dependent change after proposal"
//   trigger, finding C15).
//
// coordinator.authorizations   immutable, one per decision (admission, commit,
//                              dispatch, re-admission). A partial unique index
//                              makes a second commit Authorization impossible
//                              (C2 backstop). A trigger records the decision
//                              when the ledger's invalidation closure blocks a
//                              live intent (it writes status/block_reason
//                              only), unless the actions package already wrote
//                              its own row in the same transaction.
// coordinator.result_receipts  immutable, one per (action, outcome).
// coordinator.action_dispatch_seq  source of dispatch fences (monotonic).
import type { Migration } from '../migrate.js';
import {
  ACTION_TRANSITIONS,
  ActionAdapterSchema,
  ActionKindSchema,
  ActionStatusSchema,
  AuthorizationDecisionSchema,
  AuthorizationStageSchema,
  BlockReasonSchema,
  CapabilitySchema,
  EnvironmentSchema,
  FailureReasonSchema,
  LIVE_STATUSES,
} from '../../contracts/index.js';

const list = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');
const inEnum = (column: string, values: readonly string[]) =>
  `CHECK (${column} IN (${list(values)}))`;
const inEnumOrNull = (column: string, values: readonly string[]) =>
  `CHECK (${column} IS NULL OR ${column} IN (${list(values)}))`;

const HEX64 = "'^[0-9a-f]{64}$'";
const OUTCOMES = [
  'committed',
  'dispatched',
  'verified',
  'failed',
  'outcome_unknown',
] as const;

/** `(OLD.status = 'a' AND NEW.status IN ('b','c')) OR ...` from the contract table. */
const transitionPredicate = () =>
  ActionStatusSchema.options
    .filter((from) => ACTION_TRANSITIONS[from].length > 0)
    .map(
      (from) =>
        `(OLD.status = '${from}' AND NEW.status IN (${list(ACTION_TRANSITIONS[from])}))`,
    )
    .join('\n       OR ');

const IMMUTABLE_COLUMNS = [
  'id',
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
  'target_resource',
  'target_source_key',
  'target_environment',
  'actor_capability',
  'dependency_vector',
  'required_sources',
  'expected_target_version',
  'policy_version',
  'idempotency_key',
  'expires_at',
  'rationale',
  'compensates_action_id',
  'proposed_at',
] as const;

const migration: Migration = {
  id: '0005_actions',
  async up(client) {
    const q = (sql: string) => client.query(sql);

    await q('CREATE SEQUENCE coordinator.action_dispatch_seq AS bigint');

    await q(`
CREATE TABLE coordinator.action_intents (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  task_id uuid NOT NULL REFERENCES coordinator.tasks (id),
  attempt_id uuid NOT NULL REFERENCES coordinator.task_attempts (id),
  model_call_id uuid NOT NULL,
  tool_call_id text NOT NULL CHECK (char_length(tool_call_id) BETWEEN 1 AND 256),
  author_fencing_token integer NOT NULL CHECK (author_fencing_token >= 0),
  generation integer NOT NULL CHECK (generation >= 0),
  action text NOT NULL ${inEnum('action', ActionKindSchema.options)},
  adapter text NOT NULL ${inEnum('adapter', ActionAdapterSchema.options)},
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ ${HEX64}),
  target_resource text NOT NULL CHECK (target_resource = 'checkout'),
  target_source_key text NOT NULL CHECK (target_source_key ~ '^checkout\\.config/[a-z][a-z0-9_.]{0,60}$'),
  target_environment text NOT NULL ${inEnum('target_environment', EnvironmentSchema.options)},
  actor_capability text NOT NULL ${inEnum('actor_capability', CapabilitySchema.options)},
  dependency_vector jsonb NOT NULL,
  required_sources text[] NOT NULL,
  expected_target_version bigint NOT NULL CHECK (expected_target_version >= 0),
  policy_version text NOT NULL ${inEnum('policy_version', ['policy-v1'])},
  idempotency_key text NOT NULL CHECK (idempotency_key ~ ${HEX64}),
  expires_at timestamptz NOT NULL,
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 1000),
  status text NOT NULL ${inEnum('status', ActionStatusSchema.options)},
  status_version integer NOT NULL DEFAULT 0 CHECK (status_version >= 0),
  block_reason text ${inEnumOrNull('block_reason', BlockReasonSchema.options)},
  block_detail text CHECK (block_detail IS NULL OR char_length(block_detail) <= 1000),
  failure_reason text ${inEnumOrNull('failure_reason', FailureReasonSchema.options)},
  dispatch_fence bigint CHECK (dispatch_fence IS NULL OR dispatch_fence > 0),
  dispatch_owner text,
  dispatcher_lease_expires_at timestamptz,
  committed_target_version bigint CHECK (committed_target_version IS NULL OR committed_target_version >= 0),
  compensates_action_id uuid REFERENCES coordinator.action_intents (id),
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admitted_at timestamptz,
  committed_at timestamptz,
  dispatched_at timestamptz,
  verified_at timestamptz,
  failed_at timestamptz,
  CHECK ((status = 'blocked') = (block_reason IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK (status NOT IN ('admitted', 'committed', 'dispatched')
         OR (dispatch_fence IS NOT NULL AND dispatch_owner IS NOT NULL
             AND dispatcher_lease_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('committed', 'dispatched', 'verified', 'outcome_unknown')
         OR committed_target_version IS NOT NULL)
)`);

    await q(`
CREATE UNIQUE INDEX action_intents_idempotency_live_idx
  ON coordinator.action_intents (idempotency_key)
  WHERE status IN (${list(LIVE_STATUSES)})`);
    await q(
      'CREATE INDEX action_intents_idempotency_idx ON coordinator.action_intents (idempotency_key, proposed_at)',
    );
    await q(
      'CREATE INDEX action_intents_mission_idx ON coordinator.action_intents (mission_id, status)',
    );
    await q(
      'CREATE INDEX action_intents_attempt_idx ON coordinator.action_intents (attempt_id)',
    );
    await q(`
CREATE INDEX action_intents_lease_idx
  ON coordinator.action_intents (dispatcher_lease_expires_at)
  WHERE status = 'admitted'`);
    await q(`
CREATE INDEX action_intents_open_effect_idx
  ON coordinator.action_intents (committed_at)
  WHERE status IN ('committed', 'dispatched', 'outcome_unknown')`);
    await q(`
CREATE UNIQUE INDEX action_intents_one_live_compensation_idx
  ON coordinator.action_intents (compensates_action_id)
  WHERE compensates_action_id IS NOT NULL
    AND status IN (${list(LIVE_STATUSES)})`);

    // Binding columns never change; status moves only along the contract table.
    await q(`
CREATE FUNCTION coordinator.action_intents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ${IMMUTABLE_COLUMNS.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join('\n     OR ')} THEN
    RAISE EXCEPTION 'action intent % binding columns are immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       ${transitionPredicate()}) THEN
    RAISE EXCEPTION 'illegal action transition % -> % for %', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status_version < OLD.status_version THEN
    RAISE EXCEPTION 'status_version of % cannot go down', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER action_intents_guard BEFORE UPDATE ON coordinator.action_intents
FOR EACH ROW EXECUTE FUNCTION coordinator.action_intents_guard()`);

    await q(`
CREATE FUNCTION coordinator.notify_action_proposed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'proposed' THEN
    PERFORM pg_notify('nemodots_action_proposed', NEW.target_source_key);
  END IF;
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER action_intents_notify AFTER INSERT ON coordinator.action_intents
FOR EACH ROW EXECUTE FUNCTION coordinator.notify_action_proposed()`);

    await q(`
CREATE TABLE coordinator.authorizations (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  action_id uuid NOT NULL REFERENCES coordinator.action_intents (id),
  stage text NOT NULL ${inEnum('stage', AuthorizationStageSchema.options)},
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision text NOT NULL ${inEnum('decision', AuthorizationDecisionSchema.options)},
  block_reason text ${inEnumOrNull('block_reason', BlockReasonSchema.options)},
  block_detail text CHECK (block_detail IS NULL OR char_length(block_detail) <= 1000),
  checked_vector jsonb NOT NULL,
  target_expected bigint NOT NULL CHECK (target_expected >= 0),
  target_live bigint NOT NULL CHECK (target_live >= 0),
  author_fence_token integer NOT NULL CHECK (author_fence_token >= 0),
  author_fence_valid boolean NOT NULL,
  dispatch_fence_token bigint,
  dispatch_fence_valid boolean,
  policy_version text NOT NULL ${inEnum('policy_version', ['policy-v1'])},
  idempotency_binding text NOT NULL ${inEnum('idempotency_binding', ['new', 'same_payload', 'conflict'])},
  CHECK ((decision = 'blocked') = (block_reason IS NOT NULL)),
  CHECK ((dispatch_fence_token IS NULL) = (dispatch_fence_valid IS NULL)),
  CHECK (decision = 'blocked'
         OR decision = CASE stage WHEN 'admission' THEN 'admitted'
                                  WHEN 'commit' THEN 'committed'
                                  ELSE 'dispatched' END)
)`);
    await q(
      'CREATE INDEX authorizations_action_idx ON coordinator.authorizations (action_id, seq)',
    );
    // C2 backstop: a second commit Authorization for one action cannot exist.
    await q(`
CREATE UNIQUE INDEX authorizations_one_commit_idx
  ON coordinator.authorizations (action_id)
  WHERE stage = 'commit' AND decision = 'committed'`);

    await q(`
CREATE TABLE coordinator.result_receipts (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  action_id uuid NOT NULL REFERENCES coordinator.action_intents (id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ ${HEX64}),
  payload_hash text NOT NULL CHECK (payload_hash ~ ${HEX64}),
  outcome text NOT NULL ${inEnum('outcome', OUTCOMES)},
  control_plane jsonb,
  external_effect jsonb,
  postcondition jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (action_id, outcome)
)`);
    await q(
      'CREATE INDEX result_receipts_action_idx ON coordinator.result_receipts (action_id, seq)',
    );

    // authorizations and result_receipts are append-only for every role.
    await q(`
CREATE FUNCTION coordinator.action_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$`);
    for (const table of ['authorizations', 'result_receipts'])
      await q(`
CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON coordinator.${table}
FOR EACH ROW EXECUTE FUNCTION coordinator.action_append_only()`);
    await q(
      'REVOKE UPDATE, DELETE ON coordinator.authorizations, coordinator.result_receipts FROM nemodots_app',
    );

    // The ledger closure blocks live intents with a bare UPDATE
    // (status/block_reason/block_detail). That is a decision too: record it,
    // unless the actions package wrote its own Authorization in this
    // transaction (it sets nemodots.authz_by_writer for the transaction).
    // Only facts the trigger can read are recorded: no vector was checked, so
    // checked_vector is empty; the live target version is read from the
    // authority.
    await q(`
CREATE FUNCTION coordinator.record_closure_block() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('proposed', 'admitted') AND NEW.status = 'blocked'
     AND COALESCE(current_setting('nemodots.authz_by_writer', true), '') <> '1' THEN
    INSERT INTO coordinator.authorizations
      (id, action_id, stage, decision, block_reason, block_detail, checked_vector,
       target_expected, target_live, author_fence_token, author_fence_valid,
       dispatch_fence_token, dispatch_fence_valid, policy_version, idempotency_binding)
    VALUES (
      gen_random_uuid(), NEW.id,
      CASE OLD.status WHEN 'proposed' THEN 'admission' ELSE 'commit' END,
      'blocked', NEW.block_reason, NEW.block_detail, '[]'::jsonb,
      NEW.expected_target_version,
      COALESCE((SELECT version FROM checkout.config_entries
                 WHERE key = substr(NEW.target_source_key, 17)), 0),
      NEW.author_fencing_token, true,
      NEW.dispatch_fence,
      CASE WHEN NEW.dispatch_fence IS NULL THEN NULL
           ELSE COALESCE(NEW.dispatcher_lease_expires_at > clock_timestamp(), false) END,
      NEW.policy_version, 'new');
  END IF;
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER action_intents_record_closure_block
AFTER UPDATE OF status ON coordinator.action_intents
FOR EACH ROW EXECUTE FUNCTION coordinator.record_closure_block()`);
  },
};

export default migration;
