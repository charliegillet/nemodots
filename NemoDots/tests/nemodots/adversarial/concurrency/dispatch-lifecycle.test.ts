// W5.2 re-verification: dispatch of a committed flush across pause, resume and
// cancel (lead ruling: pause defers dispatch; cancel ends a never-claimed flush
// failed(effect_not_applied) with Authorization(dispatch, mission_not_running),
// listed in committedEffects; claimed or dispatched flushes are left to their
// dispatcher). Effects are counted from Redis keys and script calls.
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearHooks,
  createIntentReader,
  findDispatchable,
  setHook,
} from '../../../../src/server/nemodots/actions/index.js';
import { createEventSink } from '../../../../src/server/nemodots/coordinator/events.js';
import {
  cancelMission,
  pauseMission,
  resumeMission,
} from '../../../../src/server/nemodots/coordinator/missions.js';
import { latch, withTimeout } from '../../helpers/barrier.js';
import {
  authorizations,
  intentRow,
  proposeFlush,
  settle,
  waitForDbClockPast,
  withEnv,
  type Env,
} from './harness.js';

afterEach(() => clearHooks());

function missionDeps(env: Env) {
  return {
    pool: env.app,
    events: createEventSink(),
    intents: createIntentReader(),
    actions: env.actions,
  } as unknown as Parameters<typeof pauseMission>[0];
}

async function seedKeys(env: Env, n: number, tag: string) {
  for (let i = 0; i < n; i += 1)
    await env.redis.client.set(
      `${env.prefix}:cache:catalog-a:v1:${tag}-${i}`,
      JSON.stringify({ i }),
    );
}

async function keyCount(env: Env) {
  let n = 0;
  for await (const batch of env.redis.client.scanIterator({
    MATCH: `${env.prefix}:cache:catalog-a:*`,
    COUNT: 200,
  }))
    n += Array.isArray(batch) ? batch.length : 1;
  return n;
}

async function committedFlush(env: Env) {
  const sc = await proposeFlush(env);
  const admitted = await env.actions.admit(sc.intent.id, 'd1');
  const fence = (admitted as unknown as { dispatch: { fence: number } })
    .dispatch.fence;
  expect((await env.actions.commit(sc.intent.id, fence)).status).toBe(
    'committed',
  );
  return { sc, fence };
}

async function dispatchable(env: Env, id: string) {
  const { rows } = await env.app.query('SELECT 1').then(async () => {
    const client = await env.app.connect();
    try {
      return { rows: await findDispatchable(client) };
    } finally {
      client.release();
    }
  });
  return rows.find((row) => row.id === id) ?? null;
}

describe('dispatch across pause / resume / cancel', () => {
  it('cleared: a pause committed before the claim -> no effect; resume -> exactly one effect', () =>
    withEnv(async (env) => {
      await seedKeys(env, 4, 'old');
      const { sc, fence } = await committedFlush(env);
      await pauseMission(missionDeps(env), sc.world.missionId as never);
      const deferred = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(deferred.status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await keyCount(env)).toBe(4);
      await resumeMission(missionDeps(env), sc.world.missionId as never);
      const next = await dispatchable(env, sc.intent.id);
      expect(next).not.toBeNull();
      const done = await env.actions.dispatch(
        sc.intent.id,
        next!.fence ?? fence,
        'd2',
      );
      expect(done.status).toBe('verified');
      expect(env.effectRedis.evalCalls).toBe(1);
      expect(await keyCount(env)).toBe(0);
      // a redelivery afterwards is a no-op
      await env.actions.dispatch(sc.intent.id, fence, 'd3');
      expect(env.effectRedis.evalCalls).toBe(1);
    }));

  it('cleared: a pause between claim and effect -> no effect, lease released; resume -> exactly one effect', () =>
    withEnv(async (env) => {
      await seedKeys(env, 4, 'old');
      const { sc, fence } = await committedFlush(env);
      setHook('after_claim_before_effect', async ({ actionId }) => {
        if (actionId === sc.intent.id)
          await pauseMission(missionDeps(env), sc.world.missionId as never);
      });
      const deferred = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      clearHooks();
      expect(deferred.status).toBe('committed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await keyCount(env)).toBe(4);
      await resumeMission(missionDeps(env), sc.world.missionId as never);
      const next = await dispatchable(env, sc.intent.id);
      expect(next).not.toBeNull();
      const done = await env.actions.dispatch(sc.intent.id, next!.fence!, 'd2');
      expect(done.status).toBe('verified');
      expect(env.effectRedis.evalCalls).toBe(1);
      expect(await keyCount(env)).toBe(0);
    }));

  it('cleared: cancel before any claim -> failed(effect_not_applied), Authorization(dispatch, mission_not_running), Redis untouched, listed in committedEffects', () =>
    withEnv(async (env) => {
      await seedKeys(env, 4, 'old');
      const { sc, fence } = await committedFlush(env);
      const mission = await cancelMission(
        missionDeps(env) as never,
        sc.world.missionId as never,
      );
      expect(mission.cancellation?.committedEffects).toContain(sc.intent.id);
      const row = await intentRow(env, sc.intent.id);
      expect(row.status).toBe('failed');
      expect(row.failure_reason).toBe('effect_not_applied');
      const dispatchAuth = (await authorizations(env, sc.intent.id)).filter(
        (a) => a.stage === 'dispatch',
      );
      expect(dispatchAuth).toEqual([
        {
          stage: 'dispatch',
          decision: 'blocked',
          block_reason: 'mission_not_running',
        },
      ]);
      // a late delivery of the dispatch message does nothing
      await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await keyCount(env)).toBe(4);
    }));

  it('cleared: cancel between claim and effect -> the dispatcher settles it not run, Redis untouched', () =>
    withEnv(async (env) => {
      await seedKeys(env, 4, 'old');
      const { sc, fence } = await committedFlush(env);
      setHook('after_claim_before_effect', async ({ actionId }) => {
        if (actionId === sc.intent.id)
          await cancelMission(
            missionDeps(env) as never,
            sc.world.missionId as never,
          );
      });
      const result = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(result.status).toBe('failed');
      expect(env.effectRedis.evalCalls).toBe(0);
      expect(await keyCount(env)).toBe(4);
    }));

  // Stated residual window: a pause that commits after the dispatcher's last
  // pre-effect read is not honoured (freshness-at-dispatch). Characterized,
  // not a defect: the effect runs once and is recorded truthfully.
  it('residual window (stated): a pause committing after the last pre-effect read does not stop the effect', () =>
    withEnv(async (env) => {
      await seedKeys(env, 2, 'old');
      const { sc, fence } = await committedFlush(env);
      const realEval = env.effectRedis.eval.bind(env.effectRedis);
      env.effectRedis.eval = async (...args) => {
        // runs after recheckMission committed, before the script
        await pauseMission(missionDeps(env), sc.world.missionId as never);
        return realEval(...args);
      };
      const result = await env.actions.dispatch(sc.intent.id, fence, 'd1');
      expect(result.status).toBe('verified');
      expect(await keyCount(env)).toBe(0);
    }));

  // FINDING C-07 (medium). A flush whose effect RAN (marker present) but whose
  // dispatcher died before recording it is later settled
  // failed(effect_not_applied) once the mission is cancelled: the lazy path in
  // claimDispatch (actions/dispatch.ts, the TERMINAL_MISSION / generation
  // branch calling failNotRunning) does not distinguish a claimed flush (it
  // has an Authorization(stage: dispatch)) from a never-claimed one and never
  // reads the effect marker. ARCHITECTURE 5.3: "reconcile reads the effect
  // marker: present -> the effect happened once (verified)"; BUILD_PROMPT
  // invariant 8: inspectable states, not fabricated ones. Expected: verified
  // (or left for reconcile), never "not applied" while the marker exists.
  it('FINDING C-07: a flush whose effect ran before a cancel is not recorded as not applied', () =>
    withEnv(
      async (env) => {
        await seedKeys(env, 3, 'old');
        const { sc, fence } = await committedFlush(env);
        setHook('after_effect_before_record', ({ actionId }) => {
          if (actionId === sc.intent.id) throw new Error('dispatcher crashed');
        });
        expect(
          (await settle(env.actions.dispatch(sc.intent.id, fence, 'd1'))).ok,
        ).toBe(false);
        clearHooks();
        expect(await keyCount(env)).toBe(0); // the effect happened
        await cancelMission(
          missionDeps(env) as never,
          sc.world.missionId as never,
        );
        const row = await intentRow(env, sc.intent.id);
        // cancelQueued left it alone (it was claimed): still committed here
        expect(row.status).toBe('committed');
        await waitForDbClockPast(env, row.dispatcher_lease_expires_at as Date);
        // the outbox redelivers action.dispatch
        await env.actions.dispatch(sc.intent.id, fence, 'd2');
        const settled = await intentRow(env, sc.intent.id);
        expect(settled.failure_reason).not.toBe('effect_not_applied');
        const marker = await env.redis.client.get(
          `${env.prefix}:effect:${sc.intent.id}`,
        );
        expect(marker).not.toBeNull();
      },
      { dispatchLeaseMs: 300 },
    ));

  // FINDING C-08 (medium). recheckMission (actions/dispatch.ts, `if
  // (row.status !== 'committed' || row.dispatch_fence !== fence) return null`)
  // treats "my fence is obsolete" as "go ahead": a dispatcher whose lease was
  // taken over runs the effect without looking at the mission, here while the
  // mission is paused. ARCHITECTURE 4: "no effect under an obsolete fence";
  // the pause ruling: pause defers dispatch. The pause committed BEFORE this
  // dispatcher's last look, so this is outside the stated window.
  it('FINDING C-08: a zombie dispatcher whose fence was superseded does not run the effect while paused', () =>
    withEnv(
      async (env) => {
        await seedKeys(env, 3, 'old');
        const { sc, fence } = await committedFlush(env);
        const parked = latch();
        const release = latch();
        let calls = 0;
        setHook('after_claim_before_effect', async ({ actionId }) => {
          if (actionId !== sc.intent.id || (calls += 1) > 1) return;
          parked.open();
          await release.promise;
        });
        const zombie = settle(env.actions.dispatch(sc.intent.id, fence, 'd1'));
        await withTimeout(parked.promise, 5_000, 'd1 parked after its claim');
        const claimedByD1 = await intentRow(env, sc.intent.id);
        await waitForDbClockPast(
          env,
          claimedByD1.dispatcher_lease_expires_at as Date,
        );
        // d2 takes the lease over (and then stalls / crashes before its effect)
        const taken = await env.actions.claimDispatch(
          sc.intent.id,
          fence,
          'd2',
        );
        expect(taken.fence).not.toBeNull();
        await pauseMission(missionDeps(env), sc.world.missionId as never);
        release.open();
        await zombie;
        expect(env.effectRedis.evalCalls).toBe(0);
        expect(await keyCount(env)).toBe(3);
      },
      { dispatchLeaseMs: 300 },
    ));

  // FINDING C-09 (low). The absent-marker settlement of a claimed flush of a
  // stopped mission (actions/dispatch.ts settleClaimedOfStoppedMission ->
  // reconcile reads 'absent' -> failNotRunning) records
  // failed(effect_not_applied) while a dispatcher that passed its last
  // pre-effect read can still run the Lua script: its lease expired, but the
  // script cannot see PostgreSQL fences, and nothing was written to Redis to
  // stop it. The effect running is the stated freshness-at-dispatch window;
  // the RECORD claiming it did not run is not (ARCHITECTURE 5.3 "absent -> it
  // did not"; BUILD_PROMPT invariant 8). Expected: the late script is refused
  // (e.g. the settlement first plants the marker with SET NX) or the intent
  // ends verified. Never "not applied" with the namespace flushed.
  it('FINDING C-09: an absent-marker settlement is not contradicted by a late in-window effect', () =>
    withEnv(
      async (env) => {
        await seedKeys(env, 3, 'old');
        const { sc, fence } = await committedFlush(env);
        const inWindow = latch();
        const release = latch();
        const realEval = env.effectRedis.eval.bind(env.effectRedis);
        let first = true;
        env.effectRedis.eval = async (...args) => {
          if (first) {
            first = false;
            inWindow.open(); // after recheckMission, before the script
            await release.promise;
          }
          return realEval(...args);
        };
        const d1 = settle(env.actions.dispatch(sc.intent.id, fence, 'd1'));
        await withTimeout(inWindow.promise, 5_000, 'd1 in the window');
        await cancelMission(
          missionDeps(env) as never,
          sc.world.missionId as never,
        );
        const claimed = await intentRow(env, sc.intent.id);
        await waitForDbClockPast(
          env,
          claimed.dispatcher_lease_expires_at as Date,
        );
        // the outbox redelivers: claimed + stopped mission -> reconcile path
        await env.actions.dispatch(sc.intent.id, fence, 'd2');
        release.open();
        await d1;
        const row = await intentRow(env, sc.intent.id);
        const flushed = (await keyCount(env)) === 0;
        const marker = await env.redis.client.get(
          `${env.prefix}:effect:${sc.intent.id}`,
        );
        // the record and Redis must agree. A marker holding a dispatch fence
        // means the script ran; 'fence_newer' / 'not_applied' are refusals.
        const ran =
          flushed ||
          (marker !== null && !['fence_newer', 'not_applied'].includes(marker));
        if (ran) expect(row.failure_reason).not.toBe('effect_not_applied');
        else expect(row.status).toBe('failed');
      },
      { dispatchLeaseMs: 300 },
    ));

  // C-12 probe (C-09 fix review). The refusal tombstone reuses the marker
  // value 'fence_newer'. If the dispatcher loses the acknowledgement of the
  // tombstone (or dies) before the PostgreSQL settlement, the next delivery
  // reconciles the marker as "refused by the Redis fence" and records
  // failed(dispatch_fence_invalid) for a flush that was never run because the
  // mission was cancelled. Expected (cancel ruling): failed(effect_not_applied)
  // with the reason mission_not_running, whatever the crash timing.
  it('FINDING C-12: a cancelled, never-run flush is recorded as not applied even if the tombstone ack is lost', () =>
    withEnv(
      async (env) => {
        await seedKeys(env, 3, 'old');
        const { sc, fence } = await committedFlush(env);
        // a dispatcher claims and dies before its effect
        const claim = await env.actions.claimDispatch(
          sc.intent.id,
          fence,
          'd1',
        );
        expect(claim.fence).not.toBeNull();
        await cancelMission(
          missionDeps(env) as never,
          sc.world.missionId as never,
        );
        const claimed = await intentRow(env, sc.intent.id);
        await waitForDbClockPast(
          env,
          claimed.dispatcher_lease_expires_at as Date,
        );
        // redelivery: the tombstone is planted, then the reply is lost
        const realEval = env.effectRedis.eval.bind(env.effectRedis);
        env.effectRedis.eval = async (script, opts) => {
          const reply = await realEval(script, opts);
          // the settlement's tombstone: a bare SET NX of the marker, no SCAN
          if (/'NX'/.test(script) && !/SCAN/.test(script)) {
            env.effectRedis.eval = realEval;
            throw new Error('redis acknowledgement lost');
          }
          return reply;
        };
        expect(
          (await settle(env.actions.dispatch(sc.intent.id, fence, 'd2'))).ok,
        ).toBe(false);
        expect((await intentRow(env, sc.intent.id)).status).toBe('committed');
        // the next redelivery settles it
        await env.actions.dispatch(sc.intent.id, fence, 'd3');
        const row = await intentRow(env, sc.intent.id);
        expect(await keyCount(env)).toBe(3); // never run
        expect(row.status).toBe('failed');
        expect(row.failure_reason).toBe('effect_not_applied');
      },
      { dispatchLeaseMs: 300 },
    ));
});
