import { resolveMode } from './mode.js';
import { CrusoeInferenceClient } from './client.js';
import { loadFixtureAdapter } from './fixture.js';
import { InferenceBlockedError, type InferenceAdapter } from './types.js';

export * from './types.js';
export { resolveMode, type ModeResolution } from './mode.js';
export {
  CrusoeInferenceClient,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_TIMEOUT_MS,
  NULL_USAGE,
  type CompleteContext,
  type StreamObserver,
  parseUsage,
  type InferenceClientOptions,
} from './client.js';
export { buildChatBody, validateStrictOutput } from './request.js';
export { SseParser } from './sse.js';
export { Semaphore, backoffMs } from './throttle.js';
export {
  classifyHttpError,
  parseErrorEnvelope,
  parseRetryAfter,
} from './errors.js';
export {
  FixtureInference,
  fixtureKey,
  fixtureRequestInfo,
  loadFixtureAdapter,
  parseFixtureFile,
  FIXTURE_FORMAT,
  type FixtureEntry,
  type FixtureFile,
} from './fixture.js';
export { RecordingInference, redactDeep, redactSecrets } from './record.js';
export { listModels, verifyModel } from './health.js';

type Env = Record<string, string | undefined>;

/**
 * Builds the adapter for the server-resolved mode. Fails closed: when live
 * requirements are unmet, or mode is blocked, this throws InferenceBlockedError
 * naming the missing variables. It never returns a different provider.
 */
export function createInferenceFromEnv(
  env: Env = process.env,
): InferenceAdapter {
  const resolved = resolveMode(env);
  if (resolved.mode === 'blocked')
    throw new InferenceBlockedError(
      resolved.missingEnv,
      resolved.invalidEnv,
      resolved.reason,
    );
  if (resolved.mode === 'fixture')
    return loadFixtureAdapter(resolved.fixturePath);
  const maxInFlight = Number(env.NEMODOTS_INFERENCE_MAX_IN_FLIGHT ?? '4');
  return new CrusoeInferenceClient({
    baseUrl: env.OPENAI_BASE_URL!.trim(),
    apiKey: env.OPENAI_API_KEY!.trim(),
    maxInFlight:
      Number.isInteger(maxInFlight) && maxInFlight >= 1
        ? Math.min(maxInFlight, 4)
        : 4,
  });
}
