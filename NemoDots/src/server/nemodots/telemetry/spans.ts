// Tool spans and mission timing marks (migration 0006). Rows hold identities,
// timings, outcomes and DIGESTS of arguments and results, never the values.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DigestSchema,
  IsoTimeSchema,
  type PgClient,
} from '../contracts/index.js';
import {
  MISSION_TIMING_PHASES,
  TOOL_SPAN_OUTCOMES,
} from '../db/migrations/0006_telemetry.js';

export type ToolSpanOutcome = (typeof TOOL_SPAN_OUTCOMES)[number];
export type MissionTimingPhase = (typeof MISSION_TIMING_PHASES)[number];

export const ToolSpanSchema = z
  .object({
    id: z.uuid({ version: 'v4' }).optional(),
    missionId: z.uuid({ version: 'v4' }),
    taskId: z.uuid({ version: 'v4' }),
    attemptId: z.uuid({ version: 'v4' }),
    modelCallId: z.uuid({ version: 'v4' }).nullable().default(null),
    toolCallId: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200),
    startedAt: IsoTimeSchema,
    finishedAt: IsoTimeSchema.nullable(),
    outcome: z.enum(TOOL_SPAN_OUTCOMES),
    errorClass: z.string().min(1).max(100).nullable().default(null),
    argumentsDigest: DigestSchema,
    resultDigest: DigestSchema.nullable().default(null),
  })
  .strict()
  .superRefine((span, ctx) => {
    if (
      span.finishedAt !== null &&
      Date.parse(span.finishedAt) < Date.parse(span.startedAt)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'a span cannot finish before it starts',
      });
  });
export type ToolSpanInput = z.input<typeof ToolSpanSchema>;
export type ToolSpan = z.infer<typeof ToolSpanSchema> & { id: string };

/** Stores one span; redelivery of the same (attempt, toolCallId) is a no-op. */
export async function recordToolSpan(
  client: PgClient,
  input: ToolSpanInput,
): Promise<{ id: string; inserted: boolean }> {
  const span = ToolSpanSchema.parse(input);
  const id = span.id ?? randomUUID();
  const result = await client.query(
    `INSERT INTO ledger.tool_spans
       (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id, tool_name,
        started_at, finished_at, outcome, error_class, arguments_digest, result_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (attempt_id, tool_call_id) DO NOTHING`,
    [
      id,
      span.missionId,
      span.taskId,
      span.attemptId,
      span.modelCallId,
      span.toolCallId,
      span.toolName,
      span.startedAt,
      span.finishedAt,
      span.outcome,
      span.errorClass,
      span.argumentsDigest,
      span.resultDigest,
    ],
  );
  return { id, inserted: (result.rowCount ?? 0) > 0 };
}

interface SpanRow {
  id: string;
  mission_id: string;
  task_id: string;
  attempt_id: string;
  model_call_id: string | null;
  tool_call_id: string;
  tool_name: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: ToolSpanOutcome;
  error_class: string | null;
  arguments_digest: string;
  result_digest: string | null;
}

export async function listToolSpans(
  client: PgClient,
  missionId: string,
): Promise<ToolSpan[]> {
  const { rows } = await client.query<SpanRow>(
    `SELECT id, mission_id, task_id, attempt_id, model_call_id, tool_call_id, tool_name,
            started_at, finished_at, outcome, error_class, arguments_digest, result_digest
       FROM ledger.tool_spans WHERE mission_id = $1 ORDER BY started_at, id`,
    [missionId],
  );
  return rows.map((row) => ({
    id: row.id,
    missionId: row.mission_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    modelCallId: row.model_call_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at
      ? new Date(row.finished_at).toISOString()
      : null,
    outcome: row.outcome,
    errorClass: row.error_class,
    argumentsDigest: row.arguments_digest as ToolSpan['argumentsDigest'],
    resultDigest: row.result_digest as ToolSpan['resultDigest'],
  }));
}

export interface MissionTimingMark {
  missionId: string;
  phase: MissionTimingPhase;
  n: number;
  at: string;
}

/** Appends a phase mark; `n` counts repeats of the same phase (recoveries). */
export async function markMissionPhase(
  client: PgClient,
  missionId: string,
  phase: MissionTimingPhase,
  at: Date = new Date(),
): Promise<MissionTimingMark> {
  z.uuid({ version: 'v4' }).parse(missionId);
  z.enum(MISSION_TIMING_PHASES).parse(phase);
  const { rows } = await client.query<{ n: number }>(
    `INSERT INTO ledger.mission_timing (mission_id, phase, n, at)
       SELECT $1, $2, COALESCE(MAX(n), 0) + 1, $3
         FROM ledger.mission_timing WHERE mission_id = $1 AND phase = $2
     RETURNING n`,
    [missionId, phase, at.toISOString()],
  );
  return { missionId, phase, n: rows[0].n, at: at.toISOString() };
}

export async function listMissionTiming(
  client: PgClient,
  missionId: string,
): Promise<MissionTimingMark[]> {
  const { rows } = await client.query<{
    phase: MissionTimingPhase;
    n: number;
    at: Date;
  }>(
    `SELECT phase, n, at FROM ledger.mission_timing WHERE mission_id = $1 ORDER BY at, phase, n`,
    [missionId],
  );
  return rows.map((row) => ({
    missionId,
    phase: row.phase,
    n: row.n,
    at: new Date(row.at).toISOString(),
  }));
}

export interface TimingSplit {
  /** conflict_detected -> recovery_started (null when either mark is missing) */
  detectionToRecoveryStartMs: number | null;
  /** recovery_started -> recovered */
  recoveryMs: number | null;
  /** started -> completed */
  completionMs: number | null;
}

const firstAt = (marks: readonly MissionTimingMark[], phase: string) =>
  marks.find((mark) => mark.phase === phase)?.at ?? null;
const span = (from: string | null, to: string | null) =>
  from && to && Date.parse(to) >= Date.parse(from)
    ? Date.parse(to) - Date.parse(from)
    : null;

/** Durations between marks; a missing mark gives null, never 0. */
export function splitTiming(marks: readonly MissionTimingMark[]): TimingSplit {
  return {
    detectionToRecoveryStartMs: span(
      firstAt(marks, 'conflict_detected'),
      firstAt(marks, 'recovery_started'),
    ),
    recoveryMs: span(
      firstAt(marks, 'recovery_started'),
      firstAt(marks, 'recovered'),
    ),
    completionMs: span(firstAt(marks, 'started'), firstAt(marks, 'completed')),
  };
}
