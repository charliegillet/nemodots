// Composition of the action boundary (ARCHITECTURE section 2, `actions/`).
// Imports contracts, db, ledger (read APIs), sandbox/version-authority and the
// coordinator's fence/outbox/event helpers. Never team, routes or inference.
import type {
  ActionAdmissionPort,
  ActionId,
  ActionIntent,
  MissionId,
  ProposeInput,
} from '../contracts/index.js';
import { admit } from './admit.js';
import { commit, type CommitResult } from './commit.js';
import { compensate } from './compensate.js';
import type { ActionsDeps } from './deps.js';
import { claimDispatch, dispatch } from './dispatch.js';
import { propose, type ProposeContext } from './propose.js';
import { cancelQueued, createIntentReader } from './queries.js';
import { reclaim, reclaimExpired } from './reclaim.js';
import { reconcile } from './reconcile.js';
import { createSelfWriteIntents } from './self-write.js';
import { settleFromHistory, settleSuperseded } from './settle.js';

export * from './deps.js';
export * from './errors.js';
export * from './policy.js';
export * from './queries.js';
export * from './rows.js';
export { evaluate } from './predicates.js';
export { propose, ACTION_PROPOSED_TOPIC } from './propose.js';
export { admit } from './admit.js';
export { commit, ACTION_DISPATCH_TOPIC, type CommitResult } from './commit.js';
export {
  claimDispatch,
  dispatch,
  effectKey,
  fenceKey,
  FLUSH_SCRIPT,
} from './dispatch.js';
export { reconcile, readMarker } from './reconcile.js';
export { reclaim, reclaimExpired } from './reclaim.js';
export { compensate } from './compensate.js';
export {
  settleFromHistory,
  settleMismatch,
  settleSuperseded,
} from './settle.js';
export { createSelfWriteIntents } from './self-write.js';
export {
  clearHooks,
  hook,
  setHook,
  HOOK_NAMES,
  type HookName,
} from './test-hooks.js';

export interface Actions extends Omit<ActionAdmissionPort, 'dispatch'> {
  deps: ActionsDeps;
  dispatch(
    actionId: ActionId | string,
    dispatchFence: number,
    dispatcher?: string,
  ): Promise<ActionIntent>;
  /** commit with the stored receipt and the replay flag. */
  commitDetailed(
    actionId: ActionId | string,
    dispatchFence: number,
  ): Promise<CommitResult>;
  claimDispatch: (
    actionId: ActionId | string,
    callerFence: number,
    dispatcher?: string,
  ) => ReturnType<typeof claimDispatch>;
  reclaim(
    actionId: ActionId | string,
    dispatcher: string,
  ): Promise<ActionIntent>;
  reclaimExpired(dispatcher: string, limit?: number): Promise<ActionIntent[]>;
  settleFromHistory: (
    actionId: ActionId | string,
    observed: { afterDigest: string | null; configVersion: number },
  ) => Promise<ActionIntent>;
  settleSuperseded: (actionId: ActionId | string) => Promise<ActionIntent>;
  compensate: (actionId: ActionId | string) => Promise<ActionIntent>;
  intents: ReturnType<typeof createIntentReader>;
  /** The watcher's SelfWriteIntentPort (WatcherDeps.intents). */
  selfWriteIntents: ReturnType<typeof createSelfWriteIntents>;
}

export function createActions(deps: ActionsDeps): Actions {
  return {
    deps,
    propose: (input: ProposeInput, ctx) =>
      propose(deps, input, ctx as ProposeContext),
    admit: (actionId, dispatcher) => admit(deps, actionId, dispatcher),
    commit: async (actionId, dispatchFence) =>
      (await commit(deps, actionId, dispatchFence)).intent,
    commitDetailed: (actionId, dispatchFence) =>
      commit(deps, actionId, dispatchFence),
    dispatch: (actionId, dispatchFence, dispatcher) =>
      dispatch(deps, actionId, dispatchFence, dispatcher),
    reconcile: (actionId) => reconcile(deps, actionId),
    cancelQueued: (missionId: MissionId, generation) =>
      cancelQueued(deps, missionId, generation),
    claimDispatch: (actionId, callerFence, dispatcher) =>
      claimDispatch(deps, actionId, callerFence, dispatcher),
    reclaim: (actionId, dispatcher) => reclaim(deps, actionId, dispatcher),
    reclaimExpired: (dispatcher, limit) =>
      reclaimExpired(deps, dispatcher, limit),
    settleFromHistory: (actionId, observed) =>
      settleFromHistory(deps, actionId, observed),
    settleSuperseded: (actionId) => settleSuperseded(deps, actionId),
    compensate: (actionId) => compensate(deps, actionId),
    intents: createIntentReader(),
    selfWriteIntents: createSelfWriteIntents(deps),
  };
}
