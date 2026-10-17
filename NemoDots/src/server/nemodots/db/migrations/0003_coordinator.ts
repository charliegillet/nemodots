// 0003: coordinator schema (ARCHITECTURE.md sections 6-8, CONTRACTS.md
// sections 4, 6, 7, 8): missions, tasks, task_attempts, task_outputs,
// findings, recovery_events, invalidations (the coordinator's per-mission
// projection of InvalidationEvents), outbox and events.
//
// Every status/kind column carries a CHECK generated from the contract enum, so
// the database and contracts/*.ts cannot drift apart silently. Transitions
// stay in code (contracts/transitions.ts + CAS UPDATEs); a table of allowed
// edges is deliberately not mirrored into SQL.
//
// Integer columns (versions, fences, ordinals) are `integer`, not `bigint`, so
// node-postgres returns numbers; `events.id` is the one BIGSERIAL (SSE id).
// Timestamps use now()/clock_timestamp() of the database, never the app clock.
//
// Cross-package notes (also in the coordinator handoff):
//   - the ledger's closure may UPDATE task_attempts / tasks / task_outputs
//     status columns; a BEFORE UPDATE trigger stamps finished_at/finished
//     columns so foreign writers need not know about them;
//   - INSERT into coordinator.outbox and coordinator.invalidations notifies
//     `nemodots_outbox`; the events table is notified by the EventSink only.
import type { Migration } from '../migrate.js';
import {
  AbortReasonSchema,
  AttemptKindSchema,
  AttemptStatusSchema,
  CapabilitySchema,
  EnvironmentSchema,
  EventKindSchema,
  FindingConfidenceSchema,
  InvalidationReasonSchema,
  MissionStatusSchema,
  ProviderModeSchema,
  ROLE_CAPABILITIES,
  RecoveryKindSchema,
  SelfWriteSchema,
  TaskOutputKindSchema,
  TaskRoleSchema,
  TaskStatusSchema,
} from '../../contracts/index.js';

const list = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');
const inEnum = (column: string, values: readonly string[]) =>
  `CHECK (${column} IN (${list(values)}))`;
const inEnumOrNull = (column: string, values: readonly string[]) =>
  `CHECK (${column} IS NULL OR ${column} IN (${list(values)}))`;

/** capabilities must be a subset of ROLE_CAPABILITIES[role] (rev2 D5). */
const roleCapabilityCheck = () =>
  `CHECK (${TaskRoleSchema.options
    .map((role) => {
      const caps = ROLE_CAPABILITIES[role] as readonly string[];
      return `(role = '${role}' AND capabilities <@ ARRAY[${list(caps)}]::text[])`;
    })
    .join(' OR ')})`;

const HEX64 = "'^[0-9a-f]{64}$'";

const migration: Migration = {
  id: '0003_coordinator',
  async up(client) {
    const q = (sql: string) => client.query(sql);

    await q(`
CREATE TABLE coordinator.missions (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  space_id text,
  environment text NOT NULL ${inEnum('environment', EnvironmentSchema.options)},
  resource text NOT NULL,
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 2000),
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  mode text NOT NULL ${inEnum('mode', ProviderModeSchema.options)},
  status text NOT NULL ${inEnum('status', MissionStatusSchema.options)},
  transition_version integer NOT NULL DEFAULT 0 CHECK (transition_version >= 0),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  budgets jsonb NOT NULL,
  admission_min_age_ms integer NOT NULL DEFAULT 0
    CHECK (admission_min_age_ms BETWEEN 0 AND 60000),
  provider jsonb NOT NULL,
  acceptance_receipt_id uuid REFERENCES ledger.observation_receipts (id),
  failure_reason text,
  cancellation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK (cancellation IS NULL OR status = 'cancelled'),
  -- Mission success rests on a probe receipt that exists in the ledger.
  CHECK (status <> 'succeeded' OR acceptance_receipt_id IS NOT NULL)
)`);
    await q(
      'CREATE INDEX missions_status_idx ON coordinator.missions (status, created_at)',
    );

    await q(`
CREATE TABLE coordinator.tasks (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  parent_id uuid REFERENCES coordinator.tasks (id),
  depth integer NOT NULL CHECK (depth >= 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  role text NOT NULL ${inEnum('role', TaskRoleSchema.options)},
  capabilities text[] NOT NULL DEFAULT '{}'
    CHECK (capabilities <@ ARRAY[${list(CapabilitySchema.options)}]::text[]),
  status text NOT NULL ${inEnum('status', TaskStatusSchema.options)},
  transition_version integer NOT NULL DEFAULT 0 CHECK (transition_version >= 0),
  generation integer NOT NULL CHECK (generation >= 0),
  prerequisites uuid[] NOT NULL DEFAULT '{}',
  fence_seq integer NOT NULL DEFAULT 0 CHECK (fence_seq >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  budget jsonb NOT NULL,
  output_id uuid,
  created_by_model_call_id uuid,
  justification text CHECK (justification IS NULL OR char_length(justification) BETWEEN 1 AND 500),
  inherited_dependency_vector jsonb NOT NULL DEFAULT '[]'::jsonb,
  repair jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((parent_id IS NULL) = (depth = 0)),
  CHECK (parent_id IS NULL OR justification IS NOT NULL),
  CHECK (NOT (id = ANY (prerequisites))),
  ${roleCapabilityCheck()},
  UNIQUE (mission_id, ordinal)
)`);
    await q(
      'CREATE UNIQUE INDEX tasks_dedupe_idx ON coordinator.tasks (mission_id, dedupe_key) WHERE dedupe_key IS NOT NULL',
    );
    await q(
      'CREATE INDEX tasks_mission_status_idx ON coordinator.tasks (mission_id, status)',
    );
    // At most one open postcondition task per mission (recovery serialises its
    // check-then-insert under the task-graph lock; this is the backstop).
    // `invalidated` and `repairing` are deliberately outside the index: the
    // ledger closure may move a succeeded postcondition task to `invalidated`
    // in its own transaction and that UPDATE must never be refused.
    await q(`
CREATE UNIQUE INDEX tasks_one_open_postcondition_idx ON coordinator.tasks (mission_id)
 WHERE role = 'postcondition'
   AND status IN ('pending', 'runnable', 'leased', 'running', 'waiting')`);
    await q(
      'CREATE INDEX tasks_parent_idx ON coordinator.tasks (parent_id) WHERE parent_id IS NOT NULL',
    );

    await q(`
CREATE TABLE coordinator.task_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES coordinator.tasks (id),
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  n integer NOT NULL CHECK (n > 0),
  kind text NOT NULL ${inEnum('kind', AttemptKindSchema.options)},
  status text NOT NULL ${inEnum('status', AttemptStatusSchema.options)},
  generation integer NOT NULL CHECK (generation >= 0),
  lease_owner text NOT NULL,
  fencing_token integer NOT NULL CHECK (fencing_token > 0),
  lease_expires_at timestamptz NOT NULL,
  lease_renewed_at timestamptz NOT NULL,
  read_set_receipt_ids uuid[] NOT NULL DEFAULT '{}',
  read_set_vector jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_call_ids uuid[] NOT NULL DEFAULT '{}',
  inherited_dependency_vector jsonb NOT NULL DEFAULT '[]'::jsonb,
  repair_of jsonb,
  abort_reason text ${inEnumOrNull('abort_reason', AbortReasonSchema.options)},
  failure_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (task_id, n),
  UNIQUE (task_id, fencing_token),
  CHECK (kind <> 'repair' OR repair_of IS NOT NULL),
  CHECK (status <> 'aborted' OR abort_reason IS NOT NULL),
  CHECK (status <> 'running' OR abort_reason IS NULL)
)`);
    await q(
      'CREATE INDEX attempts_mission_status_idx ON coordinator.task_attempts (mission_id, status)',
    );
    await q(
      'CREATE INDEX attempts_task_idx ON coordinator.task_attempts (task_id, n)',
    );
    await q(
      "CREATE INDEX attempts_lease_idx ON coordinator.task_attempts (lease_expires_at) WHERE status = 'running'",
    );
    // Foreign writers (the ledger closure marks attempts invalidated) need not
    // know about finished_at: stamp it whenever an attempt leaves 'running'.
    await q(`
CREATE FUNCTION coordinator.stamp_attempt_finished() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'running' AND NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER attempts_stamp_finished BEFORE UPDATE ON coordinator.task_attempts
FOR EACH ROW EXECUTE FUNCTION coordinator.stamp_attempt_finished()`);

    await q(`
CREATE TABLE coordinator.task_outputs (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES coordinator.tasks (id),
  attempt_id uuid NOT NULL REFERENCES coordinator.task_attempts (id),
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  kind text NOT NULL ${inEnum('kind', TaskOutputKindSchema.options)},
  content jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ ${HEX64}),
  dependency_vector jsonb NOT NULL DEFAULT '[]'::jsonb,
  usable boolean NOT NULL DEFAULT true,
  unusable_reason text,
  published_at timestamptz NOT NULL DEFAULT now(),
  CHECK (usable = (unusable_reason IS NULL))
)`);
    await q(
      'CREATE INDEX outputs_task_idx ON coordinator.task_outputs (task_id, published_at)',
    );
    await q(
      'CREATE INDEX outputs_mission_idx ON coordinator.task_outputs (mission_id)',
    );
    await q(
      'ALTER TABLE coordinator.tasks ADD CONSTRAINT tasks_output_fk FOREIGN KEY (output_id) REFERENCES coordinator.task_outputs (id)',
    );

    await q(`
CREATE TABLE coordinator.findings (
  id uuid PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  task_id uuid NOT NULL REFERENCES coordinator.tasks (id),
  attempt_id uuid NOT NULL REFERENCES coordinator.task_attempts (id),
  claim text NOT NULL CHECK (char_length(claim) BETWEEN 1 AND 2000),
  supporting_receipt_ids uuid[] NOT NULL DEFAULT '{}',
  confidence text NOT NULL ${inEnum('confidence', FindingConfidenceSchema.options)},
  usable boolean NOT NULL DEFAULT true,
  dependency_vector jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
    await q(
      'CREATE INDEX findings_mission_idx ON coordinator.findings (mission_id, created_at)',
    );

    // The coordinator's own, mission-scoped copy of every InvalidationEvent it
    // is told about (RecoveryPort.onInvalidation) or writes itself
    // (publication_rejected). The stored event already contains only this
    // mission's subset (rev2 I10).
    await q(`
CREATE TABLE coordinator.invalidations (
  event_id text NOT NULL CHECK (event_id ~ ${HEX64}),
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  event jsonb NOT NULL,
  source_key text NOT NULL,
  reason text NOT NULL ${inEnum('reason', InvalidationReasonSchema.options)},
  self_write text NOT NULL ${inEnum('self_write', SelfWriteSchema.options)},
  gate_task_id uuid REFERENCES coordinator.tasks (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  resolved_at timestamptz,
  PRIMARY KEY (event_id, mission_id)
)`);
    await q(
      'CREATE INDEX invalidations_pending_idx ON coordinator.invalidations (created_at) WHERE processed_at IS NULL OR resolved_at IS NULL',
    );

    await q(`
CREATE TABLE coordinator.recovery_events (
  id uuid PRIMARY KEY,
  invalidation_event_id text NOT NULL CHECK (invalidation_event_id ~ ${HEX64}),
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  kind text NOT NULL ${inEnum('kind', RecoveryKindSchema.options)},
  task_id uuid,
  attempt_id uuid,
  new_attempt_id uuid,
  action_id uuid,
  detail text NOT NULL CHECK (char_length(detail) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
)`);
    // One recovery fact per (invalidation, mission, kind, task, attempt, action):
    // recovery is re-run after crashes and must not duplicate its records.
    const nil = "'00000000-0000-0000-0000-000000000000'::uuid";
    await q(`
CREATE UNIQUE INDEX recovery_events_once_idx ON coordinator.recovery_events (
  invalidation_event_id, mission_id, kind,
  COALESCE(task_id, ${nil}), COALESCE(attempt_id, ${nil}), COALESCE(action_id, ${nil})
)`);
    await q(
      'CREATE INDEX recovery_events_mission_idx ON coordinator.recovery_events (mission_id, created_at)',
    );

    await q(`
CREATE TABLE coordinator.outbox (
  id bigserial PRIMARY KEY,
  mission_id uuid,
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 100),
  payload jsonb NOT NULL,
  dedupe_key text UNIQUE,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_by text,
  claimed_until timestamptz,
  processed_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
    await q(
      'CREATE INDEX outbox_ready_idx ON coordinator.outbox (available_at, id) WHERE processed_at IS NULL AND failed_at IS NULL',
    );
    // Effect ledger for handlers that want exactly-once database effects under
    // duplicate delivery: the effect and this row commit together.
    await q(`
CREATE TABLE coordinator.outbox_applied (
  outbox_id bigint NOT NULL REFERENCES coordinator.outbox (id),
  handler text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id, handler)
)`);
    await q(`
CREATE FUNCTION coordinator.notify_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nemodots_outbox', '');
  RETURN NEW;
END
$$`);
    await q(`
CREATE TRIGGER outbox_notify AFTER INSERT ON coordinator.outbox
FOR EACH STATEMENT EXECUTE FUNCTION coordinator.notify_outbox()`);
    await q(`
CREATE TRIGGER invalidations_notify AFTER INSERT ON coordinator.invalidations
FOR EACH STATEMENT EXECUTE FUNCTION coordinator.notify_outbox()`);

    await q(`
CREATE TABLE coordinator.events (
  id bigserial PRIMARY KEY,
  mission_id uuid NOT NULL REFERENCES coordinator.missions (id),
  kind text NOT NULL ${inEnum('kind', EventKindSchema.options)},
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (payload ->> 'kind' = kind)
)`);
    await q(
      'CREATE INDEX events_mission_idx ON coordinator.events (mission_id, id)',
    );
    // Append-only: the SSE stream and replay rely on stable ids and rows.
    await q('REVOKE UPDATE, DELETE ON coordinator.events FROM nemodots_app');
  },
};

export default migration;
