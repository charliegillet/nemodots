import { randomUUID } from 'node:crypto';
import type {
  ActionId,
  EventSinkPort,
  InvalidationEvent,
  MissionEvent,
  MissionId,
  RecoveryPort,
  TaskId,
} from '../contracts/index.js';
import { createMissionControl, type MissionControl } from './control.js';
import { createEventSink, replayEvents } from './events.js';
import { createCoordinatorHandlers } from './handlers.js';
import {
  claimAttempt,
  heartbeat,
  readAttemptState,
  reapExpired,
  startAttempt,
  type ClaimOptions,
} from './leases.js';
import { pauseMission, reconcileMissions } from './missions.js';
import { createOutbox, type Outbox, type OutboxOptions } from './outbox.js';
import {
  abortAttempt,
  addReadSet,
  delegate,
  failAttempt,
  markWaiting,
  publishFinding,
  publishOutput,
  publishPlan,
  recordModelCall,
  requestReplan,
  resumeFromWaiting,
  type HostAbortReason,
} from './publish.js';
import { getTaskStatus } from './queries.js';
import {
  createRecovery,
  type Recovery,
  type RecoveryOptions,
} from './recovery.js';
import {
  createWorkerHost,
  type WorkerHost,
  type WorkerHostCoordinator,
  type WorkerHostOptions,
} from './worker-host.js';
import type { AttemptContext } from '../contracts/index.js';
import type { CoordinatorDeps } from './types.js';

export * from './errors.js';
export * from './types.js';
export {
  createEventSink,
  replayEvents,
  lastEventId,
  EventBuffer,
  EVENTS_CHANNEL,
} from './events.js';
export {
  validatePlan,
  validateDelegation,
  createsSchedulingCycle,
  childCapabilities,
} from './plan-validation.js';
export {
  createOutbox,
  enqueueOutbox,
  OUTBOX_CHANNEL,
  ActionProposedPayloadSchema,
} from './outbox.js';
export type {
  Outbox,
  OutboxHandler,
  OutboxHelpers,
  OutboxMessage,
} from './outbox.js';
export { OUTBOX_TOPICS, createCoordinatorHandlers } from './handlers.js';
export {
  createRecovery,
  evaluateOpen,
  IntentNotFoundError,
} from './recovery.js';
export type { Recovery } from './recovery.js';
export { createMissionControl } from './control.js';
export type { MissionControl } from './control.js';
export {
  createWorkerHost,
  classifyDrift,
  AttemptAbortedError,
} from './worker-host.js';
export type {
  AttemptHandler,
  HandlerHelpers,
  HandlerOutcome,
  HostRun,
  WorkerHost,
  WorkerHostOptions,
} from './worker-host.js';
export { buildSnapshot } from './snapshot.js';
export { getTaskStatus } from './queries.js';
export type { ReapedAttempt, AttemptState, ClaimOptions } from './leases.js';

export type CreateCoordinatorInput = Omit<
  CoordinatorDeps,
  'events' | 'clock'
> & {
  events?: EventSinkPort;
  clock?: () => Date;
};

export interface CoordinatorOptions {
  /** Identity used for outbox claims and as the dispatcher passed to admit(). */
  workerId?: string;
  recovery?: RecoveryOptions;
  outbox?: Pick<
    OutboxOptions,
    'claimMs' | 'maxAttempts' | 'pollMs' | 'batchSize' | 'onError'
  >;
}

export interface Coordinator {
  deps: CoordinatorDeps;
  /** Identity of this process in outbox claims and as the dispatcher passed to admit(). */
  workerId: string;
  control: MissionControl;
  recovery: Recovery & RecoveryPort;
  outbox: Outbox;
  events: {
    sink: EventSinkPort;
    replay(
      missionId: MissionId,
      afterId: number,
      limit?: number,
    ): Promise<MissionEvent[]>;
  };
  claimAttempt(options: ClaimOptions): ReturnType<typeof claimAttempt>;
  startAttempt(context: AttemptContext): Promise<void>;
  heartbeat(
    context: AttemptContext,
    leaseMs?: number,
  ): ReturnType<typeof heartbeat>;
  readAttemptState(attemptId: string): ReturnType<typeof readAttemptState>;
  reapExpired(): ReturnType<typeof reapExpired>;
  publishOutput(
    context: AttemptContext,
    input: Parameters<typeof publishOutput>[2],
  ): ReturnType<typeof publishOutput>;
  publishPlan(
    context: AttemptContext,
    input: Parameters<typeof publishPlan>[2],
  ): ReturnType<typeof publishPlan>;
  delegate(
    context: AttemptContext,
    input: Parameters<typeof delegate>[2],
  ): ReturnType<typeof delegate>;
  publishFinding(
    context: AttemptContext,
    input: Parameters<typeof publishFinding>[2],
  ): ReturnType<typeof publishFinding>;
  recordModelCall(
    context: AttemptContext,
    input: Parameters<typeof recordModelCall>[2],
  ): Promise<void>;
  addReadSet(
    context: AttemptContext,
    entries: Parameters<typeof addReadSet>[2],
  ): Promise<void>;
  failAttempt(
    context: AttemptContext,
    failure: { reason: string },
  ): ReturnType<typeof failAttempt>;
  abortAttempt(
    context: AttemptContext,
    reason: HostAbortReason,
  ): ReturnType<typeof abortAttempt>;
  markWaiting(context: AttemptContext): Promise<void>;
  resumeFromWaiting(
    context: AttemptContext,
  ): ReturnType<typeof resumeFromWaiting>;
  requestReplan(
    context: AttemptContext,
    reason: string,
  ): ReturnType<typeof requestReplan>;
  getTaskStatus(
    missionId: MissionId,
    taskId: TaskId,
  ): ReturnType<typeof getTaskStatus>;
  /** Reaper + recovery sweep; the outbox loop runs this on every tick. */
  runMaintenance(): Promise<void>;
  /** A worker host over this coordinator; the team supplies the handler. */
  createWorkerHost(
    options: Omit<WorkerHostOptions, 'coordinator' | 'leaseMs'> & {
      leaseMs?: number;
    },
  ): WorkerHost;
  /** Enqueue-free helper for the watcher: settle self-writes / invalidations. */
  onInvalidation(event: InvalidationEvent): Promise<void>;
  onSelfWriteSettled(
    actionId: ActionId,
    outcome: 'verified' | 'failed',
  ): Promise<void>;
}

/** Composition of the coordinator over injected collaborators (ports). */
export function createCoordinator(
  input: CreateCoordinatorInput,
  options: CoordinatorOptions = {},
): Coordinator {
  const deps: CoordinatorDeps = {
    ...input,
    events: input.events ?? createEventSink(),
    clock: input.clock ?? (() => new Date()),
  };
  // Unique per process by default: outbox claims name their owner, and two
  // coordinator processes must not mistake each other's claims for their own.
  const workerId =
    options.workerId ??
    `coordinator-${process.pid}-${randomUUID().slice(0, 8)}`;
  const recovery = createRecovery(deps, {
    ...options.recovery,
    pauseOnClosureCap:
      options.recovery?.pauseOnClosureCap ??
      (async (missionId) => {
        await pauseMission(deps, missionId);
      }),
  });
  const control = createMissionControl(deps);
  const runMaintenance = async () => {
    await reapExpired(deps);
    await recovery.sweep();
    await reconcileMissions(deps);
  };
  const outbox = createOutbox(deps, {
    workerId,
    handlers: createCoordinatorHandlers(deps, recovery, {
      dispatcherId: workerId,
    }),
    maintenance: runMaintenance,
    ...options.outbox,
  });

  const self: Coordinator = {
    deps,
    workerId,
    control,
    recovery,
    outbox,
    events: {
      sink: deps.events,
      replay: (missionId, afterId, limit) =>
        replayEvents(deps.pool, missionId, afterId, limit),
    },
    claimAttempt: (claimOptions) => claimAttempt(deps, claimOptions),
    startAttempt: (context) => startAttempt(deps, context),
    heartbeat: (context, leaseMs) => heartbeat(deps, context, leaseMs),
    readAttemptState: (attemptId) => readAttemptState(deps.pool, attemptId),
    reapExpired: () => reapExpired(deps),
    publishOutput: (context, body) => publishOutput(deps, context, body),
    publishPlan: (context, body) => publishPlan(deps, context, body),
    delegate: (context, body) => delegate(deps, context, body),
    publishFinding: (context, body) => publishFinding(deps, context, body),
    recordModelCall: (context, body) => recordModelCall(deps, context, body),
    addReadSet: (context, entries) => addReadSet(deps, context, entries),
    failAttempt: (context, failure) => failAttempt(deps, context, failure),
    abortAttempt: (context, reason) => abortAttempt(deps, context, reason),
    markWaiting: (context) => markWaiting(deps, context),
    resumeFromWaiting: (context) => resumeFromWaiting(deps, context),
    requestReplan: (context, reason) => requestReplan(deps, context, reason),
    getTaskStatus: (missionId, taskId) =>
      getTaskStatus(deps.pool, missionId, taskId),
    runMaintenance,
    createWorkerHost(hostOptions): WorkerHost {
      const coordinator: WorkerHostCoordinator = {
        claimAttempt: self.claimAttempt,
        startAttempt: self.startAttempt,
        heartbeat: self.heartbeat,
        readAttemptState: self.readAttemptState,
        publishOutput: self.publishOutput,
        publishPlan: self.publishPlan,
        failAttempt: self.failAttempt,
        abortAttempt: self.abortAttempt,
      };
      return createWorkerHost({
        ...hostOptions,
        coordinator,
        leaseMs: hostOptions.leaseMs ?? deps.config.leaseMs,
      });
    },
    onInvalidation: (event) => recovery.onInvalidation(event),
    onSelfWriteSettled: (actionId, outcome) =>
      recovery.onSelfWriteSettled(actionId, outcome),
  };
  return self;
}
