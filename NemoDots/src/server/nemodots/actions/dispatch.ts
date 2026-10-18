// Dispatch of the Redis effect (ARCHITECTURE 5.3, findings C3, C11).
//
// Three separate steps; no PostgreSQL transaction is ever open across the
// Redis call:
//   1. claimDispatch (tx): committed + cache.namespace version still equal to
//      committed_target_version (else failed(dispatch_fence_invalid), C11);
//      issues a NEW dispatch fence and lease, Authorization(dispatch).
//   2. the Lua script, atomic in Redis (C3): SET effect:<actionId> NX first
//      (already_applied if it existed), then the namespace fence compared with
//      the committed version (strictly newer -> fence_newer, no effect), else
//      SCAN/UNLINK the namespace and SET fence.
//   3. record (tx, fenced): committed -> dispatched -> verified, receipt,
//      events. A throw/timeout in step 2 records outcome_unknown instead.
// The fence in Redis orders flushes only; it is not an authority.
import { isMutated } from '../config/mutation.js';
import type {
  ActionId,
  ActionIntent,
  EventPayload,
  FlushCachePayload,
  ResultReceipt,
  ScriptResult,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import { cacheKeyPrefix } from '../sandbox/checkout-cache.js';
import type { ActionsDeps } from './deps.js';
import { decidedEvent, flushEvents } from './emit.js';
import { DispatchFenceError, EffectUnavailableError } from './errors.js';
import { isExternalEffect } from './policy.js';
import { lockMissionThenIntent } from './predicates.js';
import type { PgClient } from '../contracts/index.js';
import {
  findResultReceipt,
  insertAuthorization,
  toIntent,
  transition,
  updateResultReceipt,
  type AuthorizationInput,
  type IntentRow,
} from './rows.js';
import { effectKey, fenceKey } from './effect-keys.js';
import { failNotRunning } from './not-running.js';
import { reconcile } from './reconcile.js';
import { hook } from './test-hooks.js';

const CACHE_NAMESPACE_KEY = 'cache.namespace';
export const DEFAULT_EFFECT_HORIZON_SEC = 7 * 24 * 3600;

export { effectKey, fenceKey, failNotRunning };

/**
 * KEYS[1] effect marker, KEYS[2] namespace fence
 * ARGV[1] dispatch fence, ARGV[2] committed version, ARGV[3] marker TTL (s),
 * ARGV[4] SCAN pattern. Returns {result, deletedCount, fenceBefore}.
 * The marker holds the dispatch fence once the effect ran, 'fence_newer'
 * when the namespace fence refused it, or 'not_applied' when a settlement of a
 * stopped mission planted it first (the script then answers
 * 'refused_not_applied', never 'already_applied'), so reconcile can tell the two apart.
 */
export const FLUSH_SCRIPT = `
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[3]))
local before = tonumber(redis.call('GET', KEYS[2]) or '0')
if not created then
  local existing = redis.call('GET', KEYS[1])
  if existing == 'fence_newer' then
    return {'fence_newer', 0, before}
  end
  if existing == 'not_applied' then
    return {'refused_not_applied', 0, before}
  end
  return {'already_applied', 0, before}
end
if before > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[1], 'fence_newer', 'XX', 'EX', tonumber(ARGV[3]))
  return {'fence_newer', 0, before}
end
local cursor = '0'
local deleted = 0
repeat
  local reply = redis.call('SCAN', cursor, 'MATCH', ARGV[4], 'COUNT', 500)
  cursor = reply[1]
  local keys = reply[2]
  if #keys > 0 then
    redis.call('UNLINK', unpack(keys))
    deleted = deleted + #keys
  end
until cursor == '0'
redis.call('SET', KEYS[2], ARGV[2])
return {'applied', deleted, before}
`;

/**
 * MUTATION skip_effect_marker: the same flush without the per-action marker
 * (no SET NX), so a second dispatch flushes again instead of answering
 * already_applied.
 */
export const FLUSH_SCRIPT_UNMARKED = `
local before = tonumber(redis.call('GET', KEYS[2]) or '0')
if before > tonumber(ARGV[2]) then
  return {'fence_newer', 0, before}
end
local cursor = '0'
local deleted = 0
repeat
  local reply = redis.call('SCAN', cursor, 'MATCH', ARGV[4], 'COUNT', 500)
  cursor = reply[1]
  local keys = reply[2]
  if #keys > 0 then
    redis.call('UNLINK', unpack(keys))
    deleted = deleted + #keys
  end
until cursor == '0'
redis.call('SET', KEYS[2], ARGV[2])
return {'applied', deleted, before}
`;

export interface ClaimResult {
  intent: ActionIntent;
  /** The fence to use for the effect; null when nothing may be dispatched. */
  fence: number | null;
  /** cache.namespace version the flush was committed at (the Redis fence value). */
  committedVersion: number | null;
  /**
   * 'mission_paused': nothing was dispatched and nothing was written. The
   * intent stays `committed` (desired state recorded, effect not done) and is
   * dispatched after resume.
   */
  deferred?: 'mission_paused' | 'needs_reconcile' | null;
}

/** Mission states in which a committed flush may never be dispatched. */
const TERMINAL_MISSION = new Set(['cancelled', 'failed', 'succeeded']);

/** Step 1. Never touches Redis. */
export async function claimDispatch(
  deps: ActionsDeps,
  actionId: ActionId | string,
  callerFence: number,
  dispatcher = 'dispatcher',
): Promise<ClaimResult> {
  return withTransaction(deps.pool, async (client) => {
    const { intent, mission } = await lockMissionThenIntent(client, actionId);
    if (intent.status !== 'committed')
      return { intent: toIntent(intent), fence: null, committedVersion: null };
    if (!isExternalEffect(intent.action as 'set_config'))
      return { intent: toIntent(intent), fence: null, committedVersion: null };
    const held = await client.query<{ expired: boolean }>(
      'SELECT $1::timestamptz <= clock_timestamp() AS expired',
      [intent.dispatcher_lease_expires_at],
    );
    // MUTATION ignore_fencing: another dispatcher's live lease is taken over.
    if (
      !isMutated('ignore_fencing') &&
      !held.rows[0].expired &&
      intent.dispatch_fence !== callerFence
    )
      throw new DispatchFenceError(
        intent.id,
        'lease_held',
        'another dispatcher holds an unexpired lease',
      );

    // The mission was share-locked first (mission -> intent), so a pause or a
    // cancel that committed earlier is seen here, and one that has not will
    // wait for this transaction.
    if (mission.status === 'paused')
      return {
        intent: toIntent(intent),
        fence: null,
        committedVersion: null,
        deferred: 'mission_paused',
      };
    if (
      TERMINAL_MISSION.has(mission.status) ||
      mission.generation !== intent.generation
    ) {
      // A flush that was already claimed once may have run its effect (the
      // marker is in Redis, not here): never record an outcome without reading
      // the marker. Only a flush with no dispatch-stage Authorization at all
      // is settled as not run; a claimed one goes to reconcile.
      const claimedBefore = await client.query(
        `SELECT 1 FROM coordinator.authorizations
          WHERE action_id = $1 AND stage = 'dispatch' LIMIT 1`,
        [intent.id],
      );
      if (claimedBefore.rows.length > 0)
        return {
          intent: toIntent(intent),
          fence: null,
          committedVersion: null,
          deferred: 'needs_reconcile',
        };
      const failed = await failNotRunning(
        client,
        deps,
        intent,
        callerFence,
        `the mission is ${mission.status}`,
      );
      return { intent: toIntent(failed), fence: null, committedVersion: null };
    }

    const live = await client.query<{ version: number }>(
      'SELECT version FROM checkout.config_entries WHERE key = $1 FOR SHARE',
      [CACHE_NAMESPACE_KEY],
    );
    const liveVersion = live.rows[0] ? Number(live.rows[0].version) : 0;
    const base = {
      actionId: intent.id,
      stage: 'dispatch' as const,
      checkedVector: [],
      targetVersion: {
        expected:
          intent.committed_target_version ?? intent.expected_target_version,
        live: liveVersion,
      },
      authorFence: { token: intent.author_fencing_token, valid: true },
      idempotencyBinding: 'same_payload' as const,
    };
    const staleVersion = liveVersion !== intent.committed_target_version;
    if (staleVersion) {
      const detail = `cache.namespace is at version ${liveVersion}, the flush was committed at ${intent.committed_target_version}`;
      const authorization: AuthorizationInput = {
        ...base,
        decision: 'blocked',
        blockReason: 'dispatch_fence_invalid',
        dispatchFence: { token: callerFence, valid: false },
      };
      await insertAuthorization(client, authorization);
      const failed = await transition(
        client,
        intent.id,
        'committed',
        'failed',
        {
          failureReason: 'dispatch_fence_invalid',
        },
      );
      await updateResultReceipt(client, intent.id, { outcome: 'failed' });
      await flushEvents(client, deps, intent.mission_id, [
        decidedEvent(authorization, detail),
        {
          kind: 'action.failed',
          actionId: intent.id,
          failureReason: 'dispatch_fence_invalid',
          detail,
        } as unknown as EventPayload,
      ]);
      return { intent: toIntent(failed), fence: null, committedVersion: null };
    }

    const next = await client.query<{ fence: number }>(
      "SELECT nextval('coordinator.action_dispatch_seq')::int AS fence",
    );
    const fence = next.rows[0].fence;
    const claimed = await client.query<IntentRow>(
      `UPDATE coordinator.action_intents
          SET dispatch_fence = $2, dispatch_owner = $3,
              dispatcher_lease_expires_at = clock_timestamp() + ($4::int * interval '1 millisecond'),
              status_version = status_version + 1
        WHERE id = $1 AND status = 'committed' RETURNING *`,
      [intent.id, fence, dispatcher, deps.dispatchLeaseMs],
    );
    const authorization: AuthorizationInput = {
      ...base,
      decision: 'dispatched',
      blockReason: null,
      dispatchFence: { token: fence, valid: true },
    };
    await insertAuthorization(client, authorization);
    await flushEvents(client, deps, intent.mission_id, [
      decidedEvent(authorization, null),
    ]);
    return {
      intent: toIntent(claimed.rows[0]),
      fence,
      committedVersion: Number(intent.committed_target_version),
    };
  });
}

interface EffectOutcome {
  scriptResult: ScriptResult | 'refused_not_applied';
  deletedCount: number;
  fenceBefore: number;
  attemptedAt: string;
  acknowledgedAt: string;
}

async function runEffect(
  deps: ActionsDeps,
  intent: ActionIntent,
  fence: number,
  committedVersion: number,
): Promise<EffectOutcome> {
  if (!deps.redis) throw new EffectUnavailableError();
  const payload = intent.payload as FlushCachePayload;
  const attemptedAt = new Date().toISOString();
  const reply = (await deps.redis.eval(
    isMutated('skip_effect_marker') ? FLUSH_SCRIPT_UNMARKED : FLUSH_SCRIPT,
    {
      keys: [
        effectKey(deps.redisPrefix, intent.id),
        fenceKey(deps.redisPrefix),
      ],
      arguments: [
        String(fence),
        String(committedVersion),
        String(deps.effectHorizonSec ?? DEFAULT_EFFECT_HORIZON_SEC),
        `${cacheKeyPrefix(deps.redisPrefix, payload.namespace)}*`,
      ],
    },
  )) as [string, number, number];
  const acknowledgedAt = new Date().toISOString();
  return {
    scriptResult: reply[0] as ScriptResult | 'refused_not_applied',
    deletedCount: Number(reply[1]),
    fenceBefore: Number(reply[2]),
    attemptedAt,
    acknowledgedAt,
  };
}

/** Step 3: the fenced record of what the effect did. */
async function recordOutcome(
  deps: ActionsDeps,
  intent: ActionIntent,
  fence: number,
  outcome: EffectOutcome | { error: string; attemptedAt: string },
): Promise<ActionIntent> {
  return withTransaction(deps.pool, async (client) => {
    const { intent: row } = await lockMissionThenIntent(client, intent.id);
    if (row.status !== 'committed') return toIntent(row); // someone (reconcile, a second dispatcher) already settled it
    const lease = await client.query<{ valid: boolean }>(
      'SELECT dispatcher_lease_expires_at > clock_timestamp() AS valid FROM coordinator.action_intents WHERE id = $1',
      [intent.id],
    );
    if (
      !isMutated('ignore_fencing') &&
      (row.dispatch_fence !== fence || !lease.rows[0].valid)
    )
      throw new DispatchFenceError(
        intent.id,
        'lease_expired',
        'the effect may have run; reconcile or re-claim settles it',
      );
    const events: EventPayload[] = [];
    let updated: IntentRow;
    if ('error' in outcome) {
      updated = await transition(
        client,
        intent.id,
        'committed',
        'outcome_unknown',
        {
          dispatchFence: fence,
        },
      );
      await updateResultReceipt(client, intent.id, {
        outcome: 'outcome_unknown',
        externalEffect: {
          attemptedAt: outcome.attemptedAt,
          acknowledgedAt: null,
          scriptResult: null,
          deletedCount: null,
          markerPresent: null,
          fenceBefore: null,
          fenceAfter: null,
        },
      });
      events.push({
        kind: 'action.outcome_unknown',
        actionId: intent.id,
        detail: outcome.error,
      } as unknown as EventPayload);
    } else {
      // 'refused_not_applied' is not in the contract's ScriptResult enum: the
      // receipt records no script result, only that a marker was present.
      const refusedNotApplied = outcome.scriptResult === 'refused_not_applied';
      const effect: NonNullable<ResultReceipt['externalEffect']> = {
        attemptedAt: outcome.attemptedAt,
        acknowledgedAt: outcome.acknowledgedAt,
        scriptResult:
          outcome.scriptResult === 'refused_not_applied'
            ? null
            : outcome.scriptResult,
        deletedCount: outcome.deletedCount,
        markerPresent: outcome.scriptResult !== 'fence_newer',
        fenceBefore: outcome.fenceBefore,
        fenceAfter:
          outcome.scriptResult === 'applied'
            ? (row.committed_target_version ?? null)
            : outcome.fenceBefore,
      };
      if (refusedNotApplied) {
        // A settlement of a stopped mission planted the refusal first: the
        // flush did not run and will not. The record says so, never verified.
        updated = await failNotRunning(
          client,
          deps,
          row,
          fence,
          'the effect was refused: a settlement of the stopped mission got there first',
        );
      } else if (outcome.scriptResult === 'fence_newer') {
        updated = await transition(client, intent.id, 'committed', 'failed', {
          failureReason: 'dispatch_fence_invalid',
          dispatchFence: fence,
        });
        await updateResultReceipt(client, intent.id, {
          outcome: 'failed',
          externalEffect: effect,
        });
        events.push({
          kind: 'action.failed',
          actionId: intent.id,
          failureReason: 'dispatch_fence_invalid',
          detail: 'the Redis namespace fence is strictly newer',
        } as unknown as EventPayload);
      } else {
        await transition(client, intent.id, 'committed', 'dispatched', {
          dispatchFence: fence,
        });
        updated = await transition(
          client,
          intent.id,
          'dispatched',
          'verified',
          {
            dispatchFence: fence,
          },
        );
        const postcondition = {
          kind: 'observation' as const,
          receiptId: null,
          configVersion: row.committed_target_version,
        };
        await updateResultReceipt(client, intent.id, {
          outcome: 'verified',
          externalEffect: effect,
          postcondition,
        });
        events.push(
          {
            kind: 'action.dispatched',
            actionId: intent.id,
            scriptResult: outcome.scriptResult,
            deletedCount: outcome.deletedCount,
          } as unknown as EventPayload,
          {
            kind: 'action.verified',
            actionId: intent.id,
            postcondition,
          } as unknown as EventPayload,
        );
      }
    }
    await flushEvents(client, deps, row.mission_id, events);
    return toIntent(updated);
  });
}

/**
 * After the claim and before the effect: if the mission was paused, release the
 * lease and defer (the intent stays committed); if it was cancelled, settle
 * the intent as not run. Returns the settled intent, or null to go ahead.
 */
async function recheckMission(
  deps: ActionsDeps,
  intent: ActionIntent,
  fence: number,
): Promise<ActionIntent | null> {
  return withTransaction(deps.pool, async (client) => {
    const { intent: row, mission } = await lockMissionThenIntent(
      client,
      intent.id,
    );
    // Anything but "still committed under MY fence" means stop: someone else
    // settled it or took the lease over (no effect under an obsolete fence).
    if (
      row.status !== 'committed' ||
      (row.dispatch_fence !== fence && !isMutated('ignore_fencing'))
    )
      return toIntent(row);
    if (mission.status === 'paused') {
      const released = await client.query<IntentRow>(
        `UPDATE coordinator.action_intents
            SET dispatcher_lease_expires_at = clock_timestamp()
          WHERE id = $1 AND status = 'committed' AND dispatch_fence = $2
          RETURNING *`,
        [row.id, fence],
      );
      return toIntent(released.rows[0]);
    }
    if (
      TERMINAL_MISSION.has(mission.status) ||
      mission.generation !== row.generation
    ) {
      const failed = await failNotRunning(
        client,
        deps,
        row,
        fence,
        `the mission is ${mission.status}`,
      );
      return toIntent(failed);
    }
    return null;
  });
}

/**
 * Committed, undispatched flushes of running missions: the work a resume
 * leaves behind. A dispatch worker calls dispatch() for each.
 */
export async function findDispatchable(
  client: PgClient,
  limit = 50,
): Promise<{ id: ActionId; fence: number | null }[]> {
  const { rows } = await client.query<{
    id: string;
    dispatch_fence: number | null;
  }>(
    `SELECT i.id, i.dispatch_fence
       FROM coordinator.action_intents i
       JOIN coordinator.missions m ON m.id = i.mission_id
      WHERE i.status = 'committed' AND i.action = 'flush_cache_namespace'
        AND m.status IN ('running', 'awaiting_acceptance')
        AND (i.dispatcher_lease_expires_at IS NULL
             OR i.dispatcher_lease_expires_at <= clock_timestamp()
             OR NOT EXISTS (SELECT 1 FROM coordinator.authorizations a
                             WHERE a.action_id = i.id AND a.stage = 'dispatch'))
      ORDER BY i.committed_at, i.id LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id as ActionId,
    fence: row.dispatch_fence,
  }));
}

/**
 * A flush that was claimed before its mission stopped: read the effect marker
 * (reconcile). Present -> verified, fence_newer -> failed(dispatch_fence_invalid).
 * Absent -> the effect did not run and, the mission being stopped, will not:
 * settled as not run with mission_not_running.
 */
async function settleClaimedOfStoppedMission(
  deps: ActionsDeps,
  intent: ActionIntent,
): Promise<ActionIntent> {
  const reconciled = await reconcile(deps, intent.id);
  if (reconciled.status !== 'committed') return reconciled;
  // The marker was absent when read. A dispatcher that already passed its last
  // pre-effect read can still run the script (its lease is no obstacle to
  // Redis), so before recording "not run" plant a refusal tombstone with
  // SET NX: the script then sees an existing marker and does nothing. If the
  // tombstone cannot be planted the effect won the race: reconcile again, and
  // the marker decides (adversarial finding C-09).
  if (!(await plantRefusal(deps, intent.id))) return reconcile(deps, intent.id);
  return withTransaction(deps.pool, async (client) => {
    const { intent: row, mission } = await lockMissionThenIntent(
      client,
      intent.id,
    );
    if (row.status !== 'committed') return toIntent(row);
    if (
      !TERMINAL_MISSION.has(mission.status) &&
      mission.generation === row.generation
    )
      return toIntent(row);
    return toIntent(
      await failNotRunning(
        client,
        deps,
        row,
        row.dispatch_fence ?? 0,
        `the mission is ${mission.status}; the effect marker is absent`,
      ),
    );
  });
}

const PLANT_REFUSAL_SCRIPT = `
return redis.call('SET', KEYS[1], 'not_applied', 'NX', 'EX', tonumber(ARGV[1]))
`;

/** SET NX of the 'refused' marker value; false when a marker already exists. */
async function plantRefusal(
  deps: ActionsDeps,
  actionId: string,
): Promise<boolean> {
  if (!deps.redis) throw new EffectUnavailableError();
  const reply = await deps.redis.eval(PLANT_REFUSAL_SCRIPT, {
    keys: [effectKey(deps.redisPrefix, actionId)],
    arguments: [String(deps.effectHorizonSec ?? DEFAULT_EFFECT_HORIZON_SEC)],
  });
  return reply !== null && reply !== false;
}

/** Port: ActionAdmissionPort.dispatch. */
export async function dispatch(
  deps: ActionsDeps,
  actionId: ActionId | string,
  dispatchFence: number,
  dispatcher = 'dispatcher',
): Promise<ActionIntent> {
  const claim = await claimDispatch(deps, actionId, dispatchFence, dispatcher);
  if (claim.deferred === 'needs_reconcile')
    return settleClaimedOfStoppedMission(deps, claim.intent);
  if (claim.fence === null) return claim.intent;
  await hook('after_claim_before_effect', { actionId });
  // Last look before the (non-transactional) Redis call. A pause or cancel
  // that committed after the claim is honoured; one that commits in the
  // remaining microseconds is the stated freshness-at-dispatch window.
  const stopped = await recheckMission(deps, claim.intent, claim.fence);
  if (stopped) return stopped;
  let outcome: Awaited<ReturnType<typeof runEffect>> | undefined;
  let failure: { error: string; attemptedAt: string } | undefined;
  const attemptedAt = new Date().toISOString();
  try {
    outcome = await runEffect(
      deps,
      claim.intent,
      claim.fence,
      claim.committedVersion as number,
    );
  } catch (error) {
    failure = { error: (error as Error).message, attemptedAt };
  }
  await hook('after_effect_before_record', { actionId });
  return recordOutcome(deps, claim.intent, claim.fence, (outcome ?? failure)!);
}

export { findResultReceipt };
