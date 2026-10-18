// wait_for_children releases the worker slot (real coordinator, real worker
// host). The handlers here are scripted coordinator calls, not the team: they
// do exactly what the team's wait_for_children tool does (markWaiting, then
// poll resumeFromWaiting inside helpers.parked), so what is under test is the
// host's slot accounting and the recovery path of a PARKED attempt. The team
// code on top of it is covered by tests/nemodots/integration/bootstrap/
// parked-chain.test.ts.
import { expect, it } from 'vitest';
import type {
  AttemptHandler,
  HandlerHelpers,
  HandlerOutcome,
  HostRun,
} from '../../../../src/server/nemodots/coordinator/index.js';
import type { ClaimedAttempt } from '../../../../src/server/nemodots/coordinator/types.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  attemptRow,
  invalidationFor,
  plannedMission,
  recoveryKinds,
  sleep,
  taskRow,
  vectorOf,
  withHarness,
  type Harness,
} from './harness.js';

type Slots = ReturnType<
  ReturnType<Harness['coordinator']['createWorkerHost']>['slots']
>;

const out = (who: string): HandlerOutcome => ({
  type: 'output',
  output: { kind: 'handoff', content: { by: who }, dependencyVector: [] },
});

/** What wait_for_children does: mark the task waiting, then poll while PARKED. */
async function waitForChildren(
  h: Harness,
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
) {
  await h.coordinator.markWaiting(claimed.context);
  await helpers.parked!(async () => {
    for (;;) {
      await helpers.checkpoint();
      const status = await h.coordinator.resumeFromWaiting(claimed.context);
      if (status.allTerminal) return;
      await sleep(15);
    }
  });
}

const delegate = (
  h: Harness,
  claimed: ClaimedAttempt,
  role: 'cache_specialist' | 'verifier',
  title: string,
) =>
  h.coordinator.delegate(claimed.context, {
    title,
    role,
    question: `${title}?`,
    dependsOn: [],
    justification: 'needs its own reading',
    dependencyVector: vectorOf([]),
  });

function hostFor(
  h: Harness,
  handler: AttemptHandler,
  concurrency: number,
  runs: HostRun[],
) {
  return h.coordinator.createWorkerHost({
    workerId: 'host-parked',
    handler,
    pollMs: 15,
    abortCheckMs: 40,
    concurrency,
    onRun: (run) => runs.push(run),
  });
}

const settled = async (runs: HostRun[], n: number, label: string) => {
  const deadline = Date.now() + 20_000;
  while (runs.length < n) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
};

it('a delegation chain of depth 3 completes on ONE worker slot; the leaf works while both ancestors are parked and hold nothing', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    const runs: HostRun[] = [];
    let atLeaf: Slots | null = null;
    const host: ReturnType<typeof hostFor> = hostFor(
      h,
      async (claimed, helpers) => {
        const role = claimed.context.role;
        if (claimed.task.title === 'task 0') {
          await delegate(h, claimed, 'cache_specialist', 'specialist');
          await waitForChildren(h, claimed, helpers);
        } else if (role === 'cache_specialist') {
          await delegate(h, claimed, 'verifier', 'verifier');
          await waitForChildren(h, claimed, helpers);
        } else if (role === 'verifier') {
          atLeaf = host.slots();
        }
        return out(`${role}:${claimed.task.title}`);
      },
      1,
      runs,
    );
    host.start();
    try {
      // root, specialist, verifier, then the dependent second root task
      await settled(runs, 4, 'the chain');
    } finally {
      await host.stop();
    }
    expect(runs.map((run) => run.result)).toEqual(Array(4).fill('published'));
    expect(atLeaf).toEqual({ capacity: 1, held: 1, parked: 2, attempts: 3 });
    const tasks = await h.admin.query(
      `SELECT title, role, status, parent_id FROM coordinator.tasks
        WHERE mission_id = $1 ORDER BY ordinal, created_at`,
      [planned.missionId],
    );
    expect(
      tasks.rows
        .filter((t) => t.role !== 'planner')
        .every((t) => t.status === 'succeeded'),
    ).toBe(true);
    expect(await taskRow(h, planned.taskIds[0])).toMatchObject({
      status: 'succeeded',
    });
  });
}, 60_000);

it('a parent that is waiting leaves the pool free: with one slot the child runs while the parent is parked, then the parent resumes', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    const runs: HostRun[] = [];
    const log: string[] = [];
    let whileChildRuns: Slots | null = null;
    const host: ReturnType<typeof hostFor> = hostFor(
      h,
      async (claimed, helpers) => {
        const title = claimed.task.title;
        log.push(`${title}:start`);
        if (title === 'task 0') {
          await delegate(h, claimed, 'verifier', 'child');
          await waitForChildren(h, claimed, helpers);
          log.push('task 0:resumed');
        }
        if (title === 'child') {
          whileChildRuns = host.slots();
        }
        return out(title);
      },
      1,
      runs,
    );
    host.start();
    try {
      await settled(runs, 3, 'parent, child and the sibling root task');
    } finally {
      await host.stop();
    }
    expect(whileChildRuns).toMatchObject({ held: 1, parked: 1 });
    expect(log).toEqual([
      'task 0:start',
      'child:start',
      'task 0:resumed',
      'task 1:start',
    ]);
    expect(await taskRow(h, planned.taskIds[0])).toMatchObject({
      status: 'succeeded',
    });
  });
}, 60_000);

it('a parked parent whose readset is invalidated while it waits is aborted and REPAIRED, never resumed with its old transcript', async () => {
  await withHarness(async (h) => {
    const planned = await plannedMission(h, [
      { role: 'investigator' },
      { role: 'investigator', dependsOn: [0] },
    ]);
    const parentTask = planned.taskIds[0];
    const runs: HostRun[] = [];
    const childRunning = latch();
    const childRelease = latch();
    const parkedHandlerEnded = latch<string>();
    let slotsWhileChildRuns: Slots | null = null;
    const kinds: string[] = [];
    const host: ReturnType<typeof hostFor> = hostFor(
      h,
      async (claimed, helpers) => {
        const title = claimed.task.title;
        if (title === 'task 0') {
          kinds.push(claimed.attempt.kind);
          if (claimed.attempt.kind === 'repair') return out('repaired parent');
          await delegate(h, claimed, 'verifier', 'child');
          try {
            await waitForChildren(h, claimed, helpers);
          } catch (error) {
            parkedHandlerEnded.open(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
          // reaching here would be a resume on the OLD attempt
          parkedHandlerEnded.open('resumed');
          return out('stale parent');
        }
        if (title === 'child') {
          slotsWhileChildRuns = host.slots();
          childRunning.open();
          await childRelease.promise;
        }
        return out(title);
      },
      1,
      runs,
    );
    host.start();
    try {
      await withTimeout(childRunning.promise, 10_000, 'the child to start');
      // the only slot is the child's; the parent is parked and holds none
      expect(slotsWhileChildRuns).toMatchObject({ held: 1, parked: 1 });
      expect((await taskRow(h, parentTask)).status).toBe('waiting');
      const [parentAttempt] = (
        await h.admin.query(
          `SELECT id FROM coordinator.task_attempts WHERE task_id = $1 AND status = 'running'`,
          [parentTask],
        )
      ).rows;

      // what the ledger closure hands recovery for a source the parent read
      await h.coordinator.onInvalidation(
        invalidationFor({
          missionId: planned.missionId,
          attemptIds: [parentAttempt.id],
          taskIds: [parentTask],
        }),
      );
      const ended = await withTimeout(
        parkedHandlerEnded.promise,
        5_000,
        'the parked handler to be told',
      );
      // the wait loop was cut by the abort (its checkpoint) or by the fence
      // (its next resumeFromWaiting): either way it did not resume
      expect(ended).toMatch(/attempt aborted|fence rejected/);
      expect(await recoveryKinds(h, planned.missionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'repair_scheduled' }),
        ]),
      );
      expect((await attemptRow(h, parentAttempt.id)).status).not.toBe(
        'running',
      );
      await settled(runs, 1, 'the host to record the aborted parent');
      expect(runs.find((run) => run.taskId === parentTask)).toMatchObject({
        result: 'aborted',
      });
      // nothing the stale attempt produced was published
      expect(
        (
          await h.admin.query(
            `SELECT 1 FROM coordinator.task_outputs WHERE attempt_id = $1`,
            [parentAttempt.id],
          )
        ).rowCount,
      ).toBe(0);

      childRelease.open();
      // child, then the REPAIR attempt of the parent, then the dependent task
      await settled(runs, 4, 'child, parent repair and the dependent task');
    } finally {
      childRelease.open();
      await host.stop();
    }
    expect(kinds).toEqual(['initial', 'repair']);
    const attempts = await h.admin.query(
      `SELECT n, kind, status FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n`,
      [parentTask],
    );
    expect(attempts.rows[0].n).toBe(1);
    expect(attempts.rows[0].status).not.toBe('published');
    expect(attempts.rows.at(-1)).toMatchObject({
      kind: 'repair',
      status: 'published',
    });
    expect((await taskRow(h, parentTask)).status).toBe('succeeded');
  });
}, 60_000);
