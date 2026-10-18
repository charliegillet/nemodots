// Reconcile (ARCHITECTURE 5.3): settle an external effect whose outcome was
// not recorded. It READS the effect marker and never re-runs the effect.
//
//   marker = a dispatch fence   -> the effect ran exactly once: verified
//   marker = 'fence_newer'      -> refused by the Redis fence: failed(dispatch_fence_invalid)
//   marker = 'not_applied'      -> a settlement of a stopped mission planted it: the
//                                  flush never ran, failed(effect_not_applied) with
//                                  mission_not_running (settled-absent, never applied)
//   marker absent               -> failed(effect_not_applied) for outcome_unknown / dispatched;
//                                  for `committed` it is left alone (not dispatched yet:
//                                  a dispatcher may still claim it)
// A failed intent is re-dispatchable only through a NEW authorization.
import { isMutated } from '../config/mutation.js';
import type {
  ActionId,
  ActionIntent,
  EventPayload,
  ResultReceipt,
} from '../contracts/index.js';
import { withTransaction } from '../db/tx.js';
import type { ActionsDeps } from './deps.js';
import { lockMissionThenIntent } from './predicates.js';
import { effectKey } from './effect-keys.js';
import { failNotRunning } from './not-running.js';
import { flushEvents } from './emit.js';
import { EffectUnavailableError } from './errors.js';
import { isExternalEffect } from './policy.js';
import {
  plainRead,
  findIntentRow,
  toIntent,
  transition,
  updateResultReceipt,
} from './rows.js';

export type MarkerState = 'applied' | 'fence_newer' | 'not_applied' | 'absent';

export async function readMarker(
  deps: ActionsDeps,
  actionId: string,
): Promise<MarkerState> {
  if (!deps.redis) throw new EffectUnavailableError();
  // MUTATION skip_effect_marker: the marker is never read; every effect looks unapplied.
  if (isMutated('skip_effect_marker')) return 'absent';
  const value = await deps.redis.get(effectKey(deps.redisPrefix, actionId));
  if (value === null) return 'absent';
  if (value === 'fence_newer') return 'fence_newer';
  if (value === 'not_applied') return 'not_applied';
  return 'applied';
}

export async function reconcile(
  deps: ActionsDeps,
  actionId: ActionId | string,
): Promise<ActionIntent> {
  const seen = await plainRead(deps.pool, (client) =>
    findIntentRow(client, actionId),
  );
  if (!seen) throw new Error(`action intent ${actionId} does not exist`);
  const reconcilable = ['committed', 'dispatched', 'outcome_unknown'];
  if (
    !reconcilable.includes(seen.status) ||
    !isExternalEffect(seen.action as 'set_config')
  )
    return toIntent(seen);

  // Redis is read OUTSIDE any transaction.
  const marker = await readMarker(deps, seen.id);

  return withTransaction(deps.pool, async (client) => {
    const { intent: row } = await lockMissionThenIntent(client, seen.id);
    if (!reconcilable.includes(row.status)) return toIntent(row);
    if (row.status === 'committed' && marker === 'absent') return toIntent(row); // not dispatched yet: nothing to settle
    const events: EventPayload[] = [];
    let updated;
    if (marker === 'applied') {
      let from = row.status;
      if (from === 'committed') {
        await transition(client, row.id, 'committed', 'dispatched');
        from = 'dispatched';
      }
      updated = await transition(client, row.id, from, 'verified');
      const postcondition = {
        kind: 'observation' as const,
        receiptId: null,
        configVersion: row.committed_target_version,
      };
      await updateResultReceipt(client, row.id, {
        outcome: 'verified',
        externalEffect: {
          attemptedAt: new Date().toISOString(),
          acknowledgedAt: null,
          scriptResult: null,
          deletedCount: null,
          markerPresent: true,
          fenceBefore: null,
          fenceAfter: null,
        } satisfies NonNullable<ResultReceipt['externalEffect']>,
        postcondition,
      });
      events.push({
        kind: 'action.verified',
        actionId: row.id,
        postcondition,
      } as unknown as EventPayload);
    } else if (marker === 'not_applied') {
      updated = await failNotRunning(
        client,
        { events: deps.events },
        row,
        row.dispatch_fence ?? 0,
        'reconcile found the refusal marker planted when the mission stopped',
        row.status as 'committed' | 'dispatched' | 'outcome_unknown',
      );
    } else {
      const reason =
        marker === 'fence_newer'
          ? 'dispatch_fence_invalid'
          : 'effect_not_applied';
      updated = await transition(client, row.id, row.status, 'failed', {
        failureReason: reason,
      });
      await updateResultReceipt(client, row.id, {
        outcome: 'failed',
        externalEffect: {
          attemptedAt: new Date().toISOString(),
          acknowledgedAt: null,
          scriptResult: marker === 'fence_newer' ? 'fence_newer' : null,
          deletedCount: null,
          markerPresent: marker !== 'absent',
          fenceBefore: null,
          fenceAfter: null,
        },
      });
      events.push({
        kind: 'action.failed',
        actionId: row.id,
        failureReason: reason,
        detail: `reconcile read the effect marker: ${marker}`,
      } as unknown as EventPayload);
    }
    await flushEvents(client, deps, row.mission_id, events);
    return toIntent(updated);
  });
}
