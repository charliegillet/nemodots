// 0006_telemetry: tool spans, per-mission timing buckets and per-mission model
// pricing (ARCHITECTURE.md telemetry row, CONTRACTS.md section 11).
//
//   ledger.tool_spans       one row per executed (or refused) tool call: timing,
//                           outcome and digests. No arguments, no results, no
//                           prompts. Append-only.
//   ledger.mission_timing   derived rollup of where a mission's time went:
//                           setup vs inference vs tool buckets. Recomputed from
//                           tool_spans and inference_attempts (never incremented
//                           by hand), so redelivery cannot double count.
//   ledger.mission_pricing  the /v1/models pricing observed for a mission's
//                           models, stored once per (mission, model). A missing
//                           price is NULL, never zero. Append-only.
//
// None of these tables has a foreign key to coordinator rows (same stance as
// ledger.inference_attempts): telemetry must survive a fenced rejection.
// Grants come from the default privileges of 0001 (app: DML, verifier: SELECT).
import type { Migration } from '../migrate.js';

const enumCheck = (column: string, values: readonly string[]) =>
  `CHECK (${column} IN (${values.map((value) => `'${value}'`).join(', ')}))`;

const TOOL_SPAN_BUCKETS = ['setup', 'tool'] as const;
const TOOL_SPAN_OUTCOMES = [
  'ok',
  'error',
  'cancelled',
  'blocked',
  'fenced',
  'unknown',
] as const;
const TIMING_BUCKETS = ['setup', 'inference', 'tool'] as const;

const migration: Migration = {
  id: '0006_telemetry',
  async up(client) {
    const statements: string[] = [
      `CREATE TABLE ledger.tool_spans (
         id uuid PRIMARY KEY,
         mission_id uuid NOT NULL,
         task_id uuid,
         attempt_id uuid,
         tool_name text NOT NULL CHECK (tool_name ~ '^[A-Za-z0-9_.:]{1,128}$'),
         tool_call_id text CHECK (tool_call_id IS NULL OR length(tool_call_id) BETWEEN 1 AND 128),
         bucket text NOT NULL ${enumCheck('bucket', TOOL_SPAN_BUCKETS)},
         started_at timestamptz NOT NULL,
         finished_at timestamptz NOT NULL,
         duration_ms integer NOT NULL CHECK (duration_ms >= 0),
         outcome text NOT NULL ${enumCheck('outcome', TOOL_SPAN_OUTCOMES)},
         error_class text CHECK (error_class IS NULL OR error_class ~ '^[a-z0-9_]{1,64}$'),
         args_digest text CHECK (args_digest IS NULL OR args_digest ~ '^[0-9a-f]{64}$'),
         result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT tool_spans_time_order CHECK (finished_at >= started_at)
       )`,
      `CREATE INDEX tool_spans_by_mission ON ledger.tool_spans (mission_id, bucket)`,
      `CREATE TRIGGER tool_spans_append_only BEFORE UPDATE OR DELETE ON ledger.tool_spans
         FOR EACH ROW EXECUTE FUNCTION ledger.append_only_guard()`,

      `CREATE TABLE ledger.mission_timing (
         mission_id uuid NOT NULL,
         bucket text NOT NULL ${enumCheck('bucket', TIMING_BUCKETS)},
         total_ms bigint NOT NULL CHECK (total_ms >= 0),
         span_count integer NOT NULL CHECK (span_count >= 0),
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         PRIMARY KEY (mission_id, bucket)
       )`,

      `CREATE TABLE ledger.mission_pricing (
         mission_id uuid NOT NULL,
         model text NOT NULL CHECK (model <> ''),
         input_per_million numeric CHECK (input_per_million >= 0),
         output_per_million numeric CHECK (output_per_million >= 0),
         cached_per_million numeric CHECK (cached_per_million >= 0),
         source text NOT NULL CHECK (source <> ''),
         fetched_at timestamptz NOT NULL,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         PRIMARY KEY (mission_id, model)
       )`,
      `CREATE TRIGGER mission_pricing_append_only BEFORE UPDATE OR DELETE ON ledger.mission_pricing
         FOR EACH ROW EXECUTE FUNCTION ledger.append_only_guard()`,
    ];
    for (const statement of statements) await client.query(statement);
  },
};

export default migration;
