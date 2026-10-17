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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBE } from '../oracle/checkout-invariants.js';
import { newOwnerToken } from './helpers/config.js';
import { NemoApi, checkoutRequest, loadSample, sleep } from './helpers/http.js';
import { Sut } from './helpers/sut.js';
import { StepApplier, verifierProbe } from './helpers/trial.js';
import { VerifierDb } from './helpers/verifier-db.js';
import { scoreInvariants } from './helpers/scoring.js';
import type { TrialRecord } from './helpers/record.js';

let sut: Sut;
let api: NemoApi;
let db: VerifierDb;
let applier: StepApplier;
let baseline: Record<string, unknown> = {};
const banner = (n: number) => `adapter banner ${n}`;

beforeAll(async () => {
  const token = newOwnerToken();
  sut = await Sut.start({
    trialId: 'adapter-scenarios',
    ownerToken: token,
    separateWorker: false,
    inferenceMode: 'blocked',
  });
  api = new NemoApi(token);
  db = await VerifierDb.connect(sut.database);
  applier = new StepApplier(sut, api, db);
  await applier.open();
  baseline = Object.fromEntries(
    Object.entries(await db.configEntries()).map(([k, v]) => [k, v.value]),
  );
}, 300_000);

afterAll(async () => {
  await applier?.close();
  await db?.close();
  await sut?.stop();
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

async function restoreBaseline(keys: string[]) {
  for (const key of keys) {
    const current = (await db.configEntries())[key];
    if (JSON.stringify(current.value) !== JSON.stringify(baseline[key])) {
      const { response } = await ownerSet(key, baseline[key]);
      expect(response.status, `restoring ${key}`).toBe(200);
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
    const before = await db.snapshot();
    const probe = await verifierProbe(db, 2);
    const record = {
      probe,
      snapshot: null,
      snapshotAfterProbe: null,
      businessBefore: before,
    } as unknown as TrialRecord;
    const checks = scoreInvariants(record);
    expect(checks['INV-2'], checks['INV-2'].detail).toMatchObject({ ok: true });
    expect(checks['INV-3'], checks['INV-3'].detail).toMatchObject({ ok: true });
    expect(checks['INV-4'], checks['INV-4'].detail).toMatchObject({ ok: true });
    // probe rows are excluded from H, inventory add-back keeps H identical
    expect((await db.snapshot()).hash).toBe(before.hash);
  });
});

describe('G6.10 deterministic adapter: documented fault symptoms and bounded repair', () => {
  it('F5 maintenance flag: 503 writes_disabled, health degraded, owner repair restores ok', async () => {
    const step = await inject('orders.write_enabled', false);
    expect(step.ok, step.error).toBe(true);
    await sleep(600);
    const order = await checkoutRequest('POST', '/orders', {
      body: { sku: PROBE.sku, quantity: 1 },
      headers: { [PROBE.header]: 'acc6-adapter-f5' },
    });
    expect(order.status).toBe(503);
    expect(order.text).toContain('writes_disabled');
    const health = (await checkoutRequest('GET', '/health')).body as {
      status: string;
      errorClasses: string[];
    };
    expect(health.status).toBe('degraded');
    expect(health.errorClasses).toContain('writes_disabled');
    const business = await db.snapshot();
    const repaired = await ownerSet(
      'orders.write_enabled',
      baseline['orders.write_enabled'],
    );
    expect(repaired.response.status).toBe(200);
    await sleep(600);
    expect(
      ((await checkoutRequest('GET', '/health')).body as { status: string })
        .status,
    ).toBe('ok');
    expect((await db.snapshot()).hash).toBe(business.hash); // the failed order wrote nothing
  });

  it('F3 pool starvation: 503 pool_timeout under concurrency, health degraded, raising db.pool_max repairs', async () => {
    expect((await inject('db.pool_max', 1)).ok).toBe(true);
    expect((await inject('db.statement_timeout_ms', 50)).ok).toBe(true);
    await sleep(600);
    let timeouts = 0;
    for (let round = 0; round < 3 && timeouts === 0; round += 1)
      timeouts = (await loadSample(200, 12, PROBE.sku)).poolTimeout503;
    expect(timeouts).toBeGreaterThan(0);
    const degraded = (await checkoutRequest('GET', '/health')).body as {
      status: string;
      errorClasses: string[];
    };
    expect(['degraded', 'down']).toContain(degraded.status);
    await restoreBaseline(['db.pool_max', 'db.statement_timeout_ms']);
    expect((await loadSample(200, 12, PROBE.sku)).poolTimeout503).toBe(0);
    expect(
      ((await checkoutRequest('GET', '/health')).body as { status: string })
        .status,
    ).toBe('ok');
  });

  it('F2 schema mismatch: 500 cache_decode_error with expected and found schema in /metrics', async () => {
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

  it('F1 stale namespace needs the injector to seed stale blobs (entry point check)', async () => {
    const step = await inject('cache.namespace', 'acc6-adapter-ns').then(
      (s) => s,
      (error: Error) => ({ ok: false, error: error.message }),
    );
    // seedStaleBlobs is only required when a step asks for it; this scenario asks.
    const withBlobs = await applier
      .apply(1, {
        trigger: { kind: 'pre_start' },
        key: 'cache.namespace',
        value: 'acc6-adapter-ns2',
        actor: 'injector',
        requiresStaleBlobs: true,
      })
      .then(
        () => 'applied',
        (error: Error) => error.message,
      );
    expect(step.ok).toBe(true);
    expect(withBlobs).toBe('applied');
    await restoreBaseline(['cache.namespace']);
  });

  it('G6.2 a benign banner change by the owner moves no checkout health or business data', async () => {
    const before = await db.snapshot();
    const { response } = await ownerSet('ui.banner_text', banner(1));
    expect(response.status).toBe(200);
    await sleep(600);
    expect(
      ((await checkoutRequest('GET', '/health')).body as { status: string })
        .status,
    ).toBe('ok');
    expect((await db.snapshot()).hash).toBe(before.hash);
    await restoreBaseline(['ui.banner_text']);
  });
});

describe('G6.6 deterministic adapter: version authority compare-and-set', () => {
  it('G6.6 a stale expectedVersion is rejected with 409 and leaves version and history unchanged', async () => {
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
    const step = await inject('ui.banner_text', banner(20));
    expect(step.ok, step.error).toBe(true);
    const row = (await db.configVersions()).find(
      (r) => r.key === 'ui.banner_text' && r.version === step.versionAfter,
    );
    expect(row?.causedByActor).toBe('injector');
    expect(row?.causedByActionId).toBeNull();
  });
});

describe('G6.2/G6.10 deterministic adapter: honest modes', () => {
  it('G6.10 in blocked mode mission creation is refused with variable names only', async () => {
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
