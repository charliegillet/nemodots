// The closure-cap path (ARCHITECTURE 5.2, finding C14): the capped closure does
// not make the source unobservable. The affected missions are paused, a coarse
// InvalidationEvent is recorded and the receipt is registered without a closure.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import { linkPublication } from '../../../../src/server/nemodots/ledger/index.js';
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
  taskStatus,
  withWatcherEnv,
  type FixtureMission,
  type WatcherEnv,
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

/** Attempt `index` of the mission has published an output that cites what it read. */
async function publishOutput(
  env: WatcherEnv,
  mission: FixtureMission,
  index: number,
): Promise<string> {
  const { taskId, attemptId } = mission.attempts[index];
  const outputId = randomUUID();
  await env.admin.query(
    `INSERT INTO coordinator.task_outputs
       (id, task_id, attempt_id, mission_id, kind, content, digest)
     VALUES ($1, $2, $3, $4, 'finding', '{"claim":"cache namespace is catalog-a"}'::jsonb, $5)`,
    [outputId, taskId, attemptId, mission.missionId, digest(outputId)],
  );
  await env.admin.query(
    `UPDATE coordinator.task_attempts SET status = 'published' WHERE id = $1`,
    [attemptId],
  );
  await env.admin.query(
    `UPDATE coordinator.tasks SET status = 'succeeded', output_id = $2 WHERE id = $1`,
    [taskId, outputId],
  );
  const client = await env.app.connect();
  try {
    await client.query('BEGIN');
    await linkPublication(client, {
      missionId: mission.missionId,
      taskId,
      attemptId,
      modelCallIds: [],
      outputId,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return outputId;
}

describe('closure cap exceeded: work that already published', () => {
  it('names the published reader, its output and its task in the coarse set instead of calling them preserved', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher({
        config: { closureLimits: { maxDepth: 64, maxNodes: 1 } },
      });
      await watcher.runCycle();
      await watcher.runCycle();
      // task A published a finding that rests on the receipt, task B still runs
      const mission = await missionReading(env, [[member(K)], [member(K)]]);
      const outputId = await publishOutput(env, mission, 0);
      expect(await taskStatus(env, mission.attempts[0].taskId)).toBe('succeeded');

      await injectorWrite(env, K, 'catalog-b');
      const cycle = await watcher.runCycle();
      expect(
        cycle.outcomes.find((o) => o.sourceKey === member(K)),
      ).toMatchObject({ outcome: 'registered', closureCapped: true });

      const [event] = await ledgerEvents(env, member(K));
      expect(event.closure.capped).toBe(true);
      const entry = event.perMission.find(
        (p) => p.missionId === mission.missionId,
      );
      expect(entry?.affected.attemptIds).toEqual(
        mission.attempts.map((a) => a.attemptId).sort(),
      );
      expect(entry?.affected.outputIds).toEqual([outputId]);
      expect(entry?.affected.taskIds).toEqual(
        mission.attempts.map((a) => a.taskId).sort(),
      );
      // the published task is NOT claimed to be preserved
      expect(entry?.preserved.taskIds).toEqual(
        [mission.plannerTaskId, ...mission.fillerTaskIds].sort(),
      );
      expect(entry?.preserved.taskIds).not.toContain(
        mission.attempts[0].taskId,
      );
      // and the marks ran: the output cannot be consumed once the mission resumes
      const output = await env.admin.query(
        'SELECT usable FROM coordinator.task_outputs WHERE id = $1',
        [outputId],
      );
      expect(output.rows[0].usable).toBe(false);
    });
  });
});
