import type pg from 'pg';
import type {
  ActionId,
  Environment,
  MissionId,
  ObservationReceipt,
  RecoveryPort,
  SelfWrite,
  SourceKey,
  SourceReaderPort,
} from '../contracts/index.js';
import type { ClosureLimits, LedgerOptions } from '../ledger/index.js';

// Shared types of the source watcher (ARCHITECTURE.md sections 5.2, 5.4, 9.4).
// The watcher is the normal path from "the world changed" to receipts and
// invalidations. It is NOT the correctness gate (G1/G2 are): it never registers
// a revision it did not read from the authority, never infers a value, and
// classifies self-writes from the config_versions history, never from the head.

/**
 * `mission_id` of the receipts the watcher registers. Receipts are shared
 * across missions (a source is keyed by owner/environment/resource/key), but
 * the ledger stores a mission id on every receipt and the contract requires a
 * v4 UUID. The watcher belongs to no mission, so it uses this reserved id.
 */
export const WATCHER_MISSION_ID =
  '00000000-0000-4000-8000-00000000a1c7' as MissionId;

/** NOTIFY channel written by sandbox/version-authority.ts (ARCHITECTURE 5.1 step 10). */
export { SOURCE_CHANGED_CHANNEL } from '../sandbox/version-authority.js';

export type ProvenanceKind = Extract<
  ObservationReceipt['provenance']['kind'],
  'watcher' | 'owner_edit'
>;

/** What the actions package knows about a committed set_config intent. */
export interface ExpectedWrite {
  actionId: ActionId;
  /** Config member key the intent wrote (not the source key). */
  key: string;
  /** sha256 of the canonical JSON of the intended value (configValueDigest). */
  afterDigest: string;
  /** The intent already left `committed` (verified or failed). */
  settled: boolean;
}

/**
 * Read side of the actions package for the history walk (ARCHITECTURE 5.4).
 * The watcher never imports actions/**; the composition root implements this
 * port over `coordinator.action_intents` and wires the settle side through
 * `RecoveryPort.onSelfWriteSettled` (which settles the intent with
 * `settleFromHistory` and routes the coordinator's recovery).
 */
export interface IntentSettlementPort {
  /** Intents by id; unknown ids and non-set_config intents are omitted. */
  expectedWrites(
    actionIds: readonly ActionId[],
  ): Promise<ReadonlyMap<string, ExpectedWrite>>;
  /** set_config intents that are `committed` and not yet settled. */
  awaitingSettlement(): Promise<readonly ExpectedWrite[]>;
}

/**
 * The calls the watcher needs from the coordinator side. `pauseMission` is the
 * closure-cap path (C14): the watcher pauses every mission the capped closure
 * touches before it records the coarse invalidation. RecoveryPort itself has
 * no pause operation, so the composition root supplies it (bootstrap wires
 * coordinator.control.pause and may ignore "mission is not pausable").
 */
export interface WatcherRecovery extends RecoveryPort {
  pauseMission(
    missionId: MissionId,
    reason: 'closure_cap_exceeded',
  ): Promise<void>;
}

export interface WatcherConfig {
  /** OpenDots OWNER_ID. */
  ownerId: string;
  environment: Environment;
  /** Default 'checkout'. */
  resource?: string;
  spaceId?: string | null;
  /** NEMODOTS_WATCH_INTERVAL_MS (default 2000). */
  intervalMs?: number;
  /** Observed sources read on every poll (default: health, metrics, orders.recent, redis.stats). */
  observedSources?: readonly SourceKey[];
  /**
   * Also poll observed sources that a tool registered in the ledger (for
   * example `checkout.inventory/<sku>`). Default true.
   */
  followRegisteredSources?: boolean;
  /** Registered receipts carry this mission id (default WATCHER_MISSION_ID). */
  missionId?: MissionId;
  /** Closure caps handed to the ledger (default 64 / 10 000). */
  closureLimits?: ClosureLimits;
  /** Schema names (tests only; defaults are the production schemas). */
  ledger?: LedgerOptions;
  /** Name of the single-instance advisory lock (default derived from the scope). */
  lockName?: string;
}

export type WatcherEvent =
  | { type: 'leadership'; leader: boolean }
  | {
      type: 'registered';
      sourceKey: string;
      revision: number;
      selfWrite: SelfWrite;
      invalidationId: string | null;
    }
  | { type: 'confirmed'; sourceKey: string; revision: number }
  | {
      type: 'stale_observation_rejected';
      sourceKey: string;
      observed: number;
      current: number;
    }
  | {
      type: 'self_write_settled';
      actionId: string;
      outcome: 'verified' | 'failed';
    }
  | {
      type: 'closure_cap';
      sourceKey: string;
      cap: 'depth' | 'nodes';
      missionIds: string[];
    }
  | { type: 'member_removed'; sourceKey: string; invalidationId: string | null }
  | {
      type: 'history_gap';
      sourceKey: string;
      ledgerRevision: number;
      headVersion: number;
    }
  | { type: 'redelivered'; invalidationId: string }
  | { type: 'error'; where: string; message: string };

export interface WatcherDeps {
  /** nemodots_app pool: registrations, config_versions reads, ledger reads. */
  pool: pg.Pool;
  /** Connection string of a dedicated session (advisory lock + LISTEN); default: the pool's. */
  listenUrl?: string;
  readers: SourceReaderPort;
  recovery: WatcherRecovery;
  intents: IntentSettlementPort;
  config: WatcherConfig;
  clock?: () => Date;
  /** Receives ids, keys, versions and counts only; never values or actors. */
  onEvent?: (event: WatcherEvent) => void;
}

export type ObserveOutcomeKind =
  | 'registered'
  | 'confirmed'
  | 'unchanged'
  | 'removed'
  | 'rejected'
  | 'skipped'
  | 'failed';

export interface ObserveOutcome {
  sourceKey: string;
  outcome: ObserveOutcomeKind;
  revision: number | null;
  selfWrite: SelfWrite | null;
  invalidationId: string | null;
  /** The closure exceeded its cap and the coarse path was taken (C14). */
  closureCapped: boolean;
}

export interface CycleReport {
  outcomes: ObserveOutcome[];
  settled: { actionId: string; outcome: 'verified' | 'failed' }[];
  redelivered: string[];
}

export interface ObserveOptions {
  kind?: ProvenanceKind;
}
