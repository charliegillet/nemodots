import { z } from 'zod';
import {
  ACTION_ADAPTER,
  type ActionAdapter,
  type ActionKind,
  type ConfigKey,
  type ConfigValue,
  type FlushCachePayload,
  type PolicyVersion,
  type SetConfigPayload,
} from './action.js';
import { type Capability, ROLE_CAPABILITIES } from './task.js';

// Server-owned adapter policy (CONTRACTS.md section 5, policy-v1) and value
// domains per ConfigKey (ARCHITECTURE.md section 9.2).

export { ROLE_CAPABILITIES };

export const POLICY_VERSION: PolicyVersion = 'policy-v1';

export const CACHE_NAMESPACE_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Value domain per ConfigKey. */
export const CONFIG_VALUE_DOMAINS = Object.freeze({
  'cache.namespace': z.string().regex(CACHE_NAMESPACE_PATTERN),
  'cache.schema_version': z.number().int().min(1).max(9),
  'db.pool_max': z.number().int().min(1).max(20),
  'db.statement_timeout_ms': z.number().int().min(50).max(30000),
  'routing.inventory_source': z.enum(['primary', 'replica_stale']),
  'orders.write_enabled': z.boolean(),
  'ui.banner_text': z.string().max(200),
} as const satisfies Record<ConfigKey, z.ZodType<ConfigValue>>);

export function configValueInDomain(key: ConfigKey, value: unknown): boolean {
  return CONFIG_VALUE_DOMAINS[key].safeParse(value).success;
}

export type AdapterPolicyEntry<P> = {
  readonly adapter: ActionAdapter;
  readonly capability: Capability;
  readonly requiredSources: (payload: P) => readonly string[];
  /** maxAgeMs per observed source, checked against lastConfirmedAt at admission AND commit. */
  readonly maxAgeMs: Readonly<Record<string, number>>;
  readonly externalEffect: boolean;
  /** Payload validation beyond the strict schema (value domain, namespace pattern). */
  readonly validatePayload: (payload: P) => boolean;
};

export const ADAPTER_POLICY: Readonly<{
  version: PolicyVersion;
  set_config: AdapterPolicyEntry<SetConfigPayload>;
  flush_cache_namespace: AdapterPolicyEntry<FlushCachePayload>;
}> = Object.freeze({
  version: POLICY_VERSION,
  set_config: Object.freeze({
    adapter: ACTION_ADAPTER.set_config,
    capability: 'propose_config_change',
    requiredSources: (payload: SetConfigPayload) =>
      Object.freeze([`checkout.config/${payload.key}`, 'checkout.health']),
    maxAgeMs: Object.freeze({ 'checkout.health': 120000 }),
    externalEffect: false,
    validatePayload: (payload: SetConfigPayload) =>
      configValueInDomain(payload.key, payload.value),
  }),
  flush_cache_namespace: Object.freeze({
    adapter: ACTION_ADAPTER.flush_cache_namespace,
    capability: 'propose_cache_flush',
    requiredSources: () =>
      Object.freeze(['checkout.config/cache.namespace', 'redis.stats']),
    maxAgeMs: Object.freeze({ 'redis.stats': 120000 }),
    externalEffect: true,
    validatePayload: (payload: FlushCachePayload) =>
      CACHE_NAMESPACE_PATTERN.test(payload.namespace),
  }),
});

export function policyFor<A extends ActionKind>(
  action: A,
): A extends 'set_config'
  ? AdapterPolicyEntry<SetConfigPayload>
  : AdapterPolicyEntry<FlushCachePayload> {
  return ADAPTER_POLICY[action] as never;
}

/** Required sources for an intent, sorted (server-derived, never from the model). */
export function requiredSourcesFor(
  action: ActionKind,
  payload: SetConfigPayload | FlushCachePayload,
): string[] {
  const sources =
    action === 'set_config'
      ? ADAPTER_POLICY.set_config.requiredSources(payload as SetConfigPayload)
      : ADAPTER_POLICY.flush_cache_namespace.requiredSources(
          payload as FlushCachePayload,
        );
  return [...sources].sort();
}
