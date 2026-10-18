// RecoveryScopeRule (contracts/ports.ts, finding D8): the rule changes ONLY
// which tasks an invalidation restarts. Everything else is the same code for
// every rule. The rule is chosen per mission at creation by the server.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCoordinator } from '../../../../src/server/nemodots/coordinator/index.js';
import type {
  RecoveryScopeRule,
  TaskId,
} from '../../../../src/server/nemodots/contracts/index.js';
import {
  claimStart,
  count,
  invalidationFor,
  recoveryKinds,
  taskRow,
  withHarness,
  type Harness,
} from './harness.js';

const ROLES = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

const seen: Parameters<RecoveryScopeRule['select']>[0][] = [];
/** Broad restart: every non-planner task that is running or finished. */
const broad: RecoveryScopeRule = {
  name: 'broad-restart',
  select: (input) => {
    seen.push(input);
    return {
      restartTaskIds: input.tasks
        .filter(
          (task) =>
            task.role !== 'planner' &&
            task.role !== 'postcondition' &&
            ['running', 'waiting', 'succeeded'].includes(task.status),
        )
        .map((task) => task.id),
    };
  },
};
const none: RecoveryScopeRule = {
  name: 'nothing',
  select: () => ({ restartTaskIds: [] }),
};

function register(h: Harness) {
  h.coordinator.deps.recoveryScopeRules = {
    'broad-restart': broad,
    nothing: none,
    // the built-in cannot be replaced
    selective: none,
  };
}

/** plannedMission with a server-side recovery scope rule. */
async function planned(h: Harness, rule?: string) {
  register(h);
  const mission = await h.coordinator.control.create(
    { goal: 'restore the checkout' },
    rule ? { recoveryScopeRule: rule } : undefined,
  );
  await h.coordinator.control.start(mission.id);
  const planner = await h.coordinator.claimAttempt({
    workerId: 'planner-worker',
    missionId: mission.id,
  });
  await h.coordinator.startAttempt(planner!.context);
  const published = await h.coordinator.publishPlan(planner!.context, {
    plan: {
      tasks: ROLES.map((task, i) => ({
        title: `task ${i}`,
        question: `question ${i}`,
        role: task.role,
        capabilities: [],
        dependsOn: [],
      })),
    },
    createdByModelCallId: randomUUID() as never,
  });
  return { missionId: mission.id, taskIds: published.taskIds as TaskId[] };
}

async function run(
  h: Harness,
  rule: string | undefined,
  options: { selfWrite?: 'verified' } = {},
) {
  const p = await planned(h, rule);
  const [a, b, c] = p.taskIds;
  const attempts = {
    a: await claimStart(h, { taskId: a }),
    b: await claimStart(h, { taskId: b }),
    c: await claimStart(h, { taskId: c }),
  };
  await h.coordinator.onInvalidation(
    invalidationFor({
      missionId: p.missionId,
      attemptIds: [attempts.a.context.attemptId],
      taskIds: [a],
      selfWrite: options.selfWrite ?? 'none',
      preserved: [b, c],
    }),
  );
  return { ...p, a, b, c, attempts };
}

const ruleOf = async (h: Harness, missionId: string) =>
  (
    await h.admin.query(
      'SELECT recovery_scope_rule FROM coordinator.missions WHERE id = $1',
      [missionId],
    )
  ).rows[0].recovery_scope_rule as string;

it('the default is selective: only the closure is restarted, the rest is preserved, and the mission records "selective"', async () => {
  await withHarness(async (h) => {
    const r = await run(h, undefined);
    expect(await ruleOf(h, r.missionId)).toBe('selective');
    expect((await taskRow(h, r.a)).status).toBe('runnable');
    expect((await taskRow(h, r.b)).status).toBe('running');
    expect((await taskRow(h, r.c)).status).toBe('running');
    const kinds = (await recoveryKinds(h, r.missionId)).map((k) => k.kind);
    expect(kinds.filter((k) => k === 'repair_scheduled')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'branch_preserved')).toHaveLength(2);
  });
});

it('"selective" is built in: a registry entry of that name cannot replace it', async () => {
  await withHarness(async (h) => {
    const r = await run(h, 'selective'); // registry maps `selective` to the empty rule
    expect((await taskRow(h, r.a)).status).toBe('runnable');
    expect((await taskRow(h, r.b)).status).toBe('running');
  });
});

it('a broad rule changes only the scope: every running task is aborted and repaired, a replan follows, nothing is preserved, the rule is recorded', async () => {
  await withHarness(async (h) => {
    seen.length = 0;
    const r = await run(h, 'broad-restart');
    expect(await ruleOf(h, r.missionId)).toBe('broad-restart');
    for (const id of [r.a, r.b, r.c])
      expect((await taskRow(h, id)).status).toBe('runnable');
    const aborted = await h.admin.query(
      `SELECT id FROM coordinator.task_attempts WHERE status = 'aborted' AND id = ANY($1::uuid[])`,
      [[r.attempts.b.context.attemptId, r.attempts.c.context.attemptId]],
    );
    expect(aborted.rows).toHaveLength(2);
    const kinds = (await recoveryKinds(h, r.missionId)).map((k) => k.kind);
    expect(kinds.filter((k) => k === 'repair_scheduled')).toHaveLength(3);
    expect(kinds).toContain('replan_scheduled');
    expect(kinds).not.toContain('branch_preserved');
    // the same contract input every rule gets
    expect(seen).toHaveLength(1);
    expect(seen[0].closureTaskIds).toEqual([r.a]);
    expect(seen[0].directReaderTaskIds).toEqual([]); // the test event names no receipt edge
    expect(seen[0].tasks).toHaveLength(4);
    expect(seen[0].tasks.find((t) => t.id === r.a)).toMatchObject({
      role: 'investigator',
      status: 'running',
      parentId: null,
    });
    const repair = await claimStart(h, { taskId: r.b });
    expect(repair.attempt.kind).toBe('repair');
  });
});

it('a custom rule still gets held-gate coalescing and the held replan: behind a verified self-write every restarted task waits behind one postcondition', async () => {
  await withHarness(async (h) => {
    const r = await run(h, 'broad-restart', { selfWrite: 'verified' });
    expect(await count(h, 'coordinator.tasks', "role = 'postcondition'")).toBe(
      1,
    );
    for (const id of [r.a, r.b, r.c])
      expect((await taskRow(h, id)).status).toBe('invalidated');
    const kinds = (await recoveryKinds(h, r.missionId)).map((k) => k.kind);
    expect(kinds.filter((k) => k === 'repair_coalesced')).toHaveLength(3);
    expect(kinds).toContain('replan_coalesced');
    expect(kinds).not.toContain('replan_scheduled');
    expect(kinds).not.toContain('repair_scheduled');
  });
});

it('a rule may restart nothing: the affected tasks are then only recorded as preserved', async () => {
  await withHarness(async (h) => {
    const r = await run(h, 'nothing');
    expect((await taskRow(h, r.a)).status).toBe('running');
    expect(
      (await recoveryKinds(h, r.missionId)).map((k) => k.kind),
    ).not.toContain('repair_scheduled');
  });
});

it('an unknown rule name fails mission creation and writes nothing; the HTTP-shaped request cannot carry one', async () => {
  await withHarness(async (h) => {
    register(h);
    const before = await count(h, 'coordinator.missions');
    await expect(
      h.coordinator.control.create(
        { goal: 'x' },
        { recoveryScopeRule: 'bogus' },
      ),
    ).rejects.toMatchObject({ name: 'UnknownScopeRuleError' });
    expect(await count(h, 'coordinator.missions')).toBe(before);
    // the request body is a strict schema: a smuggled field is rejected
    await expect(
      h.coordinator.control.create({
        goal: 'x',
        recoveryScopeRule: 'broad-restart',
      } as never),
    ).rejects.toThrow();
    expect(await count(h, 'coordinator.missions')).toBe(before);
  });
});

/** A second coordinator (another process) over the same database with its own registry. */
function otherProcess(h: Harness, rules: Record<string, RecoveryScopeRule>) {
  return createCoordinator({
    ...h.coordinator.deps,
    recoveryScopeRules: rules,
  } as never);
}

const broadElsewhere: RecoveryScopeRule = {
  name: 'broad-restart',
  select: (input) => ({
    restartTaskIds: input.tasks
      .filter(
        (task) =>
          task.role === 'investigator' &&
          ['running', 'waiting', 'succeeded'].includes(task.status),
      )
      .map((task) => task.id),
  }),
};

async function stage(h: Harness, rule?: string) {
  const p = await planned(h, rule);
  const [a, b, c] = p.taskIds;
  const attempts = {
    a: await claimStart(h, { taskId: a }),
    b: await claimStart(h, { taskId: b }),
    c: await claimStart(h, { taskId: c }),
  };
  const event = invalidationFor({
    missionId: p.missionId,
    attemptIds: [attempts.a.context.attemptId],
    taskIds: [a],
    preserved: [b, c],
  });
  return { ...p, a, b, c, event };
}

it('two processes with different registries agree: the rule comes from the mission row, so a process whose registry holds its own "broad-restart" restarts exactly what the creator would', async () => {
  await withHarness(async (h) => {
    const r = await stage(h, 'broad-restart');
    const processB = otherProcess(h, { 'broad-restart': broadElsewhere });
    await processB.recovery.onInvalidation(r.event);
    for (const id of [r.a, r.b, r.c])
      expect((await taskRow(h, id)).status).toBe('runnable');
    // and a mission stamped "selective" is selective in every process, whatever its registry holds
    const s = await stage(h, undefined);
    await processB.recovery.onInvalidation(s.event);
    expect((await taskRow(h, s.a)).status).toBe('runnable');
    expect((await taskRow(h, s.b)).status).toBe('running');
    expect(await ruleOf(h, s.missionId)).toBe('selective');
  });
});

it("a process that does not know the mission's rule fails closed: the mission is paused with an explicit reason, nothing restarts, no fallback to selective; a process that knows it processes the event afterwards", async () => {
  await withHarness(async (h) => {
    const r = await stage(h, 'broad-restart');
    const stranger = otherProcess(h, {});
    await stranger.recovery.onInvalidation(r.event);
    const mission = (
      await h.admin.query(
        'SELECT status FROM coordinator.missions WHERE id = $1',
        [r.missionId],
      )
    ).rows[0];
    expect(mission.status).toBe('paused');
    const reasons = await h.admin.query(
      `SELECT payload ->> 'reason' AS reason FROM coordinator.events
        WHERE mission_id = $1 AND kind = 'mission.status' ORDER BY id`,
      [r.missionId],
    );
    expect(reasons.rows.map((x) => x.reason)).toContain(
      'recovery_scope_rule_unregistered: broad-restart',
    );
    // nothing ran under another arm
    expect((await recoveryKinds(h, r.missionId)).map((k) => k.kind)).toEqual(
      [],
    );
    const pending = await h.admin.query(
      'SELECT processed_at FROM coordinator.invalidations WHERE mission_id = $1',
      [r.missionId],
    );
    expect(pending.rows[0].processed_at).toBeNull();
    // the harness coordinator knows the rule: its sweep processes the event
    await h.coordinator.recovery.sweep();
    const processed = await h.admin.query(
      'SELECT processed_at FROM coordinator.invalidations WHERE mission_id = $1',
      [r.missionId],
    );
    expect(processed.rows[0].processed_at).not.toBeNull();
    // The broad rule (not selective) decided: the pause had already queued
    // every task as runnable, which this rule does not restart, so the event
    // records NO repair for the affected task (selective would have coalesced
    // task a) and records the others as preserved.
    const kinds = (await recoveryKinds(h, r.missionId)).map((k) => k.kind);
    expect(kinds).not.toContain('repair_coalesced');
    expect(kinds).not.toContain('repair_scheduled');
    expect(kinds).toContain('branch_preserved');
  });
});
