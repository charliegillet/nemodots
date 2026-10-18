// JSONL export of stored telemetry under artifacts/nemodots/telemetry/. Lines
// carry ids, timings, token counts, statuses and digests only. Before anything
// is written the whole text is scanned for credentials; a hit throws and no
// file is left behind.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PgClient } from '../contracts/index.js';
import { listMissionTiming, listToolSpans } from './spans.js';

export class TelemetryRedactionError extends Error {
  constructor(readonly pattern: string) {
    super(`telemetry export refused: it contains ${pattern}`);
    this.name = 'TelemetryRedactionError';
  }
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['an sk- style key', /\bsk-[A-Za-z0-9_-]{8,}/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  [
    'an Authorization header',
    /"?authorization"?\s*[:=]\s*"?(?:[A-Za-z]+\s+)?\S{8,}/i,
  ],
  ['a connection string', /\b(?:postgres(?:ql)?|redis|rediss):\/\/\S+/i],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Throws when `text` holds a credential pattern or any of the literal secrets. */
export function assertRedacted(
  text: string,
  secrets: readonly (string | undefined)[] = [],
): void {
  for (const [name, pattern] of SECRET_PATTERNS)
    if (pattern.test(text)) throw new TelemetryRedactionError(name);
  for (const secret of secrets)
    if (secret && secret.length >= 6 && text.includes(secret))
      throw new TelemetryRedactionError('a configured secret value');
}

interface AttemptExportRow {
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
  prefix_digest: string | null;
}

const iso = (value: Date | null) =>
  value ? new Date(value).toISOString() : null;

export async function telemetryLines(
  client: PgClient,
  missionId?: string,
): Promise<string[]> {
  const { rows } = await client.query<AttemptExportRow>(
    `SELECT a.model_call_id, a.n, a.mission_id, a.task_id, a.attempt_id, a.role,
            a.model_requested, a.model_returned, a.provider_host, a.provider_mode,
            a.started_at, a.headers_at, a.first_content_at, a.finished_at, a.http_status,
            a.prompt_tokens, a.completion_tokens, a.cached_tokens, a.reasoning_tokens,
            a.finish_reason, a.error_class, a.error_code, a.error_id, a.retry_after_ms,
            a.streamed, a.outcome, s.prefix_digest
       FROM ledger.inference_attempts a
       LEFT JOIN ledger.model_call_records m ON m.id = a.model_call_id
       LEFT JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
      WHERE ($1::uuid IS NULL OR a.mission_id = $1::uuid)
      ORDER BY a.started_at, a.model_call_id, a.n`,
    [missionId ?? null],
  );
  const lines: string[] = rows.map((row) =>
    JSON.stringify({
      kind: 'inference_attempt',
      modelCallId: row.model_call_id,
      n: row.n,
      missionId: row.mission_id,
      taskId: row.task_id,
      attemptId: row.attempt_id,
      role: row.role,
      model: { requested: row.model_requested, returned: row.model_returned },
      provider: { host: row.provider_host, mode: row.provider_mode },
      startedAt: iso(row.started_at),
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
      error: row.error_class
        ? {
            class: row.error_class,
            code: row.error_code,
            errorId: row.error_id,
          }
        : null,
      retryAfterMs: row.retry_after_ms,
      streamed: row.streamed,
      outcome: row.outcome,
      prefixDigest: row.prefix_digest,
    }),
  );
  if (missionId) {
    for (const span of await listToolSpans(client, missionId))
      lines.push(JSON.stringify({ kind: 'tool_span', ...span }));
    for (const mark of await listMissionTiming(client, missionId))
      lines.push(JSON.stringify({ kind: 'mission_timing', ...mark }));
  }
  return lines;
}

export interface ExportOptions {
  missionId?: string;
  /** project root; the file lands in <root>/artifacts/nemodots/telemetry/ */
  root?: string;
  /** file name without directories; defaults to telemetry-<mission|all>.jsonl */
  name?: string;
  /** literal secret values that must not appear (e.g. the API keys in use) */
  secrets?: readonly (string | undefined)[];
}

export async function exportTelemetryJsonl(
  client: PgClient,
  options: ExportOptions = {},
): Promise<{ path: string; lines: number }> {
  const name = options.name ?? `telemetry-${options.missionId ?? 'all'}.jsonl`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.jsonl$/.test(name))
    throw new RangeError('export name must be a plain *.jsonl file name');
  const lines = await telemetryLines(client, options.missionId);
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  assertRedacted(text, options.secrets);
  const dir = path.join(
    options.root ?? process.cwd(),
    'artifacts',
    'nemodots',
    'telemetry',
  );
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, text, { mode: 0o600 });
  return { path: file, lines: lines.length };
}
