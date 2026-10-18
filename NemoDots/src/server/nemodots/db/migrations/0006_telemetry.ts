// 0006: telemetry tables (ARCHITECTURE.md section 3, finding C16).
//
//   ledger.tool_spans      one row per tool call a worker made: identity,
//                          timing, outcome and DIGESTS of arguments and result.
//                          Never the arguments or result themselves.
//   ledger.mission_timing  append-only phase marks of a mission, used to split
//                          detection, recovery and completion time.
//
// Inference attempts already live in ledger.inference_attempts (0002); the
// telemetry package only reads them. Both new tables are append-only (the
// same trigger the ledger uses), so a span or timing mark cannot be rewritten
// after the fact. Grants come from the 0001 default privileges.
import type { Migration } from '../migrate.js';

const list = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

export const TOOL_SPAN_OUTCOMES = [
  'ok',
  'error',
  'refused',
  'cancelled',
] as const;
export const MISSION_TIMING_PHASES = [
  'created',
  'started',
  'first_model_call',
  'first_finding',
  'first_action',
  'conflict_detected',
  'recovery_started',
  'recovered',
  'completed',
  'failed',
  'cancelled',
] as const;

const migration: Migration = {
  id: '0006_telemetry',
  async up(client) {
    const statements = [
      `CREATE TABLE ledger.tool_spans (
         id uuid PRIMARY KEY,
         mission_id uuid NOT NULL,
         task_id uuid NOT NULL,
         attempt_id uuid NOT NULL,
         model_call_id uuid,
         tool_call_id text NOT NULL CHECK (tool_call_id <> ''),
         tool_name text NOT NULL CHECK (tool_name <> ''),
         started_at timestamptz NOT NULL,
         finished_at timestamptz,
         outcome text NOT NULL CHECK (outcome IN (${list(TOOL_SPAN_OUTCOMES)})),
         error_class text,
         arguments_digest text NOT NULL CHECK (arguments_digest ~ '^[0-9a-f]{64}$'),
         result_digest text CHECK (result_digest ~ '^[0-9a-f]{64}$'),
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT tool_spans_call UNIQUE (attempt_id, tool_call_id),
         CONSTRAINT tool_spans_finished_after_start CHECK (finished_at IS NULL OR finished_at >= started_at)
       )`,
      `CREATE INDEX tool_spans_by_mission ON ledger.tool_spans (mission_id, started_at)`,
      `CREATE TABLE ledger.mission_timing (
         mission_id uuid NOT NULL,
         phase text NOT NULL CHECK (phase IN (${list(MISSION_TIMING_PHASES)})),
         n integer NOT NULL CHECK (n > 0),
         at timestamptz NOT NULL,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         PRIMARY KEY (mission_id, phase, n)
       )`,
      `CREATE TRIGGER tool_spans_append_only BEFORE UPDATE OR DELETE ON ledger.tool_spans
         FOR EACH ROW EXECUTE FUNCTION ledger.append_only_guard()`,
      `CREATE TRIGGER mission_timing_append_only BEFORE UPDATE OR DELETE ON ledger.mission_timing
         FOR EACH ROW EXECUTE FUNCTION ledger.append_only_guard()`,
    ];
    for (const statement of statements) await client.query(statement);
  },
};

export default migration;
