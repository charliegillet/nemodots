// Independent transcription of the closed enums and value domains in
// docs/nemodots/CONTRACTS.md (revision 2) and ARCHITECTURE.md section 9.2.
// Deliberately NOT imported from src/server/nemodots/contracts: the oracle
// must not share code with the implementation it judges. The self-check test
// compares oracle data against these lists only.

export const RECEIPT_STATUS = [
  'supported',
  'superseded',
  'contested',
  'retracted',
  'expired',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUS)[number];

export const ACTION_STATUS = [
  'proposed',
  'admitted',
  'blocked',
  'committed',
  'dispatched',
  'verified',
  'failed',
  'outcome_unknown',
  'cancelled',
] as const;
export type ActionStatus = (typeof ACTION_STATUS)[number];

export const LIVE_STATUSES = [
  'proposed',
  'admitted',
  'committed',
  'dispatched',
  'outcome_unknown',
] as const satisfies readonly ActionStatus[];

export const BLOCK_REASON = [
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
] as const;
export type BlockReason = (typeof BLOCK_REASON)[number];

export const FAILURE_REASON = [
  'postcondition_mismatch',
  'superseded_before_verification',
  'effect_not_applied',
  'dispatch_fence_invalid',
  'expired',
  'provider_error',
] as const;
export type FailureReason = (typeof FAILURE_REASON)[number];

export const TASK_STATUS = [
  'pending',
  'runnable',
  'leased',
  'running',
  'waiting',
  'succeeded',
  'invalidated',
  'repairing',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const ATTEMPT_STATUS = [
  'running',
  'published',
  'failed',
  'aborted',
  'expired',
  'invalidated',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUS)[number];

export const MISSION_STATUS = [
  'created',
  'blocked_provider',
  'running',
  'paused',
  'awaiting_acceptance',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type MissionStatus = (typeof MISSION_STATUS)[number];

export const EDGE_KIND = ['evidence', 'inheritance', 'scheduling'] as const;
export type EdgeKind = (typeof EDGE_KIND)[number];

export const INVALIDATION_REASON = [
  'newer_observation',
  'conflicting_observation',
  'retraction',
  'expiry',
  'self_write_mismatch',
  'collection_changed',
  'publication_rejected',
  'closure_cap_exceeded',
] as const;
export type InvalidationReason = (typeof INVALIDATION_REASON)[number];

export const RECOVERY_KIND = [
  'repair_scheduled',
  'replan_scheduled',
  'postcondition_scheduled',
  'intent_blocked',
  'attempt_aborted',
  'branch_preserved',
  'repair_coalesced',
  'invalidation_resolved',
  'mission_paused_closure_cap',
] as const;
export type RecoveryKind = (typeof RECOVERY_KIND)[number];

export const TASK_ROLE = [
  'planner',
  'investigator',
  'cache_specialist',
  'database_specialist',
  'routing_specialist',
  'verifier',
  'postcondition',
] as const;
export type TaskRole = (typeof TASK_ROLE)[number];

export const CONFIG_KEYS = [
  'cache.namespace',
  'cache.schema_version',
  'db.pool_max',
  'db.statement_timeout_ms',
  'routing.inventory_source',
  'orders.write_enabled',
  'ui.banner_text',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigValue = string | number | boolean;

/** Value domains per ConfigKey (ARCHITECTURE 9.2), as plain predicates. */
export const CONFIG_DOMAIN: Readonly<
  Record<ConfigKey, (value: ConfigValue) => boolean>
> = {
  'cache.namespace': (v) =>
    typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v),
  'cache.schema_version': (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 9,
  'db.pool_max': (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20,
  'db.statement_timeout_ms': (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 50 && v <= 30000,
  'routing.inventory_source': (v) => v === 'primary' || v === 'replica_stale',
  'orders.write_enabled': (v) => typeof v === 'boolean',
  'ui.banner_text': (v) => typeof v === 'string' && v.length <= 200,
};

/** Member key pattern for `checkout.config/<key>` sources (CONTRACTS 1). */
export const MEMBER_KEY_PATTERN = /^[a-z][a-z0-9_.]{0,60}$/;

/** Maximum canonical size of a normalizedValue (CONTRACTS 2). */
export const MAX_NORMALIZED_BYTES = 16 * 1024;

/** Closure caps (ARCHITECTURE 5.2). */
export const CLOSURE_DEPTH_CAP = 64;
export const CLOSURE_NODE_CAP = 10_000;

/** Policy-v1 freshness windows (CONTRACTS 5). */
export const MAX_AGE_MS = {
  'checkout.health': 120_000,
  'redis.stats': 120_000,
} as const;
