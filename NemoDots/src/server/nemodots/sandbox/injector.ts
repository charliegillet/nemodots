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
  type AdvanceConfigResult,
  advanceConfigUnconditionally,
  isStaleVersion,
} from './version-authority.js';

export const ACTION_PROPOSED_CHANNEL = 'nemodots_action_proposed';

export type StepStatus = 'applied' | 'skipped' | 'failed';

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
  /**
   * Messages of bookkeeping writes (control.* updates) that failed. A run with
   * any is reported 'failed' and was torn down: the LISTEN connection is
   * closed and the steps still waiting are cancelled.
   */
  bookkeepingErrors?: string[];
}

export interface ScenarioRun {
  readonly runId: string;
  readonly steps: readonly ResolvedStep[];
  /** Settles when every step has been applied, skipped or failed. */
  readonly done: Promise<RunSummary>;
  /** Settles when that step does. */
  stepSettled(index: number): Promise<StepOutcome>;
  cancel(): Promise<void>;
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
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

  async start(manifest: ScenarioManifest, seed: number): Promise<ScenarioRun> {
    const steps = resolveScenario(manifest, seed);
    const runId = randomUUID();
    // The run and its schedule are one unit: either both rows exist or neither.
    await withTransaction(this.deps.pool, async (client) => {
      await client.query(
        `INSERT INTO control.scenario_runs (id, scenario_id, seed, manifest_digest, status)
         VALUES ($1, $2, $3, $4, 'running')`,
        [runId, manifest.id, seed, manifestDigest(manifest)],
      );
      for (const step of steps)
        await client.query(
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
    });

    const outcomes = new Map<number, StepOutcome>();
    const settledGates = steps.map(() => gate());
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let cancelled = false;
    // a bookkeeping failure aborts the run: remaining steps are cancelled
    let aborted = false;
    const bookkeepingErrors: string[] = [];
    const halted = () => cancelled || aborted;
    const cancelGate = gate();

    // LISTEN is established before anything is applied or returned, so a
    // proposal emitted right after start() resolves cannot be missed.
    //
    // If the LISTEN connection drops (backend restart, idle kill, network) it
    // is re-established with bounded backoff while the run is live. The
    // notifications that fell into the gap are unrecoverable, so the gap is
    // recorded in control.scenario_runs.detail. When the connection cannot be
    // restored, every still-waiting proposal step FAILS with `listener_lost`:
    // it is never reported as `no_matching_proposal`.
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
        if (handled || finishing || halted()) return;
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
      if (finishing || halted()) {
        // the run ended while this (re)connect was in flight: do not keep it
        handled = true;
        await client.end().catch(() => {});
        return;
      }
      listener = client;
    };

    let recovering = false;
    const recoverListener = async () => {
      if (recovering) return;
      recovering = true;
      try {
        for (let attempt = 1; attempt <= reconnectAttempts; attempt += 1) {
          if (finishing || halted()) return;
          await sleep(reconnectBaseMs * 2 ** (attempt - 1));
          if (finishing || halted()) return;
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
    if (armed) {
      try {
        await connectListener();
      } catch (error) {
        // Fail closed: the run was recorded above, so record that it never started.
        const message = `listener_unavailable`;
        await this.deps.pool
          .query(
            `UPDATE control.fault_schedules SET status = 'failed', error = $2
              WHERE run_id = $1 AND status = 'pending'`,
            [runId, message],
          )
          .catch(() => {});
        await this.deps.pool
          .query(
            `UPDATE control.scenario_runs
                SET status = 'failed', finished_at = now(), detail = $2::jsonb
              WHERE id = $1`,
            [
              runId,
              JSON.stringify({
                listener: { error: message, reason: errorMessage(error) },
              }),
            ],
          )
          .catch(() => {});
        throw error;
      }
    }

    const persistStep = (outcome: StepOutcome) =>
      this.deps.pool.query(
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
    const settle = async (outcome: StepOutcome) => {
      outcomes.set(outcome.index, outcome);
      try {
        await persistStep(outcome);
      } finally {
        // dependents must never hang on a step whose bookkeeping failed
        settledGates[outcome.index].open();
      }
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
        const finish = (outcome: ProposalOutcome) => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          lostWaiters.delete(lost);
          clearTimeout(timer);
          timers.delete(timer);
          resolve(outcome);
        };
        const waiter = (key: string) => {
          if (targets.has(key)) finish({ kind: 'key', key });
        };
        const lost = () => finish({ kind: 'lost' });
        waiters.push(waiter);
        lostWaiters.add(lost);
        const timer = setTimeout(
          () => finish({ kind: 'none' }),
          step.timeoutMs,
        );
        timers.add(timer);
        void cancelGate.promise.then(() => finish({ kind: 'none' }));
      });

    // Applications are serialized in readiness order so that two steps that
    // become ready together are applied in manifest order.
    let applyChain: Promise<void> = Promise.resolve();
    const apply = (step: ResolvedStep, key: string, value: unknown) => {
      const run = applyChain.then(async () => {
        let outcome: StepOutcome;
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
          outcome = applied(step, key, result);
        } catch (error) {
          outcome = {
            index: step.index,
            status: 'failed',
            key,
            versionBefore: null,
            versionAfter: null,
            settledAt: this.now(),
            error: isStaleVersion(error)
              ? 'stale_version'
              : errorMessage(error),
          };
        }
        // A bookkeeping failure here propagates (the step is NOT re-recorded as
        // failed: the configuration write above did commit).
        await settle(outcome);
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
      await Promise.all(step.after.map((i) => settledGates[i].promise));
      const prerequisitesApplied = step.after.every(
        (i) => outcomes.get(i)?.status === 'applied',
      );
      if (halted()) return skip(step, 'cancelled');
      if (!prerequisitesApplied) return skip(step, 'prerequisite_not_applied');
      if (step.trigger === 'delay' && step.delayMs) {
        await sleep(step.delayMs);
        if (halted()) return skip(step, 'cancelled');
      }
      if (step.trigger === 'on_action_proposed') {
        const proposal = await waitForProposal(step);
        if (halted()) return skip(step, 'cancelled');
        if (proposal.kind === 'lost') return fail(step, 'listener_lost');
        if (proposal.kind === 'none') return skip(step, 'no_matching_proposal');
        return apply(step, proposal.key, step.values![proposal.key]);
      }
      return apply(step, step.key!, step.value);
    };

    // Every step is awaited to the end (allSettled): a bookkeeping failure in
    // one step aborts the run (the others are cancelled and skip) but can never
    // leave a step's timer, proposal waiter or the LISTEN connection behind.
    const abort = (error: unknown) => {
      bookkeepingErrors.push(errorMessage(error));
      aborted = true;
      cancelGate.open();
      for (const timer of timers) clearTimeout(timer);
    };
    const finished = Promise.allSettled(
      steps.map((step) =>
        runStep(step).catch((error: unknown) => {
          abort(error);
        }),
      ),
    );
    const done = finished.then(async (): Promise<RunSummary> => {
      // Teardown always runs, whatever happened above.
      finishing = true;
      cancelGate.open();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      waiters.length = 0;
      lostWaiters.clear();
      await (listener as pg.Client | null)?.end().catch(() => {});
      listener = null;
      const list = steps.map(
        (s): StepOutcome =>
          outcomes.get(s.index) ?? {
            index: s.index,
            status: 'failed',
            key: s.key,
            versionBefore: null,
            versionAfter: null,
            settledAt: this.now(),
            error: 'bookkeeping_failed',
          },
      );
      const failed = list.some((o) => o.status === 'failed');
      const status =
        bookkeepingErrors.length > 0
          ? 'failed'
          : cancelled
            ? 'cancelled'
            : failed
              ? 'failed'
              : 'completed';
      try {
        await this.deps.pool.query(
          `UPDATE control.scenario_runs
              SET status = $2, finished_at = now(), detail = $3::jsonb
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
              listener: armed ? { reconnects, lost: listenerLost } : undefined,
              bookkeepingErrors: bookkeepingErrors.length
                ? bookkeepingErrors
                : undefined,
            }),
          ],
        );
      } catch (error) {
        bookkeepingErrors.push(errorMessage(error));
      }
      return {
        runId,
        scenarioId: manifest.id,
        seed,
        status: bookkeepingErrors.length > 0 ? 'failed' : status,
        steps: list,
        ...(bookkeepingErrors.length
          ? { bookkeepingErrors: [...bookkeepingErrors] }
          : {}),
      };
    });
    // A rejected `done` must not become an unhandled rejection when nobody awaits it.
    done.catch(() => {});

    return {
      runId,
      steps,
      done,
      stepSettled: (index) =>
        settledGates[index].promise.then(() => outcomes.get(index)!),
      async cancel() {
        cancelled = true;
        cancelGate.open();
        for (const timer of timers) clearTimeout(timer);
        await done.catch(() => {});
      },
    };
  }
}
