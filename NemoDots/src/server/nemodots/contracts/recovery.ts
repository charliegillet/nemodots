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
 * expired, invalidated-with-successor-published} OR exists affected intent not
 * in {blocked, failed, cancelled, verified}.
 *
 * A successor is an attempt whose `repairOf.attemptId` names the invalidated
 * attempt; it counts when it published, or was itself invalidated and has a
 * published successor. Fail-closed: an affected id missing from `attempts` or
 * `intents` keeps the event open. With `missionId`, that mission's `perMission`
 * subset is used; a mission listed in `missionIds` without an entry falls back
 * to the global affected set (fail closed); a mission not in `missionIds` is
 * not affected (closed).
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
  const resolved = (
    attempt: OpenInvalidationAttempt,
    seen: Set<string>,
  ): boolean => {
    if (
      (CLOSED_ATTEMPT_STATUSES as readonly AttemptStatus[]).includes(
        attempt.status,
      )
    )
      return true;
    if (attempt.status !== 'invalidated' || seen.has(attempt.id)) return false;
    seen.add(attempt.id);
    return (successors.get(attempt.id) ?? []).some(
      (next) =>
        next.status === 'published' ||
        (next.status === 'invalidated' && resolved(next, seen)),
    );
  };
  for (const id of affected.attemptIds) {
    const attempt = byId.get(id);
    if (!attempt || !resolved(attempt, new Set())) return true;
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
