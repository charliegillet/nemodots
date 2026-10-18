// C4 (high): `admitted` is durable, and commit re-executes EVERY G1 predicate
// under lock; an expired dispatcher cannot commit and its intent is
// re-claimable (ARCHITECTURE 4, 5.1, 6, 14 C4).
//
// Also states the residual window of freshness-at-admission for observed
// sources (README "Freshness"): a change the watcher has not observed cannot
// be detected, so a commit may rest on an observed fact that is no longer
// true for up to maxAgeMs since the last confirmation plus the commit latency.
import { describe, expect, it } from 'vitest';
import {
  actionHistory,
  admitAndCommit,
  authorizations,
  configState,
  countRows,
  expireDispatcherLease,
  externalChange,
  intentStatus,
  observed,
  proposePool,
  scenario,
  sleep,
  withWorld,
} from './harness.js';

describe('C4 admitted then changed', () => {
  it('a controlled dependency advances after admission: the commit blocks(stale), writes nothing', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      const v = await externalChange(world, 'db.pool_max', 14);
      const result = await world.service.commit(intent.id, admitted.dispatch!.fence);
      expect(result.status).toBe('blocked');
      expect(['stale_version', 'target_version_mismatch']).toContain(result.blockReason);
      const now = await configState(world, 'db.pool_max');
      expect(now.version).toBe(v);
      expect(now.value).toBe(14);
      expect(await actionHistory(world, intent.id)).toHaveLength(0);
      const authz = await authorizations(world, intent.id);
      expect(authz.map((a) => `${a.stage}:${a.decision}`)).toEqual([
        'admission:admitted',
        'commit:blocked',
      ]);
    });
  });

  it('an observed dependency is superseded after admission: the commit blocks', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      await observed(world, 'checkout.health', { status: 'ok', checks: { postgres: true } });
      const result = await world.service.commit(intent.id, admitted.dispatch!.fence);
      expect(result.status).toBe('blocked');
      expect(result.blockReason).toBe('stale_version');
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
    });
  });

  it('the cited health confirmation ages past maxAgeMs between admission and commit: evidence_too_old', async () => {
    await withWorld(async (world) => {
      // 119.2 s old at admission (limit 120 s), still within it.
      const s = await scenario(world, { healthAgeMs: 119_200 });
      const intent = await proposePool(world, s, 20);
      const admitted = await world.service.admit(intent.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
      await sleep(1_100);
      const result = await world.service.commit(intent.id, admitted.dispatch!.fence);
      expect(result.status).toBe('blocked');
      expect(result.blockReason).toBe('evidence_too_old');
    });
  });

  it('RESIDUAL WINDOW (freshness-at-admission): the world changes but the watcher never observed it; the commit goes through on the stale observation', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world, { healthAgeMs: 1_000 });
      const intent = await proposePool(world, s, 20);
      // (Imagine the real checkout turned healthy here; nobody registered it.)
      const { committed } = await admitAndCommit(world, intent.id);
      expect(committed.status).toBe('committed');
      expect((await configState(world, 'db.pool_max')).value).toBe(20);
    });
  });

  it('expired dispatcher: A is admitted, its lease lapses, B re-admits with a higher fence; A cannot commit, B commits once', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const a = await world.service.admit(intent.id, 'dispatcher-a');
      await expireDispatcherLease(world, intent.id);
      const b = await world.service.admit(intent.id, 'dispatcher-b');
      expect(b.status).toBe('admitted');
      expect(b.dispatch!.owner).toBe('dispatcher-b');
      expect(b.dispatch!.fence).toBeGreaterThan(a.dispatch!.fence);
      await expect(
        world.service.commit(intent.id, a.dispatch!.fence),
      ).rejects.toMatchObject({ name: 'DispatchFenceError' });
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
      const done = await world.service.commit(intent.id, b.dispatch!.fence);
      expect(done.status).toBe('committed');
      expect(await actionHistory(world, intent.id)).toHaveLength(1);
      expect(
        await countRows(world, 'coordinator.authorizations',
          "action_id = $1 AND decision = 'committed'", [intent.id]),
      ).toBe(1);
    });
  });

  it('an admitted intent whose own dispatcher lease expired cannot commit even with the correct fence (nobody re-admitted yet)', async () => {
    await withWorld(async (world) => {
      const s = await scenario(world);
      const intent = await proposePool(world, s, 20);
      const a = await world.service.admit(intent.id, 'dispatcher-a');
      await expireDispatcherLease(world, intent.id);
      await expect(
        world.service.commit(intent.id, a.dispatch!.fence),
      ).rejects.toMatchObject({ name: 'DispatchFenceError' });
      expect((await intentStatus(world, intent.id)).status).toBe('admitted');
      expect((await configState(world, 'db.pool_max')).value).toBe(10);
    });
  });
});
