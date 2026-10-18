// Re-claim of admitted intents whose dispatcher lease expired. A re-claim is
// a RE-ADMISSION: every predicate runs again, a new dispatch fence is issued
// and an Authorization(stage: admission) is written. The old dispatcher's
// commit then fails at its fence check (DispatchFenceError, nothing written).
import type { ActionId, ActionIntent } from '../contracts/index.js';
import { admit } from './admit.js';
import type { ActionsDeps } from './deps.js';
import { findReclaimable } from './queries.js';
import { plainRead } from './rows.js';

export async function reclaim(
  deps: ActionsDeps,
  actionId: ActionId | string,
  dispatcher: string,
): Promise<ActionIntent> {
  return admit(deps, actionId, dispatcher);
}

export async function reclaimExpired(
  deps: ActionsDeps,
  dispatcher: string,
  limit = 50,
): Promise<ActionIntent[]> {
  const ids = await plainRead(deps.pool, (client) =>
    findReclaimable(client, limit),
  );
  const reclaimed: ActionIntent[] = [];
  for (const id of ids) reclaimed.push(await reclaim(deps, id, dispatcher));
  return reclaimed;
}
