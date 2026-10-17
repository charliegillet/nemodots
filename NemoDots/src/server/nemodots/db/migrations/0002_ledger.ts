// 0002: the ledger schema (ARCHITECTURE.md sections 3 and 5, CONTRACTS.md
// sections 2, 3, 4 and 6; finding ids in brackets refer to ARCHITECTURE 14).
//
//   sources               one row per (owner, environment, resource, key); the
//                         row is the serialization point of registration and
//                         closure for observed sources [C8]. It never stores a
//                         version: controlled versions live in
//                         checkout.config_entries / config_collection only.
//   source_revisions      one row per minted revision (append-only), carrying
//                         caused_by_action_id for self-write classification.
//   observation_receipts  immutable evidence. Only status, status_version and
//                         superseded_by may change, only along the receipt
//                         transition table, enforced by a trigger.
//   receipt_confirmations append-only freshness confirmations [I2/D3].
//   receipt_transitions   append-only status history.
//   context_snapshots, model_call_records, inference_attempts
//                         one fenced record per model call; attempts of a call
//                         whose fenced record was rejected are stored alone
//                         with outcome 'orphaned_fence' [C16].
//   dependency_nodes, dependency_edges
//                         the evidence / inheritance / scheduling graph that
//                         the invalidation closure walks.
//   invalidation_events   one row per changed receipt, with the global
//                         `affected` set and the per-mission partition [I10].
//
// Every status or enum column carries a CHECK equal to its contract enum.
// Grants come from the default privileges of 0001 (app: DML, verifier:
// SELECT); immutability and append-only rules are triggers, so they hold for
// the owner role as well.
import type { Migration } from '../migrate.js';

const enumCheck = (column: string, values: readonly string[]) =>
  `CHECK (${column} IN (${values.map((value) => `'${value}'`).join(', ')}))`;

const SOURCE_TYPES = [
  'controlled_config',
  'controlled_collection',
  'observed_endpoint',
  'observed_store',
  'probe',
  'runbook',
  'page_snapshot',
  'memory_snapshot',
] as const;
const RECEIPT_STATUSES = [
  'supported',
  'superseded',
  'contested',
  'retracted',
  'expired',
] as const;
const TRUST_CLASSES = [
  'controlled_authority',
  'probe',
  'observed_tool',
  'page_snapshot',
  'memory_snapshot',
  'runbook',
] as const;
const PROVENANCE_KINDS = [
  'watcher',
  'tool_call',
  'probe',
  'commit_postcondition',
  'owner_edit',
] as const;
const TRANSITION_REASONS = [
  'newer_observation',
  'conflicting_observation',
  'owner_retraction',
  'ttl_elapsed',
  'source_removed',
  'resolved',
] as const;
const INVALIDATION_REASONS = [
  'newer_observation',
  'conflicting_observation',
  'retraction',
  'expiry',
  'self_write_mismatch',
  'collection_changed',
  'publication_rejected',
  'closure_cap_exceeded',
] as const;
const MODEL_ROLES = [
  'planner',
  'worker',
  'repair',
  'replan',
  'summarizer',
] as const;
const MODEL_CALL_OUTCOMES = [
  'completed',
  'tool_calls',
  'aborted',
  'failed',
  'invalid_output',
] as const;
const FINISH_REASONS = [
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'cancelled',
  'error',
] as const;
const INFERENCE_ERROR_CLASSES = [
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'provider_error',
  'network',
  'invalid_response',
  'cancelled',
] as const;
const NODE_KINDS = [
  'receipt',
  'model_call',
  'attempt',
  'task_output',
  'task',
  'action_intent',
] as const;

/** Legal receipt transitions (contracts/transitions.ts RECEIPT_TRANSITIONS). */
const RECEIPT_TRANSITION_PAIRS = [
  ['supported', 'superseded'],
  ['supported', 'contested'],
  ['supported', 'retracted'],
  ['supported', 'expired'],
  ['contested', 'supported'],
  ['contested', 'retracted'],
] as const;
const transitionPairs = (from: string, to: string) =>
  `(${from}, ${to}) IN (${RECEIPT_TRANSITION_PAIRS.map(([a, b]) => `('${a}', '${b}')`).join(', ')})`;

const migration: Migration = {
  id: '0002_ledger',
  async up(client) {
    const statements: string[] = [
      `CREATE TABLE ledger.sources (
         id uuid PRIMARY KEY,
         owner_id text NOT NULL CHECK (owner_id <> ''),
         environment text NOT NULL ${enumCheck('environment', ['dev', 'test', 'eval'])},
         resource text NOT NULL CHECK (resource <> ''),
         key text NOT NULL CHECK (key <> '' AND length(key) <= 256),
         source_type text NOT NULL ${enumCheck('source_type', SOURCE_TYPES)},
         authority text NOT NULL ${enumCheck('authority', ['controlled', 'observed'])},
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT sources_identity UNIQUE (owner_id, environment, resource, key),
         CONSTRAINT sources_authority_matches_type CHECK (
           (authority = 'controlled') = (source_type IN ('controlled_config', 'controlled_collection'))
         )
       )`,

      `CREATE TABLE ledger.observation_receipts (
         id uuid PRIMARY KEY,
         source_id uuid NOT NULL REFERENCES ledger.sources (id),
         source_revision integer NOT NULL CHECK (source_revision >= 0),
         collection_revision integer CHECK (collection_revision >= 0),
         mission_id uuid NOT NULL,
         space_id text,
         observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
         normalized_value jsonb NOT NULL CHECK (octet_length(normalized_value::text) <= 65536),
         raw_ref jsonb,
         status text NOT NULL ${enumCheck('status', RECEIPT_STATUSES)},
         status_version integer NOT NULL DEFAULT 0 CHECK (status_version >= 0),
         supersedes uuid REFERENCES ledger.observation_receipts (id),
         superseded_by uuid REFERENCES ledger.observation_receipts (id),
         trust text NOT NULL ${enumCheck('trust', TRUST_CLASSES)},
         provenance_kind text NOT NULL ${enumCheck('provenance_kind', PROVENANCE_KINDS)},
         tool_call_id text,
         model_call_id uuid,
         attempt_id uuid,
         caused_by_action_id uuid,
         self_write text NOT NULL DEFAULT 'none' ${enumCheck('self_write', ['none', 'verified', 'mismatch'])},
         negative jsonb,
         expires_at timestamptz,
         CONSTRAINT receipts_source_revision UNIQUE (source_id, source_revision),
         CONSTRAINT receipts_no_self_supersession CHECK (supersedes IS NULL OR supersedes <> id),
         CONSTRAINT receipts_superseded_by_status CHECK (superseded_by IS NULL OR status = 'superseded')
       )`,
      `CREATE INDEX receipts_by_source ON ledger.observation_receipts (source_id, source_revision DESC)`,
      `CREATE INDEX receipts_by_status ON ledger.observation_receipts (status) WHERE status <> 'superseded'`,

      `CREATE TABLE ledger.source_revisions (
         source_id uuid NOT NULL REFERENCES ledger.sources (id),
         source_revision integer NOT NULL CHECK (source_revision >= 0),
         receipt_id uuid NOT NULL UNIQUE REFERENCES ledger.observation_receipts (id),
         content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
         caused_by_action_id uuid,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         PRIMARY KEY (source_id, source_revision)
       )`,

      `CREATE TABLE ledger.receipt_confirmations (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         receipt_id uuid NOT NULL REFERENCES ledger.observation_receipts (id),
         confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         provenance_kind text NOT NULL ${enumCheck('provenance_kind', ['watcher', 'tool_call', 'probe'])},
         attempt_id uuid,
         model_call_id uuid
       )`,
      `CREATE INDEX confirmations_by_receipt ON ledger.receipt_confirmations (receipt_id, confirmed_at DESC)`,

      `CREATE TABLE ledger.receipt_transitions (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         receipt_id uuid NOT NULL REFERENCES ledger.observation_receipts (id),
         from_status text NOT NULL ${enumCheck('from_status', RECEIPT_STATUSES)},
         to_status text NOT NULL ${enumCheck('to_status', RECEIPT_STATUSES)},
         reason text NOT NULL ${enumCheck('reason', TRANSITION_REASONS)},
         at timestamptz NOT NULL DEFAULT clock_timestamp(),
         event_id text NOT NULL CHECK (event_id <> ''),
         CONSTRAINT receipt_transitions_legal CHECK (${transitionPairs('from_status', 'to_status')})
       )`,
      `CREATE INDEX transitions_by_receipt ON ledger.receipt_transitions (receipt_id, id)`,

      `CREATE TABLE ledger.context_snapshots (
         id uuid PRIMARY KEY,
         mission_id uuid NOT NULL,
         context_schema_version text NOT NULL CHECK (context_schema_version = 'v1'),
         layout text NOT NULL ${enumCheck('layout', ['cache_aware', 'ordinary'])},
         prefix_digest text NOT NULL CHECK (prefix_digest ~ '^[0-9a-f]{64}$'),
         prefix_length integer NOT NULL CHECK (prefix_length >= 0),
         context_digest text NOT NULL CHECK (context_digest ~ '^[0-9a-f]{64}$'),
         context_length integer NOT NULL CHECK (context_length >= prefix_length),
         tool_schema_hash text NOT NULL CHECK (tool_schema_hash ~ '^[0-9a-f]{64}$'),
         injected jsonb NOT NULL,
         dependency_vector jsonb NOT NULL,
         volatile_now timestamptz NOT NULL,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,

      `CREATE TABLE ledger.model_call_records (
         id uuid PRIMARY KEY,
         scope jsonb NOT NULL,
         mission_id uuid NOT NULL,
         task_id uuid NOT NULL,
         attempt_id uuid NOT NULL,
         role text NOT NULL ${enumCheck('role', MODEL_ROLES)},
         model_requested text NOT NULL CHECK (model_requested <> ''),
         model_returned text,
         provider_host text NOT NULL CHECK (provider_host <> ''),
         provider_mode text NOT NULL ${enumCheck('provider_mode', ['live', 'fixture'])},
         context_snapshot_id uuid NOT NULL REFERENCES ledger.context_snapshots (id),
         outcome text NOT NULL ${enumCheck('outcome', MODEL_CALL_OUTCOMES)},
         output_digest text CHECK (output_digest ~ '^[0-9a-f]{64}$'),
         output_dependency_vector jsonb NOT NULL,
         tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
         created_at timestamptz NOT NULL
       )`,
      `CREATE INDEX model_calls_by_attempt ON ledger.model_call_records (attempt_id, created_at)`,
      `CREATE INDEX model_calls_by_mission ON ledger.model_call_records (mission_id, created_at)`,

      // model_call_id has no foreign key: an orphaned call (fence lost while
      // the request was in flight) has attempts but no fenced record [C16].
      `CREATE TABLE ledger.inference_attempts (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         model_call_id uuid NOT NULL,
         n integer NOT NULL CHECK (n > 0),
         mission_id uuid NOT NULL,
         task_id uuid NOT NULL,
         attempt_id uuid NOT NULL,
         role text NOT NULL ${enumCheck('role', MODEL_ROLES)},
         model_requested text NOT NULL CHECK (model_requested <> ''),
         model_returned text,
         provider_host text NOT NULL CHECK (provider_host <> ''),
         provider_mode text NOT NULL ${enumCheck('provider_mode', ['live', 'fixture'])},
         started_at timestamptz NOT NULL,
         headers_at timestamptz,
         first_content_at timestamptz,
         finished_at timestamptz,
         http_status integer CHECK (http_status BETWEEN 100 AND 599),
         prompt_tokens integer CHECK (prompt_tokens >= 0),
         completion_tokens integer CHECK (completion_tokens >= 0),
         cached_tokens integer CHECK (cached_tokens >= 0),
         reasoning_tokens integer CHECK (reasoning_tokens >= 0),
         finish_reason text CHECK (finish_reason IS NULL OR finish_reason IN (${FINISH_REASONS.map((v) => `'${v}'`).join(', ')})),
         error_class text CHECK (error_class IS NULL OR error_class IN (${INFERENCE_ERROR_CLASSES.map((v) => `'${v}'`).join(', ')})),
         error_code text,
         error_id text,
         retry_after_ms integer CHECK (retry_after_ms >= 0),
         streamed boolean NOT NULL,
         outcome text NOT NULL ${enumCheck('outcome', ['recorded', 'orphaned_fence'])},
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT inference_attempts_call_n UNIQUE (model_call_id, n)
       )`,
      `CREATE INDEX inference_attempts_by_mission ON ledger.inference_attempts (mission_id, outcome)`,

      // Nodes carry the mission and task of every graph member so the closure
      // is self-contained; receipts are shared across missions (mission_id NULL).
      `CREATE TABLE ledger.dependency_nodes (
         kind text NOT NULL ${enumCheck('kind', NODE_KINDS)},
         id uuid NOT NULL,
         mission_id uuid,
         task_id uuid,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         PRIMARY KEY (kind, id),
         CONSTRAINT dependency_nodes_receipts_are_shared CHECK (kind <> 'receipt' OR (mission_id IS NULL AND task_id IS NULL))
       )`,
      `CREATE INDEX dependency_nodes_by_mission ON ledger.dependency_nodes (mission_id, kind)`,

      `CREATE TABLE ledger.dependency_edges (
         id uuid PRIMARY KEY,
         seq bigint GENERATED ALWAYS AS IDENTITY,
         mission_id uuid NOT NULL,
         kind text NOT NULL ${enumCheck('kind', ['evidence', 'inheritance', 'scheduling'])},
         from_kind text NOT NULL ${enumCheck('from_kind', NODE_KINDS)},
         from_id uuid NOT NULL,
         to_kind text NOT NULL ${enumCheck(
           'to_kind',
           NODE_KINDS.filter((kind) => kind !== 'receipt'),
         )},
         to_id uuid NOT NULL,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT dependency_edges_unique UNIQUE (kind, from_kind, from_id, to_kind, to_id),
         CONSTRAINT dependency_edges_no_self_loop CHECK (NOT (from_kind = to_kind AND from_id = to_id)),
         CONSTRAINT dependency_edges_scheduling_between_tasks CHECK (kind <> 'scheduling' OR (from_kind = 'task' AND to_kind = 'task')),
         CONSTRAINT dependency_edges_from_node FOREIGN KEY (from_kind, from_id) REFERENCES ledger.dependency_nodes (kind, id),
         CONSTRAINT dependency_edges_to_node FOREIGN KEY (to_kind, to_id) REFERENCES ledger.dependency_nodes (kind, id)
       )`,
      `CREATE INDEX dependency_edges_forward ON ledger.dependency_edges (from_kind, from_id) WHERE kind IN ('evidence', 'inheritance')`,
      `CREATE INDEX dependency_edges_backward ON ledger.dependency_edges (to_kind, to_id)`,
      `CREATE INDEX dependency_edges_by_seq ON ledger.dependency_edges (seq)`,

      // id = sha256(sourceKey, oldReceiptId, newReceiptId | 'null', reason).
      `CREATE TABLE ledger.invalidation_events (
         id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
         source_id uuid NOT NULL REFERENCES ledger.sources (id),
         source_key text NOT NULL,
         old_receipt_id uuid NOT NULL REFERENCES ledger.observation_receipts (id),
         new_receipt_id uuid REFERENCES ledger.observation_receipts (id),
         reason text NOT NULL ${enumCheck('reason', INVALIDATION_REASONS)},
         self_write text NOT NULL ${enumCheck('self_write', ['none', 'verified', 'mismatch'])},
         graph_version bigint NOT NULL CHECK (graph_version >= 0),
         mission_ids jsonb NOT NULL,
         affected jsonb NOT NULL,
         per_mission jsonb NOT NULL,
         closure jsonb NOT NULL,
         resolved_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
      `CREATE INDEX invalidation_events_open ON ledger.invalidation_events (created_at) WHERE resolved_at IS NULL`,
      `CREATE INDEX invalidation_events_by_receipt ON ledger.invalidation_events (old_receipt_id)`,

      // --- guards -------------------------------------------------------
      `CREATE FUNCTION ledger.receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RAISE EXCEPTION 'ledger.observation_receipts is immutable: rows cannot be deleted';
         END IF;
         IF (to_jsonb(NEW) - 'status' - 'status_version' - 'superseded_by')
            IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'status_version' - 'superseded_by') THEN
           RAISE EXCEPTION 'ledger.observation_receipts is immutable: only status, status_version and superseded_by may change';
         END IF;
         IF NEW.status = OLD.status THEN
           IF NEW.status_version <> OLD.status_version OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
             RAISE EXCEPTION 'ledger.observation_receipts is immutable: status_version and superseded_by change only with a status transition';
           END IF;
           RETURN NEW;
         END IF;
         IF NOT (${transitionPairs('OLD.status', 'NEW.status')}) THEN
           RAISE EXCEPTION 'ledger.observation_receipts is immutable: illegal status transition % -> %', OLD.status, NEW.status;
         END IF;
         IF NEW.status_version <> OLD.status_version + 1 THEN
           RAISE EXCEPTION 'ledger.observation_receipts is immutable: status_version must advance by exactly one';
         END IF;
         IF OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
           RAISE EXCEPTION 'ledger.observation_receipts is immutable: superseded_by is set once';
         END IF;
         RETURN NEW;
       END
       $guard$`,
      `CREATE TRIGGER receipts_guard BEFORE UPDATE OR DELETE ON ledger.observation_receipts
         FOR EACH ROW EXECUTE FUNCTION ledger.receipts_guard()`,

      `CREATE FUNCTION ledger.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
       BEGIN
         RAISE EXCEPTION '% is append-only and immutable: % is not allowed', TG_TABLE_NAME, TG_OP;
       END
       $guard$`,
      ...[
        'source_revisions',
        'receipt_confirmations',
        'receipt_transitions',
        'dependency_edges',
        'context_snapshots',
        'model_call_records',
      ].map(
        (table) =>
          `CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ledger.${table}
             FOR EACH ROW EXECUTE FUNCTION ledger.append_only_guard()`,
      ),

      // inference attempts and invalidation events: only resolved_at moves.
      `CREATE FUNCTION ledger.invalidation_events_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           RAISE EXCEPTION 'ledger.invalidation_events is append-only and immutable: DELETE is not allowed';
         END IF;
         IF (to_jsonb(NEW) - 'resolved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'resolved_at') THEN
           RAISE EXCEPTION 'ledger.invalidation_events is append-only and immutable: only resolved_at may be set';
         END IF;
         IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
           RAISE EXCEPTION 'ledger.invalidation_events is append-only and immutable: resolved_at is set once';
         END IF;
         RETURN NEW;
       END
       $guard$`,
      `CREATE TRIGGER invalidation_events_guard BEFORE UPDATE OR DELETE ON ledger.invalidation_events
         FOR EACH ROW EXECUTE FUNCTION ledger.invalidation_events_guard()`,
      `CREATE TRIGGER inference_attempts_append_only BEFORE UPDATE OR DELETE ON ledger.inference_attempts
         FOR EACH ROW EXECUTE FUNCTION ledger.append_only_guard()`,
    ];
    for (const statement of statements) await client.query(statement);
  },
};

export default migration;
