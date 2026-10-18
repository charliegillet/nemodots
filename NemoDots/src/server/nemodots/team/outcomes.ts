import type { ChatResult } from '../contracts/index.js';
import type { HandlerOutcome } from '../coordinator/worker-host.js';

// Explicit failure states for a model call (BUILD_PROMPT: provider and model
// failures are visible, never silent). The adapter has already retried
// rate limits, timeouts and unavailability with jittered backoff; what is
// left here is the final disposition.

export type CallDisposition =
  | { kind: 'ok' }
  /** Malformed or truncated output; the caller may spend its one correction. */
  | { kind: 'invalid' }
  /** The call was cancelled; the host decides whether the attempt aborted. */
  | { kind: 'cancelled' }
  | { kind: 'stop'; outcome: HandlerOutcome };

export function classifyCall(result: ChatResult): CallDisposition {
  if (result.outcome === 'aborted') return { kind: 'cancelled' };
  if (result.outcome === 'failed') {
    const error = result.attempts[result.attempts.length - 1]?.error ?? null;
    switch (error?.class) {
      case 'rate_limited':
        return {
          kind: 'stop',
          outcome: { type: 'failed', reason: 'inference_rate_limited' },
        };
      case 'timeout':
        return {
          kind: 'stop',
          outcome: { type: 'failed', reason: 'inference_timeout' },
        };
      case 'provider_unavailable':
      case 'network':
        // Returns the task to the pool without spending an attempt.
        return {
          kind: 'stop',
          outcome: { type: 'abort', reason: 'provider_unreachable' },
        };
      case 'cancelled':
        return { kind: 'cancelled' };
      default:
        return {
          kind: 'stop',
          outcome: {
            type: 'failed',
            reason: `inference_failed${error?.code ? `:${error.code}` : ''}`,
          },
        };
    }
  }
  if (result.finishReason === 'content_filter')
    return {
      kind: 'stop',
      outcome: { type: 'failed', reason: 'model_refused' },
    };
  if (result.outcome === 'invalid_output') return { kind: 'invalid' };
  return { kind: 'ok' };
}
