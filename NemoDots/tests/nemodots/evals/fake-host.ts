// A scripted EvalHost for runner/export tests. LABEL: deterministic double, not
// a measurement of anything. It derives observations from the arm so that the
// aggregate has something to differ on, and records what the runner asked of it.
import type {
  EndState,
  EnvironmentFacts,
  EvalHost,
  FaultOutcome,
  FaultRun,
} from '../../../src/server/nemodots/evals/host.js';
import {
  ScenarioPreconditionFailed,
  type PreconditionReport,
} from '../../../src/server/nemodots/sandbox/preconditions.js';
import { HostBlockedError } from '../../../src/server/nemodots/evals/host.js';
import type { Observations } from '../../../src/server/nemodots/evals/observations.js';
import type { TrialSpec } from '../../../src/server/nemodots/evals/types.js';
import { baseObservations } from './fixtures.js';

export interface FakeHostOptions {
  mode?: 'live' | 'fixture';
  /** throw HostBlockedError from prepare for the Nth trial (0-based) */
  blockAt?: number;
  errorAt?: number;
  timeoutAt?: number;
  /** startFaults rejects with scenario_precondition_failed for the Nth trial */
  preconditionFailsAt?: number;
  /** proposal-triggered steps that never fire, for the Nth trial */
  notTriggeredAt?: number | 'all';
  /** extra repeated work per strategy */
  repeated?: Partial<Record<TrialSpec['strategy'], number>>;
  cachedTokens?: number | null;
  /** override what the database says the mission ran under (arm-integrity tests) */
  /** the independent probe fails at the end (unresolved) */
  probeFails?: boolean;
  armRule?: string;
  armLayout?: string;
}

export class FakeHost implements EvalHost {
  facts: EnvironmentFacts;
  calls: string[] = [];
  private trial = -1;
  private current: TrialSpec | null = null;
  constructor(private readonly options: FakeHostOptions = {}) {
    this.facts = {
      mode: options.mode ?? 'live',
      instance: 'ci-evals',
      model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
      providerHost: 'api.example.test',
      commit: 'abc1234',
      node: 'v24',
      settings: {},
    };
  }
  async prepare(spec: TrialSpec) {
    this.trial += 1;
    this.current = spec;
    this.calls.push(`prepare:${spec.trialId}`);
    if (this.options.blockAt === this.trial)
      throw new HostBlockedError(
        ['OPENAI_API_KEY'],
        'BLOCKED: OPENAI_API_KEY missing',
      );
    if (this.options.errorAt === this.trial)
      throw new Error('database went away');
  }
  async startFaults(): Promise<FaultRun> {
    this.calls.push('faults:start');
    const spec = this.current!;
    if (this.options.preconditionFailsAt === this.trial) {
      const report: PreconditionReport = {
        status: 'failed',
        setup: [],
        visible: [
          {
            symptom: 'cache_decode_error',
            seen: false,
            detail: 'health ok',
          },
        ],
        failure: {
          phase: 'visible',
          message:
            'symptom not visible through the readers within 15000 ms: cache_decode_error (health ok)',
        },
        elapsedMs: 15_000,
      };
      throw new ScenarioPreconditionFailed(spec.scenarioId, 'run-1', report);
    }
    const never =
      this.options.notTriggeredAt === 'all' ||
      this.options.notTriggeredAt === this.trial;
    const outcome: FaultOutcome = {
      status: 'completed',
      notTriggered: never ? [1] : [],
      preconditions: null,
    };
    return {
      done: Promise.resolve(outcome),
      cancel: async () => {
        this.calls.push('faults:cancel');
        return outcome;
      },
    };
  }
  async startMission(spec: TrialSpec, _goal: string) {
    this.calls.push(`mission:${spec.strategy}/${spec.layout}`);
    return {
      missionId: `M-${this.trial}`,
      startedAt: '2026-10-18T10:00:00.000Z',
    };
  }
  async waitForEnd(): Promise<EndState> {
    const timedOut = this.options.timeoutAt === this.trial;
    return {
      status: timedOut ? 'running' : 'succeeded',
      timedOut,
      endedAt: '2026-10-18T10:01:00.000Z',
    };
  }
  async cancelMission(id: string) {
    this.calls.push(`cancel:${id}`);
  }
  async observe(): Promise<Observations> {
    const spec = this.current!;
    const obs = baseObservations();
    if (spec.scenarioId === 'healthy' || spec.scenarioId === 'benign_change') {
      // controls: the team correctly does nothing
      obs.intents = [];
      obs.invalidations = [];
      obs.configHistory = [];
    }
    if (this.options.probeFails)
      obs.independent = {
        probe: 'fail',
        failedInvariants: ['health_window_ok'],
        healthOk: false,
      };
    obs.arm = {
      recoveryScopeRule: this.options.armRule ?? spec.strategy,
      contextLayouts: [this.options.armLayout ?? spec.layout],
    };
    const extra = this.options.repeated?.[spec.strategy] ?? 0;
    if (extra)
      obs.tasks.find((t) => t.id === 'extra')!.attemptCount = 1 + extra;
    if (this.options.cachedTokens !== undefined)
      obs.telemetry.cachedTokens = this.options.cachedTokens;
    return obs;
  }
  async close() {
    this.calls.push('close');
  }
}
