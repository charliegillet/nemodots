// Public surface of the action boundary (ARCHITECTURE.md sections 4-5).
// Imports contracts, ledger, coordinator helpers and sandbox/version-authority;
// never team, routes or inference.
export * from './errors.js';
export * from './types.js';
export * from './policy.js';
export * from './test-hooks.js';
export { loadIntent, toIntent, type IntentRow } from './rows.js';
export { proposeIntent, type ProposeContext } from './propose.js';
export {
  admitIntent,
  admitIntentDetailed,
  type AdmitDisposition,
  type AdmitResult,
} from './admit.js';
export {
  commitIntent,
  commitIntentDetailed,
  type CommitDisposition,
  type CommitResult,
} from './commit.js';
export {
  EFFECT_SCRIPT,
  TOMBSTONE_SCRIPT,
  claimDispatch,
  ensureEpoch,
  dispatchIntent,
  dispatchIntentDetailed,
  effectKey,
  epochKey,
  fenceKey,
  parseMarker,
  type DispatchDisposition,
  type DispatchResult,
  type MarkerState,
} from './dispatch.js';
export {
  reconcileIntent,
  reconcileIntentDetailed,
  type ReconcileFinding,
  type ReconcileResult,
} from './reconcile.js';
export { findStuckWork, reclaimAdmitted, type StuckWork } from './reclaim.js';
export { compensateIntent, type CompensationInput } from './compensate.js';
export {
  createSelfWriteSettler,
  settleFromHistory,
  type SettleOutcome,
} from './settle.js';
export {
  createIntentReader,
  getIntent,
  inspectAction,
  listAuthorizations,
  listIntents,
  listResults,
  readActionSnapshot,
  type ActionInspection,
} from './queries.js';
export {
  createActionService,
  type ActionService,
  type SweepReport,
} from './service.js';
