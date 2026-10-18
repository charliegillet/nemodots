// Watcher ports and options (W3.2). The watcher is the normal path from "the
// world changed" to receipts and invalidations (BUILD_PROMPT). It imports only
// contracts, ledger, db helpers and the sandbox's version authority writer
// (for the owner edit); the actions and coordinator packages reach it through
// the injected ports below.
import type pg from 'pg';
import type {
  ActionId,
  ActionStatus,
  MissionId,
  RecoveryPort,
  SourceKey,
  SourceReaderPort,
} from '../contracts/index.js';
import type {
  ClosureLimits,
  RegistrationLedgerOptions,
} from '../ledger/index.js';

/** The slice of an action intent the history walk needs (written by the actions package). */
export interface SelfWriteIntent {
  id: ActionId;
  sourceKey: SourceKey;
  status: ActionStatus;
  /** Digest the action expects `config_versions.after_digest` to carry. */
  expectedAfterDigest: string | null;
}

export interface SettleFromHistoryInput {
  actionId: ActionId;
  outcome: 'verified' | 'failed';
  /** Set for `failed`: the intent becomes failed(postcondition_mismatch). */
  reason: 'postcondition_mismatch' | null;
  sourceKey: SourceKey;
  version: number;
  afterDigest: string | null;
}

/**
 * Provided by the actions package (`settleFromHistory`). Both methods must be
 * idempotent: a crash between settling and registering replays the walk.
 */
export interface SelfWriteIntentPort {
  find(actionId: ActionId): Promise<SelfWriteIntent | null>;
  settleFromHistory(input: SettleFromHistoryInput): Promise<void>;
}

/** MissionControlPort.pause, injected so the watcher can pause on a capped closure (C14). */
export interface MissionPauser {
  pause(missionId: MissionId): Promise<unknown>;
}

export type WatcherLogEvent =
  | 'registered'
  | 'confirmed'
  | 'retracted'
  | 'stale_observation_rejected'
  | 'authority_moved'
  | 'closure_cap_exceeded'
  | 'closure_unstable'
  | 'read_failed'
  | 'source_error'
  | 'unknown_action'
  | 'leader_acquired'
  | 'leader_lost'
  | 'invalidation_delivery_failed'
  | 'invalidation_redelivered';

/** Never carries receipt values, raw bodies or the actor of a configuration write. */
export interface WatcherLogEntry {
  event: WatcherLogEvent;
  sourceKey?: SourceKey | string;
  revision?: number;
  detail?: string;
}

export interface WatcherDeps {
  /** nemodots_app pool. */
  pool: pg.Pool;
  reader: SourceReaderPort;
  recovery: RecoveryPort;
  /** Absent: self-writes cannot be classified, every change counts as `none`. */
  intents?: SelfWriteIntentPort;
  missions?: MissionPauser;
  /** NEMODOTS_WATCH_INTERVAL_MS. */
  intervalMs: number;
  /** Required: `events` is the sink for the per-mission invalidation events. */
  ledger: RegistrationLedgerOptions;
  /** Closure caps (production default 64 / 10 000). */
  limits?: ClosureLimits;
  log?: (entry: WatcherLogEntry) => void;
  /** Test seams; never set in production. */
  hooks?: {
    /** After the watcher read the authority, before it registers. */
    beforeRegister?: (context: { sourceKey: string }) => Promise<void>;
  };
  /** Advisory lock name for single-instance scheduling. */
  lockName?: string;
}

export interface PassStats {
  sources: number;
  registered: number;
  confirmed: number;
  unchanged: number;
  retracted: number;
  errors: number;
  redelivered: number;
}

export const emptyStats = (): PassStats => ({
  sources: 0,
  registered: 0,
  confirmed: 0,
  unchanged: 0,
  retracted: 0,
  errors: 0,
  redelivered: 0,
});
