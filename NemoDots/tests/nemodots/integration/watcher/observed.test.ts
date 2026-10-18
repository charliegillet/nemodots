// Observed sources: every poll is a read passed to registerObservation, so an
// unchanged normalized digest becomes a confirmation and a changed one a new
// revision (findings I2/D2, ARCHITECTURE 9.4).
import { describe, expect, it } from 'vitest';
import { createProbe } from '../../../../src/server/nemodots/sandbox/probe.js';
import {
  confirmationCount,
  headOf,
  injectorWrite,
  lastConfirmedAt,
  ledgerEvents,
  missionReading,
  receiptsOf,
  sleep,
  withWatcherEnv,
  attemptStatus,
  type WatcherEnv,
} from './harness.js';

const OBSERVED = [
  'checkout.health',
  'checkout.metrics',
  'checkout.orders.recent',
  'redis.stats',
];

async function snapshot(env: WatcherEnv, keys: string[]) {
  const out: Record<
    string,
    { revision: number; id: string; confirmations: number; at: number }
  > = {};
  for (const key of keys) {
    const head = await headOf(env, key);
    out[key] = {
      revision: head.revision,
      id: head.id,
      confirmations: await confirmationCount(env, key),
      at: (await lastConfirmedAt(env, head.id)).getTime(),
    };
  }
  return out;
}

describe('unchanged observed sources', () => {
  it('5 polls: zero new revisions, 5 confirmations per source, lastConfirmedAt advances every poll', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      // The first /health call leaves a canary cache key, which moves
      // redis.stats exactly once; two polls reach the steady state.
      await watcher.runCycle();
      await watcher.runCycle();
      const eventsBefore = (await ledgerEvents(env)).length;
      const base = await snapshot(env, OBSERVED);

      const times: Record<string, number[]> = {};
      for (let poll = 1; poll <= 5; poll += 1) {
        await sleep(15); // lastConfirmedAt has millisecond resolution
        await watcher.runCycle();
        const now = await snapshot(env, OBSERVED);
        for (const key of OBSERVED) {
          expect(now[key].revision, `${key} poll ${poll}`).toBe(
            base[key].revision,
          );
          expect(now[key].id).toBe(base[key].id);
          expect(now[key].confirmations, `${key} poll ${poll}`).toBe(
            base[key].confirmations + poll,
          );
          (times[key] ??= []).push(now[key].at);
        }
      }
      for (const key of OBSERVED) {
        expect(times[key][0], key).toBeGreaterThan(base[key].at);
        for (let i = 1; i < times[key].length; i += 1)
          expect(times[key][i], key).toBeGreaterThan(times[key][i - 1]);
        expect((await receiptsOf(env, key)).at(-1)?.status).toBe('supported');
      }
      // no revision, so no supersession and no invalidation
      expect((await ledgerEvents(env)).length).toBe(eventsBefore);
    });
  });
});

describe('a changed observed source', () => {
  it('health: a degraded status registers once, invalidates its readers and is then only confirmed', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      await watcher.runCycle();
      const first = await headOf(env, 'checkout.health');
      expect(first.normalizedValue).toMatchObject({ status: 'ok' });
      const reader = await missionReading(env, [['checkout.health']]);
      const bystander = await missionReading(env, [['checkout.orders.recent']]);
      const eventsBefore = (await ledgerEvents(env, 'checkout.health')).length;

      await injectorWrite(env, 'orders.write_enabled', false);
      env.s.reloadConfig();
      await watcher.runCycle();

      const health = await receiptsOf(env, 'checkout.health');
      expect(health.map((r) => [r.revision, r.status])).toEqual([
        [first.revision, 'superseded'],
        [first.revision + 1, 'supported'],
      ]);
      expect(health[1].normalizedValue).toMatchObject({
        status: 'degraded',
        checks: { writes: false },
      });
      const events = (await ledgerEvents(env, 'checkout.health')).slice(
        eventsBefore,
      );
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('newer_observation');
      expect(events[0].perMission.map((p) => p.missionId)).toEqual([
        reader.missionId,
      ]);
      expect(events[0].affected.attemptIds).toEqual([
        reader.attempts[0].attemptId,
      ]);
      expect(await attemptStatus(env, reader.attempts[0].attemptId)).toBe(
        'invalidated',
      );
      expect(await attemptStatus(env, bystander.attempts[0].attemptId)).toBe(
        'running',
      );

      // still degraded: confirmed, not registered again
      const confirmations = await confirmationCount(env, 'checkout.health');
      await watcher.runCycle();
      await watcher.runCycle();
      expect(await receiptsOf(env, 'checkout.health')).toHaveLength(2);
      expect(await confirmationCount(env, 'checkout.health')).toBe(
        confirmations + 2,
      );
      expect((await ledgerEvents(env, 'checkout.health')).length).toBe(
        eventsBefore + 1,
      );

      // back to healthy: one more revision
      await injectorWrite(env, 'orders.write_enabled', true);
      env.s.reloadConfig();
      await watcher.runCycle();
      const after = await receiptsOf(env, 'checkout.health');
      expect(after).toHaveLength(3);
      expect(after[2].normalizedValue).toMatchObject({ status: 'ok' });
    });
  });

  it('a source a tool registered (checkout.inventory/<sku>) is followed on every poll', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      const [registered] = await watcher.observe([
        'checkout.inventory/SKU-0001',
      ]);
      expect(registered.outcome).toBe('registered');
      const head = await headOf(env, 'checkout.inventory/SKU-0001');
      expect(head.normalizedValue).toMatchObject({
        sku: 'SKU-0001',
        consistent: true,
      });
      await watcher.runCycle();
      await watcher.runCycle();
      expect(await receiptsOf(env, 'checkout.inventory/SKU-0001')).toHaveLength(
        1,
      );
      expect(await confirmationCount(env, 'checkout.inventory/SKU-0001')).toBe(
        2,
      );

      // an unwatched family is skipped, never read
      const [skipped] = await watcher.observe(['runbook/cache']);
      expect(skipped.outcome).toBe('skipped');
    });
  });
});

describe('D2: the acceptance probe is evidence-neutral', () => {
  it('a probe run leaves orders.recent and the inventory receipts current', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher();
      await watcher.runCycle();
      await watcher.observe(['checkout.inventory/PROBE-SKU']);
      await watcher.runCycle();
      const watched = [...OBSERVED, 'checkout.inventory/PROBE-SKU'];
      const before = await snapshot(env, watched);

      const probe = createProbe({
        verifier: env.s.pools.verifier,
        checkoutUrl: 'http://checkout.invalid',
        probeSecret: env.s.probeSecret,
        windowMs: 0,
        sampleIntervalMs: 50,
        fetch: env.s.fetch,
      });
      const result = await probe.execute();
      expect(result.verdict).toBe('pass');
      // the probe really wrote: a tagged order exists and the authority moved
      const tagged = await env.admin.query(
        'SELECT count(*) AS n FROM checkout.orders WHERE probe_run_id IS NOT NULL',
      );
      expect(tagged.rows[0].n).toBe('1');

      await sleep(15);
      await watcher.runCycle();
      const after = await snapshot(env, watched);
      for (const key of watched) {
        expect(after[key].revision, key).toBe(before[key].revision);
        expect(after[key].id, key).toBe(before[key].id);
        expect(after[key].confirmations, key).toBe(
          before[key].confirmations + 1,
        );
        expect((await receiptsOf(env, key)).at(-1)?.status, key).toBe(
          'supported',
        );
      }
    });
  });
});
