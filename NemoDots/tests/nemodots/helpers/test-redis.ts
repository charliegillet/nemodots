// withTestRedis: a random key prefix on the NemoDots Redis (56379 by default,
// never 6379). Cleanup UNLINKs only keys under that prefix; FLUSHALL/FLUSHDB
// are never used because other tests and the dev stack share the server.
import { randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import {
  DEFAULT_REDIS_PORT,
  assertSafeRedisUrl,
} from '../../../src/server/nemodots/config/env.js';

export type TestRedisClient = ReturnType<typeof createClient>;

export interface TestRedis {
  client: TestRedisClient;
  url: string;
  /** Unique prefix such as `nemodots:test:1a2b3c4d5e6f`; namespace every key with it. */
  prefix: string;
}

export function testRedisUrl(env = process.env) {
  const url =
    env.NEMODOTS_REDIS_URL ??
    `redis://127.0.0.1:${env.NEMODOTS_REDIS_PORT ?? DEFAULT_REDIS_PORT}/0`;
  assertSafeRedisUrl('NEMODOTS_REDIS_URL', url);
  return url;
}

/** UNLINKs every key under `prefix:` and returns how many were removed. */
export async function unlinkByPrefix(client: TestRedisClient, prefix: string) {
  if (!/^[A-Za-z0-9:_-]+$/.test(prefix) || prefix.length < 8)
    throw new Error('Refusing to unlink by an empty or unusual prefix.');
  let removed = 0;
  const batch: string[] = [];
  for await (const keys of client.scanIterator({
    MATCH: `${prefix}:*`,
    COUNT: 500,
  })) {
    batch.push(...keys);
    while (batch.length >= 500)
      removed += await client.unlink(batch.splice(0, 500));
  }
  if (batch.length) removed += await client.unlink(batch);
  return removed;
}

export async function withTestRedis<T>(
  fn: (redis: TestRedis) => Promise<T>,
): Promise<T> {
  const url = testRedisUrl();
  const prefix = `nemodots:test:${randomBytes(6).toString('hex')}`;
  const client = createClient({ url });
  client.on('error', () => {});
  await client.connect();
  try {
    return await fn({ client, url, prefix });
  } finally {
    try {
      await unlinkByPrefix(client, prefix);
    } finally {
      client.destroy();
    }
  }
}
