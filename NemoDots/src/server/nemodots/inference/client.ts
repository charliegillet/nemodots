import {
  INFERENCE_RETRY,
  RETRYABLE_INFERENCE_ERRORS,
  type ChatRequest,
  type ChatToolCall,
  type FinishReason,
  type InferenceAttempt,
  type InferenceErrorClass,
  type ModelCallOutcome,
  type Usage,
} from '../contracts/index.js';
import {
  classifyHttpError,
  classifyStreamError,
  type ClassifiedError,
} from './errors.js';
import { listModels, verifyModel } from './health.js';
import { buildChatBody, validateStrictOutput } from './request.js';
import { SseParser } from './sse.js';
import { Semaphore, backoffMs } from './throttle.js';
import {
  InferenceError,
  type InferenceAdapter,
  type StampedChatResult,
} from './types.js';

// Crusoe/Nemotron adapter on global fetch (no SDK). It is the only way
// NemoDots reasoning reaches a model: one base URL and one key, both required,
// no default host, no fallback provider. It never logs; request bodies and
// headers exist only on the wire. Retries apply to inference only (a pure
// function of the request), never to tool execution, which does not exist here.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_IN_FLIGHT = 4;

export interface InferenceClientOptions {
  /** Required. No default (finding I1). */
  baseUrl: string;
  apiKey: string;
  /** Per-model concurrent requests; NEMODOTS_INFERENCE_MAX_IN_FLIGHT. */
  maxInFlight?: number;
  /** Idle bound: time to response headers and every gap between body chunks. */
  timeoutMs?: number;
  /** Overall per-attempt deadline (default 60 s), so keepalive comments or a token trickle cannot hold a slot forever. */
  deadlineMs?: number;
  retry?: { baseMs?: number; capMs?: number; maxRetries?: number };
  /** Test seams. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Optional per-delta observer (live tests cancel after N deltas; a UI may stream). */
export type StreamObserver = (delta: {
  content: string | null;
  reasoning: string | null;
}) => void;

export interface CompleteContext {
  signal: AbortSignal;
  modelCallId: string;
  role: string;
  onDelta?: StreamObserver;
}

export const NULL_USAGE: Usage = Object.freeze({
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  reasoningTokens: null,
});

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Raw provider usage -> Usage. cachedTokens is null when prompt_tokens_details is absent/null. */
export function parseUsage(raw: unknown): Usage {
  const usage = record(raw);
  if (!usage) return { ...NULL_USAGE };
  return {
    promptTokens: count(usage.prompt_tokens),
    completionTokens: count(usage.completion_tokens),
    cachedTokens: count(record(usage.prompt_tokens_details)?.cached_tokens),
    reasoningTokens: count(
      record(usage.completion_tokens_details)?.reasoning_tokens,
    ),
  };
}

function mapFinish(raw: unknown): FinishReason | null {
  switch (raw) {
    case 'stop':
    case 'length':
    case 'content_filter':
    case 'tool_calls':
      return raw;
    case 'function_call':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return 'error';
  }
}

class AttemptFailure extends Error {
  constructor(readonly failure: ClassifiedError) {
    super(failure.class);
  }
}
const fail = (cls: InferenceErrorClass, code: string): never => {
  throw new AttemptFailure({
    class: cls,
    code,
    errorId: null,
    retryAfterMs: null,
  });
};

interface Parsed {
  model: string | null;
  content: string | null;
  reasoning: string | null;
  toolCalls: ChatToolCall[];
  finish: FinishReason | null;
  usage: Usage;
}

class Accumulator {
  model: string | null = null;
  content = '';
  reasoning = '';
  finish: FinishReason | null = null;
  rawUsage: unknown = undefined;
  sawDone = false;
  firstContentAt: string | null = null;
  readonly tools = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  constructor(
    private readonly now: () => string,
    private readonly onDelta?: StreamObserver,
  ) {}

  /** One SSE `data:` payload. */
  chunk(payload: string) {
    if (payload.trim() === '[DONE]') {
      this.sawDone = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return fail('invalid_response', 'malformed_sse_json');
    }
    const body = record(json);
    if (!body) return fail('invalid_response', 'malformed_sse_json');
    if (body.error !== undefined && body.choices === undefined)
      throw new AttemptFailure(classifyStreamError(body));
    if (typeof body.model === 'string') this.model = body.model;
    if (body.usage !== undefined && body.usage !== null)
      this.rawUsage = body.usage;
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = record(choices[0]);
    if (!choice) return;
    const delta = record(choice.delta) ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.firstContentAt ??= this.now();
      this.content += delta.content;
    }
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === 'string') this.reasoning += reasoning;
    if (this.onDelta) {
      const content =
        typeof delta.content === 'string' && delta.content.length > 0
          ? delta.content
          : null;
      const thought =
        typeof reasoning === 'string' && reasoning.length > 0
          ? reasoning
          : null;
      if (content !== null || thought !== null) {
        try {
          this.onDelta({ content, reasoning: thought });
        } catch {
          // an observer must never break inference
        }
      }
    }
    if (Array.isArray(delta.tool_calls))
      for (const raw of delta.tool_calls) {
        const call = record(raw);
        if (!call) continue;
        const index = count(call.index) ?? 0;
        const entry = this.tools.get(index) ?? { id: '', name: '', args: '' };
        if (typeof call.id === 'string' && call.id) entry.id ||= call.id;
        const fn = record(call.function);
        if (typeof fn?.name === 'string') entry.name += fn.name;
        if (typeof fn?.arguments === 'string') entry.args += fn.arguments;
        this.tools.set(index, entry);
      }
    const finish = mapFinish(choice.finish_reason);
    if (finish) this.finish = finish;
  }

  finalize(): Parsed {
    if (this.finish === null && !this.sawDone)
      fail('network', 'stream_truncated');
    if (this.finish === null) fail('invalid_response', 'missing_finish_reason');
    return {
      model: this.model,
      content: this.content === '' ? null : this.content,
      reasoning: this.reasoning === '' ? null : this.reasoning,
      toolCalls: toolCallList(this.tools),
      finish: this.finish,
      usage: parseUsage(this.rawUsage),
    };
  }
}

function toolCallList(
  tools: Map<number, { id: string; name: string; args: string }>,
): ChatToolCall[] {
  return [...tools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => {
      if (!call.id || !call.name)
        return fail('invalid_response', 'tool_call_incomplete');
      return { toolCallId: call.id, name: call.name, arguments: call.args };
    });
}

function parseCompletionJson(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('invalid_response', 'malformed_json');
  }
  const body = record(json);
  if (!body) return fail('invalid_response', 'malformed_json');
  if (body.error !== undefined && body.choices === undefined)
    throw new AttemptFailure(classifyStreamError(body));
  const choice = record(Array.isArray(body.choices) ? body.choices[0] : null);
  const message = record(choice?.message);
  if (!choice || !message) return fail('invalid_response', 'no_choices');
  const tools = new Map<number, { id: string; name: string; args: string }>();
  if (Array.isArray(message.tool_calls))
    message.tool_calls.forEach((raw, index) => {
      const call = record(raw);
      const fn = record(call?.function);
      tools.set(index, {
        id: typeof call?.id === 'string' ? call.id : '',
        name: typeof fn?.name === 'string' ? fn.name : '',
        args: typeof fn?.arguments === 'string' ? fn.arguments : '',
      });
    });
  const finish = mapFinish(choice.finish_reason);
  if (!finish) return fail('invalid_response', 'missing_finish_reason');
  const reasoning = message.reasoning ?? message.reasoning_content;
  return {
    model: typeof body.model === 'string' ? body.model : null,
    content:
      typeof message.content === 'string' && message.content !== ''
        ? message.content
        : null,
    reasoning:
      typeof reasoning === 'string' && reasoning !== '' ? reasoning : null,
    toolCalls: toolCallList(tools),
    finish,
    usage: parseUsage(body.usage),
  };
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

type TryResult =
  | { kind: 'ok'; attempt: InferenceAttempt; parsed: Parsed }
  | { kind: 'cancelled'; attempt: InferenceAttempt; partial: Partial<Parsed> }
  | { kind: 'error'; attempt: InferenceAttempt; failure: ClassifiedError };

export class CrusoeInferenceClient implements InferenceAdapter {
  readonly mode = 'live' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly hostName: string;
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;
  private readonly deadlineMs: number;
  private readonly retry: { baseMs: number; capMs: number; maxRetries: number };
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(options: InferenceClientOptions) {
    if (!options.baseUrl)
      throw new InferenceError(
        'OPENAI_BASE_URL is required; there is no default provider',
        'configuration',
      );
    if (!options.apiKey)
      throw new InferenceError('OPENAI_API_KEY is required', 'configuration');
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new InferenceError(
        'OPENAI_BASE_URL is not a valid URL',
        'configuration',
      );
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new InferenceError(
        'OPENAI_BASE_URL must be http(s)',
        'configuration',
      );
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.hostName = url.host;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    new Semaphore(this.maxInFlight); // validates the limit
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = {
      baseMs: options.retry?.baseMs ?? INFERENCE_RETRY.baseMs,
      capMs: options.retry?.capMs ?? INFERENCE_RETRY.capMs,
      maxRetries: options.retry?.maxRetries ?? INFERENCE_RETRY.maxRetries,
    };
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  host(): string {
    return this.hostName;
  }

  /** Snapshot for tests and diagnostics: in-flight and queued per model. */
  load(model: string) {
    const semaphore = this.semaphores.get(model);
    return {
      inFlight: semaphore?.inFlight ?? 0,
      queued: semaphore?.queued ?? 0,
    };
  }

  listModels(signal?: AbortSignal): Promise<string[]> {
    return listModels(this.http(), signal);
  }

  verifyModel(model: string, signal?: AbortSignal): Promise<boolean> {
    return verifyModel(this.http(), model, signal);
  }

  private http() {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      timeoutMs: this.timeoutMs,
    };
  }

  private semaphoreFor(model: string) {
    let semaphore = this.semaphores.get(model);
    if (!semaphore) {
      semaphore = new Semaphore(this.maxInFlight);
      this.semaphores.set(model, semaphore);
    }
    return semaphore;
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  async complete(
    req: ChatRequest,
    ctx: CompleteContext,
  ): Promise<StampedChatResult> {
    const body = JSON.stringify(buildChatBody(req)); // throws on invalid requests
    const semaphore = this.semaphoreFor(req.model);
    const attempts: InferenceAttempt[] = [];
    const stamp = { host: this.hostName, mode: 'live' as const };
    const finish = (
      outcome: ModelCallOutcome,
      parsed: Partial<Parsed>,
      finishReason: FinishReason | null,
      usage: Usage,
    ): StampedChatResult => ({
      modelReturned: parsed.model ?? null,
      content: parsed.content ?? null,
      reasoning: parsed.reasoning ?? null,
      toolCalls: outcome === 'aborted' ? [] : (parsed.toolCalls ?? []),
      finishReason,
      usage,
      attempts,
      outcome,
      provider: stamp,
    });

    for (let n = 1; ; n++) {
      const result = await this.tryOnce(req, body, ctx, n, semaphore);
      attempts.push(result.attempt);
      if (result.kind === 'cancelled')
        return finish('aborted', result.partial, 'cancelled', {
          ...NULL_USAGE,
        });
      if (result.kind === 'ok') {
        const outcome = this.judge(req, result.parsed);
        return finish(
          outcome,
          result.parsed,
          result.parsed.finish,
          result.parsed.usage,
        );
      }
      const retryable = (
        RETRYABLE_INFERENCE_ERRORS as readonly string[]
      ).includes(result.failure.class);
      if (!retryable || n > this.retry.maxRetries)
        return finish('failed', {}, 'error', { ...NULL_USAGE });
      const delay = backoffMs(n, {
        ...this.retry,
        retryAfterMs: result.failure.retryAfterMs,
        random: this.random,
      });
      try {
        await this.sleep(delay, ctx.signal);
      } catch {
        return finish('aborted', {}, 'cancelled', { ...NULL_USAGE });
      }
    }
  }

  private judge(req: ChatRequest, parsed: Parsed): ModelCallOutcome {
    if (parsed.toolCalls.length > 0)
      return parsed.finish === 'length' ? 'invalid_output' : 'tool_calls';
    if (parsed.finish === 'tool_calls') return 'invalid_output';
    if (req.responseFormat) {
      const checked =
        parsed.finish === 'stop'
          ? validateStrictOutput(req.responseFormat.schema, parsed.content)
          : { ok: false as const };
      return checked.ok ? 'completed' : 'invalid_output';
    }
    return 'completed';
  }

  private async tryOnce(
    req: ChatRequest,
    body: string,
    ctx: CompleteContext,
    n: number,
    semaphore: Semaphore,
  ): Promise<TryResult> {
    const attempt: InferenceAttempt = {
      n,
      startedAt: this.iso(),
      headersAt: null,
      firstContentAt: null,
      finishedAt: null,
      httpStatus: null,
      usage: { ...NULL_USAGE },
      finishReason: null,
      error: null,
      retryAfterMs: null,
      streamed: req.stream,
      outcome: 'recorded',
    };
    const cancelled = (partial: Partial<Parsed> = {}): TryResult => {
      attempt.finishedAt = this.iso();
      attempt.finishReason = 'cancelled';
      attempt.error = { class: 'cancelled', code: null, errorId: null };
      attempt.usage = { ...NULL_USAGE };
      return { kind: 'cancelled', attempt, partial };
    };
    let release: () => void;
    try {
      release = await semaphore.acquire(ctx.signal);
    } catch {
      return cancelled();
    }
    attempt.startedAt = this.iso();

    const controller = new AbortController();
    let timedOut = false;
    let deadlineHit = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      deadlineHit = true;
      controller.abort();
    }, this.deadlineMs);
    // Rejects the moment the controller aborts, so a read that the runtime
    // fails to reject on abort can never hold a semaphore slot.
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true },
      ),
    );
    aborted.catch(() => undefined);
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const accumulator = new Accumulator(() => this.iso(), ctx.onDelta);
    try {
      if (ctx.signal.aborted) return cancelled();
      arm();
      const response = await Promise.race([
        aborted,
        fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            accept: req.stream ? 'text/event-stream' : 'application/json',
            'x-request-id': ctx.modelCallId,
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        }),
      ]);
      attempt.headersAt = this.iso();
      attempt.httpStatus = response.status;
      if (!response.ok) {
        const text = await Promise.race([aborted, response.text()]);
        const failure = classifyHttpError(
          response.status,
          text.slice(0, 16_384),
          response.headers,
          this.now(),
        );
        return this.errored(attempt, failure);
      }
      let parsed: Parsed;
      if (req.stream) {
        if (!response.body) return fail('invalid_response', 'no_body');
        const parser = new SseParser();
        const reader = response.body.getReader();
        for (;;) {
          arm();
          const { done, value } = await Promise.race([aborted, reader.read()]);
          if (done) break;
          for (const payload of parser.push(value)) accumulator.chunk(payload);
          attempt.firstContentAt ??= accumulator.firstContentAt;
        }
        for (const payload of parser.end()) accumulator.chunk(payload);
        attempt.firstContentAt ??= accumulator.firstContentAt;
        parsed = accumulator.finalize();
      } else {
        parsed = parseCompletionJson(
          await Promise.race([aborted, response.text()]),
        );
      }
      attempt.finishedAt = this.iso();
      attempt.usage = parsed.usage;
      attempt.finishReason = parsed.finish;
      return { kind: 'ok', attempt, parsed };
    } catch (error) {
      if (ctx.signal.aborted)
        return cancelled({
          model: accumulator.model,
          content: accumulator.content === '' ? null : accumulator.content,
          reasoning:
            accumulator.reasoning === '' ? null : accumulator.reasoning,
        });
      if (error instanceof AttemptFailure)
        return this.errored(attempt, error.failure);
      return this.errored(attempt, {
        class: timedOut ? 'timeout' : 'network',
        code: deadlineHit
          ? 'client_deadline'
          : timedOut
            ? 'client_timeout'
            : networkCode(error),
        errorId: null,
        retryAfterMs: null,
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      ctx.signal.removeEventListener('abort', onAbort);
      controller.abort(); // frees the socket if the body was not fully read
      release();
    }
  }

  private errored(
    attempt: InferenceAttempt,
    failure: ClassifiedError,
  ): TryResult {
    attempt.finishedAt = this.iso();
    attempt.finishReason = 'error';
    attempt.usage = { ...NULL_USAGE };
    attempt.retryAfterMs = failure.retryAfterMs;
    attempt.error = {
      class: failure.class,
      code: failure.code,
      errorId: failure.errorId,
    };
    return { kind: 'error', attempt, failure };
  }
}

function networkCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string'
    ? cause.code.slice(0, 60)
    : 'fetch_failed';
}
