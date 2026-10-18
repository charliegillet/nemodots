// flush_cache_namespace, the only external effect (ARCHITECTURE.md section 5.3,
// findings C3, C11).
//
//   claimDispatch   one transaction: intent FOR UPDATE, mission FOR SHARE, then
//                   a CAS UPDATE on status = 'committed' AND the live
//                   checkout.config_entries['cache.namespace'].version =
//                   committed_target_version. A moved authority, a cancelled
//                   mission or an expired intent fails the intent
//                   (failed(dispatch_fence_invalid | expired)) with an
//                   Authorization(stage 'dispatch', blocked). Success grants a
//                   new dispatch fence and lease and records
//                   Authorization(stage 'dispatch', dispatched).
//   the effect      ONE Lua script, atomic in Redis, outside any PostgreSQL
//                   transaction:
//                     SET <prefix>:effect:<actionId> NX first -> already_applied
//                       (nothing else is touched);
//                     fence <prefix>:fence:cache.namespace strictly newer than
//                       the committed version -> fence_newer;
//                     else SCAN/UNLINK the namespace, SET the fence -> applied.
//                   The marker's final value records what the script did
//                   (applied / fence_newer), so a reader never mistakes a
//                   refused flush for an applied one.
//   record          dispatched -> verified, or failed(dispatch_fence_invalid)
//                   for fence_newer, or outcome_unknown when the call threw or
//                   timed out. Verification reads the marker back with a
//                   separate GET: the delete count alone is never proof.
//
// The Redis fence orders flushes among themselves only. PostgreSQL
// (claimDispatch's CAS and the intent row) remains the authority; Redis is
// never asked whether a change is permitted.
import type {
  ActionIntent,
  FlushCachePayload,
  ResultReceipt,
  ScriptResult,
} from '../contracts/index.js';
import { EventBuffer, createEventSink } from '../coordinator/events.js';
import { enqueueOutbox } from '../coordinator/outbox.js';
import { withTransaction } from '../db/tx.js';
import { lockConfigRows } from '../sandbox/version-authority.js';
import { cacheKeyPrefix } from '../sandbox/checkout-cache.js';
import { decidedEvent, failIntent, lockMissionShared } from './decision.js';
import { ActionNotFoundError, EffectUnavailableError } from './errors.js';
import { parsePayload } from './policy.js';
import {
  claimAuthorizationWriter,
  insertAuthorization,
  insertResultReceipt,
  loadIntent,
  mapIntentRow,
  toIntent,
  type IntentDbRow,
  type IntentRow,
} from './rows.js';
import { barrier, isSimulatedCrash } from './test-hooks.js';
import {
  DEFAULT_MARKER_HORIZON_SECONDS,
  DEFAULT_REDIS_PREFIX,
  DEFAULT_REDIS_TIMEOUT_MS,
  leaseMs,
  type ActionDeps,
  type RedisEffectClient,
} from './types.js';

// --- keys and markers ---------------------------------------------------------------

export const prefixOf = (deps: ActionDeps) =>
  deps.redisPrefix ?? DEFAULT_REDIS_PREFIX;
export const effectKey = (prefix: string, actionId: string) =>
  `${prefix}:effect:${actionId}`;
/** Orders flushes of the cache namespace resource among themselves. */
export const fenceKey = (prefix: string) => `${prefix}:fence:cache.namespace`;
const escapeGlob = (text: string) => text.replace(/[\\*?[\]]/g, '\\$&');

export type MarkerState =
  | { kind: 'applied'; fence: number; deleted: number }
  | { kind: 'fence_newer'; fence: number }
  | { kind: 'tombstone' }
  | { kind: 'pending' }
  | { kind: 'unreadable'; raw: string };

export function parseMarker(raw: string | null): MarkerState | null {
  if (raw === null) return null;
  const parts = raw.split(':');
  if (parts[0] === 'applied' && parts.length === 3) {
    const fence = Number(parts[1]);
    const deleted = Number(parts[2]);
    if (Number.isInteger(fence) && Number.isInteger(deleted))
      return { kind: 'applied', fence, deleted };
  }
  if (parts[0] === 'fence_newer' && parts.length === 2) {
    const fence = Number(parts[1]);
    if (Number.isInteger(fence)) return { kind: 'fence_newer', fence };
  }
  if (parts[0] === 'tombstone') return { kind: 'tombstone' };
  if (parts[0] === 'pending') return { kind: 'pending' };
  return { kind: 'unreadable', raw };
}

/**
 * KEYS[1] effect marker, KEYS[2] fence.
 * ARGV[1] dispatch fence, ARGV[2] committed target version, ARGV[3] MATCH
 * pattern of the namespace, ARGV[4] marker lifetime in seconds.
 * Returns {result, deleted, fenceBefore, fenceAfter, marker}.
 */
export const EFFECT_SCRIPT = `
local ttl = tonumber(ARGV[4])
local created = redis.call('SET', KEYS[1], 'pending:' .. ARGV[1], 'NX', 'EX', ttl)
if not created then
  local prior = redis.call('GET', KEYS[1])
  return {'already_applied', 0, 0, 0, prior or ''}
end
local fenceBefore = tonumber(redis.call('GET', KEYS[2])) or 0
local committed = tonumber(ARGV[2])
if fenceBefore > committed then
  local marker = 'fence_newer:' .. tostring(fenceBefore)
  redis.call('SET', KEYS[1], marker, 'EX', ttl)
  return {'fence_newer', 0, fenceBefore, fenceBefore, marker}
end
local deleted = 0
local cursor = '0'
repeat
  local reply = redis.call('SCAN', cursor, 'MATCH', ARGV[3], 'COUNT', 500)
  cursor = reply[1]
  local keys = reply[2]
  local n = #keys
  local i = 1
  while i <= n do
    local last = math.min(i + 499, n)
    deleted = deleted + redis.call('UNLINK', unpack(keys, i, last))
    i = last + 1
  end
until cursor == '0'
redis.call('SET', KEYS[2], tostring(committed))
local marker = 'applied:' .. ARGV[1] .. ':' .. tostring(deleted)
redis.call('SET', KEYS[1], marker, 'EX', ttl)
return {'applied', deleted, fenceBefore, committed, marker}
`;

export interface ScriptOutcome {
  result: ScriptResult;
  deleted: number;
  fenceBefore: number;
  fenceAfter: number;
  marker: string;
}

export function parseScriptReply(reply: unknown): ScriptOutcome {
  if (!Array.isArray(reply) || reply.length < 5)
    throw new EffectUnavailableError('the effect script returned no result');
  const [result, deleted, fenceBefore, fenceAfter, marker] = reply as unknown[];
  if (
    result !== 'applied' &&
    result !== 'already_applied' &&
    result !== 'fence_newer'
  )
    throw new EffectUnavailableError(
      'the effect script returned an unknown result',
    );
  return {
    result,
    deleted: Number(deleted),
    fenceBefore: Number(fenceBefore),
    fenceAfter: Number(fenceAfter),
    marker: String(marker ?? ''),
  };
}

/** Rejects (and abandons the call) when Redis does not answer within the budget. */
export async function withinBudget<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new EffectUnavailableError(`${label} timed out after ${ms} ms`),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const redisBudget = (deps: ActionDeps) =>
  deps.redisTimeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;

export function requireRedis(deps: ActionDeps): RedisEffectClient {
  if (!deps.redis)
    throw new EffectUnavailableError(
      'no Redis client is configured for flush_cache_namespace',
    );
  return deps.redis;
}

// --- claimDispatch ---------------------------------------------------------------------

export type ClaimOutcome =
  | { claimed: true; row: IntentRow; fence: number }
  | { claimed: false; intent: ActionIntent; why: string };

export async function claimDispatch(
  deps: ActionDeps,
  actionId: string,
  dispatcher: string,
): Promise<ClaimOutcome> {
  const events = deps.events ?? createEventSink();
  return withTransaction(deps.pool, async (client): Promise<ClaimOutcome> => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    await barrier('before_lock', { actionId, stage: 'dispatch' });
    const row = await loadIntent(client, actionId, { lock: true });
    if (!row) throw new ActionNotFoundError(actionId);
    const unchanged = (why: string): ClaimOutcome => ({
      claimed: false,
      intent: toIntent(row),
      why,
    });
    if (row.adapter !== 'redis_cache')
      return unchanged('not an external effect');
    if (row.status !== 'committed') return unchanged(`status is ${row.status}`);

    const mission = await lockMissionShared(client, row.missionId);
    if (!mission) throw new Error(`mission ${row.missionId} does not exist`);

    const refuse = async (
      blockReason: 'dispatch_fence_invalid' | 'expired' | 'generation_mismatch',
      detail: string,
      failure: 'dispatch_fence_invalid' | 'expired',
      live: number,
    ): Promise<ClaimOutcome> => {
      const failed = await failIntent(client, row, failure);
      if (!failed) return unchanged('the intent changed concurrently');
      const authorization = await insertAuthorization(client, {
        actionId: row.id,
        stage: 'dispatch',
        decision: 'blocked',
        blockReason,
        blockDetail: detail,
        checkedVector: [],
        targetVersion: {
          expected: row.committedTargetVersion ?? row.expectedTargetVersion,
          live,
        },
        authorFence: { token: row.authorFencingToken, valid: true },
        dispatchFence:
          row.dispatchFence === null
            ? null
            : { token: row.dispatchFence, valid: false },
        idempotencyBinding: 'new',
      });
      buffer.add(row.missionId, decidedEvent(authorization, detail));
      buffer.add(row.missionId, {
        kind: 'action.failed',
        actionId: row.id,
        failureReason: failure,
        detail,
      });
      await insertResultReceipt(client, {
        intent: row,
        outcome: 'failed',
        externalEffect: null,
      });
      await buffer.flush(client);
      return { claimed: false, intent: toIntent(failed), why: detail };
    };

    // The controlled target: hold the row so the CAS below is stable until commit.
    const locked = await lockConfigRows(client, {
      keys: ['cache.namespace'],
      mode: 'share',
    });
    const live = locked.versions.get('cache.namespace') ?? 0;

    if (mission.generation !== row.generation)
      return refuse(
        'generation_mismatch',
        `mission generation ${mission.generation}, intent generation ${row.generation}`,
        'dispatch_fence_invalid',
        live,
      );
    if (mission.status === 'paused') return unchanged('the mission is paused');
    if (row.expiresAt.getTime() <= (row.dbNow?.getTime() ?? Date.now()))
      return refuse('expired', 'the intent passed its expiry', 'expired', live);

    const claimed = await client.query<IntentDbRow>(
      `UPDATE coordinator.action_intents
          SET dispatch_fence = nextval('coordinator.action_dispatch_seq'),
              dispatch_owner = $2,
              dispatcher_lease_expires_at =
                clock_timestamp() + $3 * interval '1 millisecond',
              status_version = status_version + 1
        WHERE id = $1 AND status = 'committed' AND status_version = $4
          AND (SELECT version FROM checkout.config_entries WHERE key = 'cache.namespace')
              = committed_target_version
        RETURNING *`,
      [row.id, dispatcher, leaseMs(deps), row.statusVersion],
    );
    if (claimed.rows.length !== 1)
      return refuse(
        'dispatch_fence_invalid',
        `cache.namespace is at version ${live}, the flush was committed at ${row.committedTargetVersion}`,
        'dispatch_fence_invalid',
        live,
      );
    const mapped = mapIntentRow(claimed.rows[0]);
    const authorization = await insertAuthorization(client, {
      actionId: row.id,
      stage: 'dispatch',
      decision: 'dispatched',
      blockReason: null,
      checkedVector: [],
      targetVersion: {
        expected: row.committedTargetVersion ?? row.expectedTargetVersion,
        live,
      },
      authorFence: { token: row.authorFencingToken, valid: true },
      dispatchFence: { token: mapped.dispatchFence!, valid: true },
      idempotencyBinding: 'new',
    });
    buffer.add(row.missionId, decidedEvent(authorization, null));
    await buffer.flush(client);
    return { claimed: true, row: mapped, fence: mapped.dispatchFence! };
  });
}

// --- recording ---------------------------------------------------------------------------

interface EffectFacts {
  attemptedAt: Date;
  acknowledgedAt: Date | null;
  scriptResult: ScriptResult | null;
  deletedCount: number | null;
  markerPresent: boolean | null;
  fenceBefore: number | null;
  fenceAfter: number | null;
}

const effectDto = (
  facts: EffectFacts,
): NonNullable<ResultReceipt['externalEffect']> => ({
  attemptedAt: facts.attemptedAt.toISOString(),
  acknowledgedAt: facts.acknowledgedAt?.toISOString() ?? null,
  scriptResult: facts.scriptResult,
  deletedCount: facts.deletedCount,
  markerPresent: facts.markerPresent,
  fenceBefore: facts.fenceBefore,
  fenceAfter: facts.fenceAfter,
});

/** committed -> dispatched under the claimed fence; false when someone else moved the intent. */
async function recordDispatched(
  deps: ActionDeps,
  row: IntentRow,
  fence: number,
  facts: EffectFacts,
): Promise<boolean> {
  const events = deps.events ?? createEventSink();
  return withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    const updated = await client.query(
      `UPDATE coordinator.action_intents
          SET status = 'dispatched', status_version = status_version + 1,
              dispatched_at = clock_timestamp()
        WHERE id = $1 AND status = 'committed' AND dispatch_fence = $2`,
      [row.id, fence],
    );
    if (updated.rowCount !== 1) return false;
    await insertResultReceipt(client, {
      intent: row,
      outcome: 'dispatched',
      externalEffect: effectDto(facts),
    });
    buffer.add(row.missionId, {
      kind: 'action.dispatched',
      actionId: row.id,
      scriptResult: facts.scriptResult,
      deletedCount: facts.deletedCount,
    });
    await buffer.flush(client);
    return true;
  });
}

type SettleFrom = 'committed' | 'dispatched' | 'outcome_unknown';

/** {committed | dispatched | outcome_unknown} -> verified, CAS on the status read. */
export async function recordVerified(
  deps: ActionDeps,
  row: IntentRow,
  from: SettleFrom,
  facts: EffectFacts,
): Promise<IntentRow | null> {
  const events = deps.events ?? createEventSink();
  return withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    const updated = await client.query<IntentDbRow>(
      `UPDATE coordinator.action_intents
          SET status = 'verified', status_version = status_version + 1,
              verified_at = clock_timestamp(),
              dispatched_at = COALESCE(dispatched_at, clock_timestamp())
        WHERE id = $1 AND status = $2
        RETURNING *`,
      [row.id, from],
    );
    if (updated.rows.length !== 1) return null;
    if (from !== 'dispatched') {
      await insertResultReceipt(client, {
        intent: row,
        outcome: 'dispatched',
        externalEffect: effectDto(facts),
      });
      buffer.add(row.missionId, {
        kind: 'action.dispatched',
        actionId: row.id,
        scriptResult: facts.scriptResult,
        deletedCount: facts.deletedCount,
      });
    }
    const postcondition = {
      kind: 'observation' as const,
      receiptId: null,
      configVersion: row.committedTargetVersion,
    };
    await insertResultReceipt(client, {
      intent: row,
      outcome: 'verified',
      externalEffect: effectDto(facts),
      postcondition,
    });
    await enqueueOutbox(client, {
      missionId: row.missionId,
      topic: 'mission.evaluate',
      payload: { missionId: row.missionId },
      dedupeKey: `action:${row.id}:verified`,
    });
    buffer.add(row.missionId, {
      kind: 'action.verified',
      actionId: row.id,
      postcondition,
    });
    await buffer.flush(client);
    return mapIntentRow(updated.rows[0]);
  });
}

export type SettleFailure = 'dispatch_fence_invalid' | 'effect_not_applied';

/** {committed | dispatched | outcome_unknown} -> failed(reason) with a `failed` receipt. */
export async function recordFailed(
  deps: ActionDeps,
  row: IntentRow,
  from: SettleFrom,
  reason: SettleFailure,
  facts: EffectFacts | null,
  detail: string,
  fence: number | null = null,
): Promise<IntentRow | null> {
  const events = deps.events ?? createEventSink();
  return withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    const updated = await client.query<IntentDbRow>(
      `UPDATE coordinator.action_intents
          SET status = 'failed', status_version = status_version + 1,
              failure_reason = $3, failed_at = clock_timestamp()
        WHERE id = $1 AND status = $2 AND ($4::bigint IS NULL OR dispatch_fence = $4)
        RETURNING *`,
      [row.id, from, reason, fence],
    );
    if (updated.rows.length !== 1) return null;
    await insertResultReceipt(client, {
      intent: row,
      outcome: 'failed',
      externalEffect: facts ? effectDto(facts) : null,
    });
    await enqueueOutbox(client, {
      missionId: row.missionId,
      topic: 'mission.evaluate',
      payload: { missionId: row.missionId },
      dedupeKey: `action:${row.id}:failed`,
    });
    buffer.add(row.missionId, {
      kind: 'action.failed',
      actionId: row.id,
      failureReason: reason,
      detail,
    });
    await buffer.flush(client);
    return mapIntentRow(updated.rows[0]);
  });
}

/** {committed | dispatched} -> outcome_unknown: the effect may or may not have happened. */
export async function recordUnknown(
  deps: ActionDeps,
  row: IntentRow,
  from: 'committed' | 'dispatched',
  facts: EffectFacts,
  detail: string,
  fence: number | null = null,
): Promise<IntentRow | null> {
  const events = deps.events ?? createEventSink();
  return withTransaction(deps.pool, async (client) => {
    const buffer = new EventBuffer(events);
    await claimAuthorizationWriter(client);
    const updated = await client.query<IntentDbRow>(
      `UPDATE coordinator.action_intents
          SET status = 'outcome_unknown', status_version = status_version + 1
        WHERE id = $1 AND status = $2 AND ($3::bigint IS NULL OR dispatch_fence = $3)
        RETURNING *`,
      [row.id, from, fence],
    );
    if (updated.rows.length !== 1) return null;
    await insertResultReceipt(client, {
      intent: row,
      outcome: 'outcome_unknown',
      externalEffect: effectDto(facts),
    });
    buffer.add(row.missionId, {
      kind: 'action.outcome_unknown',
      actionId: row.id,
      detail,
    });
    await buffer.flush(client);
    return mapIntentRow(updated.rows[0]);
  });
}

// --- the dispatch ----------------------------------------------------------------------------

export type DispatchDisposition =
  /** the effect is applied and read back */
  | 'verified'
  /** fence_newer or a refused claim: the intent failed */
  | 'failed'
  | 'outcome_unknown'
  /** nothing to dispatch (not a committed flush) */
  | 'unchanged';

export interface DispatchResult {
  intent: ActionIntent;
  scriptResult: ScriptResult | null;
  deletedCount: number | null;
  disposition: DispatchDisposition;
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function reload(
  deps: ActionDeps,
  actionId: string,
): Promise<ActionIntent> {
  const row = await loadIntent(deps.pool, actionId);
  if (!row) throw new ActionNotFoundError(actionId);
  return toIntent(row);
}

export async function dispatchIntentDetailed(
  deps: ActionDeps,
  actionId: string,
  dispatcher: string,
): Promise<DispatchResult> {
  const prelim = await loadIntent(deps.pool, actionId);
  if (!prelim) throw new ActionNotFoundError(actionId);
  if (prelim.adapter !== 'redis_cache' || prelim.status !== 'committed')
    return {
      intent: toIntent(prelim),
      scriptResult: null,
      deletedCount: null,
      disposition: 'unchanged',
    };
  const redis = requireRedis(deps);
  await barrier('after_preliminary_read', { actionId, stage: 'dispatch' });

  const claim = await claimDispatch(deps, actionId, dispatcher);
  if (!claim.claimed)
    return {
      intent: claim.intent,
      scriptResult: null,
      deletedCount: null,
      disposition: claim.intent.status === 'failed' ? 'failed' : 'unchanged',
    };
  const { row, fence } = claim;
  const payload = parsePayload(row.action, row.payload)!
    .payload as FlushCachePayload;
  const prefix = prefixOf(deps);
  const committedVersion =
    row.committedTargetVersion ?? row.expectedTargetVersion;

  // The effect: Redis only, no PostgreSQL transaction is open.
  const attemptedAt = new Date();
  let outcome: ScriptOutcome;
  try {
    outcome = parseScriptReply(
      await withinBudget(
        redis.eval(EFFECT_SCRIPT, {
          keys: [effectKey(prefix, row.id), fenceKey(prefix)],
          arguments: [
            String(fence),
            String(committedVersion),
            `${escapeGlob(cacheKeyPrefix(prefix, payload.namespace))}*`,
            String(deps.markerHorizonSeconds ?? DEFAULT_MARKER_HORIZON_SECONDS),
          ],
        }),
        redisBudget(deps),
        'the effect script',
      ),
    );
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    // The call threw or timed out: the script is atomic, so it either ran
    // completely or not at all, and the answer was lost. Never guess.
    const updated = await recordUnknown(
      deps,
      row,
      'committed',
      {
        attemptedAt,
        acknowledgedAt: null,
        scriptResult: null,
        deletedCount: null,
        markerPresent: null,
        fenceBefore: null,
        fenceAfter: null,
      },
      `the effect call failed: ${errorText(error)}`,
      fence,
    );
    return {
      intent: updated ? toIntent(updated) : await reload(deps, actionId),
      scriptResult: null,
      deletedCount: null,
      disposition: 'outcome_unknown',
    };
  }
  const acknowledgedAt = new Date();
  await barrier('after_effect_before_record', { actionId, stage: 'dispatch' });

  const prior =
    outcome.result === 'already_applied' ? parseMarker(outcome.marker) : null;
  const effective: 'applied' | 'fence_newer' | 'not_applied' | 'unknown' =
    outcome.result === 'applied'
      ? 'applied'
      : outcome.result === 'fence_newer'
        ? 'fence_newer'
        : prior?.kind === 'applied'
          ? 'applied'
          : prior?.kind === 'fence_newer'
            ? 'fence_newer'
            : prior?.kind === 'tombstone'
              ? 'not_applied'
              : 'unknown';
  const facts: EffectFacts = {
    attemptedAt,
    acknowledgedAt,
    scriptResult: effective === 'fence_newer' ? 'fence_newer' : outcome.result,
    deletedCount: outcome.result === 'already_applied' ? 0 : outcome.deleted,
    markerPresent: true,
    fenceBefore: outcome.fenceBefore,
    fenceAfter: outcome.fenceAfter,
  };
  const done = async (
    updated: IntentRow | null,
    disposition: DispatchDisposition,
  ): Promise<DispatchResult> => ({
    intent: updated ? toIntent(updated) : await reload(deps, actionId),
    scriptResult: facts.scriptResult,
    deletedCount: facts.deletedCount,
    disposition: updated ? disposition : 'unchanged',
  });

  if (effective === 'fence_newer')
    return done(
      await recordFailed(
        deps,
        row,
        'committed',
        'dispatch_fence_invalid',
        facts,
        'a newer flush of the cache namespace was already applied; nothing was deleted',
        fence,
      ),
      'failed',
    );
  if (effective === 'not_applied')
    return done(
      await recordFailed(
        deps,
        row,
        'committed',
        'effect_not_applied',
        facts,
        'reconcile fenced this action as not applied; nothing was deleted',
        fence,
      ),
      'failed',
    );
  if (effective === 'unknown')
    return done(
      await recordUnknown(
        deps,
        row,
        'committed',
        facts,
        'the effect marker holds an unreadable value',
        fence,
      ),
      'outcome_unknown',
    );

  // applied (this call, or an earlier one whose record was lost).
  if (!(await recordDispatched(deps, row, fence, facts)))
    return done(null, 'unchanged');
  let readback: MarkerState | null = null;
  try {
    readback = parseMarker(
      await withinBudget(
        redis.get(effectKey(prefix, row.id)),
        redisBudget(deps),
        'the marker read-back',
      ),
    );
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
  }
  const dispatchedRow = {
    ...row,
    committedTargetVersion: row.committedTargetVersion,
  };
  if (readback?.kind === 'applied')
    return done(
      await recordVerified(deps, dispatchedRow, 'dispatched', facts),
      'verified',
    );
  return done(
    await recordUnknown(
      deps,
      row,
      'dispatched',
      { ...facts, markerPresent: readback !== null },
      'the effect marker could not be read back',
    ),
    'outcome_unknown',
  );
}

export async function dispatchIntent(
  deps: ActionDeps,
  actionId: string,
  dispatcher: string,
): Promise<ActionIntent> {
  return (await dispatchIntentDetailed(deps, actionId, dispatcher)).intent;
}

export type { EffectFacts };
