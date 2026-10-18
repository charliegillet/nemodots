import { describe, expect, it } from 'vitest';
import {
  runCohort,
  runTrial,
} from '../../../src/server/nemodots/evals/runner.js';
import {
  SUITES,
  planCohort,
} from '../../../src/server/nemodots/evals/suites.js';
import { FakeHost } from './fake-host.js';

const specs = (trials = 1, scenarios = ['diverging_edges']) =>
  planCohort({
    suite: SUITES.matched,
    trials,
    seed: 1,
    scenarios,
    cohortId: 'c',
  });

describe('runTrial', () => {
  it('runs the host in order, cancels the faults, scores independently and prices the trial', async () => {
    const host = new FakeHost();
    const [spec] = specs();
    const record = await runTrial(host, spec);
    expect(record).toMatchObject({
      schema: 'nemodots.eval.trial.v1',
      status: 'completed',
      countsAsLive: true,
      scenarioClass: 'diverging_edges',
      missionStatus: 'succeeded',
    });
    expect(record.score?.correctness.resolved).toBe(true);
    expect(record.cost?.source).toBe('estimate');
    expect(record.steps.map((s) => s.kind)).toContain('set_config');
    expect(record.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    const order = host.calls.map((c) => c.split(':')[0]);
    expect(order).toEqual(['prepare', 'faults', 'mission', 'faults']);
    expect(host.calls).toContain('faults:cancel');
  });

  it('a timed-out mission is cancelled, still observed and scored, and counts as a scored live trial (unresolved), not dropped', async () => {
    const host = new FakeHost({ timeoutAt: 0 });
    const record = await runTrial(host, specs()[0]);
    expect(record.status).toBe('timed_out');
    expect(record.countsAsLive).toBe(true);
    expect(record.score).not.toBeNull();
    expect(host.calls).toContain('cancel:M-0');
  });

  it('an error becomes a recorded error trial with the faults and mission cleaned up', async () => {
    const host = new FakeHost({ errorAt: 0 });
    const record = await runTrial(host, specs()[0]);
    expect(record.status).toBe('error');
    expect(record.note).toContain('database went away');
    expect(record.score).toBeNull();
  });

  it('a scenario whose symptom never appeared is precondition_failed: no mission starts and nothing is scored', async () => {
    const host = new FakeHost({ preconditionFailsAt: 0 });
    const record = await runTrial(host, specs()[0]);
    expect(record.status).toBe('precondition_failed');
    expect(record.note).toContain('scenario_precondition_failed');
    expect(record.note).toContain('cache_decode_error');
    expect(record.score).toBeNull();
    expect(record.cost).toBeNull();
    expect(record.countsAsLive).toBe(false);
    expect(record.missionId).toBeNull();
    // the mission was never started, so there is nothing to cancel
    expect(host.calls.some((c) => c.startsWith('mission:'))).toBe(false);
    expect(host.calls.some((c) => c.startsWith('cancel:'))).toBe(false);
  });

  it('a proposal-triggered step that never fired is not_exercised: observed and recorded, never scored or a pass', async () => {
    const host = new FakeHost({ notTriggeredAt: 0 });
    const record = await runTrial(host, specs()[0]);
    expect(record.status).toBe('not_exercised');
    expect(record.note).toContain('dependent_step_not_triggered');
    expect(record.note).toContain('step 1');
    expect(record.score).toBeNull();
    expect(record.countsAsLive).toBe(false);
    // the evidence stays on the record for diagnosis
    expect(record.observations).not.toBeNull();
    expect(record.missionId).toBe('M-0');
    expect(host.calls).toContain('faults:cancel');
  });

  it('a timed-out mission whose dependent step never fired is not_exercised too, not an unresolved score', async () => {
    const record = await runTrial(
      new FakeHost({ timeoutAt: 0, notTriggeredAt: 0 }),
      specs()[0],
    );
    expect(record.status).toBe('not_exercised');
    expect(record.score).toBeNull();
  });

  it('a blocked host yields a blocked trial naming what is missing', async () => {
    const record = await runTrial(new FakeHost({ blockAt: 0 }), specs()[0]);
    expect(record.status).toBe('blocked');
    expect(record.note).toContain('OPENAI_API_KEY');
  });

  it('a fixture host never counts as live', async () => {
    const record = await runTrial(
      new FakeHost({ mode: 'fixture' }),
      specs()[0],
    );
    expect(record.status).toBe('completed');
    expect(record.mode).toBe('fixture');
    expect(record.countsAsLive).toBe(false);
  });

  it('the neutral goal carries no scenario information', async () => {
    const seen: string[] = [];
    const host = new FakeHost();
    const original = host.startMission.bind(host);
    host.startMission = async (spec, goal) => {
      seen.push(goal);
      return original(spec, goal);
    };
    await runTrial(host, specs()[0]);
    expect(seen).toEqual([
      'Restore checkout availability while preserving customer data.',
    ]);
  });
});

describe('arm integrity', () => {
  it('a mission that ran under another recovery scope rule is recorded as an error, not scored or counted', async () => {
    const record = await runTrial(
      new FakeHost({ armRule: 'selective' }),
      specs()[0],
    );
    // specs()[0] is broad-restart: the database says selective
    expect(record.spec.strategy).toBe('broad-restart');
    expect(record.status).toBe('error');
    expect(record.note).toContain('ARM_MISMATCH');
    expect(record.note).toContain('selective');
    expect(record.score).toBeNull();
    expect(record.countsAsLive).toBe(false);
    expect(record.observations).not.toBeNull();
  });

  it('a mission whose model calls used another context layout is recorded as an error', async () => {
    const record = await runTrial(
      new FakeHost({ armLayout: 'ordinary' }),
      specs()[0],
    );
    expect(record.spec.layout).toBe('cache_aware');
    expect(record.status).toBe('error');
    expect(record.note).toContain('context layout ordinary');
  });

  it('matching arms are scored as usual', async () => {
    expect((await runTrial(new FakeHost(), specs()[0])).status).toBe(
      'completed',
    );
  });
});

describe('runCohort', () => {
  it('runs every trial in plan order and reports each as it completes', async () => {
    const host = new FakeHost();
    const plan = specs(1);
    const seen: number[] = [];
    const records = await runCohort(
      host,
      plan,
      {},
      { onTrial: (_r, i) => void seen.push(i) },
    );
    expect(records.map((r) => r.spec.trialId)).toEqual(
      plan.map((s) => s.trialId),
    );
    expect(seen).toEqual(plan.map((_, i) => i));
    expect(records.every((r) => r.status === 'completed')).toBe(true);
  });

  it('a blocked host stops the run and records the rest as blocked (nothing is silently dropped)', async () => {
    const host = new FakeHost({ blockAt: 1 });
    const plan = specs(1);
    const records = await runCohort(host, plan);
    expect(records).toHaveLength(plan.length);
    expect(records[0].status).toBe('completed');
    expect(records.slice(1).every((r) => r.status === 'blocked')).toBe(true);
    // the host was not asked to prepare again after the block
    expect(host.calls.filter((c) => c.startsWith('prepare'))).toHaveLength(2);
  });

  it('waits between trials when spacing is requested', async () => {
    const waits: number[] = [];
    await runCohort(
      new FakeHost(),
      specs(1),
      {},
      { spacingMs: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([5, 5, 5, 5]);
  });

  it('an error in one trial does not stop the others', async () => {
    const records = await runCohort(new FakeHost({ errorAt: 1 }), specs(1));
    expect(records.map((r) => r.status)).toEqual([
      'completed',
      'error',
      'completed',
      'completed',
      'completed',
    ]);
  });
});
