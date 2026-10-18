// Public facade of the invalidation closure. The engine lives in
// supersession.ts (so receipts.ts can use it without an import cycle); this
// module is the stable entry point named by the architecture:
//   supersedeAndInvalidate   register a receipt, supersede the prior head and
//                            invalidate its closure on the caller's connection
//   registerWithoutClosure   the watcher's cap path (C14)
//   ClosureCapExceeded       thrown BEFORE the receipt is registered
export {
  ClosureCapExceeded,
  createCoordinatorMarker,
  insertInvalidationEvent,
  invalidateRetired,
  loadClosure,
  supersedeAndInvalidate,
  supersedeWithoutClosure,
  unionAffected,
  type ClosureMarker,
  type CoarseInvalidation,
  type LoadedClosure,
  type MarkSummary,
  type SupersedeInput,
  type SupersedeResult,
} from './supersession.js';
export {
  CLOSURE_LIMITS,
  buildClosure,
  traverseClosure,
  type ClosureLimits,
  type ClosureResult,
} from './closure.js';

import type { PgClient } from '../contracts/index.js';
import {
  registerObservation,
  type RegisterObservationInput,
  type RegisterOptions,
  type RegisterResult,
} from './receipts.js';

/**
 * Registers an observation and supersedes the prior head WITHOUT computing a
 * closure (ARCHITECTURE 5.2, C14). The watcher calls it in a fresh transaction
 * after ClosureCapExceeded: it has paused the affected missions
 * (`ClosureCapExceeded.missionIds`) and passes the coarse affected set as
 * `options.coarse`; a closure_cap_exceeded InvalidationEvent with
 * closure.capped = true is recorded, the coarse set gets the same
 * compare-and-set marks as a real closure, and the source stays observable.
 * Superseding a live receipt without a coarse set throws
 * CoarseInvalidationRequiredError before anything is written.
 */
export function registerWithoutClosure(
  client: PgClient,
  input: RegisterObservationInput,
  options: Omit<RegisterOptions, 'closure'> = {},
): Promise<RegisterResult> {
  return registerObservation(client, input, { ...options, closure: 'skip' });
}
