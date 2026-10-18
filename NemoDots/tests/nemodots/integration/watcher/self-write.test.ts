// Self-writes are classified from the config_versions HISTORY (ARCHITECTURE
// 5.4, C7). The committing writes below use the app role, the only role whose
// caused_by_action_id survives the I14 trigger.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  ActionId,
  SourceKey,
} from '../../../../src/server/nemodots/contracts/index.js';
import { advanceConfigTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { attemptRow, recoveryKinds, taskRow } from '../coordinator/harness.js';
import {
  claimStart,
  plannedMission,
  receiptsOf,
  withWatcherEnv,
  type WatcherEnv,
} from './harness.js';

const KEY = 'cache.schema_version';
const SOURCE = `checkout.config/${KEY}` as SourceKey;

/** actor (cache_specialist) published its proposal; `other` is a running branch. */
async function lineage(env: WatcherEnv) {
  const { h } = env;
  const planned = await plannedMission(h, [
    { role: 'cache_specialist' },
    { role: 'investigator' },
    { role: 'investigator', dependsOn: [0] },
  ]);
  const [actorTask, otherTask] = planned.taskIds;
  const actor = await claimStart(h, { taskId: actorTask });
  const other = await claimStart(h, { taskId: otherTask });
  const receipt = await env.observeMember(planned.missionId, KEY);
  const link = (attemptId: string, taskId: string) =>
    env.link(receipt.receipt.id, {
      attemptId,
      taskId,
      missionId: planned.missionId,
    });
  await link(actor.context.attemptId, actorTask);
  await link(other.context.attemptId, otherTask);
  return { planned, actorTask, otherTask, actor, other, receipt };
}

async function commitAsAction(
  env: WatcherEnv,
  ctx: Awaited<ReturnType<typeof lineage>>,
  value: number,
  expectedVersion: number,
  expectedDigestOverride?: string,
) {
  const actionId = randomUUID() as ActionId;
  const result = await advanceConfigTx(env.h.pool, {
    key: KEY,
    value,
    expectedVersion,
    causedBy: { actor: 'action', actionId },
  });
  env.intents.add(
    actionId,
    ctx.planned.missionId,
    ctx.actorTask,
    ctx.actor.context.attemptId,
    SOURCE,
    expectedDigestOverride ?? result.afterDigest,
  );
  return { actionId, result };
}

it('a verified self-write settles the intent from history, stamps selfWrite:verified and routes the acting lineage to a postcondition while other branches are coalesced behind it', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const ctx = await lineage(env);
    // The actor's attempt has published (its proposal) before the commit lands.
    await h.coordinator.publishOutput(ctx.actor.context, {
      kind: 'handoff',
      content: { proposed: true },
      dependencyVector: [],
    });
    const { actionId } = await commitAsAction(env, ctx, 2, 1);

    const watcher = env.make();
    expect(await watcher.pass()).toMatchObject({ registered: 1, errors: 0 });

    // intent verified through the history walk
    expect(env.intents.settled).toMatchObject([
      { actionId, outcome: 'verified', reason: null, version: 2 },
    ]);
    expect(h.intents.intents.get(actionId)?.status).toBe('verified');
    expect(env.recovery.settlements).toEqual([
      { actionId, outcome: 'verified' },
    ]);
    // head receipt carries the self-write from the LAST row
    const receipts = await receiptsOf(h, SOURCE);
    expect(receipts.map((r) => [r.source_revision, r.status])).toEqual([
      [1, 'superseded'],
      [2, 'supported'],
    ]);
    expect(receipts[1]).toMatchObject({
      self_write: 'verified',
      caused_by_action_id: actionId,
    });
    expect(env.recovery.invalidations[0].selfWrite).toBe('verified');

    // exactly one postcondition task; the other branch is held behind it
    // (repair coalesced, not scheduled).
    const post = await h.admin.query(
      `SELECT id, repair FROM coordinator.tasks WHERE mission_id = $1 AND role = 'postcondition'`,
      [ctx.planned.missionId],
    );
    expect(post.rows).toHaveLength(1);
    expect(post.rows[0].repair.kind).toBe('postcondition');
    expect(['aborted', 'invalidated']).toContain(
      (await attemptRow(h, ctx.other.context.attemptId)).status,
    );
    expect((await taskRow(h, ctx.otherTask)).status).toBe('invalidated');
    const kinds = (await recoveryKinds(h, ctx.planned.missionId)).map(
      (r) => r.kind,
    );
    expect(kinds).toContain('postcondition_scheduled');
    expect(kinds).toContain('repair_coalesced');
    expect(kinds).not.toContain('repair_scheduled');
  });
});

it('a self-write whose after-digest does not match fails the intent (postcondition_mismatch) and invalidates everything', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const ctx = await lineage(env);
    const { actionId } = await commitAsAction(env, ctx, 2, 1, 'f'.repeat(64));

    await env.make().pass();

    expect(env.intents.settled).toMatchObject([
      { actionId, outcome: 'failed', reason: 'postcondition_mismatch' },
    ]);
    expect(h.intents.intents.get(actionId)?.status).toBe('failed');
    const head = (await receiptsOf(h, SOURCE)).at(-1)!;
    expect(head).toMatchObject({
      source_revision: 2,
      self_write: 'mismatch',
      caused_by_action_id: actionId,
    });
    const event = env.recovery.invalidations[0];
    expect(event.reason).toBe('self_write_mismatch');
    expect(event.selfWrite).toBe('mismatch');
    // full invalidation: the acting lineage is not excused
    expect([...event.affected.attemptIds].sort()).toEqual(
      [ctx.actor.context.attemptId, ctx.other.context.attemptId].sort(),
    );
    expect(
      (await recoveryKinds(h, ctx.planned.missionId)).map((r) => r.kind),
    ).not.toContain('postcondition_scheduled');
  });
});

it('C7: stopped watcher, action commits v1->v2, injector writes v2->v3, restart: revision 3 is registered with selfWrite none, the action row still settles verified and the invalidation covers the acting lineage too', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const ctx = await lineage(env);
    const first = env.make();
    expect(await first.pass()).toMatchObject({ registered: 0 });
    await first.stop();

    const { actionId } = await commitAsAction(env, ctx, 2, 1);
    await env.inject(KEY, 5);

    const restarted = env.make();
    expect(await restarted.pass()).toMatchObject({ registered: 1, errors: 0 });

    const receipts = await receiptsOf(h, SOURCE);
    expect(receipts.map((r) => [r.source_revision, r.status])).toEqual([
      [1, 'superseded'],
      [3, 'supported'],
    ]);
    expect(receipts[1]).toMatchObject({
      self_write: 'none',
      caused_by_action_id: null,
    });
    // X's own row matched: verified (the walk saw v2), but nothing is excused.
    expect(env.intents.settled).toMatchObject([
      { actionId, outcome: 'verified', version: 2 },
    ]);
    const event = env.recovery.invalidations[0];
    expect(event.selfWrite).toBe('none');
    expect([...event.affected.attemptIds].sort()).toEqual(
      [ctx.actor.context.attemptId, ctx.other.context.attemptId].sort(),
    );
    for (const attempt of [ctx.actor, ctx.other])
      expect((await attemptRow(h, attempt.context.attemptId)).status).not.toBe(
        'running',
      );
  });
});

it('a history row naming an unknown action excuses nothing and is logged', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const ctx = await lineage(env);
    const actionId = randomUUID() as ActionId;
    await advanceConfigTx(h.pool, {
      key: KEY,
      value: 2,
      expectedVersion: 1,
      causedBy: { actor: 'action', actionId },
    });
    await env.make().pass();
    expect(env.intents.settled).toEqual([]);
    expect(env.logs.some((l) => l.event === 'unknown_action')).toBe(true);
    expect((await receiptsOf(h, SOURCE)).at(-1)).toMatchObject({
      self_write: 'none',
      caused_by_action_id: null,
    });
    expect(env.recovery.invalidations[0].affected.attemptIds).toHaveLength(2);
    void ctx;
  });
});

it('an owner edit through the manual path registers immediately and never records the owner', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const ctx = await lineage(env);
    const { ownerEdit } =
      await import('../../../../src/server/nemodots/watcher/index.js');
    const watcher = env.make();
    const { change, observed } = await ownerEdit(
      { pool: h.pool, watcher },
      { key: KEY, value: 3, expectedVersion: 1 },
    );
    expect(change.versionAfter).toBe(2);
    expect(observed).toMatchObject({ registered: 1 });
    const head = (await receiptsOf(h, SOURCE)).at(-1)!;
    expect(head).toMatchObject({ source_revision: 2, self_write: 'none' });
    const history = await h.admin.query(
      `SELECT caused_by_actor FROM checkout.config_versions WHERE key = $1 AND version = 2`,
      [KEY],
    );
    expect(history.rows[0].caused_by_actor).toBe('owner');
    expect(JSON.stringify(env.recovery.invalidations)).not.toContain('"owner"');
    expect(env.recovery.invalidations[0].affected.attemptIds).toHaveLength(2);
    void ctx;
  });
});

// DEPENDENCY (ledger): ARCHITECTURE 5.4 says a verified self-write does not
// invalidate the acting lineage. The ledger closure still follows the actor's
// evidence edge, so this fails today. `it.fails` turns into a red test the day
// the ledger excuses the lineage: flip it to `it` then.
it.fails(
  'acting lineage keeps its output after a verified self-write',
  async () => {
    await withWatcherEnv(async (env) => {
      const { h } = env;
      const ctx = await lineage(env);
      await h.coordinator.publishOutput(ctx.actor.context, {
        kind: 'handoff',
        content: { proposed: true },
        dependencyVector: [],
      });
      await commitAsAction(env, ctx, 2, 1);
      await env.make().pass();
      expect((await taskRow(h, ctx.actorTask)).status).toBe('succeeded');
      expect((await taskRow(h, ctx.actorTask)).output_id).not.toBeNull();
    });
  },
);
