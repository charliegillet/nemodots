import { z } from 'zod';
import { DigestSchema } from './digest.js';
import {
  ActionIdSchema,
  AttemptIdSchema,
  AuthorizationIdSchema,
  CountSchema,
  EnvironmentSchema,
  IsoTimeSchema,
  MissionIdSchema,
  ModelCallIdSchema,
  ReceiptIdSchema,
  ResultReceiptIdSchema,
  RevisionSchema,
  SourceKeySchema,
  TaskIdSchema,
} from './ids.js';
import { DependencyVectorSchema } from './model-call.js';
import { ReceiptStatusSchema } from './observation.js';
import { CapabilitySchema } from './task.js';

// CONTRACTS.md section 5: ActionIntent, Authorization, ResultReceipt.

export const ActionKindSchema = z.enum(['set_config', 'flush_cache_namespace']);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionStatusSchema = z.enum([
  'proposed',
  'admitted',
  'blocked',
  'committed',
  'dispatched',
  'verified',
  'failed',
  'outcome_unknown',
  'cancelled',
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/** (rev2 C5) scope of the unique idempotency index. */
export const LIVE_STATUSES = Object.freeze([
  'proposed',
  'admitted',
  'committed',
  'dispatched',
  'outcome_unknown',
] as const satisfies readonly ActionStatus[]);
export function isLiveStatus(status: ActionStatus): boolean {
  return (LIVE_STATUSES as readonly ActionStatus[]).includes(status);
}

export const BlockReasonSchema = z.enum([
  'stale_version',
  'stale_pending_observation',
  'receipt_not_supported',
  'missing_required_source',
  'target_version_mismatch',
  'author_fence_invalid',
  'dispatch_fence_invalid',
  'idempotency_conflict',
  'capability_denied',
  'policy_version_mismatch',
  'payload_invalid',
  'expired',
  'evidence_too_old',
  'citation_out_of_scope',
  'mission_not_running',
  'generation_mismatch',
]);
export type BlockReason = z.infer<typeof BlockReasonSchema>;

export const FailureReasonSchema = z.enum([
  'postcondition_mismatch',
  'superseded_before_verification',
  'effect_not_applied',
  'dispatch_fence_invalid',
  'expired',
  'provider_error',
]);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

export const PolicyVersionSchema = z.literal('policy-v1');
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export const ConfigKeySchema = z.enum([
  'cache.namespace',
  'cache.schema_version',
  'db.pool_max',
  'db.statement_timeout_ms',
  'routing.inventory_source',
  'orders.write_enabled',
  'ui.banner_text',
]);
export type ConfigKey = z.infer<typeof ConfigKeySchema>;

export const ConfigValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ConfigValue = z.infer<typeof ConfigValueSchema>;

export const SetConfigPayloadSchema = z
  .object({
    key: ConfigKeySchema,
    value: ConfigValueSchema,
    expectedCurrentValueDigest: DigestSchema,
  })
  .strict();
export type SetConfigPayload = z.infer<typeof SetConfigPayloadSchema>;

export const FlushCachePayloadSchema = z
  .object({
    namespace: z.string().min(1),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type FlushCachePayload = z.infer<typeof FlushCachePayloadSchema>;

export const ActionAdapterSchema = z.enum(['checkout_config', 'redis_cache']);
export type ActionAdapter = z.infer<typeof ActionAdapterSchema>;
export const ACTION_ADAPTER = Object.freeze({
  set_config: 'checkout_config',
  flush_cache_namespace: 'redis_cache',
} as const satisfies Record<ActionKind, ActionAdapter>);

/** Target source of an action: the member key for set_config, cache.namespace for a flush (rev2 C11). */
export function actionTargetSourceKey(
  action: ActionKind,
  payload: SetConfigPayload | FlushCachePayload,
): string {
  if (action === 'set_config')
    return `checkout.config/${(payload as SetConfigPayload).key}`;
  return 'checkout.config/cache.namespace';
}

export const INTENT_TTL_MS = 10 * 60 * 1000;
export const RATIONALE_MAX = 1000;

export const ActionTargetSchema = z
  .object({
    resource: z.literal('checkout'),
    sourceKey: SourceKeySchema,
    environment: EnvironmentSchema,
  })
  .strict();

const nullableTime = IsoTimeSchema.nullable();

export const ActionIntentSchema = z
  .object({
    id: ActionIdSchema,
    missionId: MissionIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    modelCallId: ModelCallIdSchema,
    toolCallId: z.string().min(1),
    authorFencingToken: CountSchema,
    generation: CountSchema,
    action: ActionKindSchema,
    adapter: ActionAdapterSchema,
    payload: z.union([SetConfigPayloadSchema, FlushCachePayloadSchema]),
    payloadHash: DigestSchema,
    target: ActionTargetSchema,
    actorCapability: CapabilitySchema,
    dependencyVector: DependencyVectorSchema,
    requiredSources: z.array(SourceKeySchema),
    expectedTargetVersion: RevisionSchema,
    policyVersion: PolicyVersionSchema,
    idempotencyKey: DigestSchema,
    expiresAt: IsoTimeSchema,
    rationale: z.string().min(1).max(RATIONALE_MAX),
    status: ActionStatusSchema,
    statusVersion: CountSchema,
    blockReason: BlockReasonSchema.nullable(),
    blockDetail: z.string().nullable(),
    failureReason: FailureReasonSchema.nullable(),
    dispatch: z
      .object({
        fence: CountSchema,
        owner: z.string().min(1),
        leaseExpiresAt: IsoTimeSchema,
      })
      .strict()
      .nullable(),
    proposedAt: IsoTimeSchema,
    admittedAt: nullableTime,
    committedAt: nullableTime,
    dispatchedAt: nullableTime,
    verifiedAt: nullableTime,
    failedAt: nullableTime,
  })
  .strict()
  .superRefine((intent, ctx) => {
    const payloadOk =
      intent.action === 'set_config'
        ? SetConfigPayloadSchema.safeParse(intent.payload).success
        : FlushCachePayloadSchema.safeParse(intent.payload).success;
    if (!payloadOk)
      ctx.addIssue({
        code: 'custom',
        path: ['payload'],
        message: `payload does not match action ${intent.action}`,
      });
    if (intent.adapter !== ACTION_ADAPTER[intent.action])
      ctx.addIssue({
        code: 'custom',
        path: ['adapter'],
        message: `action ${intent.action} uses adapter ${ACTION_ADAPTER[intent.action]}`,
      });
    if (
      payloadOk &&
      intent.target.sourceKey !== actionTargetSourceKey(intent.action, intent.payload)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['target', 'sourceKey'],
        message: 'target.sourceKey does not match the action payload',
      });
    if ((intent.status === 'blocked') !== (intent.blockReason !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['blockReason'],
        message: 'blockReason is set exactly for blocked intents',
      });
    if ((intent.status === 'failed') !== (intent.failureReason !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['failureReason'],
        message: 'failureReason is set exactly for failed intents',
      });
    if (intent.status === 'proposed' && intent.dispatch !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['dispatch'],
        message: 'dispatch is present from admission on',
      });
    if (
      (intent.status === 'admitted' ||
        intent.status === 'committed' ||
        intent.status === 'dispatched') &&
      intent.dispatch === null
    )
      ctx.addIssue({
        code: 'custom',
        path: ['dispatch'],
        message: `a ${intent.status} intent carries its dispatch lease`,
      });
  });
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

/** propose_action tool input (model-facing). Identity, vector, versions are server-derived. */
const proposeCommon = {
  supportingReceiptIds: z.array(ReceiptIdSchema).max(32),
  rationale: z.string().min(1).max(RATIONALE_MAX),
};
export const ProposeInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('set_config'),
      payload: SetConfigPayloadSchema,
      ...proposeCommon,
    })
    .strict(),
  z
    .object({
      action: z.literal('flush_cache_namespace'),
      payload: FlushCachePayloadSchema,
      ...proposeCommon,
    })
    .strict(),
]);
export type ProposeInput = z.infer<typeof ProposeInputSchema>;

export const AuthorizationStageSchema = z.enum(['admission', 'commit', 'dispatch']);
export type AuthorizationStage = z.infer<typeof AuthorizationStageSchema>;
export const AuthorizationDecisionSchema = z.enum([
  'admitted',
  'committed',
  'blocked',
  'dispatched',
]);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;
const STAGE_SUCCESS = {
  admission: 'admitted',
  commit: 'committed',
  dispatch: 'dispatched',
} as const satisfies Record<AuthorizationStage, AuthorizationDecision>;

export const CheckedVectorEntrySchema = z
  .object({
    sourceKey: SourceKeySchema,
    recordedRevision: RevisionSchema,
    liveRevision: RevisionSchema,
    receiptStatus: ReceiptStatusSchema,
    lastConfirmedAt: IsoTimeSchema,
    freshnessOk: z.boolean(),
  })
  .strict();
export const CheckedVectorSchema = z.array(CheckedVectorEntrySchema);
export type CheckedVector = z.infer<typeof CheckedVectorSchema>;

const fence = z.object({ token: CountSchema, valid: z.boolean() }).strict();

export const AuthorizationSchema = z
  .object({
    id: AuthorizationIdSchema,
    actionId: ActionIdSchema,
    stage: AuthorizationStageSchema,
    decidedAt: IsoTimeSchema,
    decision: AuthorizationDecisionSchema,
    blockReason: BlockReasonSchema.nullable(),
    checkedVector: CheckedVectorSchema,
    targetVersion: z
      .object({ expected: RevisionSchema, live: RevisionSchema })
      .strict(),
    authorFence: fence,
    dispatchFence: fence.nullable(),
    policyVersion: PolicyVersionSchema,
    idempotencyBinding: z.enum(['new', 'same_payload', 'conflict']),
  })
  .strict()
  .superRefine((authorization, ctx) => {
    if ((authorization.decision === 'blocked') !== (authorization.blockReason !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['blockReason'],
        message: 'blockReason is set exactly for blocked decisions',
      });
    if (
      authorization.decision !== 'blocked' &&
      authorization.decision !== STAGE_SUCCESS[authorization.stage]
    )
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: `stage ${authorization.stage} decides ${STAGE_SUCCESS[authorization.stage]} or blocked`,
      });
  });
export type Authorization = z.infer<typeof AuthorizationSchema>;

export const ScriptResultSchema = z.enum(['applied', 'already_applied', 'fence_newer']);
export type ScriptResult = z.infer<typeof ScriptResultSchema>;

export const PostconditionSchema = z
  .object({
    kind: z.enum(['history', 'observation']),
    receiptId: ReceiptIdSchema.nullable(),
    configVersion: RevisionSchema.nullable(),
  })
  .strict();
export type Postcondition = z.infer<typeof PostconditionSchema>;

export const ResultReceiptSchema = z
  .object({
    id: ResultReceiptIdSchema,
    actionId: ActionIdSchema,
    idempotencyKey: DigestSchema,
    payloadHash: DigestSchema,
    outcome: z.enum(['committed', 'dispatched', 'verified', 'failed', 'outcome_unknown']),
    controlPlane: z
      .object({
        targetVersionBefore: RevisionSchema,
        targetVersionAfter: RevisionSchema.nullable(),
        causedByActionId: ActionIdSchema,
        beforeDigest: DigestSchema,
        afterDigest: DigestSchema,
      })
      .strict()
      .nullable(),
    externalEffect: z
      .object({
        attemptedAt: IsoTimeSchema,
        acknowledgedAt: nullableTime,
        scriptResult: ScriptResultSchema.nullable(),
        deletedCount: CountSchema.nullable(),
        markerPresent: z.boolean().nullable(),
        fenceBefore: CountSchema.nullable(),
        fenceAfter: CountSchema.nullable(),
      })
      .strict()
      .nullable(),
    postcondition: PostconditionSchema.nullable(),
    recordedAt: IsoTimeSchema,
  })
  .strict()
  .refine(
    (receipt) =>
      receipt.controlPlane === null ||
      receipt.controlPlane.causedByActionId === receipt.actionId,
    {
      path: ['controlPlane', 'causedByActionId'],
      message: 'controlPlane.causedByActionId must be the receipt action',
    },
  );
export type ResultReceipt = z.infer<typeof ResultReceiptSchema>;
