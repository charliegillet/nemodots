// Tool spans, orphaned-call storage and the mission timing rollup.
//
// recordToolSpan stores one row per executed or refused tool call (timing,
// outcome, digests; never arguments, results or prompts) and refreshes the
// mission's timing buckets. recordOrphanedInference is the telemetry entry for
// a model call that completed on the provider after the author's lease was
// lost (finding C16): it delegates to the ledger's unfenced path and refreshes
// the timing rollup. refreshMissionTiming recomputes the setup / inference /
// tool buckets from stored rows, so calling it twice never double counts.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DigestSchema,
  IsoTimeSchema,
  MissionIdSchema,
  type PgClient,
} from '../contracts/index.js';
import {
  recordOrphanedAttempt,
  type RecordOrphanedAttemptInput,
} from '../ledger/model-calls.js';

export const TOOL_SPAN_BUCKETS = ['setup', 'tool'] as const;
export const TOOL_SPAN_OUTCOMES = [
  'ok',
  'error',
  'cancelled',
  'blocked',
  'fenced',
  'unknown',
] as const;
export const TIMING_BUCKETS = ['setup', 'inference', 'tool'] as const;
export type ToolSpanBucket = (typeof TOOL_SPAN_BUCKETS)[number];
export type ToolSpanOutcome = (typeof TOOL_SPAN_OUTCOMES)[number];
export type TimingBucket = (typeof TIMING_BUCKETS)[number];

const uuid = () => z.uuid();

export const ToolSpanInputSchema = z
  .object({
    id: uuid().optional(),
    missionId: MissionIdSchema,
    taskId: uuid().nullable().optional(),
    attemptId: uuid().nullable().optional(),
    toolName: z.string().regex(/^[A-Za-z0-9_.:]{1,128}$/),
    toolCallId: z.string().min(1).max(128).nullable().optional(),
    bucket: z.enum(TOOL_SPAN_BUCKETS).default('tool'),
    startedAt: IsoTimeSchema,
    finishedAt: IsoTimeSchema,
    outcome: z.enum(TOOL_SPAN_OUTCOMES),
    errorClass: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .nullable()
      .optional(),
    argsDigest: DigestSchema.nullable().optional(),
    resultDigest: DigestSchema.nullable().optional(),
  })
  .strict();
export type ToolSpanInput = z.input<typeof ToolSpanInputSchema>;

export interface ToolSpan {
  id: string;
  missionId: string;
  taskId: string | null;
  attemptId: string | null;
  toolName: string;
  toolCallId: string | null;
  bucket: ToolSpanBucket;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: ToolSpanOutcome;
  errorClass: string | null;
  argsDigest: string | null;
  resultDigest: string | null;
}

export class TelemetryError extends Error {
  constructor(
    readonly code:
      | 'span_invalid'
      | 'span_conflict'
      | 'pricing_invalid'
      | 'redaction_failed'
      | 'export_invalid'
      | 'comparison_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'TelemetryError';
  }
}

export interface RecordedToolSpan {
  span: ToolSpan;
  /** False when the same span id was already stored (redelivery). */
  created: boolean;
}

/** Stores one tool span (idempotent per span id) and refreshes the mission timing. */
export async function recordToolSpan(
  client: PgClient,
  input: ToolSpanInput,
): Promise<RecordedToolSpan> {
  const parsed = ToolSpanInputSchema.safeParse(input);
  if (!parsed.success)
    throw new TelemetryError(
      'span_invalid',
      `tool span is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  const value = parsed.data;
  const started = Date.parse(value.startedAt);
  const finished = Date.parse(value.finishedAt);
  if (finished < started)
    throw new TelemetryError('span_invalid', 'finishedAt precedes startedAt');
  const span: ToolSpan = {
    id: value.id ?? randomUUID(),
    missionId: value.missionId,
    taskId: value.taskId ?? null,
    attemptId: value.attemptId ?? null,
    toolName: value.toolName,
    toolCallId: value.toolCallId ?? null,
    bucket: value.bucket,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    durationMs: finished - started,
    outcome: value.outcome,
    errorClass: value.errorClass ?? null,
    argsDigest: value.argsDigest ?? null,
    resultDigest: value.resultDigest ?? null,
  };
  const inserted = await client.query(
    `INSERT INTO ledger.tool_spans
       (id, mission_id, task_id, attempt_id, tool_name, tool_call_id, bucket, started_at,
        finished_at, duration_ms, outcome, error_class, args_digest, result_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO NOTHING`,
    [
      span.id,
      span.missionId,
      span.taskId,
      span.attemptId,
      span.toolName,
      span.toolCallId,
      span.bucket,
      span.startedAt,
      span.finishedAt,
      span.durationMs,
      span.outcome,
      span.errorClass,
      span.argsDigest,
      span.resultDigest,
    ],
  );
  const created = inserted.rowCount === 1;
  if (!created) {
    const existing = await client.query<{
      mission_id: string;
      tool_name: string;
      duration_ms: number;
      outcome: string;
    }>(
      'SELECT mission_id, tool_name, duration_ms, outcome FROM ledger.tool_spans WHERE id = $1',
      [span.id],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.mission_id !== span.missionId ||
      row.tool_name !== span.toolName ||
      row.duration_ms !== span.durationMs ||
      row.outcome !== span.outcome
    )
      throw new TelemetryError(
        'span_conflict',
        `tool span ${span.id} was already stored with different content`,
      );
  }
  await refreshMissionTiming(client, span.missionId);
  return { span, created };
}

export interface MissionTiming {
  /** Summed span time per bucket. Concurrent spans overlap, so this is work time, not wall time. */
  setupMs: number;
  inferenceMs: number;
  toolMs: number;
  spans: { setup: number; inference: number; tool: number };
}

/**
 * Recomputes ledger.mission_timing from stored rows: setup and tool from
 * tool_spans, inference from finished inference attempts (orphaned ones
 * included: they were billed and took time). An attempt without finishedAt
 * (cancelled before completion) contributes no time. Idempotent.
 */
export async function refreshMissionTiming(
  client: PgClient,
  missionId: string,
): Promise<MissionTiming> {
  await client.query(
    `INSERT INTO ledger.mission_timing (mission_id, bucket, total_ms, span_count)
     SELECT $1::uuid, bucket, COALESCE(SUM(ms), 0)::bigint, COUNT(*)::integer
       FROM (
         SELECT bucket, duration_ms AS ms FROM ledger.tool_spans WHERE mission_id = $1
         UNION ALL
         SELECT 'inference', ROUND(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::bigint
           FROM ledger.inference_attempts
          WHERE mission_id = $1 AND finished_at IS NOT NULL
       ) spans
      GROUP BY bucket
     ON CONFLICT (mission_id, bucket) DO UPDATE
       SET total_ms = EXCLUDED.total_ms, span_count = EXCLUDED.span_count,
           updated_at = clock_timestamp()`,
    [missionId],
  );
  return getMissionTiming(client, missionId);
}

/** Reads the stored rollup; buckets without rows are zero spans, zero ms. */
export async function getMissionTiming(
  client: PgClient,
  missionId: string,
): Promise<MissionTiming> {
  const { rows } = await client.query<{
    bucket: TimingBucket;
    total_ms: string;
    span_count: number;
  }>(
    'SELECT bucket, total_ms, span_count FROM ledger.mission_timing WHERE mission_id = $1',
    [missionId],
  );
  const timing: MissionTiming = {
    setupMs: 0,
    inferenceMs: 0,
    toolMs: 0,
    spans: { setup: 0, inference: 0, tool: 0 },
  };
  for (const row of rows) {
    const ms = Number(row.total_ms);
    if (row.bucket === 'setup') timing.setupMs = ms;
    else if (row.bucket === 'inference') timing.inferenceMs = ms;
    else timing.toolMs = ms;
    timing.spans[row.bucket] = row.span_count;
  }
  return timing;
}

/**
 * Stores the attempts of a call whose fenced record was rejected (C16) as
 * unfenced `orphaned_fence` rows and refreshes the timing rollup. Idempotent
 * per (call, n). Never writes a record, snapshot or edge.
 */
export async function recordOrphanedInference(
  client: PgClient,
  input: RecordOrphanedAttemptInput,
): Promise<{ inserted: number }> {
  const result = await recordOrphanedAttempt(client, input);
  await refreshMissionTiming(client, input.scope.missionId);
  return result;
}

export async function listToolSpans(
  client: PgClient,
  missionId: string,
): Promise<ToolSpan[]> {
  const { rows } = await client.query<{
    id: string;
    mission_id: string;
    task_id: string | null;
    attempt_id: string | null;
    tool_name: string;
    tool_call_id: string | null;
    bucket: ToolSpanBucket;
    started_at: Date;
    finished_at: Date;
    duration_ms: number;
    outcome: ToolSpanOutcome;
    error_class: string | null;
    args_digest: string | null;
    result_digest: string | null;
  }>(
    `SELECT id, mission_id, task_id, attempt_id, tool_name, tool_call_id, bucket, started_at,
            finished_at, duration_ms, outcome, error_class, args_digest, result_digest
       FROM ledger.tool_spans WHERE mission_id = $1 ORDER BY started_at, id`,
    [missionId],
  );
  return rows.map((row) => ({
    id: row.id,
    missionId: row.mission_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    bucket: row.bucket,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    durationMs: row.duration_ms,
    outcome: row.outcome,
    errorClass: row.error_class,
    argsDigest: row.args_digest,
    resultDigest: row.result_digest,
  }));
}
