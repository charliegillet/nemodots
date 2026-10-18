import type { InferenceErrorClass } from '../contracts/index.js';

// Provider error classification. Crusoe returns
//   {"code": "...", "message": "...", "error_id": "..."}
// (observed live, CRUSOE_SMOKE_PRE item 7a) while OpenAI-compatible gateways
// return {"error": {"message", "type", "code"}}; both are parsed. Only the
// class, code and error id are kept: messages can echo request content.

export interface ClassifiedError {
  class: InferenceErrorClass;
  code: string | null;
  errorId: string | null;
  retryAfterMs: number | null;
}

const MAX_FIELD = 120;
const clip = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_FIELD)
    : typeof value === 'number'
      ? String(value)
      : null;

/** Extracts {code, errorId} from either envelope; unparsable bodies give nulls. */
export function parseErrorEnvelope(body: unknown): {
  code: string | null;
  errorId: string | null;
} {
  let value: unknown = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return { code: null, errorId: null };
    }
  }
  if (!value || typeof value !== 'object') return { code: null, errorId: null };
  const top = value as Record<string, unknown>;
  const nested =
    top.error && typeof top.error === 'object'
      ? (top.error as Record<string, unknown>)
      : null;
  if (nested)
    return {
      code: clip(nested.code) ?? clip(nested.type),
      errorId: clip(nested.error_id) ?? clip(top.error_id),
    };
  return {
    code: clip(top.code) ?? clip(top.type),
    errorId: clip(top.error_id),
  };
}

/** retry-after: delta-seconds or an HTTP date. Returns milliseconds or null. */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function classifyStatus(status: number): InferenceErrorClass {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 502 || status === 503) return 'provider_unavailable';
  return 'provider_error';
}

export function classifyHttpError(
  status: number,
  body: string,
  headers: { get(name: string): string | null },
  now?: number,
): ClassifiedError {
  const envelope = parseErrorEnvelope(body);
  return {
    class: classifyStatus(status),
    code: envelope.code,
    errorId: envelope.errorId,
    retryAfterMs: parseRetryAfter(headers.get('retry-after'), now),
  };
}

/** An error object delivered inside a 200 SSE stream. */
export function classifyStreamError(body: unknown): ClassifiedError {
  const envelope = parseErrorEnvelope(body);
  const code = envelope.code?.toLowerCase() ?? '';
  const cls: InferenceErrorClass =
    code.includes('rate') || code.includes('max_requests')
      ? 'rate_limited'
      : code.includes('unavailable') || code.includes('overloaded')
        ? 'provider_unavailable'
        : 'provider_error';
  return { class: cls, ...envelope, retryAfterMs: null };
}
