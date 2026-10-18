// Row mapping and the small SQL helpers shared by the action transactions.
// Every status change goes through `transition()`: a compare-and-set on
// (id, status[, dispatch_fence]) that checks the contract's transition table
// first and throws a typed error when the row moved.
import { randomUUID } from 'node:crypto';
import {
  canTransition,
  IllegalTransitionError,
  type ActionId,
  type ActionIntent,
  type ActionStatus,
  type Authorization,
  type AuthorizationDecision,
  type AuthorizationStage,
  type BlockReason,
  type CheckedVector,
  type DependencyVector,
  type FailureReason,
  type PgClient,
  type ResultReceipt,
} from '../contracts/index.js';
import { ActionNotFoundError, DispatchFenceError } from './errors.js';

type Json = Record<string, unknown>;

export interface IntentRow {
  id: string;
  mission_id: string;
  task_id: string;
  attempt_id: string;
  model_call_id: string;
  tool_call_id: string;
  author_fencing_token: number;
  generation: number;
  action: string;
  adapter: string;
  payload: Json;
  payload_hash: string;
  supporting_receipt_ids: string[];
  target: Json;
  actor_capability: string;
  dependency_vector: DependencyVector;
  required_sources: string[];
  expected_target_version: number;
  policy_version: string;
  idempotency_key: string;
  expires_at: Date;
  rationale: string;
  status: ActionStatus;
  status_version: number;
  block_reason: BlockReason | null;
  block_detail: string | null;
  failure_reason: FailureReason | null;
  dispatch_fence: number | null;
  dispatch_owner: string | null;
  dispatcher_lease_expires_at: Date | null;
  committed_target_version: number | null;
  proposed_at: Date;
  admitted_at: Date | null;
  committed_at: Date | null;
  dispatched_at: Date | null;
  verified_at: Date | null;
  failed_at: Date | null;
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

export function toIntent(row: IntentRow): ActionIntent {
  return {
    id: row.id,
    missionId: row.mission_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    modelCallId: row.model_call_id,
    toolCallId: row.tool_call_id,
    authorFencingToken: row.author_fencing_token,
    generation: row.generation,
    action: row.action,
    adapter: row.adapter,
    payload: row.payload,
    payloadHash: row.payload_hash,
    target: row.target,
    actorCapability: row.actor_capability,
    dependencyVector: row.dependency_vector,
    requiredSources: row.required_sources,
    expectedTargetVersion: row.expected_target_version,
    policyVersion: row.policy_version,
    idempotencyKey: row.idempotency_key,
    expiresAt: iso(row.expires_at),
    rationale: row.rationale,
    status: row.status,
    statusVersion: row.status_version,
    blockReason: row.block_reason,
    blockDetail: row.block_detail,
    failureReason: row.failure_reason,
    dispatch:
      row.dispatch_fence === null
        ? null
        : {
            fence: row.dispatch_fence,
            owner: row.dispatch_owner as string,
            leaseExpiresAt: iso(row.dispatcher_lease_expires_at as Date),
          },
    proposedAt: iso(row.proposed_at),
    admittedAt: isoOrNull(row.admitted_at),
    committedAt: isoOrNull(row.committed_at),
    dispatchedAt: isoOrNull(row.dispatched_at),
    verifiedAt: isoOrNull(row.verified_at),
    failedAt: isoOrNull(row.failed_at),
  } as unknown as ActionIntent;
}

export type IntentLock = 'update' | 'share' | 'none';

export async function findIntentRow(
  client: PgClient,
  actionId: string,
  lock: IntentLock = 'none',
): Promise<IntentRow | null> {
  const clause =
    lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
  const { rows } = await client.query<IntentRow>(
    `SELECT * FROM coordinator.action_intents WHERE id = $1${clause}`,
    [actionId],
  );
  return rows[0] ?? null;
}

export async function getIntentRow(
  client: PgClient,
  actionId: string,
  lock: IntentLock = 'none',
): Promise<IntentRow> {
  const row = await findIntentRow(client, actionId, lock);
  if (!row) throw new ActionNotFoundError(actionId);
  return row;
}

export async function getIntent(
  client: PgClient,
  actionId: string,
): Promise<ActionIntent> {
  return toIntent(await getIntentRow(client, actionId));
}

const TIME_COLUMN: Partial<Record<ActionStatus, string>> = {
  admitted: 'admitted_at',
  committed: 'committed_at',
  dispatched: 'dispatched_at',
  verified: 'verified_at',
  failed: 'failed_at',
};

export interface TransitionExtra {
  blockReason?: BlockReason;
  blockDetail?: string | null;
  failureReason?: FailureReason;
  /** assignments appended to the SET list, as [column, value] pairs */
  set?: [string, unknown][];
  /** `column = now() + ms` (database clock), e.g. a dispatcher lease */
  setIntervalMs?: [string, number][];
  /** requires this dispatch fence AND an unexpired dispatcher lease */
  dispatchFence?: number;
}

/**
 * CAS from `from` to `to`. Zero rows matched means someone else moved the
 * intent (or the fence/lease no longer holds): DispatchFenceError, nothing
 * written.
 */
export async function transition(
  client: PgClient,
  actionId: string,
  from: ActionStatus,
  to: ActionStatus,
  extra: TransitionExtra = {},
): Promise<IntentRow> {
  if (!canTransition('action', from, to))
    throw new IllegalTransitionError('action', from, to);
  const params: unknown[] = [actionId, from, to];
  const sets = ['status = $3', 'status_version = status_version + 1'];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  const timeColumn = TIME_COLUMN[to];
  if (timeColumn) sets.push(`${timeColumn} = now()`);
  if (to === 'blocked') {
    add('block_reason', extra.blockReason ?? null);
    add('block_detail', extra.blockDetail ?? null);
  }
  if (to === 'failed') add('failure_reason', extra.failureReason ?? null);
  for (const [column, value] of extra.set ?? []) add(column, value);
  for (const [column, ms] of extra.setIntervalMs ?? []) {
    params.push(ms);
    sets.push(
      `${column} = now() + ($${params.length}::int * interval '1 millisecond')`,
    );
  }
  let guard = '';
  if (extra.dispatchFence !== undefined) {
    params.push(extra.dispatchFence);
    guard = ` AND dispatch_fence = $${params.length} AND dispatcher_lease_expires_at > clock_timestamp()`;
  }
  const { rows } = await client.query<IntentRow>(
    `UPDATE coordinator.action_intents SET ${sets.join(', ')}
      WHERE id = $1 AND status = $2${guard} RETURNING *`,
    params,
  );
  if (!rows[0])
    throw new DispatchFenceError(
      actionId,
      extra.dispatchFence === undefined ? 'not_admitted' : 'fence_mismatch',
      `could not move ${from} -> ${to}`,
    );
  return rows[0];
}

export interface AuthorizationInput {
  actionId: string;
  stage: AuthorizationStage;
  decision: AuthorizationDecision;
  blockReason: BlockReason | null;
  checkedVector: CheckedVector;
  targetVersion: { expected: number; live: number };
  authorFence: { token: number; valid: boolean };
  dispatchFence: { token: number; valid: boolean } | null;
  idempotencyBinding: Authorization['idempotencyBinding'];
}

/** Authorizations are immutable; one is written per decision (never for a duplicate delivery, C2). */
export async function insertAuthorization(
  client: PgClient,
  input: AuthorizationInput,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO coordinator.authorizations
       (id, action_id, stage, decision, block_reason, checked_vector, target_version,
        author_fence, dispatch_fence, policy_version, idempotency_binding)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, 'policy-v1', $10)`,
    [
      id,
      input.actionId,
      input.stage,
      input.decision,
      input.blockReason,
      JSON.stringify(input.checkedVector),
      JSON.stringify(input.targetVersion),
      JSON.stringify(input.authorFence),
      input.dispatchFence === null ? null : JSON.stringify(input.dispatchFence),
      input.idempotencyBinding,
    ],
  );
  return id;
}

interface ReceiptRow {
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

const toReceipt = (row: ReceiptRow): ResultReceipt =>
  ({
    id: row.id,
    actionId: row.action_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    outcome: row.outcome,
    controlPlane: row.control_plane,
    externalEffect: row.external_effect,
    postcondition: row.postcondition,
    recordedAt: iso(row.recorded_at),
  }) as unknown as ResultReceipt;

export async function findResultReceipt(
  client: PgClient,
  actionId: string,
): Promise<ResultReceipt | null> {
  const { rows } = await client.query<ReceiptRow>(
    'SELECT * FROM coordinator.result_receipts WHERE action_id = $1',
    [actionId],
  );
  return rows[0] ? toReceipt(rows[0]) : null;
}

export async function insertResultReceipt(
  client: PgClient,
  input: {
    actionId: string;
    idempotencyKey: string;
    payloadHash: string;
    outcome: ResultReceipt['outcome'];
    controlPlane: ResultReceipt['controlPlane'];
  },
): Promise<ResultReceipt> {
  const { rows } = await client.query<ReceiptRow>(
    `INSERT INTO coordinator.result_receipts
       (id, action_id, idempotency_key, payload_hash, outcome, control_plane)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
    [
      randomUUID(),
      input.actionId,
      input.idempotencyKey,
      input.payloadHash,
      input.outcome,
      input.controlPlane === null ? null : JSON.stringify(input.controlPlane),
    ],
  );
  return toReceipt(rows[0]);
}

export async function updateResultReceipt(
  client: PgClient,
  actionId: ActionId | string,
  patch: {
    outcome: ResultReceipt['outcome'];
    externalEffect?: ResultReceipt['externalEffect'];
    postcondition?: ResultReceipt['postcondition'];
  },
): Promise<ResultReceipt> {
  const { rows } = await client.query<ReceiptRow>(
    `UPDATE coordinator.result_receipts
        SET outcome = $2,
            external_effect = COALESCE($3::jsonb, external_effect),
            postcondition = COALESCE($4::jsonb, postcondition),
            recorded_at = clock_timestamp()
      WHERE action_id = $1 RETURNING *`,
    [
      actionId,
      patch.outcome,
      patch.externalEffect ? JSON.stringify(patch.externalEffect) : null,
      patch.postcondition ? JSON.stringify(patch.postcondition) : null,
    ],
  );
  if (!rows[0]) throw new ActionNotFoundError(actionId);
  return toReceipt(rows[0]);
}

/** One plain (non-transactional) read on a pooled connection. */
export async function plainRead<T>(
  pool: { connect(): Promise<import('pg').PoolClient> },
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
