// Gate 0 items 4 (stack half) and 5:
//   G0.4d isolated stack: PostgreSQL 55432 and Redis 56379 (db 1) are healthy,
//         the user's 5432/6379 are refused by configuration
//   G0.4e seeded checkout API on 4600 is healthy, restartable, independently
//         observable, and seeding is scoped to the test database
//   G0.5  clean start / restart / setup state without Crusoe or Intelligence
//         configuration; fixture vs live vs blocked are labelled honestly
// Everything this file starts (checkout 4600, app 4601, a stub provider on an
// ephemeral port) is stopped in afterAll.
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccDb, query, type AccDb } from './helpers/acc-db.js';
import {
  APP_PORT,
  APP_ROOT,
  CHECKOUT_PORT,
  REDIS_DB_INDEX,
  REDIS_PREFIX,
  ROLES,
  SCRATCH,
  cleanEnv,
  ensureScratch,
  makeRedactor,
  portIsFree,
  run,
  sleep,
  startManaged,
  waitForHttp,
  type ManagedProcess,
} from './helpers/common.js';
import { collectNeedles } from './helpers/secrets.js';

const MIGRATE = path.join(APP_ROOT, 'src/server/nemodots/db/migrate.ts');
const SEED = path.join(APP_ROOT, 'src/server/nemodots/sandbox/seed.ts');
const CHECKOUT = path.join(
  APP_ROOT,
  'src/server/nemodots/sandbox/checkout-main.ts',
);
const APP_ENTRY = path.join(APP_ROOT, 'src/server/index.ts');
const CONTRACTS = path.join(APP_ROOT, 'src/server/nemodots/contracts/index.ts');
const CONFIG = path.join(APP_ROOT, 'src/server/nemodots/config/env.ts');
const FIXTURE = path.join(
  APP_ROOT,
  'tests/nemodots/fixtures/inference/text-completion.fixture.json',
);

let db: AccDb;
let redact: (t: string) => string;
let needles: ReturnType<typeof collectNeedles>;
const owned: ManagedProcess[] = [];
let stubServer: Server | undefined;

const redisUrl = () =>
  `redis://127.0.0.1:${db.stack.redisPort}/${REDIS_DB_INDEX}`;

function stackEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    NEMODOTS_INSTANCE: db.stack.name,
    NEMODOTS_REDIS_URL: redisUrl(),
    NEMODOTS_REDIS_PREFIX: REDIS_PREFIX,
    NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${CHECKOUT_PORT}`,
    NEMODOTS_CHECKOUT_PORT: String(CHECKOUT_PORT),
    NEMODOTS_PROBE_SECRET: db.stack.probeSecret,
  };
  for (const role of ROLES)
    env[`NEMODOTS_PG_URL_${role.toUpperCase()}`] = db.urls[role];
  return cleanEnv({ ...env, ...extra });
}

const requireEntry = (file: string, what: string) => {
  if (!existsSync(file))
    throw new Error(
      `ENTRY POINT MISSING: ${path.relative(APP_ROOT, file)} (${what}). Required by gate 0 item 4.`,
    );
};

beforeAll(async () => {
  db = await createAccDb();
  needles = collectNeedles([]);
  redact = makeRedactor([
    db.stack.probeSecret,
    ...ROLES.map((r) => decodeURIComponent(new URL(db.urls[r]).password)),
    ...needles.map((n) => n.value),
  ]);
  const migrate = await run('node', ['--import', 'tsx', MIGRATE], {
    cwd: APP_ROOT,
    env: cleanEnv({ NEMODOTS_PG_URL_ADMIN: db.urls.admin }),
    logName: 'g0-stack-migrate.log',
    timeoutMs: 120_000,
    redact,
  });
  if (migrate.code !== 0)
    throw new Error(`migration of ${db.name} failed: ${migrate.tail}`);
}, 300_000);

afterAll(async () => {
  for (const proc of owned.reverse()) await proc.stop().catch(() => undefined);
  await new Promise<void>((resolve) =>
    stubServer ? stubServer.close(() => resolve()) : resolve(),
  );
  try {
    const client = createClient({ url: redisUrl() });
    await client.connect();
    for await (const key of client.scanIterator({
      MATCH: `${REDIS_PREFIX}*`,
      COUNT: 200,
    })) {
      const list = Array.isArray(key) ? key : [key];
      if (list.length) await client.unlink(list);
    }
    await client.quit();
  } catch {
    /* redis already down: nothing of ours to clean */
  }
  await db?.drop().catch(() => undefined);
  for (const f of readdirSync(SCRATCH))
    if (/^app-.*\.sqlite(-shm|-wal)?$/.test(f))
      rmSync(path.join(SCRATCH, f), { force: true });
}, 120_000);

// ------------------------------------------------------------------ G0.4d

describe('G0.4d isolated stack', () => {
  it('[G0.4] PostgreSQL answers on 55432 (never 5432) as every role against the throwaway database', async () => {
    for (const role of ROLES) {
      const url = new URL(db.urls[role]);
      expect(url.port).toBe('55432');
      const rows = await query<{ u: string; d: string; p: string }>(
        db.urls[role],
        'SELECT current_user AS u, current_database() AS d, inet_server_port()::text AS p',
      );
      expect(rows[0].u).toBe(`nemodots_${role}`);
      expect(rows[0].d).toBe(db.name);
      expect(rows[0].p).toBe('55432');
    }
  });

  it('[G0.4] real Redis on 56379 db 1 stores and returns a value under the acc0 prefix', async () => {
    const client = createClient({ url: redisUrl() });
    await client.connect();
    try {
      expect(await client.ping()).toBe('PONG');
      const info = await client.info('server');
      expect(info).toMatch(/tcp_port:56379/);
      const key = `${REDIS_PREFIX}:probe:${Date.now()}`;
      await client.set(key, 'acc0', { EX: 60 });
      expect(await client.get(key)).toBe('acc0');
      await client.unlink(key);
      expect(await client.get(key)).toBeNull();
    } finally {
      await client.quit();
    }
  });

  it("[G0.4] configuration refuses the user's own PostgreSQL (5432) and Redis (6379) without echoing URLs", async () => {
    requireEntry(CONFIG, 'configuration schema');
    const mod = (await import(/* @vite-ignore */ CONFIG)) as {
      parseNemoDotsEnv(env: Record<string, string | undefined>): unknown;
    };
    // Built at run time so this file never contains a credential-shaped URL.
    const marker = ['Echo', 'Marker', '0000'].join('-');
    const scheme = ['postgres', ''].join(':') + '//';
    const secretUrl = `${scheme}nemodots_app:${marker}@127.0.0.1:5432/nemodots`;
    const cases: Record<string, string>[] = [
      { NEMODOTS_PG_PORT: '5432' },
      { NEMODOTS_REDIS_PORT: '6379' },
      { NEMODOTS_REDIS_URL: 'redis://127.0.0.1:6379/0' },
      { NEMODOTS_REDIS_URL: 'redis://127.0.0.1/0' },
      { NEMODOTS_PG_URL_APP: secretUrl },
      {
        NEMODOTS_PG_URL_APP: `${scheme}nemodots_app:${marker}@127.0.0.1/nemodots`,
      },
      {
        NEMODOTS_PG_URL_APP: `${scheme}u:${marker}@127.0.0.1:55432/n?port=5432`,
      },
    ];
    for (const env of cases) {
      let message = '';
      try {
        mod.parseNemoDotsEnv(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `no refusal for ${Object.keys(env)[0]}`).not.toBe('');
      expect(message).not.toContain(marker);
    }
  });
});

// ------------------------------------------------------------------ G0.4e

describe('G0.4e seeded checkout API', () => {
  // Free port 4600 for the G0.5 cases that start their own checkout.
  afterAll(async () => {
    while (owned.length) await owned.pop()!.stop();
  });

  const checkoutUrl = `http://127.0.0.1:${CHECKOUT_PORT}`;

  async function startCheckout(logName: string) {
    requireEntry(CHECKOUT, 'checkout API entry');
    expect(
      await portIsFree(CHECKOUT_PORT),
      `port ${CHECKOUT_PORT} is already in use`,
    ).toBe(true);
    // Minimal explicit environment, as stack.mjs gives the checkout child (finding I3).
    const proc = startManaged('node', ['--import', 'tsx', CHECKOUT], {
      cwd: APP_ROOT,
      env: cleanEnv({
        NEMODOTS_PG_URL_CHECKOUT: db.urls.checkout,
        NEMODOTS_REDIS_URL: redisUrl(),
        NEMODOTS_REDIS_PREFIX: REDIS_PREFIX,
        NEMODOTS_CHECKOUT_PORT: String(CHECKOUT_PORT),
        NEMODOTS_PROBE_SECRET: db.stack.probeSecret,
      }),
      logName,
      redact,
    });
    owned.push(proc);
    return proc;
  }

  it('[G0.4] seed populates the checkout schema with the documented data shape and is scoped to the test database', async () => {
    requireEntry(SEED, 'seed script');
    const mainBefore = await mainDbDigest();
    const seed = await run('node', ['--import', 'tsx', SEED], {
      cwd: APP_ROOT,
      env: stackEnv(),
      logName: 'g0-seed-1.log',
      timeoutMs: 180_000,
      redact,
    });
    expect(seed.code, `seed exit ${seed.code}: ${seed.tail}`).toBe(0);
    // Data shape the verifier introspects (ACCEPTANCE_CONTRACT section 6).
    const cols = await query<{ t: string; c: string }>(
      db.urls.verifier,
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'checkout'`,
    );
    const has = (t: string, c: string) =>
      cols.some((x) => x.t === t && x.c === c);
    expect(has('orders', 'probe_run_id'), 'checkout.orders.probe_run_id').toBe(
      true,
    );
    for (const c of ['order_id', 'sku', 'quantity'])
      expect(has('order_items', c), `checkout.order_items.${c}`).toBe(true);
    for (const c of ['sku', 'quantity'])
      expect(has('inventory', c), `checkout.inventory.${c}`).toBe(true);
    const inv = await query<{ n: string }>(
      db.urls.verifier,
      'SELECT count(*)::text AS n FROM checkout.inventory',
    );
    expect(Number(inv[0].n)).toBeGreaterThan(0);
    // Seeding this database must not touch the instance's main database.
    expect(await mainDbDigest()).toEqual(mainBefore);
  }, 300_000);

  it('[G0.4] a second seed run keeps the business data size stable (reset is scoped, not additive)', async () => {
    const count = async () =>
      Number(
        (
          await query<{ n: string }>(
            db.urls.verifier,
            'SELECT count(*)::text AS n FROM checkout.inventory',
          )
        )[0].n,
      );
    const before = await count();
    const seed = await run('node', ['--import', 'tsx', SEED], {
      cwd: APP_ROOT,
      env: stackEnv(),
      logName: 'g0-seed-2.log',
      timeoutMs: 180_000,
      redact,
    });
    expect(seed.code, `second seed exit ${seed.code}: ${seed.tail}`).toBe(0);
    expect(await count()).toBe(before);
  }, 300_000);

  it('[G0.4] the checkout API starts, reports ok on 4600, and its health is visible to an independent probe', async () => {
    const proc = await startCheckout('g0-checkout-1.log');
    const res = await waitForHttp(`${checkoutUrl}/health`, proc, 60_000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok');
    // Independent observation: the verifier role reads the same database the API serves.
    const inv = await query<{ n: string }>(
      db.urls.verifier,
      'SELECT count(*)::text AS n FROM checkout.inventory',
    );
    expect(Number(inv[0].n)).toBeGreaterThan(0);
    // No raw credentials in the API response.
    const text = JSON.stringify(body);
    for (const n of needles) expect(text.includes(n.value)).toBe(false);
  }, 120_000);

  it('[G0.4] stop makes health unreachable (not stale ok); restart recovers with data intact', async () => {
    const proc = owned[owned.length - 1];
    expect(proc, 'checkout was not started by the previous case').toBeDefined();
    const before = await query<{ n: string }>(
      db.urls.verifier,
      'SELECT count(*)::text AS n FROM checkout.inventory',
    );
    await proc.stop();
    await expect(
      fetch(`${checkoutUrl}/health`, { signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow();
    const again = await startCheckout('g0-checkout-2.log');
    const res = await waitForHttp(`${checkoutUrl}/health`, again, 60_000);
    expect(((await res.json()) as { status?: string }).status).toBe('ok');
    const after = await query<{ n: string }>(
      db.urls.verifier,
      'SELECT count(*)::text AS n FROM checkout.inventory',
    );
    expect(after[0].n).toBe(before[0].n);
  }, 180_000);
});

async function mainDbDigest() {
  const url = (await import('./helpers/common.js')).withDb(
    db.stack.roleUrls.verifier,
    'nemodots',
  );
  const tables = await query<{ s: string; t: string }>(
    url,
    `SELECT schemaname AS s, tablename AS t FROM pg_tables
      WHERE schemaname IN ('ledger','coordinator','checkout','control') ORDER BY 1, 2`,
  ).catch(() => []);
  const out: Record<string, string> = {};
  for (const { s, t } of tables) {
    const r = await query<{ d: string }>(
      url,
      `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS d FROM ${s}.${t} x`,
    ).catch(() => [{ d: 'unreadable' }]);
    out[`${s}.${t}`] = r[0].d;
  }
  return out;
}

// -------------------------------------------------------------------- G0.5

interface HealthJson {
  mode: string;
  missingEnv: string[];
  intelligence: string;
  postgres: string;
  redis: string;
  provider: {
    host: string | null;
    reachable: boolean;
    modelListed: boolean;
  };
  checkout: { reachable: boolean; status: string | null };
}

describe('G0.5 clean start and setup state without Crusoe or Intelligence configuration', () => {
  const base = `http://127.0.0.1:${APP_PORT}`;
  const ALL_THREE = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];

  /** Starts the app, runs fn, and always stops it (success or failure). */
  async function withApp<T>(
    label: string,
    extra: Record<string, string>,
    fn: () => Promise<T>,
  ) {
    expect(
      await portIsFree(APP_PORT),
      `port ${APP_PORT} is already in use`,
    ).toBe(true);
    const proc = startManaged('node', ['--import', 'tsx', APP_ENTRY], {
      cwd: APP_ROOT,
      env: stackEnv({
        HOST: '127.0.0.1',
        PORT: String(APP_PORT),
        DATABASE_PATH: path.join(ensureScratch(), `app-${label}.sqlite`),
        // Explicit emptiness: nothing from the developer shell can enable live mode.
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        OPENAI_MODEL: '',
        INTELLIGENCE_API_KEY: '',
        CPK_INTELLIGENCE_API_KEY: '',
        ...extra,
      }),
      logName: `g0-app-${label}.log`,
      redact,
    });
    owned.push(proc);
    try {
      await waitForHttp(`${base}/api/state`, proc, 60_000);
      return await fn();
    } finally {
      await proc.stop();
      owned.splice(owned.indexOf(proc), 1);
      await sleep(200);
    }
  }

  async function health() {
    const res = await fetch(`${base}/api/nemodots/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json: json as HealthJson };
  }

  const assertBlocked = async () => {
    const h = await health();
    expect(h.status, `health route status; body: ${h.text.slice(0, 200)}`).toBe(
      200,
    );
    const contracts = (await import(/* @vite-ignore */ CONTRACTS)) as {
      HealthStatusSchema: { safeParse(v: unknown): { success: boolean } };
    };
    expect(
      contracts.HealthStatusSchema.safeParse(h.json).success,
      'HealthStatus contract',
    ).toBe(true);
    expect(h.json.mode).toBe('blocked');
    expect([...h.json.missingEnv].sort()).toEqual(ALL_THREE);
    expect(h.json.provider.host).toBeNull();
    expect(h.json.provider.reachable).toBe(false);
    expect(h.json.provider.modelListed).toBe(false);
    expect(h.json.intelligence).toBe('blocked');
    for (const n of needles)
      expect(h.text.includes(n.value), `health leaks ${n.name}`).toBe(false);
    return h;
  };

  it(
    '[G0.5] clean start: app serves and the upstream setup state reports not configured',
    () =>
      withApp('blocked', {}, async () => {
        const res = await fetch(`${base}/api/state`);
        expect(res.status).toBe(200);
        const state = (await res.json()) as { configured?: boolean };
        expect(
          state.configured,
          'upstream configured flag must be false without Intelligence',
        ).toBe(false);
      }),
    120_000,
  );

  it(
    '[G0.5] /api/nemodots/health labels the run BLOCKED, names exactly the missing variables and reports infrastructure separately',
    () =>
      withApp('blocked', {}, async () => {
        const h = await assertBlocked();
        expect(h.json.postgres).toBe('ok');
        expect(h.json.redis).toBe('ok');
        expect(h.json.checkout.reachable).toBe(false);
      }),
    120_000,
  );

  it(
    '[G0.5] starting a mission while blocked answers 503 with missingEnv names and creates nothing',
    () =>
      withApp('blocked', {}, async () => {
        const res = await fetch(`${base}/api/nemodots/missions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goal: 'Restore the checkout application.' }),
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as {
          error?: string;
          missingEnv?: string[];
        };
        expect(typeof body.error).toBe('string');
        expect([...(body.missingEnv ?? [])].sort()).toEqual(ALL_THREE);
        const list = await fetch(`${base}/api/nemodots/missions`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual([]);
      }),
    120_000,
  );

  it('[G0.5] restart with the same storage yields the same honest blocked state', async () => {
    const first = await withApp('blocked', {}, assertBlocked);
    await expect(
      fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1500) }),
    ).rejects.toThrow();
    const second = await withApp('blocked', {}, assertBlocked);
    expect(second.json.mode).toBe(first.json.mode);
    expect([...second.json.missingEnv].sort()).toEqual(
      [...first.json.missingEnv].sort(),
    );
  }, 240_000);

  it(
    '[G0.5] a partial live configuration is still BLOCKED, names only the absent variable and invents no host',
    () =>
      withApp(
        'partial',
        {
          OPENAI_API_KEY: 'acc0-not-a-real-key-0000000000',
          OPENAI_MODEL: 'acc0-model',
        },
        async () => {
          const h = await health();
          expect(h.status, h.text.slice(0, 200)).toBe(200);
          expect(h.json.mode).toBe('blocked');
          expect(h.json.missingEnv).toEqual(['OPENAI_BASE_URL']);
          expect(h.json.provider.host).toBeNull();
          expect(h.text).not.toContain('api.openai.com');
          expect(h.text).not.toContain('acc0-not-a-real-key');
        },
      ),
    120_000,
  );

  it(
    '[G0.5] fixture mode is labelled fixture, never live',
    () =>
      withApp(
        'fixture',
        { NEMODOTS_INFERENCE_MODE: 'fixture', NEMODOTS_FIXTURE_PATH: FIXTURE },
        async () => {
          const h = await health();
          expect(h.status, h.text.slice(0, 200)).toBe(200);
          expect(h.json.mode).toBe('fixture');
          expect(h.json.missingEnv).toEqual([]);
          expect(h.json.provider.reachable).toBe(false);
        },
      ),
    120_000,
  );

  it('[G0.5] fully configured live mode with an unreachable provider is labelled live-but-unreachable, not healthy', async () => {
    // A stub that fails every request stands in for a dead provider endpoint
    // (valid for this adapter/labelling check; it proves nothing about inference).
    stubServer = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('{"error":"stub down"}');
    });
    await new Promise<void>((r) =>
      stubServer!.listen(0, '127.0.0.1', () => r()),
    );
    const addr = stubServer.address();
    const stubPort = typeof addr === 'object' && addr ? addr.port : 0;
    await withApp(
      'live',
      {
        NEMODOTS_INFERENCE_MODE: 'live',
        OPENAI_API_KEY: 'acc0-not-a-real-key-0000000000',
        OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
        OPENAI_MODEL: 'acc0-model',
      },
      async () => {
        const h = await health();
        expect(h.status, h.text.slice(0, 200)).toBe(200);
        expect(h.json.mode).toBe('live');
        expect(h.json.missingEnv).toEqual([]);
        expect(h.json.provider.host).toBe(`127.0.0.1:${stubPort}`);
        expect(h.json.provider.reachable).toBe(false);
        expect(h.json.provider.modelListed).toBe(false);
        expect(h.text).not.toContain('acc0-not-a-real-key');
      },
    );
  }, 120_000);

  it('[G0.5] with the checkout API running, health reports it reachable', async () => {
    requireEntry(CHECKOUT, 'checkout API entry');
    expect(await portIsFree(CHECKOUT_PORT)).toBe(true);
    const checkout = startManaged('node', ['--import', 'tsx', CHECKOUT], {
      cwd: APP_ROOT,
      env: cleanEnv({
        NEMODOTS_PG_URL_CHECKOUT: db.urls.checkout,
        NEMODOTS_REDIS_URL: redisUrl(),
        NEMODOTS_REDIS_PREFIX: REDIS_PREFIX,
        NEMODOTS_CHECKOUT_PORT: String(CHECKOUT_PORT),
        NEMODOTS_PROBE_SECRET: db.stack.probeSecret,
      }),
      logName: 'g0-checkout-3.log',
      redact,
    });
    owned.push(checkout);
    try {
      await waitForHttp(
        `http://127.0.0.1:${CHECKOUT_PORT}/health`,
        checkout,
        60_000,
      );
      await withApp('blocked', {}, async () => {
        const h = await health();
        expect(h.status, h.text.slice(0, 200)).toBe(200);
        expect(h.json.checkout.reachable).toBe(true);
        expect(h.json.checkout.status).toBe('ok');
        expect(h.json.mode).toBe('blocked');
      });
    } finally {
      await checkout.stop();
    }
  }, 180_000);
});
