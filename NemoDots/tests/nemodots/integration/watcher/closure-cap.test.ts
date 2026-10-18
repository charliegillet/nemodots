// The closure-cap path (ARCHITECTURE 5.2, finding C14): the capped closure does
// not make the source unobservable. The affected missions are paused, a coarse
// InvalidationEvent is recorded and the receipt is registered without a closure.
import { describe, expect, it } from 'vitest';
import {
  attemptStatus,
  headOf,
  injectorWrite,
  insertCommittedIntent,
  intentStatus,
  ledgerEvents,
  missionReading,
  missionStatus,
  receiptsOf,
  recoveryKinds,
  withWatcherEnv,
} from './harness.js';

const K = 'cache.namespace';
const member = (key: string) => `checkout.config/${key}`;

describe('closure cap exceeded', () => {
  it('pauses the missions, records a coarse event and still registers the receipt', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher({
        config: { closureLimits: { maxDepth: 64, maxNodes: 1 } },
      });
      await watcher.runCycle();
      await watcher.runCycle();
      const m1 = await missionReading(env, [[member(K)], [member(K)]]);
      const m2 = await missionReading(env, [[member(K)]]);
      const bystander = await missionReading(env, [[member('ui.banner_text')]]);
      // a live (proposed) intent of M1: part of the coarse set, blocked by the marks
      const proposed = await insertCommittedIntent(env, {
        mission: m1,
        attemptIndex: 0,
        key: K,
        value: 'catalog-b',
        status: 'proposed',
      });

      await injectorWrite(env, K, 'catalog-b');
      const cycle = await watcher.runCycle();

      const outcome = cycle.outcomes.find((o) => o.sourceKey === member(K));
      expect(outcome).toMatchObject({
        outcome: 'registered',
        revision: 2,
        closureCapped: true,
      });
      // the receipt is registered although the closure was refused
      const receipts = await receiptsOf(env, member(K));
      expect(receipts.map((r) => [r.revision, r.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      expect(env.events.filter((e) => e.type === 'closure_cap')).toEqual([
        {
          type: 'closure_cap',
          sourceKey: member(K),
          cap: 'nodes',
          missionIds: [m1.missionId, m2.missionId].sort(),
        },
      ]);

      // both missions that cite the old receipt are paused; the bystander runs
      expect([...env.paused].sort()).toEqual(
        [m1.missionId, m2.missionId].sort(),
      );
      expect(await missionStatus(env, m1.missionId)).toBe('paused');
      expect(await missionStatus(env, m2.missionId)).toBe('paused');
      expect(await missionStatus(env, bystander.missionId)).toBe('running');
      expect(await attemptStatus(env, bystander.attempts[0].attemptId)).toBe(
        'running',
      );

      // the coarse event: every live attempt and intent of the missions
      const [event] = await ledgerEvents(env, member(K));
      expect(event).toMatchObject({
        reason: 'closure_cap_exceeded',
        selfWrite: 'none',
        oldReceiptId: receipts[0].id,
        newReceiptId: receipts[1].id,
        closure: { depth: 0, nodes: 1, capped: true },
      });
      const byMission = new Map(event.perMission.map((p) => [p.missionId, p]));
      expect([...byMission.keys()].sort()).toEqual(
        [m1.missionId, m2.missionId].sort(),
      );
      expect(byMission.get(m1.missionId)?.affected).toEqual({
        modelCallIds: [],
        attemptIds: m1.attempts.map((a) => a.attemptId).sort(),
        outputIds: [],
        actionIds: [proposed],
        taskIds: m1.attempts.map((a) => a.taskId).sort(),
      });
      expect(byMission.get(m2.missionId)?.affected.attemptIds).toEqual([
        m2.attempts[0].attemptId,
      ]);
      expect(byMission.get(m1.missionId)?.preserved.taskIds).toEqual(
        [m1.plannerTaskId, ...m1.fillerTaskIds].sort(),
      );
      // the marks of the coarse set ran like a real closure's
      expect((await intentStatus(env, proposed)).status).toBe('blocked');

      // the coordinator received it and recorded the pause
      expect(await recoveryKinds(env, m1.missionId)).toContain(
        'mission_paused_closure_cap',
      );
      expect(await recoveryKinds(env, m2.missionId)).toContain(
        'mission_paused_closure_cap',
      );
      expect(await recoveryKinds(env, bystander.missionId)).toEqual([]);

      // the source stays observable: the next change registers again
      await injectorWrite(env, K, 'catalog-c');
      await watcher.runCycle();
      expect((await headOf(env, member(K))).revision).toBe(3);
    });
  });
});
