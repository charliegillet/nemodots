// The live EvalHost: the dedicated stack's checkout, injector and verifier, plus
// a MissionDriver that creates and runs missions under an arm. Everything the
// mission decides stays inside the product; this host only
//   - resets the world between trials (clears ledger/coordinator rows, restores
//     the configuration baseline through the version authority, flushes the
//     cache),
//   - injects the scenario's faults through the injector role, which also
//     establishes the scenario's preconditions (e.g. warms the cache) and
//     verifies the symptom through the production readers BEFORE the mission
//     starts; a symptom that does not appear is scenario_precondition_failed,
//     never a no-fault trial,
//   - starts the mission under the arm's recovery scope rule and layout,
//   - ends the observation with a FRESH independent probe (verifier role),
//   - reads the evidence back as the verifier role for the oracle.
// Instance safety: it refuses the shared `dev` instance unless told otherwise,
// and never touches ports 5432/6379 (config/env.ts refuses them).
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import pg from 'pg';
import {
  PG_ROLES,
  parseNemoDotsEnv,
  pgUrlEnvName,
  type NemoDotsConfig,
} from '../config/env.js';
import { createRolePool } from '../db/pool.js';
import type { Scope } from '../contracts/ids.js';
import { Injector } from '../sandbox/injector.js';
import { loadScenario } from '../sandbox/manifest.js';
import { preconditionDepsFromReaders } from '../sandbox/preconditions.js';
import { createSourceReaders } from '../sandbox/readers.js';
import { createProbe } from '../sandbox/probe.js';
import { PROBE_SKU, PROBE_SKU_STOCK } from '../sandbox/constants.js';
import { seedCheckout } from '../sandbox/seed.js';
import { collectObservations } from './collect.js';
import {
  HostBlockedError,
  type EndState,
  type EnvironmentFacts,
  type EvalHost,
  type FaultOutcome,
  type FaultRun,
} from './host.js';
import type { Observations, ObsIndependentCheck } from './observations.js';
import type { TrialSpec } from './types.js';

/** Creates and drives missions under an arm. Implemented over bootstrap; see cli.ts. */
export interface MissionDriver {
  /** Throws HostBlockedError when the arm cannot be run (a missing hook). */
  createAndStart(spec: TrialSpec, goal: string): Promise<{ missionId: string }>;
  cancel(missionId: string): Promise<void>;
  close(): Promise<void>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LiveHostOptions {
  env: Record<string, string | undefined>;
  driver: MissionDriver;
  /** allow the shared dev instance (default refuses) */
  allowInstances?: readonly string[];
  commit?: string | null;
  pollMs?: number;
  now?: () => Date;
}

export const LIVE_ENV_NAMES = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const;

/** Names missing for a live run, in the order they are checked. */
export function missingLiveEnv(
  env: Record<string, string | undefined>,
): string[] {
  return LIVE_ENV_NAMES.filter((name) => !env[name]?.trim());
}

export function assertInstance(
  instance: string,
  allowed: readonly string[] = [],
): void {
  if (instance === 'dev' && !allowed.includes('dev'))
    throw new HostBlockedError(
      ['NEMODOTS_INSTANCE'],
      'BLOCKED: refusing the shared dev instance; run on a dedicated one (for example NEMODOTS_INSTANCE=ci-evals) or pass --allow-instance dev',
    );
}

export async function createLiveHost(
  options: LiveHostOptions,
): Promise<LiveEvalHost> {
  const missing = missingLiveEnv(options.env);
  if (missing.length > 0)
    throw new HostBlockedError(
      missing,
      `BLOCKED: ${missing.join(', ')} missing`,
    );
  const config = parseNemoDotsEnv(options.env);
  assertInstance(config.instance, options.allowInstances);
  for (const role of PG_ROLES)
    if (!config.pg.urls[role] && role !== 'checkout')
      throw new HostBlockedError(
        [pgUrlEnvName(role)],
        `BLOCKED: ${pgUrlEnvName(role)} missing (run through npm run nemodots:evals)`,
      );
  if (!config.probe.secret)
    throw new HostBlockedError(
      ['NEMODOTS_PROBE_SECRET'],
      'BLOCKED: NEMODOTS_PROBE_SECRET missing',
    );
  return new LiveEvalHost(options, config);
}

export class LiveEvalHost implements EvalHost {
  readonly facts: EnvironmentFacts;
  private readonly verifier: pg.Pool;
  private readonly admin: pg.Pool;
  private readonly injectorPool: pg.Pool;
  private readonly redis: ReturnType<typeof createClient>;
  private redisReady: Promise<unknown> | null = null;
  private readonly checkoutUrl: string;
  private readonly now: () => Date;

  constructor(
    private readonly options: LiveHostOptions,
    private readonly config: NemoDotsConfig,
  ) {
    const urls = config.pg.urls as Record<string, string>;
    this.verifier = createRolePool('verifier', urls.verifier);
    this.admin = createRolePool('admin', urls.admin, { max: 2 });
    this.injectorPool = createRolePool('injector', urls.injector);
    this.redis = createClient({ url: config.redis.url });
    this.redis.on('error', () => undefined);
    this.checkoutUrl = config.checkout.url;
    this.now = options.now ?? (() => new Date());
    const model = options.env.OPENAI_MODEL!.trim();
    this.facts = {
      mode: 'live',
      instance: config.instance,
      model,
      providerHost: new URL(options.env.OPENAI_BASE_URL!.trim()).host,
      commit: options.commit ?? null,
      node: process.version,
      settings: {
        NEMODOTS_TASK_MAX_TOKENS: options.env.NEMODOTS_TASK_MAX_TOKENS ?? null,
        NEMODOTS_INFERENCE_MAX_IN_FLIGHT:
          options.env.NEMODOTS_INFERENCE_MAX_IN_FLIGHT ??
          String(config.inference.maxInFlight),
        probeWindowMs: config.probe.windowMs,
      },
    };
  }

  private async redisClient() {
    this.redisReady ??= this.redis.connect();
    await this.redisReady;
    return this.redis;
  }

  async prepare(spec: TrialSpec): Promise<void> {
    void spec;
    // 1. a clean ledger and coordinator: no residue of an earlier trial can
    //    attach to this one (sources, receipts, edges, missions, intents).
    await this.admin.query(`SET lock_timeout = '10s'`);
    await this.admin.query(
      `TRUNCATE ledger.dependency_edges, ledger.dependency_nodes, ledger.invalidation_events,
                ledger.receipt_confirmations, ledger.receipt_transitions, ledger.source_revisions,
                ledger.inference_attempts, ledger.model_call_records, ledger.context_snapshots,
                ledger.tool_spans, ledger.mission_timing, ledger.observation_receipts,
                ledger.sources,
                coordinator.recovery_events, coordinator.invalidations, coordinator.outbox_applied,
                coordinator.outbox, coordinator.events, coordinator.findings,
                coordinator.result_receipts, coordinator.authorizations,
                coordinator.action_intents, coordinator.task_outputs,
                coordinator.task_attempts, coordinator.tasks, coordinator.missions
         RESTART IDENTITY CASCADE`,
    );
    // 2. probe residue and the baseline configuration (through the version authority)
    await this.admin.query(
      `DELETE FROM checkout.order_items WHERE order_id IN
         (SELECT id FROM checkout.orders WHERE probe_run_id IS NOT NULL)`,
    );
    await this.admin.query(
      'DELETE FROM checkout.orders WHERE probe_run_id IS NOT NULL',
    );
    await this.admin.query(
      'UPDATE checkout.inventory SET quantity = $2 WHERE sku = $1',
      [PROBE_SKU, PROBE_SKU_STOCK],
    );
    await seedCheckout(this.admin, { restoreConfig: true });
    // 3. an empty cache. Scenarios that need entries under the baseline schema
    //    establish them themselves (preconditions.setup); nothing here may
    //    paper over a scenario that does not.
    const redis = await this.redisClient();
    const prefix = `${this.config.redis.prefix}:cache:`;
    const batch: string[] = [];
    for await (const keys of redis.scanIterator({
      MATCH: `${prefix}*`,
      COUNT: 200,
    }))
      batch.push(...keys);
    if (batch.length > 0) await redis.unlink(batch);
    await sleep(400); // the checkout's configuration cache is 250 ms
    // /ready reads no cached entry, so the cache stays empty
    const ready = await fetch(`${this.checkoutUrl}/ready`).catch(() => null);
    if (!ready || ready.status !== 200)
      throw new Error(
        'the checkout did not answer 200 on /ready after the reset',
      );
    // 4. a clean error window. /metrics keeps error classes for 30 s, so the
    //    previous trial's decode error would otherwise be visible to this
    //    trial's readers (and could satisfy a symptom check that this trial's
    //    own fault has not produced).
    await this.waitForCleanMetricsWindow();
  }

  private async waitForCleanMetricsWindow(limitMs = 45_000): Promise<void> {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const body = (await fetch(`${this.checkoutUrl}/metrics`)
        .then((response) => response.json())
        .catch(() => null)) as {
        errors?: { windowClasses?: string[] };
      } | null;
      if (body && (body.errors?.windowClasses ?? []).length === 0) return;
      if (Date.now() >= deadline)
        throw new Error(
          `the checkout's metrics window still holds error classes after ${limitMs} ms: ${(body?.errors?.windowClasses ?? ['unreadable']).join(',')}`,
        );
      await sleep(1_000);
    }
  }

  async startFaults(
    spec: TrialSpec,
    manifest: ReturnType<typeof loadScenario>,
  ): Promise<FaultRun> {
    // The readers are the ones an agent has. The injector applies the initial
    // faults, then verifies the declared symptoms through them; this rejects
    // with ScenarioPreconditionFailed when they do not appear.
    const preconditions = preconditionDepsFromReaders(
      createSourceReaders({
        pg: this.verifier,
        redis: (await this.redisClient()) as never,
        redisPrefix: this.config.redis.prefix,
        checkoutUrl: this.checkoutUrl,
      }),
      {
        ownerId: 'evals',
        missionId: randomUUID(),
        spaceId: null,
        environment: 'eval',
        resource: 'checkout',
      } as unknown as Scope,
      { checkoutUrl: this.checkoutUrl },
    );
    const run = await new Injector({
      pool: this.injectorPool,
      listenUrl: this.config.pg.urls.injector as string,
      preconditions,
    }).startVerified(manifest, spec.seed);
    const outcome = (summary: Awaited<typeof run.done>): FaultOutcome => ({
      status: summary.status,
      notTriggered: summary.notTriggered,
      preconditions: summary.preconditions,
    });
    return {
      done: run.done.then(outcome),
      cancel: async () => outcome(await run.cancel()),
    };
  }

  async startMission(spec: TrialSpec, goal: string) {
    const startedAt = this.now().toISOString();
    const { missionId } = await this.options.driver.createAndStart(spec, goal);
    return { missionId, startedAt };
  }

  async waitForEnd(missionId: string, timeoutMs: number): Promise<EndState> {
    const deadline = Date.now() + timeoutMs;
    const poll = this.options.pollMs ?? 2_000;
    for (;;) {
      const { rows } = await this.verifier.query<{ status: string }>(
        'SELECT status FROM coordinator.missions WHERE id = $1',
        [missionId],
      );
      const status = rows[0]?.status ?? 'unknown';
      if (TERMINAL.has(status))
        return { status, timedOut: false, endedAt: this.now().toISOString() };
      if (Date.now() >= deadline)
        return { status, timedOut: true, endedAt: this.now().toISOString() };
      await sleep(poll);
    }
  }

  async cancelMission(missionId: string): Promise<void> {
    await this.options.driver.cancel(missionId);
  }

  async observe(input: {
    spec: TrialSpec;
    missionId: string;
    startedAt: string;
    endedAt: string | null;
  }): Promise<Observations> {
    const independent = await this.independentCheck();
    return collectObservations({
      db: this.verifier,
      missionId: input.missionId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      providerHost: this.facts.providerHost,
      live: true,
      independent,
    });
  }

  /** A fresh probe run by the harness, after the mission ended and the faults stopped. */
  private async independentCheck(): Promise<ObsIndependentCheck> {
    try {
      const probe = createProbe({
        verifier: this.verifier,
        checkoutUrl: this.checkoutUrl,
        probeSecret: this.config.probe.secret as string,
        windowMs: this.config.probe.windowMs,
      });
      const result = await probe.execute();
      const health = await fetch(`${this.checkoutUrl}/health`)
        .then((response) => response.json() as Promise<{ status?: string }>)
        .catch(() => null);
      return {
        probe: result.verdict,
        failedInvariants: result.invariants
          .filter((i) => !i.ok)
          .map((i) => i.name as string),
        healthOk: health ? health.status === 'ok' : null,
      } as const;
    } catch {
      return {
        probe: 'unavailable',
        failedInvariants: [],
        healthOk: null,
      } as const;
    }
  }

  async close(): Promise<void> {
    await this.options.driver.close().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
    await Promise.all(
      [this.verifier, this.admin, this.injectorPool].map((pool) =>
        pool.end().catch(() => undefined),
      ),
    );
  }
}
