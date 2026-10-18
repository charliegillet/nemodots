// Can the independent probe pass while the seeded cache fault is active?
// (changed-evidence investigation.) The probe creates and reads an order, checks
// inventory, and requires /health to stay ok across its window. F2 breaks
// cached reads and degrades /health, so a probe taken while the fault is active
// must FAIL. The fault is only active if the cache already holds entries under
// the baseline schema when the schema version changes: a health check writes
// its canary under whatever schema is current, so an unwarmed cache would make
// an injection a no-op, and the mission would then be legitimately healthy.
//
// That used to be a property of the scenario (a silent no-fault trial). The
// scenario now declares `preconditions` (warm_cache + the symptom that must be
// visible), so the injector warms the cache itself and verifies the decode error
// through the readers before inject() resolves. The no-op remains reachable only
// as an explicitly unverified run; the evals never score an `unchecked` run.
import { expect, it } from 'vitest';
import { createProbe } from '../../../../src/server/nemodots/sandbox/probe.js';
import { withSandbox, type Sandbox } from '../sandbox/harness.js';

const probe = (s: Sandbox) =>
  createProbe({
    verifier: s.pools.verifier,
    checkoutUrl: 'http://checkout.invalid',
    probeSecret: s.probeSecret,
    windowMs: 200,
    sampleIntervalMs: 50,
    fetch: s.fetch,
  });

it('an unwarmed sandbox + cache_schema_mismatch: the scenario warms the cache itself, the fault is active and the probe FAILS', async () => {
  await withSandbox(async (s) => {
    // nothing is warmed by hand: the scenario's preconditions warm the cache
    // under the baseline schema and verify the symptom before this resolves
    const run = await s.inject('cache_schema_mismatch', 1);
    expect((await run.ready).status).toBe('verified');
    expect((await run.done).status).toBe('completed');
    s.reloadConfig();

    // active: every cached read fails, /health is degraded
    expect((await s.request('/products')).status).toBe(500);
    const health = await s.request('/health');
    expect(health.status).toBe(503);
    expect(health.body.status).toBe('degraded');

    // orders do not depend on the cache, but the health window does
    const result = await probe(s).execute();
    expect(result.verdict).toBe('fail');
    expect(result.invariants.filter((i) => !i.ok).map((i) => i.name)).toEqual([
      'health_window_ok',
    ]);
    expect(result.healthWindow.allOk).toBe(false);
  });
}, 60_000);

it('an UNVERIFIED injection into an unwarmed cache is a no-op: health stays ok and the probe passes (status unchecked, never scored)', async () => {
  await withSandbox(async (s) => {
    // no health check or catalogue read before the fault, and no preconditions
    // run: this is exactly the silent no-fault trial the verified path rejects
    const run = await s.inject('cache_schema_mismatch', 1, { verify: false });
    expect(await run.ready).toMatchObject({
      status: 'unchecked',
      reason: 'no_verifier_configured',
    });
    expect((await run.done).status).toBe('completed');
    s.reloadConfig();

    // the config really changed ...
    const { rows } = await s.pools.verifier.query(
      "SELECT value, version FROM checkout.config_entries WHERE key = 'cache.schema_version'",
    );
    expect(Number(rows[0].version)).toBeGreaterThan(1);
    expect(rows[0].value).not.toBe(1);
    // ... but the first reads after it write fresh entries under the new schema
    expect((await s.request('/health')).status).toBe(200);
    expect((await s.request('/products')).status).toBe(200);
    expect((await s.request('/products')).status).toBe(200);
    const result = await probe(s).execute();
    expect(result.verdict).toBe('pass');
  });
}, 60_000);
