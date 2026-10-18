// Runs trials and cohorts. Every trial is recorded, including blocked, timed
// out and errored ones: the export contains them all (gate 8: "all trials
// exported"). A fixture host can run, but its trials are labelled and the
// aggregate never mixes them into live results.
import {
  loadScenario,
  manifestDigest,
  resolveScenario,
  type ResolvedStep,
  type ScenarioManifest,
} from '../sandbox/manifest.js';
import {
  HostBlockedError,
  isPreconditionFailure,
  type EnvironmentFacts,
  type EvalHost,
} from './host.js';
import type { Observations } from './observations.js';
import { scoreTrial, type TrialScore } from './scoring.js';
import { trialCost, type TrialCost } from './cost.js';
import type { ModelPrice } from '../telemetry/pricing.js';
import {
  NEUTRAL_MISSION_GOAL,
  type TrialSpec,
  type TrialStatus,
} from './types.js';

export const TRIAL_SCHEMA = 'nemodots.eval.trial.v1';

export interface TrialRecord {
  schema: typeof TRIAL_SCHEMA;
  spec: TrialSpec;
  scenarioClass: string;
  manifestDigest: string;
  /** the resolved steps for this seed, with the injected values (private raw data) */
  steps: ResolvedStep[];
  status: TrialStatus;
  /** why a trial is blocked/errored/timed out; never contains secrets */
  note: string | null;
  mode: EnvironmentFacts['mode'];
  /** scored live trial: the host was live and the mission ran to its end or to the time limit */
  countsAsLive: boolean;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  missionId: string | null;
  missionStatus: string | null;
  score: TrialScore | null;
  cost: TrialCost | null;
  /**
   * What the mission consumed, set on trials that are observed but not scored
   * (not_exercised) so the cohort spend still includes them. Scored trials
   * carry it in `score.efficiency`.
   */
  usage: TrialUsage | null;
  observations: Observations | null;
  environment: EnvironmentFacts;
}

export interface TrialUsage {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
}

export interface RunOptions {
  /** per-trial wall-clock limit (default 900 s, the gate-6 timing bound) */
  timeoutMs?: number;
  scenarioDir?: string;
  goal?: string;
  prices?: Record<string, ModelPrice> | null;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 900_000;

export async function runTrial(
  host: EvalHost,
  spec: TrialSpec,
  options: RunOptions = {},
): Promise<TrialRecord> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const manifest: ScenarioManifest = loadScenario(
    spec.scenarioId,
    options.scenarioDir,
  );
  const steps = resolveScenario(manifest, spec.seed);
  const base = {
    schema: TRIAL_SCHEMA,
    spec,
    scenarioClass: manifest.class,
    manifestDigest: manifestDigest(manifest),
    steps,
    mode: host.facts.mode,
    environment: host.facts,
    startedAt: startedAt.toISOString(),
  } as const;
  const finish = (
    status: TrialStatus,
    extra: Partial<TrialRecord> & { note?: string | null } = {},
  ): TrialRecord => {
    const finishedAt = now();
    // A timed-out live mission is a real, scored trial (unresolved at the limit);
    // dropping it would flatter every arm that is slow. Errors and blocks have no score.
    const scored = status === 'completed' || status === 'timed_out';
    return {
      ...base,
      status,
      note: extra.note ?? null,
      countsAsLive: scored && host.facts.mode === 'live',
      finishedAt: finishedAt.toISOString(),
      wallMs: finishedAt.getTime() - startedAt.getTime(),
      missionId: extra.missionId ?? null,
      missionStatus: extra.missionStatus ?? null,
      score: extra.score ?? null,
      cost: extra.cost ?? null,
      usage: extra.usage ?? null,
      observations: extra.observations ?? null,
    };
  };

  let faults: Awaited<ReturnType<EvalHost['startFaults']>> | null = null;
  let missionId: string | null = null;
  try {
    await host.prepare(spec, manifest, steps);
    faults = await host.startFaults(spec, manifest);
    const mission = await host.startMission(
      spec,
      options.goal ?? NEUTRAL_MISSION_GOAL,
    );
    missionId = mission.missionId;
    const end = await host.waitForEnd(
      mission.missionId,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (end.timedOut)
      await host.cancelMission(mission.missionId).catch(() => undefined);
    // the mission is over: ending the run also settles any fault step still
    // waiting for a proposal that never came
    const faultOutcome = await faults.cancel().catch(() => null);
    faults = null;
    const observations = await host.observe({
      spec,
      missionId: mission.missionId,
      startedAt: mission.startedAt,
      endedAt: end.endedAt,
    });
    const mismatch = armMismatch(spec, observations);
    if (mismatch)
      return finish('error', {
        missionId: mission.missionId,
        missionStatus: end.status,
        observations,
        note: `ARM_MISMATCH: ${mismatch} (the trial is recorded but not scored or counted)`,
      });
    if (faultOutcome && faultOutcome.notTriggered.length > 0) {
      // not scored, but the mission ran and spent: keep its usage and cost
      const spent = scoreTrial(manifest, steps, observations).efficiency;
      return finish('not_exercised', {
        missionId: mission.missionId,
        missionStatus: end.status,
        observations,
        usage: {
          modelCalls: spent.modelCalls,
          promptTokens: spent.promptTokens,
          completionTokens: spent.completionTokens,
          cachedTokens: spent.cachedTokens,
        },
        cost: trialCost(
          {
            promptTokens: spent.promptTokens,
            completionTokens: spent.completionTokens,
            cachedTokens: spent.cachedTokens,
          },
          host.facts.model,
          options.prices ?? null,
        ),
        note: `dependent_step_not_triggered: step ${faultOutcome.notTriggered.join(', ')} never fired because no matching proposal arrived before the mission ended (${end.status}); the fault schedule was not completed, so the trial is recorded but not scored and is not a pass`,
      });
    }
    const score = scoreTrial(manifest, steps, observations);
    const cost = trialCost(
      {
        promptTokens: score.efficiency.promptTokens,
        completionTokens: score.efficiency.completionTokens,
        cachedTokens: score.efficiency.cachedTokens,
      },
      host.facts.model,
      options.prices ?? null,
    );
    return finish(end.timedOut ? 'timed_out' : 'completed', {
      missionId: mission.missionId,
      missionStatus: end.status,
      score,
      cost,
      observations,
      note: end.timedOut
        ? 'the mission was cancelled at the trial time limit'
        : null,
    });
  } catch (error) {
    await faults?.cancel().catch(() => undefined);
    if (missionId) await host.cancelMission(missionId).catch(() => undefined);
    if (error instanceof HostBlockedError)
      return finish('blocked', { note: error.message, missionId });
    if (isPreconditionFailure(error))
      return finish('precondition_failed', {
        note: error.message.slice(0, 700),
        missionId,
      });
    return finish('error', {
      note: `${(error as Error).name}: ${(error as Error).message}`.slice(
        0,
        500,
      ),
      missionId,
    });
  }
}

/**
 * The arm is verified from the database, not trusted from the request: a
 * mission that ran under another recovery scope rule or another context layout
 * is not a trial of this arm and must never reach the tables.
 */
export function armMismatch(spec: TrialSpec, obs: Observations): string | null {
  if (obs.arm.recoveryScopeRule !== spec.strategy)
    return `mission ran under recovery scope rule ${obs.arm.recoveryScopeRule ?? 'none'}, not ${spec.strategy}`;
  const wrong = obs.arm.contextLayouts.filter(
    (layout) => layout !== spec.layout,
  );
  if (wrong.length > 0)
    return `model calls used context layout ${wrong.join(',')}, not ${spec.layout}`;
  return null;
}

export interface CohortHooks {
  /** called after each trial, in order; the CLI appends the raw record here */
  onTrial?(
    record: TrialRecord,
    index: number,
    total: number,
  ): Promise<void> | void;
  /** wait between trials (prefix-cache spacing, rate limits) */
  sleep?(ms: number): Promise<void>;
  spacingMs?: number;
}

/** Sequential cohort run. A BLOCKED host stops the run: every remaining trial is recorded as blocked. */
export async function runCohort(
  host: EvalHost,
  specs: readonly TrialSpec[],
  options: RunOptions = {},
  hooks: CohortHooks = {},
): Promise<TrialRecord[]> {
  const records: TrialRecord[] = [];
  let blocked: string | null = null;
  for (const [index, spec] of specs.entries()) {
    if (index > 0 && hooks.spacingMs)
      await (
        hooks.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
      )(hooks.spacingMs);
    const record: TrialRecord = blocked
      ? skippedAsBlocked(host, spec, blocked, options)
      : await runTrial(host, spec, options);
    if (record.status === 'blocked' && !blocked) blocked = record.note;
    records.push(record);
    await hooks.onTrial?.(record, index, specs.length);
  }
  return records;
}

function skippedAsBlocked(
  host: EvalHost,
  spec: TrialSpec,
  note: string | null,
  options: RunOptions,
): TrialRecord {
  const manifest = loadScenario(spec.scenarioId, options.scenarioDir);
  const at = (options.now ?? (() => new Date()))().toISOString();
  return {
    schema: TRIAL_SCHEMA,
    spec,
    scenarioClass: manifest.class,
    manifestDigest: manifestDigest(manifest),
    steps: resolveScenario(manifest, spec.seed),
    status: 'blocked',
    note,
    mode: host.facts.mode,
    countsAsLive: false,
    startedAt: at,
    finishedAt: at,
    wallMs: 0,
    missionId: null,
    missionStatus: null,
    score: null,
    cost: null,
    usage: null,
    observations: null,
    environment: host.facts,
  };
}
