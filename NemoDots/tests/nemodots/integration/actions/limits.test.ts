// What the guarantee does NOT cover, written down as tests (TEST_PROMPT gate 2,
// last paragraph; ARCHITECTURE section 4 "Limits"), plus the exact freshness
// window of an observed source.
import { describe, expect, it } from 'vitest';
import {
  admitAndCommit,
  configState,
  observed,
  proposePool,
  scenario,
  withWorld,
} from './harness.js';

describe('outside the guarantee', () => {
  it('a change of an observed source that nobody observed is invisible: the commit rests on the old receipt', async () => {
    await withWorld(async (world) => {
      // The health receipt says "degraded". Suppose the real endpoint recovered
      // an instant ago: no observation was registered, so there is nothing for
      // G1 to compare. The property for observed sources is freshness at
      // admission (maxAgeMs), not currency.
      const s = await scenario(world);
      const proposed = await proposePool(world, s, 20);
      const { committed } = await admitAndCommit(world, proposed.id);
      expect(committed.status).toBe('committed');
      expect(await configState(world, 'db.pool_max')).toMatchObject({
        value: 20,
        version: 2,
        causedBy: proposed.id,
      });
    });
  });

  it('the evidence window is maxAgeMs of lastConfirmedAt: 119 s admits, 121 s does not', async () => {
    await withWorld(async (world) => {
      const inside = await scenario(world, { healthAgeMs: 119_000 });
      const first = await proposePool(world, inside, 20);
      const admitted = await world.service.admit(first.id, 'dispatcher-a');
      expect(admitted.status).toBe('admitted');
    });
    await withWorld(async (world) => {
      const outside = await scenario(world, { healthAgeMs: 121_000 });
      const second = await proposePool(world, outside, 20);
      const refused = await world.service.admit(second.id, 'dispatcher-a');
      expect(refused.blockReason).toBe('evidence_too_old');
    });
  });

  it('an old observation re-confirmed by the watcher is fresh again, with the same revision', async () => {
    await withWorld(async (world) => {
      const value = { status: 'degraded', checks: { postgres: true } };
      const aged = await observed(
        world,
        'checkout.health',
        value,
        new Date(Date.now() - 600_000),
      );
      const confirmed = await observed(world, 'checkout.health', value);
      expect(confirmed.id).toBe(aged.id);
      expect(confirmed.sourceRevision).toBe(aged.sourceRevision);
      expect(Date.parse(confirmed.lastConfirmedAt)).toBeGreaterThan(
        Date.now() - 5_000,
      );
      const s = await scenario(world, { health: confirmed });
      const proposed = await proposePool(world, s, 20);
      expect((await world.service.admit(proposed.id, 'd')).status).toBe(
        'admitted',
      );
    });
  });
});
