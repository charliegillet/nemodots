import { INFERENCE_RETRY } from '../contracts/index.js';

/** FIFO counting semaphore; waiters can be aborted. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    grant: () => void;
    cancel: (reason: unknown) => void;
  }> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('semaphore limit must be a positive integer');
  }

  get inFlight() {
    return this.active;
  }
  get queued() {
    return this.waiters.length;
  }

  /** Resolves with a release function; rejects with signal.reason when aborted while queued. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          resolve(this.releaser());
        },
        cancel: reject,
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.grant();
    };
  }
}

/**
 * Delay before retry number `retry` (1-based): base * 2^(retry-1) capped, with
 * up to +25% jitter, then raised to the provider's retry-after (when present)
 * and capped again. Never below the base delay.
 */
export function backoffMs(
  retry: number,
  opts: {
    baseMs?: number;
    capMs?: number;
    retryAfterMs?: number | null;
    random?: () => number;
  } = {},
): number {
  const base = opts.baseMs ?? INFERENCE_RETRY.baseMs;
  const cap = opts.capMs ?? INFERENCE_RETRY.capMs;
  const random = opts.random ?? Math.random;
  const exponential = Math.min(cap, base * 2 ** (retry - 1));
  const jittered = exponential * (1 + 0.25 * random());
  const wanted = Math.max(jittered, opts.retryAfterMs ?? 0);
  return Math.round(Math.min(cap, Math.max(base, wanted)));
}
