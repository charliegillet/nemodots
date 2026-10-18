// The private fault injector (ARCHITECTURE.md section 9.3), role
// nemodots_injector.
//
// It applies a scenario manifest through the SAME version authority every
// controlled writer uses (`advanceConfig`, actor 'injector'), records its work
// in control.scenario_runs / control.fault_schedules (readable by
// nemodots_verifier only), and never supplies diagnoses, expected repairs or
// scenario ids to anything an agent can read: injector-caused revisions carry
// caused_by_actor = 'injector', which receipts redact.
//
// Step triggers:
//   immediate   applied as soon as its prerequisites (`after`) are applied
//   delay       applied `delayMs` after its prerequisites
//   dependent_change_after_proposal
//               armed on LISTEN nemodots_action_proposed; the NOTIFY payload
//               names the proposal's TARGET KEY only. When that key is one the
//               step lists, the injector advances it to the manifest's injected
//               value. The injector reads NO coordinator table (finding C15).
//               The wait has NO wall-clock limit of its own: it lasts as long
//               as the run (which ends with the mission, on cancel) unless the
//               manifest's `timeoutMs` or `maxRunMs` says otherwise. A step
//               that never fires is recorded as `dependent_step_not_triggered`
//               and listed in RunSummary.notTriggered; it is never a pass.
//
// Preconditions (manifest `preconditions`, deps.preconditions): `setup` runs
// before the first step, the initial steps (no `after`, not proposal-triggered)
// are applied, then the declared symptoms must be visible through the same
// readers an agent has. Every other step waits for that. `ScenarioRun.ready`
// reports the outcome; `startVerified` fails loudly as
// `scenario_precondition_failed` (ScenarioPreconditionFailed) so a run that
// never showed its symptom cannot be scored as a no-fault trial.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CONFIG_MEMBER_KEY_PATTERN } from '../contracts/ids.js';
import { withTransaction } from '../db/tx.js';
import {
  type ResolvedStep,
  type ScenarioManifest,
  manifestDigest,
  resolveScenario,
} from './manifest.js';
import {
  type PreconditionDeps,
  type PreconditionReport,
  ScenarioPreconditionFailed,
  runSetup,
  uncheckedReport,
  verifyVisible,
  DEFAULT_SYMPTOM_WITHIN_MS,
} from './preconditions.js';
import {
  type AdvanceConfigResult,
  advanceConfigUnconditionally,
  isStaleVersion,
} from './version-authority.js';

export const ACTION_PROPOSED_CHANNEL = 'nemodots_action_proposed';

export type StepStatus = 'applied' | 'skipped' | 'failed';

/** Step `error` values the callers branch on. */
export const DEPENDENT_STEP_NOT_TRIGGERED = 'dependent_step_not_triggered';
export const PRECONDITION_FAILED_STEP = 'scenario_precondition_failed';

export interface StepOutcome {
  index: number;
  status: StepStatus;
  key: string | null;
  versionBefore: number | null;
  versionAfter: number | null;
  /** Wall-clock ms at which the step settled. */
  settledAt: number;
  error?: string;
}

export interface RunSummary {
  runId: string;
  scenarioId: string;
  seed: number;
  status: 'completed' | 'failed' | 'cancelled';
  steps: StepOutcome[];
  /** Indices of proposal-triggered steps that never fired (`dependent_step_not_triggered`). */
  notTriggered: number[];
  preconditions: PreconditionReport;
}

export interface ScenarioRun {
  readonly runId: string;
  readonly steps: readonly ResolvedStep[];
  /**
   * Settles (never rejects) once the setup has run, the initial steps are
   * applied and the declared symptoms were seen or the window passed. A mission
   * must not start before this settles with status `verified` or `unchecked`.
   */
  readonly ready: Promise<PreconditionReport>;
  /** Settles when every step has been applied, skipped or failed. */
  readonly done: Promise<RunSummary>;
  /** Settles when that step does. */
  stepSettled(index: number): Promise<StepOutcome>;
  /** Ends the run (the mission is over) and returns what happened. */
  cancel(): Promise<RunSummary>;
}

export interface InjectorDeps {
  /** pool for role nemodots_injector */
  pool: pg.Pool;
  /**
   * connection string of the same role, for the dedicated LISTEN connection.
   * A function is re-evaluated on every (re)connect.
   */
  listenUrl: string | (() => string);
  now?: () => number;
  /** Bounded reconnect of the LISTEN connection (defaults: 5 attempts, 100 ms base). */
  listenerReconnect?: { attempts?: number; baseDelayMs?: number };
  /**
   * Readers (the ones an agent has) used to establish and verify the manifest's
   * preconditions. Without them a manifest that declares preconditions runs
   * `unchecked`; the caller must treat that as not verified.
   */
  preconditions?: PreconditionDeps;
  /**
   * Upper bound, from the end of the preconditions, on waiting for a
   * proposal-triggered step. Absent means no bound other than the run's own
   * end (cancel). A caller sets this to the mission's own deadline, never to
   * something shorter.
   */
  maxRunMs?: number;
}

/** Extracts the target config key from a nemodots_action_proposed payload. */
export function parseProposedKey(payload: string | undefined): string | null {
  if (!payload) return null;
  let raw = payload.trim();
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = parsed.key ?? parsed.target ?? parsed.targetKey;
      if (typeof candidate !== 'string') return null;
      raw = candidate;
    } catch {
      return null;
    }
  }
  raw = raw.replace(/^checkout\.config\//, '');
  return CONFIG_MEMBER_KEY_PATTERN.test(raw) ? raw : null;
}

/** Test/dev helper: what the action proposal path emits (payload: target key). */
export async function notifyProposed(
  client: { query(text: string, values?: unknown[]): Promise<unknown> },
  key: string,
) {
  await client.query('SELECT pg_notify($1, $2)', [
    ACTION_PROPOSED_CHANNEL,
    key,
  ]);
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

export class Injector {
  private readonly now: () => number;

  constructor(private readonly deps: InjectorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * start() plus the guarantee a mission needs: resolves only when the
   * scenario's preconditions are verified (or the scenario declares none, or no
   * verifier was configured, which `run.ready` reports as `unchecked`). When the
   * symptom is not visible the run is cancelled and this rejects with
   * ScenarioPreconditionFailed (`scenario_precondition_failed`), so the trial
   * is never scored as a no-fault trial.
   */
  async startVerified(
    manifest: ScenarioManifest,
    seed: number,
  ): Promise<ScenarioRun> {
    const run = await this.start(manifest, seed);
    const report = await run.ready;
    if (report.status === 'failed') {
      await run.cancel();
      throw new ScenarioPreconditionFailed(manifest.id, run.runId, report);
    }
    return run;
  }

  async start(manifest: ScenarioManifest, seed: number): Promise<ScenarioRun> {
    const steps = resolveScenario(manifest, seed);
    const runId = randomUUID();
    await this.deps.pool.query(
      `INSERT INTO control.scenario_runs (id, scenario_id, seed, manifest_digest, status)
       VALUES ($1, $2, $3, $4, 'running')`,
      [runId, manifest.id, seed, manifestDigest(manifest)],
    );
    for (const step of steps)
      await this.deps.pool.query(
        `INSERT INTO control.fault_schedules
           (run_id, step_index, kind, config_key, resolved_value, trigger, delay_ms, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'pending')`,
        [
          runId,
          step.index,
          step.kind,
          step.key ?? null,
          JSON.stringify(step.values ?? step.value),
          step.trigger,
          step.delayMs,
        ],
      );

    const outcomes = new Map<number, StepOutcome>();
    const settledGates = steps.map(() => gate());
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let cancelled = false;
    const cancelGate = gate();

    // Preconditions: `setupGate` opens once the setup actions ran, `readyGate`
    // once the initial steps are applied and the symptoms were checked. Both
    // always open (also on failure) so no step can wait on them forever.
    const declared = manifest.preconditions;
    const verifier = declared ? this.deps.preconditions : undefined;
    const setupGate = gate();
    const readyGate = gate();
    let setupFailed = false;
    let preconditionFailed = false;
    let report: PreconditionReport = uncheckedReport(
      declared ? 'no_verifier_configured' : 'no_preconditions_declared',
    );

    // LISTEN is established before anything is applied or returned, so a
    // proposal emitted right after start() resolves cannot be missed.
    //
    // If the LISTEN connection drops (backend restart, idle kill, network) it
    // is re-established with bounded backoff while the run is live. The
    // notifications that fell into the gap are unrecoverable, so the gap is
    // recorded in control.scenario_runs.detail. When the connection cannot be
    // restored, every still-waiting proposal step FAILS with `listener_lost`:
    // it is never reported as `dependent_step_not_triggered`.
    type ProposalOutcome =
      { kind: 'key'; key: string } | { kind: 'lost' } | { kind: 'none' };
    const waiters: ((key: string) => void)[] = [];
    const lostWaiters = new Set<() => void>();
    let listener: pg.Client | null = null;
    let finishing = false;
    let listenerLost = false;
    let reconnects = 0;
    const armed = steps.some((s) => s.trigger === 'on_action_proposed');
    const reconnectAttempts = this.deps.listenerReconnect?.attempts ?? 5;
    const reconnectBaseMs = this.deps.listenerReconnect?.baseDelayMs ?? 100;
    const listenUrl = () =>
      typeof this.deps.listenUrl === 'function'
        ? this.deps.listenUrl()
        : this.deps.listenUrl;

    const connectListener = async () => {
      const client = new pg.Client({
        connectionString: listenUrl(),
        application_name: 'nemodots-injector-listen',
      });
      let handled = false;
      const dropped = () => {
        if (handled || finishing || cancelled) return;
        handled = true;
        if (listener === client) listener = null;
        void recoverListener();
      };
      client.on('error', dropped);
      client.on('end', dropped);
      client.on('notification', (message) => {
        if (message.channel !== ACTION_PROPOSED_CHANNEL) return;
        const key = parseProposedKey(message.payload);
        if (key) for (const waiter of [...waiters]) waiter(key);
      });
      try {
        await client.connect();
        await client.query(`LISTEN ${ACTION_PROPOSED_CHANNEL}`);
      } catch (error) {
        handled = true; // the caller handles the failure
        await client.end().catch(() => {});
        throw error;
      }
      listener = client;
    };

    let recovering = false;
    const recoverListener = async () => {
      if (recovering) return;
      recovering = true;
      try {
        for (let attempt = 1; attempt <= reconnectAttempts; attempt += 1) {
          if (finishing || cancelled) return;
          await sleep(reconnectBaseMs * 2 ** (attempt - 1));
          if (finishing || cancelled) return;
          try {
            await connectListener();
            reconnects += 1;
            return;
          } catch {
            // try again with a longer pause
          }
        }
        listenerLost = true;
        for (const lost of [...lostWaiters]) lost();
      } finally {
        recovering = false;
      }
    };
    if (armed) await connectListener();

    const settle = async (outcome: StepOutcome) => {
      outcomes.set(outcome.index, outcome);
      await this.deps.pool.query(
        `UPDATE control.fault_schedules
            SET status = $3, applied_at = CASE WHEN $3 = 'applied' THEN now() END,
                version_before = $4, version_after = $5, error = $6
          WHERE run_id = $1 AND step_index = $2`,
        [
          runId,
          outcome.index,
          outcome.status,
          outcome.versionBefore,
          outcome.versionAfter,
          outcome.error ?? null,
        ],
      );
      settledGates[outcome.index].open();
    };

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          resolve();
        }, ms);
        timers.add(timer);
        void cancelGate.promise.then(() => {
          clearTimeout(timer);
          timers.delete(timer);
          resolve();
        });
      });

    const waitForProposal = (step: ResolvedStep) =>
      new Promise<ProposalOutcome>((resolve) => {
        if (listenerLost) return resolve({ kind: 'lost' });
        const targets = new Set(Object.keys(step.values ?? {}));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: ProposalOutcome) => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          lostWaiters.delete(lost);
          if (timer) {
            clearTimeout(timer);
            timers.delete(timer);
          }
          resolve(outcome);
        };
        const waiter = (key: string) => {
          if (targets.has(key)) finish({ kind: 'key', key });
        };
        const lost = () => finish({ kind: 'lost' });
        waiters.push(waiter);
        lostWaiters.add(lost);
        // No timer unless a bound was asked for: a late proposal must still
        // trigger the step for as long as the run lives.
        const limit = [step.timeoutMs, this.deps.maxRunMs]
          .filter((ms): ms is number => typeof ms === 'number')
          .reduce<number | undefined>(
            (least, ms) => (least === undefined ? ms : Math.min(least, ms)),
            undefined,
          );
        if (limit !== undefined)
          timer = setTimeout(() => finish({ kind: 'none' }), limit);
        if (timer) timers.add(timer);
        void cancelGate.promise.then(() => finish({ kind: 'none' }));
      });

    // Applications are serialized in readiness order so that two steps that
    // become ready together are applied in manifest order.
    let applyChain: Promise<void> = Promise.resolve();
    const apply = (step: ResolvedStep, key: string, value: unknown) => {
      const run = applyChain.then(async () => {
        try {
          const result = await withTransaction(this.deps.pool, (client) =>
            advanceConfigUnconditionally(client, {
              key,
              value:
                step.kind === 'delete_config'
                  ? undefined
                  : (value as string | number | boolean),
              insertIfMissing: step.kind === 'insert_config',
              deleteKey: step.kind === 'delete_config',
              causedBy: { actor: 'injector' },
            }),
          );
          await settle(applied(step, key, result));
        } catch (error) {
          await settle({
            index: step.index,
            status: 'failed',
            key,
            versionBefore: null,
            versionAfter: null,
            settledAt: this.now(),
            error: isStaleVersion(error)
              ? 'stale_version'
              : error instanceof Error
                ? error.message
                : String(error),
          });
        }
      });
      applyChain = run.catch(() => {});
      return run;
    };
    const applied = (
      step: ResolvedStep,
      key: string,
      result: AdvanceConfigResult,
    ): StepOutcome => ({
      index: step.index,
      status: 'applied',
      key,
      versionBefore: result.versionBefore,
      versionAfter: result.versionAfter,
      settledAt: this.now(),
    });
    const skip = (step: ResolvedStep, reason: string) =>
      settle({
        index: step.index,
        status: 'skipped',
        key: step.key,
        versionBefore: null,
        versionAfter: null,
        settledAt: this.now(),
        error: reason,
      });

    const fail = (step: ResolvedStep, reason: string) =>
      settle({
        index: step.index,
        status: 'failed',
        key: step.key,
        versionBefore: null,
        versionAfter: null,
        settledAt: this.now(),
        error: reason,
      });

    const runStep = async (step: ResolvedStep) => {
      await setupGate.promise;
      await Promise.all(step.after.map((i) => settledGates[i].promise));
      const prerequisitesApplied = step.after.every(
        (i) => outcomes.get(i)?.status === 'applied',
      );
      if (cancelled) return skip(step, 'cancelled');
      if (setupFailed) return skip(step, PRECONDITION_FAILED_STEP);
      if (!step.initial) {
        // every later step happens in the world the mission starts in
        await readyGate.promise;
        if (cancelled) return skip(step, 'cancelled');
        if (preconditionFailed) return skip(step, PRECONDITION_FAILED_STEP);
      }
      if (!prerequisitesApplied) return skip(step, 'prerequisite_not_applied');
      if (step.trigger === 'delay' && step.delayMs) {
        await sleep(step.delayMs);
        if (cancelled) return skip(step, 'cancelled');
      }
      if (step.trigger === 'on_action_proposed') {
        const proposal = await waitForProposal(step);
        // the wait ended without a matching proposal: the mission is over (cancel)
        // or the bound was reached. Either way the step did not fire.
        if (proposal.kind === 'none')
          return skip(step, DEPENDENT_STEP_NOT_TRIGGERED);
        if (cancelled) return skip(step, 'cancelled');
        if (proposal.kind === 'lost') return fail(step, 'listener_lost');
        return apply(step, proposal.key, step.values![proposal.key]);
      }
      return apply(step, step.key!, step.value);
    };

    // Setup -> initial steps -> symptoms visible. Resolves with the report and
    // never rejects; the gates always open.
    const establish = async (): Promise<PreconditionReport> => {
      const startedAt = this.now();
      const initial = steps.filter((s) => s.initial).map((s) => s.index);
      const elapsed = () => this.now() - startedAt;
      const checked = Boolean(declared && verifier);
      let phase: 'setup' | 'initial_steps' | 'visible' = 'setup';
      const failed = (
        setup: PreconditionReport['setup'],
        visible: PreconditionReport['visible'],
        message: string,
      ): PreconditionReport => ({
        status: 'failed',
        setup,
        visible,
        failure: { phase, message, ...(cancelled ? { cancelled: true } : {}) },
        elapsedMs: elapsed(),
      });
      try {
        let setup: PreconditionReport['setup'] = [];
        if (declared && verifier) setup = await runSetup(declared, verifier);
        const failedSetup = setup.find((a) => !a.ok);
        if (failedSetup) {
          setupFailed = true;
          return failed(
            setup,
            [],
            `${failedSetup.kind}: ${failedSetup.detail}`,
          );
        }
        setupGate.open();
        phase = 'initial_steps';
        await Promise.all(initial.map((i) => settledGates[i].promise));
        // Without a verifier the run is unchecked: a failed step is an ordinary
        // step failure (the run fails), not a precondition failure.
        if (!checked) return { ...report, setup, elapsedMs: elapsed() };
        if (cancelled)
          return failed(
            setup,
            [],
            'cancelled before the preconditions were verified',
          );
        const notApplied = initial.find(
          (i) => outcomes.get(i)?.status !== 'applied',
        );
        if (notApplied !== undefined)
          return failed(
            setup,
            [],
            `step ${notApplied} ${outcomes.get(notApplied)?.status}: ${outcomes.get(notApplied)?.error ?? 'not applied'}`,
          );
        phase = 'visible';
        const visible = await verifyVisible(
          declared!,
          verifier!,
          () => cancelled,
        );
        const missing = visible.filter((v) => !v.seen);
        if (cancelled)
          return failed(
            setup,
            visible,
            'cancelled before the preconditions were verified',
          );
        if (missing.length)
          return failed(
            setup,
            visible,
            `symptom not visible through the readers within ${declared!.withinMs ?? DEFAULT_SYMPTOM_WITHIN_MS} ms: ${missing.map((v) => `${v.symptom} (${v.detail})`).join('; ')}`,
          );
        return { status: 'verified', setup, visible, elapsedMs: elapsed() };
      } catch (error) {
        return failed(
          [],
          [],
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    const ready: Promise<PreconditionReport> = establish().then(
      async (result) => {
        report = result;
        // a cancel is the caller's decision, not a failed precondition
        preconditionFailed =
          result.status === 'failed' && !result.failure?.cancelled;
        setupGate.open();
        readyGate.open();
        await this.deps.pool
          .query(
            `UPDATE control.scenario_runs
                SET detail = COALESCE(detail, '{}'::jsonb) || $2::jsonb
              WHERE id = $1`,
            [runId, JSON.stringify({ preconditions: result })],
          )
          .catch(() => {});
        return result;
      },
    );
    if (!declared || !verifier) setupGate.open();

    const finished = Promise.all(steps.map((step) => runStep(step)));
    const done = finished.then(async (): Promise<RunSummary> => {
      const list = steps.map((s) => outcomes.get(s.index)!);
      const failed = list.some((o) => o.status === 'failed');
      await ready;
      const notTriggered = list
        .filter((o) => o.error === DEPENDENT_STEP_NOT_TRIGGERED)
        .map((o) => o.index);
      const status = preconditionFailed
        ? 'failed'
        : cancelled
          ? 'cancelled'
          : failed
            ? 'failed'
            : 'completed';
      finishing = true;
      await (listener as pg.Client | null)?.end().catch(() => {});
      await this.deps.pool.query(
        `UPDATE control.scenario_runs
            SET status = $2, finished_at = now(),
                detail = COALESCE(detail, '{}'::jsonb) || $3::jsonb
          WHERE id = $1`,
        [
          runId,
          status,
          JSON.stringify({
            steps: list.map((o) => ({
              index: o.index,
              status: o.status,
              error: o.error ?? null,
            })),
            notTriggered,
            preconditions: report,
            listener: armed ? { reconnects, lost: listenerLost } : undefined,
          }),
        ],
      );
      return {
        runId,
        scenarioId: manifest.id,
        seed,
        status,
        steps: list,
        notTriggered,
        preconditions: report,
      };
    });
    // A rejected `done` must not become an unhandled rejection when nobody awaits it.
    done.catch(() => {});

    return {
      runId,
      steps,
      ready,
      done,
      stepSettled: (index) =>
        settledGates[index].promise.then(() => outcomes.get(index)!),
      async cancel() {
        cancelled = true;
        cancelGate.open();
        setupGate.open();
        for (const timer of timers) clearTimeout(timer);
        return done;
      },
    };
  }
}
