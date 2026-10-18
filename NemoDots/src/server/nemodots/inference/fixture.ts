import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  DigestSchema,
  FinishReasonSchema,
  UsageSchema,
  digest,
  type ChatRequest,
  type InferenceAttempt,
} from '../contracts/index.js';
import {
  InferenceError,
  type InferenceAdapter,
  type StampedChatResult,
} from './types.js';

// Fixture replay adapter (NEMODOTS_INFERENCE_MODE=fixture). It replays
// recorded or hand-authored responses keyed by
// digest(model, system, messages, toolSchemaHash), refuses requests it has no
// entry for (never improvising an answer), and stamps every result
// provider.mode = 'fixture' so a fixture run can never be counted as live.

export const FIXTURE_FORMAT = 'nemodots.inference.fixture.v1';

export const FixtureEntrySchema = z
  .object({
    key: DigestSchema,
    /** Informational: digests and sizes only, never request content. */
    request: z
      .object({
        model: z.string().min(1),
        systemDigest: DigestSchema,
        messageCount: z.number().int().nonnegative(),
        toolSchemaHash: DigestSchema.nullable(),
      })
      .strict(),
    response: z
      .object({
        modelReturned: z.string().min(1).nullable(),
        content: z.string().nullable(),
        reasoning: z.string().nullable(),
        toolCalls: z.array(
          z
            .object({
              toolCallId: z.string().min(1),
              name: z.string().min(1),
              arguments: z.string(),
            })
            .strict(),
        ),
        finishReason: FinishReasonSchema,
        usage: UsageSchema,
        outcome: z.enum(['completed', 'tool_calls', 'invalid_output']),
      })
      .strict(),
  })
  .strict();
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export const FixtureFileSchema = z
  .object({
    format: z.literal(FIXTURE_FORMAT),
    /** Human label shown wherever the fixture is used; fixtures are never live evidence. */
    label: z.string().min(1),
    provenance: z.enum(['hand-authored', 'recorded-live']),
    host: z.string().min(1).default('fixture.local'),
    models: z.array(z.string().min(1)).default([]),
    entries: z.array(FixtureEntrySchema),
  })
  .strict();
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

/** The model-visible parts of a request that identify a replayable call. */
export function fixtureKeyInput(req: ChatRequest) {
  const [system, ...messages] = req.messages;
  if (!system || system.role !== 'system')
    throw new InferenceError(
      'first message must be the system message',
      'invalid_request',
    );
  return {
    model: req.model,
    system: system.content,
    messages,
    toolSchemaHash:
      req.toolSchemaHash ?? (req.tools.length > 0 ? digest(req.tools) : null),
  };
}

export function fixtureKey(req: ChatRequest): string {
  return digest(fixtureKeyInput(req));
}

export function fixtureRequestInfo(req: ChatRequest): FixtureEntry['request'] {
  const input = fixtureKeyInput(req);
  return {
    model: input.model,
    systemDigest: digest(input.system),
    messageCount: input.messages.length,
    toolSchemaHash: input.toolSchemaHash,
  };
}

export function parseFixtureFile(text: string): FixtureFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InferenceError('fixture file is not JSON', 'configuration');
  }
  const parsed = FixtureFileSchema.safeParse(json);
  if (!parsed.success)
    throw new InferenceError(
      `fixture file is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
      'configuration',
    );
  const keys = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (keys.has(entry.key))
      throw new InferenceError(
        `duplicate fixture key ${entry.key}`,
        'configuration',
      );
    keys.add(entry.key);
  }
  return parsed.data;
}

export class FixtureInference implements InferenceAdapter {
  readonly mode = 'fixture' as const;
  private readonly entries: Map<string, FixtureEntry>;

  constructor(
    private readonly file: FixtureFile,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = new Map(file.entries.map((entry) => [entry.key, entry]));
  }

  get label() {
    return this.file.label;
  }

  host(): string {
    return this.file.host;
  }

  async listModels(): Promise<string[]> {
    const models = new Set([
      ...this.file.models,
      ...this.file.entries.map((entry) => entry.request.model),
    ]);
    return [...models];
  }

  async verifyModel(model: string): Promise<boolean> {
    return (await this.listModels()).includes(model);
  }

  async complete(
    req: ChatRequest,
    ctx: { signal: AbortSignal },
  ): Promise<StampedChatResult> {
    const key = fixtureKey(req);
    const entry = this.entries.get(key);
    if (!entry)
      throw new InferenceError(
        `no fixture for key ${key} (model ${req.model}); fixture mode never improvises`,
        'fixture_miss',
        'fixture_miss',
      );
    const at = new Date(this.now()).toISOString();
    const stamp = { host: this.file.host, mode: 'fixture' as const };
    const nullUsage = {
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    };
    if (ctx.signal.aborted) {
      const attempt: InferenceAttempt = {
        n: 1,
        startedAt: at,
        headersAt: null,
        firstContentAt: null,
        finishedAt: at,
        httpStatus: null,
        usage: nullUsage,
        finishReason: 'cancelled',
        error: { class: 'cancelled', code: null, errorId: null },
        retryAfterMs: null,
        streamed: false,
        outcome: 'recorded',
      };
      return {
        modelReturned: null,
        content: null,
        reasoning: null,
        toolCalls: [],
        finishReason: 'cancelled',
        usage: nullUsage,
        attempts: [attempt],
        outcome: 'aborted',
        provider: stamp,
      };
    }
    const response = entry.response;
    // Timings are replay times, not the recorded ones: a replay never claims
    // provider latency it did not measure.
    const attempt: InferenceAttempt = {
      n: 1,
      startedAt: at,
      headersAt: null,
      firstContentAt: null,
      finishedAt: at,
      httpStatus: null,
      usage: response.usage,
      finishReason: response.finishReason,
      error: null,
      retryAfterMs: null,
      streamed: false,
      outcome: 'recorded',
    };
    return {
      modelReturned: response.modelReturned,
      content: response.content,
      reasoning: response.reasoning,
      toolCalls: response.toolCalls.map((call) => ({ ...call })),
      finishReason: response.finishReason,
      usage: response.usage,
      attempts: [attempt],
      outcome: response.outcome,
      provider: stamp,
    };
  }
}

/** Loads a fixture adapter; a missing path is an error, never an empty adapter. */
export function loadFixtureAdapter(path: string | undefined): FixtureInference {
  if (!path)
    throw new InferenceError(
      'NEMODOTS_FIXTURE_PATH is required for fixture mode',
      'configuration',
    );
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new InferenceError('fixture file cannot be read', 'configuration');
  }
  return new FixtureInference(parseFixtureFile(text));
}
