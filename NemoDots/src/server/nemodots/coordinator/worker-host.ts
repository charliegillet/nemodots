import {
  AbortReasonSchema,
  type AbortReason,
  type AttemptContext,
  type AttemptId,
  type MissionId,
  type ModelCallId,
  type TaskId,
  type TaskRole,
} from '../contracts/index.js';
import { FenceError, isSupportError } from './errors.js';
import type { AttemptState } from './leases.js';
import type { ClaimedAttempt, OutputInput } from './types.js';
import type { ClaimOptions } from './leases.js';
import type { HostAbortReason } from './publish.js';

// Generic worker host: claim -> handler -> heartbeat -> publish. The team (W4)
// supplies the per-attempt handler; the host owns the lease heartbeat, the
// AbortController and the abort-on-drift check that mirrors
// src/server/dot-agent.ts:137-168: a check function that is polled on an
// interval AND callable at every tool boundary, and that aborts the run when
// the world it started in changed.
//
// What counts as drift (checked every `abortCheckMs`, default 250 ms, from one
// cheap read of attempt + task + mission):
//   - the attempt left `running` (the ledger closure marked it `invalidated`,
//     recovery or pause/cancel marked it `aborted`, the reaper marked it
//     `expired`)  -> the attempt's abortReason (readset_invalidated,
//     mission_paused, mission_cancelled, lease_lost, ...);
//   - the mission is paused/cancelled/finished or its generation moved;
//   - the fencing token no longer matches the task, or the lease expired.
// Status is always written to the database BEFORE anything signals the worker,
// so a late publication is rejected by the fence, not by timing.
//
// A transaction is never held across the handler or any network call: the host
// only opens short transactions inside the coordinator functions it calls.

export class AttemptAbortedError extends Error {
  constructor(readonly reason: AbortReason | 'host_stopped') {
    super(`attempt aborted: ${reason}`);
    this.name = 'AttemptAbortedError';
  }
}

export interface HandlerHelpers {
  signal: AbortSignal;
  /** Re-checks the attempt now (call at each tool boundary); throws AttemptAbortedError when it must stop. */
  checkpoint(): Promise<void>;
  /** The reason the host aborted the attempt, if it did. */
  abortReason(): AbortReason | 'host_stopped' | null;
}

export type HandlerOutcome =
  | { type: 'output'; output: OutputInput }
  | {
      type: 'plan';
      plan: unknown;
      createdByModelCallId: ModelCallId | null;
      cancelTaskIds?: TaskId[];
    }
  | { type: 'failed'; reason: string }
  /** The handler already published (e.g. through publishPlan itself). */
  | { type: 'published' }
  /** The handler stopped on a host condition and wants the task returned to the pool. */
  | { type: 'abort'; reason: HostAbortReason };

export type AttemptHandler = (
  claimed: ClaimedAttempt,
  helpers: HandlerHelpers,
) => Promise<HandlerOutcome>;

/** The coordinator functions the host calls (bound to a CoordinatorDeps). */
export interface WorkerHostCoordinator {
  claimAttempt(options: ClaimOptions): Promise<ClaimedAttempt | null>;
  startAttempt(context: AttemptContext): Promise<void>;
  heartbeat(context: AttemptContext, leaseMs?: number): Promise<unknown>;
  readAttemptState(attemptId: string): Promise<AttemptState | null>;
  publishOutput(context: AttemptContext, input: OutputInput): Promise<unknown>;
  publishPlan(
    context: AttemptContext,
    input: {
      plan: unknown;
      createdByModelCallId: ModelCallId | null;
      cancelTaskIds?: TaskId[];
    },
  ): Promise<unknown>;
  failAttempt(
    context: AttemptContext,
    failure: { reason: string },
  ): Promise<unknown>;
  abortAttempt(
    context: AttemptContext,
    reason: HostAbortReason,
  ): Promise<unknown>;
}

export type HostResult =
  | 'published'
  | 'failed'
  | 'aborted'
  | 'fenced'
  | 'support_rejected'
  | 'handler_published'
  | 'error';

export interface HostRun {
  attemptId: AttemptId;
  taskId: TaskId;
  missionId: MissionId;
  result: HostResult;
  abortReason: AbortReason | 'host_stopped' | null;
  error?: unknown;
}

export interface WorkerHostOptions {
  coordinator: WorkerHostCoordinator;
  workerId: string;
  handler: AttemptHandler;
  roles?: readonly TaskRole[];
  missionId?: MissionId;
  /** Lease length requested at claim time (NEMODOTS_LEASE_MS). */
  leaseMs: number;
  /** Idle sleep between empty claims (default 500 ms). */
  pollMs?: number;
  /** Abort-check interval (default 250 ms). */
  abortCheckMs?: number;
  /** Concurrent attempts in start() mode (default 1). */
  concurrency?: number;
  onRun?: (run: HostRun) => void;
  onError?: (error: unknown) => void;
}

export interface WorkerHost {
  /** Claim and fully process at most one attempt. Null when nothing was runnable. */
  runOnce(): Promise<HostRun | null>;
  start(): void;
  /** Stop claiming, abort in-flight attempts (their leases expire; the reaper requeues them) and wait. */
  stop(): Promise<void>;
}

/** Why the world the attempt started in no longer holds, or null while it does. */
export function classifyDrift(
  state: AttemptState | null,
  context: AttemptContext,
): AbortReason | null {
  if (!state) return 'lease_lost';
  if (state.attemptStatus !== 'running') {
    const recorded = AbortReasonSchema.safeParse(state.abortReason);
    if (recorded.success) return recorded.data;
    return state.attemptStatus === 'invalidated'
      ? 'readset_invalidated'
      : 'lease_lost';
  }
  if (state.missionStatus === 'paused') return 'mission_paused';
  if (state.missionStatus !== 'running') return 'mission_cancelled';
  if (state.missionGeneration !== context.generation)
    return 'mission_cancelled';
  if (
    state.attemptToken !== context.fencingToken ||
    state.taskFence !== context.fencingToken
  )
    return 'lease_lost';
  if (state.leaseExpired) return 'lease_lost';
  return null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
  const {
    coordinator,
    handler,
    leaseMs,
    pollMs = 500,
    abortCheckMs = 250,
    concurrency = 1,
  } = options;
  const report = (error: unknown) => options.onError?.(error);
  const inflight = new Set<(reason: 'host_stopped') => void>();
  const loops: Promise<void>[] = [];
  const stopController = new AbortController();
  let stopping = false;

  async function publish(
    claimed: ClaimedAttempt,
    outcome: HandlerOutcome,
  ): Promise<HostResult> {
    const { context } = claimed;
    switch (outcome.type) {
      case 'output':
        await coordinator.publishOutput(context, outcome.output);
        return 'published';
      case 'plan':
        await coordinator.publishPlan(context, outcome);
        return 'published';
      case 'published':
        return 'handler_published';
      case 'failed':
        await coordinator.failAttempt(context, { reason: outcome.reason });
        return 'failed';
      case 'abort':
        await coordinator.abortAttempt(context, outcome.reason);
        return 'aborted';
    }
  }

  async function processAttempt(claimed: ClaimedAttempt): Promise<HostRun> {
    const { context } = claimed;
    const base = {
      attemptId: context.attemptId,
      taskId: context.taskId,
      missionId: context.missionId,
    };
    const run = (
      result: HostResult,
      abortReason: HostRun['abortReason'] = null,
      error?: unknown,
    ): HostRun => ({ ...base, result, abortReason, error });

    try {
      await coordinator.startAttempt(context);
    } catch (error) {
      if (error instanceof FenceError) return run('fenced');
      throw error;
    }

    const controller = new AbortController();
    let abortReason: AbortReason | 'host_stopped' | null = null;
    const abort = (reason: AbortReason | 'host_stopped') => {
      if (abortReason) return;
      abortReason = reason;
      controller.abort(new AttemptAbortedError(reason));
    };
    inflight.add(abort);
    let checking: Promise<void> | null = null;
    const check = (): Promise<void> => {
      if (!checking)
        checking = (async () => {
          try {
            if (abortReason) return;
            const state = await coordinator.readAttemptState(context.attemptId);
            const drift = classifyDrift(state, context);
            if (drift) abort(drift);
          } finally {
            checking = null;
          }
        })();
      return checking;
    };
    const heartbeatTimer = setInterval(
      () => {
        coordinator.heartbeat(context, leaseMs).catch((error: unknown) => {
          if (error instanceof FenceError) abort('lease_lost');
          else report(error);
        });
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    const checkTimer = setInterval(() => {
      check().catch(report);
    }, abortCheckMs);

    const helpers: HandlerHelpers = {
      signal: controller.signal,
      async checkpoint() {
        await check();
        if (abortReason) throw new AttemptAbortedError(abortReason);
      },
      abortReason: () => abortReason,
    };

    let outcome: HandlerOutcome | undefined;
    let thrown: unknown;
    try {
      outcome = await handler(claimed, helpers);
    } catch (error) {
      thrown = error;
    } finally {
      clearInterval(heartbeatTimer);
      clearInterval(checkTimer);
      inflight.delete(abort);
    }

    // One last look before anything is written: an abort that raced the
    // handler's return must not publish.
    if (!abortReason && !stopping)
      try {
        await check();
      } catch (error) {
        report(error);
      }
    if (abortReason) return run('aborted', abortReason);

    try {
      if (thrown !== undefined) {
        if (thrown instanceof FenceError) return run('fenced');
        const reason =
          thrown instanceof Error ? thrown.message : String(thrown);
        await coordinator.failAttempt(context, { reason });
        return run('failed', null, thrown);
      }
      return run(await publish(claimed, outcome!));
    } catch (error) {
      if (error instanceof FenceError) return run('fenced');
      if (isSupportError(error)) return run('support_rejected');
      // A rejected plan/oversized output: the attempt fails and is retried.
      try {
        await coordinator.failAttempt(context, {
          reason: error instanceof Error ? error.message : String(error),
        });
        return run('failed', null, error);
      } catch (failure) {
        if (failure instanceof FenceError) return run('fenced');
        report(failure);
        return run('error', null, failure);
      }
    }
  }

  async function runOnce(): Promise<HostRun | null> {
    const claimed = await coordinator.claimAttempt({
      workerId: options.workerId,
      missionId: options.missionId,
      roles: options.roles,
      leaseMs,
    });
    if (!claimed) return null;
    const result = await processAttempt(claimed);
    options.onRun?.(result);
    return result;
  }

  async function loop() {
    while (!stopping) {
      try {
        const handled = await runOnce();
        if (!handled) await sleep(pollMs, stopController.signal);
      } catch (error) {
        report(error);
        await sleep(pollMs, stopController.signal);
      }
    }
  }

  return {
    runOnce,
    start() {
      if (loops.length > 0) return;
      stopping = false;
      for (let i = 0; i < concurrency; i += 1) loops.push(loop());
    },
    async stop() {
      stopping = true;
      stopController.abort();
      for (const abort of inflight) abort('host_stopped');
      await Promise.all(loops);
      loops.length = 0;
    },
  };
}
