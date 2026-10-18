// Collects one mission's observations for the oracle with read-only SQL as the
// verifier role (which may read everything, control.* included; nothing read
// here ever reaches a model). Rows become plain records (observations.ts); no
// prompts or completions are read: model calls contribute identities, timings
// and token counts only.
import {
  listMissionTiming,
  splitTiming,
  telemetrySummary,
} from '../telemetry/index.js';
import type {
  ObsAffected,
  ObsAttempt,
  ObsAuthorization,
  ObsCheckedEntry,
  ObsConfigRow,
  ObsEdge,
  ObsIndependentCheck,
  ObsIntent,
  ObsInvalidation,
  ObsNode,
  ObsResult,
  ObsTask,
  ObsTiming,
  Observations,
} from './observations.js';

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

type Row = Record<string, unknown>;
const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);
const isoOrNull = (value: unknown) =>
  value === null || value === undefined ? null : iso(value);
const num = (value: unknown) => Number(value);
const emptyAffected = (): ObsAffected => ({
  modelCallIds: [],
  attemptIds: [],
  outputIds: [],
  actionIds: [],
  taskIds: [],
});

function affectedOf(raw: unknown): ObsAffected {
  const value = (raw ?? {}) as Partial<ObsAffected>;
  return {
    modelCallIds: value.modelCallIds ?? [],
    attemptIds: value.attemptIds ?? [],
    outputIds: value.outputIds ?? [],
    actionIds: value.actionIds ?? [],
    taskIds: value.taskIds ?? [],
  };
}

export interface CollectInput {
  db: Queryable;
  missionId: string;
  /** the harness's own clock reading when the mission was started */
  startedAt: string;
  endedAt: string | null;
  /** the expected inference host, to count provider mismatches */
  providerHost: string;
  /** a live trial: fixture-mode calls are counted as violations */
  live: boolean;
  independent: ObsIndependentCheck;
}

export async function collectObservations(
  input: CollectInput,
): Promise<Observations> {
  const { db, missionId } = input;
  const q = async (text: string, values: unknown[] = []) =>
    (await db.query<Row>(text, values)).rows;

  const mission = (
    await q(
      'SELECT status, recovery_scope_rule FROM coordinator.missions WHERE id = $1',
      [missionId],
    )
  )[0];
  const layoutRows = await q(
    `SELECT DISTINCT s.layout FROM ledger.model_call_records m
       JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id
      WHERE m.mission_id = $1 ORDER BY s.layout`,
    [missionId],
  );

  const tasks: ObsTask[] = (
    await q(
      `SELECT t.id, t.parent_id, t.role, t.status, t.prerequisites, t.output_id,
              t.attempt_count, o.usable AS output_usable
         FROM coordinator.tasks t
         LEFT JOIN coordinator.task_outputs o ON o.id = t.output_id
        WHERE t.mission_id = $1 ORDER BY t.ordinal`,
      [missionId],
    )
  ).map((row) => ({
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    role: String(row.role),
    status: String(row.status),
    prerequisites: ((row.prerequisites as string[] | null) ?? []).map(String),
    outputId: row.output_id ? String(row.output_id) : null,
    outputUsable:
      row.output_id === null || row.output_id === undefined
        ? null
        : row.output_usable === true,
    attemptCount: num(row.attempt_count),
  }));

  const attempts: ObsAttempt[] = (
    await q(
      `SELECT id, task_id, kind, status, repair_of, started_at, finished_at
         FROM coordinator.task_attempts WHERE mission_id = $1 ORDER BY started_at, n`,
      [missionId],
    )
  ).map((row) => ({
    id: String(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind),
    status: String(row.status),
    repairOfEventId:
      (row.repair_of as { invalidationEventId?: string } | null)
        ?.invalidationEventId ?? null,
    startedAt: iso(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  }));

  const nodes: ObsNode[] = (
    await q(
      `SELECT kind, id, mission_id, task_id FROM ledger.dependency_nodes
        WHERE mission_id = $1
           OR (kind = 'receipt' AND id IN (
                SELECT from_id FROM ledger.dependency_edges
                 WHERE mission_id = $1 AND from_kind = 'receipt'))`,
      [missionId],
    )
  ).map((row) => ({
    kind: String(row.kind),
    id: String(row.id),
    missionId: row.mission_id ? String(row.mission_id) : null,
    taskId: row.task_id ? String(row.task_id) : null,
  }));

  const edges: ObsEdge[] = (
    await q(
      `SELECT kind, from_kind, from_id, to_kind, to_id, created_at
         FROM ledger.dependency_edges WHERE mission_id = $1 ORDER BY seq`,
      [missionId],
    )
  ).map((row) => ({
    kind: String(row.kind) as ObsEdge['kind'],
    fromKind: String(row.from_kind),
    fromId: String(row.from_id),
    toKind: String(row.to_kind),
    toId: String(row.to_id),
    createdAt: iso(row.created_at),
  }));

  const invalidations: ObsInvalidation[] = (
    await q(
      `SELECT id, source_key, reason, self_write, old_receipt_id, new_receipt_id,
              created_at, per_mission, closure
         FROM ledger.invalidation_events
        WHERE mission_ids ? $1 ORDER BY created_at`,
      [missionId],
    )
  ).map((row) => {
    const entries =
      (row.per_mission as { missionId: string; affected: unknown }[]) ?? [];
    const mine = entries.find((entry) => entry.missionId === missionId);
    return {
      id: String(row.id),
      sourceKey: String(row.source_key),
      reason: String(row.reason),
      selfWrite: String(row.self_write) as ObsInvalidation['selfWrite'],
      oldReceiptId: String(row.old_receipt_id),
      newReceiptId: row.new_receipt_id ? String(row.new_receipt_id) : null,
      createdAt: iso(row.created_at),
      affected: mine ? affectedOf(mine.affected) : emptyAffected(),
      capped: (row.closure as { capped?: boolean } | null)?.capped === true,
    };
  });

  const intents: ObsIntent[] = (
    await q(
      `SELECT id, task_id, attempt_id, action, payload, status, block_reason,
              failure_reason, expected_target_version, idempotency_key, payload_hash,
              proposed_at, admitted_at, committed_at, verified_at
         FROM coordinator.action_intents WHERE mission_id = $1 ORDER BY proposed_at`,
      [missionId],
    )
  ).map((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const flush = row.action === 'flush_cache_namespace';
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      attemptId: String(row.attempt_id),
      action: String(row.action) as ObsIntent['action'],
      target: flush
        ? {
            key: 'cache.namespace',
            value: (payload.namespace as string) ?? null,
          }
        : {
            key: String(payload.key ?? ''),
            value: (payload.value as string | number | boolean) ?? null,
          },
      status: String(row.status),
      blockReason: row.block_reason ? String(row.block_reason) : null,
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      expectedTargetVersion: num(row.expected_target_version),
      idempotencyKey: String(row.idempotency_key),
      payloadHash: String(row.payload_hash),
      proposedAt: iso(row.proposed_at),
      admittedAt: isoOrNull(row.admitted_at),
      committedAt: isoOrNull(row.committed_at),
      verifiedAt: isoOrNull(row.verified_at),
    };
  });

  const authorizations: ObsAuthorization[] = (
    await q(
      `SELECT a.action_id, a.stage, a.decision, a.block_reason, a.decided_at,
              a.checked_vector, a.author_fence, a.dispatch_fence
         FROM coordinator.authorizations a
         JOIN coordinator.action_intents i ON i.id = a.action_id
        WHERE i.mission_id = $1 ORDER BY a.decided_at`,
      [missionId],
    )
  ).map((row) => ({
    actionId: String(row.action_id),
    stage: String(row.stage) as ObsAuthorization['stage'],
    decision: String(row.decision),
    blockReason: row.block_reason ? String(row.block_reason) : null,
    decidedAt: iso(row.decided_at),
    checkedVector: ((row.checked_vector as ObsCheckedEntry[] | null) ?? []).map(
      (entry) => ({
        sourceKey: String(entry.sourceKey),
        recordedRevision: num(entry.recordedRevision),
        liveRevision: num(entry.liveRevision),
        receiptStatus: String(entry.receiptStatus),
        freshnessOk: entry.freshnessOk === true,
      }),
    ),
    authorFenceValid:
      (row.author_fence as { valid?: boolean } | null)?.valid === true,
    dispatchFenceValid:
      row.dispatch_fence === null || row.dispatch_fence === undefined
        ? null
        : (row.dispatch_fence as { valid?: boolean }).valid === true,
  }));

  const results: ObsResult[] = (
    await q(
      `SELECT r.action_id, r.outcome, r.external_effect
         FROM coordinator.result_receipts r
         JOIN coordinator.action_intents i ON i.id = r.action_id
        WHERE i.mission_id = $1`,
      [missionId],
    )
  ).map((row) => ({
    actionId: String(row.action_id),
    outcome: String(row.outcome),
    scriptResult:
      (row.external_effect as { scriptResult?: string } | null)?.scriptResult ??
      null,
  }));

  // the whole history of every key (small); the oracle decides what is in scope
  const configHistory: ObsConfigRow[] = (
    await q(
      `SELECT key, version, value, caused_by_action_id, caused_by_actor, at
         FROM checkout.config_versions ORDER BY at, key, version`,
    )
  ).map((row) => ({
    key: String(row.key),
    version: num(row.version),
    value: (row.value ?? null) as ObsConfigRow['value'],
    causedByActionId: row.caused_by_action_id
      ? String(row.caused_by_action_id)
      : null,
    actor: String(row.caused_by_actor ?? 'unknown'),
    at: iso(row.at),
  }));

  // telemetry: identities, tokens and timings only
  const summary = await telemetrySummary(db as never, missionId);
  const hostRows = await q(
    `SELECT count(*) FILTER (WHERE provider_host <> $2) AS mismatches,
            count(*) FILTER (WHERE provider_mode = 'fixture') AS fixture
       FROM ledger.model_call_records WHERE mission_id = $1`,
    [missionId, input.providerHost],
  );
  const inference = (
    await q(
      `SELECT min(started_at) AS first_started,
              sum(extract(epoch FROM (finished_at - started_at)) * 1000) AS inference_ms
         FROM ledger.inference_attempts
        WHERE mission_id = $1 AND outcome = 'recorded'`,
      [missionId],
    )
  )[0];
  const tools = (
    await q(
      `SELECT sum(extract(epoch FROM (finished_at - started_at)) * 1000) AS tool_ms
         FROM ledger.tool_spans WHERE mission_id = $1 AND finished_at IS NOT NULL`,
      [missionId],
    )
  )[0];
  const marks = splitTiming(await listMissionTiming(db as never, missionId));
  const wall = input.endedAt
    ? Date.parse(input.endedAt) - Date.parse(input.startedAt)
    : null;
  const timing: ObsTiming = {
    setupMs: inference?.first_started
      ? Math.max(
          0,
          Date.parse(iso(inference.first_started)) -
            Date.parse(input.startedAt),
        )
      : null,
    inferenceMs:
      inference?.inference_ms === null || inference?.inference_ms === undefined
        ? null
        : num(inference.inference_ms),
    toolMs:
      tools?.tool_ms === null || tools?.tool_ms === undefined
        ? null
        : num(tools.tool_ms),
    recoveryMs: marks.recoveryMs,
    completionMs: marks.completionMs ?? wall,
  };

  return {
    missionId,
    missionStatus: mission ? String(mission.status) : 'unknown',
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    tasks,
    attempts,
    nodes,
    edges,
    invalidations,
    intents,
    authorizations,
    results,
    configHistory,
    telemetry: {
      calls: summary.calls,
      promptTokens: summary.tokens.prompt,
      completionTokens: summary.tokens.completion,
      cachedTokens: summary.tokens.cached.total,
      retries: summary.retries,
      errors: summary.errors,
      providerMismatches: input.live ? num(hostRows[0]?.mismatches ?? 0) : 0,
      fixtureCalls: input.live ? num(hostRows[0]?.fixture ?? 0) : 0,
    },
    timing,
    independent: input.independent,
    arm: {
      recoveryScopeRule: mission?.recovery_scope_rule
        ? String(mission.recovery_scope_rule)
        : null,
      contextLayouts: layoutRows.map((row) => String(row.layout)),
    },
  };
}
