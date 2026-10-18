// Shared fixture for the sandbox integration tests: a fresh migrated database,
// a random Redis prefix, per-role pools, the seeded checkout and an in-process
// checkout app driven through `app.request` (no TCP, same code as production).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  createCheckoutApp,
  type CheckoutRuntime,
} from '../../../../src/server/nemodots/sandbox/checkout-app.js';
import { CONFIG_CACHE_MS } from '../../../../src/server/nemodots/sandbox/checkout-db.js';
import type { PreconditionDeps } from '../../../../src/server/nemodots/sandbox/preconditions.js';
import {
  Injector,
  type ScenarioRun,
} from '../../../../src/server/nemodots/sandbox/injector.js';
import { loadScenario } from '../../../../src/server/nemodots/sandbox/manifest.js';
import { preconditionDepsFromReaders } from '../../../../src/server/nemodots/sandbox/preconditions.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import type { Scope } from '../../../../src/server/nemodots/contracts/ids.js';
import { seedCheckout } from '../../../../src/server/nemodots/sandbox/seed.js';
import { probeHeaderValue } from '../../../../src/server/nemodots/sandbox/probe-auth.js';
import { withTestDatabase, type TestDatabase } from '../../helpers/test-db.js';
import { withTestRedis, type TestRedis } from '../../helpers/test-redis.js';

/** Response bodies are checked field by field in the tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface Pools {
  admin: pg.Pool;
  app: pg.Pool;
  checkout: pg.Pool;
  injector: pg.Pool;
  verifier: pg.Pool;
}

export interface Sandbox {
  db: TestDatabase;
  redis: TestRedis;
  pools: Pools;
  runtime: CheckoutRuntime;
  probeSecret: string;
  /** A controllable clock: the checkout's config cache and metrics windows use it. */
  clock: { now(): number; advance(ms: number): void };
  /** Lets the 250 ms configuration cache expire so the next request re-reads config. */
  reloadConfig(): void;
  request(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<{ status: number; body: Json }>;
  probeHeader(runId: string): Record<string, string>;
  /** A fetch that routes to the in-process app, for readers/probe under test. */
  fetch: typeof fetch;
  /**
   * Starts a development-set scenario with the injector role. Unless
   * `verify: false`, it resolves only after the scenario's preconditions were
   * established and its symptoms were seen through the production readers
   * (rejects with ScenarioPreconditionFailed otherwise).
   */
  inject(
    id: string,
    seed?: number,
    options?: { verify?: boolean },
  ): Promise<ScenarioRun>;
  /** Preconditions deps over this sandbox's readers (the clock is advanced between polls). */
  preconditionDeps(): PreconditionDeps;
}

export interface SandboxOptions {
  seed?: boolean;
  /** Override the Redis URL the checkout uses (to simulate Redis being down). */
  redisUrl?: string;
}

const CHECKOUT_URL = 'http://checkout.invalid';
const TEST_SCOPE = {
  ownerId: 'owner',
  missionId: '11111111-1111-4111-8111-111111111111',
  spaceId: null,
  environment: 'test',
  resource: 'checkout',
} as unknown as Scope;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withSandbox<T>(
  fn: (sandbox: Sandbox) => Promise<T>,
  options: SandboxOptions = {},
): Promise<T> {
  return withTestDatabase(async (db) =>
    withTestRedis(async (redis) => {
      const make = (url: string, max = 4) =>
        new pg.Pool({ connectionString: url, max });
      const pools: Pools = {
        admin: make(db.urls.admin),
        app: make(db.urls.app),
        checkout: make(db.urls.checkout),
        injector: make(db.urls.injector),
        verifier: make(db.urls.verifier),
      };
      for (const pool of Object.values(pools)) pool.on('error', () => {});
      const probeSecret = randomBytes(16).toString('hex');
      let offset = 0;
      const base = Date.now();
      const clock = {
        now: () => base + offset,
        advance: (ms: number) => {
          offset += ms;
        },
      };
      let runtime: CheckoutRuntime | undefined;
      const runs: ScenarioRun[] = [];
      try {
        if (options.seed !== false) await seedCheckout(pools.admin);
        runtime = createCheckoutApp({
          pgUrl: db.urls.checkout,
          redisUrl: options.redisUrl ?? redis.url,
          redisPrefix: redis.prefix,
          probeSecret,
          now: clock.now,
        });
        const app = runtime.app;
        const sandbox: Sandbox = {
          db,
          redis,
          pools,
          runtime,
          probeSecret,
          clock,
          reloadConfig: () => clock.advance(CONFIG_CACHE_MS + 1),
          async request(path, init = {}) {
            const response = await app.request(path, {
              method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
              headers: {
                ...(init.body === undefined
                  ? {}
                  : { 'content-type': 'application/json' }),
                ...init.headers,
              },
              body:
                init.body === undefined ? undefined : JSON.stringify(init.body),
            });
            const text = await response.text();
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            return { status: response.status, body };
          },
          fetch: async (input, init) => {
            const url = new URL(String(input));
            return app.request(url.pathname + url.search, {
              method: init?.method,
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              body: init?.body as string | undefined,
            });
          },
          probeHeader: (runId) => ({
            'x-nemodots-probe': probeHeaderValue(probeSecret, runId),
          }),
          preconditionDeps() {
            return preconditionDepsFromReaders(
              createSourceReaders({
                pg: pools.verifier,
                redis: redis.client,
                redisPrefix: redis.prefix,
                checkoutUrl: CHECKOUT_URL,
                fetch: sandbox.fetch,
                now: clock.now,
              }),
              TEST_SCOPE,
              {
                checkoutUrl: CHECKOUT_URL,
                fetch: sandbox.fetch,
                // the checkout's configuration cache and health self-test
                // follow the controllable clock
                sleep: async (ms: number) => {
                  clock.advance(CONFIG_CACHE_MS + 1);
                  await sleep(Math.min(ms, 20));
                },
              },
            );
          },
          async inject(id, seed = 1, options = {}) {
            const injector = new Injector({
              pool: pools.injector,
              listenUrl: db.urls.injector,
              preconditions:
                options.verify === false
                  ? undefined
                  : sandbox.preconditionDeps(),
            });
            const manifest = loadScenario(id);
            const run =
              options.verify === false
                ? await injector.start(manifest, seed)
                : await injector.startVerified(manifest, seed);
            runs.push(run);
            return run;
          },
        };
        if (!options.redisUrl) {
          // wait for the checkout's Redis connection
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            if ((await sandbox.request('/ready')).status === 200) break;
            await sleep(50);
          }
        }
        return await fn(sandbox);
      } finally {
        for (const run of runs) await run.cancel().catch(() => {});
        await runtime?.close();
        await Promise.all(
          Object.values(pools).map((pool) => pool.end().catch(() => {})),
        );
      }
    }),
  );
}
