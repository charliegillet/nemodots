import type {
  FinishReason,
  InferenceAttempt,
  InferenceErrorClass,
  Usage,
} from '../contracts/model-call.js';

// A fetch wrapper for the openaiCompatibleText `fetch` client option
// (dot-agent.ts). It observes the raw chat-completions exchange the TanStack
// adapter hides: the HTTP status, the model the provider says it served, the
// raw usage object (so "cached tokens unavailable" stays null instead of
// becoming 0, LEAD_NOTES), and the timings. It never reads or stores request
// bodies or headers, so no key or prompt text can leak through it.
//
// It delegates to `globalThis.fetch` at call time, so a test that replaces
// the global keeps working, and it returns the original Response untouched:
// the observer reads a clone.

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export interface HttpExchange {
  /** 1-based position within the collector. */
  sequence: number;
  /** Index of the model call this exchange belongs to (see beginCall). */
  callIndex: number;
  startedAt: string;
  headersAt: string | null;
  firstContentAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  streamed: boolean;
  modelReturned: string | null;
  /** The provider's usage object exactly as sent (no key material), or null. */
  rawUsage: Record<string, unknown> | null;
  usage: Usage;
  finishReason: FinishReason | null;
  error: {
    class: InferenceErrorClass;
    code: string | null;
    errorId: string | null;
  } | null;
  retryAfterMs: number | null;
}

const NO_USAGE: Usage = Object.freeze({
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
});

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** null = unavailable (field absent or null), never coerced to 0. */
export function normalizeRawUsage(raw: Record<string, unknown> | null): Usage {
  if (!raw) return NO_USAGE;
  return {
    promptTokens: count(raw.prompt_tokens),
    completionTokens: count(raw.completion_tokens),
    cachedTokens: count(object(raw.prompt_tokens_details)?.cached_tokens),
    reasoningTokens: count(
      object(raw.completion_tokens_details)?.reasoning_tokens,
    ),
  };
}

const FINISH_REASONS: readonly FinishReason[] = [
  'stop',
  'tool_calls',
  'length',
  'content_filter',
];

function statusClass(status: number): InferenceErrorClass {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 503 || status === 502) return 'provider_unavailable';
  return 'provider_error';
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function errorCode(body: string): string | null {
  try {
    const detail = object(object(JSON.parse(body))?.error);
    const raw = detail?.code ?? detail?.type;
    return typeof raw === 'string' ? raw : null;
  } catch {
    return null;
  }
}

const isAbort = (error: unknown) =>
  error instanceof Error &&
  (error.name === 'AbortError' || error.name === 'TimeoutError');

export interface FetchTelemetryOptions {
  /** Defaults to globalThis.fetch resolved on every call. */
  base?: FetchLike;
  now?: () => Date;
  /** Bound on how long takeCall waits for a stream to finish being read. */
  settleTimeoutMs?: number;
}

export class FetchTelemetry {
  private readonly exchanges: HttpExchange[] = [];
  private readonly settling = new Map<number, Promise<void>>();
  private call = 0;
  private readonly now: () => Date;
  private readonly settleTimeoutMs: number;

  constructor(private readonly options: FetchTelemetryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.settleTimeoutMs = options.settleTimeoutMs ?? 5000;
  }

  /** Marks the start of a model call; later exchanges belong to it. */
  beginCall(): number {
    this.call += 1;
    return this.call;
  }

  /** The exchanges of one model call, once their streams have been read. */
  async takeCall(callIndex: number = this.call): Promise<HttpExchange[]> {
    const own = this.exchanges.filter((e) => e.callIndex === callIndex);
    const pending = own
      .map((e) => this.settling.get(e.sequence))
      .filter((p): p is Promise<void> => p !== undefined);
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.settleTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return own;
  }

  all(): readonly HttpExchange[] {
    return this.exchanges;
  }

  /** Bound arrow so it can be passed directly as the `fetch` client option. */
  readonly fetch: FetchLike = async (input, init) => {
    const base: FetchLike =
      this.options.base ?? ((i, o) => globalThis.fetch(i, o));
    const exchange: HttpExchange = {
      sequence: this.exchanges.length + 1,
      callIndex: this.call,
      startedAt: this.now().toISOString(),
      headersAt: null,
      firstContentAt: null,
      finishedAt: null,
      httpStatus: null,
      streamed: false,
      modelReturned: null,
      rawUsage: null,
      usage: NO_USAGE,
      finishReason: null,
      error: null,
      retryAfterMs: null,
    };
    this.exchanges.push(exchange);
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      exchange.finishedAt = this.now().toISOString();
      exchange.error = {
        class: isAbort(error) ? 'cancelled' : 'network',
        code: error instanceof Error ? error.name : null,
        errorId: null,
      };
      if (isAbort(error)) exchange.finishReason = 'cancelled';
      throw error;
    }
    exchange.headersAt = this.now().toISOString();
    exchange.httpStatus = response.status;
    exchange.retryAfterMs = retryAfterMs(response);
    let observed: Response | undefined;
    try {
      observed = response.clone();
    } catch {
      observed = undefined;
    }
    if (observed)
      this.settling.set(
        exchange.sequence,
        this.read(exchange, observed).catch((error: unknown) => {
          exchange.finishedAt ??= this.now().toISOString();
          if (!exchange.error)
            exchange.error = {
              class: isAbort(error) ? 'cancelled' : 'network',
              code: error instanceof Error ? error.name : null,
              errorId: null,
            };
          if (isAbort(error)) {
            exchange.finishReason = 'cancelled';
            exchange.usage = NO_USAGE;
            exchange.rawUsage = null;
          }
        }),
      );
    else exchange.finishedAt = this.now().toISOString();
    return response;
  };

  private async read(exchange: HttpExchange, response: Response) {
    const type = response.headers.get('content-type') ?? '';
    exchange.streamed = type.includes('text/event-stream');
    const errorId = response.headers.get('x-request-id');
    if (!response.ok) {
      const body = (await response.text()).slice(0, 4096);
      exchange.error = {
        class: statusClass(response.status),
        code: errorCode(body),
        errorId,
      };
      exchange.finishedAt = this.now().toISOString();
      return;
    }
    if (!exchange.streamed) {
      this.absorb(exchange, await response.text());
      exchange.firstContentAt = exchange.headersAt;
      exchange.finishedAt = this.now().toISOString();
      this.finish(exchange);
      return;
    }
    if (!response.body) {
      exchange.finishedAt = this.now().toISOString();
      return;
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.absorbLine(exchange, line);
    }
    buffer += decoder.decode();
    if (buffer) this.absorbLine(exchange, buffer);
    exchange.finishedAt = this.now().toISOString();
    this.finish(exchange);
  }

  private finish(exchange: HttpExchange) {
    exchange.usage = normalizeRawUsage(exchange.rawUsage);
  }

  private absorbLine(exchange: HttpExchange, line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    this.absorb(exchange, payload, true);
  }

  private absorb(exchange: HttpExchange, json: string, chunk = false) {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = object(JSON.parse(json));
    } catch {
      return;
    }
    if (!parsed) return;
    if (typeof parsed.model === 'string' && parsed.model)
      exchange.modelReturned = parsed.model;
    const usage = object(parsed.usage);
    if (usage) exchange.rawUsage = usage;
    const choice = object(
      Array.isArray(parsed.choices) ? parsed.choices[0] : null,
    );
    if (!choice) return;
    const delta = object(choice.delta) ?? object(choice.message);
    if (
      chunk &&
      !exchange.firstContentAt &&
      delta &&
      (delta.content ||
        delta.reasoning ||
        delta.reasoning_content ||
        delta.tool_calls)
    )
      exchange.firstContentAt = this.now().toISOString();
    const reason = choice.finish_reason;
    if (typeof reason === 'string') {
      const known = FINISH_REASONS.find((r) => r === reason);
      if (known) exchange.finishReason = known;
      else if (reason === 'function_call') exchange.finishReason = 'tool_calls';
    }
  }
}

export function createFetchTelemetry(options?: FetchTelemetryOptions) {
  return new FetchTelemetry(options);
}

/** Maps a finished exchange onto the contract's InferenceAttempt. */
export function toInferenceAttempt(
  exchange: HttpExchange,
  n: number,
): InferenceAttempt {
  const cancelled =
    exchange.finishReason === 'cancelled' ||
    exchange.error?.class === 'cancelled';
  return {
    n,
    startedAt: exchange.startedAt,
    headersAt: exchange.headersAt,
    firstContentAt: exchange.firstContentAt,
    finishedAt: exchange.finishedAt,
    httpStatus: exchange.httpStatus,
    usage: cancelled ? NO_USAGE : exchange.usage,
    finishReason: cancelled
      ? 'cancelled'
      : exchange.error && !exchange.finishReason
        ? 'error'
        : exchange.finishReason,
    error: exchange.error,
    retryAfterMs: exchange.retryAfterMs,
    streamed: exchange.streamed,
    outcome: 'recorded',
  };
}
