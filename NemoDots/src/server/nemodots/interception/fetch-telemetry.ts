// Observes the chat-completions requests the OpenAI-compatible adapter makes
// for a Dot turn. It is passed as the adapter's `fetch`, so it sees the real
// provider exchange: timing, status, usage and the returned model. It never
// stores request or response bodies, only counts and ids. Unavailable usage is
// null, never 0. Cancelled requests record every usage field as null.
import type {
  FinishReason,
  InferenceErrorClass,
  Usage,
} from '../contracts/index.js';

export interface ObservedRequest {
  n: number;
  host: string;
  startedAt: string;
  headersAt: string | null;
  firstContentAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  streamed: boolean;
  usage: Usage;
  finishReason: FinishReason | null;
  modelReturned: string | null;
  error: {
    class: InferenceErrorClass;
    code: string | null;
    errorId: string | null;
  } | null;
}

export interface FetchTelemetry {
  fetch: typeof fetch;
  /** Requests observed so far, in start order. */
  readonly requests: readonly ObservedRequest[];
  /** Resolves when every response body seen so far has been fully read. */
  settled(): Promise<void>;
}

const nullUsage = (): Usage => ({
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
});
const num = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;

function usageFrom(raw: unknown): Usage | null {
  const usage = obj(raw);
  if (!usage) return null;
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    cachedTokens: num(obj(usage.prompt_tokens_details)?.cached_tokens),
    reasoningTokens: num(
      obj(usage.completion_tokens_details)?.reasoning_tokens,
    ),
  };
}

const FINISH = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
const finishFrom = (value: unknown): FinishReason | null =>
  typeof value === 'string' && FINISH.has(value)
    ? (value as FinishReason)
    : null;

function errorClass(status: number): InferenceErrorClass {
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_error';
}

export function createFetchTelemetry(
  options: { baseFetch?: typeof fetch; now?: () => Date } = {},
): FetchTelemetry {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const requests: ObservedRequest[] = [];
  const pending = new Set<Promise<void>>();

  const track = (promise: Promise<void>) => {
    const guarded = promise.catch(() => undefined);
    pending.add(guarded);
    void guarded.then(() => pending.delete(guarded));
  };

  const observeStream = async (
    body: ReadableStream<Uint8Array>,
    record: ObservedRequest,
    signal: AbortSignal | null | undefined,
  ) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let chunk: Record<string, unknown> | null;
      try {
        chunk = obj(JSON.parse(data));
      } catch {
        return;
      }
      if (!chunk) return;
      if (typeof chunk.model === 'string') record.modelReturned = chunk.model;
      const usage = usageFrom(chunk.usage);
      if (usage) record.usage = usage;
      const choice = obj(
        Array.isArray(chunk.choices) ? chunk.choices[0] : null,
      );
      if (!choice) return;
      const delta = obj(choice.delta);
      const content = delta?.content;
      if (!record.firstContentAt && typeof content === 'string' && content)
        record.firstContentAt = iso();
      if (!record.firstContentAt && Array.isArray(delta?.tool_calls))
        record.firstContentAt = iso();
      record.finishReason =
        finishFrom(choice.finish_reason) ?? record.finishReason;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          handle(buffer.slice(0, index).replace(/\r$/, ''));
          buffer = buffer.slice(index + 1);
        }
      }
      handle(buffer);
    } catch {
      if (!signal?.aborted && !record.error)
        record.error = { class: 'network', code: null, errorId: null };
    } finally {
      record.finishedAt = iso();
      if (signal?.aborted) {
        record.finishReason = 'cancelled';
        record.error = { class: 'cancelled', code: null, errorId: null };
        record.usage = nullUsage();
      }
    }
  };

  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // Resolve at call time so a test or runtime that replaces globalThis.fetch
    // is honoured.
    const base = options.baseFetch ?? globalThis.fetch;
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    if (!url.pathname.endsWith('/chat/completions')) return base(input, init);
    const record: ObservedRequest = {
      n: requests.length + 1,
      host: url.host,
      startedAt: iso(),
      headersAt: null,
      firstContentAt: null,
      finishedAt: null,
      httpStatus: null,
      streamed: false,
      usage: nullUsage(),
      finishReason: null,
      modelReturned: null,
      error: null,
    };
    requests.push(record);
    const signal = init?.signal;
    let response: Response;
    try {
      response = await base(input, init);
    } catch {
      record.finishedAt = iso();
      record.error = signal?.aborted
        ? { class: 'cancelled', code: null, errorId: null }
        : { class: 'network', code: null, errorId: null };
      if (signal?.aborted) record.finishReason = 'cancelled';
      throw (
        (signal?.aborted ? signal.reason : undefined) ?? new Error('network')
      );
    }
    record.headersAt = iso();
    record.httpStatus = response.status;
    record.streamed = (response.headers.get('content-type') ?? '').includes(
      'text/event-stream',
    );
    if (!response.ok) {
      record.finishReason = 'error';
      record.error = {
        class: errorClass(response.status),
        code: null,
        errorId: null,
      };
      const copy = response.clone();
      track(
        copy
          .json()
          .then((body: unknown) => {
            const envelope = obj(obj(body)?.error) ?? obj(body);
            const code = envelope?.code;
            const errorId = envelope?.error_id;
            if (record.error) {
              record.error.code = typeof code === 'string' ? code : null;
              record.error.errorId =
                typeof errorId === 'string' ? errorId : null;
            }
          })
          .catch(() => undefined)
          .finally(() => {
            record.finishedAt = iso();
          }),
      );
      return response;
    }
    if (record.streamed && response.body) {
      const [forCaller, forUs] = response.body.tee();
      track(observeStream(forUs, record, signal));
      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const copy = response.clone();
    track(
      copy
        .json()
        .then((body: unknown) => {
          const parsed = obj(body);
          if (typeof parsed?.model === 'string')
            record.modelReturned = parsed.model;
          const usage = usageFrom(parsed?.usage);
          if (usage) record.usage = usage;
          const choice = obj(
            Array.isArray(parsed?.choices) ? parsed.choices[0] : null,
          );
          record.finishReason = finishFrom(choice?.finish_reason);
          record.firstContentAt = null;
        })
        .catch(() => undefined)
        .finally(() => {
          record.finishedAt = iso();
        }),
    );
    return response;
  };

  return {
    fetch: wrapped as typeof fetch,
    requests,
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
