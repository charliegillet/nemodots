// TEST_PROMPT gate 2 cases 9-12 and 15 (+ oracle LS-1..LS-7, ADM-11b/11c,
// ADM-19a/19b): fencing, duplicate delivery, crash recovery, lost-reply
// external effects, separate lease lifecycles.
//
// Fenced WRITES (publishOutput, delegate, publishFinding, recordModelCall,
// addReadSet, heartbeat, claim, reap) are the REAL coordinator functions:
//   src/server/nemodots/coordinator/publish.ts  publishOutput, delegate,
//     publishFinding, recordModelCall, addReadSet
//   src/server/nemodots/coordinator/leases.ts   claimAttempt, startAttempt,
//     heartbeat, reapExpired
// Recovery and duplicate-delivery cases run every recovery step on a SECOND
// action-admission instance with its own pg.Pool and Redis client, so
// process-local memoisation cannot satisfy them.
import { describe, expect, it } from 'vitest';
import {
  addReadSet,
  delegate,
  publishFinding,
  publishOutput,
  recordModelCall,
} from '../../../../src/server/nemodots/coordinator/publish.js';
import { heartbeat } from '../../../../src/server/nemodots/coordinator/leases.js';
import {
  ADMISSION_CASES,
  NS,
  POOL,
  SETUP_CONFIG,
  TIMEOUT,
  authSummary,
  barrier,
  checkOutcome,
  errText,
  isDispatchFenceError,
  isFenceError,
  isSettled,
  sleep,
  withTimeout,
  withWorld,
  type ActionsHandle,
  type Att,
  type Rec,
  type World,
} from './harness.js';
import { expectNoMutation } from './asserts.js';
import type { AdmissionOutcome } from '../oracle/admission.js';

const SETUP_POOL = SETUP_CONFIG[POOL];
const fence = (i: { dispatch: { fence: number } | null }) => i.dispatch!.fence;
const NONE = { need: [] as never[] };
class Crash extends Error {
  constructor(at: string) {
    super(`CRASH_SIMULATED at ${at}`);
    this.name = 'Crash';
  }
}
const crashAt = (w: World, point: Parameters<World['onHook']>[0]) =>
  w.onHook(point, () => {
    throw new Crash(point);
  });
const crashed = (e: unknown) => errText(e).includes('CRASH_SIMULATED');
const settle = async <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: v }),
    (e) => ({ err: e as unknown }),
  );
const threwFence = (r: { ok: unknown } | { err: unknown }) =>
  'err' in r && isFenceError(r.err);
const threwDispatchFence = (r: { ok: unknown } | { err: unknown }) =>
  'err' in r && isDispatchFenceError(r.err);

function oracleOutcome(id: string): AdmissionOutcome {
  const c = ADMISSION_CASES.find((x) => x.id === id);
  if (!c || 'anyOf' in c.expected)
    throw new Error(`oracle case ${id} is missing or has alternatives`);
  return c.expected;
}

/**
 * Every fenced write of an attempt, through the real coordinator functions.
 * Each thunk is built BEFORE the lease is lost (valid payloads), then fired
 * with the old token.
 */
function fencedOps(w: World, att: Att) {
  const vector = w.vector(['member:db.pool_max']);
  const call = w.buildModelCall(att, ['tc-late']);
  return {
    call,
    ops: {
      publishOutput: () =>
        publishOutput(w.deps, att.ctx, {
          kind: 'handoff',
          content: { note: 'late output' },
          dependencyVector: vector,
        }),
      delegate: () =>
        delegate(w.deps, att.ctx, {
          title: 'late child',
          role: 'verifier',
          question: 'verify the late claim',
          dependsOn: [],
          justification: 'late delegation attempt',
          dependencyVector: vector,
          toolCallId: 'tc-late-delegate',
        }),
      publishFinding: () =>
        publishFinding(w.deps, att.ctx, {
          claim: 'late finding',
          supportingReceiptIds: [w.receiptId('member:db.pool_max') as never],
          confidence: 'low',
          dependencyVector: vector,
        }),
      recordModelCall: () =>
        recordModelCall(w.deps, att.ctx, {
          record: call.record,
          snapshot: call.snapshot,
        }),
      addReadSet: () => addReadSet(w.deps, att.ctx, vector),
      heartbeat: () => heartbeat(w.deps, att.ctx),
    } satisfies Record<string, () => Promise<unknown>>,
  };
}

async function leaseRows(w: World, ids: string[]) {
  return (
    await w.admin.query(
      `SELECT a.id, a.status, a.fencing_token, a.lease_expires_at, a.lease_renewed_at,
              t.fence_seq, t.status AS task_status
         FROM coordinator.task_attempts a JOIN coordinator.tasks t ON t.id = a.task_id
        WHERE a.id = ANY($1::uuid[]) ORDER BY a.id`,
      [ids],
    )
  ).rows;
}

/** plant keys, propose + admit + commit a flush; returns the committed intent and the planted keys */
async function committedFlush(w: World, tc = 'tc-f', n = 4) {
  const keys = await w.plantCache(n);
  const i = await w.proposeAdmit(w.flushSpec(tc));
  await w.actions.commit(i.id, fence(i));
  return { i, keys };
}

/** Recovery by another dispatcher instance: the current fence, or an expired-lease reclaim. */
async function recoverDispatch(w: World, h: ActionsHandle, id: string) {
  const row = await w.intent(id);
  const first = await settle(h.api.dispatch(id as never, Number(row.dispatch_fence)));
  if ('ok' in first) return first.ok as Rec;
  if (!isDispatchFenceError(first.err)) throw first.err;
  await w.expireDispatcherLease(id);
  const r = await h.api.reclaim(id, 'dispatcher-recovery');
  return h.api.dispatch(id as never, fence(r)) as Promise<Rec>;
}

describe('G2 leases, duplicates, recovery: cases 9-12, 15', () => {
  describe('G2-09 lease fencing (real coordinator paths)', () => {
    it('LS-1 workers race to claim one runnable task: exactly one wins, one attempt, fence +1 (sampled over 8 rounds)', async () => {
      await withWorld(async (w) => {
        for (let n = 0; n < 8; n += 1) {
          const taskId = await w.seedTask(w.mission, 'investigator');
          const results = await Promise.all(
            [1, 2, 3].map(() => settle(w.claim('investigator'))),
          );
          const wins = results.filter((r) => 'ok' in r && r.ok !== null);
          const losses = results.filter((r) => !('ok' in r && r.ok !== null));
          expect(wins, `round ${n}: exactly one claimant`).toHaveLength(1);
          for (const l of losses)
            if ('err' in l)
              expect(errText(l.err), 'a loser may only lose the claim').toMatch(
                /claim_lost/,
              );
          const rows = await w.admin.query(
            `SELECT (SELECT count(*)::int FROM coordinator.task_attempts WHERE task_id=$1) AS attempts,
                    (SELECT fence_seq FROM coordinator.tasks WHERE id=$1) AS fence_seq`,
            [taskId],
          );
          expect(rows.rows[0]).toEqual({ attempts: 1, fence_seq: 1 });
        }
      }, NONE);
    });

    it('LS-2 heartbeat with a stale token fails and renews nothing', async () => {
      await withWorld(async (w) => {
        const att = await w.newAttempt('investigator');
        const before = await leaseRows(w, [att.ctx.attemptId]);
        const out = await settle(
          heartbeat(w.deps, {
            ...att.ctx,
            fencingToken: att.ctx.fencingToken - 1,
          }),
        );
        expect(threwFence(out)).toBe(true);
        expect(await leaseRows(w, [att.ctx.attemptId])).toEqual(before);
        // the right token still renews (positive control)
        const ok = await heartbeat(w.deps, att.ctx);
        expect(Date.parse(ok.leaseExpiresAt)).toBeGreaterThanOrEqual(
          before[0].lease_expires_at.getTime(),
        );
      }, NONE);
    });

    it('LS-4 renew after lease expiry fails even before any reaper ran', async () => {
      await withWorld(async (w) => {
        const att = await w.newAttempt('investigator');
        await w.expireLease(att.ctx.attemptId);
        const before = await leaseRows(w, [att.ctx.attemptId]);
        expect(threwFence(await settle(heartbeat(w.deps, att.ctx)))).toBe(true);
        expect(await leaseRows(w, [att.ctx.attemptId])).toEqual(before);
      }, NONE);
    });

    it('LS-3 reaper takeover: expire, reap, a NEW worker claims with a fresh lease and a higher fence; every fenced write of the old worker fails and writes nothing', async () => {
      await withWorld(async (w) => {
        const old = await w.newAttempt('database_specialist', {
          reads: ['member:db.pool_max', 'health'],
        });
        const { call, ops } = fencedOps(w, old);
        await w.expireLease(old.ctx.attemptId);
        expect(await w.reap()).toHaveLength(1);
        expect((await leaseRows(w, [old.ctx.attemptId]))[0]).toMatchObject({
          status: 'expired',
          task_status: 'runnable',
          fence_seq: old.ctx.fencingToken + 1,
        });

        // every fenced op fails; rowsWritten 0 except the telemetry exception: the
        // completed model call is stored UNFENCED as ONE orphaned inference attempt
        // (C16), and a repeat of the same call adds nothing (idempotent per call).
        const phase = async (label: string, newOrphans: number) => {
          const before = await w.footprint();
          const ids = (
            await w.admin.query(
              'SELECT id FROM coordinator.task_attempts WHERE task_id=$1',
              [old.ctx.taskId],
            )
          ).rows.map((r) => r.id as string);
          const leasesBefore = await leaseRows(w, ids);
          for (const [name, op] of Object.entries(ops))
            expect(
              threwFence(await settle(op())),
              `${label}: ${name} with the old token must throw FenceError`,
            ).toBe(true);
          const after = await w.footprint();
          expect(after.orphanedInference - before.orphanedInference).toBe(
            newOrphans,
          );
          expect({ ...after, orphanedInference: 0 }).toEqual({
            ...before,
            orphanedInference: 0,
          });
          expect(await leaseRows(w, ids)).toEqual(leasesBefore);
        };

        await phase('reaped, task runnable', 1);
        const holder = await w.claim('database_specialist');
        expect(holder, 'a new worker claims the requeued task').not.toBeNull();
        expect(holder!.ctx.taskId).toBe(old.ctx.taskId);
        expect(holder!.ctx.fencingToken).toBeGreaterThan(old.ctx.fencingToken);
        await phase('new holder with a fresh lease', 0);

        const orphan = await w.admin.query(
          'SELECT outcome FROM ledger.inference_attempts WHERE model_call_id=$1',
          [call.record.id],
        );
        expect(orphan.rows.map((r) => r.outcome)).toEqual(['orphaned_fence']);
        for (const sql of [
          'SELECT count(*)::int n FROM ledger.dependency_edges WHERE from_id=$1 OR to_id=$1',
          'SELECT count(*)::int n FROM ledger.model_call_records WHERE id=$1',
          'SELECT count(*)::int n FROM ledger.context_snapshots WHERE id=$1',
        ])
          expect(
            (
              await w.admin.query(sql, [
                sql.includes('snapshots')
                  ? call.snapshot.id
                  : call.record.id,
              ])
            ).rows[0].n,
            sql,
          ).toBe(0);

        // positive control: the new holder is not broken, it can publish
        const out = await publishOutput(w.deps, holder!.ctx, {
          kind: 'handoff',
          content: { note: 'holder output' },
          dependencyVector: w.vector(['member:db.pool_max']),
        });
        expect(out.outputId).toBeTruthy();
      }, NONE);
    });

    it('LS-3b the token, not the clock, decides: an old attempt whose lease has NOT expired by the clock but whose fence was superseded cannot write', async () => {
      await withWorld(async (w) => {
        const att = await w.newAttempt('database_specialist', {
          reads: ['member:db.pool_max'],
        });
        const { ops } = fencedOps(w, att);
        await w.admin.query(
          'UPDATE coordinator.tasks SET fence_seq = fence_seq + 1 WHERE id=$1',
          [att.ctx.taskId],
        );
        const live = await w.admin.query(
          'SELECT lease_expires_at > now() AS live FROM coordinator.task_attempts WHERE id=$1',
          [att.ctx.attemptId],
        );
        expect(live.rows[0].live, 'the lease is unexpired by the clock').toBe(
          true,
        );
        const before = await w.footprint();
        for (const [name, op] of Object.entries(ops))
          expect(
            threwFence(await settle(op())),
            `${name} must be fenced by the token`,
          ).toBe(true);
        const after = await w.footprint();
        expect({ ...after, orphanedInference: 0 }).toEqual({
          ...before,
          orphanedInference: 0,
        });
      }, NONE);
    });

    it('LS-7 fencing tokens strictly increase across takeovers (three claims of one task)', async () => {
      await withWorld(async (w) => {
        const first = await w.newAttempt('investigator');
        const tokens = [first.ctx.fencingToken];
        let current = first;
        for (let n = 0; n < 2; n += 1) {
          await w.expireLease(current.ctx.attemptId);
          expect(await w.reap()).toHaveLength(1);
          const next = await w.claim('investigator');
          expect(next).not.toBeNull();
          expect(next!.ctx.taskId).toBe(first.ctx.taskId);
          tokens.push(next!.ctx.fencingToken);
          current = next!;
        }
        expect(tokens).toHaveLength(3);
        for (let n = 1; n < tokens.length; n += 1)
          expect(tokens[n]).toBeGreaterThan(tokens[n - 1]);
        const fenceSeq = (
          await w.admin.query(
            'SELECT fence_seq FROM coordinator.tasks WHERE id=$1',
            [first.ctx.taskId],
          )
        ).rows[0].fence_seq;
        expect(fenceSeq).toBe(tokens[2]);
      }, NONE);
    });

    it('LS-6 cancel waits for an in-flight publication, then rejects the next one (real MissionControlPort.cancel)', async () => {
      await withWorld(
        async (w) => {
          const control = await w.control();
          const att = await w.newAttempt('investigator', {
            reads: ['member:db.pool_max'],
          });
          const vec = w.vector(['member:db.pool_max']);
          // Park INSIDE the publication transaction (mission FOR SHARE already held),
          // through the validator the coordinator calls there.
          const real = w.deps.supportValidator;
          let release!: () => void;
          const gate = new Promise<void>((r) => (release = r));
          let reached!: () => void;
          const inTx = new Promise<void>((r) => (reached = r));
          w.deps.supportValidator = {
            assertCurrent: async (...args) => {
              reached();
              await gate;
              return real.assertCurrent(...args);
            },
          };
          const before = await w.footprint();
          const gen0 = (
            await w.admin.query(
              'SELECT generation FROM coordinator.missions WHERE id=$1',
              [w.mission],
            )
          ).rows[0].generation;
          const first = settle(
            publishOutput(w.deps, att.ctx, {
              kind: 'handoff',
              content: { n: 1 },
              dependencyVector: vec,
            }),
          );
          await withTimeout(inTx, 10_000, 'publication never reached the tx');
          const cancel = settle(control.cancel(w.mission));
          expect(await isSettled(cancel, 400)).toBe(false);
          expect(await w.anyBlocked(), 'cancel waits on the publication').toBe(
            true,
          );
          release();
          const [p1] = await Promise.all([first, cancel]);
          w.deps.supportValidator = real;
          expect('ok' in p1, 'the in-flight publication commits').toBe(true);
          const mid = await w.footprint();
          expect(mid.outputs).toBe(before.outputs + 1);
          expect(
            (
              await w.admin.query(
                'SELECT generation, status FROM coordinator.missions WHERE id=$1',
                [w.mission],
              )
            ).rows[0],
          ).toMatchObject({ generation: gen0 + 1, status: 'cancelled' });
          const next = await settle(
            publishOutput(w.deps, att.ctx, {
              kind: 'handoff',
              content: { n: 2 },
              dependencyVector: vec,
            }),
          );
          expect(threwFence(next)).toBe(true);
          const after = await w.footprint();
          expect({ ...after, events: 0 }).toEqual({ ...mid, events: 0 });
        },
        { need: ['control'] },
      );
    });

    it('G2-09 takeover then propose/commit: the old author token cannot propose, a stale dispatch fence cannot commit, and nothing is written', async () => {
      await withWorld(async (w) => {
        const stale = await w.newAttempt('database_specialist', {
          reads: ['member:db.pool_max', 'health'],
        });
        await w.modelCallFor(stale, 'tc-stale'); // recorded while the author still held its lease
        await w.expireLease(stale.ctx.attemptId);
        expect(await w.reap()).toHaveLength(1);
        const holder = await w.claim('database_specialist');
        expect(holder!.ctx.fencingToken).toBeGreaterThan(
          stale.ctx.fencingToken,
        );
        const before = await w.footprint();
        const out = await settle(
          w.propose({ ...w.poolSpec('tc-stale'), att: stale }),
        );
        expect(threwFence(out), 'err' in out ? errText(out.err) : '').toBe(
          true,
        );
        expect(await w.footprint()).toEqual(before);
        expect(
          (
            await w.admin.query(
              'SELECT count(*)::int n FROM coordinator.action_intents WHERE tool_call_id=$1',
              ['tc-stale'],
            )
          ).rows[0].n,
        ).toBe(0);

        // a stale or wrong dispatch fence cannot commit and writes nothing
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        for (const bad of [fence(i) - 1, fence(i) + 1]) {
          const r = await settle(w.actions.commit(i.id, bad));
          expect(
            threwDispatchFence(r),
            `fence ${bad}: ${'err' in r ? errText(r.err) : 'returned'}`,
          ).toBe(true);
        }
        expect((await w.intent(i.id)).status).toBe('admitted');
        await expectNoMutation(w, base);
        expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
          'admitted',
        ]);
        expect((await w.resultReceipts(i.id)).length).toBe(0);
      });
    });
  });

  describe('G2-10 duplicate delivery', () => {
    it('G2-10a two simultaneous identical commits from two independent instances at the lock boundary: one effect, one receipt, the same intent returned to both', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        const second = await w.newActions('second');
        const third = await w.newActions('third');
        const gate = barrier(2);
        w.onHook('before_lock', () => gate.arrive());
        const [a, b] = await Promise.all([
          w.actions.commit(i.id, fence(i)),
          second.api.commit(i.id, fence(i)),
        ]);
        expect(gate.arrived).toBe(2);
        expect([a.status, b.status]).toEqual(['committed', 'committed']);
        for (const f of ['id', 'statusVersion', 'committedAt'] as const)
          expect(a[f], `both callers see the same ${f}`).toEqual(b[f]);
        const receipts = await w.resultReceipts(i.id);
        expect(receipts).toHaveLength(1);
        expect(
          (await authSummary(w, i.id)).filter((x) => x.stage === 'commit'),
        ).toEqual([
          { stage: 'commit', decision: 'committed', blockReason: null },
        ]);
        await w.clearHooks();
        // a later delivery on a third instance returns the original and writes nothing
        const c = await third.api.commit(i.id, fence(i));
        expect(c.status).toBe('committed');
        expect(c.statusVersion).toBe(a.statusVersion);
        expect((await w.resultReceipts(i.id)).map((r) => r.id)).toEqual(
          receipts.map((r) => r.id),
        );
        await checkOutcome(w, oracleOutcome('ADM-10'), {
          intents: { I: i.id },
          base,
        });
      });
    });

    it('G2-10b two simultaneous identical proposals (same tool call) from two instances yield one intent', async () => {
      await withWorld(async (w) => {
        const second = await w.newActions('second');
        // one proposing attempt and one recorded model call, as a replayed tool call has
        const att = await w.newAttempt('database_specialist', {
          reads: ['member:db.pool_max', 'health'],
        });
        await w.modelCallFor(att, 'tc-dup');
        const [a, b] = await Promise.all([
          w.propose({ ...w.poolSpec('tc-dup'), att }),
          w.proposeVia(second.api, { ...w.poolSpec('tc-dup'), att }),
        ]);
        expect(a.id).toBe(b.id);
        expect(
          (
            await w.admin.query(
              'SELECT count(*)::int n FROM coordinator.action_intents WHERE tool_call_id=$1',
              ['tc-dup'],
            )
          ).rows[0].n,
        ).toBe(1);
      });
    });
  });

  describe('G2-11 crash recovery distinguishes uncommitted, committed and unknown', () => {
    it('G2-11a crash after admission: the lease expires, a NEW instance re-claims and commits once; the old dispatcher’s fence is dead', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1')); // dispatcher-1 "crashes" here
        const oldFence = fence(i);
        const b = await w.newActions('recovery');
        await w.expireDispatcherLease(i.id);
        const r = await b.api.reclaim(i.id, 'dispatcher-2');
        expect(fence(r)).toBeGreaterThan(oldFence);
        expect(threwDispatchFence(await settle(w.actions.commit(i.id, oldFence)))).toBe(
          true,
        );
        expect(await w.actionRows()).toBe(0);
        await b.api.commit(i.id, fence(r));
        await checkOutcome(w, oracleOutcome('ADM-11a'), {
          intents: { I: i.id },
          base,
        });
      });
    });

    it('G2-11b ADM-11b crash before the commit lock: nothing written, the intent is still claimable by a new instance that commits exactly once', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        crashAt(w, 'before_lock');
        const out = await settle(w.actions.commit(i.id, fence(i)));
        expect('err' in out && crashed(out.err)).toBe(true);
        expect(w.hits('before_lock')).toBe(1);
        expect((await w.intent(i.id)).status).toBe('admitted');
        expect(await w.actionRows()).toBe(0);
        await w.clearHooks();
        const b = await w.newActions('recovery');
        await w.expireDispatcherLease(i.id);
        const r = await b.api.reclaim(i.id, 'dispatcher-2');
        await b.api.commit(i.id, fence(r));
        await checkOutcome(w, oracleOutcome('ADM-11b'), {
          intents: { I: i.id },
          base,
        });
      });
    });

    it('G2-11b2 crash after the lock, before the commit: rolled back entirely, a new instance commits exactly once', async () => {
      await withWorld(async (w) => {
        const v1 = (await w.cfg(POOL)).version;
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        crashAt(w, 'after_lock_before_commit');
        const out = await settle(w.actions.commit(i.id, fence(i)));
        expect('err' in out && crashed(out.err)).toBe(true);
        expect((await w.intent(i.id)).status).toBe('admitted');
        expect(await w.cfg(POOL)).toMatchObject({
          version: v1,
          value: SETUP_POOL,
        });
        expect((await authSummary(w, i.id)).map((a) => a.decision)).toEqual([
          'admitted',
        ]);
        expect((await w.resultReceipts(i.id)).length).toBe(0);
        await w.clearHooks();
        const b = await w.newActions('recovery');
        await b.api.commit(i.id, fence(i));
        expect((await w.intent(i.id)).status).toBe('committed');
        expect((await w.cfg(POOL)).version).toBe(v1 + 1);
        expect(await w.actionRows()).toBe(1);
      });
    });

    it('G2-11c ADM-11c crash after the commit (set_config): committed once; a new instance’s repeat commit writes nothing (no second authorization, receipt, version or outbox row)', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const i = await w.proposeAdmit(w.poolSpec('tc-1'));
        crashAt(w, 'after_commit_before_dispatch');
        const first = await settle(w.actions.commit(i.id, fence(i)));
        if ('err' in first) expect(crashed(first.err)).toBe(true);
        await w.clearHooks();
        expect((await w.intent(i.id)).status).toBe('committed');
        const outbox = (await w.outboxFor(i.id)).length;
        expect(outbox).toBeGreaterThanOrEqual(1);
        const b = await w.newActions('recovery');
        const again = await b.api.commit(i.id, fence(i));
        expect(again.status).toBe('committed');
        expect((await w.outboxFor(i.id)).length).toBe(outbox);
        await checkOutcome(w, oracleOutcome('ADM-11c'), {
          intents: { I: i.id },
          base,
        });
        expect(
          (await authSummary(w, i.id)).filter((x) => x.stage === 'commit'),
        ).toHaveLength(1);
      });
    });

    it('G2-11c-flush crash after the commit (outbox row pending), before dispatch: committed with no Redis effect; a new instance dispatches exactly once, a repeat dispatch does nothing', async () => {
      await withWorld(async (w) => {
        const { i, keys } = await committedFlush(w);
        const outbox = (await w.outboxFor(i.id)).length;
        expect(
          outbox,
          'the commit left a pending outbox row',
        ).toBeGreaterThanOrEqual(1);
        crashAt(w, 'after_commit_before_dispatch');
        const out = await settle(w.actions.dispatch(i.id, fence(i)));
        expect('err' in out && crashed(out.err)).toBe(true);
        expect(w.hits('after_commit_before_dispatch')).toBe(1);
        expect((await w.intent(i.id)).status).toBe('committed');
        expect(await w.cacheKeysLeft(keys)).toBe(keys.length);
        expect(await w.markerPresent(i.id)).toBe(false);
        await sleep(150);
        expect(w.watch.mentions(keys)).toBe(0);
        await w.clearHooks();
        const b = await w.newActions('recovery');
        const d = await recoverDispatch(w, b, i.id);
        expect(['dispatched', 'verified']).toContain(d.status);
        expect(await w.cacheKeysLeft(keys)).toBe(0);
        expect(await w.markerPresent(i.id)).toBe(true);
        const fresh = await w.plantCache(2, 'acc-ns-a', 'fresh');
        const c = await w.newActions('again');
        await settle(recoverDispatch(w, c, i.id)); // a repeat delivery
        await sleep(150);
        expect(await w.cacheKeysLeft(fresh)).toBe(2);
        expect(w.watch.mentions(keys)).toBe(keys.length); // one effect: each key unlinked once
        expect(w.watch.mentions(fresh)).toBe(0);
        expect((await w.outboxFor(i.id)).length).toBe(outbox);
      });
    });

    it('G2-11d ADM-11d crash after the effect, before it is recorded: a second instance’s dispatch finds the marker (already_applied), settles verified, and never flushes again', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const { i, keys } = await committedFlush(w);
        crashAt(w, 'after_effect_before_record');
        const out = await settle(w.actions.dispatch(i.id, fence(i)));
        expect('err' in out && crashed(out.err)).toBe(true);
        expect(await w.cacheKeysLeft(keys)).toBe(0); // the effect really happened
        expect(await w.markerPresent(i.id)).toBe(true);
        expect(['committed', 'dispatched', 'outcome_unknown']).toContain(
          (await w.intent(i.id)).status,
        );
        await w.clearHooks();
        // data written by someone else after the first effect must survive the second dispatch
        const fresh = await w.plantCache(2, 'acc-ns-a', 'fresh');
        const b = await w.newActions('recovery');
        const d = await recoverDispatch(w, b, i.id);
        expect(d.status).toBe('verified');
        await sleep(150);
        expect(await w.cacheKeysLeft(fresh)).toBe(2);
        expect(JSON.stringify(await w.resultReceipts(i.id))).toContain(
          'already_applied',
        );
        await checkOutcome(w, oracleOutcome('ADM-11d'), {
          intents: { F: i.id },
          base,
          redis: { mentions: w.watch.mentions(keys), planted: keys.length },
        });
        expect(w.watch.mentions(fresh)).toBe(0);
      });
    });
  });

  describe('G2-12 lost response after a real external effect', () => {
    it('G2-12a the reply is lost after the Redis effect: outcome_unknown until a new instance reconciles from the marker; never re-applied', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const { i, keys } = await committedFlush(w, 'tc-f', 3);
        w.fault.mode = 'drop_reply';
        await settle(w.actions.dispatch(i.id, fence(i)));
        w.fault.mode = 'ok';
        expect((await w.intent(i.id)).status).toBe('outcome_unknown');
        expect(await w.cacheKeysLeft(keys)).toBe(0); // effect happened despite the lost reply
        expect(await w.markerPresent(i.id)).toBe(true);
        const fresh = await w.plantCache(2, 'acc-ns-a', 'fresh');
        const b = await w.newActions('recovery');
        const r = await b.api.reconcile(i.id);
        expect(r.status).toBe('verified');
        expect(await w.cacheKeysLeft(fresh)).toBe(2); // reconcile did not flush again
        expect(((await w.resultReceipts(i.id)).at(-1) as Rec).outcome).toBe(
          'verified',
        );
        await sleep(150);
        await checkOutcome(w, oracleOutcome('ADM-12a'), {
          intents: { F: i.id },
          base,
          redis: { mentions: w.watch.mentions(keys), planted: keys.length },
        });
        expect(w.watch.mentions(fresh)).toBe(0);
      });
    });

    it('G2-12b the request never reached Redis: no effect happened; a new instance’s reconcile settles failed(effect_not_applied) and does not re-run it', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const { i, keys } = await committedFlush(w, 'tc-f', 3);
        w.fault.mode = 'fail_before';
        await settle(w.actions.dispatch(i.id, fence(i)));
        w.fault.mode = 'ok';
        expect(['outcome_unknown', 'committed']).toContain(
          (await w.intent(i.id)).status,
        );
        expect(await w.cacheKeysLeft(keys)).toBe(3);
        const b = await w.newActions('recovery');
        expect((await b.api.reconcile(i.id)).status).toBe('failed');
        expect((await b.api.reconcile(i.id)).status).toBe('failed');
        expect(await w.cacheKeysLeft(keys)).toBe(3); // reconcile never re-runs the effect
        expect(await w.markerPresent(i.id)).toBe(false);
        await sleep(150);
        await checkOutcome(w, oracleOutcome('ADM-12b'), {
          intents: { F: i.id },
          base,
          redis: { mentions: w.watch.mentions(keys), planted: keys.length },
        });
      });
    });

    it('G2-12c ADM-19a the namespace authority advanced after commit, before dispatch: failed(dispatch_fence_invalid) and zero Redis effects', async () => {
      await withWorld(async (w) => {
        const base = await w.snapshotConfig();
        const { i, keys } = await committedFlush(w, 'tc-f', 3);
        await w.advance(NS, 'acc-ns-b', { register: false });
        await settle(w.actions.dispatch(i.id, fence(i)));
        expect(await w.cacheKeysLeft(keys)).toBe(3);
        expect(await w.markerPresent(i.id)).toBe(false);
        await sleep(150);
        await checkOutcome(w, oracleOutcome('ADM-19a'), {
          intents: { F: i.id },
          base,
          redis: { mentions: w.watch.mentions(keys), planted: keys.length },
        });
      });
    });

    it('G2-12d ADM-19b a Redis effect fence strictly newer than the committed version: fence_newer, failed(dispatch_fence_invalid), zero effects', async () => {
      await withWorld(async (w) => {
        const committedVersion = (await w.cfg(NS)).version;
        // F0 applies once and writes the namespace fence; its key reveals the layout.
        const f0 = await committedFlush(w, 'tc-f0', 2);
        await w.actions.dispatch(f0.i.id, fence(f0.i));
        const fenceKeys = await w.fenceKeys();
        expect(
          fenceKeys,
          'a flush must leave exactly one fence key',
        ).toHaveLength(1);
        expect(Number(await w.redis.get(fenceKeys[0]))).toBe(committedVersion);
        await w.redis.set(fenceKeys[0], String(committedVersion + 1));
        // F1: same target version, but the fence moved past it
        const keys = await w.plantCache(3, 'acc-ns-a', 'f1');
        const f1 = await w.proposeAdmit(w.flushSpec('tc-f1'));
        await w.actions.commit(f1.id, fence(f1));
        await settle(w.actions.dispatch(f1.id, fence(f1)));
        expect(await w.cacheKeysLeft(keys)).toBe(3);
        expect(await w.markerPresent(f1.id)).toBe(false);
        const row = await w.intent(f1.id);
        expect(row.status).toBe('failed');
        expect(row.failure_reason).toBe('dispatch_fence_invalid');
        await sleep(150);
        expect(w.watch.mentions(keys)).toBe(0);
        expect((await w.cfg(NS)).version).toBe(committedVersion); // authority unchanged
      });
    });
  });

  it('G2-15 / LS-5 separate lease lifecycles: a completed author’s proposal executes under a new dispatch lease; an expired author cannot propose; an expired dispatcher cannot commit and a re-claim has a higher fence', async () => {
    await withWorld(async (w) => {
      const v1 = (await w.cfg(POOL)).version;
      const author = await w.newAttempt('database_specialist');
      const i = await w.propose({ ...w.poolSpec('tc-1'), att: author });
      // the author finishes: its authoring lease is over (real publication)
      await publishOutput(w.deps, author.ctx, {
        kind: 'handoff',
        content: { done: true },
        dependencyVector: [],
      });
      expect((await leaseRows(w, [author.ctx.attemptId]))[0].status).toBe(
        'published',
      );
      const admitted = await w.actions.admit(i.id, 'dispatcher-1');
      await w.actions.commit(i.id, fence(admitted));
      expect((await w.intent(i.id)).status).toBe('committed');
      expect(await w.cfg(POOL)).toMatchObject({
        version: v1 + 1,
        value: 12,
        causedBy: i.id,
      });

      // an author whose lease expired cannot propose
      const expired = await w.newAttempt('database_specialist', {
        reads: ['member:db.pool_max', 'health'],
      });
      await w.modelCallFor(expired, 'tc-2');
      await w.expireLease(expired.ctx.attemptId);
      expect(
        threwFence(
          await settle(w.propose({ ...w.poolSpec('tc-2', 8), att: expired })),
        ),
      ).toBe(true);
      expect(
        (
          await w.admin.query(
            'SELECT count(*)::int n FROM coordinator.action_intents WHERE tool_call_id=$1',
            ['tc-2'],
          )
        ).rows[0].n,
      ).toBe(0);

      // an expired dispatcher cannot commit; a re-claim has a higher fence and can
      const j = await w.proposeAdmit(
        w.setSpec('tc-3', TIMEOUT, 120, [
          'member:db.statement_timeout_ms',
          'health',
        ]),
      );
      await w.expireDispatcherLease(j.id);
      expect(
        threwDispatchFence(await settle(w.actions.commit(j.id, fence(j)))),
      ).toBe(true);
      expect((await w.intent(j.id)).status).toBe('admitted');
      expect((await w.cfg(TIMEOUT)).value).toBe(SETUP_CONFIG[TIMEOUT]);
      expect(await w.actionRows()).toBe(1);
      const r = await w.actions.reclaim(j.id, 'dispatcher-2');
      expect(fence(r)).toBeGreaterThan(fence(j));
      expect(
        threwDispatchFence(await settle(w.actions.commit(j.id, fence(j)))),
      ).toBe(true);
      await w.actions.commit(j.id, fence(r));
      expect((await w.intent(j.id)).status).toBe('committed');
      expect(await w.cfg(TIMEOUT)).toMatchObject({ value: 120, causedBy: j.id });
      expect(await w.actionRows()).toBe(2);
      expect(
        (await authSummary(w, j.id)).filter((x) => x.decision === 'committed'),
      ).toHaveLength(1);
    });
  });
});
