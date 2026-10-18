// Collaborators of the action boundary. Everything is injected by the
// composition root; this package imports ledger, coordinator helpers and
// contracts, never team/routes/inference.
import type pg from 'pg';
import type { EventSinkPort, RecoveryPort } from '../contracts/index.js';
import type { LedgerOptions } from '../ledger/options.js';

/**
 * The slice of a node-redis client the flush effect needs. A node-redis v5
 * client satisfies it; tests may pass a counting wrapper.
 */
export interface RedisEffectClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number },
  ): Promise<string | null>;
}

export interface ActionDeps {
  /** nemodots_app pool: the only role that may author the self-write marker. */
  pool: pg.Pool;
  /** Required by dispatch and reconcile of flush_cache_namespace; null disables the effect. */
  redis?: RedisEffectClient | null;
  /** NEMODOTS_REDIS_PREFIX; cache keys, fences and effect markers live under it. */
  redisPrefix?: string;
  /** NEMODOTS_DISPATCH_LEASE_MS (default 30 000). */
  dispatchLeaseMs?: number;
  events?: EventSinkPort;
  ledger?: LedgerOptions;
  /** How long effect markers live in Redis (default 7 days); reconcile never concludes absence beyond it. */
  markerHorizonSeconds?: number;
  /** Per Redis call budget (default 5 000 ms); exceeding it is outcome_unknown. */
  redisTimeoutMs?: number;
  /** Told when a self-write is settled by settleFromHistory. */
  recovery?: RecoveryPort | null;
}

export const DEFAULT_DISPATCH_LEASE_MS = 30_000;
export const DEFAULT_MARKER_HORIZON_SECONDS = 7 * 24 * 3600;
export const DEFAULT_REDIS_TIMEOUT_MS = 5_000;
export const DEFAULT_REDIS_PREFIX = 'nemodots:dev';

export const leaseMs = (deps: ActionDeps) =>
  deps.dispatchLeaseMs ?? DEFAULT_DISPATCH_LEASE_MS;
