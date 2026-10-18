// Scenario preconditions on a real database: every fault class establishes its
// own prerequisites, is verified through the production readers before inject()
// resolves, shows its symptom, repairs, and is healthy again. A scenario whose
// symptom does not appear fails loudly (scenario_precondition_failed) instead
// of becoming a silent no-fault trial.
import { describe, expect, it } from 'vitest';
import type {
  Scope,
  SourceKey,
} from '../../../../src/server/nemodots/contracts/ids.js';
import {
  Injector,
  notifyProposed,
  type ScenarioRun,
} from '../../../../src/server/nemodots/sandbox/injector.js';
import {
  ScenarioManifestSchema,
  type ScenarioManifest,
} from '../../../../src/server/nemodots/sandbox/manifest.js';
import { ScenarioPreconditionFailed } from '../../../../src/server/nemodots/sandbox/preconditions.js';
import { createSourceReaders } from '../../../../src/server/nemodots/sandbox/readers.js';
import { SCARCE_SKU } from '../../../../src/server/nemodots/sandbox/seed.js';
import { advanceConfigTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { withSandbox, type Json, type Sandbox } from './harness.js';

const scope = {
  ownerId: 'owner',
  missionId: '11111111-1111-4111-8111-111111111111',
  spaceId: null,
  environment: 'test',
  resource: 'checkout',
} as unknown as Scope;

/** What an agent's readers return right now (fresh configuration view). */
function observe(s: Sandbox) {
  const readers = createSourceReaders({
    pg: s.pools.verifier,
    redis: s.redis.client,
    redisPrefix: s.redis.prefix,
    checkoutUrl: 'http://checkout.invalid',
    fetch: s.fetch,
    now: s.clock.now,
  });
  return async (key: string): Promise<Json> => {
    s.reloadConfig();
    return (await readers.read(key as SourceKey, scope)).normalizedValue;
  };
}

async function repair(
  s: Sandbox,
  key: string,
  value: string | number | boolean,
) {
  const row = await s.pools.app.query(
    'SELECT version FROM checkout.config_entries WHERE key = $1',
    [key],
  );
  await advanceConfigTx(s.pools.app, {
    key,
    value,
    expectedVersion: Number(row.rows[0].version),
    causedBy: { actor: 'owner' },
  });
  s.reloadConfig();
}

const manifest = (
  steps: unknown[],
  preconditions: unknown,
  extra: Record<string, unknown> = {},
): ScenarioManifest =>
  ScenarioManifestSchema.parse({
    id: 'adhoc_preconditions',
    version: 1,
    class: 'repairable_checkout_fault',
    description: 'ad hoc test scenario',
    preconditions,
    steps,
    oracle: {
      faultClass: 'multi',
      expectation: 'repair_required',
      symptoms: [],
      acceptableRepairs: [],
      mustNotChange: [],
    },
    ...extra,
  });

const injectorFor = (s: Sandbox, verified = true) =>
  new Injector({
    pool: s.pools.injector,
    listenUrl: s.db.urls.injector,
    preconditions: verified ? s.preconditionDeps() : undefined,
  });

async function recorded(s: Sandbox, run: ScenarioRun) {
  const row = await s.pools.verifier.query<{ status: string; detail: Json }>(
    'SELECT status, detail FROM control.scenario_runs WHERE id = $1',
    [run.runId],
  );
  return row.rows[0];
}

const versionOf = async (s: Sandbox, key: string) =>
  Number(
    (
      await s.pools.verifier.query(
        'SELECT version FROM checkout.config_entries WHERE key = $1',
        [key],
      )
    ).rows[0].version,
  );

describe('every fault class: inject -> symptom observable -> repair -> healthy', () => {
  it('cache_schema_mismatch: the scenario warms the cache itself (cold start)', async () => {
    await withSandbox(async (s) => {
      // nothing has read the catalogue or /health yet: the cache is cold
      expect((await observe(s)('redis.stats')).keyCounts).toEqual({});
      const run = await s.inject('cache_schema_mismatch', 1);
      const ready = await run.ready;
      expect(ready.status).toBe('verified');
      expect(ready.setup).toEqual([
        expect.objectContaining({ kind: 'warm_cache', ok: true }),
      ]);
      expect((await recorded(s, run)).detail.preconditions.status).toBe(
        'verified',
      );

      const read = observe(s);
      const health = await read('checkout.health');
      expect(health.status).toBe('degraded');
      expect(health.errors).toEqual(['cache_decode_error']);
      const metrics = await read('checkout.metrics');
      expect(metrics.errorClasses).toContain('cache_decode_error');
      expect(metrics.cacheDecodeError).toMatchObject({ foundSchema: 1 });
      expect(metrics.cacheDecodeError.expectedSchema).toBeGreaterThan(1);

      await repair(s, 'cache.schema_version', 1);
      expect((await read('checkout.health')).status).toBe('ok');
      expect((await s.request('/products')).status).toBe(200);
    });
  });

  it('dependent_change_after_proposal: verified at the first fault, still armed for the proposal', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('dependent_change_after_proposal', 1);
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      expect((await read('checkout.health')).errors).toEqual([
        'cache_decode_error',
      ]);
      // the second advance has not happened: the step waits for a proposal
      const before = await versionOf(s, 'cache.schema_version');
      let settled = false;
      const second = run.stepSettled(1).then((outcome) => {
        settled = true;
        return outcome;
      });
      const t0 = Date.now();
      while (!settled && Date.now() - t0 < 5_000) {
        await notifyProposed(s.pools.app, 'cache.schema_version');
        await Promise.race([second, new Promise((r) => setTimeout(r, 50))]);
      }
      expect(await second).toMatchObject({ status: 'applied' });
      expect(await versionOf(s, 'cache.schema_version')).toBe(before + 1);
      expect((await read('checkout.health')).errors).toEqual([
        'cache_decode_error',
      ]);
      await repair(s, 'cache.schema_version', 1);
      expect((await read('checkout.health')).status).toBe('ok');
    });
  });

  it('second_change_during_repair: the later fault waits for the verified first one', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('second_change_during_repair', 1);
      const startedAt = Date.now();
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      expect((await read('checkout.health')).errors).toEqual([
        'cache_decode_error',
      ]);
      // the pool shrink is gated on readiness: it lands only after its delay
      expect(await versionOf(s, 'db.pool_max')).toBe(1);
      const second = await run.stepSettled(1);
      expect(second).toMatchObject({ status: 'applied', key: 'db.pool_max' });
      expect(second.settledAt - startedAt).toBeGreaterThanOrEqual(2_300);
      const health = await read('checkout.health');
      expect(health.errors).toEqual(['cache_decode_error', 'pool_exhausted']);
      await repair(s, 'cache.schema_version', 1);
      await repair(s, 'db.pool_max', 10);
      expect((await read('checkout.health')).status).toBe('ok');
    });
  });

  it('pool_starvation', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('pool_starvation', 1);
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      const health = await read('checkout.health');
      expect(health.status).toBe('degraded');
      expect(health.errors).toEqual(['pool_exhausted']);
      await repair(s, 'db.pool_max', 10);
      expect((await read('checkout.health')).status).toBe('ok');
    });
  });

  it('stale_replica: the API view and the authority disagree before any customer traffic', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('stale_replica', 1);
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      const view = await read(`checkout.inventory/${SCARCE_SKU}`);
      expect(view.consistent).toBe(false);
      expect(view.divergence).not.toBe(0);
      expect((await read('checkout.health')).status).toBe('ok');
      await repair(s, 'routing.inventory_source', 'primary');
      expect((await read(`checkout.inventory/${SCARCE_SKU}`)).consistent).toBe(
        true,
      );
    });
  });

  it('writes_disabled', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('writes_disabled', 1);
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      const health = await read('checkout.health');
      expect(health.checks.writes).toBe(false);
      expect(health.errors).toEqual(['writes_disabled']);
      await repair(s, 'orders.write_enabled', true);
      expect((await read('checkout.health')).status).toBe('ok');
    });
  });

  it('conflicting_observations: a healthy /health beside a disagreeing inventory', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('conflicting_observations', 1);
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      expect((await read('checkout.health')).status).toBe('ok');
      expect((await read(`checkout.inventory/${SCARCE_SKU}`)).consistent).toBe(
        false,
      );
      // the misleading banner is gated behind the verified symptoms
      expect(await versionOf(s, 'ui.banner_text')).toBe(1);
      await repair(s, 'routing.inventory_source', 'primary');
      expect((await read(`checkout.inventory/${SCARCE_SKU}`)).consistent).toBe(
        true,
      );
    });
  });

  it('diverging_edges: both branches are visible at once, the later advance is gated', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('diverging_edges', 1);
      expect((await run.ready).status).toBe('verified');
      const read = observe(s);
      expect((await read('checkout.health')).errors).toEqual([
        'cache_decode_error',
      ]);
      expect((await read(`checkout.inventory/${SCARCE_SKU}`)).consistent).toBe(
        false,
      );
      const afterReady = await versionOf(s, 'cache.schema_version');
      const third = await run.stepSettled(2);
      expect(third).toMatchObject({
        status: 'applied',
        versionAfter: afterReady + 1,
      });
      await repair(s, 'cache.schema_version', 1);
      await repair(s, 'routing.inventory_source', 'primary');
      expect((await read('checkout.health')).status).toBe('ok');
      expect((await read(`checkout.inventory/${SCARCE_SKU}`)).consistent).toBe(
        true,
      );
    });
  });

  it.each(['healthy', 'benign_change'])(
    '%s: verified healthy before the mission starts',
    async (id) => {
      await withSandbox(async (s) => {
        const run = await s.inject(id, 1);
        expect((await run.ready).status).toBe('verified');
        expect((await observe(s)('checkout.health')).status).toBe('ok');
        expect((await run.done).status).toBe('completed');
      });
    },
  );
});

describe('a scenario whose symptom never appears fails loudly', () => {
  it('cold cache without the warm-up: scenario_precondition_failed, nothing scored as no-fault', async () => {
    await withSandbox(async (s) => {
      const cold = manifest(
        [
          {
            kind: 'set_config',
            key: 'cache.schema_version',
            value: 2,
            trigger: { type: 'immediate' },
          },
          {
            kind: 'set_config',
            key: 'ui.banner_text',
            value: 'later',
            trigger: { type: 'delay', delayMs: 100 },
            after: [0],
          },
        ],
        { visible: ['cache_decode_error'], withinMs: 600 },
      );
      const injector = injectorFor(s);
      const error = await injector.startVerified(cold, 1).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ScenarioPreconditionFailed);
      const failure = error as ScenarioPreconditionFailed;
      expect(failure.code).toBe('scenario_precondition_failed');
      expect(failure.message).toContain('scenario_precondition_failed');
      expect(failure.report.status).toBe('failed');
      expect(failure.report.failure?.phase).toBe('visible');
      expect(failure.report.visible).toEqual([
        expect.objectContaining({ symptom: 'cache_decode_error', seen: false }),
      ]);
      // the run is on record as failed, with the report, and the later step never ran
      const run = await s.pools.verifier.query<{
        status: string;
        detail: Json;
      }>('SELECT status, detail FROM control.scenario_runs WHERE id = $1', [
        failure.runId,
      ]);
      expect(run.rows[0].status).toBe('failed');
      expect(run.rows[0].detail.preconditions.status).toBe('failed');
      const steps = await s.pools.verifier.query(
        'SELECT step_index, status, error FROM control.fault_schedules WHERE run_id = $1 ORDER BY step_index',
        [failure.runId],
      );
      expect(steps.rows).toEqual([
        { step_index: 0, status: 'applied', error: null },
        {
          step_index: 1,
          status: 'skipped',
          error: 'scenario_precondition_failed',
        },
      ]);
      expect(await versionOf(s, 'ui.banner_text')).toBe(1);
    });
  });

  it('a warm-up that leaves nothing in the cache fails in the setup phase and applies no fault', async () => {
    // the checkout cannot reach Redis: the catalogue is served uncached
    await withSandbox(
      async (s) => {
        const m = manifest(
          [{ kind: 'set_config', key: 'cache.schema_version', value: 2 }],
          { setup: [{ kind: 'warm_cache' }], visible: ['cache_decode_error'] },
        );
        const error = await injectorFor(s)
          .startVerified(m, 1)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(error).toBeInstanceOf(ScenarioPreconditionFailed);
        const failure = error as ScenarioPreconditionFailed;
        expect(failure.report.failure?.phase).toBe('setup');
        expect(failure.report.setup[0]).toMatchObject({
          kind: 'warm_cache',
          ok: false,
        });
        expect(await versionOf(s, 'cache.schema_version')).toBe(1);
        const steps = await s.pools.verifier.query(
          'SELECT status, error FROM control.fault_schedules WHERE run_id = $1',
          [failure.runId],
        );
        expect(steps.rows).toEqual([
          { status: 'skipped', error: 'scenario_precondition_failed' },
        ]);
      },
      { redisUrl: 'redis://127.0.0.1:1' },
    );
  });

  it('a change that does not produce the declared symptom is reported with what the readers showed', async () => {
    await withSandbox(async (s) => {
      const mild = manifest(
        [{ kind: 'set_config', key: 'db.pool_max', value: 8 }],
        { visible: ['pool_exhausted'], withinMs: 600 },
      );
      const error = await injectorFor(s)
        .startVerified(mild, 1)
        .then(
          () => null,
          (e: unknown) => e,
        );
      const failure = error as ScenarioPreconditionFailed;
      expect(failure).toBeInstanceOf(ScenarioPreconditionFailed);
      expect(failure.report.visible[0]).toMatchObject({
        symptom: 'pool_exhausted',
        seen: false,
      });
      expect(failure.report.visible[0].detail).toContain('health ok');
    });
  });

  it('an initial step that fails is a precondition failure when the scenario declares preconditions', async () => {
    await withSandbox(async (s) => {
      const broken = manifest(
        [{ kind: 'set_config', key: 'no.such.key', value: 1 }],
        { visible: ['healthy'] },
      );
      const error = await injectorFor(s)
        .startVerified(broken, 1)
        .then(
          () => null,
          (e: unknown) => e,
        );
      const failure = error as ScenarioPreconditionFailed;
      expect(failure.report.failure?.phase).toBe('initial_steps');
      expect(failure.report.failure?.message).toContain(
        'config key does not exist',
      );
    });
  });

  it('cancelling while the symptoms are being awaited is a cancel, not a precondition failure', async () => {
    await withSandbox(async (s) => {
      const never = manifest(
        [{ kind: 'set_config', key: 'ui.banner_text', value: 'x' }],
        { visible: ['pool_exhausted'], withinMs: 30_000 },
      );
      const run = await injectorFor(s).start(never, 1);
      await new Promise((r) => setTimeout(r, 200));
      await run.cancel();
      const ready = await run.ready;
      expect(ready.status).toBe('failed');
      expect(ready.failure?.cancelled).toBe(true);
      expect((await run.done).status).toBe('cancelled');
    });
  });
});

describe('unchecked runs say so', () => {
  it('without readers a declared scenario is reported unchecked, and startVerified does not pretend', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('cache_schema_mismatch', 1, { verify: false });
      const ready = await run.ready;
      expect(ready).toMatchObject({
        status: 'unchecked',
        reason: 'no_verifier_configured',
      });
      expect((await recorded(s, run)).detail.preconditions.status).toBe(
        'unchecked',
      );
    });
  });

  it('a scenario with no declared preconditions is unchecked for that reason', async () => {
    await withSandbox(async (s) => {
      const plain = manifest(
        [{ kind: 'set_config', key: 'ui.banner_text', value: 'x' }],
        undefined,
      );
      const run = await injectorFor(s).start(plain, 1);
      expect(await run.ready).toMatchObject({
        status: 'unchecked',
        reason: 'no_preconditions_declared',
      });
      expect((await run.done).status).toBe('completed');
    });
  });
});

describe('the preconditions stay out of the agents’ view', () => {
  it('no reader output carries the scenario, its preconditions or the injector', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('cache_schema_mismatch', 1);
      await run.ready;
      const read = observe(s);
      const seen = JSON.stringify([
        await read('checkout.health'),
        await read('checkout.metrics'),
        await read('checkout.orders.recent'),
        await read(`checkout.inventory/${SCARCE_SKU}`),
        await read('redis.stats'),
        await read('checkout.config'),
        await read('checkout.config/cache.schema_version'),
      ]);
      expect(seen).not.toMatch(
        /cache_schema_mismatch|precondition|scenario|oracle|injector|warm_cache/i,
      );
      // the control schema is closed to the application role
      await expect(
        s.pools.app.query('SELECT 1 FROM control.scenario_runs'),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
