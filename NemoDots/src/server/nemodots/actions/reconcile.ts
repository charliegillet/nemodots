// Reconcile (ARCHITECTURE.md section 5.3 step 3, finding C3): decide what a
// flush_cache_namespace intent whose outcome is not recorded really did, by
// reading the effect marker. It NEVER re-runs the effect.
//
//   committed, no marker      the effect has not run: awaiting dispatch
//   marker `applied:...`      the effect happened exactly once: verified
//   marker `fence_newer:...`  a newer flush won; nothing was deleted:
//                             failed(dispatch_fence_invalid)
//   marker `tombstone:...`    reconcile itself fenced the action: failed(effect_not_applied)
//   no marker, an effect attempt recorded (dispatched | outcome_unknown, or a
//   committed flush whose dispatcher lease lapsed), decided in this order:
//     1. a stored result receipt says the script answered `applied`: the effect
//        happened whatever Redis remembers; settle verified (markerPresent
//        false in the receipt). Durable evidence is never overridden by the
//        absence of a volatile marker.
//     2. otherwise absence is proof only while the Redis epoch recorded with
//        the claim is unchanged (the script is atomic: no marker means it never
//        ran). Reconcile then writes a tombstone with SET NX, in the same Lua
//        call that checks the epoch, so a late arriving script call sees the
//        marker and does nothing, and only then fails the intent
//        (failed(effect_not_applied)); re-dispatch needs a new authorization.
//     3. the epoch changed (Redis restarted, lost its state): absence proves
//        nothing. The intent stays outcome_unknown (finding epoch_changed) for
//        an operator; nothing is concluded and nothing is run again.
//   anything older than the marker horizon is never concluded (the marker may
//   have expired): the intent stays outcome_unknown.
// The count of deleted keys in any readback is never treated as proof.
// set_config has no external effect: committed means applied, and verification
// arrives from the watcher's history walk (settle.ts).
import type { ActionIntent } from '../contracts/index.js';
import { ActionNotFoundError } from './errors.js';
import {
  TOMBSTONE_SCRIPT,
  effectKey,
  epochKey,
  parseMarker,
  prefixOf,
  recordFailed,
  recordVerified,
  redisBudget,
  requireRedis,
  withinBudget,
  type EffectFacts,
} from './dispatch.js';
import { loadIntent, toIntent, type IntentRow } from './rows.js';
import { barrier, isSimulatedCrash } from './test-hooks.js';
import { DEFAULT_MARKER_HORIZON_SECONDS, type ActionDeps } from './types.js';

export type ReconcileFinding =
  /** proposed | admitted: no commit happened */
  | 'uncommitted'
  /** set_config committed; the watcher verifies it from the history */
  | 'committed'
  /** flush committed, the effect has not run */
  | 'awaiting_dispatch'
  | 'effect_applied'
  | 'effect_not_applied'
  | 'fence_newer'
  /** already verified / failed / blocked / cancelled */
  | 'terminal'
  /** cannot conclude (Redis unreachable, marker expired or unreadable) */
  | 'unknown'
  /** Redis lost its state since the attempt: absence of the marker proves nothing */
  | 'epoch_changed';

export interface ReconcileResult {
  intent: ActionIntent;
  finding: ReconcileFinding;
}

const factsFor = (
  row: IntentRow,
  marker: { deleted: number | null } | null,
): EffectFacts => ({
  attemptedAt: row.dispatchedAt ?? row.committedAt ?? new Date(),
  acknowledgedAt: null,
  scriptResult: marker ? 'applied' : null,
  deletedCount: marker?.deleted ?? null,
  markerPresent: marker !== null,
  fenceBefore: null,
  fenceAfter: row.committedTargetVersion,
});

/**
 * Durable proof that the script answered `applied` for this action: the
 * `dispatched` receipt (written only when the effect was effective) or an
 * `outcome_unknown` receipt that kept the script's own answer.
 */
async function appliedEvidence(
  deps: ActionDeps,
  actionId: string,
): Promise<{ deleted: number | null } | null> {
  const { rows } = await deps.pool.query<{
    external_effect: { deletedCount?: number | null } | null;
  }>(
    `SELECT external_effect FROM coordinator.result_receipts
      WHERE action_id = $1
        AND ((outcome = 'dispatched'
              AND external_effect->>'scriptResult' IN ('applied', 'already_applied'))
          OR (outcome = 'outcome_unknown'
              AND external_effect->>'scriptResult' = 'applied'))
      ORDER BY seq LIMIT 1`,
    [actionId],
  );
  if (!rows[0]) return null;
  const deleted = rows[0].external_effect?.deletedCount;
  return { deleted: typeof deleted === 'number' ? deleted : null };
}

export async function reconcileIntentDetailed(
  deps: ActionDeps,
  actionId: string,
  depth = 0,
): Promise<ReconcileResult> {
  const row = await loadIntent(deps.pool, actionId);
  if (!row) throw new ActionNotFoundError(actionId);
  await barrier('after_preliminary_read', { actionId, stage: 'reconcile' });
  const result = (finding: ReconcileFinding, current: IntentRow = row) => ({
    intent: toIntent(current),
    finding,
  });

  if (row.status === 'proposed' || row.status === 'admitted')
    return result('uncommitted');
  if (
    row.status === 'verified' ||
    row.status === 'failed' ||
    row.status === 'blocked' ||
    row.status === 'cancelled'
  )
    return result('terminal');
  if (row.adapter !== 'redis_cache') return result('committed');
  // Nobody has attempted the effect (the attempt is recorded in PostgreSQL
  // before the script runs): there is nothing in Redis to read.
  if (row.status === 'committed' && row.effectAttemptedAt === null)
    return result('awaiting_dispatch');

  const redis = requireRedis(deps);
  const prefix = prefixOf(deps);
  const key = effectKey(prefix, row.id);
  const from = row.status as 'committed' | 'dispatched' | 'outcome_unknown';
  const reload = async (finding: ReconcileFinding) => {
    const current = await loadIntent(deps.pool, actionId);
    return result(finding, current ?? row);
  };

  let raw: string | null;
  try {
    raw = await withinBudget(
      redis.get(key),
      redisBudget(deps),
      'the marker read',
    );
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    return result('unknown');
  }
  const marker = parseMarker(raw);

  if (marker?.kind === 'applied') {
    const done = await recordVerified(deps, row, from, factsFor(row, marker));
    return done ? result('effect_applied', done) : reload('effect_applied');
  }
  if (marker?.kind === 'fence_newer') {
    const done = await recordFailed(
      deps,
      row,
      from,
      'dispatch_fence_invalid',
      {
        ...factsFor(row, null),
        scriptResult: 'fence_newer',
        markerPresent: true,
      },
      'a newer flush of the cache namespace was already applied',
    );
    return done ? result('fence_newer', done) : reload('fence_newer');
  }
  if (marker?.kind === 'tombstone') {
    const done = await recordFailed(
      deps,
      row,
      from,
      'effect_not_applied',
      { ...factsFor(row, null), markerPresent: true },
      'reconcile fenced this action as not applied',
    );
    return done
      ? result('effect_not_applied', done)
      : reload('effect_not_applied');
  }
  if (marker) return result('unknown'); // pending or unreadable

  // No marker.
  // A committed flush whose dispatcher is still working under a live lease is
  // simply not done.
  if (row.status === 'committed' && row.leaseValid)
    return result('awaiting_dispatch');

  // 1. Durable evidence beats a missing volatile marker.
  const evidence = await appliedEvidence(deps, row.id);
  if (evidence) {
    const done = await recordVerified(deps, row, from, {
      ...factsFor(row, { deleted: evidence.deleted }),
      markerPresent: false,
    });
    return done ? result('effect_applied', done) : reload('effect_applied');
  }

  // 2/3. Absence proves "never ran" only against the same Redis epoch.
  if (!row.redisEpoch) return result('unknown');
  const markerHorizon =
    deps.markerHorizonSeconds ?? DEFAULT_MARKER_HORIZON_SECONDS;
  const times = [row.effectAttemptedAt, row.dispatchedAt, row.committedAt]
    .filter((time): time is Date => time !== null)
    .map((time) => time.getTime());
  const since = times.length > 0 ? Math.min(...times) : 0;
  if (Date.now() - since >= markerHorizon * 1000) return result('unknown');
  // Fence the action: after this SET NX no script call can apply it.
  let fenced: unknown;
  try {
    fenced = await withinBudget(
      redis.eval(TOMBSTONE_SCRIPT, {
        keys: [key, epochKey(prefix)],
        arguments: [row.redisEpoch, String(markerHorizon)],
      }),
      redisBudget(deps),
      'the tombstone write',
    );
  } catch (error) {
    if (isSimulatedCrash(error)) throw error;
    return result('unknown');
  }
  const verdict = Array.isArray(fenced) ? fenced[0] : null;
  if (verdict === 'epoch_changed') return result('epoch_changed');
  if (verdict === 'exists')
    // The marker appeared between the read and the write: read it again.
    return depth < 2
      ? reconcileIntentDetailed(deps, actionId, depth + 1)
      : result('unknown');
  if (verdict !== 'fenced') return result('unknown');
  const done = await recordFailed(
    deps,
    row,
    from,
    'effect_not_applied',
    { ...factsFor(row, null), markerPresent: false },
    'no effect marker exists and the Redis epoch is unchanged; the effect did not run',
  );
  return done
    ? result('effect_not_applied', done)
    : reload('effect_not_applied');
}

export async function reconcileIntent(
  deps: ActionDeps,
  actionId: string,
): Promise<ActionIntent> {
  return (await reconcileIntentDetailed(deps, actionId)).intent;
}
