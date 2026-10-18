import type {
  ChatRequest,
  ChatResult,
  InferencePort,
  ProviderMode,
} from '../contracts/index.js';

// ChatRequest / ChatResult / InferencePort are owned by contracts/ports.ts and
// re-exported here so the team (W4 tool loop) has one import site. The tool
// loop is not part of this package: nothing here executes a tool.
export type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatToolCall,
  InferencePort,
} from '../contracts/index.js';

/** Where a result came from; the coordinator stamps ModelCallRecord.provider from it. */
export interface ProviderStamp {
  host: string;
  mode: ProviderMode;
}

/** A ChatResult carrying the provider that produced it (structurally a ChatResult). */
export type StampedChatResult = ChatResult & { provider: ProviderStamp };

export interface InferenceAdapter extends InferencePort {
  readonly mode: ProviderMode;
  complete(
    req: ChatRequest,
    ctx: Parameters<InferencePort['complete']>[1],
  ): Promise<StampedChatResult>;
  /**
   * True when the model is served. Resolves false only for a provider
   * "model not found"; any other failure throws InferenceError.
   */
  verifyModel(model: string, signal?: AbortSignal): Promise<boolean>;
}

/** Thrown for programmer errors (invalid request shape) and non-completion failures (listModels). */
export class InferenceError extends Error {
  constructor(
    message: string,
    readonly errorClass: string,
    readonly code: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'InferenceError';
  }
}

/** Live mode requirements are unmet (or mode is blocked): the adapter refuses to exist. */
export class InferenceBlockedError extends Error {
  constructor(
    readonly missingEnv: string[],
    readonly invalidEnv: string[] = [],
    readonly reason: 'requested' | 'missing_env' = 'missing_env',
  ) {
    super(
      reason === 'requested'
        ? 'Inference is blocked by NEMODOTS_INFERENCE_MODE=blocked.'
        : `Inference is BLOCKED: set ${[...missingEnv, ...invalidEnv].join(', ')}.`,
    );
    this.name = 'InferenceBlockedError';
  }
}
