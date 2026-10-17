import { randomUUID } from 'node:crypto';
import { classifyHttpError, parseErrorEnvelope } from './errors.js';
import { InferenceError } from './types.js';

// Model discovery. GET /v1/models lists served models (13 on Crusoe,
// 2026-10-17); verifyModel falls back to a one-token probe when a model is
// not listed so the Crusoe 404 `model_not_found` envelope is the arbiter.

export interface HttpTarget {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

async function request(
  target: HttpTarget,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(target.timeoutMs);
  try {
    return await fetch(`${target.baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        'x-request-id': randomUUID(),
      },
      body: init.body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
  } catch {
    if (signal?.aborted)
      throw new InferenceError('request cancelled', 'cancelled');
    throw new InferenceError(
      timeout.aborted ? 'request timed out' : 'network error',
      timeout.aborted ? 'timeout' : 'network',
    );
  }
}

async function fail(response: Response): Promise<never> {
  const text = await response.text().catch(() => '');
  const failure = classifyHttpError(
    response.status,
    text.slice(0, 16_384),
    response.headers,
  );
  throw new InferenceError(
    `provider returned HTTP ${response.status}`,
    failure.class,
    failure.code,
    response.status,
  );
}

export async function listModels(
  target: HttpTarget,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await request(target, '/models', { method: 'GET' }, signal);
  if (!response.ok) return fail(response);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new InferenceError('malformed /models response', 'invalid_response');
  }
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new InferenceError('malformed /models response', 'invalid_response');
  return data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

export async function verifyModel(
  target: HttpTarget,
  model: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if ((await listModels(target, signal)).includes(model)) return true;
  const response = await request(
    target,
    '/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        reasoning_effort: 'none',
        stream: false,
      }),
    },
    signal,
  );
  if (response.ok) {
    await response.body?.cancel();
    return true;
  }
  const text = await response.text().catch(() => '');
  const { code } = parseErrorEnvelope(text);
  if (response.status === 404 && (code === null || /not_found/i.test(code)))
    return false;
  throw new InferenceError(
    `provider returned HTTP ${response.status}`,
    classifyHttpError(response.status, text, response.headers).class,
    code,
    response.status,
  );
}
