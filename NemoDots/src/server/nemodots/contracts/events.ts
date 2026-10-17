import { z } from 'zod';
import {
  ActionKindSchema,
  ActionTargetSchema,
  AuthorizationDecisionSchema,
  AuthorizationStageSchema,
  BlockReasonSchema,
  CheckedVectorSchema,
  FailureReasonSchema,
  PostconditionSchema,
  ScriptResultSchema,
} from './action.js';
import { DigestSchema } from './digest.js';
import { FindingClaimSchema, FindingConfidenceSchema } from './finding.js';
import {
  ActionIdSchema,
  AttemptIdSchema,
  CountSchema,
  FindingIdSchema,
  InvalidationEventIdSchema,
  IsoTimeSchema,
  MissionIdSchema,
  ModelCallIdSchema,
  ReceiptIdSchema,
  RevisionSchema,
  SourceKeySchema,
  TaskIdSchema,
  TaskOutputIdSchema,
} from './ids.js';
import {
  DependencyVectorSchema,
  ModelCallOutcomeSchema,
  ModelRoleSchema,
  ProviderModeSchema,
  UsageSchema,
} from './model-call.js';
import {
  ProvenanceKindSchema,
  ReceiptStatusSchema,
  SelfWriteSchema,
  TransitionReasonSchema,
  TrustClassSchema,
} from './observation.js';
import {
  AffectedSchema,
  ClosureSchema,
  InvalidationReasonSchema,
  RecoveryEventSchema,
} from './recovery.js';
import { CheckoutStatusSchema, ServiceStateSchema, TelemetrySummarySchema } from './routes.js';
import {
  AbortReasonSchema,
  AttemptKindSchema,
  AttemptStatusSchema,
  MissionSchema,
  MissionStatusSchema,
  RepairOfSchema,
  TaskObjectSchema,
  TaskOutputKindSchema,
  TaskStatusSchema,
} from './task.js';

// CONTRACTS.md section 8: durable mission events with typed payloads (rev2 D4).
// Never included: prompts, raw tool bodies, control data, env values, role URLs,
// the probe secret. Every variant is strict, so a stray key (e.g. `control`) is
// rejected.

export const EventKindSchema = z.enum([
  'mission.created',
  'mission.status',
  'task.created',
  'task.status',
  'attempt.started',
  'attempt.finished',
  'attempt.aborted',
  'model_call.recorded',
  'tool_call.recorded',
  'receipt.registered',
  'receipt.confirmed',
  'receipt.transition',
  'finding.published',
  'output.published',
  'action.proposed',
  'action.decided',
  'action.committed',
  'action.dispatched',
  'action.verified',
  'action.failed',
  'action.outcome_unknown',
  'invalidation.recorded',
  'invalidation.resolved',
  'recovery.recorded',
  'probe.recorded',
  'health.sampled',
  'telemetry.updated',
  'heartbeat',
]);
export type EventKind = z.infer<typeof EventKindSchema>;

const variant = <K extends EventKind, S extends z.ZodRawShape>(kind: K, shape: S) =>
  z.object({ kind: z.literal(kind), ...shape }).strict();

const reason = z.string().nullable();

export const EventPayloadSchema = z.discriminatedUnion('kind', [
  variant('mission.created', { mission: MissionSchema }),
  variant('mission.status', {
    from: MissionStatusSchema,
    to: MissionStatusSchema,
    reason,
  }),
  variant('task.created', {
    task: TaskObjectSchema.pick({
      id: true,
      parentId: true,
      depth: true,
      title: true,
      role: true,
      capabilities: true,
      prerequisites: true,
      justification: true,
      createdByModelCallId: true,
    }),
  }),
  variant('task.status', {
    taskId: TaskIdSchema,
    from: TaskStatusSchema,
    to: TaskStatusSchema,
    reason,
  }),
  variant('attempt.started', {
    attemptId: AttemptIdSchema,
    taskId: TaskIdSchema,
    n: z.number().int().positive(),
    attemptKind: AttemptKindSchema,
    repairOf: RepairOfSchema.nullable(),
    inheritedVectorSize: CountSchema,
  }),
  variant('attempt.finished', {
    attemptId: AttemptIdSchema,
    taskId: TaskIdSchema,
    status: AttemptStatusSchema,
    readSetReceiptIds: z.array(ReceiptIdSchema),
    modelCallCount: CountSchema,
  }),
  variant('attempt.aborted', {
    attemptId: AttemptIdSchema,
    taskId: TaskIdSchema,
    abortReason: AbortReasonSchema,
  }),
  variant('model_call.recorded', {
    modelCallId: ModelCallIdSchema,
    attemptId: AttemptIdSchema,
    taskId: TaskIdSchema,
    role: ModelRoleSchema,
    model: z
      .object({ requested: z.string().min(1), returned: z.string().min(1).nullable() })
      .strict(),
    provider: z.object({ host: z.string().min(1), mode: ProviderModeSchema }).strict(),
    outcome: ModelCallOutcomeSchema,
    prefixDigest: DigestSchema,
    contextDigest: DigestSchema,
    usage: UsageSchema,
    attempts: z.number().int().positive(),
    dependencyVectorSize: CountSchema,
  }),
  variant('tool_call.recorded', {
    attemptId: AttemptIdSchema,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    durationMs: z.number().nonnegative(),
    ok: z.boolean(),
    receiptId: ReceiptIdSchema.nullable(),
  }),
  variant('receipt.registered', {
    receiptId: ReceiptIdSchema,
    sourceKey: SourceKeySchema,
    sourceRevision: RevisionSchema,
    supersedes: ReceiptIdSchema.nullable(),
    trust: TrustClassSchema.exclude(['model_claim']),
    selfWrite: SelfWriteSchema,
    provenanceKind: ProvenanceKindSchema,
    contentDigest: DigestSchema,
  }),
  variant('receipt.confirmed', {
    receiptId: ReceiptIdSchema,
    sourceKey: SourceKeySchema,
    confirmedAt: IsoTimeSchema,
  }),
  variant('receipt.transition', {
    receiptId: ReceiptIdSchema,
    from: ReceiptStatusSchema,
    to: ReceiptStatusSchema,
    reason: TransitionReasonSchema,
  }),
  variant('finding.published', {
    findingId: FindingIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    claim: FindingClaimSchema,
    confidence: FindingConfidenceSchema,
    supportingReceiptIds: z.array(ReceiptIdSchema),
  }),
  variant('output.published', {
    outputId: TaskOutputIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    outputKind: TaskOutputKindSchema,
    digest: DigestSchema,
    dependencyVectorSize: CountSchema,
  }),
  variant('action.proposed', {
    actionId: ActionIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    action: ActionKindSchema,
    target: ActionTargetSchema,
    payloadHash: DigestSchema,
    expectedTargetVersion: RevisionSchema,
    dependencyVector: DependencyVectorSchema,
    requiredSources: z.array(SourceKeySchema),
    admissionNotBefore: IsoTimeSchema,
  }),
  variant('action.decided', {
    actionId: ActionIdSchema,
    stage: AuthorizationStageSchema,
    decision: AuthorizationDecisionSchema,
    blockReason: BlockReasonSchema.nullable(),
    blockDetail: z.string().nullable(),
    checkedVector: CheckedVectorSchema,
    targetVersion: z.object({ expected: RevisionSchema, live: RevisionSchema }).strict(),
    dispatchFence: z
      .object({ token: CountSchema, valid: z.boolean() })
      .strict()
      .nullable(),
  }),
  variant('action.committed', {
    actionId: ActionIdSchema,
    targetVersionBefore: RevisionSchema,
    targetVersionAfter: RevisionSchema,
    causedByActionId: ActionIdSchema,
    afterDigest: DigestSchema,
  }),
  variant('action.dispatched', {
    actionId: ActionIdSchema,
    scriptResult: ScriptResultSchema.nullable(),
    deletedCount: CountSchema.nullable(),
  }),
  variant('action.verified', {
    actionId: ActionIdSchema,
    postcondition: PostconditionSchema,
  }),
  variant('action.failed', {
    actionId: ActionIdSchema,
    failureReason: FailureReasonSchema,
    detail: z.string().nullable(),
  }),
  variant('action.outcome_unknown', {
    actionId: ActionIdSchema,
    detail: z.string(),
  }),
  variant('invalidation.recorded', {
    invalidationEventId: InvalidationEventIdSchema,
    sourceKey: SourceKeySchema,
    oldReceiptId: ReceiptIdSchema,
    newReceiptId: ReceiptIdSchema.nullable(),
    reason: InvalidationReasonSchema,
    selfWrite: SelfWriteSchema,
    /** this mission only */
    affected: AffectedSchema,
    preserved: z.object({ taskIds: z.array(TaskIdSchema) }).strict(),
    closure: ClosureSchema,
  }),
  variant('invalidation.resolved', {
    invalidationEventId: InvalidationEventIdSchema,
    resolvedAt: IsoTimeSchema,
  }),
  variant('recovery.recorded', { recovery: RecoveryEventSchema }),
  variant('probe.recorded', {
    receiptId: ReceiptIdSchema,
    verdict: z.enum(['pass', 'fail']),
    invariants: z.array(
      z.object({ name: z.string().min(1), ok: z.boolean() }).strict(),
    ),
    healthSamples: CountSchema,
    healthOk: CountSchema,
  }),
  variant('health.sampled', {
    checkout: z.object({ status: CheckoutStatusSchema }).strict(),
    provider: z.object({ reachable: z.boolean() }).strict(),
    postgres: ServiceStateSchema,
    redis: ServiceStateSchema,
  }),
  variant('telemetry.updated', { summary: TelemetrySummarySchema }),
  variant('heartbeat', {}),
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventPayloadOf<K extends EventKind> = Extract<EventPayload, { kind: K }>;

export const MissionEventSchema = z
  .object({
    /** coordinator.events.id; id order == commit order */
    id: z.number().int().positive(),
    missionId: MissionIdSchema,
    kind: EventKindSchema,
    at: IsoTimeSchema,
    payload: EventPayloadSchema,
  })
  .strict()
  .refine((event) => event.kind === event.payload.kind, {
    path: ['payload', 'kind'],
    message: 'payload.kind must equal kind',
  });
export type MissionEvent = z.infer<typeof MissionEventSchema>;
