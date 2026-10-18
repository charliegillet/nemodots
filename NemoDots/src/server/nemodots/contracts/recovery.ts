import { z } from 'zod';
import {
  ActionIdSchema,
  AttemptIdSchema,
  CountSchema,
  InvalidationEventIdSchema,
  IsoTimeSchema,
  MissionIdSchema,
  ModelCallIdSchema,
  ReceiptIdSchema,
  RecoveryEventIdSchema,
  RevisionSchema,
  SourceKeySchema,
  TaskIdSchema,
  TaskOutputIdSchema,
} from './ids.js';
import type { ActionStatus } from './action.js';
import type { MissionId } from './ids.js';
import { SelfWriteSchema } from './observation.js';
import type { AttemptStatus, TaskAttempt } from './task.js';

// CONTRACTS.md section 6: InvalidationEvent and RecoveryEvent.

export const InvalidationReasonSchema = z.enum([
  'newer_observation',
  'conflicting_observation',
  'retraction',
  'expiry',
  'self_write_mismatch',
  'collection_changed',
  'publication_rejected',
  'closure_cap_exceeded',
]);
export type InvalidationReason = z.infer<typeof InvalidationReasonSchema>;

export const AffectedSchema = z
  .object({
    modelCallIds: z.array(ModelCallIdSchema),
    attemptIds: z.array(AttemptIdSchema),
    outputIds: z.array(TaskOutputIdSchema),
    actionIds: z.array(ActionIdSchema),
    taskIds: z.array(TaskIdSchema),
  })
  .strict();
export type Affected = z.infer<typeof AffectedSchema>;

export const PerMissionInvalidationSchema = z
  .object({
    missionId: MissionIdSchema,
    affected: AffectedSchema,
    preserved: z.object({ taskIds: z.array(TaskIdSchema) }).strict(),
  })
  .strict();

export const ClosureSchema = z
  .object({ depth: CountSchema, nodes: CountSchema, capped: z.boolean() })
  .strict();

export const InvalidationEventSchema = z
  .object({
    id: InvalidationEventIdSchema,
    missionIds: z.array(MissionIdSchema),
    sourceKey: SourceKeySchema,
    oldReceiptId: ReceiptIdSchema,
    newReceiptId: ReceiptIdSchema.nullable(),
    reason: InvalidationReasonSchema,
    selfWrite: SelfWriteSchema,
    graphVersion: RevisionSchema,
    affected: AffectedSchema,
    perMission: z.array(PerMissionInvalidationSchema),
    closure: ClosureSchema,
    resolvedAt: IsoTimeSchema.nullable(),
    createdAt: IsoTimeSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    const missions = new Set(event.missionIds);
    if (missions.size !== event.missionIds.length)
      ctx.addIssue({
        code: 'custom',
        path: ['missionIds'],
        message: 'missionIds must be unique',
      });
    const covered = new Set(event.perMission.map((entry) => entry.missionId));
    if (covered.size !== event.perMission.length)
      ctx.addIssue({
        code: 'custom',
        path: ['perMission'],
        message: 'perMission must have at most one entry per mission',
      });
    for (const [i, id] of event.missionIds.entries())
      if (!covered.has(id))
        ctx.addIssue({
          code: 'custom',
          path: ['missionIds', i],
          message: 'every mission in missionIds needs a perMission entry',
        });
    for (const [i, entry] of event.perMission.entries())
      if (!missions.has(entry.missionId))
        ctx.addIssue({
          code: 'custom',
          path: ['perMission', i, 'missionId'],
          message: 'perMission entry for a mission not in missionIds',
        });
  });
export type InvalidationEvent = z.infer<typeof InvalidationEventSchema>;

export const RecoveryKindSchema = z.enum([
  'repair_scheduled',
  'replan_scheduled',
  'postcondition_scheduled',
  'intent_blocked',
  'attempt_aborted',
  'branch_preserved',
  'repair_coalesced',
  // rev3: a replan held behind a verified self-write's postcondition, released with the held repairs.
  'replan_coalesced',
  'invalidation_resolved',
  'mission_paused_closure_cap',
]);
export type RecoveryKind = z.infer<typeof RecoveryKindSchema>;

export const RecoveryEventSchema = z
  .object({
    id: RecoveryEventIdSchema,
    invalidationEventId: InvalidationEventIdSchema,
    missionId: MissionIdSchema,
    kind: RecoveryKindSchema,
    taskId: TaskIdSchema.nullable(),
    attemptId: AttemptIdSchema.nullable(),
    newAttemptId: AttemptIdSchema.nullable(),
    actionId: ActionIdSchema.nullable(),
    detail: z.string().max(500),
    createdAt: IsoTimeSchema,
  })
  .strict();
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>;

/** Attempt statuses that close an affected attempt (plus invalidated-with-successor-published). */
export const CLOSED_ATTEMPT_STATUSES = Object.freeze([
  'published',
  'failed',
  'aborted',
  'expired',
] as const satisfies readonly AttemptStatus[]);
/** Intent statuses that close an affected intent. */
export const CLOSED_INTENT_STATUSES = Object.freeze([
  'blocked',
  'failed',
  'cancelled',
  'verified',
] as const satisfies readonly ActionStatus[]);

export type OpenInvalidationAttempt = Pick<
  TaskAttempt,
  'id' | 'status' | 'repairOf'
>;
export type OpenInvalidationIntent = { id: string; status: ActionStatus };

/**
 * open(e) := exists affected attempt not in {published, failed, aborted,
 * expired, invalidated-with-a-published-descendant} OR exists affected intent
 * not in {blocked, failed, cancelled, verified}.
 *
 * A descendant of an attempt is any attempt whose `repairOf.attemptId` names it,
 * or names one of its descendants (the repair chain). The chain is followed
 * TRANSITIVELY through every status: a repair that was itself aborted by a
 * later event (the next repair names the aborted one, not the original), failed
 * or expired does not break it. An invalidated attempt is resolved when ANY
 * descendant published; whether that output is still supported is the
 * caller's check on the task's current output. A chain that ends without a
 * published descendant (running, queued, failed, aborted, cyclic) leaves the
 * event open, i.e. unrecoverable chains fail closed. Fail-closed also covers an
 * affected id missing from `attempts` or `intents`. With `missionId`, that
 * mission's `perMission` subset is used; a mission listed in `missionIds`
 * without an entry falls back to the global affected set (fail closed); a
 * mission not in `missionIds` is not affected (closed).
 *
 * Known limit (pending CONTRACTS revision, see handoff): per CONTRACTS section 6
 * an affected `published` attempt counts as closed and `affected.taskIds` /
 * `outputIds` are ignored, whereas ARCHITECTURE 7.1 (D9) words the rule as
 * "terminal without a published repair". There is no published->invalidated
 * attempt edge, so an event affecting only published attempts is closed at once.
 * Callers needing the stricter rule must also check task/output status.
 */
export function openInvalidation(
  event: Pick<InvalidationEvent, 'affected' | 'perMission' | 'missionIds'>,
  attempts: readonly OpenInvalidationAttempt[],
  intents: readonly OpenInvalidationIntent[],
  missionId?: string,
): boolean {
  let affected: Affected = event.affected;
  if (missionId !== undefined) {
    const entry = event.perMission.find((item) => item.missionId === missionId);
    if (entry) affected = entry.affected;
    else if (!event.missionIds.includes(missionId as MissionId)) return false;
  }
  const byId = new Map(
    attempts.map((attempt) => [attempt.id as string, attempt]),
  );
  const successors = new Map<string, OpenInvalidationAttempt[]>();
  for (const attempt of attempts) {
    if (!attempt.repairOf) continue;
    const list = successors.get(attempt.repairOf.attemptId) ?? [];
    list.push(attempt);
    successors.set(attempt.repairOf.attemptId, list);
  }
  const resolved = (attempt: OpenInvalidationAttempt): boolean => {
    if (
      (CLOSED_ATTEMPT_STATUSES as readonly AttemptStatus[]).includes(
        attempt.status,
      )
    )
      return true;
    if (attempt.status !== 'invalidated') return false;
    // Iterative so a long chain cannot exhaust the stack; `seen` ends cycles.
    const seen = new Set<string>([attempt.id]);
    const pending = [...(successors.get(attempt.id) ?? [])];
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      if (next.status === 'published') return true;
      pending.push(...(successors.get(next.id) ?? []));
    }
    return false;
  };
  for (const id of affected.attemptIds) {
    const attempt = byId.get(id);
    if (!attempt || !resolved(attempt)) return true;
  }
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));
  for (const id of affected.actionIds) {
    const intent = intentById.get(id);
    if (
      !intent ||
      !(CLOSED_INTENT_STATUSES as readonly ActionStatus[]).includes(
        intent.status,
      )
    )
      return true;
  }
  return false;
}
