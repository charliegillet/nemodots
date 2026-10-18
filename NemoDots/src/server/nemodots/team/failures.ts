// Inference failures become explicit attempt outcomes. A provider that cannot
// be reached stops reasoning visibly (the task returns to the pool without
// using an attempt); rate limits, timeouts and refusals fail the attempt with
// their class named; nothing is retried here (the adapter already retried).
import type { ChatResult } from '../contracts/index.js';
import type { HandlerOutcome } from '../coordinator/index.js';

export function lastErrorClass(result: ChatResult): string | null {
  for (let i = result.attempts.length - 1; i >= 0; i -= 1) {
    const error = result.attempts[i].error;
    if (error) return error.class;
  }
  return null;
}

/** null when the call produced a usable (or correctable) result. */
export function failureOutcome(result: ChatResult): HandlerOutcome | null {
  if (result.outcome === 'failed') {
    const errorClass = lastErrorClass(result) ?? 'provider_error';
    switch (errorClass) {
      case 'network':
      case 'provider_unavailable':
        return { type: 'abort', reason: 'provider_unreachable' };
      case 'rate_limited':
        return { type: 'failed', reason: 'inference_rate_limited' };
      case 'timeout':
        return { type: 'failed', reason: 'inference_timeout' };
      case 'invalid_response':
        return { type: 'failed', reason: 'invalid_output' };
      default:
        return { type: 'failed', reason: `inference_${errorClass}` };
    }
  }
  const last = result.attempts.at(-1);
  if (last?.finishReason === 'content_filter')
    return { type: 'failed', reason: 'inference_refused' };
  return null;
}
