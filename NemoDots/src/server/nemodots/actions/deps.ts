import type { EventSinkPort, SupportValidator } from '../contracts/index.js';
import type { TransactionPool } from '../db/tx.js';

/**
 * The slice of node-redis the effect path uses. The real client satisfies it;
 * tests wrap it to count commands and to inject lost responses.
 */
export interface EffectRedis {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface ActionsDeps {
  /** nemodots_app pool: the only role that may set caused_by_action_id. */
  pool: TransactionPool;
  validator: SupportValidator;
  events: EventSinkPort;
  /** null: external effects fail with EffectUnavailable (outcome_unknown) */
  redis: EffectRedis | null;
  /** NEMODOTS_REDIS_PREFIX */
  redisPrefix: string;
  /** NEMODOTS_DISPATCH_LEASE_MS */
  dispatchLeaseMs: number;
  /** TTL of the effect marker, seconds (the reconcile horizon). Default 7 days. */
  effectHorizonSec?: number;
}
