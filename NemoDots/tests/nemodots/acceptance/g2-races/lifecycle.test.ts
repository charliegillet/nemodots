// TEST_PROMPT gate 2 cases 13, 14, 16 and the documented limits of the guarantee.
// Compensation, cancellation (through the real MissionControlPort), the
// self-write marker and what the guarantee does NOT cover.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import {
  delegate,
  publishOutput,
} from '../../../../src/server/nemodots/coordinator/publish.js';
import { advanceConfig } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { ADMISSION_CASES, type AdmissionOutcome } from '../oracle/admission.js';
import { SELF_WRITE_CASES } from '../oracle/closures.js';
import {
  ORDERS,
  POOL,
  TIMEOUT,
  authSummary,
  checkOutcome,
  commitSettled,
  expectNoReplanStorm,
  errText,
  isSettled,
  sleep,
  withWorld,
  type Att,
  type Rec,
  type World,
} from './harness.js';

const fence = (i: { dispatch: { fence: number } | null }) => i.dispatch!.fence;
const NONE = { need: [] as never[] };
const settle = async (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: v }),
    (e) => ({ err: e as unknown }),
  );

/** A new proposer that has read the CURRENT receipts (after the watcher or a registration moved them). */
async function currentReader(w: World, labels: string[]): Promise<Att> {
  for (const l of labels) if (l.startsWith('member:')) await w.refresh(l);
  return w.newAttempt('database_specialist', { reads: labels });
}

const attemptStatus = async (w: World, id: string) =>
  (
    await w.admin.query(
      'SELECT status FROM coordinator.task_attempts WHERE id=$1',
      [id],
    )
  ).rows[0].status as string;
const taskStatusOf = async (w: World, attemptId: string) =>
  (
    await w.admin.query(
      `SELECT t.status FROM coordinator.tasks t JOIN coordinator.task_attempts a ON a.task_id=t.id WHERE a.id=$1`,
      [attemptId],
    )
  ).rows[0].status as string;
const recoveryCounts = async (w: World) =>
  Object.fromEntries(
    (
      await w.admin.query(
        `SELECT kind, count(*)::int n FROM coordinator.recovery_events WHERE mission_id=$1 GROUP BY kind ORDER BY kind`,
        [w.mission],
      )
    ).rows.map((r) => [r.kind as string, r.n as number]),
  );
function oracleOutcome(id: string): AdmissionOutcome {
  const c = ADMISSION_CASES.find((x) => x.id === id);
  if (!c || 'anyOf' in c.expected)
    throw new Error(`oracle case ${id} is missing or has alternatives`);
  return c.expected;
}
const swExpected = (id: string) => {
  const c = SELF_WRITE_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`oracle case ${id} not found`);
  return c.expected;
};
/**
 * The recovery ROUTING decisions recorded for the mission. The oracle's
 * recoveryKinds lists routing outcomes; bookkeeping kinds (attempt_aborted,
 * intent_blocked, branch_preserved, invalidation_resolved) are not decisions.
 */
const ROUTING_KINDS = [
  'repair_scheduled',
  'replan_scheduled',
  'replan_coalesced',
  'postcondition_scheduled',
  'repair_coalesced',
];
/** The replan_* recovery rows of the mission, oldest first. */
const replanRows = async (w: World) =>
  (
    await w.admin.query(
      `SELECT kind, invalidation_event_id, detail FROM coordinator.recovery_events
        WHERE mission_id=$1 AND kind IN ('replan_scheduled','replan_coalesced')
        ORDER BY created_at, id`,
      [w.mission],
    )
  ).rows as { kind: string; invalidation_event_id: string; detail: string }[];
/** Root tasks (not planner/postcondition) in the mission's subset of an invalidation. */
const affectedRoots = async (w: World, eventId: string) => {
  const row = (
    await w.admin.query(
      'SELECT event FROM coordinator.invalidations WHERE mission_id=$1 AND event_id=$2',
      [w.mission, eventId],
    )
  ).rows[0];
  const taskIds = (row?.event?.affected?.taskIds ?? []) as string[];
  const roots = await w.admin.query(
    `SELECT id FROM coordinator.tasks WHERE id = ANY($1::uuid[])
        AND parent_id IS NULL AND role NOT IN ('planner','postcondition')`,
    [taskIds],
  );
  return { taskIds, roots: roots.rows.map((r) => r.id as string).sort() };
};
const routingKinds = async (w: World) =>
  (
    await w.admin.query(
      `SELECT DISTINCT kind FROM coordinator.recovery_events
        WHERE mission_id=$1 AND kind = ANY($2::text[]) ORDER BY kind`,
      [w.mission, ROUTING_KINDS],
    )
  ).rows.map((r) => r.kind as string);
const maxRepairAttemptsPerTask = async (w: World) =>
  (
    await w.admin.query(
      `SELECT COALESCE(max(n), 0)::int AS n FROM (
         SELECT count(*) AS n FROM coordinator.task_attempts
          WHERE mission_id=$1 AND kind='repair' GROUP BY task_id) x`,
      [w.mission],
    )
  ).rows[0].n as number;
const postconditionCount = async (w: World) =>
  (
    await w.admin.query(
      `SELECT (SELECT count(*)::int FROM coordinator.tasks WHERE mission_id=$1 AND role='postcondition')
            + (SELECT count(*)::int FROM coordinator.task_attempts a JOIN coordinator.tasks t ON t.id=a.task_id
                WHERE a.mission_id=$1 AND a.kind='postcondition' AND t.role <> 'postcondition') AS n`,
      [w.mission],
    )
  ).rows[0].n as number;

/**
 * A task counts as invalidated when one of its attempts was moved to
 * `invalidated`. The task row itself may already be `runnable` again because
 * recovery requeued it for repair.
 */
const taskInvalidated = async (w: World, taskId: string) =>
  (
    await w.admin.query(
      "SELECT count(*)::int AS n FROM coordinator.task_attempts WHERE task_id=$1 AND status='invalidated'",
      [taskId],
    )
  ).rows[0].n > 0;

/**
 * The SW oracle's lineage: T_parent (an investigator that read r1) delegates
 * T_act (a database_specialist, which keeps propose_config_change under rev3
 * D5, contracts/task.ts#allowedCapabilities) through the real coordinator
 * delegate(). T_act proposes and admits X. T_other is an unrelated reader of r1.
 */
async function swLineage(w: World) {
  const parent = await w.newAttempt('investigator', {
    reads: ['member:db.pool_max', 'health'],
  });
  await w.modelCallFor(parent, 'tc-del');
  const { taskId: actTask } = await delegate(w.deps, parent.ctx, {
    title: 'g2 acting child',
    role: 'database_specialist',
    question: 'g2 acting question',
    dependsOn: [],
    justification: 'the investigator cannot propose',
    dependencyVector: w.vector(['member:db.pool_max', 'health']),
    toolCallId: 'tc-del',
  });
  const act = await w.claim('database_specialist');
  if (!act || act.ctx.taskId !== actTask)
    throw new Error('the delegated acting task could not be claimed');
  const other = await w.newAttempt('investigator', {
    reads: ['member:db.pool_max'],
  });
  const x = await w.proposeAdmit({ ...w.poolSpec('tc-1'), att: act });
  expect(
    x.status,
    `the acting proposal must be admitted (${x.blockReason ?? ''})`,
  ).toBe('admitted');
  return { lineage: [parent.ctx.taskId, act.ctx.taskId], other, x };
}

/** Every SW-* expectation against the authoritative rows. */
async function expectSw(
  w: World,
  id: 'SW-1' | 'SW-2' | 'SW-3',
  run: { lineage: string[]; other: Att; x: { id: string } },
) {
  const exp = swExpected(id);
  const head = await w.headReceipt(`checkout.config/${POOL}`);
  expect(head!.provenance.selfWrite, `${id} head selfWrite`).toBe(
    exp.headSelfWrite,
  );
  const row = await w.intent(run.x.id);
  expect(row.status, `${id} X status`).toBe(exp.intentOutcome.X.status);
  if (exp.intentOutcome.X.failureReason)
    expect(row.failure_reason, `${id} X failure reason`).toBe(
      exp.intentOutcome.X.failureReason,
    );
  const lineage = await Promise.all(
    run.lineage.map(async (t, n) => [
      n === 0 ? 'T_parent' : 'T_act',
      await taskInvalidated(w, t),
    ]),
  );
  expect(lineage, `${id} acting lineage invalidated`).toEqual(
    lineage.map(([name]) => [name, exp.actingLineageInvalidated]),
  );
  expect(
    await taskInvalidated(w, run.other.ctx.taskId),
    `${id} other reader invalidated`,
  ).toBe(exp.otherReadersInvalidated);
  expect(await postconditionCount(w), `${id} postconditions`).toBe(
    exp.postconditionAttempts,
  );
  await expectNoReplanStorm(w);
  expect(await routingKinds(w), `${id} routing kinds`).toEqual(
    [...exp.recoveryKinds].sort(),
  );
  expect(await maxRepairAttemptsPerTask(w)).toBeLessThanOrEqual(
    exp.maxRepairAttemptsPerTask,
  );
}

/** The mission's planner task and its latest attempt. */
const plannerOf = async (w: World) => {
  const row = (
    await w.admin.query(
      `SELECT t.id AS task_id, t.status, t.repair,
              (SELECT a.id FROM coordinator.task_attempts a WHERE a.task_id = t.id
                ORDER BY a.n DESC LIMIT 1) AS attempt_id
         FROM coordinator.tasks t WHERE t.mission_id=$1 AND t.role='planner'`,
      [w.mission],
    )
  ).rows[0];
  return row as {
    task_id: string;
    status: string;
    repair: Rec | null;
    attempt_id: string;
  };
};
/** The open postcondition task verifies the given (moved) members and publishes. */
async function settlePostcondition(w: World, members: string[]) {
  const post = await w.claim('postcondition');
  expect(post, 'the postcondition task is claimable').toBeTruthy();
  for (const m of members) await w.refresh(m);
  await w.readReceipts(post!, members);
  await publishOutput(w.deps, post!.ctx, {
    kind: 'verification',
    content: { verified: true },
    dependencyVector: w.vector(members),
  });
}
const replanScheduledCount = async (w: World) =>
  (
    await w.admin.query(
      "SELECT count(*)::int n FROM coordinator.recovery_events WHERE mission_id=$1 AND kind='replan_scheduled'",
      [w.mission],
    )
  ).rows[0].n as number;

describe('G2 compensation, cancellation, self-writes: cases 13, 14, 16', () => {
  describe('G2-13 compensation', () => {
    it('G2-13a compensation of a set_config restores the prior value only while the version has not moved, through a NEW authorized intent whose digests chain to the original', async () => {
      await withWorld(
        async (w) => {
          const before = await w.cfg(POOL);
          const i = await w.proposeAdmit(w.poolSpec('tc-1'));
          await w.actions.commit(i.id, fence(i));
          await w.watcherPoll(); // the history walk settles it verified
          expect((await w.intent(i.id)).status).toBe('verified');
          const att = await currentReader(w, ['member:db.pool_max', 'health']);
          const comp0 = await w.actions.compensate(
            i.id,
            await w.callCtx(att, 'tc-comp'),
          );
          expect(comp0.id).not.toBe(i.id);
          const comp =
            comp0.status === 'proposed'
              ? await w.actions.admit(comp0.id, 'd1')
              : comp0;
          expect(comp.status).toBe('admitted');
          await w.actions.commit(comp.id, fence(comp));
          expect(await w.cfg(POOL)).toMatchObject({
            value: before.value,
            version: before.version + 2,
            causedBy: comp.id,
          });
          const rows = (await w.history(POOL)).filter(
            (h) => Number(h.version) > before.version,
          );
          expect(rows.map((r) => r.caused_by_action_id)).toEqual([
            i.id,
            comp.id,
          ]);
          expect(rows[0].before_digest).toBe(digest(before.value));
          expect(rows[0].after_digest).toBe(digest(12));
          expect(rows[1].before_digest).toBe(rows[0].after_digest);
          expect(rows[1].after_digest).toBe(rows[0].before_digest);
          expect(
            (await authSummary(w, comp.id)).map((a) => a.decision),
          ).toEqual(['admitted', 'committed']);
          expect((await w.intent(i.id)).status).toBe('verified'); // history is not rewritten
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-13b ADM-13 a later valid change survives: the compensation intent is blocked(stale_version) and the later value is untouched', async () => {
      await withWorld(
        async (w) => {
          const v1 = (await w.cfg(POOL)).version;
          const i = await w.proposeAdmit(w.poolSpec('tc-1'));
          await w.actions.commit(i.id, fence(i));
          await w.watcherPoll();
          await w.advance(POOL, 6, { via: 'owner', register: true }); // later valid change
          const att = await w.newAttempt('database_specialist', {
            reads: ['member:db.pool_max', 'health'],
          });
          let c = await w.actions.compensate(
            i.id,
            await w.callCtx(att, 'tc-comp'),
          );
          expect(c.id).not.toBe(i.id);
          if (c.status === 'proposed') c = await w.actions.admit(c.id, 'd1');
          if (c.status === 'admitted') await commitSettled(w, c.id, fence(c));
          const row = await w.intent(c.id);
          expect(row.status).toBe('blocked');
          expect(row.block_reason).toBe('stale_version');
          expect(await w.cfg(POOL)).toMatchObject({
            value: 6,
            version: v1 + 2,
            causedBy: null,
          });
          expect(await w.actionRows()).toBe(1); // only the original
          expect((await w.resultReceipts(c.id)).length).toBe(0);
          expect((await w.intent(i.id)).status).toBe('verified');
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-13c ADM-13 an irreversible Redis flush is refused as irreversible and never shown as undone', async () => {
      await withWorld(async (w) => {
        const keys = await w.plantCache(3);
        const f = await w.proposeAdmit(w.flushSpec('tc-f'));
        await w.actions.commit(f.id, fence(f));
        const d = await w.actions.dispatch(f.id, fence(f));
        expect(d.status).toBe('verified');
        expect(await w.cacheKeysLeft(keys)).toBe(0);
        const intentsBefore = (await w.footprint()).intents;
        const att = await w.newAttempt('cache_specialist', {
          reads: ['member:cache.namespace', 'redis'],
        });
        const out = await settle(
          w.actions.compensate(f.id, await w.callCtx(att, 'tc-comp')),
        );
        expect('err' in out, 'compensating a flush must throw').toBe(true);
        expect(errText('err' in out ? out.err : '')).toMatch(/irreversible/i);
        expect((await w.footprint()).intents, 'no compensation intent').toBe(
          intentsBefore,
        );
        expect(await w.cacheKeysLeft(keys)).toBe(0); // nothing resurrected
        const row = await w.intent(f.id);
        expect(row.status).toBe('verified');
        expect(['compensated', 'cancelled', 'reverted']).not.toContain(
          row.status,
        );
        await sleep(100);
        expect(w.watch.mentions(keys)).toBe(keys.length); // exactly one effect
      });
    });
  });

  it('G2-14 ADM-14 cancellation: queued work stops, committed effects stay in history and in the cancellation record, an in-flight dispatch reports its real status', async () => {
    await withWorld(
      async (w) => {
        const base = await w.snapshotConfig();
        const gen0 = (
          await w.admin.query(
            'SELECT generation FROM coordinator.missions WHERE id=$1',
            [w.mission],
          )
        ).rows[0].generation;
        const keys = await w.plantCache(3);
        const P = await w.propose(w.poolSpec('tc-p', 12)); // proposed (queued)
        const Q = await w.proposeAdmit(
          w.setSpec('tc-q', ORDERS, true, [`member:${ORDERS}`, 'health']),
        ); // admitted (queued)
        const C = await w.proposeAdmit(
          w.setSpec('tc-c', TIMEOUT, 2500, [
            'member:db.statement_timeout_ms',
            'health',
          ]),
        );
        await w.actions.commit(C.id, fence(C)); // a committed effect
        const F = await w.proposeAdmit(w.flushSpec('tc-f'));
        await w.actions.commit(F.id, fence(F));
        const parked = w.park('after_effect_before_record');
        const dispatch = settle(w.actions.dispatch(F.id, fence(F)));
        await parked.reached; // Redis effect applied, result not yet recorded
        expect(await w.cacheKeysLeft(keys)).toBe(0);

        const control = await w.control();
        const cancel = settle(control.cancel(w.mission));
        // deterministic ordering: cancel completes while the dispatch is parked, or it is
        // observed waiting on a lock the in-flight work holds; neither is fine to miss.
        let how: 'completed' | 'waiting' | null = null;
        for (let n = 0; n < 50 && how === null; n += 1) {
          if (await isSettled(cancel, 100)) how = 'completed';
          else if (await w.anyBlocked()) how = 'waiting';
        }
        expect(
          how,
          'cancel must either complete or be observed waiting while the dispatch is parked',
        ).not.toBeNull();
        parked.release();
        await dispatch;
        const cancelled = await cancel;
        expect(
          'ok' in cancelled,
          errText('err' in cancelled ? cancelled.err : ''),
        ).toBe(true);

        // queued work stops and cannot be revived by a late commit
        for (const q of [P, Q]) {
          expect((await w.intent(q.id)).status, `${q.id} queued work`).toBe(
            'cancelled',
          );
          await commitSettled(w, q.id, q.dispatch?.fence ?? 0);
          expect((await w.intent(q.id)).status).toBe('cancelled');
        }
        expect(await w.cfg(POOL)).toMatchObject({
          version: base[POOL].version,
          value: base[POOL].value,
        });
        expect(await w.cfg(ORDERS)).toMatchObject({
          version: base[ORDERS].version,
          value: base[ORDERS].value,
        });
        // the committed effect stays
        expect(await w.cfg(TIMEOUT)).toMatchObject({
          version: base[TIMEOUT].version + 1,
          value: 2500,
          causedBy: C.id,
        });
        expect(await w.actionRows()).toBe(1);
        expect((await w.intent(C.id)).status).toBe('committed'); // ADM-14: C stays committed
        // the in-flight external request is never relabelled cancelled
        expect(['dispatched', 'verified', 'outcome_unknown']).toContain(
          (await w.intent(F.id)).status,
        );
        const m = (
          await w.admin.query(
            'SELECT status, generation, cancellation FROM coordinator.missions WHERE id=$1',
            [w.mission],
          )
        ).rows[0];
        expect(m.status).toBe('cancelled');
        expect(m.generation).toBe(gen0 + 1);
        const rec = m.cancellation as {
          cancelledIntentIds: string[];
          committedEffects: string[];
        };
        expect([...rec.cancelledIntentIds].sort()).toEqual([P.id, Q.id].sort());
        expect([...rec.committedEffects].sort()).toEqual([C.id, F.id].sort());
        expect(rec.cancelledIntentIds).not.toContain(F.id);
      },
      { need: ['actions', 'hooks', 'cacheKey', 'control'] },
    );
  });

  describe('G2-16 self-write', () => {
    it('G2-16a a successful self-write r1->r2 with a trusted causedByActionId routes to verification: the acting lineage is kept, other branches are invalidated, exactly one postcondition is enqueued, no repair storm', async () => {
      await withWorld(
        async (w) => {
          const v1 = (await w.cfg(POOL)).version;
          const i = await w.proposeAdmit(w.poolSpec('tc-1'));
          const other = await w.newAttempt('investigator', {
            reads: ['member:db.pool_max'],
          }); // an unrelated branch that read r1
          await w.actions.commit(i.id, fence(i));
          await w.watcherPoll();
          const after1 = {
            recovery: await recoveryCounts(w),
            post: await postconditionCount(w),
            events: await w.invalidationsFor(`checkout.config/${POOL}`),
          };
          for (let n = 0; n < 2; n += 1) await w.watcherPoll(); // repeated polling must not storm
          expect(await recoveryCounts(w)).toEqual(after1.recovery);
          expect(await postconditionCount(w)).toBe(1);
          expect(after1.post).toBe(1);
          const events = await w.invalidationsFor(`checkout.config/${POOL}`);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            self_write: 'verified',
            reason: 'newer_observation',
          });
          expect(events[0].affected.attemptIds).toContain(other.ctx.attemptId);
          expect(after1.events).toHaveLength(1);

          // the head receipt carries the verified self-write
          const head = await w.headReceipt(`checkout.config/${POOL}`);
          expect(Number(head!.source_revision)).toBe(v1 + 1);
          expect(head!.provenance).toMatchObject({
            selfWrite: 'verified',
            causedByActionId: i.id,
          });
          expect((await w.intent(i.id)).status).toBe('verified');

          // acting lineage kept, other branch invalidated and its repair coalesced
          expect(await attemptStatus(w, i.attemptId)).not.toBe('invalidated');
          expect(await taskStatusOf(w, i.attemptId)).not.toBe('invalidated');
          expect(await attemptStatus(w, other.ctx.attemptId)).toBe(
            'invalidated',
          );
          expect(await taskStatusOf(w, other.ctx.attemptId)).toBe(
            'invalidated',
          );
          const recovery = await w.admin.query(
            'SELECT kind, task_id FROM coordinator.recovery_events WHERE mission_id=$1',
            [w.mission],
          );
          expect(
            recovery.rows.some(
              (r) =>
                r.kind === 'repair_coalesced' && r.task_id === other.ctx.taskId,
            ),
            'the other branch’s repair is coalesced behind the postcondition',
          ).toBe(true);
          const actingTask = (
            await w.admin.query(
              'SELECT task_id FROM coordinator.task_attempts WHERE id=$1',
              [i.attemptId],
            )
          ).rows[0].task_id;
          expect(
            recovery.rows.some(
              (r) => r.kind === 'repair_scheduled' && r.task_id === actingTask,
            ),
            'the acting branch is not repaired',
          ).toBe(false);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-16b a mismatched interleaving still invalidates: an injector write after the commit makes the head selfWrite none and invalidates BOTH branches', async () => {
      await withWorld(
        async (w) => {
          const v1 = (await w.cfg(POOL)).version;
          const i = await w.proposeAdmit(w.poolSpec('tc-1'));
          const other = await w.newAttempt('investigator', {
            reads: ['member:db.pool_max'],
          });
          await w.actions.commit(i.id, fence(i));
          await w.advance(POOL, 4); // the injector writes r3 before the watcher looks
          await w.watcherPoll();
          const head = await w.headReceipt(`checkout.config/${POOL}`);
          expect(Number(head!.source_revision)).toBe(v1 + 2);
          expect(head!.provenance).toMatchObject({
            selfWrite: 'none',
            causedByActionId: null,
          });
          expect((await w.history(POOL)).at(-1)).toMatchObject({
            caused_by_actor: 'injector',
            caused_by_action_id: null,
          });
          const events = await w.invalidationsFor(`checkout.config/${POOL}`);
          const ev = events.find((e) => e.new_receipt_id === head!.id);
          expect(
            ev,
            'an invalidation event for the r1 -> r3 supersession',
          ).toBeTruthy();
          expect(ev).toMatchObject({
            self_write: 'none',
            reason: 'newer_observation',
          });
          expect(ev!.affected.attemptIds).toEqual(
            expect.arrayContaining([i.attemptId, other.ctx.attemptId]),
          );
          expect(await attemptStatus(w, i.attemptId)).toBe('invalidated');
          expect(await attemptStatus(w, other.ctx.attemptId)).toBe(
            'invalidated',
          );
          // its own history row is still verified
          expect((await w.intent(i.id)).status).toBe('verified');
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-16e SW-1 verified self-write through the acting lineage (investigator delegates the specialist): lineage kept, other reader invalidated, one postcondition, routing postcondition_scheduled + repair_coalesced', async () => {
      await withWorld(
        async (w) => {
          const run = await swLineage(w);
          await w.actions.commit(run.x.id, fence(run.x));
          await w.watcherPoll();
          await expectSw(w, 'SW-1', run);

          // oracle-v3 SW-1 provenance: the held replan comes from the UNRELATED
          // root T_other, never from the excused acting lineage.
          const sw1 = swExpected('SW-1');
          const byName: Record<string, string> = {
            T_parent: run.lineage[0],
            T_act: run.lineage[1],
            T_other: run.other.ctx.taskId,
          };
          const held = await replanRows(w);
          expect(held.map((r) => r.kind)).toEqual(['replan_coalesced']);
          const eventId = held[0].invalidation_event_id;
          const scope = await affectedRoots(w, eventId);
          expect(
            scope.roots,
            'the invalidated roots are exactly the replan trigger',
          ).toEqual(sw1.replanTriggerTaskIds!.map((n) => byName[n]).sort());
          for (const t of run.lineage)
            expect(
              scope.taskIds,
              'the acting lineage is excused',
            ).not.toContain(t);

          // oracle-v3 SW-1 release: once the postcondition settles, the held
          // replan runs exactly once for the same event.
          const post = await w.claim('postcondition');
          expect(post, 'the postcondition task is claimable').toBeTruthy();
          await w.refresh('member:db.pool_max');
          await w.readReceipts(post!, ['member:db.pool_max']);
          await publishOutput(w.deps, post!.ctx, {
            kind: 'verification',
            content: { verified: true },
            dependencyVector: w.vector(['member:db.pool_max']),
          });
          const after = await replanRows(w);
          expect(
            after.filter(
              (r) =>
                r.kind === 'replan_scheduled' &&
                r.invalidation_event_id === eventId,
            ),
            'released replans for the event',
          ).toHaveLength(sw1.replansReleasedAfterPostcondition!);
          expect(
            after.filter((r) => r.kind === 'replan_scheduled'),
          ).toHaveLength(1);
          await expectNoReplanStorm(w);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-16f SW-2 self-write whose history after-digest mismatches: X failed(postcondition_mismatch), everything invalidated, routing repair_scheduled only', async () => {
      await withWorld(
        async (w) => {
          const run = await swLineage(w);
          await w.actions.commit(run.x.id, fence(run.x));
          // the action's history row disagrees with what its commit recorded
          // (verifier fixture on the per-test database, admin role)
          await w.admin.query(
            'ALTER TABLE checkout.config_versions DISABLE TRIGGER USER',
          );
          try {
            await w.admin.query(
              "UPDATE checkout.config_versions SET after_digest = repeat('f', 64) WHERE key = $1 AND caused_by_action_id = $2",
              [POOL, run.x.id],
            );
          } finally {
            await w.admin.query(
              'ALTER TABLE checkout.config_versions ENABLE TRIGGER USER',
            );
          }
          await w.watcherPoll();
          await expectSw(w, 'SW-2', run);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-16g SW-3 self-write then an injector write before the watcher runs: head selfWrite none, X verified from its own row, the whole lineage and the other reader invalidated, routing repair_scheduled only', async () => {
      await withWorld(
        async (w) => {
          const run = await swLineage(w);
          await w.actions.commit(run.x.id, fence(run.x));
          await w.advance(POOL, 4); // the injector writes before the watcher looks
          await w.watcherPoll();
          await expectSw(w, 'SW-3', run);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    // No oracle id: the two sides of scheduleReplan (adversary review).
    it('G2-16h a root task invalidated in a mission WITHOUT a succeeded planner: its repair is scheduled and no replan of any kind is recorded', async () => {
      await withWorld(
        async (w) => {
          const reader = await w.newAttempt('investigator', {
            reads: ['member:db.pool_max'],
          });
          await w.advance(POOL, 4); // unregistered; the watcher registers it
          await w.watcherPoll();
          expect(await attemptStatus(w, reader.ctx.attemptId)).toBe(
            'invalidated',
          );
          expect(await routingKinds(w)).toEqual(['repair_scheduled']);
          expect(await replanRows(w)).toEqual([]);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'], planner: false },
      );
    });

    it('G2-16i positive control: the same root invalidation with a succeeded planner under replanCap records exactly one replan_scheduled', async () => {
      await withWorld(
        async (w) => {
          const reader = await w.newAttempt('investigator', {
            reads: ['member:db.pool_max'],
          });
          await w.advance(POOL, 4);
          await w.watcherPoll();
          expect(await attemptStatus(w, reader.ctx.attemptId)).toBe(
            'invalidated',
          );
          expect(await routingKinds(w)).toEqual([
            'repair_scheduled',
            'replan_scheduled',
          ]);
          expect((await replanRows(w)).map((r) => r.kind)).toEqual([
            'replan_scheduled',
          ]);
          await expectNoReplanStorm(w);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    // No oracle ids: the replan-merge rules around one open gate (lead ruling
    // 2026-10-18; C-10 from the concurrency review).
    it('G2-16j two verified self-writes behind ONE open gate: one held replan per event (the second merged), exactly one replan_scheduled after the postcondition settles', async () => {
      await withWorld(
        async (w) => {
          // event E1: verified self-write X on db.pool_max; T_other is an unrelated root reader
          const run = await swLineage(w);
          await w.actions.commit(run.x.id, fence(run.x));
          await w.watcherPoll();
          const e1 = await replanRows(w);
          expect(e1.map((r) => r.kind)).toEqual(['replan_coalesced']);
          // event E2: a second verified self-write Y on another key while the gate is open
          const actor = await w.newAttempt('database_specialist', {
            reads: [`member:${TIMEOUT}`, 'health'],
          });
          const other2 = await w.newAttempt('investigator', {
            reads: [`member:${TIMEOUT}`],
          });
          const y = await w.proposeAdmit({
            ...w.setSpec('tc-2', TIMEOUT, 2500, [
              `member:${TIMEOUT}`,
              'health',
            ]),
            att: actor,
          });
          expect(y.status).toBe('admitted');
          await w.actions.commit(y.id, fence(y));
          await w.watcherPoll();
          expect(await attemptStatus(w, other2.ctx.attemptId)).toBe(
            'invalidated',
          );
          const rows = await replanRows(w);
          const events = [...new Set(rows.map((r) => r.invalidation_event_id))];
          expect(
            events,
            'two events, each with its own held replan',
          ).toHaveLength(2);
          const e2 = rows.filter(
            (r) => r.invalidation_event_id !== e1[0].invalidation_event_id,
          );
          expect(e2.map((r) => r.kind)).toEqual(['replan_coalesced']);
          expect(e2[0].detail).toMatch(
            /merged into the replan already pending/,
          );
          expect(await postconditionCount(w), 'one gate for both').toBe(1);
          expect(await replanScheduledCount(w)).toBe(0);
          await expectNoReplanStorm(w);

          await settlePostcondition(w, [
            'member:db.pool_max',
            `member:${TIMEOUT}`,
          ]);
          expect(await replanScheduledCount(w), 'one replan in total').toBe(1);
          await expectNoReplanStorm(w);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-16k C-10: an unrelated UNGATED event (checkout.health) reaching the held planner keeps it held, is recorded as a merged replan_coalesced, schedules no repair for the planner, and the single release counts toward replanCap', async () => {
      await withWorld(
        async (w) => {
          const run = await swLineage(w);
          // the planner's plan rests on health, so a health change reaches it
          const before = await plannerOf(w);
          await w.recordEvidence(
            {
              missionId: w.mission,
              taskId: before.task_id,
              attemptId: before.attempt_id,
            },
            ['health'],
          );
          await w.actions.commit(run.x.id, fence(run.x));
          await w.watcherPoll(); // the gate opens; the planner is held
          const held = await plannerOf(w);
          expect(held.repair?.kind, 'the planner holds a replan').toBe(
            'replan',
          );
          expect(held.status).not.toBe('runnable');
          expect((await replanRows(w)).map((r) => r.kind)).toEqual([
            'replan_coalesced',
          ]);

          // an unrelated, ungated change: health degrades and is registered
          await w.registerObserved('health', { status: 'degraded' });
          await w.deliverLatestInvalidation('checkout.health');
          const healthEvent = (
            await w.admin.query(
              `SELECT id FROM ledger.invalidation_events WHERE source_key='checkout.health'
                ORDER BY created_at DESC, id DESC LIMIT 1`,
            )
          ).rows[0].id as string;

          const still = await plannerOf(w);
          expect(still.status, 'the planner stays held').toBe(held.status);
          expect(still.status).not.toBe('runnable');
          const merged = (await replanRows(w)).filter(
            (r) => r.invalidation_event_id === healthEvent,
          );
          expect(merged.map((r) => r.kind)).toEqual(['replan_coalesced']);
          expect(merged[0].detail).toMatch(/merged into the replan/);
          const plannerRepairs = await w.admin.query(
            `SELECT count(*)::int n FROM coordinator.recovery_events
              WHERE mission_id=$1 AND task_id=$2 AND kind='repair_scheduled'`,
            [w.mission, before.task_id],
          );
          expect(plannerRepairs.rows[0].n, 'no repair for the planner').toBe(0);
          expect(await replanScheduledCount(w)).toBe(0);
          await expectNoReplanStorm(w);

          await settlePostcondition(w, ['member:db.pool_max']);
          expect(
            await replanScheduledCount(w),
            'exactly one released replan',
          ).toBe(1);
          expect(
            await replanScheduledCount(w),
            'the release counts toward replanCap',
          ).toBeLessThanOrEqual((w.deps as Rec).config.replanCap);
          await expectNoReplanStorm(w);
        },
        { need: ['actions', 'hooks', 'cacheKey', 'watcher'] },
      );
    });

    it('G2-16c ADM-16 the model/injector cannot forge the marker: version authority, raw UPDATE and raw history INSERT through the injector role all leave caused_by_action_id NULL; only the app role may set it', async () => {
      await withWorld(async (w) => {
        const forged = randomUUID();
        const v = (await w.cfg(POOL)).version;
        // (1) the injector pool, through the version authority, CLAIMING to be an action
        const client = await w.injector.connect();
        try {
          await client.query('BEGIN');
          await advanceConfig(client, {
            key: POOL,
            value: 6,
            expectedVersion: v,
            causedBy: { actor: 'action', actionId: forged },
          });
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        const head = (
          await w.admin.query(
            'SELECT value, version, caused_by_action_id FROM checkout.config_entries WHERE key=$1',
            [POOL],
          )
        ).rows[0];
        expect(head).toMatchObject({
          value: 6,
          caused_by_action_id: null,
        });
        expect(Number(head.version)).toBe(v + 1);
        const hist = (await w.history(POOL)).at(-1)!;
        expect(Number(hist.version)).toBe(v + 1);
        expect(hist.caused_by_action_id).toBeNull();
        expect(await w.actionRows()).toBe(0);

        // (2) a raw UPDATE of the head marker through the injector role
        const upd = await w.injector
          .query(
            'UPDATE checkout.config_entries SET caused_by_action_id=$1 WHERE key=$2 RETURNING caused_by_action_id',
            [forged, POOL],
          )
          .then(
            (r) => ({ rows: r.rows }),
            (e: { code?: string }) => ({ code: e.code }),
          );
        if ('code' in upd) expect(upd.code).toBe('42501');
        else expect(upd.rows[0].caused_by_action_id).toBeNull();

        // (3) a raw INSERT of a forged history row through the injector role
        const ins = await w.injector
          .query(
            `INSERT INTO checkout.config_versions (key, version, value, before_digest, after_digest, caused_by_action_id, caused_by_actor)
             VALUES ($1, $2, '7'::jsonb, NULL, NULL, $3, 'action') RETURNING caused_by_action_id`,
            [POOL, v + 50, forged],
          )
          .then(
            (r) => ({ rows: r.rows }),
            (e: { code?: string }) => ({ code: e.code }),
          );
        if ('code' in ins) expect(ins.code).toBe('42501');
        else expect(ins.rows[0].caused_by_action_id).toBeNull();

        // (4) the same raw UPDATE through the admin role is neutralised too
        const adm = await w.admin.query(
          'UPDATE checkout.config_entries SET caused_by_action_id=$1 WHERE key=$2 RETURNING caused_by_action_id',
          [forged, POOL],
        );
        expect(adm.rows[0].caused_by_action_id).toBeNull();

        for (const t of ['config_entries', 'config_versions'])
          expect(
            (
              await w.admin.query(
                `SELECT count(*)::int n FROM checkout.${t} WHERE caused_by_action_id IS NOT NULL`,
              )
            ).rows[0].n,
            `${t} holds no forged marker`,
          ).toBe(0);
        expect(await w.actionRows()).toBe(0);

        // positive control: the trusted app role CAN set the marker, so the NULL above is the role rule
        const real = randomUUID();
        const app = await w.app.connect();
        try {
          await app.query('BEGIN');
          await advanceConfig(app, {
            key: POOL,
            value: 9,
            expectedVersion: Number(head.version),
            causedBy: { actor: 'action', actionId: real },
          });
          await app.query('COMMIT');
        } finally {
          app.release();
        }
        expect((await w.cfg(POOL)).causedBy).toBe(real);
      }, NONE);
    });

    it('G2-16c2 a forged marker never classifies as a self-write: the watcher registers the injector write with selfWrite none and no causedByActionId', async () => {
      await withWorld(
        async (w) => {
          const forged = randomUUID();
          const v = (await w.cfg(POOL)).version;
          const client = await w.injector.connect();
          try {
            await client.query('BEGIN');
            await advanceConfig(client, {
              key: POOL,
              value: 6,
              expectedVersion: v,
              causedBy: { actor: 'action', actionId: forged },
            });
            await client.query('COMMIT');
          } finally {
            client.release();
          }
          await w.watcherPoll();
          const head = await w.headReceipt(`checkout.config/${POOL}`);
          expect(Number(head!.source_revision)).toBe(v + 1);
          expect(head!.provenance).toMatchObject({
            selfWrite: 'none',
            causedByActionId: null,
          });
          expect(await w.actionRows()).toBe(0);
        },
        { need: ['watcher'] },
      );
    });
  });

  it('G2-OUT2 ADM-20 outside the guarantee: a Redis change nobody observed, made between proposal and admission inside maxAge, does not stop admission', async () => {
    await withWorld(async (w) => {
      const base = await w.snapshotConfig();
      const redisBefore = w.receiptId('redis');
      const f = await w.propose(w.flushSpec('tc-f'));
      // mutate_redis_unobserved: a key appears in the namespace; nothing registers it
      await w.plantCache(1, 'acc-ns-a', 'unobserved');
      const admitted = await w.actions.admit(f.id, 'd1');
      expect(admitted.status).toBe('admitted');
      expect(w.receiptId('redis')).toBe(redisBefore);
      await checkOutcome(w, oracleOutcome('ADM-20'), {
        intents: { F: f.id },
        base,
      });
    });
  });

  it('G2-OUT outside the guarantee (documented): unobserved changes and uninstrumented remote effects are not checked by admission', async () => {
    await withWorld(async (w) => {
      const redisBefore = w.receiptId('redis');
      // A Redis key written by someone else, never observed or registered anywhere.
      const keys = await w.plantCache(2);
      const stranger = await w.plantCache(1, 'acc-ns-a', 'stranger');
      const i = await w.proposeAdmit(w.flushSpec('tc-f'));
      await w.redis.set(`${w.names.prefix}:unobserved:late`, 'x'); // unobserved remote change after admission
      await w.actions.commit(i.id, fence(i));
      await w.actions.dispatch(i.id, fence(i));
      // The flush still applied: the unobserved write is outside the vector, so nothing blocked it,
      // and keys written by a stranger inside the namespace were deleted too.
      expect((await w.intent(i.id)).status).toMatch(/dispatched|verified/);
      expect(await w.cacheKeysLeft([...keys, ...stranger])).toBe(0);
      expect(w.receiptId('redis')).toBe(redisBefore); // the ledger never learned of the change
      const vector = (await w.auths(i.id)).flatMap((a: Rec) =>
        (a.checked_vector as { sourceKey: string }[]).map((e) => e.sourceKey),
      );
      expect(vector.some((k) => /unobserved|late/.test(k))).toBe(false);
      // An observed source that nobody re-registered is likewise invisible; only the
      // freshness window (maxAgeMs) bounds it, which is the documented residual.
      const j = await w.proposeAdmit(w.poolSpec('tc-2'));
      await w.actions.commit(j.id, fence(j));
      expect((await w.intent(j.id)).status).toBe('committed');
    });
  });
});
