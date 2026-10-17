// The injector's trigger machinery: delays, prerequisites, cancellation and the
// LISTEN-driven dependent change (C15). Uses ad-hoc manifests validated by the
// real manifest schema so timings stay short.
import { describe, expect, it } from 'vitest';
import {
  Injector,
  notifyProposed,
  parseProposedKey,
} from '../../../../src/server/nemodots/sandbox/injector.js';
import {
  ScenarioManifestSchema,
  type ScenarioManifest,
} from '../../../../src/server/nemodots/sandbox/manifest.js';
import { withSandbox, type Sandbox } from './harness.js';

const manifest = (
  steps: unknown[],
  extra: Partial<ScenarioManifest> = {},
): ScenarioManifest =>
  ScenarioManifestSchema.parse({
    id: 'adhoc',
    version: 1,
    class: 'repairable_checkout_fault',
    description: 'ad hoc test scenario',
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

const start = (s: Sandbox, m: ScenarioManifest, seed = 1) =>
  new Injector({ pool: s.pools.injector, listenUrl: s.db.urls.injector }).start(
    m,
    seed,
  );

const versionOf = async (s: Sandbox, key: string) =>
  Number(
    (
      await s.pools.verifier.query(
        'SELECT version FROM checkout.config_entries WHERE key = $1',
        [key],
      )
    ).rows[0].version,
  );

describe('dependent_change_after_proposal (C15)', () => {
  it('fires within 500 ms of the NOTIFY naming its key, and only for that key', async () => {
    await withSandbox(async (s) => {
      const run = await s.inject('dependent_change_after_proposal', 1);
      const first = await run.stepSettled(0);
      expect(first).toMatchObject({
        status: 'applied',
        key: 'cache.schema_version',
      });
      expect(await versionOf(s, 'cache.schema_version')).toBe(2);

      // a proposal for another key and a malformed payload leave the step armed
      await notifyProposed(s.pools.app, 'db.pool_max');
      await notifyProposed(s.pools.app, 'not a key!');
      await new Promise((r) => setTimeout(r, 300));
      expect(await versionOf(s, 'cache.schema_version')).toBe(2);

      const t0 = Date.now();
      await notifyProposed(s.pools.app, 'cache.schema_version');
      const second = await run.stepSettled(1);
      const elapsed = second.settledAt - t0;
      expect(second).toMatchObject({
        status: 'applied',
        key: 'cache.schema_version',
        versionBefore: 2,
        versionAfter: 3,
      });
      expect(elapsed).toBeLessThan(500);
      const summary = await run.done;
      expect(summary.status).toBe('completed');
      const head = await s.pools.verifier.query(
        "SELECT value, caused_by_actor, caused_by_action_id FROM checkout.config_entries WHERE key = 'cache.schema_version'",
      );
      expect([5, 6]).toContain(head.rows[0].value);
      expect(head.rows[0]).toMatchObject({
        caused_by_actor: 'injector',
        caused_by_action_id: null,
      });
    });
  });

  it('accepts the source-key and JSON payload forms, and fires only once', async () => {
    await withSandbox(async (s) => {
      const m = manifest([
        {
          kind: 'dependent_change_after_proposal',
          values: { 'db.pool_max': 2 },
          timeoutMs: 20000,
        },
      ]);
      const run = await start(s, m);
      await notifyProposed(s.pools.app, 'checkout.config/db.pool_max');
      await notifyProposed(s.pools.app, JSON.stringify({ key: 'db.pool_max' }));
      await run.done;
      expect(await versionOf(s, 'db.pool_max')).toBe(2);
      expect(
        parseProposedKey('{"target":"checkout.config/cache.namespace"}'),
      ).toBe('cache.namespace');
      expect(parseProposedKey(undefined)).toBeNull();
      expect(parseProposedKey('{bad json')).toBeNull();
    });
  });

  it('is skipped when no matching proposal arrives before its timeout', async () => {
    await withSandbox(async (s) => {
      const run = await start(
        s,
        manifest([
          {
            kind: 'dependent_change_after_proposal',
            values: { 'db.pool_max': 2 },
            timeoutMs: 150,
          },
        ]),
      );
      const summary = await run.done;
      expect(summary.steps[0]).toMatchObject({
        status: 'skipped',
        error: 'no_matching_proposal',
      });
      expect(summary.status).toBe('completed');
      expect(await versionOf(s, 'db.pool_max')).toBe(1);
    });
  });

  it('cancel() skips armed steps and leaves the configuration alone', async () => {
    await withSandbox(async (s) => {
      const run = await start(
        s,
        manifest([
          {
            kind: 'dependent_change_after_proposal',
            values: { 'db.pool_max': 2 },
          },
          {
            kind: 'set_config',
            key: 'ui.banner_text',
            value: 'late',
            trigger: { type: 'delay', delayMs: 30000 },
          },
        ]),
      );
      await run.cancel();
      const summary = await run.done;
      expect(summary.status).toBe('cancelled');
      expect(summary.steps.map((st) => [st.status, st.error])).toEqual([
        ['skipped', 'cancelled'],
        ['skipped', 'cancelled'],
      ]);
      expect(await versionOf(s, 'db.pool_max')).toBe(1);
      expect(await versionOf(s, 'ui.banner_text')).toBe(1);
    });
  });
});

describe('delays, prerequisites and membership steps', () => {
  it('honours delays after prerequisites and applies steps in order', async () => {
    await withSandbox(async (s) => {
      const t0 = Date.now();
      const run = await start(
        s,
        manifest([
          { kind: 'set_config', key: 'db.pool_max', value: 3 },
          {
            kind: 'set_config',
            key: 'ui.banner_text',
            value: 'later',
            trigger: { type: 'delay', delayMs: 250 },
            after: [0],
          },
        ]),
      );
      const first = await run.stepSettled(0);
      const second = await run.stepSettled(1);
      expect(first.status).toBe('applied');
      expect(second.status).toBe('applied');
      expect(second.settledAt - first.settledAt).toBeGreaterThanOrEqual(240);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      expect((await run.done).status).toBe('completed');
    });
  });

  it('a failed step makes dependents skip and the run fail', async () => {
    await withSandbox(async (s) => {
      const run = await start(
        s,
        manifest([
          { kind: 'set_config', key: 'no.such.key', value: 1 },
          { kind: 'set_config', key: 'db.pool_max', value: 3, after: [0] },
        ]),
      );
      const summary = await run.done;
      expect(summary.status).toBe('failed');
      expect(summary.steps[0]).toMatchObject({
        status: 'failed',
        error: 'config key does not exist',
      });
      expect(summary.steps[1]).toMatchObject({
        status: 'skipped',
        error: 'prerequisite_not_applied',
      });
      expect(await versionOf(s, 'db.pool_max')).toBe(1);
      const row = await s.pools.verifier.query(
        'SELECT status FROM control.scenario_runs WHERE id = $1',
        [run.runId],
      );
      expect(row.rows[0].status).toBe('failed');
    });
  });

  it('insert_config and delete_config change membership through the version authority', async () => {
    await withSandbox(async (s) => {
      const collection = async () =>
        Number(
          (
            await s.pools.verifier.query(
              'SELECT version FROM checkout.config_collection',
            )
          ).rows[0].version,
        );
      const base = await collection();
      const run = await start(
        s,
        manifest([
          { kind: 'insert_config', key: 'exp.flag', value: true },
          { kind: 'delete_config', key: 'exp.flag', after: [0] },
        ]),
      );
      const summary = await run.done;
      expect(summary.steps.map((st) => st.status)).toEqual([
        'applied',
        'applied',
      ]);
      expect(await collection()).toBe(base + 2);
      const history = await s.pools.verifier.query(
        "SELECT version, value, caused_by_actor FROM checkout.config_versions WHERE key = 'exp.flag' ORDER BY version",
      );
      expect(history.rows).toEqual([
        { version: '1', value: true, caused_by_actor: 'injector' },
        { version: '2', value: null, caused_by_actor: 'injector' },
      ]);
    });
  });
});
