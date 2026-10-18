// Row types for coordinator.action_intents / authorizations / result_receipts
// (0005_actions) and their mappers to the contract DTOs. bigint columns leave
// node-postgres as strings and are converted with Number(): versions and fences
// are far below 2^53.
import { randomUUID } from 'node:crypto';
import {
  ActionIntentSchema,
  AuthorizationSchema,
  ResultReceiptSchema,
  type ActionAdapter,
  type ActionId,
  type ActionIntent,
  type ActionKind,
  type ActionStatus,
  type AttemptId,
  type Authorization,
  type AuthorizationDecision,
  type AuthorizationStage,
  type BlockReason,
  type Capability,
  type CheckedVector,
  type DependencyVector,
  type Environment,
  type FailureReason,
  type MissionId,
  type ModelCallId,
  type PgClient,
  type PolicyVersion,
  type ResultReceipt,
  type SourceKey,
  type TaskId,
} from '../contracts/index.js';

const num = (value: unknown) => Number(value);
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

export interface IntentDbRow {
  id: string;
  mission_id: string;
  task_id: string;
  attempt_id: string;
  model_call_id: string;
  tool_call_id: string;
  author_fencing_token: number;
  generation: number;
  action: ActionKind;
  adapter: ActionAdapter;
  payload: unknown;
  payload_hash: string;
  target_resource: 'checkout';
  target_source_key: string;
  target_environment: Environment;
  actor_capability: Capability;
  dependency_vector: DependencyVector;
  required_sources: string[];
  expected_target_version: string | number;
  policy_version: string;
  idempotency_key: string;
  expires_at: Date;
  rationale: string;
  status: ActionStatus;
  status_version: number;
  block_reason: BlockReason | null;
  block_detail: string | null;
  failure_reason: FailureReason | null;
  dispatch_fence: string | number | null;
  dispatch_owner: string | null;
  dispatcher_lease_expires_at: Date | null;
  committed_target_version: string | number | null;
  compensates_action_id: string | null;
  proposed_at: Date;
  admitted_at: Date | null;
  committed_at: Date | null;
  dispatched_at: Date | null;
  verified_at: Date | null;
  failed_at: Date | null;
  /** Present when the query selects it (lease check against the database clock). */
  lease_valid?: boolean | null;
  db_now?: Date;
}

export interface IntentRow {
  id: ActionId;
  missionId: MissionId;
  taskId: TaskId;
  attemptId: AttemptId;
  modelCallId: ModelCallId;
  toolCallId: string;
  authorFencingToken: number;
  generation: number;
  action: ActionKind;
  adapter: ActionAdapter;
  payload: unknown;
  payloadHash: string;
  targetSourceKey: string;
  targetEnvironment: Environment;
  actorCapability: Capability;
  dependencyVector: DependencyVector;
  requiredSources: string[];
  expectedTargetVersion: number;
  policyVersion: string;
  idempotencyKey: string;
  expiresAt: Date;
  rationale: string;
  status: ActionStatus;
  statusVersion: number;
  blockReason: BlockReason | null;
  blockDetail: string | null;
  failureReason: FailureReason | null;
  dispatchFence: number | null;
  dispatchOwner: string | null;
  dispatcherLeaseExpiresAt: Date | null;
  committedTargetVersion: number | null;
  compensatesActionId: ActionId | null;
  proposedAt: Date;
  admittedAt: Date | null;
  committedAt: Date | null;
  dispatchedAt: Date | null;
  verifiedAt: Date | null;
  failedAt: Date | null;
  /** The dispatcher lease is unexpired by the database clock (when selected). */
  leaseValid: boolean;
  /** The database clock when the row was read (when selected). */
  dbNow: Date | null;
}

export function mapIntentRow(row: IntentDbRow): IntentRow {
  return {
    id: row.id as ActionId,
    missionId: row.mission_id as MissionId,
    taskId: row.task_id as TaskId,
    attemptId: row.attempt_id as AttemptId,
    modelCallId: row.model_call_id as ModelCallId,
    toolCallId: row.tool_call_id,
    authorFencingToken: row.author_fencing_token,
    generation: row.generation,
    action: row.action,
    adapter: row.adapter,
    payload: row.payload,
    payloadHash: row.payload_hash,
    targetSourceKey: row.target_source_key,
    targetEnvironment: row.target_environment,
    actorCapability: row.actor_capability,
    dependencyVector: row.dependency_vector,
    requiredSources: row.required_sources,
    expectedTargetVersion: num(row.expected_target_version),
    policyVersion: row.policy_version,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    rationale: row.rationale,
    status: row.status,
    statusVersion: row.status_version,
    blockReason: row.block_reason,
    blockDetail: row.block_detail,
    failureReason: row.failure_reason,
    dispatchFence: numOrNull(row.dispatch_fence),
    dispatchOwner: row.dispatch_owner,
    dispatcherLeaseExpiresAt: row.dispatcher_lease_expires_at,
    committedTargetVersion: numOrNull(row.committed_target_version),
    compensatesActionId: row.compensates_action_id as ActionId | null,
    proposedAt: row.proposed_at,
    admittedAt: row.admitted_at,
    committedAt: row.committed_at,
    dispatchedAt: row.dispatched_at,
    verifiedAt: row.verified_at,
    failedAt: row.failed_at,
    leaseValid: row.lease_valid === true,
    dbNow: row.db_now ?? null,
  };
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? iso(value) : null);

/** The contract DTO. `dispatch` is present as soon as a lease was ever granted. */
export function toIntent(row: IntentRow): ActionIntent {
  return {
    id: row.id,
    missionId: row.missionId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    modelCallId: row.modelCallId,
    toolCallId: row.toolCallId,
    authorFencingToken: row.authorFencingToken,
    generation: row.generation,
    action: row.action,
    adapter: row.adapter,
    payload: row.payload as ActionIntent['payload'],
    payloadHash: row.payloadHash,
    target: {
      resource: 'checkout',
      sourceKey: row.targetSourceKey as SourceKey,
      environment: row.targetEnvironment,
    },
    actorCapability: row.actorCapability,
    dependencyVector: row.dependencyVector,
    requiredSources: row.requiredSources as SourceKey[],
    expectedTargetVersion: row.expectedTargetVersion,
    policyVersion: row.policyVersion as PolicyVersion,
    idempotencyKey: row.idempotencyKey,
    expiresAt: iso(row.expiresAt),
    rationale: row.rationale,
    status: row.status,
    statusVersion: row.statusVersion,
    blockReason: row.blockReason,
    blockDetail: row.blockDetail,
    failureReason: row.failureReason,
    dispatch:
      row.dispatchFence !== null &&
      row.dispatchOwner !== null &&
      row.dispatcherLeaseExpiresAt !== null
        ? {
            fence: row.dispatchFence,
            owner: row.dispatchOwner,
            leaseExpiresAt: iso(row.dispatcherLeaseExpiresAt),
          }
        : null,
    proposedAt: iso(row.proposedAt),
    admittedAt: isoOrNull(row.admittedAt),
    committedAt: isoOrNull(row.committedAt),
    dispatchedAt: isoOrNull(row.dispatchedAt),
    verifiedAt: isoOrNull(row.verifiedAt),
    failedAt: isoOrNull(row.failedAt),
  };
}

/** Validating variant for boundaries (queries, tests): throws on a malformed row. */
export const toIntentChecked = (row: IntentRow): ActionIntent =>
  ActionIntentSchema.parse(toIntent(row));

const INTENT_COLUMNS = `*, (dispatcher_lease_expires_at > clock_timestamp()) AS lease_valid,
       clock_timestamp() AS db_now`;

export async function loadIntent(
  client: PgClient,
  actionId: string,
  options: { lock?: boolean } = {},
): Promise<IntentRow | null> {
  const { rows } = await client.query<IntentDbRow>(
    `SELECT ${INTENT_COLUMNS} FROM coordinator.action_intents WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`,
    [actionId],
  );
  return rows[0] ? mapIntentRow(rows[0]) : null;
}

export async function loadIntentsByKey(
  client: PgClient,
  idempotencyKey: string,
): Promise<IntentRow[]> {
  const { rows } = await client.query<IntentDbRow>(
    `SELECT ${INTENT_COLUMNS} FROM coordinator.action_intents
      WHERE idempotency_key = $1 ORDER BY proposed_at, id`,
    [idempotencyKey],
  );
  return rows.map(mapIntentRow);
}

// --- authorizations -----------------------------------------------------------

export interface AuthorizationInput {
  actionId: ActionId;
  stage: AuthorizationStage;
  decision: AuthorizationDecision;
  blockReason: BlockReason | null;
  blockDetail?: string | null;
  checkedVector: CheckedVector;
  targetVersion: { expected: number; live: number };
  authorFence: { token: number; valid: boolean };
  dispatchFence: { token: number; valid: boolean } | null;
  idempotencyBinding: 'new' | 'same_payload' | 'conflict';
}

interface AuthorizationDbRow {
  id: string;
  action_id: string;
  stage: AuthorizationStage;
  decided_at: Date;
  decision: AuthorizationDecision;
  block_reason: BlockReason | null;
  checked_vector: CheckedVector;
  target_expected: string | number;
  target_live: string | number;
  author_fence_token: number;
  author_fence_valid: boolean;
  dispatch_fence_token: string | number | null;
  dispatch_fence_valid: boolean | null;
  policy_version: string;
  idempotency_binding: 'new' | 'same_payload' | 'conflict';
}

export function mapAuthorization(row: AuthorizationDbRow): Authorization {
  return {
    id: row.id as Authorization['id'],
    actionId: row.action_id as ActionId,
    stage: row.stage,
    decidedAt: iso(row.decided_at),
    decision: row.decision,
    blockReason: row.block_reason,
    checkedVector: row.checked_vector,
    targetVersion: {
      expected: num(row.target_expected),
      live: num(row.target_live),
    },
    authorFence: {
      token: row.author_fence_token,
      valid: row.author_fence_valid,
    },
    dispatchFence:
      row.dispatch_fence_token === null
        ? null
        : {
            token: num(row.dispatch_fence_token),
            valid: row.dispatch_fence_valid === true,
          },
    policyVersion: row.policy_version as PolicyVersion,
    idempotencyBinding: row.idempotency_binding,
  };
}

export async function insertAuthorization(
  client: PgClient,
  input: AuthorizationInput,
): Promise<Authorization> {
  const { rows } = await client.query<AuthorizationDbRow>(
    `INSERT INTO coordinator.authorizations
       (id, action_id, stage, decision, block_reason, block_detail, checked_vector,
        target_expected, target_live, author_fence_token, author_fence_valid,
        dispatch_fence_token, dispatch_fence_valid, policy_version, idempotency_binding)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, 'policy-v1', $14)
     RETURNING *`,
    [
      randomUUID(),
      input.actionId,
      input.stage,
      input.decision,
      input.blockReason,
      input.blockDetail ?? null,
      JSON.stringify(input.checkedVector),
      input.targetVersion.expected,
      input.targetVersion.live,
      input.authorFence.token,
      input.authorFence.valid,
      input.dispatchFence?.token ?? null,
      input.dispatchFence?.valid ?? null,
      input.idempotencyBinding,
    ],
  );
  return AuthorizationSchema.parse(mapAuthorization(rows[0]));
}

// --- result receipts ------------------------------------------------------------

interface ResultDbRow {
  id: string;
  action_id: string;
  idempotency_key: string;
  payload_hash: string;
  outcome: ResultReceipt['outcome'];
  control_plane: ResultReceipt['controlPlane'];
  external_effect: ResultReceipt['externalEffect'];
  postcondition: ResultReceipt['postcondition'];
  recorded_at: Date;
}

export function mapResultReceipt(row: ResultDbRow): ResultReceipt {
  return {
    id: row.id as ResultReceipt['id'],
    actionId: row.action_id as ActionId,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    outcome: row.outcome,
    controlPlane: row.control_plane,
    externalEffect: row.external_effect,
    postcondition: row.postcondition,
    recordedAt: iso(row.recorded_at),
  };
}

export interface ResultReceiptInput {
  intent: Pick<IntentRow, 'id' | 'idempotencyKey' | 'payloadHash'>;
  outcome: ResultReceipt['outcome'];
  controlPlane?: ResultReceipt['controlPlane'];
  externalEffect?: ResultReceipt['externalEffect'];
  postcondition?: ResultReceipt['postcondition'];
}

/** Inserts the receipt of (action, outcome); an existing one is returned unchanged. */
export async function insertResultReceipt(
  client: PgClient,
  input: ResultReceiptInput,
): Promise<ResultReceipt> {
  const inserted = await client.query<ResultDbRow>(
    `INSERT INTO coordinator.result_receipts
       (id, action_id, idempotency_key, payload_hash, outcome, control_plane,
        external_effect, postcondition)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
     ON CONFLICT (action_id, outcome) DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      input.intent.id,
      input.intent.idempotencyKey,
      input.intent.payloadHash,
      input.outcome,
      input.controlPlane ? JSON.stringify(input.controlPlane) : null,
      input.externalEffect ? JSON.stringify(input.externalEffect) : null,
      input.postcondition ? JSON.stringify(input.postcondition) : null,
    ],
  );
  const row =
    inserted.rows[0] ??
    (await getResultRow(client, input.intent.id, input.outcome));
  if (!row) throw new Error('result receipt vanished');
  return ResultReceiptSchema.parse(mapResultReceipt(row));
}

async function getResultRow(
  client: PgClient,
  actionId: string,
  outcome: ResultReceipt['outcome'],
): Promise<ResultDbRow | null> {
  const { rows } = await client.query<ResultDbRow>(
    'SELECT * FROM coordinator.result_receipts WHERE action_id = $1 AND outcome = $2',
    [actionId, outcome],
  );
  return rows[0] ?? null;
}

export async function getResultReceipt(
  client: PgClient,
  actionId: string,
  outcome: ResultReceipt['outcome'],
): Promise<ResultReceipt | null> {
  const row = await getResultRow(client, actionId, outcome);
  return row ? mapResultReceipt(row) : null;
}

export async function listResultReceipts(
  client: PgClient,
  actionId: string,
): Promise<ResultReceipt[]> {
  const { rows } = await client.query<ResultDbRow>(
    'SELECT * FROM coordinator.result_receipts WHERE action_id = $1 ORDER BY seq',
    [actionId],
  );
  return rows.map(mapResultReceipt);
}

/**
 * Marks the transaction as one that writes its own Authorization rows, so the
 * closure-block trigger stays quiet (0005_actions).
 */
export async function claimAuthorizationWriter(client: PgClient) {
  await client.query(
    "SELECT set_config('nemodots.authz_by_writer', '1', true)",
  );
}
