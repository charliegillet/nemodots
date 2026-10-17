// Domains of the checkout's controlled configuration keys (ARCHITECTURE.md
// section 9.2). This file states what a VALID value looks like, never what the
// healthy baseline or a scenario value is: baselines live in seed.ts and in
// the scenario manifests only (finding D7).
import {
  ConfigKeySchema,
  type ConfigKey,
  type ConfigValue,
} from '../contracts/action.js';

export const CONFIG_KEYS: readonly ConfigKey[] = ConfigKeySchema.options;

/** Keys the checkout cannot serve without. ui.banner_text is cosmetic (B1). */
export const REQUIRED_CONFIG_KEYS: readonly ConfigKey[] = [
  'cache.namespace',
  'cache.schema_version',
  'db.pool_max',
  'db.statement_timeout_ms',
  'routing.inventory_source',
  'orders.write_enabled',
];

export const INVENTORY_SOURCES = ['primary', 'replica_stale'] as const;
export type InventorySource = (typeof INVENTORY_SOURCES)[number];

const NAMESPACE_PATTERN = /^[a-z0-9-]{1,32}$/;

const integerIn = (min: number, max: number) => (value: unknown) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

const DOMAINS: Record<ConfigKey, (value: unknown) => boolean> = {
  'cache.namespace': (value) =>
    typeof value === 'string' && NAMESPACE_PATTERN.test(value),
  'cache.schema_version': integerIn(1, 9),
  'db.pool_max': integerIn(1, 20),
  'db.statement_timeout_ms': integerIn(50, 30_000),
  'routing.inventory_source': (value) =>
    typeof value === 'string' &&
    (INVENTORY_SOURCES as readonly string[]).includes(value),
  'orders.write_enabled': (value) => typeof value === 'boolean',
  'ui.banner_text': (value) => typeof value === 'string' && value.length <= 200,
};

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export type ValueCheck =
  { ok: true; value: ConfigValue } | { ok: false; reason: string };

/** Domain check used by the checkout and offered to the action adapter policy. */
export function validateConfigValue(key: string, value: unknown): ValueCheck {
  if (!isConfigKey(key)) return { ok: false, reason: 'unknown_key' };
  if (!DOMAINS[key](value)) return { ok: false, reason: 'out_of_domain' };
  return { ok: true, value: value as ConfigValue };
}

export interface CheckoutSettings {
  cacheNamespace: string;
  cacheSchemaVersion: number;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  inventorySource: InventorySource;
  ordersWriteEnabled: boolean;
  bannerText: string | null;
}

export type ParsedSettings =
  | { ok: true; settings: CheckoutSettings }
  | { ok: false; invalidKeys: string[] };

/** Parses the config rows. Names invalid/missing keys, never their values. */
export function parseCheckoutSettings(
  entries: ReadonlyMap<string, unknown>,
): ParsedSettings {
  const invalidKeys: string[] = [];
  for (const key of REQUIRED_CONFIG_KEYS) {
    const check = entries.has(key)
      ? validateConfigValue(key, entries.get(key))
      : ({ ok: false } as const);
    if (!check.ok) invalidKeys.push(key);
  }
  const banner = entries.get('ui.banner_text');
  if (
    entries.has('ui.banner_text') &&
    !validateConfigValue('ui.banner_text', banner).ok
  )
    invalidKeys.push('ui.banner_text');
  if (invalidKeys.length) return { ok: false, invalidKeys };
  return {
    ok: true,
    settings: {
      cacheNamespace: entries.get('cache.namespace') as string,
      cacheSchemaVersion: entries.get('cache.schema_version') as number,
      dbPoolMax: entries.get('db.pool_max') as number,
      dbStatementTimeoutMs: entries.get('db.statement_timeout_ms') as number,
      inventorySource: entries.get(
        'routing.inventory_source',
      ) as InventorySource,
      ordersWriteEnabled: entries.get('orders.write_enabled') as boolean,
      bannerText: entries.has('ui.banner_text') ? (banner as string) : null,
    },
  };
}
