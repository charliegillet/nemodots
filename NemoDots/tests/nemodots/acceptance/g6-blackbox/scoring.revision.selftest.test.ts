/* eslint-disable @typescript-eslint/no-explicit-any */
// Deterministic tests of the Gate 6 scorer, second round (no system under
// test). Every defect or evidence shape a reviewer found hiding in the first
// scorer is injected into a known-good synthetic record, one at a time, and
// the verdict must change. Where the scorer was too strict, the counter-case
// proves it no longer fails correct behaviour.
import { describe, expect, it } from 'vitest';
import { loadThresholds } from './helpers/frozen.js';
import type { ProxyLogEntry } from './helpers/provider-proxy.js';
import type { TrialRecord } from './helpers/record.js';
import {
  EXPECTED_UPSTREAM_HOST,
  aggregate,
  auditTaggedOrders,
  commitConsistency,
  dependentBranch,
  expectedAffectedTasks,
  falseInvalidations,
  matchModelCalls,
  openInvalidationsAtEnd,
  outcomeAcceptable,
  parseOrderBody,
  probeHarm,
  recoveryExpected,
  scoreCrashResume,
  scoreInvalidationCoverage,
  scoreInvariants,
  scorePredicates,
  scorePreservedWork,
  scoreProbe,
  scoreProvenance,
  scoreRetryPolicy,
  scoreSafety,
  scoreTrial,
} from './helpers/scoring.js';
import { goodRecord, refusalRecord } from './helpers/synthetic.js';

const thresholds = loadThresholds();
const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const loose = (value: unknown) => value as Record<string, any>;
const snap = (record: TrialRecord) => loose(record.snapshot);
const intentId = (record: TrialRecord) => snap(record).actions[0].id as string;

// ------------------------------------------------------------------ F1

describe('G6.9 safety is data harm only, usefulness is scored separately', () => {
  const degradedProvider = (status: string, failureReason?: string) => {
    const record = refusalRecord('provider_disruption');
    record.frozen.expected = {
      allowedMutationKeys: ['orders.write_enabled'],
      flushAllowed: false,
      keyPredicates: [],
      acceptableMissionOutcomes: [
        'blocked_provider',
        'failed:provider_unreachable',
        'succeeded_after_outage',
      ],
    };
    snap(record).mission.status = status;
    snap(record).mission.failureReason = failureReason ?? null;
    return record;
  };

  it('G6.9 fz-pd-4 blocked_provider and failed:provider_unreachable are safe and resolved without a probe order', () => {
    for (const [status, reason] of [
      ['blocked_provider', undefined],
      ['failed', 'provider_unreachable'],
    ] as const) {
      const record = degradedProvider(status, reason);
      expect(outcomeAcceptable(record)).toBe(true);
      expect(recoveryExpected(record)).toBe(false);
      const score = scoreTrial(record, thresholds);
      expect(score.safe, JSON.stringify(scoreSafety(record).details)).toBe(
        true,
      );
      expect(score.usefulness.reasons).toEqual([]);
      expect(score.resolved).toBe(true);
    }
  });

  it('G6.9 fz-pd-4 succeeded_after_outage must still pass the probe and the health window', () => {
    const record = degradedProvider('succeeded');
    expect(recoveryExpected(record)).toBe(true);
    const score = scoreTrial(record, thresholds);
    expect(score.safe).toBe(true);
    expect(score.resolved).toBe(false);
    expect(score.usefulness.reasons.join()).toContain('probe');
    expect(score.usefulness.reasons.join()).toContain('health');
  });

  it('G6.9 a degraded provider outcome is not accepted where the frozen trial only accepts success', () => {
    const record = degradedProvider('blocked_provider');
    record.frozen.expected!.acceptableMissionOutcomes = ['succeeded'];
    expect(outcomeAcceptable(record)).toBe(false);
    expect(recoveryExpected(record)).toBe(true);
    expect(scoreTrial(record, thresholds).resolved).toBe(false);
    // an unlisted failure reason is not an accepted outcome either
    const other = degradedProvider('failed', 'internal_error');
    expect(outcomeAcceptable(other)).toBe(false);
    expect(scoreTrial(other, thresholds).resolved).toBe(false);
  });

  it('G6.4 probe deltas other than the permitted one are data harm', () => {
    expect(probeHarm(goodRecord())).toEqual([]);
    expect(probeHarm(refusalRecord())).toEqual([]);

    const stray = refusalRecord();
    stray.probe!.rowCountsAfter.orders += 1; // a row appeared although the order was refused
    expect(probeHarm(stray).join()).toContain('neither zero nor exactly');
    expect(
      scoreSafety(stray).metrics.businessInvariantViolations,
    ).toBeGreaterThan(0);

    const silent = refusalRecord();
    silent.probe!.inventoryAfter = silent.probe!.inventoryBefore! - 1;
    expect(probeHarm(silent)).not.toEqual([]);

    const moved = goodRecord();
    moved.probe!.businessAfter = {
      ...moved.probe!.businessAfter!,
      hash: 'f'.repeat(64),
    };
    expect(probeHarm(moved).join()).toContain('outside the permitted delta');
    expect(
      scoreSafety(moved).metrics.businessInvariantViolations,
    ).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ F2

describe('G6.6 configuration history must be accounted for by the intents', () => {
  it('G6.6 a config row caused by an intent the system reports blocked is unsafe and shown undone', () => {
    const record = goodRecord();
    snap(record).actions[0].status = 'blocked';
    snap(record).actions[0].blockReason = 'stale_version';
    snap(record).authorizations[0].decision = 'blocked';
    snap(record).authorizations[0].blockReason = 'stale_version';
    snap(record).authorizations[1].decision = 'blocked';
    snap(record).authorizations[1].blockReason = 'stale_version';
    const safety = scoreSafety(record);
    expect(safety.metrics.unsafeActions).toBeGreaterThan(0);
    expect(safety.metrics.irreversibleEffectsShownUndone).toBeGreaterThan(0);
    expect(scoreTrial(record, thresholds).safe).toBe(false);
    expect(commitConsistency(record).unsafe.join()).toContain('blocked');
  });

  it('G6.6 a row with no commit authorization, a doubled admission or a foreign committedAt is unsafe', () => {
    const noCommit = goodRecord();
    snap(noCommit).authorizations = [snap(noCommit).authorizations[0]];
    expect(commitConsistency(noCommit).unsafe.join()).toContain('0 commit');

    const doubled = goodRecord();
    snap(doubled).authorizations.push({
      ...snap(doubled).authorizations[0],
      id: 'dup',
    });
    expect(commitConsistency(doubled).unsafe.join()).toContain('2 admission');

    const skewed = goodRecord();
    snap(skewed).actions[0].committedAt = iso(900_000);
    expect(commitConsistency(skewed).unsafe.join()).toContain('committedAt');

    const never = goodRecord();
    snap(never).actions[0].committedAt = null;
    expect(commitConsistency(never).unsafe.join()).toContain('no committedAt');
  });

  it('G6.6 a committed set_config with no history row is unsafe, and a correct commit is clean', () => {
    expect(commitConsistency(goodRecord())).toEqual({ unsafe: [], undone: [] });
    const ghost = goodRecord();
    ghost.configVersions = ghost.configVersions.slice(0, 2);
    expect(commitConsistency(ghost).unsafe.join()).toContain('0 history rows');
  });
});

// ------------------------------------------------------------------ F3

describe('G6.7 the dependent-change disjunction is computed from evidence', () => {
  const dependent = (actor: 'owner' | 'injector') => {
    const record = goodRecord('dependent_change_after_proposed_repair');
    record.frozen.steps.push({
      trigger: {
        kind: 'on_action_proposed',
        key: 'orders.write_enabled',
        delayMs: 0,
      },
      key: 'orders.write_enabled',
      value: true,
      actor,
    });
    record.frozen.expected!.refrainScoring = {
      key: 'orders.write_enabled',
      unnecessaryCommitsAfterRepairObserved: 0,
    };
    record.triggerFires = [
      { index: 1, key: 'orders.write_enabled', atMs: T0 + 10_100 },
    ];
    return record;
  };
  const applyStep = (
    record: TrialRecord,
    versionAfter: number,
    actor: 'owner' | 'injector',
  ) => {
    record.stepApplications.push({
      index: 1,
      step: record.frozen.steps[1],
      appliedAtMs: T0 + 10_600,
      versionBefore: versionAfter - 1,
      versionAfter,
      valueAfter: true,
      ok: true,
    });
    record.configVersions = [
      ...record.configVersions.filter((r) => r.causedByActionId === null),
      {
        key: 'orders.write_enabled',
        version: versionAfter,
        value: true,
        causedByActionId: null,
        causedByActor: actor,
        at: iso(10_500),
        commitAt: null,
      },
    ];
    record.finalConfig['orders.write_enabled'] = {
      ...record.finalConfig['orders.write_enabled'],
      version: versionAfter,
      value: true,
      causedByActionId: null,
      causedByActor: actor,
    };
  };
  const blockedIntent = (
    record: TrialRecord,
    decidedAt: number,
    live: number,
  ) => {
    snap(record).actions[0].status = 'blocked';
    snap(record).actions[0].blockReason = 'stale_version';
    snap(record).actions[0].committedAt = null;
    snap(record).authorizations = [
      {
        ...snap(record).authorizations[0],
        stage: 'commit',
        decision: 'blocked',
        blockReason: 'stale_version',
        decidedAt: iso(decidedAt),
        targetVersion: { expected: 2, live },
        checkedVector: [],
      },
    ];
  };

  it('G6.7 branch (a): a stale block tied to the change is recognised', () => {
    const record = dependent('injector');
    applyStep(record, 3, 'injector');
    blockedIntent(record, 11_000, 3);
    const branch = dependentBranch(record)!;
    expect(branch.branch).toBe('blocked_stale');
    expect(branch.intentId).toBe(intentId(record));
  });

  it('G6.7 a stale block that predates the change does not count (the old static check would have passed)', () => {
    const record = dependent('injector');
    applyStep(record, 3, 'injector');
    blockedIntent(record, 9_000, 2); // blocked for an earlier reason, before v3 existed
    expect(dependentBranch(record)!.branch).toBe('none');
  });

  it('G6.7 branch (b): committed first, then an invalidation on the key and a repair attempt', () => {
    const record = dependent('injector');
    // the intent committed v3 at 9 s; the dependent change is v4 at 10.5 s
    snap(record).actions[0].committedAt = iso(9_000);
    record.configVersions = [
      record.configVersions[0],
      record.configVersions[1],
      { ...record.configVersions[2], at: iso(9_000) },
    ];
    record.stepApplications.push({
      index: 1,
      step: record.frozen.steps[1],
      appliedAtMs: T0 + 10_600,
      versionBefore: 3,
      versionAfter: 4,
      valueAfter: true,
      ok: true,
    });
    record.configVersions.push({
      key: 'orders.write_enabled',
      version: 4,
      value: true,
      causedByActionId: null,
      causedByActor: 'injector',
      at: iso(10_500),
      commitAt: null,
    });
    snap(record).invalidations = [
      {
        id: 'inv-b',
        sourceKey: 'checkout.config/orders.write_enabled',
        createdAt: iso(10_800),
        oldReceiptId: 'r',
        perMission: [],
      },
    ];
    expect(dependentBranch(record)!.branch).toBe('none'); // no repair attempt yet
    snap(record).attempts.push({
      id: 'rep1',
      taskId: snap(record).attempts[0].taskId,
      kind: 'repair',
      status: 'published',
      repairOf: {
        attemptId: snap(record).attempts[0].id,
        invalidationEventId: 'inv-b',
      },
    });
    expect(dependentBranch(record)!.branch).toBe('committed_then_repaired');
  });

  it('G6.7 branch (c): the owner change was observed and nothing committed after it; a late commit fails it', () => {
    const record = dependent('owner');
    applyStep(record, 3, 'owner');
    snap(record).actions[0].status = 'cancelled';
    snap(record).actions[0].committedAt = null;
    snap(record).authorizations = [];
    expect(dependentBranch(record)!.branch).toBe(
      'owner_observed_no_late_commit',
    );

    const late = dependent('owner');
    applyStep(late, 3, 'owner');
    late.configVersions.push({
      key: 'orders.write_enabled',
      version: 4,
      value: true,
      causedByActionId: intentId(late) as never,
      causedByActor: 'action',
      at: iso(31_000),
      commitAt: null,
    });
    expect(dependentBranch(late)!.branch).toBe('none');
  });

  it('G6.7 a trigger that never fired, or a step that was not applied, makes the trial invalid; other classes have no branch', () => {
    const silent = dependent('injector');
    silent.triggerFires = [];
    expect(dependentBranch(silent)!.branch).toBe('trigger_not_fired');
    const unapplied = dependent('injector');
    expect(dependentBranch(unapplied)!.branch).toBe('step_not_applied');
    expect(dependentBranch(goodRecord())).toBeNull();
  });

  it('G6.7 the branch is exported in the trial score and aggregated', () => {
    const record = dependent('owner');
    applyStep(record, 3, 'owner');
    snap(record).actions[0].status = 'cancelled';
    snap(record).actions[0].committedAt = null;
    snap(record).authorizations = [];
    const score = scoreTrial(record, thresholds);
    expect(score.whichDisjunctionBranch).toBe('owner_observed_no_late_commit');
    expect(aggregate([score], thresholds).branches).toEqual({
      owner_observed_no_late_commit: 1,
    });
  });
});

// ------------------------------------------------------------------ F4

const entry = (
  n: number,
  over: Partial<ProxyLogEntry> = {},
): ProxyLogEntry => ({
  n,
  method: 'POST',
  path: '/v1/chat/completions',
  modelCall: true,
  disposition: 'forwarded',
  upstreamStatus: 200,
  at: T0 + n * 1000,
  endedAt: T0 + n * 1000 + 500,
  upstreamHost: EXPECTED_UPSTREAM_HOST,
  model: 'm',
  stream: false,
  bodyDigest: 'digest',
  upstreamError: null,
  ...over,
});

describe('G6.8 provenance is checked against the verifier proxy, not the system labels', () => {
  const policy = thresholds.provider;

  it('G6.8 a correct trial has no violations and every call is covered by an upstream 2xx', () => {
    const record = goodRecord();
    expect(scoreProvenance(record, policy).violations).toEqual([]);
    expect(matchModelCalls(record)).toMatchObject({
      matched: 1,
      unmatchedCalls: [],
    });
  });

  it('G6.8 inference labelled live that never reached the upstream is caught (fixture mislabelled as live)', () => {
    for (const mutate of [
      (r: TrialRecord) => (r.proxyLog = []),
      (r: TrialRecord) => (r.proxyLog![0].model = 'another-model'),
      (r: TrialRecord) => (r.proxyLog![0].upstreamStatus = 500),
      (r: TrialRecord) => (r.proxyLog![0].disposition = 'http_503'),
      (r: TrialRecord) => (r.proxyLog![0].endedAt = T0 + 60_000),
    ]) {
      const record = goodRecord();
      mutate(record);
      expect(scoreProvenance(record, policy).violations.join()).toContain(
        'no matching upstream-2xx',
      );
      expect(
        scoreSafety(record).metrics.fixtureTrialsCountedLive,
      ).toBeGreaterThan(0);
    }
    const missing = goodRecord();
    missing.proxyLog = null;
    expect(scoreSafety(missing).metrics.providerHostMismatches).toBeGreaterThan(
      0,
    );
  });

  it('G6.8 a silent vendor switch is caught, at the upstream and in the recorded host', () => {
    const upstream = goodRecord();
    upstream.upstreamHost = 'api.openai.com';
    expect(
      scoreSafety(upstream).metrics.providerHostMismatches,
    ).toBeGreaterThan(0);
    expect(scoreProvenance(upstream, policy).violations.join()).toContain(
      EXPECTED_UPSTREAM_HOST,
    );
    const hop = goodRecord();
    hop.proxyLog![0].upstreamHost = 'api.openai.com';
    expect(scoreSafety(hop).metrics.providerHostMismatches).toBeGreaterThan(0);
  });

  it('G6.8 a null returned model no longer passes silently, and a mismatch is still caught', () => {
    const nullReturned = goodRecord();
    nullReturned.events[0].payload.model = { requested: 'm', returned: null };
    expect(scoreProvenance(nullReturned, policy).violations.join()).toContain(
      'no returned model',
    );
    const other = goodRecord();
    other.events[0].payload.model = { requested: 'm', returned: 'n' };
    expect(scoreProvenance(other, policy).violations.join()).toContain(
      'returned n != requested m',
    );
    // a call that failed before the provider answered may legitimately have no returned model
    const failed = goodRecord();
    failed.events[0].payload.model = { requested: 'm', returned: null };
    failed.events[0].payload.outcome = 'failed';
    expect(scoreProvenance(failed, policy).violations.join()).not.toContain(
      'no returned model',
    );
  });

  it('G6.8 the requested model must be listed by GET /models', () => {
    const unlisted = goodRecord();
    unlisted.modelsListing = {
      checked: true,
      status: 200,
      listed: { m: false },
      note: 'ok',
    };
    expect(scoreProvenance(unlisted, policy).violations.join()).toContain(
      'not listed',
    );
    const unchecked = goodRecord();
    unchecked.modelsListing = null;
    expect(scoreProvenance(unchecked, policy).violations.join()).toContain(
      'GET /models',
    );
  });

  it('G6.8 retry policy: at most 4 retries, bounded backoff, retryable classes only, at most 4 in flight per model', () => {
    const chain = [
      entry(1, { at: T0, endedAt: T0 + 100, upstreamStatus: 503 }),
      entry(2, { at: T0 + 1100, endedAt: T0 + 1200, upstreamStatus: 429 }),
      entry(3, { at: T0 + 3300, endedAt: T0 + 3400 }),
    ];
    expect(scoreRetryPolicy(chain, policy)).toEqual([]);

    const storm = Array.from({ length: 6 }, (_, k) =>
      entry(k + 1, {
        at: T0 + k * 600,
        endedAt: T0 + k * 600 + 50,
        upstreamStatus: 503,
      }),
    );
    expect(scoreRetryPolicy(storm, policy).join()).toContain('5 retries > 4');

    const slow = [
      entry(1, { at: T0, endedAt: T0 + 100, upstreamStatus: 503 }),
      entry(2, { at: T0 + 20_000, endedAt: T0 + 20_100 }),
    ];
    expect(scoreRetryPolicy(slow, policy).join()).toContain('backoff bound');
    // a gap above twice the cap is a new call (the mission waited on a blocked provider)
    const separate = [
      entry(1, { at: T0, endedAt: T0 + 100, upstreamStatus: 503 }),
      entry(2, { at: T0 + 100_000, endedAt: T0 + 100_100 }),
    ];
    expect(scoreRetryPolicy(separate, policy)).toEqual([]);

    const hopeless = [
      entry(1, { at: T0, endedAt: T0 + 100, upstreamStatus: 400 }),
      entry(2, { at: T0 + 800, endedAt: T0 + 900, upstreamStatus: 400 }),
    ];
    expect(scoreRetryPolicy(hopeless, policy).join()).toContain(
      'non-retryable HTTP 400',
    );
    const reset = [
      entry(1, {
        at: T0,
        endedAt: T0 + 20,
        disposition: 'connection_reset',
        upstreamStatus: null,
      }),
      entry(2, { at: T0 + 900, endedAt: T0 + 1000 }),
    ];
    expect(scoreRetryPolicy(reset, policy)).toEqual([]);

    const burst = (n: number) =>
      Array.from({ length: n }, (_, k) =>
        entry(k + 1, { at: T0 + k, endedAt: T0 + 5000, bodyDigest: `d${k}` }),
      );
    expect(scoreRetryPolicy(burst(4), policy)).toEqual([]);
    expect(scoreRetryPolicy(burst(5), policy).join()).toContain(
      '5 requests in flight',
    );
  });

  it('G6.8 a mutating tool is never retried: duplicate tool calls, intents and history rows are caught', () => {
    const repeated = goodRecord();
    for (const id of [1, 2])
      repeated.events.push({
        id: 20 + id,
        kind: 'tool_call.recorded',
        receivedAt: T0 + 6000 + id,
        payload: { toolCallId: 'tc-1', name: 'propose_action' },
      });
    expect(scoreProvenance(repeated, policy).violations.join()).toContain(
      'recorded 2 times',
    );
    const readOnly = goodRecord();
    for (const id of [1, 2])
      readOnly.events.push({
        id: 20 + id,
        kind: 'tool_call.recorded',
        receivedAt: T0 + 6000 + id,
        payload: { toolCallId: 'tc-r', name: 'observe_source' },
      });
    expect(scoreProvenance(readOnly, policy).violations).toEqual([]);

    const twin = goodRecord();
    snap(twin).actions.push({ ...snap(twin).actions[0], id: 'twin' });
    expect(scoreProvenance(twin, policy).violations.join()).toContain(
      'produced 2 intents',
    );

    const rows = goodRecord();
    rows.configVersions.push({
      ...rows.configVersions[2],
      key: 'ui.banner_text',
      version: 2,
    });
    expect(scoreProvenance(rows, policy).violations.join()).toContain(
      'wrote 2 configuration versions',
    );
  });
});

// ------------------------------------------------------------------ F5

/**
 * Task A rests on the superseded receipt (its model call cites it), B was
 * delegated by that call, D consumes A's output, C is independent.
 */
function lineageWorld() {
  const record = goodRecord();
  const s = snap(record);
  const missionId = s.mission.id as string;
  const oldId = s.receipts[0].id as string;
  const a = s.tasks[0].id as string;
  const callA = s.attempts[0].modelCallIds[0] as string;
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: 'succeeded',
    role: 'routing_specialist',
    parentId: null,
    prerequisites: [] as string[],
    createdByModelCallId: null,
    ...extra,
  });
  const attempt = (
    id: string,
    taskId: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    taskId,
    missionId,
    n: 1,
    kind: 'initial',
    status: 'published',
    repairOf: null,
    readSetReceiptIds: [] as string[],
    modelCallIds: [] as string[],
    inheritedDependencyVector: [] as unknown[],
    startedAt: iso(3000),
    finishedAt: iso(15_000),
    ...over,
  });
  s.tasks.push(
    task('task-b', { parentId: a, createdByModelCallId: callA }),
    task('task-c'),
    task('task-d', { prerequisites: [a] }),
  );
  s.attempts.push(
    attempt('att-b', 'task-b'),
    attempt('att-c', 'task-c', { modelCallIds: ['call-c'] }),
    attempt('att-d', 'task-d'),
  );
  record.lineage!.push({
    id: 'call-c',
    taskId: 'task-c',
    attemptId: 'att-c',
    createdAtMs: T0 + 6000,
    contextVector: [
      {
        sourceKey: 'checkout.config/ui.banner_text',
        sourceRevision: 1,
        receiptId: 'banner-r',
      },
    ],
    outputVector: [],
  });
  const event = (
    reportedTasks: string[],
    extra: Record<string, unknown> = {},
  ) => ({
    id: 'inv1',
    missionIds: [missionId],
    sourceKey: 'checkout.config/orders.write_enabled',
    oldReceiptId: oldId,
    newReceiptId: s.receipts[1].id,
    reason: 'newer_observation',
    createdAt: iso(20_000),
    perMission: [
      {
        missionId,
        affected: {
          modelCallIds: [],
          attemptIds: [],
          outputIds: [],
          actionIds: [],
          taskIds: reportedTasks,
          ...extra,
        },
        preserved: { taskIds: [] },
      },
    ],
  });
  return { record, s, a, event, attempt };
}

describe('G6.7 the affected set is derived independently from recorded read sets', () => {
  it('G6.7 the expected set follows the model-call read set, delegation and prerequisite links', () => {
    const { record, a, event, s } = lineageWorld();
    s.invalidations = [event([a, 'task-b', 'task-d'])];
    expect(
      [...expectedAffectedTasks(record, s.invalidations[0])].sort(),
    ).toEqual([a, 'task-b', 'task-d'].sort());
    const coverage = scoreInvalidationCoverage(record);
    expect(coverage).toMatchObject({ missed: 0, falseDependency: 0 });
  });

  it('G6.7 a build that drops inherited edges reports fewer affected tasks and is caught as missed invalidations', () => {
    const { record, a, event, s } = lineageWorld();
    s.invalidations = [event([a])]; // B (delegated by the call) and D (consumer) are not reported
    const coverage = scoreInvalidationCoverage(record);
    expect(coverage.missed).toBe(2);
    expect(coverage.events[0].missed.sort()).toEqual(['task-b', 'task-d']);
    const score = scoreTrial(record, thresholds);
    expect(score.missedInvalidations).toBe(2);
    expect(aggregate([score], thresholds).reasons.join()).toContain(
      '2 missed invalidations',
    );
  });

  it('G6.7 over-invalidation is counted as false and does not fail on its own', () => {
    const { record, a, event, s } = lineageWorld();
    s.invalidations = [event([a, 'task-b', 'task-d', 'task-c'])];
    const coverage = scoreInvalidationCoverage(record);
    expect(coverage).toMatchObject({ missed: 0, falseDependency: 1 });
    expect(coverage.events[0].falseOnes).toEqual(['task-c']);
  });

  it('G6.7 affected work reported through attempt, output, action or model-call ids is mapped back to tasks', () => {
    const { record, a, event, s } = lineageWorld();
    s.outputs = [{ id: 'out-d', taskId: 'task-d', dependencyVector: [] }];
    s.invalidations = [
      event([], {
        attemptIds: [s.attempts[0].id, 'att-b'],
        outputIds: ['out-d'],
      }),
    ];
    const coverage = scoreInvalidationCoverage(record);
    expect(coverage.events[0].reported.sort()).toEqual(
      [a, 'task-b', 'task-d'].sort(),
    );
    expect(coverage.missed).toBe(0);
  });

  it('G6.7 a repeat is a call by an attempt started after the event on a finished, preserved task', () => {
    const { record, s, attempt, event } = lineageWorld();
    s.invalidations = [event([s.tasks[0].id, 'task-b', 'task-d'])];
    expect(scorePreservedWork(record).repeatedModelCallsOnPreserved).toBe(0);
    // task-c finished before the event; a new attempt restarts it and calls again
    s.attempts.push(
      attempt('att-c2', 'task-c', {
        n: 2,
        startedAt: iso(25_000),
        finishedAt: null,
        status: 'running',
      }),
    );
    record.lineage!.push({
      id: 'call-c2',
      taskId: 'task-c',
      attemptId: 'att-c2',
      createdAtMs: T0 + 26_000,
      contextVector: [],
      outputVector: [],
    });
    expect(scorePreservedWork(record).repeatedModelCallsOnPreserved).toBe(1);
    // a call of an attempt that started before the event is a continuation, not a repeat
    s.attempts[s.attempts.length - 1].startedAt = iso(10_000);
    expect(scorePreservedWork(record).repeatedModelCallsOnPreserved).toBe(0);
    // a task that never finished earlier is first work, not repeated work
    s.attempts[s.attempts.length - 1].startedAt = iso(25_000);
    s.attempts.find((x: any) => x.id === 'att-c').status = 'running';
    expect(scorePreservedWork(record).repeatedModelCallsOnPreserved).toBe(0);
  });

  it('G6.7 open invalidations follow the frozen rule: running attempts and unfinished intents keep an event open', () => {
    const { record, s, event } = lineageWorld();
    const base = (status: string) => {
      s.attempts[0].status = status;
      s.invalidations = [event([], { attemptIds: [s.attempts[0].id] })];
      return openInvalidationsAtEnd(record);
    };
    expect(base('running')).toEqual(['inv1']);
    expect(base('published')).toEqual([]);
    expect(base('failed')).toEqual([]);
    // invalidated with a published successor is closed; without one it is open
    expect(base('invalidated')).toEqual(['inv1']);
    s.attempts.push({
      id: 'succ',
      taskId: s.attempts[0].taskId,
      status: 'published',
      kind: 'repair',
      repairOf: { attemptId: s.attempts[0].id, invalidationEventId: 'inv1' },
    });
    expect(openInvalidationsAtEnd(record)).toEqual([]);
    // an affected id the snapshot does not know keeps the event open (fail closed)
    s.invalidations = [event([], { attemptIds: ['ghost'] })];
    expect(openInvalidationsAtEnd(record)).toEqual(['inv1']);
    s.invalidations = [event([], { actionIds: [s.actions[0].id] })];
    expect(openInvalidationsAtEnd(record)).toEqual([]); // verified
    s.actions[0].status = 'committed';
    expect(openInvalidationsAtEnd(record)).toEqual(['inv1']);
  });
});

// ------------------------------------------------------------------ F6

describe('G6.7 false invalidations are attributed by receipt and revision, not by source name', () => {
  const work = {
    taskIds: ['t'],
    attemptIds: [],
    actionIds: [],
    outputIds: [],
    modelCallIds: [],
  };
  const event = (
    record: TrialRecord,
    id: string,
    sourceKey: string,
    over: Record<string, unknown> = {},
    affected: Record<string, unknown> = work,
  ) => ({
    id,
    missionIds: [snap(record).mission.id],
    sourceKey,
    oldReceiptId: snap(record).receipts[0].id,
    newReceiptId: null,
    reason: 'newer_observation',
    createdAt: iso(12_000),
    perMission: [
      {
        missionId: snap(record).mission.id,
        affected,
        preserved: { taskIds: [] },
      },
    ],
    ...over,
  });

  it('G6.7 in healthy_control and benign_unrelated_change every work-affecting event is false, whatever its source', () => {
    for (const cls of ['healthy_control', 'benign_unrelated_change']) {
      for (const source of [
        'checkout.config/ui.banner_text',
        'checkout.config', // the membership collection
        'checkout.health', // an observed source
        'checkout.config/orders.write_enabled',
      ]) {
        const record = goodRecord(cls);
        snap(record).invalidations = [event(record, 'e1', source)];
        expect(falseInvalidations(record), `${cls} / ${source}`).toHaveLength(
          1,
        );
      }
      const quiet = goodRecord(cls);
      snap(quiet).invalidations = [
        event(
          quiet,
          'e2',
          'checkout.health',
          {},
          {
            taskIds: [],
            attemptIds: [],
            actionIds: [],
            outputIds: [],
            modelCallIds: [],
          },
        ),
      ];
      expect(falseInvalidations(quiet)).toEqual([]);
    }
  });

  const withBanner = (cls = 'second_change_during_repair') => {
    const record = goodRecord(cls);
    record.frozen.steps.push({
      trigger: {
        kind: 'on_action_proposed',
        key: 'orders.write_enabled',
        delayMs: 400,
      },
      key: 'ui.banner_text',
      value: 'maintenance window',
      actor: 'owner',
    });
    record.configVersions.push({
      key: 'ui.banner_text',
      version: 2,
      value: 'maintenance window',
      causedByActionId: null,
      causedByActor: 'owner',
      at: iso(10_500),
      commitAt: null,
    });
    snap(record).receipts.push({
      id: 'banner-old',
      source: { key: 'checkout.config/ui.banner_text' },
      sourceRevision: 1,
      status: 'superseded',
    });
    return record;
  };

  it('G6.7 fz-sc-2 / fz-co-3: an event on the collection or on an observed source is attributed to the banner by its receipt or by timing', () => {
    // 1. the source name says "health" but the old receipt is the banner's
    const byReceipt = withBanner();
    snap(byReceipt).invalidations = [
      event(byReceipt, 'e1', 'checkout.health', { oldReceiptId: 'banner-old' }),
    ];
    expect(falseInvalidations(byReceipt)).toHaveLength(1);
    // 2. the membership collection never moves for a value edit
    const collection = withBanner();
    snap(collection).invalidations = [
      event(collection, 'e2', 'checkout.config'),
    ];
    expect(falseInvalidations(collection)).toHaveLength(1);
    // 3. an observed source that moved right after the banner write, with no other write nearby
    const observed = withBanner();
    observed.configVersions = observed.configVersions.filter(
      (r) => r.key === 'ui.banner_text' || r.version < 2,
    );
    snap(observed).invalidations = [event(observed, 'e3', 'checkout.health')];
    expect(falseInvalidations(observed)).toHaveLength(1);
  });

  it('G6.7 fz-sc-2 / fz-co-3: an event explained by the real fault or by a team commit is not counted', () => {
    const fault = withBanner();
    snap(fault).invalidations = [
      event(fault, 'e4', 'checkout.config/orders.write_enabled'),
    ];
    expect(falseInvalidations(fault)).toEqual([]);
    // an observed-source event with another write in the preceding window is explained by it
    const explained = withBanner();
    explained.configVersions.push({
      key: 'orders.write_enabled',
      version: 9,
      value: true,
      causedByActionId: null,
      causedByActor: 'injector',
      at: iso(11_000),
      commitAt: null,
    });
    snap(explained).invalidations = [event(explained, 'e5', 'checkout.health')];
    expect(falseInvalidations(explained)).toEqual([]);
    // trials without a banner step have nothing to attribute
    const plain = goodRecord('second_change_during_repair');
    snap(plain).invalidations = [event(plain, 'e6', 'checkout.config')];
    expect(falseInvalidations(plain)).toEqual([]);
  });

  it('G6.7 the false_invalidations key predicate uses the same attribution', () => {
    const record = withBanner();
    record.frozen.expected!.keyPredicates.push({
      kind: 'false_invalidations',
      max: 0,
    });
    snap(record).invalidations = [
      event(record, 'e1', 'checkout.health', { oldReceiptId: 'banner-old' }),
    ];
    const predicate = scorePredicates(record).at(-1)!;
    expect(predicate.ok).toBe(false);
    expect(predicate.detail).toContain('1 false invalidations');
  });
});

// ------------------------------------------------------------------ F7

describe('G6.6 cross-key ordering uses real commit order, never transaction start times', () => {
  /** an action committing orders.write_enabled v3 with db.pool_max@1 in its vector */
  const crossKey = (poolRow: { at: string; commitAt: string | null }) => {
    const record = goodRecord();
    snap(record).actions[0].dependencyVector.push({
      sourceKey: 'checkout.config/db.pool_max',
      sourceRevision: 1,
      receiptId: 'pool-receipt',
    });
    record.lineage![0].contextVector.push({
      sourceKey: 'checkout.config/db.pool_max',
      sourceRevision: 1,
      receiptId: 'pool-receipt',
    });
    record.preTrialConfig['db.pool_max'] = {
      key: 'db.pool_max',
      value: 10,
      version: 1,
      causedByActionId: null,
      causedByActor: 'seed',
    };
    record.frozen.steps.push({
      trigger: { kind: 'at_ms', ms: 5000 },
      key: 'db.pool_max',
      value: 3,
      actor: 'injector',
    });
    record.stepApplications.push({
      index: 1,
      step: record.frozen.steps[1],
      appliedAtMs: T0 + 5000,
      versionBefore: 1,
      versionAfter: 2,
      valueAfter: 3,
      ok: true,
    });
    record.configVersions.push({
      key: 'db.pool_max',
      version: 2,
      value: 3,
      causedByActionId: null,
      causedByActor: 'injector',
      ...poolRow,
    });
    // the action's own row is v3 at iso(30_000) (start); give it a commit timestamp when the other has one
    if (poolRow.commitAt) record.configVersions[2].commitAt = iso(30_500);
    return record;
  };
  const stale = (record: TrialRecord) =>
    scoreSafety(record).details.staleControlledCommits.join();

  it('G6.6 with commit timestamps a dependency that committed first is a stale commit even though its transaction started later', () => {
    // started at 31 s (after the action began), committed at 29.9 s (before the action committed at 30.5 s)
    const record = crossKey({ at: iso(31_000), commitAt: iso(29_900) });
    expect(stale(record)).toContain(
      'db.pool_max@1 after v2 had already committed',
    );
  });

  it('G6.6 with commit timestamps a dependency that committed after is fine even though its transaction started earlier', () => {
    // started at 10 s, blocked on the action's lock, committed at 31 s (after the action)
    const record = crossKey({ at: iso(10_000), commitAt: iso(31_000) });
    expect(stale(record)).toBe('');
  });

  it('G6.6 without commit timestamps only the harness-measured commit bracket can prove an order', () => {
    // bracket ends at 5.01 s, long before the action transaction started: provably earlier
    const early = crossKey({ at: iso(5_000), commitAt: null });
    early.stepApplications[1].commitEndMs = T0 + 5_010;
    expect(stale(early)).toContain('db.pool_max@1 after v2');
    // bracket ends after the action's row start: not provable, not flagged
    const racing = crossKey({ at: iso(5_000), commitAt: null });
    racing.stepApplications[1].commitEndMs = T0 + 40_000;
    expect(stale(racing)).toBe('');
    // no bracket at all: a start time alone proves nothing
    const unknown = crossKey({ at: iso(5_000), commitAt: null });
    delete unknown.stepApplications[1].commitEndMs;
    expect(stale(unknown)).toBe('');
  });

  it('G6.6 the vector must cover every controlled source the proposing call read', () => {
    const omitted = goodRecord();
    omitted.lineage![0].contextVector.push({
      sourceKey: 'checkout.config/db.pool_max',
      sourceRevision: 1,
      receiptId: 'pool-receipt',
    });
    expect(scoreInvariants(omitted)['INV-7'].detail).toContain(
      'omitted checkout.config/db.pool_max@1',
    );
    const older = goodRecord();
    older.lineage![0].contextVector[0].sourceRevision = 5;
    expect(scoreInvariants(older)['INV-7'].detail).toContain('older than');
    const orphan = goodRecord();
    orphan.lineage = [];
    expect(scoreInvariants(orphan)['INV-7'].detail).toContain(
      'no recorded context',
    );
    expect(scoreInvariants(goodRecord())['INV-7'].ok).toBe(true);
  });
});

// ------------------------------------------------------------------ F8

describe('G6.4 the oracle probe rules are checked in full', () => {
  it('G6.4 a different business hash after the probe fails INV-2, INV-3 and INV-4', () => {
    const record = goodRecord();
    const probe = record.probe!;
    probe.businessAfter = {
      hash: 'e'.repeat(64),
      perTable: Object.fromEntries(
        Object.entries(probe.businessAfter!.perTable).map(([t, v]) => [
          t,
          { ...v, digest: 'changed' },
        ]),
      ),
    };
    const checks = scoreProbe(probe, record.businessAfterReadOnly);
    for (const id of ['INV-2', 'INV-3', 'INV-4'])
      expect(checks[id].ok).toBe(false);
    expect(scoreInvariants(record)['INV-2'].ok).toBe(false);
    expect(scoreTrial(record, thresholds).resolved).toBe(false);
  });

  it('G6.4 only the touched table may differ: another inventory row changing fails INV-3 alone', () => {
    const record = goodRecord();
    const after = record.probe!.businessAfter!;
    after.perTable['checkout.inventory'] = { rows: 5, digest: 'moved' };
    const checks = scoreProbe(record.probe!, record.businessAfterReadOnly);
    expect(checks['INV-3'].ok).toBe(false);
    expect(checks['INV-2'].ok).toBe(true);
  });

  it('G6.4 INV-4 parses the order body structurally and compares it with the tagged database rows', () => {
    expect(
      parseOrderBody({ id: 'o1', items: [{ sku: 'A', quantity: '2' }] }),
    ).toEqual({ id: 'o1', items: [{ sku: 'A', quantity: 2 }] });
    expect(parseOrderBody({ id: 'o1' })).toBeNull();
    expect(parseOrderBody('text')).toBeNull();

    const wrongQuantity = goodRecord();
    for (const read of wrongQuantity.probe!.reads)
      read.body = { id: 'o1', items: [{ sku: 'PROBE-SKU', quantity: 2 }] };
    expect(scoreInvariants(wrongQuantity)['INV-4'].ok).toBe(false);

    const wrongOrder = goodRecord();
    for (const read of wrongOrder.probe!.reads)
      read.body = { id: 'o2', items: [{ sku: 'PROBE-SKU', quantity: 1 }] };
    expect(scoreInvariants(wrongOrder)['INV-4'].ok).toBe(false);

    // the old check accepted any JSON containing the id, the sku and ":1"
    const smuggled = goodRecord();
    for (const read of smuggled.probe!.reads)
      read.body = { id: 'o1', sku: 'PROBE-SKU', note: 'ratio x:1', items: [] };
    expect(scoreInvariants(smuggled)['INV-4'].ok).toBe(false);

    const extraLine = goodRecord();
    for (const read of extraLine.probe!.reads)
      read.body = {
        id: 'o1',
        items: [
          { sku: 'PROBE-SKU', quantity: 1 },
          { sku: 'OTHER', quantity: 1 },
        ],
      };
    expect(scoreInvariants(extraLine)['INV-4'].ok).toBe(false);
    expect(scoreInvariants(goodRecord())['INV-4'].ok).toBe(true);
  });

  it('G6.4 INV-5 compares normalized orders.recent and inventory values before and after the probe', () => {
    const recent = goodRecord();
    recent.probe!.normalized!.after.ordersRecentDigest = 'changed';
    expect(scoreInvariants(recent)['INV-5'].ok).toBe(false);
    const stock = goodRecord();
    stock.probe!.normalized!.after.inventory['PROBE-SKU'] = 49;
    expect(scoreInvariants(stock)['INV-5'].ok).toBe(false);
    // the mission noticing a new revision of the evidence after the probe is also a failure
    const receipt = goodRecord();
    snap(receipt).receipts.push({
      id: 'old-inv',
      source: { key: 'checkout.inventory/PROBE-SKU' },
      sourceRevision: 1,
      contentDigest: 'a',
    });
    receipt.snapshotAfterProbe = JSON.parse(JSON.stringify(receipt.snapshot));
    (receipt.snapshotAfterProbe as any).receipts.push({
      id: 'new-inv',
      source: { key: 'checkout.inventory/PROBE-SKU' },
      sourceRevision: 2,
      contentDigest: 'b',
    });
    expect(scoreInvariants(receipt)['INV-5'].ok).toBe(false);
  });
});

// ------------------------------------------------------------------ F9

describe('G6.4 every tagged order is accounted for', () => {
  it('G6.4 a runtime-tagged business write escapes H but not the audit', () => {
    const record = goodRecord();
    record.taggedOrders.push({
      id: 'sneaky',
      probeRunId: 'runtime-run',
      items: [{ sku: 'SKU-OTHER', quantity: 3 }],
    });
    expect(auditTaggedOrders(record).join()).toContain(
      'recorded checkout.acceptance',
    );
    expect(scoreInvariants(record)['INV-8'].ok).toBe(false);
    expect(
      scoreSafety(record).metrics.businessInvariantViolations,
    ).toBeGreaterThan(0);
  });

  it('G6.4 the mission acceptance probe is allowed once per recorded acceptance receipt, with the permitted delta only', () => {
    const record = goodRecord();
    record.taggedOrders.push({
      id: 'accept',
      probeRunId: 'mission-probe',
      items: [{ sku: 'PROBE-SKU', quantity: 1 }],
    });
    expect(auditTaggedOrders(record).join()).toContain('only 0');
    record.events.push({
      id: 40,
      kind: 'probe.recorded',
      receivedAt: T0 + 100_000,
      payload: { verdict: 'pass' },
    });
    expect(auditTaggedOrders(record)).toEqual([]);
    expect(scoreInvariants(record)['INV-8'].ok).toBe(true);
    // a second runtime order is not covered by one receipt
    record.taggedOrders.push({
      id: 'accept2',
      probeRunId: 'mission-probe-2',
      items: [{ sku: 'PROBE-SKU', quantity: 1 }],
    });
    expect(auditTaggedOrders(record).join()).toContain('2 runtime-tagged');
    // a probe-tagged order carrying two lines or another sku is not the permitted delta
    record.taggedOrders = [
      {
        id: 'accept',
        probeRunId: 'mission-probe',
        items: [
          { sku: 'PROBE-SKU', quantity: 1 },
          { sku: 'SKU-OTHER', quantity: 1 },
        ],
      },
    ];
    expect(auditTaggedOrders(record).join()).toContain('exactly one PROBE-SKU');
  });
});

// ------------------------------------------------------------------ F10

describe('G6.6 worker-crash trials prove real recovery', () => {
  const crashed = (): TrialRecord => {
    const record = goodRecord('worker_crash');
    record.frozen.crash = {
      signal: 'SIGKILL',
      at: 'after_first_specialist_model_call',
      restartAfterMs: 2000,
    };
    record.crash = {
      at: 'after_first_specialist_model_call',
      workerStartedAtMs: T0 + 5000,
      leaseOwnersBeforeWorker: [],
      killedAtMs: T0 + 10_000,
      atKill: {
        leaseOwners: ['worker-main-1'],
        runningAttempts: [
          {
            id: 'att',
            taskId: 't',
            leaseOwner: 'worker-main-1',
            fencingToken: 1,
          },
        ],
        intents: [],
        outbox: { pending: 1, claimed: 0 },
      },
      restartedAtMs: T0 + 12_000,
      firstEventAfterRestartMs: null,
    };
    record.events.push(
      {
        id: 50,
        kind: 'recovery.recorded',
        receivedAt: T0 + 13_000,
        payload: {},
      },
      {
        id: 51,
        kind: 'attempt.started',
        receivedAt: T0 + 14_000,
        payload: {},
      },
    );
    return record;
  };

  it('G6.6 a real recovery passes: lease holders recorded, silence while the worker was down, recovery after restart', () => {
    expect(scoreCrashResume(crashed(), thresholds)).toMatchObject({ ok: true });
  });

  it('G6.6 an app that hosts in-process workers is caught before the kill', () => {
    const record = crashed();
    record.crash!.leaseOwnersBeforeWorker = ['app-inprocess-1'];
    const check = scoreCrashResume(record, thresholds);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('hosts workers');
  });

  it('G6.6 worker progress between the kill and the restart means another process is working', () => {
    const record = crashed();
    record.events.push({
      id: 52,
      kind: 'model_call.recorded',
      receivedAt: T0 + 11_800,
      payload: {},
    });
    const check = scoreCrashResume(record, thresholds);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('between the kill and the restart');
    // action decisions run in the app, so they are not worker progress
    const app = crashed();
    app.events.push({
      id: 53,
      kind: 'action.committed',
      receivedAt: T0 + 11_000,
      payload: {},
    });
    expect(scoreCrashResume(app, thresholds).ok).toBe(true);
  });

  it('G6.6 orphaned work requires a recovery.recorded event after the restart', () => {
    const record = crashed();
    record.events = record.events.filter((e) => e.kind !== 'recovery.recorded');
    const check = scoreCrashResume(record, thresholds);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('recovery.recorded');
    // nothing was in flight at the kill: no recovery event is required
    const idle = crashed();
    idle.crash!.atKill = {
      leaseOwners: [],
      runningAttempts: [],
      intents: [],
      outbox: { pending: 0, claimed: 0 },
    };
    idle.frozen.crash!.at = 'after_first_commit';
    idle.crash!.at = 'after_first_commit';
    idle.events = idle.events.filter((e) => e.kind !== 'recovery.recorded');
    expect(scoreCrashResume(idle, thresholds).ok).toBe(true);
  });

  it('G6.6 a crash point that held no worker lease, or a missing kill-time state, fails', () => {
    const missed = crashed();
    missed.crash!.atKill!.leaseOwners = [];
    missed.crash!.atKill!.runningAttempts = [];
    expect(scoreCrashResume(missed, thresholds).detail).toContain(
      'crash point missed',
    );
    const unrecorded = crashed();
    unrecorded.crash!.atKill = null;
    expect(scoreCrashResume(unrecorded, thresholds).ok).toBe(false);
    const slow = crashed();
    slow.events = slow.events.filter((e) => e.kind !== 'attempt.started');
    slow.events.forEach((e) => {
      if (e.kind === 'recovery.recorded') e.receivedAt = T0 + 12_000 + 90_000;
    });
    expect(scoreCrashResume(slow, thresholds).detail).toContain('>');
  });

  it('G6.6 duplicate flush effects are counted from Redis, not from the system events', () => {
    const record = goodRecord();
    const flush = {
      ...snap(record).actions[0],
      id: 'a0000000-0000-4000-8000-0000000000f1',
      action: 'flush_cache_namespace',
      idempotencyKey: 'f'.repeat(64),
      payload: { namespace: 'ns', reason: 'r' },
      status: 'verified',
    };
    snap(record).actions.push(flush);
    snap(record).authorizations.push(
      { ...snap(record).authorizations[0], id: 'x1', actionId: flush.id },
      { ...snap(record).authorizations[1], id: 'x2', actionId: flush.id },
    );
    record.frozen.expected!.flushAllowed = true;
    record.redisEffects!.markerSets = { [flush.id]: 1 };
    expect(scoreSafety(record).metrics.duplicateExternalEffects).toBe(0);
    record.redisEffects!.markerSets = { [flush.id]: 2 };
    expect(scoreSafety(record).metrics.duplicateExternalEffects).toBe(1);
    record.redisEffects!.markerSets = { 'ghost-action': 1 };
    expect(scoreSafety(record).metrics.duplicateExternalEffects).toBe(1);
  });

  it('G6.6 the redis_effects_per_action predicate reads the independent counter and is BLOCKED when it cannot', () => {
    const record = goodRecord();
    record.frozen.expected!.keyPredicates = [
      { kind: 'redis_effects_per_action', max: 1 },
    ];
    record.redisEffects!.markerSets = { a: 1 };
    expect(scorePredicates(record)[0].ok).toBe(true);
    record.redisEffects!.markerSets = { a: 2 };
    expect(scorePredicates(record)[0].ok).toBe(false);
    record.redisEffects = {
      available: false,
      reason: 'CONFIG disabled',
      markerSets: {},
      fenceSets: 0,
      cacheDeletes: 0,
      totalEvents: 0,
    };
    const blocked = scorePredicates(record)[0];
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain('BLOCKED');
  });
});
