// W6.3 demo adversary: two scheduling defects on the demo path, reproduced
// with the SCRIPTED ADAPTER POLICY (scripted-mission.ts; not a live trial).
// Both use the single-fault scenario (cache_schema_mismatch), so neither
// depends on the dependent change or on DA-02.
//
// DA-04  evaluateMission (coordinator/missions.ts) moves a mission to
//        awaiting_acceptance when every task is terminal and no invalidation
//        is open. It does not look at action intents still `proposed` and
//        waiting out admission.minAgeMs (the demo sets 3000 ms). The probe then
//        fails on the unrepaired checkout, each failure costs a replan, the
//        replan cap (3) is reached and the mission fails while the correct
//        repair is still queued; the repair is then blocked mission_not_running.
//        A real model is slower, so live the usual effect is a spurious failed
//        probe and a burnt replan; the scripted policy just answers instantly.
//
// DA-05  wait_for_children keeps the worker slot of the waiting attempt. With
//        the product default NEMODOTS_WORKERS=2, the chain the incident policy
//        induces (investigator waits for a specialist, the specialist waits for
//        its verifier) needs three slots, so the verifier cannot start until a
//        wait times out (waitTimeoutMs 180 s in incidentTeamConfig) and the
//        parent continues without its child's result.
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';
import { scriptedEvidence } from './scripted-mission.js';

const ms = (value: unknown) => new Date(value as string).getTime();

describe('DA-04: acceptance does not start while a proposed repair waits for admission', () => {
  it('no awaiting_acceptance transition while an intent of the mission is still proposed, and no valid repair ends blocked mission_not_running', async () => {
    const ev = await scriptedEvidence(withTestDatabase, withTestRedis, {
      rule: 'selective',
      scenarioClass: 'cache_schema_mismatch',
      minAgeMs: 3000,
      latencyMs: 0,
      probeWindowMs: 1500,
      workers: 6,
      timeoutMs: 60_000,
    });
    const decidedAt = (id: string) => {
      const times = ev.authorizations
        .filter((a) => a.action_id === id)
        .map((a) => ms(a.decided_at));
      return times.length ? Math.min(...times) : Infinity;
    };
    const acceptances = ev.missionEvents
      .filter((e) => e.payload?.to === 'awaiting_acceptance')
      .map((e) => ms(e.created_at));
    const overlaps = acceptances.flatMap((at) =>
      ev.intents
        .filter((i) => ms(i.proposed_at) <= at && decidedAt(i.id) > at)
        .map(
          (i) =>
            `acceptance at +${at - ms(i.proposed_at)} ms after proposing ${i.payload?.key}=${i.payload?.value}`,
        ),
    );
    const gaveUp = ev.intents
      .filter(
        (i) =>
          i.payload?.key === 'cache.schema_version' &&
          i.status === 'blocked' &&
          i.block_reason === 'mission_not_running',
      )
      .map((i) => `${i.payload.value}: ${i.block_detail}`);
    expect({
      overlaps,
      gaveUp,
      mission: `${ev.mission.status}: ${ev.mission.failure_reason ?? ''}`,
    }).toEqual({ overlaps: [], gaveUp: [], mission: 'succeeded: ' });
  }, 120_000);
});

/** Seconds each delegated child waited for its first attempt (to the end if it never started). */
async function childLags(workers: number) {
  const ev = await scriptedEvidence(withTestDatabase, withTestRedis, {
    rule: 'selective',
    scenarioClass: 'cache_schema_mismatch',
    minAgeMs: 0,
    latencyMs: 300,
    probeWindowMs: 1500,
    workers,
    timeoutMs: 90_000,
    // stop once a verifier child has either started or waited 25 s
    stopWhen: async (missionId, pool) => {
      const { rows } = await pool.query(
        `SELECT t.created_at, (SELECT min(a.started_at) FROM coordinator.task_attempts a WHERE a.task_id = t.id) AS started
           FROM coordinator.tasks t
          WHERE t.mission_id = $1 AND t.role = 'verifier' AND t.parent_id IS NOT NULL`,
        [missionId],
      );
      return rows.some(
        (r) => r.started !== null || Date.now() - ms(r.created_at) > 25_000,
      );
    },
  });
  const children = ev.tasks.filter((t) => t.parent_id !== null);
  const end = Date.now();
  return {
    verifiers: children.filter((c) => c.role === 'verifier').length,
    lags: children.map((child) => {
      const first = ev.attempts
        .filter((a) => a.task_id === child.id)
        .map((a) => ms(a.started_at))
        .sort((a, b) => a - b)[0];
      return {
        child: `${child.title} (${child.role})`,
        waitedS: Math.round(((first ?? end) - ms(child.created_at)) / 1000),
        started: first !== undefined,
      };
    }),
  };
}

describe('DA-05: a delegated child can run while its parents wait', () => {
  it('control: with six workers every delegated child starts within 20 s', async () => {
    const { verifiers, lags } = await childLags(6);
    expect(verifiers).toBeGreaterThan(0);
    expect(lags.filter((l) => l.waitedS > 20)).toEqual([]);
  }, 150_000);

  it('product default NEMODOTS_WORKERS=2: every delegated child starts within 20 s', async () => {
    const { verifiers, lags } = await childLags(2);
    expect(verifiers).toBeGreaterThan(0);
    expect(lags.filter((l) => l.waitedS > 20)).toEqual([]);
  }, 150_000);
});
