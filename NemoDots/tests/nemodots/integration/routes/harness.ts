// Route fixtures: the REAL upstream createApp (its /api/* middleware: host,
// Origin, Sec-Fetch-Site, owner token, JSON-only mutations, 1 MB body) with
// nemodotsRoutes mounted under /api/nemodots, over a real migrated PostgreSQL
// database and the real coordinator. app.ts is not edited: createApp registers
// its middleware first, and a route mounted afterwards runs behind it exactly
// as W5 will mount it.
//
// Labelled doubles: the owner edit, the injector trigger, the model list and
// the checkout fetch are injected per test; Store/Runner are the upstream
// in-memory ones createApp needs.
import { createSseParser } from '../../../../src/client/nemodots/mission-stream.js';
import { createApp } from '../../../../src/server/app.js';
import { Runner } from '../../../../src/server/runner.js';
import type { Config } from '../../../../src/server/research.js';
import { Store } from '../../../../src/server/store.js';
import type { Hono } from 'hono';
import {
  nemodotsRoutes,
  type NemoDotsRouteDeps,
} from '../../../../src/server/nemodots/routes/index.js';
import type { Harness } from '../coordinator/harness.js';

export const OWNER_TOKEN = 'owner-token-for-route-tests';
export const FIXTURE_ENV = {
  NEMODOTS_INFERENCE_MODE: 'fixture',
  NEMODOTS_FIXTURE_PATH: '/nonexistent/fixture.jsonl',
};
export const LIVE_SECRET_KEY = 'sk-route-test-secret-key-0001';
export const LIVE_ENV = {
  OPENAI_API_KEY: LIVE_SECRET_KEY,
  OPENAI_BASE_URL: 'https://inference.example.test/v1',
  OPENAI_MODEL: 'nvidia/test-model',
};

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };

export interface RouteFixture {
  app: Hono;
  fetchApi(
    path: string,
    init?: RequestInit & { token?: string | null },
  ): Promise<Response>;
  post(path: string, body: unknown, token?: string | null): Promise<Response>;
  get(path: string, token?: string | null): Promise<Response>;
}

export type RouteOverrides = Partial<NemoDotsRouteDeps>;

export function mountRoutes(
  h: Pick<Harness, 'pool' | 'coordinator' | 'db'>,
  overrides: RouteOverrides = {},
  options: { ownerToken?: string | null } = {},
) {
  const store = new Store(':memory:');
  const runner = new Runner(store, config);
  const ownerToken =
    options.ownerToken === null
      ? undefined
      : (options.ownerToken ?? OWNER_TOKEN);
  const app = createApp({ store, runner, config, ownerToken });
  app.route(
    '/api/nemodots',
    nemodotsRoutes({
      pool: h.pool,
      control: h.coordinator.control,
      ownerId: 'owner',
      env: FIXTURE_ENV,
      ownerEdit: async () => {
        throw new Error('ownerEdit not configured for this test');
      },
      injector: {
        async run() {
          throw new Error('injector not configured for this test');
        },
      },
      stream: { pollMs: 50, heartbeatMs: 10_000, writeTimeoutMs: 5_000 },
      ...overrides,
    }),
  );
  const call = (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const { token = ownerToken ?? null, headers, ...rest } = init;
    const merged = new Headers(headers);
    if (token && !merged.has('authorization'))
      merged.set('authorization', `Bearer ${token}`);
    return Promise.resolve(
      app.request(`http://localhost/api/nemodots${path}`, {
        ...rest,
        headers: merged,
      }),
    );
  };
  const fixture: RouteFixture = {
    app,
    fetchApi: call,
    get: (path, token) => call(path, { token }),
    post: (path, body, token) =>
      call(path, {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
  return { ...fixture, close: () => store.close() };
}

export interface OpenStream {
  response: Response;
  /** Parsed SSE messages in arrival order. */
  messages: { id: string | null; event: string; data: string }[];
  /** Ids of the written events, in order. */
  ids(): number[];
  /** Everything received, raw (comments included). */
  raw(): string;
  closed(): boolean;
  close(): Promise<void>;
}

export async function openStream(
  fixture: RouteFixture,
  path: string,
  headers: Record<string, string> = {},
): Promise<OpenStream> {
  const response = await fixture.fetchApi(path, { headers });
  const messages: OpenStream['messages'] = [];
  let raw = '';
  let closed = false;
  const parser = createSseParser((m) => messages.push(m));
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        parser.push(text);
      }
    } catch {
      // cancelled
    } finally {
      closed = true;
    }
  })();
  return {
    response,
    messages,
    ids: () => messages.map((m) => Number(m.id)),
    raw: () => raw,
    closed: () => closed,
    async close() {
      await reader?.cancel().catch(() => {});
      await pump;
    },
  };
}
