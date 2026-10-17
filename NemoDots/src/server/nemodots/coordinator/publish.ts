import { randomUUID } from 'node:crypto';
import {
  FindingClaimSchema,
  FindingConfidenceSchema,
  DependencyVectorSchema,
  TASK_OUTPUT_MAX_BYTES,
  canonicalByteLength,
  canonicalJson,
  allowedCapabilities,
  delegableRoles,
  digest,
  sha256Hex,
  unionDependencyVectors,
  type AttemptContext,
  type AttemptId,
  type DependencyVector,
  type FindingConfidence,
  type FindingId,
  type MissionId,
  type ModelCallId,
  type ModelCallRecord,
  type ContextSnapshot,
  type Plan,
  type ReceiptId,
  type TaskId,
  type TaskOutputId,
  type TaskOutputKind,
  type TaskRole,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { finishAttempt } from './attempts.js';
import {
  CapabilityDeniedError,
  CitationOutOfScopeError,
  DelegationRejectedError,
  FenceError,
  PlanRejectedError,
  isSupportError,
  type SupportErrorShape,
} from './errors.js';
import { EventBuffer } from './events.js';
import { lockFencedAttempt, type FenceOptions, type FencedAttempt } from './fence.js';
import { carryRepair } from './leases.js';
import {
  childCapabilities,
  validateDelegation,
  validatePlan,
} from './plan-validation.js';
import {
  recordPublicationRejection,
  releaseGate,
  resolveClosedInvalidations,
  scheduleReplan,
  type RecoveryOptions,
} from './recovery.js';
import type { MissionRow, TaskRow } from './rows.js';
import {
  enqueueMissionEvaluate,
  failedAttemptCount,
  insertTask,
  lockTasks,
  promoteRunnable,
  requeueTask,
  transitionTask,
  type TxCtx,
} from './tasks.js';
import type {
  CoordinatorDeps,
  OutputInput,
  PublishedOutput,
} from './types.js';

// ARCHITECTURE.md G2 / section 6. Every publication is ONE transaction:
//
//   attempt lookup -> SELECT missions ... FOR SHARE -> fence + generation check
//   -> SupportValidator.assertCurrent(client, ids, { lockMode: 'share' })
//   -> writes -> events (last, they hold the events advisory lock)
//
// Rejections write nothing:
//   FenceError    the caller no longer owns the attempt (lease taken over,
//                 status left running, generation moved, mission not running);
//                 for recordModelCall the injected recordOrphanedAttempt stores
//                 the completed inference call unfenced (C16).
//   SupportError  the evidence is stale: the publication rolls back, then a
//                 second transaction moves the attempt to `invalidated`
//                 (abortReason publication_rejected), writes a synthetic
//                 InvalidationEvent and schedules a repair (C13). The original
//                 SupportError is rethrown so the worker stops.
//
// plan/delegate also take FOR UPDATE (not SHARE) on the mission row: their
// task-count caps are checked under that lock, so concurrent enqueues cannot
// both pass the cap. FOR UPDATE conflicts with cancel exactly like SHARE does.

export type PublishDeps = Pick<
  CoordinatorDeps,
  | 'pool'
  | 'config'
  | 'events'
  | 'supportValidator'
  | 'ledger'
  | 'recordOrphanedAttempt'
  | 'intents'
  | 'clock'
>;

interface PublicationSpec<T> {
  context: AttemptContext;
  fence?: FenceOptions;
  /** Receipts the publication rests on; asserted current under lock. */
  vector?: (fenced: FencedAttempt) => DependencyVector;
  write: (fenced: FencedAttempt, tx: TxCtx) => Promise<T>;
}

const RECOVERY_OPTIONS: RecoveryOptions = {};

export async function runPublication<T>(
  deps: PublishDeps,
  spec: PublicationSpec<T>,
): Promise<T> {
  let attemptedVector: DependencyVector = [];
  try {
    return await withTransaction(deps.pool, async (client) => {
      const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
      const fenced = await lockFencedAttempt(client, spec.context, spec.fence);
      const vector = spec.vector ? spec.vector(fenced) : [];
      attemptedVector = vector;
      const ids = [...new Set(vector.map((entry) => entry.receiptId))];
      if (ids.length > 0)
        await deps.supportValidator.assertCurrent(
          client,
          ids as ReceiptId[],
          { lockMode: 'share' },
        );
      const result = await spec.write(fenced, tx);
      await tx.events.flush(client);
      return result;
    });
  } catch (error) {
    if (isSupportError(error))
      await rejectAfterSupportError(deps, spec.context, attemptedVector, error);
    throw error;
  }
}

async function rejectAfterSupportError(
  deps: PublishDeps,
  context: AttemptContext,
  vector: DependencyVector,
  error: SupportErrorShape,
) {
  await withTransaction(deps.pool, async (client) => {
    const tx: TxCtx = { client, events: new EventBuffer(deps.events) };
    let fenced: FencedAttempt;
    try {
      fenced = await lockFencedAttempt(client, context, {
        ignoreLease: true,
        taskStatuses: ['running', 'waiting'],
      });
    } catch (fence) {
      // Someone else already moved the attempt (takeover, invalidation): the
      // rejected publication wrote nothing and there is nothing more to do.
      if (fence instanceof FenceError) return;
      throw fence;
    }
    await recordPublicationRejection(
      tx,
      deps,
      RECOVERY_OPTIONS,
      fenced,
      vector,
      error,
      deps.clock(),
    );
    await tx.events.flush(client);
  });
}

const union = unionDependencyVectors;

// ----------------------------------------------------------------- outputs

export interface TaskCompletionContext {
  tx: TxCtx;
  deps: PublishDeps;
  fenced: FencedAttempt;
}

/** Shared tail of a completing publication: attempt published, task succeeded, dependents promoted. */
async function completeTask(
  ctx: TaskCompletionContext,
  outputId: string,
): Promise<void> {
  const { tx, deps, fenced } = ctx;
  let task = fenced.task;
  if (task.status === 'waiting')
    task = await transitionTask(tx, task, 'running', {
      reason: 'children_done',
    });
  await finishAttempt(tx, fenced.attempt, 'published');
  await transitionTask(tx, task, 'succeeded', {
    reason: 'output_published',
    outputId,
  });
  await promoteRunnable(tx, task.mission_id);
  if (task.role === 'postcondition')
    await releaseGate(tx, task.mission_id, task.id);
  await resolveClosedInvalidations(tx, deps, task.mission_id);
  await enqueueMissionEvaluate(tx.client, task.mission_id);
}

export async function publishOutput(
  deps: PublishDeps,
  context: AttemptContext,
  input: OutputInput,
): Promise<PublishedOutput> {
  if (input.kind === 'plan')
    throw new RangeError('plans are published with publishPlan');
  const bytes = canonicalByteLength(input.content);
  if (bytes > TASK_OUTPUT_MAX_BYTES)
    throw new RangeError(
      `output content is ${bytes} bytes; the limit is ${TASK_OUTPUT_MAX_BYTES}`,
    );
  const requested = DependencyVectorSchema.parse(input.dependencyVector);
  return runPublication(deps, {
    context,
    vector: (fenced) =>
      union(requested, fenced.attempt.inherited_dependency_vector),
    async write(fenced, tx) {
      const vector = union(
        requested,
        fenced.attempt.inherited_dependency_vector,
      );
      const outputId = randomUUID();
      const outputDigest = digest(input.content);
      await tx.client.query(
        `INSERT INTO coordinator.task_outputs
           (id, task_id, attempt_id, mission_id, kind, content, digest, dependency_vector)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
        [
          outputId,
          fenced.task.id,
          fenced.attempt.id,
          fenced.task.mission_id,
          input.kind,
          canonicalJson(input.content),
          outputDigest,
          JSON.stringify(vector),
        ],
      );
      await deps.ledger.recordArtifact(tx.client, {
        kind: 'task_output',
        id: outputId,
        missionId: fenced.task.mission_id as MissionId,
        taskId: fenced.task.id as TaskId,
        attemptId: fenced.attempt.id,
        dependencyVector: vector,
      });
      tx.events.add(fenced.task.mission_id, {
        kind: 'output.published',
        outputId: outputId as TaskOutputId,
        taskId: fenced.task.id as TaskId,
        attemptId: fenced.attempt.id as AttemptId,
        outputKind: input.kind as TaskOutputKind,
        digest: outputDigest,
        dependencyVectorSize: vector.length,
      });
      await completeTask({ tx, deps, fenced }, outputId);
      return { outputId: outputId as TaskOutputId, digest: outputDigest };
    },
  });
}

// -------------------------------------------------------------------- plan

export interface PublishPlanInput {
  plan: Plan | unknown;
  /** The planner model call that emitted the plan (provenance only, never an evidence edge). */
  createdByModelCallId: ModelCallId | null;
  /** Obsolete tasks a replan supersedes (same mission, non-terminal). */
  cancelTaskIds?: TaskId[];
}

export interface PublishedPlan extends PublishedOutput {
  taskIds: TaskId[];
}

/**
 * Persists a validated plan as root tasks and completes the planner attempt.
 * Caps are checked under FOR UPDATE on the mission row. Plan tasks record
 * createdByModelCallId and get NO evidence edge from the planner's reads: the
 * plan is a scheduling artifact (D1), so the plan output's dependency vector is
 * empty and nothing is passed to the ledger.
 */
export async function publishPlan(
  deps: PublishDeps,
  context: AttemptContext,
  input: PublishPlanInput,
): Promise<PublishedPlan> {
  return runPublication(deps, {
    context,
    fence: { missionLock: 'update' },
    async write(fenced, tx) {
      if (fenced.task.role !== 'planner')
        throw new PlanRejectedError(['only the planner task publishes a plan']);
      const existing = await tx.client.query<{ n: string }>(
        `SELECT count(*) AS n FROM coordinator.tasks WHERE mission_id = $1`,
        [fenced.mission.id],
      );
      const verdict = validatePlan(input.plan, {
        maxTasks: fenced.mission.budgets.maxTasks,
        existingTasks: Number(existing.rows[0].n),
      });
      if (!verdict.ok) throw new PlanRejectedError(verdict.issues);
      const defaults = deps.config.taskDefaults;
      const ids = verdict.plan.tasks.map(() => randomUUID() as TaskId);
      for (const [i, planned] of verdict.plan.tasks.entries()) {
        // An empty capability list means "the role's defaults".
        const capabilities = planned.capabilities.length
          ? planned.capabilities
          : allowedCapabilities(planned.role, null);
        await insertTask(tx, {
          id: ids[i],
          missionId: fenced.mission.id as MissionId,
          parentId: null,
          depth: 0,
          title: planned.title,
          question: planned.question,
          role: planned.role,
          capabilities,
          prerequisites: planned.dependsOn.map((index) => ids[index]),
          generation: fenced.mission.generation,
          budget: {
            maxIterations: defaults.maxIterations,
            maxTokens: defaults.maxTokens,
            maxChildren: capabilities.includes('delegate')
              ? fenced.mission.budgets.maxBreadth
              : 0,
          },
          maxAttempts: defaults.maxAttempts,
          createdByModelCallId: input.createdByModelCallId,
          justification: null,
        });
      }
      if (input.cancelTaskIds?.length) {
        const rows = await lockTasks(tx.client, input.cancelTaskIds);
        for (const row of rows) {
          if (row.mission_id !== fenced.mission.id) continue;
          if (['succeeded', 'failed', 'cancelled'].includes(row.status)) continue;
          await transitionTask(tx, row, 'cancelled', {
            reason: 'superseded_by_replan',
          });
        }
      }
      const outputId = randomUUID();
      const outputDigest = digest(verdict.plan);
      await tx.client.query(
        `INSERT INTO coordinator.task_outputs
           (id, task_id, attempt_id, mission_id, kind, content, digest, dependency_vector)
         VALUES ($1, $2, $3, $4, 'plan', $5::jsonb, $6, '[]'::jsonb)`,
        [
          outputId,
          fenced.task.id,
          fenced.attempt.id,
          fenced.mission.id,
          canonicalJson(verdict.plan),
          outputDigest,
        ],
      );
      tx.events.add(fenced.mission.id, {
        kind: 'output.published',
        outputId: outputId as TaskOutputId,
        taskId: fenced.task.id as TaskId,
        attemptId: fenced.attempt.id as AttemptId,
        outputKind: 'plan',
        digest: outputDigest,
        dependencyVectorSize: 0,
      });
      await completeTask({ tx, deps, fenced }, outputId);
      return { outputId: outputId as TaskOutputId, digest: outputDigest, taskIds: ids };
    },
  });
}

// ---------------------------------------------------------------- delegate

export interface DelegateInput {
  title: string;
  role: TaskRole;
  question: string;
  dependsOn: TaskId[];
  justification: string;
  /** The emitting model call's snapshot vector: the context the child inherits. */
  dependencyVector: DependencyVector;
  createdByModelCallId?: ModelCallId | null;
  /** The delegate_task tool call id; makes a replayed call return the same task. */
  toolCallId?: string;
}

export async function delegate(
  deps: PublishDeps,
  context: AttemptContext,
  input: DelegateInput,
): Promise<{ taskId: TaskId; created: boolean }> {
  const requested = DependencyVectorSchema.parse(input.dependencyVector);
  return runPublication(deps, {
    context,
    fence: { missionLock: 'update' },
    vector: (fenced) =>
      union(requested, fenced.attempt.inherited_dependency_vector),
    async write(fenced, tx) {
      const parent = fenced.task;
      if (!parent.capabilities.includes('delegate'))
        throw new CapabilityDeniedError('delegate', parent.role);
      const dedupeKey = input.toolCallId ? `delegate:${input.toolCallId}` : null;
      if (dedupeKey) {
        const repeat = await tx.client.query<TaskRow>(
          `SELECT * FROM coordinator.tasks WHERE mission_id = $1 AND dedupe_key = $2`,
          [parent.mission_id, dedupeKey],
        );
        if (repeat.rows[0])
          return { taskId: repeat.rows[0].id as TaskId, created: false };
      }
      const graph = (
        await tx.client.query<
          Pick<TaskRow, 'id' | 'parent_id' | 'prerequisites'>
        >(
          `SELECT id, parent_id, prerequisites FROM coordinator.tasks WHERE mission_id = $1`,
          [parent.mission_id],
        )
      ).rows;
      const budgets = fenced.mission.budgets;
      const candidateId = randomUUID() as TaskId;
      const issues = validateDelegation(
        {
          role: input.role,
          title: input.title,
          question: input.question,
          justification: input.justification,
          dependsOn: input.dependsOn,
        },
        {
          parent: {
            id: parent.id as TaskId,
            role: parent.role as TaskRole,
            depth: parent.depth,
            capabilities: parent.capabilities as never,
            maxChildren: parent.budget.maxChildren,
          },
          limits: {
            maxDepth: budgets.maxDepth,
            maxBreadth: budgets.maxBreadth,
            maxTasks: budgets.maxTasks,
          },
          totalTasks: graph.length,
          parentChildren: graph.filter((task) => task.parent_id === parent.id)
            .length,
          tasks: graph.map((task) => ({
            id: task.id as TaskId,
            parentId: task.parent_id as TaskId | null,
            prerequisites: task.prerequisites as TaskId[],
          })),
        },
        candidateId,
      );
      if (issues.length > 0) throw new DelegationRejectedError(issues);
      const capabilities = childCapabilities(
        input.role,
        parent.capabilities as never,
      );
      const defaults = deps.config.taskDefaults;
      const vector = union(requested, fenced.attempt.inherited_dependency_vector);
      const child = await insertTask(tx, {
        id: candidateId,
        missionId: parent.mission_id as MissionId,
        parentId: parent.id as TaskId,
        depth: parent.depth + 1,
        title: input.title,
        question: input.question,
        role: input.role,
        capabilities,
        prerequisites: input.dependsOn,
        generation: fenced.mission.generation,
        budget: {
          maxIterations: defaults.maxIterations,
          maxTokens: defaults.maxTokens,
          maxChildren:
            capabilities.includes('delegate') &&
            delegableRoles(input.role).length > 0
              ? budgets.maxBreadth
              : 0,
        },
        maxAttempts: defaults.maxAttempts,
        createdByModelCallId: input.createdByModelCallId ?? null,
        justification: input.justification,
        inheritedDependencyVector: vector,
        dedupeKey,
      });
      await promoteRunnable(tx, parent.mission_id);
      await deps.ledger.recordArtifact(tx.client, {
        kind: 'task',
        id: child.id,
        missionId: parent.mission_id as MissionId,
        taskId: parent.id as TaskId,
        attemptId: fenced.attempt.id,
        dependencyVector: vector,
      });
      return { taskId: child.id as TaskId, created: true };
    },
  });
}

// ---------------------------------------------------------------- findings

export interface FindingInput {
  claim: string;
  supportingReceiptIds: ReceiptId[];
  confidence: FindingConfidence;
  /** The emitting model call's snapshot vector (citations are scope-checked against it). */
  dependencyVector: DependencyVector;
}

export async function publishFinding(
  deps: PublishDeps,
  context: AttemptContext,
  input: FindingInput,
): Promise<{ findingId: FindingId }> {
  FindingClaimSchema.parse(input.claim);
  FindingConfidenceSchema.parse(input.confidence);
  const requested = DependencyVectorSchema.parse(input.dependencyVector);

  const vectorFor = (fenced: FencedAttempt): DependencyVector => {
    const known = new Map<string, DependencyVector[number]>();
    for (const entry of [
      ...requested,
      ...fenced.attempt.inherited_dependency_vector,
      ...fenced.attempt.read_set_vector,
    ])
      known.set(entry.receiptId, entry);
    const scope = new Set<string>([
      ...known.keys(),
      ...fenced.attempt.read_set_receipt_ids,
    ]);
    const outside = input.supportingReceiptIds.filter((id) => !scope.has(id));
    if (outside.length > 0) throw new CitationOutOfScopeError(outside);
    const cited = input.supportingReceiptIds
      .map((id) => known.get(id))
      .filter((entry): entry is DependencyVector[number] => entry !== undefined);
    return union(requested, fenced.attempt.inherited_dependency_vector, cited);
  };

  return runPublication(deps, {
    context,
    vector: vectorFor,
    async write(fenced, tx) {
      const vector = vectorFor(fenced);
      const findingId = randomUUID();
      await tx.client.query(
        `INSERT INTO coordinator.findings
           (id, mission_id, task_id, attempt_id, claim, supporting_receipt_ids,
            confidence, dependency_vector)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8::jsonb)`,
        [
          findingId,
          fenced.task.mission_id,
          fenced.task.id,
          fenced.attempt.id,
          input.claim,
          input.supportingReceiptIds,
          input.confidence,
          JSON.stringify(vector),
        ],
      );
      await deps.ledger.recordArtifact(tx.client, {
        kind: 'finding',
        id: findingId,
        missionId: fenced.task.mission_id as MissionId,
        taskId: fenced.task.id as TaskId,
        attemptId: fenced.attempt.id,
        dependencyVector: vector,
      });
      tx.events.add(fenced.task.mission_id, {
        kind: 'finding.published',
        findingId: findingId as FindingId,
        taskId: fenced.task.id as TaskId,
        attemptId: fenced.attempt.id as AttemptId,
        claim: input.claim,
        confidence: input.confidence,
        supportingReceiptIds: input.supportingReceiptIds,
      });
      return { findingId: findingId as FindingId };
    },
  });
}

// ----------------------------------------------------------- model calls

export interface ModelCallInput {
  record: ModelCallRecord;
  snapshot: ContextSnapshot;
}

/**
 * Records a completed model call against the attempt. If the author's fence
 * was lost while the call was in flight the fenced write is rejected with
 * FenceError, nothing is stored here, and the injected recordOrphanedAttempt
 * stores the billed call unfenced with outcome `orphaned_fence` (C16).
 */
export async function recordModelCall(
  deps: PublishDeps,
  context: AttemptContext,
  input: ModelCallInput,
): Promise<void> {
  const { record, snapshot } = input;
  if (
    record.attemptId !== context.attemptId ||
    record.taskId !== context.taskId ||
    record.scope.missionId !== context.missionId
  )
    throw new RangeError(
      'the model call record does not belong to this attempt context',
    );
  try {
    await runPublication(deps, {
      context,
      vector: () => union(snapshot.dependencyVector, record.outputDependencyVector),
      async write(fenced, tx) {
        await deps.ledger.recordModelCall(tx.client, {
          record,
          snapshot,
          context,
        });
        await tx.client.query(
          `UPDATE coordinator.task_attempts
              SET model_call_ids = array_append(model_call_ids, $2::uuid)
            WHERE id = $1 AND NOT ($2::uuid = ANY (model_call_ids))`,
          [fenced.attempt.id, record.id],
        );
        const last = record.attempts[record.attempts.length - 1];
        tx.events.add(fenced.task.mission_id, {
          kind: 'model_call.recorded',
          modelCallId: record.id,
          attemptId: fenced.attempt.id as AttemptId,
          taskId: fenced.task.id as TaskId,
          role: record.role,
          model: record.model,
          provider: record.provider,
          outcome: record.outcome,
          prefixDigest: snapshot.prefixDigest,
          contextDigest: snapshot.contextDigest,
          usage: last.usage,
          attempts: record.attempts.length,
          dependencyVectorSize: record.outputDependencyVector.length,
        });
      },
    });
  } catch (error) {
    if (error instanceof FenceError) {
      try {
        await deps.recordOrphanedAttempt({
          context,
          record: {
            ...record,
            attempts: record.attempts.map((attempt) => ({
              ...attempt,
              outcome: 'orphaned_fence' as const,
            })),
          },
          fenceReason: error.reason,
        });
      } catch (orphanError) {
        error.orphanRecordError = orphanError;
      }
    }
    throw error;
  }
}

// ----------------------------------------------------------------- readset

/**
 * Adds receipts the attempt read (observe_source) to its readset under the
 * same fenced, support-checked transaction: a receipt that was superseded
 * between registration and now rejects the publication and invalidates the
 * attempt (C13) instead of being silently added.
 */
export async function addReadSet(
  deps: PublishDeps,
  context: AttemptContext,
  entries: DependencyVector,
): Promise<void> {
  const requested = DependencyVectorSchema.parse(entries);
  await runPublication(deps, {
    context,
    vector: () => requested,
    async write(fenced, tx) {
      const merged = union(fenced.attempt.read_set_vector, requested);
      await tx.client.query(
        `UPDATE coordinator.task_attempts
            SET read_set_vector = $2::jsonb, read_set_receipt_ids = $3::uuid[]
          WHERE id = $1`,
        [
          fenced.attempt.id,
          JSON.stringify(merged),
          [...new Set(merged.map((entry) => entry.receiptId))],
        ],
      );
    },
  });
}

// ------------------------------------------------- attempt failure / abort

/** Settles a task whose attempt ended without publishing: retry, or fail it for good. */
async function settleUnpublished(
  tx: TxCtx,
  deps: PublishDeps,
  fenced: FencedAttempt,
  options: { reason: string; exhaust: boolean },
): Promise<'requeued' | 'failed'> {
  const { task, mission } = { task: fenced.task, mission: fenced.mission };
  const failures = await failedAttemptCount(tx.client, task.id);
  const canFail = task.status === 'running' || task.status === 'waiting';
  if (canFail && (options.exhaust || failures >= task.max_attempts)) {
    await transitionTask(tx, task, 'failed', {
      reason: options.reason,
      bumpFence: true,
    });
    if (task.role === 'postcondition')
      await releaseGate(tx, mission.id, task.id);
    await resolveClosedInvalidations(tx, deps, mission.id);
    await enqueueMissionEvaluate(tx.client, mission.id);
    return 'failed';
  }
  await requeueTask(tx, task, {
    reason: options.reason,
    bumpFence: true,
    repair: carryRepair(fenced.attempt, options.reason),
  });
  return 'requeued';
}

/**
 * The attempt failed (handler error, invalid output). It is retried until the
 * worker's failures (failed + expired attempts) reach task.maxAttempts, then
 * the task fails.
 */
export async function failAttempt(
  deps: PublishDeps,
  context: AttemptContext,
  failure: { reason: string },
): Promise<'requeued' | 'failed'> {
  return runPublication(deps, {
    context,
    fence: { ignoreLease: true, taskStatuses: ['leased', 'running', 'waiting'] },
    async write(fenced, tx) {
      await finishAttempt(tx, fenced.attempt, 'failed', {
        failureReason: failure.reason.slice(0, 500),
      });
      return settleUnpublished(tx, deps, fenced, {
        reason: 'attempt_failed',
        exhaust: false,
      });
    },
  });
}

export type HostAbortReason =
  | 'budget_exhausted'
  | 'provider_unreachable'
  | 'lease_lost';

/**
 * The host stops an attempt it still owns: budget exhaustion fails the task
 * (a retry would exhaust again); provider loss returns the task to the pool
 * without counting against maxAttempts.
 */
export async function abortAttempt(
  deps: PublishDeps,
  context: AttemptContext,
  reason: HostAbortReason,
): Promise<'requeued' | 'failed'> {
  return runPublication(deps, {
    context,
    fence: { ignoreLease: true, taskStatuses: ['leased', 'running', 'waiting'] },
    async write(fenced, tx) {
      await finishAttempt(tx, fenced.attempt, 'aborted', { abortReason: reason });
      return settleUnpublished(tx, deps, fenced, {
        reason: `attempt_aborted:${reason}`,
        exhaust: reason === 'budget_exhausted',
      });
    },
  });
}

// ------------------------------------------------- waiting, replan, queries

/** wait_for_children: running -> waiting (fenced). */
export async function markWaiting(
  deps: PublishDeps,
  context: AttemptContext,
): Promise<void> {
  await runPublication(deps, {
    context,
    fence: { taskStatuses: ['running', 'waiting'] },
    async write(fenced, tx) {
      if (fenced.task.status === 'running')
        await transitionTask(tx, fenced.task, 'waiting', {
          reason: 'waiting_for_children',
        });
    },
  });
}

export interface ChildrenStatus {
  children: { id: TaskId; status: string; outputId: string | null; role: string }[];
  allTerminal: boolean;
}

/** waiting -> running once every child is terminal. Returns the children's state. */
export async function resumeFromWaiting(
  deps: PublishDeps,
  context: AttemptContext,
): Promise<ChildrenStatus> {
  return runPublication(deps, {
    context,
    fence: { taskStatuses: ['running', 'waiting'] },
    async write(fenced, tx) {
      const rows = (
        await tx.client.query<
          Pick<TaskRow, 'id' | 'status' | 'output_id' | 'role'>
        >(
          `SELECT id, status, output_id, role FROM coordinator.tasks
            WHERE parent_id = $1 ORDER BY ordinal`,
          [fenced.task.id],
        )
      ).rows;
      const allTerminal = rows.every((row) =>
        ['succeeded', 'failed', 'cancelled'].includes(row.status),
      );
      if (allTerminal && fenced.task.status === 'waiting')
        await transitionTask(tx, fenced.task, 'running', {
          reason: 'children_done',
        });
      return {
        children: rows.map((row) => ({
          id: row.id as TaskId,
          status: row.status,
          outputId: row.output_id,
          role: row.role,
        })),
        allTerminal,
      };
    },
  });
}

/**
 * request_replan: schedules a `replan` attempt for the planner (bounded by
 * config.replanCap per mission). Returns false when the cap is reached or the
 * planner is not idle.
 */
export async function requestReplan(
  deps: PublishDeps,
  context: AttemptContext,
  reason: string,
): Promise<{ scheduled: boolean }> {
  return runPublication(deps, {
    context,
    async write(fenced, tx) {
      if (!fenced.task.capabilities.includes('request_replan'))
        throw new CapabilityDeniedError('request_replan', fenced.task.role);
      const scheduled = await scheduleReplan(
        tx,
        deps,
        fenced.mission as MissionRow,
        sha256Hex(`replan-request:${fenced.attempt.id}`),
        `replan requested: ${reason}`.slice(0, 480),
      );
      return { scheduled };
    },
  });
}

