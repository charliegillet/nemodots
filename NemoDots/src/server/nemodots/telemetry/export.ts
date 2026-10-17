// JSONL export of a mission's telemetry: artifacts/nemodots/telemetry/<missionId>.jsonl.
// One JSON object per line, `type` first: mission, inference_attempt,
// tool_span, timing, pricing, cost, summary. Rows are the stored rows (ids,
// timings, token counts, digests, error classes); prompts, completions, tool
// arguments and tool results are never stored, so never exported.
//
// Redaction check: before anything is written, the serialized lines are
// scanned for `sk-`, `Bearer`, key-like tokens, connection URLs, and for each
// configured secret (the value and its 8-character prefix). A hit aborts the
// export with TelemetryError('redaction_failed') naming only the kind of
// match, and no file is created. The scan fails closed; it does not rewrite.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PgClient } from '../contracts/index.js';
import { redactSecrets } from '../inference/record.js';
import { estimateMissionCost, loadMissionPricing } from './pricing.js';
import { TelemetryError, getMissionTiming, listToolSpans } from './spans.js';
import { summarizeTelemetryDetailed } from './summary.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TELEMETRY_EXPORT_DIR = path.join(
  'artifacts',
  'nemodots',
  'telemetry',
);
export const EXPORT_SCHEMA_VERSION = 1;

/** Environment variables whose values must never reach an export. */
const SECRET_ENV_NAMES = [
  'OPENAI_API_KEY',
  'CRUSOE_API_KEY',
  'CPK_INTELLIGENCE_API_KEY',
] as const;

export function configuredSecrets(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return SECRET_ENV_NAMES.map((name) => env[name]).filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  );
}

/** Names the first redaction violation in `text` (never its value), or null. */
export function findRedactionViolation(
  text: string,
  secrets: readonly string[] = [],
): string | null {
  if (text.includes('sk-')) return 'sk- prefix';
  if (/bearer/i.test(text)) return 'Bearer token';
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    if (text.includes(secret)) return 'configured secret';
    if (text.includes(secret.slice(0, 8))) return 'configured secret prefix';
  }
  if (redactSecrets(text) !== text) return 'secret-shaped value';
  return null;
}

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

interface AttemptRow {
  model_call_id: string;
  n: number;
  mission_id: string;
  task_id: string;
  attempt_id: string;
  role: string;
  model_requested: string;
  model_returned: string | null;
  provider_host: string;
  provider_mode: string;
  started_at: Date;
  headers_at: Date | null;
  first_content_at: Date | null;
  finished_at: Date | null;
  http_status: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  finish_reason: string | null;
  error_class: string | null;
  error_code: string | null;
  error_id: string | null;
  retry_after_ms: number | null;
  streamed: boolean;
  outcome: string;
}

export interface MissionTelemetryExport {
  missionId: string;
  lines: string[];
}

/** Builds the export lines from stored rows; nothing is written. */
export async function buildMissionTelemetryExport(
  client: PgClient,
  missionId: string,
  exportedAt: Date = new Date(),
): Promise<MissionTelemetryExport> {
  if (!UUID.test(missionId))
    throw new TelemetryError('export_invalid', 'missionId must be a uuid');
  const attempts = await client.query<AttemptRow>(
    `SELECT model_call_id, n, mission_id, task_id, attempt_id, role, model_requested,
            model_returned, provider_host, provider_mode, started_at, headers_at,
            first_content_at, finished_at, http_status, prompt_tokens, completion_tokens,
            cached_tokens, reasoning_tokens, finish_reason, error_class, error_code,
            error_id, retry_after_ms, streamed, outcome
       FROM ledger.inference_attempts WHERE mission_id = $1
      ORDER BY started_at, model_call_id, n`,
    [missionId],
  );
  const spans = await listToolSpans(client, missionId);
  const timing = await getMissionTiming(client, missionId);
  const pricing = await loadMissionPricing(client, missionId);
  const cost = await estimateMissionCost(client, missionId);
  const { summary, detail } = await summarizeTelemetryDetailed(
    client,
    missionId,
  );

  const objects: Record<string, unknown>[] = [
    {
      type: 'mission',
      schemaVersion: EXPORT_SCHEMA_VERSION,
      missionId,
      exportedAt: exportedAt.toISOString(),
    },
    ...attempts.rows.map((row) => ({
      type: 'inference_attempt',
      modelCallId: row.model_call_id,
      n: row.n,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      role: row.role,
      modelRequested: row.model_requested,
      modelReturned: row.model_returned,
      providerHost: row.provider_host,
      providerMode: row.provider_mode,
      startedAt: row.started_at.toISOString(),
      headersAt: iso(row.headers_at),
      firstContentAt: iso(row.first_content_at),
      finishedAt: iso(row.finished_at),
      httpStatus: row.http_status,
      usage: {
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        cachedTokens: row.cached_tokens,
        reasoningTokens: row.reasoning_tokens,
      },
      finishReason: row.finish_reason,
      errorClass: row.error_class,
      errorCode: row.error_code,
      errorId: row.error_id,
      retryAfterMs: row.retry_after_ms,
      streamed: row.streamed,
      outcome: row.outcome,
    })),
    ...spans.map((span) => ({ type: 'tool_span', ...span })),
    { type: 'timing', ...timing },
    ...pricing.map((price) => ({ type: 'pricing', ...price })),
    { type: 'cost', ...cost },
    { type: 'summary', summary, detail },
  ];
  return { missionId, lines: objects.map((object) => JSON.stringify(object)) };
}

export interface ExportOptions {
  /** Directory the artifacts/ tree lives in; default process.cwd(). */
  rootDir?: string;
  /** Extra secret values to check; configured API keys from the environment are always checked. */
  secrets?: readonly string[];
  exportedAt?: Date;
}

/**
 * Writes the mission's export atomically (temp file + rename) after the
 * redaction check. Returns the absolute path and line count.
 */
export async function exportMissionTelemetry(
  client: PgClient,
  missionId: string,
  options: ExportOptions = {},
): Promise<{ path: string; lines: number }> {
  const built = await buildMissionTelemetryExport(
    client,
    missionId,
    options.exportedAt,
  );
  const text = built.lines.join('\n') + '\n';
  const violation = findRedactionViolation(text, [
    ...configuredSecrets(),
    ...(options.secrets ?? []),
  ]);
  if (violation)
    throw new TelemetryError(
      'redaction_failed',
      `telemetry export refused: it contains a ${violation}; nothing was written`,
    );
  const dir = path.resolve(
    options.rootDir ?? process.cwd(),
    TELEMETRY_EXPORT_DIR,
  );
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${missionId.toLowerCase()}.jsonl`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  return { path: target, lines: built.lines.length };
}
