// Rolling request/cache/error metrics of the checkout API (ARCHITECTURE.md 9.1,
// 9.4). Error classes, cache ratio and error rate are computed over a sliding
// window so that a repaired fault disappears from /metrics (and from the
// normalized `checkout.metrics` observation) instead of persisting for the
// life of the process. Cumulative counters are kept for information and are
// excluded from normalization (finding D2).
export const ERROR_CLASSES = [
  'cache_decode_error',
  'pool_timeout',
  'statement_timeout',
  'writes_disabled',
  'redis_unavailable',
  'config_invalid',
  'db_unavailable',
  'internal_error',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const METRICS_WINDOW_MS = 30_000;

export interface MetricsSnapshot {
  service: 'checkout';
  windowMs: number;
  requests: { total: number; window: number; windowServerErrors: number };
  cache: {
    hits: number;
    misses: number;
    windowHits: number;
    windowMisses: number;
  };
  errors: {
    /** cumulative per class since process start (raw, not normalized) */
    byClass: Record<string, number>;
    /** classes seen inside the window, sorted */
    windowClasses: string[];
  };
  /** Latest decode error inside the window (D7): what the API expected vs found. */
  cache_decode_error: {
    expectedSchema: number;
    foundSchema: number | null;
  } | null;
}

interface ErrorEvent {
  t: number;
  cls: ErrorClass;
  expectedSchema?: number;
  foundSchema?: number | null;
}

export class CheckoutMetrics {
  private requests: { t: number; serverError: boolean }[] = [];
  private cacheEvents: { t: number; hit: boolean }[] = [];
  private errors: ErrorEvent[] = [];
  private totalRequests = 0;
  private totalHits = 0;
  private totalMisses = 0;
  private readonly totalByClass = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = METRICS_WINDOW_MS,
  ) {}

  recordRequest(status: number) {
    this.totalRequests += 1;
    this.requests.push({ t: this.now(), serverError: status >= 500 });
  }

  recordCache(hit: boolean) {
    if (hit) this.totalHits += 1;
    else this.totalMisses += 1;
    this.cacheEvents.push({ t: this.now(), hit });
  }

  recordError(
    cls: ErrorClass,
    detail?: { expectedSchema: number; foundSchema: number | null },
  ) {
    this.totalByClass.set(cls, (this.totalByClass.get(cls) ?? 0) + 1);
    this.errors.push({ t: this.now(), cls, ...detail });
  }

  private prune() {
    const cutoff = this.now() - this.windowMs;
    const keep = <T extends { t: number }>(events: T[]) =>
      events.filter((event) => event.t > cutoff);
    this.requests = keep(this.requests);
    this.cacheEvents = keep(this.cacheEvents);
    this.errors = keep(this.errors);
  }

  snapshot(): MetricsSnapshot {
    this.prune();
    const decode = [...this.errors]
      .reverse()
      .find((event) => event.cls === 'cache_decode_error');
    return {
      service: 'checkout',
      windowMs: this.windowMs,
      requests: {
        total: this.totalRequests,
        window: this.requests.length,
        windowServerErrors: this.requests.filter((r) => r.serverError).length,
      },
      cache: {
        hits: this.totalHits,
        misses: this.totalMisses,
        windowHits: this.cacheEvents.filter((e) => e.hit).length,
        windowMisses: this.cacheEvents.filter((e) => !e.hit).length,
      },
      errors: {
        byClass: Object.fromEntries(
          [...this.totalByClass.entries()].sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        ),
        windowClasses: [...new Set(this.errors.map((e) => e.cls))].sort(),
      },
      cache_decode_error:
        decode && decode.expectedSchema !== undefined
          ? {
              expectedSchema: decode.expectedSchema,
              foundSchema: decode.foundSchema ?? null,
            }
          : null,
    };
  }
}
