// Gate 0 items 4 (stack half) and 5:
//   G0.4d isolated stack: PostgreSQL 55432 and Redis 56379 (db 1) are healthy,
//         the user's 5432/6379 are refused by configuration
//   G0.4e seeded checkout API on 4600 is healthy, restartable, independently
//         observable, and seeding is scoped to the test database
//   G0.5  clean start / restart / setup state without Crusoe or Intelligence
//         configuration; fixture vs live vs blocked are labelled honestly
// Everything this file starts (checkout 4600, app 4601, a stub provider on an
// ephemeral port) is stopped in afterAll.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccDb, query, type AccDb } from './helpers/acc-db.js';
import {
  startStubProvider,
  type StubProvider,
} from './helpers/stub-provider.js';
import {
  APP_PORT,
  APP_ROOT,
  CHECKOUT_PORT,
  REDIS_DB_INDEX,
  REDIS_PREFIX,
  ROLES,
  SCRATCH,
  appendManifest,
  cleanEnv,
  ensureScratch,
  makeRedactor,
  portIsFree,
  run,
  sleep,
  startManaged,
  waitForHttp,
  withDb,
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
let neighbour: AccDb | undefined;
let redact: (t: string) => string;
let needles: ReturnType<typeof collectNeedles>;
const owned: ManagedProcess[] = [];
const stubs: StubProvider[] = [];

const redisUrl = () =>
  `redis://127.0.0.1:${db.stack.redisPort}/${REDIS_DB_INDEX}`;

function stackEnv(extra: Record<string, string> = {}, target: AccDb = db) {
  const env: Record<string, string> = {
    NEMODOTS_INSTANCE: target.stack.name,
    NEMODOTS_REDIS_URL: redisUrl(),
    NEMODOTS_REDIS_PREFIX: REDIS_PREFIX,
    NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${CHECKOUT_PORT}`,
    NEMODOTS_CHECKOUT_PORT: String(CHECKOUT_PORT),
    NEMODOTS_PROBE_SECRET: target.stack.probeSecret,
  };
  for (const role of ROLES)
    env[`NEMODOTS_PG_URL_${role.toUpperCase()}`] = target.urls[role];
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
  for (const stub of stubs) await stub.close().catch(() => undefined);
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
  await neighbour?.drop().catch(() => undefined);
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
});

// Port refusal. Built at run time so this file never contains a
// credential-shaped URL. Every case is the full valid baseline plus ONE
// override, so a parser that throws on any input cannot pass.
describe('G0.4d configuration refuses the user PostgreSQL (5432) and Redis (6379)', () => {
  const marker = ['Echo', 'Marker', '0000'].join('-');
  const scheme = ['postgres', ''].join(':') + '//';
  const pgUrlFor = (role: string, host: string, port: string) =>
    `${scheme}nemodots_${role}:${marker}@${host}${port ? `:${port}` : ''}/nemodots`;

  const baseline = (): Record<string, string> => {
    const env: Record<string, string> = {
      NEMODOTS_INSTANCE: 'acc0',
      NEMODOTS_REDIS_URL: 'redis://127.0.0.1:56379/1',
      NEMODOTS_REDIS_PREFIX: 'acc0:g0',
      NEMODOTS_CHECKOUT_PORT: '4600',
      NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:4600',
      NEMODOTS_PROBE_SECRET: `${marker}-probe-secret-value`,
    };
    for (const role of ROLES)
      env[`NEMODOTS_PG_URL_${role.toUpperCase()}`] = pgUrlFor(
        role,
        '127.0.0.1',
        '55432',
      );
    return env;
  };

  const parser = async () => {
    requireEntry(CONFIG, 'configuration schema');
    return (await import(/* @vite-ignore */ CONFIG)) as {
      parseNemoDotsEnv(env: Record<string, string | undefined>): {
        pg: { port: number };
      };
    };
  };

  async function refusal(overrides: Record<string, string>) {
    const mod = await parser();
    let message = '';
    try {
      mod.parseNemoDotsEnv({ ...baseline(), ...overrides });
    } catch (error) {
      message = (error as Error).message;
    }
    return message;
  }

  it('[G0.4] positive control: the full baseline parses, and valid spellings (localhost, [::1]) on 55432 / 56379 are accepted', async () => {
    const mod = await parser();
    const config = mod.parseNemoDotsEnv(baseline());
    expect(config.pg.port).toBe(55432);
    for (const host of ['localhost', '[::1]']) {
      const overrides: Record<string, string> = {
        NEMODOTS_REDIS_URL: `redis://${host}:56379/1`,
      };
      for (const role of ROLES)
        overrides[`NEMODOTS_PG_URL_${role.toUpperCase()}`] = pgUrlFor(
          role,
          host,
          '55432',
        );
      expect(
        () => mod.parseNemoDotsEnv({ ...baseline(), ...overrides }),
        `${host} on the NemoDots ports must be accepted`,
      ).not.toThrow();
    }
  });

  it('[G0.4] every PostgreSQL role URL is refused on 5432, explicit or omitted, in every host spelling, and the message names the variable and never the URL', async () => {
    const failures: string[] = [];
    let cases = 0;
    for (const role of ROLES) {
      const name = `NEMODOTS_PG_URL_${role.toUpperCase()}`;
      for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
        for (const port of ['5432', '']) {
          cases += 1;
          const message = await refusal({ [name]: pgUrlFor(role, host, port) });
          if (!message)
            failures.push(`${name} ${host}:${port || '(omitted)'} accepted`);
          else {
            if (!message.includes(name))
              failures.push(
                `${name} ${host}:${port || '(omitted)'}: message omits the variable`,
              );
            if (message.includes(marker))
              failures.push(
                `${name} ${host}:${port || '(omitted)'}: message echoes the URL`,
              );
          }
        }
      }
      const viaQuery = await refusal({
        [name]: `${pgUrlFor(role, '127.0.0.1', '55432')}?port=5432`,
      });
      cases += 1;
      if (!viaQuery.includes(name))
        failures.push(`${name} ?port=5432 override not refused by name`);
    }
    expect(cases).toBe(5 * 7);
    expect(failures, failures.join('; ')).toEqual([]);
  });

  it('[G0.4] the explicit port variables, the Redis URL spellings and the checkout URL are refused on 5432 / 6379 and name the variable', async () => {
    const cases: [string, Record<string, string>][] = [
      ['NEMODOTS_PG_PORT', { NEMODOTS_PG_PORT: '5432' }],
      ['NEMODOTS_PG_PORT', { NEMODOTS_PG_PORT: '6379' }],
      ['NEMODOTS_REDIS_PORT', { NEMODOTS_REDIS_PORT: '6379' }],
      ['NEMODOTS_REDIS_PORT', { NEMODOTS_REDIS_PORT: '5432' }],
      ['NEMODOTS_CHECKOUT_PORT', { NEMODOTS_CHECKOUT_PORT: '5432' }],
      ['NEMODOTS_CHECKOUT_PORT', { NEMODOTS_CHECKOUT_PORT: '6379' }],
      [
        'NEMODOTS_CHECKOUT_URL',
        { NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:5432' },
      ],
      [
        'NEMODOTS_CHECKOUT_URL',
        { NEMODOTS_CHECKOUT_URL: 'http://localhost:6379' },
      ],
    ];
    for (const host of ['127.0.0.1', 'localhost', '[::1]'])
      for (const url of [
        `redis://${host}:6379/0`,
        `redis://${host}/0`,
        `redis://:${marker}@${host}:6379/0`,
      ])
        cases.push(['NEMODOTS_REDIS_URL', { NEMODOTS_REDIS_URL: url }]);
    const failures: string[] = [];
    for (const [name, overrides] of cases) {
      const message = await refusal(overrides);
      if (!message)
        failures.push(`${JSON.stringify(Object.keys(overrides))} accepted`);
      else if (!message.includes(name))
        failures.push(`${name}: message omits the variable`);
      if (message.includes(marker))
        failures.push(`${name}: message echoes a secret`);
    }
    expect(failures, failures.join('; ')).toEqual([]);
  });

  /** Runs a real entry point with a refused URL on 127.0.0.2 (no listener there). */
  async function entryRefuses(
    label: string,
    args: string[],
    env: Record<string, string>,
  ) {
    const r = await run('node', ['--import', 'tsx', ...args], {
      cwd: APP_ROOT,
      env,
      logName: `g0-refuse-${label}.log`,
      timeoutMs: 60_000,
      redact: makeRedactor([marker]),
    });
    return r;
  }

  it('[G0.4] the migrate CLI refuses an ADMIN URL on 127.0.0.2:5432 (and with the port omitted) before connecting: non-zero exit with the refusal text, never a connection error', async () => {
    for (const port of ['5432', '']) {
      const url = pgUrlFor('admin', '127.0.0.2', port);
      const r = await entryRefuses(
        `migrate-${port || 'omitted'}`,
        [MIGRATE],
        cleanEnv({
          NEMODOTS_PG_URL_ADMIN: url,
        }),
      );
      expect(r.timedOut).toBe(false);
      expect(r.code, r.tail).not.toBe(0);
      expect(r.code, r.tail).not.toBeNull();
      expect(r.tail).toContain('NEMODOTS_PG_URL_ADMIN');
      expect(r.tail).toMatch(/5432|refuse/i);
      expect(r.tail).not.toMatch(
        /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i,
      );
      expect(r.tail).not.toContain(marker);
    }
  }, 180_000);

  it('[G0.4] the seed CLI refuses the same URL before connecting', async () => {
    requireEntry(SEED, 'seed script');
    const r = await entryRefuses(
      'seed',
      [SEED],
      stackEnv({
        NEMODOTS_PG_URL_ADMIN: pgUrlFor('admin', '127.0.0.2', '5432'),
      }),
    );
    expect(r.timedOut).toBe(false);
    expect(r.code, r.tail).not.toBe(0);
    expect(r.tail).toContain('NEMODOTS_PG_URL_ADMIN');
    expect(r.tail).not.toMatch(
      /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i,
    );
    expect(r.tail).not.toContain(marker);
  }, 180_000);

  it('[G0.4] checkout-main refuses a CHECKOUT URL on 127.0.0.2:5432 before listening or connecting', async () => {
    requireEntry(CHECKOUT, 'checkout API entry');
    const r = await entryRefuses(
      'checkout-main',
      [CHECKOUT],
      cleanEnv({
        NEMODOTS_PG_URL_CHECKOUT: pgUrlFor('checkout', '127.0.0.2', '5432'),
        NEMODOTS_REDIS_URL: redisUrl(),
        NEMODOTS_REDIS_PREFIX: REDIS_PREFIX,
        NEMODOTS_CHECKOUT_PORT: String(CHECKOUT_PORT),
        NEMODOTS_PROBE_SECRET: db.stack.probeSecret,
      }),
    );
    expect(r.timedOut, 'checkout-main must exit, not keep running').toBe(false);
    expect(r.code, r.tail).not.toBe(0);
    expect(r.tail).toContain('NEMODOTS_PG_URL_CHECKOUT');
    expect(r.tail).not.toMatch(
      /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i,
    );
    expect(r.tail).not.toContain(marker);
    expect(await portIsFree(CHECKOUT_PORT), 'port 4600 must not be bound').toBe(
      true,
    );
  }, 180_000);
});

// ------------------------------------------------------------------ G0.4e

interface TableDigest {
  rows: number;
  md5: string;
}

/**
 * Digest of every table in the four schemas of `database`, read as the
 * verifier role. Any query error THROWS: an unreadable table never counts as
 * "unchanged".
 */
async function digestDatabase(database: string, only?: string[]) {
  const url = withDb(db.stack.roleUrls.verifier, database);
  const tables = await query<{ s: string; t: string }>(
    url,
    `SELECT schemaname AS s, tablename AS t FROM pg_tables
      WHERE schemaname IN ('ledger','coordinator','checkout','control') ORDER BY 1, 2`,
  );
  const out: Record<string, TableDigest> = {};
  for (const { s, t } of tables) {
    if (only && !only.includes(s)) continue;
    const r = await query<{ n: string; d: string }>(
      url,
      `SELECT count(*)::text AS n,
              md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS d
         FROM ${s}.${t} x`,
    );
    out[`${s}.${t}`] = { rows: Number(r[0].n), md5: r[0].d };
  }
  return out;
}

const nonEmptyTables = (d: Record<string, TableDigest>) =>
  Object.values(d).filter((t) => t.rows > 0).length;

/** Key names of every Redis database on 56379 (db N -> keys). */
async function redisKeyNames(port: number) {
  const out = new Set<string>();
  for (let n = 0; n < 16; n += 1) {
    const client = createClient({ url: `redis://127.0.0.1:${port}/${n}` });
    await client.connect();
    try {
      for await (const key of client.scanIterator({ COUNT: 500 })) {
        const list = Array.isArray(key) ? key : [key];
        for (const k of list) out.add(`${n}:${k}`);
      }
    } finally {
      await client.quit();
    }
  }
  return out;
}

/** Keys added or removed outside the suite's own prefix and the shared test prefix. */
function redisOutsideDiff(before: Set<string>, after: Set<string>) {
  const mine = (k: string) =>
    /^\d+:acc0:/.test(k) || /^\d+:nemodots:test:/.test(k);
  return {
    added: [...after].filter((k) => !before.has(k) && !mine(k)),
    removed: [...before].filter((k) => !after.has(k) && !mine(k)),
  };
}

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

  const runSeed = (target: AccDb, logName: string) =>
    run('node', ['--import', 'tsx', SEED], {
      cwd: APP_ROOT,
      env: stackEnv({}, target),
      logName,
      timeoutMs: 180_000,
      redact,
    });

  /** Business hash: every checkout table (products, inventory, replica, orders, items, config) and every control table. */
  const businessHash = async () => {
    const d = await digestDatabase(db.name, ['checkout', 'control']);
    return d;
  };

  it('[G0.4] a neighbouring acc0 database (migrated and seeded) is readable and non-empty before the target is seeded', async () => {
    requireEntry(SEED, 'seed script');
    neighbour = await createAccDb();
    const m = await run('node', ['--import', 'tsx', MIGRATE], {
      cwd: APP_ROOT,
      env: cleanEnv({ NEMODOTS_PG_URL_ADMIN: neighbour.urls.admin }),
      logName: 'g0-neighbour-migrate.log',
      timeoutMs: 120_000,
      redact,
    });
    expect(m.code, m.tail).toBe(0);
    const seed = await runSeed(neighbour, 'g0-neighbour-seed.log');
    expect(seed.code, `neighbour seed exit ${seed.code}: ${seed.tail}`).toBe(0);
    const digest = await (async () => {
      const url = withDb(db.stack.roleUrls.verifier, neighbour.name);
      const tables = await query<{ n: string }>(
        url,
        "SELECT count(*)::text AS n FROM pg_tables WHERE schemaname IN ('ledger','coordinator','checkout','control')",
      );
      const d = await digestDatabase(neighbour.name);
      expect(Object.keys(d).length, 'every table readable').toBe(
        Number(tables[0].n),
      );
      return d;
    })();
    expect(nonEmptyTables(digest)).toBeGreaterThanOrEqual(5);
    expect(digest['checkout.orders'].rows).toBeGreaterThan(0);
    expect(digest['checkout.inventory'].rows).toBeGreaterThan(0);
    appendManifest({
      gate: 0,
      step: 'seed-neighbour',
      neighbour: neighbour.name,
      tables: Object.keys(digest).length,
      nonEmptyTables: nonEmptyTables(digest),
    });
  }, 400_000);

  it('[G0.4] seed populates the target with the documented data shape; the neighbour database, the main database and every Redis key outside the acc0 prefix are untouched', async () => {
    if (!neighbour) throw new Error('neighbour database was not created');
    const neighbourBefore = await digestDatabase(neighbour.name);
    expect(nonEmptyTables(neighbourBefore)).toBeGreaterThanOrEqual(5);
    let mainBefore: Record<string, TableDigest> | string;
    try {
      mainBefore = await digestDatabase('nemodots');
    } catch (error) {
      mainBefore = `unreadable: ${(error as Error).message.slice(0, 80)}`;
    }
    const redisBefore = await redisKeyNames(db.stack.redisPort);

    const seed = await runSeed(db, 'g0-seed-1.log');
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
    const target = await digestDatabase(db.name, ['checkout']);
    expect(target['checkout.inventory'].rows).toBeGreaterThan(0);
    expect(target['checkout.orders'].rows).toBeGreaterThan(0);

    // Scoping: the neighbour is byte-for-byte unchanged and the digests were non-empty.
    const neighbourAfter = await digestDatabase(neighbour.name);
    expect(neighbourAfter).toEqual(neighbourBefore);
    let mainAfter: Record<string, TableDigest> | string;
    try {
      mainAfter = await digestDatabase('nemodots');
    } catch (error) {
      mainAfter = `unreadable: ${(error as Error).message.slice(0, 80)}`;
    }
    expect(mainAfter).toEqual(mainBefore);
    const redisAfter = await redisKeyNames(db.stack.redisPort);
    const diff = redisOutsideDiff(redisBefore, redisAfter);
    appendManifest({
      gate: 0,
      step: 'seed-scoping',
      neighbourTablesNonEmpty: nonEmptyTables(neighbourBefore),
      mainDatabase:
        typeof mainBefore === 'string'
          ? mainBefore
          : `${Object.keys(mainBefore).length} tables, ${nonEmptyTables(mainBefore)} non-empty`,
      redisKeysBefore: redisBefore.size,
      redisKeysAfter: redisAfter.size,
      redisOutsideAdded: diff.added.length,
      redisOutsideRemoved: diff.removed.length,
    });
    expect(
      diff,
      'seed changed Redis keys outside the acc0:g0 prefix (key names withheld)',
    ).toEqual({ added: [], removed: [] });
  }, 400_000);

  it('[G0.4] positive control for the Redis scoping check: a key written outside the prefix is reported', async () => {
    const before = await redisKeyNames(db.stack.redisPort);
    const stray = `leakcontrol:${Date.now()}`;
    const client = createClient({
      url: `redis://127.0.0.1:${db.stack.redisPort}/3`,
    });
    await client.connect();
    try {
      await client.set(stray, '1', { EX: 60 });
      const after = await redisKeyNames(db.stack.redisPort);
      const diff = redisOutsideDiff(before, after);
      expect(diff.added).toContain(`3:${stray}`);
    } finally {
      await client.unlink(stray);
      await client.quit();
    }
  });

  it('[G0.4] a second seed run leaves a business hash over EVERY checkout and control table unchanged (no duplicated orders, no changed config or fault state)', async () => {
    const before = await businessHash();
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        'checkout.orders',
        'checkout.order_items',
        'checkout.inventory',
        'checkout.inventory_replica',
        'checkout.products',
        'checkout.config_entries',
        'checkout.config_versions',
        'checkout.config_collection',
        'control.scenario_runs',
        'control.fault_schedules',
      ]),
    );
    expect(before['checkout.orders'].rows).toBeGreaterThan(0);
    const seed = await runSeed(db, 'g0-seed-2.log');
    expect(seed.code, `second seed exit ${seed.code}: ${seed.tail}`).toBe(0);
    const after = await businessHash();
    expect(after).toEqual(before);
  }, 300_000);

  it('[G0.4] the checkout API starts, reports ok on 4600, serves cached catalog reads under the acc0 prefix only, and its health is visible to an independent probe', async () => {
    const redisBefore = await redisKeyNames(db.stack.redisPort);
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
    // A real Redis effect: the catalog is cache-aside, so reads leave keys under the prefix.
    for (let i = 0; i < 2; i += 1) {
      const products = await fetch(`${checkoutUrl}/products`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(products.status).toBe(200);
    }
    const client = createClient({ url: redisUrl() });
    await client.connect();
    const mine: string[] = [];
    try {
      for await (const key of client.scanIterator({
        MATCH: `${REDIS_PREFIX}*`,
        COUNT: 200,
      })) {
        const list = Array.isArray(key) ? key : [key];
        mine.push(...list);
      }
    } finally {
      await client.quit();
    }
    expect(
      mine.length,
      'checkout wrote no cache key under acc0:g0',
    ).toBeGreaterThan(0);
    const diff = redisOutsideDiff(
      redisBefore,
      await redisKeyNames(db.stack.redisPort),
    );
    expect(diff, 'checkout wrote Redis keys outside its prefix').toEqual({
      added: [],
      removed: [],
    });
  }, 180_000);

  it('[G0.4] stop makes health unreachable (not stale ok); restart recovers with data intact', async () => {
    const proc = owned[owned.length - 1];
    expect(proc, 'checkout was not started by the previous case').toBeDefined();
    const before = await businessHash();
    await proc.stop();
    await expect(
      fetch(`${checkoutUrl}/health`, { signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow();
    const again = await startCheckout('g0-checkout-2.log');
    const res = await waitForHttp(`${checkoutUrl}/health`, again, 60_000);
    expect(((await res.json()) as { status?: string }).status).toBe('ok');
    expect(await businessHash()).toEqual(before);
  }, 180_000);
});

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
    model: string | null;
  };
  checkout: { reachable: boolean; status: string | null };
}

describe('G0.5 clean start and setup state without Crusoe or Intelligence configuration', () => {
  const base = `http://127.0.0.1:${APP_PORT}`;
  const ALL_THREE = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
  const FAKE_KEY = 'acc0-not-a-real-key-0000000000';

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

  const liveEnv = (stub: StubProvider, model: string) => ({
    NEMODOTS_INFERENCE_MODE: 'live',
    OPENAI_API_KEY: FAKE_KEY,
    OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
    OPENAI_MODEL: model,
  });

  const counts = async () => {
    const out: Record<string, number> = {};
    for (const table of ['missions', 'tasks', 'events'])
      out[table] = Number(
        (
          await query<{ n: string }>(
            db.urls.verifier,
            `SELECT count(*)::text AS n FROM coordinator.${table}`,
          )
        )[0].n,
      );
    return out;
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
    '[G0.5] starting a mission while blocked answers 503 with missingEnv names and creates nothing (route list AND coordinator tables)',
    () =>
      withApp('blocked', {}, async () => {
        const before = await counts();
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
        // Independent of the production route: the verifier role reads the tables.
        expect(await counts()).toEqual(before);
        expect(before).toEqual({ missions: 0, tasks: 0, events: 0 });
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
        { OPENAI_API_KEY: FAKE_KEY, OPENAI_MODEL: 'acc0-model' },
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

  it('[G0.5] fixture mode is labelled fixture even when all three OPENAI_* variables point at a live-looking stub, and nothing is sent to that stub', async () => {
    const stub = await startStubProvider(['acc0/model-x']);
    stubs.push(stub);
    await withApp(
      'fixture',
      {
        ...liveEnv(stub, 'acc0/model-x'),
        NEMODOTS_INFERENCE_MODE: 'fixture',
        NEMODOTS_FIXTURE_PATH: FIXTURE,
      },
      async () => {
        const first = await health();
        expect(first.status, first.text.slice(0, 200)).toBe(200);
        expect(first.json.mode).toBe('fixture');
        expect(first.json.missingEnv).toEqual([]);
        expect(first.json.provider.reachable).toBe(false);
        expect(first.json.provider.modelListed).toBe(false);
        expect(first.text).not.toContain(FAKE_KEY);
        await sleep(1500);
        const second = await health();
        expect(second.json.mode).toBe('fixture');
        expect(
          stub.requests,
          `fixture mode contacted the provider: ${stub.requests.join(', ')}`,
        ).toEqual([]);
      },
    );
  }, 120_000);

  it('[G0.5] fixture mode with a nonexistent fixture file is refused or blocked, never labelled fixture or live', async () => {
    const missingFixture = path.join(SCRATCH, 'no-such-fixture.json');
    expect(existsSync(missingFixture)).toBe(false);
    const proc = startManaged('node', ['--import', 'tsx', APP_ENTRY], {
      cwd: APP_ROOT,
      env: stackEnv({
        HOST: '127.0.0.1',
        PORT: String(APP_PORT),
        DATABASE_PATH: path.join(ensureScratch(), 'app-nofixture.sqlite'),
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        OPENAI_MODEL: '',
        INTELLIGENCE_API_KEY: '',
        CPK_INTELLIGENCE_API_KEY: '',
        NEMODOTS_INFERENCE_MODE: 'fixture',
        NEMODOTS_FIXTURE_PATH: missingFixture,
      }),
      logName: 'g0-app-nofixture.log',
      redact,
    });
    owned.push(proc);
    try {
      let outcome: 'refused' | 'blocked' | 'unexpected';
      let detail = '';
      try {
        await waitForHttp(`${base}/api/state`, proc, 60_000);
        const h = await health();
        detail = `status=${h.status} mode=${h.json?.mode} body=${h.text.slice(0, 120)}`;
        // Only an explicit blocked label counts: a 404 from a route that does
        // not exist yet is not a refusal.
        outcome =
          h.status === 200 && h.json?.mode === 'blocked'
            ? 'blocked'
            : 'unexpected';
      } catch {
        outcome = proc.exited() ? 'refused' : 'unexpected';
        detail = proc.output().slice(-300);
      }
      if (outcome === 'refused')
        expect(
          proc.output(),
          'a refusal must say why (the fixture path)',
        ).toMatch(/fixture/i);
      expect(
        ['refused', 'blocked'],
        `a missing fixture file must be refused or labelled blocked (${detail})`,
      ).toContain(outcome);
    } finally {
      await proc.stop();
      owned.splice(owned.indexOf(proc), 1);
      await sleep(200);
    }
  }, 120_000);

  it('[G0.5] live mode with a provider that lists the configured model is labelled live, reachable and modelListed (positive control)', async () => {
    const stub = await startStubProvider(['acc0/model-x', 'acc0/other']);
    stubs.push(stub);
    await withApp('live-ok', liveEnv(stub, 'acc0/model-x'), async () => {
      const h = await health();
      expect(h.status, h.text.slice(0, 200)).toBe(200);
      expect(h.json.mode).toBe('live');
      expect(h.json.missingEnv).toEqual([]);
      expect(h.json.provider.host).toBe(`127.0.0.1:${stub.port}`);
      expect(h.json.provider.reachable).toBe(true);
      expect(h.json.provider.modelListed).toBe(true);
      expect(h.text).not.toContain(FAKE_KEY);
      expect(stub.requests.length, 'provider was never asked').toBeGreaterThan(
        0,
      );
    });
  }, 120_000);

  it('[G0.5] live mode with a provider that lists a DIFFERENT model is reachable but modelListed false', async () => {
    const stub = await startStubProvider(['acc0/some-other-model']);
    stubs.push(stub);
    await withApp('live-other', liveEnv(stub, 'acc0/model-x'), async () => {
      const h = await health();
      expect(h.status, h.text.slice(0, 200)).toBe(200);
      expect(h.json.mode).toBe('live');
      expect(h.json.provider.reachable).toBe(true);
      expect(h.json.provider.modelListed).toBe(false);
    });
  }, 120_000);

  it('[G0.5] fully configured live mode with an unreachable provider is labelled live-but-unreachable, not healthy', async () => {
    // A stub that fails every request stands in for a dead provider endpoint
    // (valid for this labelling check; it proves nothing about inference).
    const stub = await startStubProvider('down');
    stubs.push(stub);
    await withApp('live', liveEnv(stub, 'acc0-model'), async () => {
      const h = await health();
      expect(h.status, h.text.slice(0, 200)).toBe(200);
      expect(h.json.mode).toBe('live');
      expect(h.json.missingEnv).toEqual([]);
      expect(h.json.provider.host).toBe(`127.0.0.1:${stub.port}`);
      expect(h.json.provider.reachable).toBe(false);
      expect(h.json.provider.modelListed).toBe(false);
      expect(h.text).not.toContain(FAKE_KEY);
      expect(
        stub.requests.length,
        'the unreachable case never asked the provider',
      ).toBeGreaterThan(0);
    });
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
