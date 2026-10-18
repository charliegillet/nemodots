// Source watcher public surface (ARCHITECTURE.md sections 5.2, 5.4, 9.4).
// Imports contracts, ledger, db and the version authority only; never team/**
// or actions/** (the composition root injects RecoveryPort, the intent port
// and the mission pause).
export * from './types.js';
export * from './sources.js';
export { createSqlIntentSettlement } from './intents.js';
export {
  classifyHistory,
  readHistory,
  walkHistory,
  applySettlements,
  sweepSettlements,
  type Classification,
  type HistoryRow,
  type Settlement,
} from './self-write.js';
export {
  buildCoarseInvalidation,
  registerAfterClosureCap,
  type ClosureCapDeps,
  type ClosureCapResult,
} from './closure-cap.js';
export {
  createScheduler,
  type Scheduler,
  type SchedulerOptions,
  type WorkBatch,
} from './scheduler.js';
export {
  createWatcher,
  type ExclusiveOps,
  type Watcher,
  type WatcherStats,
} from './watcher.js';
export {
  createOwnerEdit,
  type OwnerEdit,
  type OwnerEditInput,
  type OwnerEditResult,
} from './manual.js';
