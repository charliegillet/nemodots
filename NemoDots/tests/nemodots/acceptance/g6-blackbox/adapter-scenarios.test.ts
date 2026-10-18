// G6.10 Deterministic adapter scenarios. No live inference is used (the app runs
// in blocked mode), so these results are reported SEPARATELY from the autonomous
// trials and never count toward live resolution rates. They prove the sandbox,
// the version authority and the honest-mode behaviour the trials rely on:
// documented fault symptoms through HTTP only, bounded repair through the owner
// route, version CAS, and blocked/fixture labelling.
//
// Expected values come from ARCHITECTURE 9.1/9.2 and the oracle invariants. The
// healthy baseline is read from the seeded database at run time (never
// hard-coded here) because the baseline lives only in sandbox/seed.ts.
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CheckoutHealthResponseSchema } from '../../../../src/server/nemodots/contracts/index.js';
import { PROBE } from '../oracle/checkout-invariants.js';
import { newOwnerToken } from './helpers/config.js';
import { NemoApi, checkoutRequest, loadSample, sleep } from './helpers/http.js';
import { createClient } from 'redis';
import { redisTrialUrl, trialRedisPrefix } from './helpers/config.js';
import { Sut } from './helpers/sut.js';
import { StepApplier, probeHeader, verifierProbe } from './helpers/trial.js';
import { RedisEffectWatcher, VerifierDb } from './helpers/verifier-db.js';
import { auditTaggedOrders, scoreProbe } from './helpers/scoring.js';

let sut: Sut | undefined;
let api: NemoApi;
let db: VerifierDb;
let applier: StepApplier;
let baseline: Record<string, unknown> = {};
let current: 'sandbox' | 'app' | null = null;
let starting: Promise<void> | null = null;
const banner = (n: number) => `adapter banner ${n}`;

async function teardown() {
  await applier?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await sut?.stop();
  sut = undefined;
  current = null;
}

/**
 * Starts (or switches to) the requested environment; every test awaits it so a
 * failure is reported on each test rather than as a skip. "sandbox" is the
 * checkout API plus PostgreSQL/Redis without the app; "app" adds the OpenDots
 * server with NemoDots in blocked mode (no inference is ever spent).
 */
async function use(kind: 'sandbox' | 'app'): Promise<void> {
  await starting;
  if (current === kind) return;
  starting = (async () => {
    await teardown();
    const token = newOwnerToken();
    sut = await Sut.start({
      trialId: `adapter-${kind}`,
      ownerToken: token,
      separateWorker: false,
      inferenceMode: 'blocked',
      withApp: kind === 'app',
    });
    api = new NemoApi(token);
    db = await VerifierDb.connect(sut);
    applier = new StepApplier(sut, api, db);
    await applier.open();
    baseline = Object.fromEntries(
      Object.entries(await db.configEntries()).map(([k, v]) => [k, v.value]),
    );
    current = kind;
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

afterAll(async () => {
  await starting?.catch(() => undefined);
  await teardown();
}, 120_000);

/** owner repair through the public route, with the current version read by the verifier */
async function ownerSet(key: string, value: unknown) {
  const entry = (await db.configEntries())[key];
  const response = await api.post(
    `/sandbox/sources/${encodeURIComponent(key)}`,
    {
      value,
      expectedVersion: entry.version,
    },
  );
  return { response, entry };
}

/** Polls /health until it reports `want` (health reflects recent errors, so recovery may lag a few seconds). */
async function waitForHealth(
  want: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await checkoutRequest('GET', '/health')).body as {
      status?: string;
    };
    const last = body?.status ?? 'unreadable';
    if (last === want || Date.now() > deadline) return last;
    await sleep(500);
  }
}

async function restoreBaseline(keys: string[]) {
  for (const key of keys) {
    const live = (await db.configEntries())[key];
    if (JSON.stringify(live.value) !== JSON.stringify(baseline[key])) {
      const step = await inject(
        key,
        baseline[key] as string | number | boolean,
      );
      expect(step.ok, `restoring ${key}: ${step.error}`).toBe(true);
    }
  }
  await sleep(600); // checkout config cache is 250 ms
}

const inject = (key: string, value: string | number | boolean) =>
  applier.apply(0, {
    trigger: { kind: 'pre_start' },
    key,
    value,
    actor: 'injector',
  });

describe('G6.10 deterministic adapter: healthy checkout baseline', () => {
  it('G6.3 healthy checkout answers health, ready, products and inventory', async () => {
    await use('sandbox');
    const health = await checkoutRequest('GET', '/health');
    expect(health.status).toBe(200);
    expect((health.body as { status: string }).status).toBe('ok');
    expect((await checkoutRequest('GET', '/ready')).status).toBe(200);
    expect((await checkoutRequest('GET', '/products')).status).toBe(200);
    expect(
      (await checkoutRequest('GET', `/inventory/${PROBE.sku}`)).status,
    ).toBe(200);
  });

  it('G6.4 INV-1 read-only requests leave the business hash unchanged', async () => {
    await use('sandbox');
    const before = await db.snapshot();
    for (const path of [
      '/health',
      '/ready',
      '/products',
      `/inventory/${PROBE.sku}`,
      '/metrics',
    ])
      for (let n = 0; n < 3; n += 1)
        await (await fetch(`http://127.0.0.1:4720${path}`)).arrayBuffer();
    expect((await db.snapshot()).hash).toBe(before.hash);
  });

  it('G6.3/G6.4 one fresh probe order creates exactly one order, decrements inventory, reads back', async () => {
    await use('sandbox');
    const before = await db.snapshot();
    const probe = await verifierProbe(db, 2);
    const checks = scoreProbe(probe, before);
    expect(checks['INV-2'], checks['INV-2'].detail).toMatchObject({ ok: true });
    expect(checks['INV-3'], checks['INV-3'].detail).toMatchObject({ ok: true });
    expect(checks['INV-4'], checks['INV-4'].detail).toMatchObject({ ok: true });
    // probe rows are excluded from H, inventory add-back keeps H identical
    expect((await db.snapshot()).hash).toBe(before.hash);
  });
});

describe('G6.10 deterministic adapter: documented fault symptoms and bounded repair', () => {
  afterEach(async () => {
    if (current !== 'sandbox') return;
    // a failed assertion must not leak a fault into the next scenario
    await restoreBaseline(Object.keys(baseline));
  });

  it('F5 maintenance flag: 503 writes_disabled, health degraded, a bounded repair restores ok', async () => {
    await use('sandbox');
    const step = await inject('orders.write_enabled', false);
    expect(step.ok, step.error).toBe(true);
    await sleep(600);
    const order = await checkoutRequest('POST', '/orders', {
      body: { items: [{ sku: PROBE.sku, quantity: 1 }] },
      headers: { [PROBE.header]: probeHeader('acc6-adapter-f5') },
    });
    expect(order.status).toBe(503);
    expect(order.text).toContain('writes_disabled');
    const health = (await checkoutRequest('GET', '/health')).body as {
      status: string;
      errors: string[];
    };
    expect(health.status).toBe('degraded');
    expect(health.errors).toContain('writes_disabled');
    const business = await db.snapshot();
    await restoreBaseline(['orders.write_enabled']);
    await sleep(600);
    expect(await waitForHealth('ok')).toBe('ok');
    expect((await db.snapshot()).hash).toBe(business.hash); // the failed order wrote nothing
  });

  it('F3 pool starvation: 503 pool_timeout under concurrency, health degraded, raising db.pool_max repairs', async () => {
    await use('sandbox');
    expect((await inject('db.pool_max', 1)).ok).toBe(true);
    expect((await inject('db.statement_timeout_ms', 50)).ok).toBe(true);
    await sleep(600);
    let timeouts = 0;
    for (let round = 0; round < 3 && timeouts === 0; round += 1)
      timeouts = (await loadSample(200, 12, PROBE.sku)).poolTimeout503;
    expect(timeouts).toBeGreaterThan(0);
    const degraded = (await checkoutRequest('GET', '/health')).body as {
      status: string;
      errors: string[];
    };
    expect(['degraded', 'down']).toContain(degraded.status);
    await restoreBaseline(['db.pool_max', 'db.statement_timeout_ms']);
    expect((await loadSample(200, 12, PROBE.sku)).poolTimeout503).toBe(0);
    expect(await waitForHealth('ok')).toBe('ok');
  });

  it('F2 schema mismatch: 500 cache_decode_error with expected and found schema in /metrics', async () => {
    await use('sandbox');
    await checkoutRequest('GET', '/products'); // warm the cache under the baseline schema
    const schema = Number(baseline['cache.schema_version']);
    const injected = schema >= 9 ? schema - 1 : schema + 1;
    expect((await inject('cache.schema_version', injected)).ok).toBe(true);
    await sleep(600);
    const read = await checkoutRequest('GET', '/products');
    expect(read.status).toBe(500);
    expect(read.text).toContain('cache_decode_error');
    const metrics = await checkoutRequest('GET', '/metrics');
    expect(metrics.text).toContain('cache_decode_error');
    expect(metrics.text).toContain(String(injected));
    expect(metrics.text).toContain(String(schema));
    await restoreBaseline(['cache.schema_version']);
    expect((await checkoutRequest('GET', '/products')).status).toBe(200);
  });

  it('F4 stale replica routing: an order succeeds while the API inventory view disagrees with the authority', async () => {
    await use('sandbox');
    expect((await inject('routing.inventory_source', 'replica_stale')).ok).toBe(
      true,
    );
    await sleep(600);
    const probe = await verifierProbe(db, 1);
    expect(probe.create.status).toBeGreaterThanOrEqual(200);
    expect(probe.create.status).toBeLessThan(300);
    const authority = await db.inventoryQuantity(PROBE.sku);
    const view = (await checkoutRequest('GET', `/inventory/${PROBE.sku}`))
      .body as { quantity?: number };
    expect(view.quantity).not.toBe(authority);
    await restoreBaseline(['routing.inventory_source']);
    const fixed = (await checkoutRequest('GET', `/inventory/${PROBE.sku}`))
      .body as { quantity?: number };
    expect(fixed.quantity).toBe(await db.inventoryQuantity(PROBE.sku));
  });

  it('F1 stale namespace: blobs of another schema make reads fail with cache_decode_error; restoring the namespace repairs', async () => {
    await use('sandbox');
    const step = await applier.apply(0, {
      trigger: { kind: 'pre_start' },
      key: 'cache.namespace',
      value: 'acc6-stale-ns',
      actor: 'injector',
      requiresStaleBlobs: true,
    });
    expect(step.ok, step.error).toBe(true);
    await sleep(600);
    const read = await checkoutRequest('GET', '/products');
    expect(read.status).toBe(500);
    expect(read.text).toContain('cache_decode_error');
    await restoreBaseline(['cache.namespace']);
    expect((await checkoutRequest('GET', '/products')).status).toBe(200);
  });

  it('G6.2 a benign banner change moves no checkout health or business data', async () => {
    await use('sandbox');
    const before = await db.snapshot();
    const step = await inject('ui.banner_text', banner(1));
    expect(step.ok, step.error).toBe(true);
    await sleep(600);
    expect(await waitForHealth('ok')).toBe('ok');
    expect((await db.snapshot()).hash).toBe(before.hash);
    await restoreBaseline(['ui.banner_text']);
  });
});

describe('G6.6 deterministic adapter: version authority compare-and-set', () => {
  it('G6.6 a stale expectedVersion is rejected with 409 and leaves version and history unchanged', async () => {
    await use('app');
    const before = (await db.configEntries())['ui.banner_text'];
    const historyBefore = (await db.configVersions()).length;
    const response = await api.post(
      `/sandbox/sources/${encodeURIComponent('ui.banner_text')}`,
      {
        value: banner(2),
        expectedVersion:
          before.version - 1 > 0 ? before.version - 1 : before.version + 5,
      },
    );
    expect(response.status).toBe(409);
    const after = (await db.configEntries())['ui.banner_text'];
    expect(after.version).toBe(before.version);
    expect(after.value).toEqual(before.value);
    expect((await db.configVersions()).length).toBe(historyBefore);
  });

  it('G6.6 a correct expectedVersion advances by exactly one and records an owner history row', async () => {
    await use('app');
    const before = (await db.configEntries())['ui.banner_text'];
    const { response } = await ownerSet('ui.banner_text', banner(3));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: before.version + 1 });
    const row = (await db.configVersions()).find(
      (r) => r.key === 'ui.banner_text' && r.version === before.version + 1,
    );
    expect(row).toBeDefined();
    expect(row!.causedByActor).toBe('owner');
    expect(row!.causedByActionId).toBeNull();
    expect(row!.value).toBe(banner(3));
  });

  it('G6.6 two simultaneous edits at the same version serialize: exactly one wins', async () => {
    await use('app');
    const before = (await db.configEntries())['ui.banner_text'];
    const attempt = (n: number) =>
      api.post(`/sandbox/sources/${encodeURIComponent('ui.banner_text')}`, {
        value: banner(10 + n),
        expectedVersion: before.version,
      });
    const results = await Promise.all([attempt(1), attempt(2)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = (await db.configEntries())['ui.banner_text'];
    expect(after.version).toBe(before.version + 1);
    const rows = (await db.configVersions()).filter(
      (r) => r.key === 'ui.banner_text' && r.version === before.version + 1,
    );
    expect(rows).toHaveLength(1);
  });

  it('G6.6 an injector write is attributed to the injector and never to an action', async () => {
    await use('sandbox');
    const step = await inject('ui.banner_text', banner(20));
    expect(step.ok, step.error).toBe(true);
    const row = (await db.configVersions()).find(
      (r) => r.key === 'ui.banner_text' && r.version === step.versionAfter,
    );
    expect(row?.causedByActor).toBe('injector');
    expect(row?.causedByActionId).toBeNull();
  });
});

describe('G6.10 deterministic adapter: proxied checkout health contract', () => {
  it('G6.10 GET /sandbox/checkout/health matches the public CheckoutHealthResponse contract', async () => {
    await use('app');
    const response = await api.get('/sandbox/checkout/health');
    expect(response.status).toBe(200);
    const parsed = CheckoutHealthResponseSchema.safeParse(response.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.status).toBe('ok');
  });
});

describe('G6.2/G6.10 deterministic adapter: honest modes', () => {
  it('G6.10 in blocked mode mission creation is refused with variable names only', async () => {
    await use('app');
    const health = await api.get<{ mode: string; missingEnv: string[] }>(
      '/health',
    );
    expect(health.status).toBe(200);
    expect(health.body.mode).toBe('blocked');
    for (const name of health.body.missingEnv)
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    const created = await api.post<{ error: string; missingEnv: string[] }>(
      '/missions',
      {
        goal: 'Investigate the checkout service.',
      },
    );
    expect(created.status).toBe(503);
    expect(Array.isArray(created.body.missingEnv)).toBe(true);
    for (const name of created.body.missingEnv)
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('G6.10 a body mode that disagrees with the server mode is refused, never silently relabelled', async () => {
    await use('app');
    const created = await api.post('/missions', {
      goal: 'Investigate the checkout service.',
      mode: 'live',
    });
    expect([400, 503]).toContain(created.status);
    expect(created.status).not.toBe(201);
    const missions = await api.get<unknown[]>('/missions');
    expect(missions.body).toEqual([]);
  });
});

describe('G6.4 deterministic adapter: the harness reads with its own read-only role', () => {
  it('G6.4 the reader is a separate harness-only role that cannot write or read control data', async () => {
    await use('sandbox');
    expect(await db.currentUser()).toMatch(/^acc6_ro_/);
    const reader = new pg.Client({ connectionString: sut!.readerUrl });
    await reader.connect();
    try {
      await expect(
        reader.query('UPDATE checkout.inventory SET quantity = quantity'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        reader.query("INSERT INTO checkout.config_versions (key) VALUES ('x')"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        reader.query('SELECT * FROM control.scenario_runs'),
      ).rejects.toThrow(/permission denied/);
      // the three schemas the invariants need are readable
      for (const table of [
        'checkout.orders',
        'ledger.model_call_records',
        'coordinator.task_attempts',
      ])
        await reader.query(`SELECT 1 FROM ${table} LIMIT 1`);
    } finally {
      await reader.end();
    }
  });

  it('G6.4 the app and worker environment holds the architecture roles only: no admin, no checkout, no reader', async () => {
    await use('sandbox');
    const names = sut!.appEnvNames();
    expect(names).toEqual(
      expect.arrayContaining([
        'NEMODOTS_PG_URL_APP',
        'NEMODOTS_PG_URL_INJECTOR',
        'NEMODOTS_PG_URL_VERIFIER',
      ]),
    );
    for (const forbidden of [
      'NEMODOTS_PG_URL_ADMIN',
      'NEMODOTS_PG_URL_CHECKOUT',
    ])
      expect(names).not.toContain(forbidden);
    expect(names.filter((n) => /READER|ACC6/i.test(n))).toEqual([]);
  });

  it('G6.4 config history carries parseable start times; commit timestamps are used exactly when the server tracks them', async () => {
    await use('sandbox');
    const rows = await db.configVersions();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number.isNaN(Date.parse(row.at))).toBe(false);
      if (db.commitTimestamps)
        expect(Number.isNaN(Date.parse(row.commitAt ?? ''))).toBe(false);
      else expect(row.commitAt ?? null).toBeNull();
    }
  });

  it('G6.4 the verifier probe leaves the audit clean and the normalized evidence values unchanged', async () => {
    await use('sandbox');
    const probe = await verifierProbe(db, 1);
    expect(probe.normalized!.after).toEqual(probe.normalized!.before);
    const tagged = await db.taggedOrders();
    expect(tagged.filter((o) => o.probeRunId === probe.runId)).toHaveLength(1);
    // the stray runtime-tagged rows of other probes in this database would be reported
    const audit = auditTaggedOrders({
      probe,
      taggedOrders: tagged,
      snapshot: null,
      snapshotAfterProbe: null,
      events: [],
    } as never);
    const foreign = tagged.filter((o) => o.probeRunId !== probe.runId);
    expect(audit.length > 0).toBe(foreign.length > 0);
  });
});

describe('G6.6 deterministic adapter: independent Redis effect counting', () => {
  it('G6.6 the keyspace watcher counts effect markers per action, ignores NX no-ops, and restores the server setting', async () => {
    await use('sandbox');
    const prefix = `${trialRedisPrefix('adapter-watch')}`;
    const admin = createClient({ url: redisTrialUrl() });
    await admin.connect();
    const before = (await admin.configGet('notify-keyspace-events')) as Record<
      string,
      string
    >;
    const watcher = await RedisEffectWatcher.start(prefix);
    try {
      const marker = `${prefix}:effect:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      await admin.set(marker, '1', { NX: true }); // first effect
      await admin.set(marker, '1', { NX: true }); // duplicate attempt: a no-op, no event
      await admin.set(
        `${prefix}:effect:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        '1',
      );
      await admin.set(
        `${prefix}:effect:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        '2',
      ); // forced second write
      await admin.set(`${prefix}:fence:checkout`, '3');
      await admin.set(`${prefix}:cache:ns:v1:products`, '[]');
      await admin.unlink(`${prefix}:cache:ns:v1:products`);
      await sleep(400);
      const seen = watcher.peek();
      expect(seen.available, seen.reason ?? '').toBe(true);
      expect(seen.markerSets).toEqual({
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 1,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': 2,
      });
      expect(seen.fenceSets).toBe(1);
      expect(seen.cacheDeletes).toBe(1);
    } finally {
      await watcher.stop();
      const after = (await admin.configGet('notify-keyspace-events')) as Record<
        string,
        string
      >;
      expect(after['notify-keyspace-events']).toBe(
        before['notify-keyspace-events'],
      );
      for await (const keys of admin.scanIterator({ MATCH: `${prefix}:*` }))
        if (keys.length) await admin.unlink(keys);
      await admin.quit();
    }
  });
});
