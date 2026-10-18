// Health probes for the NemoDots composition root. Each probe is bounded by a
// timeout, never throws, and returns only states and names: no URLs with
// credentials, no keys, no response bodies. Provider reachability is cached so
// a polling UI does not turn into a stream of billed or rate-limited requests.
import type { createClient } from 'redis';
import type { HealthStatus } from './contracts/index.js';
import { listModels, type HttpTarget } from './inference/health.js';

type RedisLike = Pick<ReturnType<typeof createClient>, 'ping'> & {
  isOpen?: boolean;
};

export interface ProbeSet {
  provider: () => Promise<{
    reachable: boolean;
    modelListed: boolean;
    checkedAt: string | null;
  }>;
  redis: () => Promise<'ok' | 'down'>;
  checkout: () => Promise<HealthStatus['checkout']>;
}

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
};

export function createProbes(options: {
  /** null when the mode is not live (fixture and blocked never contact a provider). */
  provider: { target: HttpTarget; model: string } | null;
  redis: RedisLike | null;
  checkoutUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  providerCacheMs?: number;
}): ProbeSet {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.providerCacheMs ?? 30_000;
  let cached: {
    at: number;
    value: Awaited<ReturnType<ProbeSet['provider']>>;
  } | null = null;
  return {
    async provider() {
      if (!options.provider)
        return { reachable: false, modelListed: false, checkedAt: null };
      if (cached && now() - cached.at < cacheMs) return cached.value;
      const checkedAt = new Date(now()).toISOString();
      const value = await listModels(options.provider.target).then(
        (ids) => ({
          reachable: true,
          modelListed: ids.includes(options.provider!.model),
          checkedAt,
        }),
        () => ({ reachable: false, modelListed: false, checkedAt }),
      );
      cached = { at: now(), value };
      return value;
    },
    async redis() {
      if (!options.redis) return 'down';
      return withTimeout(
        Promise.resolve(options.redis.ping()).then(
          () => 'ok' as const,
          () => 'down' as const,
        ),
        2_000,
        'down' as const,
      );
    },
    async checkout() {
      return withTimeout(
        doFetch(`${options.checkoutUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        }).then(async (response) => {
          const body = (await response.json().catch(() => null)) as {
            status?: unknown;
          } | null;
          const status =
            body?.status === 'ok' ||
            body?.status === 'degraded' ||
            body?.status === 'down'
              ? body.status
              : null;
          return { reachable: true, status };
        }),
        2_500,
        { reachable: false, status: null },
      );
    },
  };
}
