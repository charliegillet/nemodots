// Verified self-writes (ARCHITECTURE 5.4): the acting lineage of the action
// that wrote the new revision is excluded from the closure; every other
// branch is still invalidated. The marker is only honoured when the version
// history (written by nemodots_app alone) agrees; a forged one leaves the
// closure full. Real default schemas: checkout.*, coordinator.* and 0005.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addEdges,
  linkPublication,
} from '../../../../src/server/nemodots/ledger/index.js';
import {
  advanceConfigTx,
  advanceConfigUnconditionallyTx,
} from '../../../../src/server/nemodots/sandbox/version-authority.js';
import {
  inTx,
  newScope,
  registerReal,
  sourceRef,
  useLedgerDb,
} from './fixtures.js';

const getDb = useLedgerDb();

async function build() {
  const { admin, app } = getDb();
  const scope = newScope();
  const key = `ledger.sw_${randomUUID().slice(0, 8)}`;
  await admin.query(
    `INSERT INTO checkout.config_entries (key, value, version, caused_by_actor) VALUES ($1, '3'::jsonb, 1, 'seed')`,
    [key],
  );
  await admin.query(
    `INSERT INTO checkout.config_versions (key, version, value, after_digest, caused_by_actor, at)
     VALUES ($1, 1, '3'::jsonb, repeat('a', 64), 'seed', now())`,
    [key],
  );
  await admin.query(
    'UPDATE checkout.config_collection SET version = version + 1',
  );
  const missionId = scope.missionId;
  await admin.query(
    `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
     VALUES ($1, $2, 'test', 'checkout', 'self write', 'fixture', 'running', '{}'::jsonb, '{}'::jsonb)`,
    [missionId, scope.ownerId],
  );
  const [actorTask, otherTask] = [randomUUID(), randomUUID()];
  const [actorAttempt, otherAttempt] = [randomUUID(), randomUUID()];
  const output = randomUUID();
  for (const [i, id] of [actorTask, otherTask].entries())
    await admin.query(
      `INSERT INTO coordinator.tasks (id, mission_id, depth, ordinal, title, question, role, status, generation, budget)
       VALUES ($1, $2, 0, $3, 't', 'q', 'investigator', 'running', 0, '{}'::jsonb)`,
      [id, missionId, i],
    );
  for (const [id, taskId] of [
    [actorAttempt, actorTask],
    [otherAttempt, otherTask],
  ])
    await admin.query(
      `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner,
                                              fencing_token, lease_expires_at, lease_renewed_at)
       VALUES ($1, $2, $3, 1, 'initial', 'running', 0, 'w', 1, now() + interval '1 hour', now())`,
      [id, taskId, missionId],
    );
  await admin.query(
    `INSERT INTO coordinator.task_outputs (id, task_id, attempt_id, mission_id, kind, content, digest)
     VALUES ($1, $2, $3, $4, 'handoff', '{}'::jsonb, repeat('b', 64))`,
    [output, actorTask, actorAttempt, missionId],
  );
  const member = (
    await inTx(app, (client) =>
      registerReal(client, {
        source: sourceRef(scope, `checkout.config/${key}`),
        normalizedValue: { key, value: 3, version: 1 },
        provenance: { kind: 'watcher' },
      }),
    )
  ).receipt;
  const actionId = randomUUID();
  const node = (id: string, taskId: string) => ({
    kind: 'attempt' as const,
    id,
    missionId,
    taskId,
  });
  await inTx(app, (client) =>
    addEdges(client, [
      {
        kind: 'evidence',
        from: { kind: 'receipt', id: member.id },
        to: node(actorAttempt, actorTask),
      },
      {
        kind: 'evidence',
        from: { kind: 'receipt', id: member.id },
        to: node(otherAttempt, otherTask),
      },
      {
        kind: 'evidence',
        from: node(actorAttempt, actorTask),
        to: { kind: 'task_output', id: output, missionId, taskId: actorTask },
      },
    ]),
  );
  // the actor's proposal joins the graph exactly as propose() does it
  await inTx(app, (client) =>
    linkPublication(client, {
      missionId,
      taskId: actorTask,
      attemptId: actorAttempt,
      modelCallIds: [],
      actionId,
    }),
  );
  return {
    scope,
    key,
    member,
    actionId,
    actorTask,
    otherTask,
    actorAttempt,
    otherAttempt,
    output,
  };
}

type World = Awaited<ReturnType<typeof build>>;

const register = (
  w: World,
  value: number,
  version: number,
  claim: {
    selfWrite: 'verified' | 'mismatch' | 'none';
    actionId: string | null;
  },
) =>
  inTx(getDb().app, (client) =>
    registerReal(client, {
      source: sourceRef(w.scope, `checkout.config/${w.key}`),
      normalizedValue: { key: w.key, value, version },
      provenance: {
        kind: 'watcher',
        selfWrite: claim.selfWrite,
        causedByActionId: claim.actionId as never,
      },
    }),
  );

const status = async (table: string, id: string, column = 'status') =>
  (
    await getDb().admin.query(
      `SELECT ${column} AS v FROM coordinator.${table} WHERE id = $1`,
      [id],
    )
  ).rows[0].v;

describe('verified self-write', () => {
  it('excludes the acting lineage from the closure and invalidates every other branch', async () => {
    const w = await build();
    await advanceConfigTx(getDb().app, {
      key: w.key,
      value: 4,
      expectedVersion: 1,
      causedBy: { actor: 'action', actionId: w.actionId },
    });
    const result = await register(w, 4, 2, {
      selfWrite: 'verified',
      actionId: w.actionId,
    });
    const event = result.invalidation!;
    expect(event.selfWrite).toBe('verified');
    expect(event.affected.attemptIds).toEqual([w.otherAttempt]);
    expect(event.affected.taskIds).toEqual([w.otherTask]);
    expect(event.affected.outputIds).toEqual([]);
    expect(event.affected.actionIds).toEqual([]);
    expect(event.perMission[0].preserved.taskIds).toContain(w.actorTask);
    expect(result.marks).toMatchObject({
      attemptsInvalidated: [w.otherAttempt],
      outputsUnusable: [],
    });
    expect(await status('task_attempts', w.actorAttempt)).toBe('running');
    expect(await status('task_attempts', w.otherAttempt)).toBe('invalidated');
    expect(await status('tasks', w.actorTask)).toBe('running');
    expect(await status('tasks', w.otherTask)).toBe('invalidated');
    expect(await status('task_outputs', w.output, 'usable')).toBe(true);
  });

  it('a mismatch or an unmarked write keeps the full closure', async () => {
    for (const claim of [
      { selfWrite: 'mismatch' as const, actionId: 'self' },
      { selfWrite: 'none' as const, actionId: null },
    ]) {
      const w = await build();
      await advanceConfigTx(getDb().app, {
        key: w.key,
        value: 4,
        expectedVersion: 1,
        causedBy: { actor: 'action', actionId: w.actionId },
      });
      const result = await register(w, 4, 2, {
        selfWrite: claim.selfWrite,
        actionId: claim.actionId === 'self' ? w.actionId : null,
      });
      expect([...result.invalidation!.affected.attemptIds].sort()).toEqual(
        [w.actorAttempt, w.otherAttempt].sort(),
      );
      expect(await status('task_outputs', w.output, 'usable')).toBe(false);
    }
  });

  it('a forged marker is not honoured: written by a non-app role the history carries no action, the closure stays full', async () => {
    const w = await build();
    // the injector-style write names the action, the trigger nulls it
    await advanceConfigUnconditionallyTx(getDb().admin, {
      key: w.key,
      value: 4,
      causedBy: { actor: 'injector', actionId: w.actionId },
    });
    const history = await getDb().admin.query(
      'SELECT caused_by_action_id FROM checkout.config_versions WHERE key = $1 AND version = 2',
      [w.key],
    );
    expect(history.rows[0].caused_by_action_id).toBeNull();
    const result = await register(w, 4, 2, {
      selfWrite: 'verified',
      actionId: w.actionId,
    });
    expect([...result.invalidation!.affected.attemptIds].sort()).toEqual(
      [w.actorAttempt, w.otherAttempt].sort(),
    );
    expect(result.invalidation!.affected.outputIds).toEqual([w.output]);
    expect(await status('task_attempts', w.actorAttempt)).toBe('invalidated');
    expect(await status('task_outputs', w.output, 'usable')).toBe(false);
  });

  it('a marker naming a different action than the one that wrote the row excuses nothing', async () => {
    const w = await build();
    await advanceConfigTx(getDb().app, {
      key: w.key,
      value: 4,
      expectedVersion: 1,
      causedBy: { actor: 'action', actionId: randomUUID() },
    });
    const result = await register(w, 4, 2, {
      selfWrite: 'verified',
      actionId: w.actionId,
    });
    expect(result.invalidation!.affected.attemptIds).toHaveLength(2);
  });
});
