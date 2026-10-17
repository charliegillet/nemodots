// G6.10 app-level rare-race adapter scenarios. TEST_PROMPT gate 6 asks for
// deterministic adapter scenarios that prove rare races; the sandbox scenarios
// in adapter-scenarios.test.ts only prove fault symptoms and owner-route CAS.
// These run one real mission (live inference authors the intent) through the
// real app, force ONE interleaving with an external control, and read the
// outcome from PostgreSQL (reader role), Redis (keyspace subscriber) and the
// public API. They are reported separately and never count toward the live
// resolution rates. NEMODOTS_TEST_HOOKS is set only here, never in a trial.
//
// Each scenario is run twice: against the normal build (must leave no
// violation) and against the build selected by NEMODOTS_MUTATION=<name> that
// breaks exactly the invariant the scenario targets (must produce at least one
// violation, otherwise the mutation is not caught here and the test fails).
//
//   R1 stale between preliminary read and commit   -> bypass_final_version_check
//   R2 held row locks serialize a dependent writer     (no mutation: locking order)
//   R3 SIGKILL at after_commit_before_dispatch         (recovery without a double effect)
//   R4 SIGKILL at after_effect_before_record       -> skip_effect_marker
//   R5 Redis reply lost after the effect           -> skip_effect_marker
//   R6 SIGSTOP/SIGCONT zombie worker, lease expired -> ignore_fencing
//
// Not drivable from outside: a reused idempotency key with a different payload
// (accept_duplicate_differing_payloads) and skipped freshness (skip_freshness)
// need an entry point that submits an intent with a chosen key or evidence age;
// the harness never submits intents. They are covered by gate 2/8 (ADM-05a,
// ADM-05d, ADM-17, LG-09) and stated as NOT covered by G6 in
// mutation-coverage.test.ts.
import { describe, expect, it } from 'vitest';
import { sleep } from './helpers/http.js';
import { raceViolations, waitFor, withRace } from './helpers/races.js';
import type { Step } from './helpers/frozen.js';
import type { TrialRecord } from './helpers/record.js';
import { BlockedError } from './helpers/config.js';

const RACE_TIMEOUT = 1_500_000;
const STALE = [
  'stale_version',
  'stale_pending_observation',
  'target_version_mismatch',
];
const F5: Step = {
  trigger: { kind: 'pre_start' },
  key: 'orders.write_enabled',
  value: false,
  actor: 'injector',
};
const F1: Step = {
  trigger: { kind: 'pre_start' },
  key: 'cache.namespace',
  value: 'acc6-race-ns',
  actor: 'injector',
  requiresStaleBlobs: true,
};

interface RaceResult {
  violations: string[];
  /** null when the targeted interleaving really happened, otherwise why not */
  notExercised: string | null;
}

const snapshotOf = (record: TrialRecord) => record.snapshot!;
const flushIntent = (record: TrialRecord) =>
  snapshotOf(record).actions.find((a) => a.action === 'flush_cache_namespace');

/** BLOCKED (not FAIL) when the team simply chose another valid repair: rerun. */
function requireFlush(record: TrialRecord) {
  const flush = flushIntent(record);
  if (!flush)
    throw new BlockedError(
      'race not exercised: the team repaired without proposing a cache flush; rerun',
    );
  return flush;
}

async function staleBetweenCheckAndCommit(
  mutation?: string,
): Promise<RaceResult> {
  return withRace(
    {
      name: mutation ? 'r1-mutated' : 'r1',
      steps: [F5],
      allowedKeys: ['orders.write_enabled'],
      hooks: true,
      mutation,
    },
    async (env) => {
      await env.hooks!.arrived('after_preliminary_read', 600_000);
      // a dependent change lands while the commit is parked after its preliminary read
      await env.applier.writeUnconditionally('orders.write_enabled', true);
      env.hooks!.release('after_preliminary_read');
      await env.finish(240_000);
      const record = await env.record();
      const rejected = snapshotOf(record).authorizations.some(
        (a) =>
          a.stage === 'commit' &&
          a.decision === 'blocked' &&
          STALE.includes(a.blockReason ?? ''),
      );
      return {
        violations: raceViolations(record),
        notExercised: rejected
          ? null
          : 'no commit authorization was blocked as stale after the parked read',
      };
    },
  );
}

async function lockSerializesDependentWriter(): Promise<RaceResult> {
  return withRace(
    {
      name: 'r2',
      steps: [F5],
      allowedKeys: ['orders.write_enabled'],
      hooks: true,
    },
    async (env) => {
      await env.hooks!.arrived('after_lock_before_commit', 600_000);
      let settled = false;
      const pending = env.applier
        .writeUnconditionally('orders.write_enabled', true)
        .then((result) => {
          settled = true;
          return result;
        });
      await sleep(3000);
      const queued = !settled;
      env.hooks!.release('after_lock_before_commit');
      const write = await pending;
      await env.finish(240_000);
      const record = await env.record();
      const rows = record.configVersions.filter(
        (r) => r.key === 'orders.write_enabled',
      );
      const actionRow = rows.find((r) => r.causedByActionId);
      const writerRow = rows.find((r) => r.version === write.versionAfter);
      const violations = raceViolations(record);
      if (!queued)
        violations.push(
          'the dependent writer completed while the commit transaction held its row locks',
        );
      if (!actionRow) violations.push('the parked commit never wrote its row');
      else if (writerRow && writerRow.version < actionRow.version)
        violations.push(
          'the dependent writer is ordered before the commit that held the lock',
        );
      return { violations, notExercised: null };
    },
  );
}

async function crashAtBarrier(
  point: 'after_commit_before_dispatch' | 'after_effect_before_record',
  mutation?: string,
): Promise<RaceResult> {
  return withRace(
    {
      name: `${point === 'after_commit_before_dispatch' ? 'r3' : 'r4'}${mutation ? '-mutated' : ''}`,
      steps: [F1],
      allowedKeys: ['cache.namespace'],
      flushAllowed: true,
      hooks: true,
      mutation,
    },
    async (env) => {
      const arrival = await env.hooks!.arrived(point, 600_000);
      const atBarrier = { ...env.redisWatch.peek().markerSets };
      await env.sut.killApp();
      env.hooks!.release(point); // the restarted app must not park again
      await env.sut.restartApp();
      await env.finish(300_000);
      const record = await env.record();
      const flush = requireFlush(record);
      const id = arrival.actionId ?? flush.id;
      const markers = record.redisEffects?.markerSets[id] ?? 0;
      const violations = raceViolations(record);
      if (point === 'after_effect_before_record' && (atBarrier[id] ?? 0) !== 1)
        violations.push(
          `the applied flush left ${atBarrier[id] ?? 0} effect markers at the barrier, not 1`,
        );
      if (
        point === 'after_commit_before_dispatch' &&
        (atBarrier[id] ?? 0) !== 0
      )
        violations.push('the effect was applied before the dispatch barrier');
      if (markers !== 1)
        violations.push(
          `after recovery Redis saw ${markers} effect-marker writes for the flush, not exactly 1`,
        );
      if (flush.status !== 'verified')
        violations.push(
          `the flush intent ended ${flush.status} after the restart, not verified`,
        );
      return { violations, notExercised: null };
    },
  );
}

async function lostRedisReply(mutation?: string): Promise<RaceResult> {
  return withRace(
    {
      name: mutation ? 'r5-mutated' : 'r5',
      steps: [F1],
      allowedKeys: ['cache.namespace'],
      flushAllowed: true,
      lossyRedis: true,
      mutation,
    },
    async (env) => {
      env.redisProxy!.arm(':effect:');
      await env.finish(300_000);
      const record = await env.record();
      const flush = requireFlush(record);
      const markers = record.redisEffects?.markerSets[flush.id] ?? 0;
      const violations = raceViolations(record);
      if (markers !== 1)
        violations.push(
          `a lost reply left ${markers} effect-marker writes for the flush, not exactly 1`,
        );
      if (flush.status !== 'verified')
        violations.push(
          `the flush ended ${flush.status} after a lost reply although the effect was applied`,
        );
      return {
        violations,
        notExercised:
          env.redisProxy!.drops >= 1
            ? null
            : 'no Redis reply was dropped (no effect script reached Redis)',
      };
    },
  );
}

async function zombieWorker(mutation?: string): Promise<RaceResult> {
  return withRace(
    {
      name: mutation ? 'r6-mutated' : 'r6',
      steps: [F5],
      allowedKeys: ['orders.write_enabled'],
      separateWorker: true,
      leaseMs: 4000,
      mutation,
    },
    async (env) => {
      env.sut.startWorker('worker');
      const stale = await waitFor(
        async () => {
          const running = await env.db.runningAttempts(env.missionId);
          return running[0];
        },
        300_000,
        'a running attempt held by the first worker',
        300,
      );
      env.sut.signal('worker', 'SIGSTOP');
      await sleep(4000 + 2500); // the lease expires while the worker is frozen
      env.sut.startWorker('worker2');
      const successor = await waitFor(
        async () => {
          const attempts = await env.db.attemptsOfMission(env.missionId);
          return attempts.find(
            (a) =>
              a.taskId === stale.taskId && a.fencingToken > stale.fencingToken,
          );
        },
        120_000,
        'a successor attempt under a newer fence',
        500,
      );
      env.sut.signal('worker', 'SIGCONT'); // the zombie wakes and tries to publish
      await sleep(10_000);
      env.sut.signal('worker', 'SIGKILL');
      await env.finish(300_000);
      const record = await env.record();
      const attempts = await env.db.attemptsOfMission(env.missionId);
      const outputs = await env.db.outputsOfMission(env.missionId);
      const violations = raceViolations(record);
      const zombie = attempts.find((a) => a.id === stale.id);
      if (zombie?.status === 'published')
        violations.push(
          `the lease-expired attempt ${stale.id.slice(0, 8)} ended published`,
        );
      if (outputs.some((o) => o.attemptId === stale.id))
        violations.push(
          `an output was published under the expired fence of attempt ${stale.id.slice(0, 8)}`,
        );
      const tokens = attempts
        .filter((a) => a.taskId === stale.taskId)
        .map((a) => a.fencingToken);
      if (new Set(tokens).size !== tokens.length)
        violations.push('two attempts of one task share a fencing token');
      return {
        violations,
        notExercised:
          successor.fencingToken > stale.fencingToken
            ? null
            : 'no successor took over',
      };
    },
  );
}

describe('G6.10 app-level rare races (deterministic barriers, one live mission each)', () => {
  const expectClean = (result: RaceResult) => {
    expect(result.notExercised, 'race exercised').toBeNull();
    expect(result.violations).toEqual([]);
  };

  it(
    'G6.10 R1 a change between the preliminary read and the commit is rejected by the final check, nothing commits under the old version',
    async () => expectClean(await staleBetweenCheckAndCommit()),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 R2 row locks held at after_lock_before_commit serialize a dependent writer behind the commit',
    async () => expectClean(await lockSerializesDependentWriter()),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 R3 SIGKILL of the app at after_commit_before_dispatch recovers to exactly one flush effect',
    async () =>
      expectClean(await crashAtBarrier('after_commit_before_dispatch')),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 R4 SIGKILL of the app at after_effect_before_record reconciles from the effect marker without a second effect',
    async () => expectClean(await crashAtBarrier('after_effect_before_record')),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 R5 a Redis reply lost after the effect is reconciled, not repeated and not reported failed',
    async () => expectClean(await lostRedisReply()),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 R6 a SIGSTOP/SIGCONT zombie worker cannot publish after its lease expired',
    async () => expectClean(await zombieWorker()),
    RACE_TIMEOUT,
  );
});

describe('G6.10 gate-8 mutations are caught by the matching race (each must FAIL under its mutation build)', () => {
  const caught = (result: RaceResult, name: string) => {
    expect(
      result.violations.length,
      `mutation ${name} produced no violation: the race does not catch it`,
    ).toBeGreaterThan(0);
  };

  it(
    'G6.10 bypass_final_version_check is caught by R1',
    async () =>
      caught(
        await staleBetweenCheckAndCommit('bypass_final_version_check'),
        'bypass_final_version_check',
      ),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 skip_effect_marker is caught by R4',
    async () =>
      caught(
        await crashAtBarrier(
          'after_effect_before_record',
          'skip_effect_marker',
        ),
        'skip_effect_marker (R4)',
      ),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 skip_effect_marker is caught by R5',
    async () =>
      caught(
        await lostRedisReply('skip_effect_marker'),
        'skip_effect_marker (R5)',
      ),
    RACE_TIMEOUT,
  );

  it(
    'G6.10 ignore_fencing is caught by R6',
    async () => caught(await zombieWorker('ignore_fencing'), 'ignore_fencing'),
    RACE_TIMEOUT,
  );
});
