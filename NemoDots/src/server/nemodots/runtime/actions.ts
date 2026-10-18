import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ACTION_ADAPTER,
  actionTargetSourceKey,
  ActionIntentSchema,
  AuthorizationSchema,
  INTENT_TTL_MS,
  ResultReceiptSchema,
  digest,
  type ActionId,
  type ActionIntent,
  type AttemptContext,
  type Authorization,
  type BlockReason,
  type CheckedVector,
  type DependencyVector,
  type EventSinkPort,
  type ModelCallId,
  type PgClient,
  type ProposeInput,
  type ResultReceipt,
  type SetConfigPayload,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { assertCurrent, getReceipt, SupportError } from '../ledger/index.js';
import {
  advanceConfig,
  ConfigVersionError,
  configValueDigest,
  lockConfigRows,
} from '../sandbox/version-authority.js';

// Demo action boundary (simplified W3.1). One intent row per proposal in
// coordinator.action_intents. Admission runs in the same transaction as the
// insert; the commit runs later (the dispatcher queue) and re-checks every
// predicate under FOR UPDATE row locks in the SAME transaction as the config
// write: the intent row, the dependency vector receipts (assertCurrent), the
// config member rows (lockConfigRows) and finally advanceConfig's CAS on the
// target version. A version that moved in between blocks the intent with
// `stale_version`, and the block is recorded in that same transaction.
//
// Simplifications versus the full design: no outbox-driven admission (the
// mission's minAgeMs is not applied), no dispatcher lease expiry/reclaim, and
// flush_cache_namespace is applied directly in the commit (no Lua fence).

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const iso = (value: unknown) =>
  value === null || value === undefined
    ? null
    : new Date(value as string).toISOString();

export function intentFromRow(row: Row): ActionIntent {
  return ActionIntentSchema.parse({
    id: row.id,
    missionId: row.mission_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    modelCallId: row.model_call_id,
    toolCallId: row.tool_call_id,
    authorFencingToken: Number(row.author_fencing_token),
    generation: Number(row.generation),
    action: row.action,
    adapter: row.adapter,
    payload: row.payload,
    payloadHash: row.payload_hash,
    target: {
      resource: row.target_resource,
      sourceKey: row.target_source_key,
      environment: row.target_environment,
    },
    actorCapability: row.actor_capability,
    dependencyVector: row.dependency_vector,
    requiredSources: row.required_sources,
    expectedTargetVersion: Number(row.expected_target_version),
    policyVersion: row.policy_version,
    idempotencyKey: row.idempotency_key,
    expiresAt: iso(row.expires_at),
    rationale: row.rationale,
    status: row.status,
    statusVersion: Number(row.status_version),
    blockReason: row.block_reason,
    blockDetail: row.block_detail,
    failureReason: row.failure_reason,
    dispatch:
      row.dispatch_fence === null
        ? null
        : {
            fence: Number(row.dispatch_fence),
            owner: row.dispatch_owner,
            leaseExpiresAt: iso(row.dispatcher_lease_expires_at),
          },
    proposedAt: iso(row.proposed_at),
    admittedAt: iso(row.admitted_at),
    committedAt: iso(row.committed_at),
    dispatchedAt: iso(row.dispatched_at),
    verifiedAt: iso(row.verified_at),
    failedAt: iso(row.failed_at),
  });
}

export function authorizationFromRow(row: Row): Authorization {
  return AuthorizationSchema.parse({
    id: row.id,
    actionId: row.action_id,
    stage: row.stage,
    decidedAt: iso(row.decided_at),
    decision: row.decision,
    blockReason: row.block_reason,
    checkedVector: row.checked_vector,
    targetVersion: {
      expected: Number(row.target_expected),
      live: Number(row.target_live),
    },
    authorFence: {
      token: Number(row.author_fence_token),
      valid: row.author_fence_valid,
    },
    dispatchFence:
      row.dispatch_fence_token === null
        ? null
        : {
            token: Number(row.dispatch_fence_token),
            valid: row.dispatch_fence_valid,
          },
    policyVersion: row.policy_version,
    idempotencyBinding: row.idempotency_binding,
  });
}

export function resultFromRow(row: Row): ResultReceipt {
  return ResultReceiptSchema.parse({
    id: row.id,
    actionId: row.action_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    outcome: row.outcome,
    controlPlane: row.control_plane,
    externalEffect: row.external_effect,
    postcondition: row.postcondition,
    recordedAt: iso(row.recorded_at),
  });
}

export class ActionRefusedError extends Error {
  constructor(
    readonly reason: BlockReason,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefusedError';
  }
}

export interface ActionsDeps {
  pool: pg.Pool;
  events: EventSinkPort;
  dispatcherId: string;
  /** How long an admitted intent waits in the dispatcher queue before commit. */
  commitDelayMs: number;
  dispatchLeaseMs: number;
  redis?: { unlinkNamespace(namespace: string): Promise<number> };
  onSettled?: (intent: ActionIntent) => void;
}

const configKeyOf = (sourceKey: string) =>
  sourceKey.startsWith('checkout.config/')
    ? sourceKey.slice('checkout.config/'.length)
    : null;

/** The full ActionAdmissionPort is not needed for the demo; see header. */
export function createActions(deps: ActionsDeps) {
  const { pool, events } = deps;

  async function lockIntent(client: PgClient, id: string) {
    const { rows } = await client.query<Row>(
      'SELECT * FROM coordinator.action_intents WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!rows[0]) throw new Error(`unknown action ${id}`);
    return rows[0];
  }

  /** Checks the vector receipts under FOR UPDATE; SupportError carries the reason. */
  async function checkVector(
    client: PgClient,
    vector: DependencyVector,
  ): Promise<CheckedVector> {
    return assertCurrent(
      client,
      vector.map((entry) => entry.receiptId),
      { lockMode: 'update' },
    );
  }

  async function insertAuthorization(
    client: PgClient,
    row: Row,
    input: {
      stage: 'admission' | 'commit';
      decision: 'admitted' | 'committed' | 'blocked';
      blockReason: BlockReason | null;
      blockDetail: string | null;
      checkedVector: CheckedVector;
      live: number;
      dispatchFence: number | null;
    },
  ) {
    await client.query(`SET LOCAL nemodots.authz_by_writer = '1'`);
    await client.query(
      `INSERT INTO coordinator.authorizations
         (id, action_id, stage, decision, block_reason, block_detail, checked_vector,
          target_expected, target_live, author_fence_token, author_fence_valid,
          dispatch_fence_token, dispatch_fence_valid, policy_version, idempotency_binding)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,true,$11,$12,'policy-v1','new')`,
      [
        randomUUID(),
        row.id,
        input.stage,
        input.decision,
        input.blockReason,
        input.blockDetail,
        JSON.stringify(input.checkedVector),
        row.expected_target_version,
        input.live,
        row.author_fencing_token,
        input.dispatchFence,
        input.dispatchFence === null ? null : true,
      ],
    );
    await events.append(client, {
      missionId: row.mission_id,
      kind: 'action.decided',
      payload: {
        kind: 'action.decided',
        actionId: row.id,
        stage: input.stage,
        decision: input.decision,
        blockReason: input.blockReason,
        blockDetail: input.blockDetail,
        checkedVector: input.checkedVector,
        targetVersion: {
          expected: Number(row.expected_target_version),
          live: input.live,
        },
        dispatchFence:
          input.dispatchFence === null
            ? null
            : { token: input.dispatchFence, valid: true },
      },
    } as never);
  }

  async function block(
    client: PgClient,
    row: Row,
    stage: 'admission' | 'commit',
    reason: BlockReason,
    detail: string,
    checkedVector: CheckedVector,
    live: number,
  ) {
    await insertAuthorization(client, row, {
      stage,
      decision: 'blocked',
      blockReason: reason,
      blockDetail: detail,
      checkedVector,
      live,
      dispatchFence: row.dispatch_fence === null ? null : Number(row.dispatch_fence),
    });
    const { rows } = await client.query<Row>(
      `UPDATE coordinator.action_intents
          SET status = 'blocked', status_version = status_version + 1,
              block_reason = $2, block_detail = $3
        WHERE id = $1 RETURNING *`,
      [row.id, reason, detail.slice(0, 1000)],
    );
    return intentFromRow(rows[0]);
  }

  async function liveTargetVersion(client: PgClient, sourceKey: string) {
    const key = configKeyOf(sourceKey);
    if (!key) return 0;
    const locked = await lockConfigRows(client, { keys: [key] });
    return locked.versions.get(key) ?? 0;
  }

  /**
   * propose_action: insert the intent and admit it in one transaction.
   * The vector is the attempt's read set; the expected target version is the
   * revision of the target receipt the attempt observed.
   */
  async function proposeAndAdmit(
    input: ProposeInput,
    ctx: AttemptContext & { modelCallId: ModelCallId; toolCallId: string },
    vector: DependencyVector,
  ): Promise<ActionIntent> {
    const capability =
      input.action === 'set_config'
        ? 'propose_config_change'
        : 'propose_cache_flush';
    if (!ctx.capabilities.includes(capability))
      throw new ActionRefusedError(
        'capability_denied',
        `role ${ctx.role} lacks ${capability}`,
      );
    const targetKey = actionTargetSourceKey(input.action, input.payload);
    const targetEntry = vector.find((entry) => entry.sourceKey === targetKey);
    if (!targetEntry)
      throw new ActionRefusedError(
        'missing_required_source',
        `observe ${targetKey} before proposing a change to it`,
      );
    const id = randomUUID() as ActionId;
    const payloadHash = digest(input.payload);
    const idempotencyKey = digest({
      missionId: ctx.missionId,
      targetKey,
      payload: input.payload,
      toolCallId: ctx.toolCallId,
    });
    return withTransaction(pool, async (client) => {
      if (input.action === 'set_config') {
        const target = await getReceipt(client, targetEntry.receiptId);
        const observed = (target?.normalizedValue as { value?: unknown })
          ?.value;
        const payload = input.payload as SetConfigPayload;
        if (
          observed === undefined ||
          configValueDigest(observed as never) !==
            payload.expectedCurrentValueDigest
        )
          throw new ActionRefusedError(
            'payload_invalid',
            'expectedCurrentValueDigest does not match the observed value (copy valueDigest from observe_source)',
          );
      }
      const missionRow = await client.query<Row>(
        'SELECT environment, status, generation FROM coordinator.missions WHERE id = $1',
        [ctx.missionId],
      );
      const environment = missionRow.rows[0]?.environment ?? 'demo';
      const inserted = await client.query<Row>(
        `INSERT INTO coordinator.action_intents
           (id, mission_id, task_id, attempt_id, model_call_id, tool_call_id,
            author_fencing_token, generation, action, adapter, payload, payload_hash,
            target_resource, target_source_key, target_environment, actor_capability,
            dependency_vector, required_sources, expected_target_version, policy_version,
            idempotency_key, expires_at, rationale, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'checkout',$13,$14,$15,
                 $16::jsonb,$17::text[],$18,'policy-v1',$19,
                 clock_timestamp() + ($20 || ' milliseconds')::interval,$21,'proposed')
         RETURNING *`,
        [
          id,
          ctx.missionId,
          ctx.taskId,
          ctx.attemptId,
          ctx.modelCallId,
          ctx.toolCallId,
          ctx.fencingToken,
          ctx.generation,
          input.action,
          ACTION_ADAPTER[input.action],
          JSON.stringify(input.payload),
          payloadHash,
          targetKey,
          environment,
          capability,
          JSON.stringify(vector),
          [targetKey],
          targetEntry.sourceRevision,
          idempotencyKey,
          String(INTENT_TTL_MS),
          input.rationale,
        ],
      );
      const row = inserted.rows[0];
      const proposed = intentFromRow(row);
      await events.append(client, {
        missionId: ctx.missionId,
        kind: 'action.proposed',
        payload: {
          kind: 'action.proposed',
          actionId: id,
          taskId: ctx.taskId,
          attemptId: ctx.attemptId,
          action: proposed.action,
          target: proposed.target,
          payloadHash,
          expectedTargetVersion: proposed.expectedTargetVersion,
          dependencyVector: vector,
          requiredSources: proposed.requiredSources,
          admissionNotBefore: proposed.proposedAt,
        },
      } as never);

      // Admission, same transaction (C4 stage 1).
      if (missionRow.rows[0]?.status !== 'running')
        return block(client, row, 'admission', 'mission_not_running', 'mission is not running', [], 0);
      let checked: CheckedVector;
      try {
        checked = await checkVector(client, vector);
      } catch (error) {
        if (error instanceof SupportError)
          return block(client, row, 'admission', error.reason as BlockReason, error.message, [], 0);
        throw error;
      }
      const live = await liveTargetVersion(client, targetKey);
      if (live !== proposed.expectedTargetVersion)
        return block(
          client,
          row,
          'admission',
          'stale_version',
          `expected ${targetKey} v${proposed.expectedTargetVersion}, live v${live}`,
          checked,
          live,
        );
      const fence = Number(
        (
          await client.query<{ n: string }>(
            "SELECT nextval('coordinator.action_dispatch_seq') AS n",
          )
        ).rows[0].n,
      );
      const admitted = await client.query<Row>(
        `UPDATE coordinator.action_intents
            SET status = 'admitted', status_version = status_version + 1,
                admitted_at = clock_timestamp(), dispatch_fence = $2, dispatch_owner = $3,
                dispatcher_lease_expires_at = clock_timestamp() + ($4 || ' milliseconds')::interval
          WHERE id = $1 RETURNING *`,
        [id, fence, deps.dispatcherId, String(deps.dispatchLeaseMs)],
      );
      await insertAuthorization(client, admitted.rows[0], {
        stage: 'admission',
        decision: 'admitted',
        blockReason: null,
        blockDetail: null,
        checkedVector: checked,
        live,
        dispatchFence: fence,
      });
      return intentFromRow(admitted.rows[0]);
    });
  }

  /**
   * Commit: every predicate re-run under FOR UPDATE, then the CAS write, all in
   * one transaction. A moved version blocks with stale_version (rolled back to
   * a savepoint so the block itself is recorded in this transaction).
   */
  async function commit(actionId: string): Promise<ActionIntent> {
    const result = await withTransaction(pool, async (client) => {
      const row = await lockIntent(client, actionId);
      if (row.status !== 'admitted') return intentFromRow(row);
      const vector = row.dependency_vector as DependencyVector;
      const mission = await client.query<Row>(
        'SELECT status, generation FROM coordinator.missions WHERE id = $1 FOR SHARE',
        [row.mission_id],
      );
      if (mission.rows[0]?.status !== 'running')
        return block(client, row, 'commit', 'mission_not_running', 'mission is not running', [], 0);
      let checked: CheckedVector = [];
      // Target row FOR UPDATE first: the version the proposal was bound to
      // must still be the live one, checked in the transaction that writes.
      const live = await liveTargetVersion(client, row.target_source_key);
      if (live !== Number(row.expected_target_version))
        return block(
          client,
          row,
          'commit',
          'stale_version',
          `${row.target_source_key}: proposal bound to v${row.expected_target_version}, live v${live} (checked under FOR UPDATE in the commit transaction)`,
          [],
          live,
        );
      try {
        checked = await checkVector(client, vector);
      } catch (error) {
        if (!(error instanceof SupportError)) throw error;
        // The vector names a receipt that is no longer current: report the
        // reason against the live target version read under the same lock.
        return block(
          client,
          row,
          'commit',
          error.reason as BlockReason,
          `${error.message}; ${row.target_source_key} expected v${row.expected_target_version}, live v${live}`,
          [],
          live,
        );
      }
      if (row.action === 'set_config') {
        const payload = row.payload as SetConfigPayload;
        await client.query('SAVEPOINT nemodots_commit');
        try {
          const written = await advanceConfig(client, {
            key: payload.key,
            value: payload.value,
            expectedVersion: Number(row.expected_target_version),
            causedBy: { actor: 'action', actionId: row.id },
          });
          await client.query('RELEASE SAVEPOINT nemodots_commit');
          return settleCommitted(client, row, checked, {
            before: written.versionBefore,
            after: written.versionAfter,
            beforeDigest: written.beforeDigest ?? digest(null),
            afterDigest: written.afterDigest ?? digest(null),
          });
        } catch (error) {
          if (!(error instanceof ConfigVersionError)) throw error;
          await client.query('ROLLBACK TO SAVEPOINT nemodots_commit');
          return block(
            client,
            row,
            'commit',
            error.code === 'stale_version' ? 'stale_version' : 'payload_invalid',
            `CAS on ${payload.key}: expected v${row.expected_target_version}, found v${error.currentVersion ?? live} under FOR UPDATE`,
            checked,
            error.currentVersion ?? live,
          );
        }
      }
      // flush_cache_namespace: cache.namespace version must still be current.
      if (live !== Number(row.expected_target_version))
        return block(
          client,
          row,
          'commit',
          'stale_version',
          `expected ${row.target_source_key} v${row.expected_target_version}, live v${live}`,
          checked,
          live,
        );
      return settleCommitted(client, row, checked, {
        before: live,
        after: live,
        beforeDigest: digest(null),
        afterDigest: digest(null),
      });
    });
    if (
      result.status === 'committed' &&
      result.action === 'flush_cache_namespace' &&
      deps.redis
    ) {
      const namespace = (result.payload as { namespace: string }).namespace;
      const deleted = await deps.redis.unlinkNamespace(namespace);
      return withTransaction(pool, async (client) => {
        const row = await lockIntent(client, actionId);
        await client.query(
          `INSERT INTO coordinator.result_receipts
             (id, action_id, idempotency_key, payload_hash, outcome, external_effect)
           VALUES ($1,$2,$3,$4,'dispatched',$5::jsonb)`,
          [
            randomUUID(),
            row.id,
            row.idempotency_key,
            row.payload_hash,
            JSON.stringify({
              attemptedAt: new Date().toISOString(),
              acknowledgedAt: new Date().toISOString(),
              scriptResult: 'applied',
              deletedCount: deleted,
              markerPresent: null,
              fenceBefore: null,
              fenceAfter: null,
            }),
          ],
        );
        const updated = await client.query<Row>(
          `UPDATE coordinator.action_intents
              SET status = 'verified', status_version = status_version + 1,
                  dispatched_at = clock_timestamp(), verified_at = clock_timestamp()
            WHERE id = $1 RETURNING *`,
          [row.id],
        );
        await events.append(client, {
          missionId: row.mission_id,
          kind: 'action.dispatched',
          payload: {
            kind: 'action.dispatched',
            actionId: row.id,
            scriptResult: 'applied',
            deletedCount: deleted,
          },
        } as never);
        return intentFromRow(updated.rows[0]);
      });
    }
    return result;
  }

  async function settleCommitted(
    client: PgClient,
    row: Row,
    checked: CheckedVector,
    version: {
      before: number;
      after: number;
      beforeDigest: string;
      afterDigest: string;
    },
  ) {
    const updated = await client.query<Row>(
      `UPDATE coordinator.action_intents
          SET status = 'committed', status_version = status_version + 1,
              committed_at = clock_timestamp(), committed_target_version = $2
        WHERE id = $1 RETURNING *`,
      [row.id, version.after],
    );
    await insertAuthorization(client, updated.rows[0], {
      stage: 'commit',
      decision: 'committed',
      blockReason: null,
      blockDetail: null,
      checkedVector: checked,
      live: version.before,
      dispatchFence: Number(row.dispatch_fence),
    });
    await client.query(
      `INSERT INTO coordinator.result_receipts
         (id, action_id, idempotency_key, payload_hash, outcome, control_plane)
       VALUES ($1,$2,$3,$4,'committed',$5::jsonb)`,
      [
        randomUUID(),
        row.id,
        row.idempotency_key,
        row.payload_hash,
        JSON.stringify({
          targetVersionBefore: version.before,
          targetVersionAfter: version.after,
          causedByActionId: row.id,
          beforeDigest: version.beforeDigest,
          afterDigest: version.afterDigest,
        }),
      ],
    );
    await events.append(client, {
      missionId: row.mission_id,
      kind: 'action.committed',
      payload: {
        kind: 'action.committed',
        actionId: row.id,
        targetVersionBefore: version.before,
        targetVersionAfter: version.after,
        causedByActionId: row.id,
        afterDigest: version.afterDigest,
      },
    } as never);
    return intentFromRow(updated.rows[0]);
  }

  /** The watcher saw the self-write receipt: the postcondition holds. */
  async function verify(actionId: string, receiptId: string, version: number) {
    return withTransaction(pool, async (client) => {
      const row = await lockIntent(client, actionId);
      if (row.status !== 'committed') return intentFromRow(row);
      const postcondition = {
        kind: 'observation' as const,
        receiptId,
        configVersion: version,
      };
      await client.query(
        `INSERT INTO coordinator.result_receipts
           (id, action_id, idempotency_key, payload_hash, outcome, postcondition)
         VALUES ($1,$2,$3,$4,'verified',$5::jsonb)`,
        [
          randomUUID(),
          row.id,
          row.idempotency_key,
          row.payload_hash,
          JSON.stringify(postcondition),
        ],
      );
      const updated = await client.query<Row>(
        `UPDATE coordinator.action_intents
            SET status = 'verified', status_version = status_version + 1,
                verified_at = clock_timestamp()
          WHERE id = $1 RETURNING *`,
        [row.id],
      );
      await events.append(client, {
        missionId: row.mission_id,
        kind: 'action.verified',
        payload: { kind: 'action.verified', actionId: row.id, postcondition },
      } as never);
      return intentFromRow(updated.rows[0]);
    });
  }

  /** Waits in the dispatcher queue, then commits. Returns the settled intent. */
  async function proposeAndCommit(
    input: ProposeInput,
    ctx: AttemptContext & { modelCallId: ModelCallId; toolCallId: string },
    vector: DependencyVector,
  ): Promise<{ admitted: ActionIntent; final: ActionIntent }> {
    const admitted = await proposeAndAdmit(input, ctx, vector);
    if (admitted.status !== 'admitted') {
      deps.onSettled?.(admitted);
      return { admitted, final: admitted };
    }
    await new Promise((resolve) => setTimeout(resolve, deps.commitDelayMs));
    const final = await commit(admitted.id);
    deps.onSettled?.(final);
    return { admitted, final };
  }

  async function cancelQueued(missionId: string, _generation: number) {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE coordinator.action_intents
          SET status = 'cancelled', status_version = status_version + 1
        WHERE mission_id = $1 AND status IN ('proposed', 'admitted') RETURNING id`,
      [missionId],
    );
    return rows.map((row) => row.id as ActionId);
  }

  async function read(actionId: string) {
    const { rows } = await pool.query<Row>(
      'SELECT * FROM coordinator.action_intents WHERE id = $1',
      [actionId],
    );
    return rows[0] ? intentFromRow(rows[0]) : null;
  }

  return {
    proposeAndAdmit,
    proposeAndCommit,
    commit,
    verify,
    cancelQueued,
    read,
  };
}

export type Actions = ReturnType<typeof createActions>;
