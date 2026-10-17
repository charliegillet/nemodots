import { z } from 'zod';
import { digest, DigestSchema } from './digest.js';
import type { ActionKind } from './action.js';
import type { InvalidationReason } from './recovery.js';

// CONTRACTS.md section 1: identity and scope. Ids are UUIDv4 strings with
// branded TypeScript types; InvalidationEventId is a content digest.

const uuid = () => z.uuid({ version: 'v4' });

export const MissionIdSchema = uuid().brand<'MissionId'>();
export type MissionId = z.infer<typeof MissionIdSchema>;
export const TaskIdSchema = uuid().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;
export const AttemptIdSchema = uuid().brand<'AttemptId'>();
export type AttemptId = z.infer<typeof AttemptIdSchema>;
export const ReceiptIdSchema = uuid().brand<'ReceiptId'>();
export type ReceiptId = z.infer<typeof ReceiptIdSchema>;
export const ModelCallIdSchema = uuid().brand<'ModelCallId'>();
export type ModelCallId = z.infer<typeof ModelCallIdSchema>;
export const ContextSnapshotIdSchema = uuid().brand<'ContextSnapshotId'>();
export type ContextSnapshotId = z.infer<typeof ContextSnapshotIdSchema>;
export const TaskOutputIdSchema = uuid().brand<'TaskOutputId'>();
export type TaskOutputId = z.infer<typeof TaskOutputIdSchema>;
export const ActionIdSchema = uuid().brand<'ActionId'>();
export type ActionId = z.infer<typeof ActionIdSchema>;
export const AuthorizationIdSchema = uuid().brand<'AuthorizationId'>();
export type AuthorizationId = z.infer<typeof AuthorizationIdSchema>;
export const ResultReceiptIdSchema = uuid().brand<'ResultReceiptId'>();
export type ResultReceiptId = z.infer<typeof ResultReceiptIdSchema>;
export const FindingIdSchema = uuid().brand<'FindingId'>();
export type FindingId = z.infer<typeof FindingIdSchema>;
export const RecoveryEventIdSchema = uuid().brand<'RecoveryEventId'>();
export type RecoveryEventId = z.infer<typeof RecoveryEventIdSchema>;
export const DependencyEdgeIdSchema = uuid().brand<'DependencyEdgeId'>();
export type DependencyEdgeId = z.infer<typeof DependencyEdgeIdSchema>;
/** sha256(sourceKey, oldReceiptId, newReceiptId | 'null', reason); see invalidationEventId(). */
export const InvalidationEventIdSchema =
  DigestSchema.brand<'InvalidationEventId'>();
export type InvalidationEventId = z.infer<typeof InvalidationEventIdSchema>;

/** ISO-8601 UTC timestamp (`Z` suffix) as used in every DTO. */
export const IsoTimeSchema = z.iso.datetime();
export const RevisionSchema = z.number().int().nonnegative();
export const CountSchema = z.number().int().nonnegative();

export const EnvironmentSchema = z.enum(['dev', 'test', 'eval']);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const ScopeSchema = z
  .object({
    ownerId: z.string().min(1),
    missionId: MissionIdSchema,
    spaceId: z.string().min(1).nullable(),
    environment: EnvironmentSchema,
    resource: z.string().min(1),
  })
  .strict();
export type Scope = z.infer<typeof ScopeSchema>;

// Source keys (registry-validated). Path segments are single segments: no
// '/', no '.', so a key can never address a path.
export const CONFIG_MEMBER_KEY_PATTERN = /^[a-z][a-z0-9_.]{0,60}$/;
const segment = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
export const SOURCE_KEY_PATTERNS = {
  'checkout.config': /^checkout\.config$/,
  'checkout.config/<key>': /^checkout\.config\/[a-z][a-z0-9_.]{0,60}$/,
  'checkout.health': /^checkout\.health$/,
  'checkout.metrics': /^checkout\.metrics$/,
  'checkout.inventory/<sku>': new RegExp(`^checkout\\.inventory/${segment}$`),
  'checkout.orders.recent': /^checkout\.orders\.recent$/,
  'checkout.acceptance': /^checkout\.acceptance$/,
  'redis.stats': /^redis\.stats$/,
  'runbook/<id>': new RegExp(`^runbook/${segment}$`),
  'opendots.page/<pageId>': new RegExp(`^opendots\\.page/${segment}$`),
  'opendots.memory/<memoryId>': new RegExp(`^opendots\\.memory/${segment}$`),
} as const;
export type SourceKeyFamily = keyof typeof SOURCE_KEY_PATTERNS;

export function sourceKeyFamily(key: string): SourceKeyFamily | null {
  for (const [family, pattern] of Object.entries(SOURCE_KEY_PATTERNS))
    if (pattern.test(key)) return family as SourceKeyFamily;
  return null;
}

/** One anchored pattern matching every family (also emitted into tool JSON Schemas). */
export const SOURCE_KEY_PATTERN = new RegExp(
  `^(?:${Object.values(SOURCE_KEY_PATTERNS)
    .map((pattern) => pattern.source.slice(1, -1))
    .join('|')})$`,
);

export const SourceKeySchema = z
  .string()
  .max(256)
  .regex(SOURCE_KEY_PATTERN, 'unknown source key')
  .brand<'SourceKey'>();
export type SourceKey = z.infer<typeof SourceKeySchema>;

export const SourceTypeSchema = z.enum([
  'controlled_config',
  'controlled_collection',
  'observed_endpoint',
  'observed_store',
  'probe',
  'runbook',
  'page_snapshot',
  'memory_snapshot',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;
export const SourceAuthoritySchema = z.enum(['controlled', 'observed']);
export type SourceAuthority = z.infer<typeof SourceAuthoritySchema>;

export const SourceRefSchema = z
  .object({
    key: SourceKeySchema,
    sourceType: SourceTypeSchema,
    authority: SourceAuthoritySchema,
    scope: ScopeSchema,
  })
  .strict()
  .superRefine((ref, ctx) => {
    const controlledType =
      ref.sourceType === 'controlled_config' ||
      ref.sourceType === 'controlled_collection';
    if (controlledType !== (ref.authority === 'controlled'))
      ctx.addIssue({
        code: 'custom',
        path: ['authority'],
        message: 'authority must be controlled exactly for controlled_* types',
      });
    const family = sourceKeyFamily(ref.key);
    if (
      (family === 'checkout.config') !==
      (ref.sourceType === 'controlled_collection')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['sourceType'],
        message: 'checkout.config is the only controlled_collection',
      });
    if (
      (family === 'checkout.config/<key>') !==
      (ref.sourceType === 'controlled_config')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['sourceType'],
        message: 'checkout.config/<key> members are the only controlled_config',
      });
  });
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Uniqueness key of a source: (ownerId, environment, resource, key). */
export function sourceIdentity(ref: Pick<SourceRef, 'key' | 'scope'>): string {
  return digest([
    ref.scope.ownerId,
    ref.scope.environment,
    ref.scope.resource,
    ref.key,
  ]);
}

/**
 * (rev2 C5) sha256(missionId, taskId, attemptId, action, expectedTargetVersion,
 * toolCallId). The payload hash is deliberately NOT part of the key; it is
 * bound beside it so a replayed tool call id with a tampered payload conflicts.
 */
export function idempotencyKey(
  missionId: MissionId,
  taskId: TaskId,
  attemptId: AttemptId,
  action: ActionKind,
  expectedTargetVersion: number,
  toolCallId: string,
): string {
  if (!Number.isInteger(expectedTargetVersion) || expectedTargetVersion < 0)
    throw new RangeError(
      'expectedTargetVersion must be a non-negative integer',
    );
  if (!toolCallId) throw new RangeError('toolCallId is required');
  return digest([
    'idempotency-v1',
    missionId,
    taskId,
    attemptId,
    action,
    expectedTargetVersion,
    toolCallId,
  ]);
}

/** InvalidationEvent.id = sha256(sourceKey, oldReceiptId, newReceiptId | 'null', reason). */
export function invalidationEventId(
  sourceKey: SourceKey,
  oldReceiptId: ReceiptId,
  newReceiptId: ReceiptId | null,
  reason: InvalidationReason,
): InvalidationEventId {
  return digest([
    'invalidation-v1',
    sourceKey,
    oldReceiptId,
    newReceiptId ?? 'null',
    reason,
  ]) as InvalidationEventId;
}
