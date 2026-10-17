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
  /** connection string of the same role, for the dedicated LISTEN connection */
  listenUrl: string;
  now?: () => number;
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

    // LISTEN is established before anything is applied or returned, so a
    // proposal emitted right after start() resolves cannot be missed.
    const waiters: ((key: string) => void)[] = [];
    let listener: pg.Client | null = null;
    if (steps.some((s) => s.trigger === 'on_action_proposed')) {
      listener = new pg.Client({
        connectionString: this.deps.listenUrl,
        application_name: 'nemodots-injector-listen',
      });
      listener.on('error', () => {});
      await listener.connect();
      listener.on('notification', (message) => {
        if (message.channel !== ACTION_PROPOSED_CHANNEL) return;
        const key = parseProposedKey(message.payload);
        if (key) for (const waiter of [...waiters]) waiter(key);
      });
      await listener.query(`LISTEN ${ACTION_PROPOSED_CHANNEL}`);
    }

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
      new Promise<string | null>((resolve) => {
        const targets = new Set(Object.keys(step.values ?? {}));
        const finish = (key: string | null) => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          clearTimeout(timer);
          timers.delete(timer);
          resolve(key);
        };
        const waiter = (key: string) => {
          if (targets.has(key)) finish(key);
        };
        waiters.push(waiter);
        const timer = setTimeout(() => finish(null), step.timeoutMs);
        timers.add(timer);
        void cancelGate.promise.then(() => finish(null));
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

    const runStep = async (step: ResolvedStep) => {
      await Promise.all(step.after.map((i) => settledGates[i].promise));
      const prerequisitesApplied = step.after.every(
        (i) => outcomes.get(i)?.status === 'applied',
      );
      if (cancelled) return skip(step, 'cancelled');
      if (!prerequisitesApplied) return skip(step, 'prerequisite_not_applied');
      if (step.trigger === 'delay' && step.delayMs) {
        await sleep(step.delayMs);
        if (cancelled) return skip(step, 'cancelled');
      }
      if (step.trigger === 'on_action_proposed') {
        const key = await waitForProposal(step);
        if (cancelled) return skip(step, 'cancelled');
        if (!key) return skip(step, 'no_matching_proposal');
        return apply(step, key, step.values![key]);
      }
      return apply(step, step.key!, step.value);
    };

    const finished = Promise.all(steps.map((step) => runStep(step)));
    const done = finished.then(async (): Promise<RunSummary> => {
      const list = steps.map((s) => outcomes.get(s.index)!);
      const failed = list.some((o) => o.status === 'failed');
      const status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
      await listener?.end().catch(() => {});
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
          }),
        ],
      );
      return { runId, scenarioId: manifest.id, seed, status, steps: list };
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
