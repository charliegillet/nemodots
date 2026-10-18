// A crash (or a failure) between the registration's COMMIT and the delivery of
// its InvalidationEvent must not leave a mission waiting forever: the next poll
// delivers ledger events the coordinator has no copy of.
import { describe, expect, it } from 'vitest';
import {
  injectorWrite,
  ledgerEvents,
  missionReading,
  recoveryKinds,
  withWatcherEnv,
} from './harness.js';

const member = (key: string) => `checkout.config/${key}`;

describe('redelivery of undelivered invalidations', () => {
  it('delivers an event whose first delivery failed, once', async () => {
    await withWatcherEnv(async (env) => {
      const first = env.watcher({
        recovery: {
          ...env.recovery,
          async onInvalidation() {
            throw new Error('coordinator unavailable');
          },
        },
      });
      await first.runCycle();
      await first.runCycle();
      const mission = await missionReading(env, [
        [member('db.pool_max')],
        [member('ui.banner_text')],
      ]);

      await injectorWrite(env, 'db.pool_max', 13);
      await first.runCycle();
      const [event] = await ledgerEvents(env, member('db.pool_max'));
      expect(event.missionIds).toEqual([mission.missionId]);
      expect(
        env.events.some(
          (e) => e.type === 'error' && e.where === 'onInvalidation',
        ),
      ).toBe(true);
      const copies = () =>
        env.admin.query(
          'SELECT 1 FROM coordinator.invalidations WHERE event_id = $1',
          [event.id],
        );
      expect((await copies()).rows).toHaveLength(0);
      expect(await recoveryKinds(env, mission.missionId)).toEqual([]);

      // a healthy coordinator: the next poll finds and delivers it
      const second = env.watcher();
      const cycle = await second.runCycle();
      expect(cycle.redelivered).toEqual([event.id]);
      expect((await copies()).rows).toHaveLength(1);
      expect(await recoveryKinds(env, mission.missionId)).toContain(
        'repair_scheduled',
      );

      // delivered exactly once
      const again = await second.runCycle();
      expect(again.redelivered).toEqual([]);
    });
  });
});
