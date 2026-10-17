import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatRequest } from '../contracts/index.js';
import {
  FIXTURE_FORMAT,
  fixtureKey,
  fixtureRequestInfo,
  type FixtureEntry,
  type FixtureFile,
} from './fixture.js';
import {
  InferenceError,
  type InferenceAdapter,
  type StampedChatResult,
} from './types.js';

// Fixture recording. Wraps a (live) adapter, keeps the completed responses and
// writes a fixture file on flush(). Secrets are stripped from everything that
// is written: explicit secret values, bearer tokens and common key shapes.
// Request content is never stored, only digests and sizes.

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}/g,
  /\bcpk_[A-Za-z0-9_-]{16,}/g,
  /\b(?:postgres|postgresql|redis|rediss):\/\/[^\s"']+/gi,
];

export function redactSecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text;
  for (const secret of secrets)
    if (secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** Deep redaction of every string in a JSON value. */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactSecrets(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]),
    ) as T;
  return value;
}

export interface RecordingOptions {
  label: string;
  /** Values (for example the API key) that must never reach the file. */
  secrets: readonly string[];
}

export class RecordingInference implements InferenceAdapter {
  private readonly entries = new Map<string, FixtureEntry>();

  constructor(
    private readonly inner: InferenceAdapter,
    private readonly options: RecordingOptions,
  ) {}

  get mode() {
    return this.inner.mode;
  }
  host() {
    return this.inner.host();
  }
  listModels() {
    return this.inner.listModels();
  }
  verifyModel(model: string, signal?: AbortSignal) {
    return this.inner.verifyModel(model, signal);
  }

  async complete(
    req: ChatRequest,
    ctx: Parameters<InferenceAdapter['complete']>[1],
  ): Promise<StampedChatResult> {
    const result = await this.inner.complete(req, ctx);
    if (
      result.provider.mode === 'live' &&
      (result.outcome === 'completed' || result.outcome === 'tool_calls') &&
      result.finishReason &&
      result.finishReason !== 'cancelled' &&
      result.finishReason !== 'error'
    ) {
      const key = fixtureKey(req);
      this.entries.set(key, {
        key,
        request: fixtureRequestInfo(req),
        response: {
          modelReturned: result.modelReturned,
          content: result.content,
          reasoning: result.reasoning,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
          usage: result.usage,
          outcome: result.outcome,
        },
      });
    }
    return result;
  }

  toFile(): FixtureFile {
    const entries = [...this.entries.values()].sort((a, b) =>
      a.key < b.key ? -1 : 1,
    );
    return redactDeep(
      {
        format: FIXTURE_FORMAT,
        label: this.options.label,
        provenance: 'recorded-live' as const,
        host: this.inner.host(),
        models: [...new Set(entries.map((e) => e.request.model))],
        entries,
      },
      this.options.secrets,
    );
  }

  /** Writes the fixture atomically; refuses if a secret survived redaction. */
  flush(path: string): void {
    const text = `${JSON.stringify(this.toFile(), null, 2)}\n`;
    for (const secret of this.options.secrets)
      if (secret.length >= 6 && text.includes(secret))
        throw new InferenceError('secret survived redaction', 'configuration');
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode: 0o644 });
    renameSync(temp, path);
  }
}
