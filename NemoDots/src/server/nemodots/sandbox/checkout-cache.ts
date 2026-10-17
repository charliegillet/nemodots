// Redis cache-aside of the checkout API (ARCHITECTURE.md 9.1, 9.2).
//
// Keys: `<prefix>:cache:<namespace>:v<schema>:<name>`. Values are JSON blobs
// `{ schema, name, storedAt, data }`.
//
// A namespace is a versioned format domain. A lookup under the expected
// schema vN that misses first checks the namespace for entries stored under
// another schema vM; finding any means the cache holds blobs this build can
// not decode, and the API answers 500 cache_decode_error (expectedSchema N,
// foundSchema M) instead of silently mixing formats. This is how a changed
// `cache.schema_version` (fault class F2) becomes observable; flushing the
// namespace or setting the version back repairs it.
import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

export class CacheDecodeError extends Error {
  constructor(
    readonly expectedSchema: number,
    readonly foundSchema: number | null,
  ) {
    super(
      `cache holds entries with schema ${foundSchema ?? 'unknown'}, this build expects ${expectedSchema}`,
    );
    this.name = 'CacheDecodeError';
  }
}

export class RedisUnavailableError extends Error {
  constructor(message = 'redis is not available') {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

export const CACHE_TTL_SECONDS = 3600;
const OP_TIMEOUT_MS = 500;
const MAX_SCAN_ITERATIONS = 100;

export const cacheKeyPrefix = (prefix: string, namespace: string) =>
  `${prefix}:cache:${namespace}:`;

export const cacheKey = (
  prefix: string,
  namespace: string,
  schema: number,
  name: string,
) => `${cacheKeyPrefix(prefix, namespace)}v${schema}:${name}`;

export interface ParsedCacheKey {
  namespace: string;
  schema: number;
  name: string;
}

/** Inverse of cacheKey; null for keys that are not cache entries of this prefix. */
export function parseCacheKey(
  prefix: string,
  key: string,
): ParsedCacheKey | null {
  const head = `${prefix}:cache:`;
  if (!key.startsWith(head)) return null;
  const match = /^([a-z0-9-]{1,32}):v(\d+):(.+)$/.exec(key.slice(head.length));
  if (!match) return null;
  return {
    namespace: match[1],
    schema: Number(match[2]),
    name: match[3],
  };
}

async function guarded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RedisUnavailableError('redis timed out')),
          OP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof RedisUnavailableError) throw error;
    throw new RedisUnavailableError(
      error instanceof Error ? error.message : 'redis error',
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface CacheSettings {
  cacheNamespace: string;
  cacheSchemaVersion: number;
}

export class CheckoutCache {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
  ) {}

  get ready() {
    return this.redis.isReady;
  }

  private assertReady() {
    if (!this.redis.isReady) throw new RedisUnavailableError();
  }

  async ping(): Promise<boolean> {
    try {
      this.assertReady();
      return (await guarded(this.redis.ping())) === 'PONG';
    } catch {
      return false;
    }
  }

  /** Schemas of entries in `namespace` other than `expected`, ascending. */
  private async foreignSchemas(namespace: string, expected: number) {
    this.assertReady();
    const found = new Set<number>();
    const head = cacheKeyPrefix(this.prefix, namespace);
    const iterator = this.redis.scanIterator({
      MATCH: `${head}v*`,
      COUNT: 500,
    });
    let iterations = 0;
    const scan = async () => {
      for await (const keys of iterator) {
        for (const key of keys) {
          const parsed = parseCacheKey(this.prefix, key as string);
          if (parsed && parsed.schema !== expected) found.add(parsed.schema);
        }
        iterations += 1;
        if (iterations >= MAX_SCAN_ITERATIONS) break;
      }
    };
    await guarded(scan());
    return [...found].sort((a, b) => a - b);
  }

  /**
   * Cache-aside read. Throws CacheDecodeError on a schema mismatch and
   * RedisUnavailableError when Redis cannot be reached (callers fall back to
   * the loader).
   */
  async readThrough<T>(
    settings: CacheSettings,
    name: string,
    loader: () => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> {
    const expected = settings.cacheSchemaVersion;
    const key = cacheKey(this.prefix, settings.cacheNamespace, expected, name);
    this.assertReady();
    const raw = await guarded(this.redis.get(key));
    if (raw !== null) {
      let blob: { schema?: unknown; name?: unknown; data?: unknown };
      try {
        blob = JSON.parse(raw as string);
      } catch {
        throw new CacheDecodeError(expected, null);
      }
      if (blob.schema !== expected || blob.name !== name)
        throw new CacheDecodeError(
          expected,
          typeof blob.schema === 'number' ? blob.schema : null,
        );
      return { value: blob.data as T, hit: true };
    }
    const foreign = await this.foreignSchemas(
      settings.cacheNamespace,
      expected,
    );
    if (foreign.length) throw new CacheDecodeError(expected, foreign[0]);
    const value = await loader();
    await guarded(
      this.redis.set(
        key,
        JSON.stringify({
          schema: expected,
          name,
          storedAt: new Date(this.now()).toISOString(),
          data: value,
        }),
        { EX: CACHE_TTL_SECONDS },
      ),
    );
    return { value, hit: false };
  }
}
