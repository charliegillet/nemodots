# Checkout system

The checkout API serves `GET /products` (catalog, cached in Redis), `POST /orders` and order reads. Product data and orders live in PostgreSQL; inventory is decremented exactly once per order item.

## Observable sources (observe_source)

| Source key | What it returns |
| --- | --- |
| `checkout.health` | overall status (ok/degraded/down), per-check booleans (postgres, redis, config_parse, writes), current error classes |
| `checkout.metrics` | recent error classes, cache schema the API expects vs the schema found in cached blobs, latency deciles |
| `checkout.orders.recent` | bucketed count and status set of recent orders |
| `checkout.inventory/<sku>` | inventory authority vs the API's view, and whether they are consistent |
| `redis.stats` | cache key counts per namespace and schema suffix |
| `checkout.config` | list of config keys and the collection version |
| `checkout.config/<key>` | `{ key, value, version }` of one config key; also returns `valueDigest` |

## Config keys (checkout.config/<key>)

- `cache.namespace`: Redis namespace for catalog cache blobs.
- `cache.schema_version`: the blob schema the API reads and writes. Cache keys are `<prefix>:cache:<namespace>:v<schema>:<name>`. Blobs written under one schema cannot be decoded by an API expecting another; a mismatch shows up as `cache_decode_error`, and `checkout.metrics` then reports the schema the API expects (from config) and the schema found in the stored blobs. Consistency is restored either by setting `cache.schema_version` to the schema the stored blobs actually use (`foundSchema`), or by flushing the namespace so blobs are rebuilt under the configured schema. Setting the key to the value it already has changes nothing.
- `db.pool_max`, `db.statement_timeout_ms`: database pool size and statement timeout.
- `routing.inventory_source`: which inventory store the API reads.
- `orders.write_enabled`: whether order writes are accepted.
- `ui.banner_text`: cosmetic banner text.

Every config change advances the key's version by one. Config history is not exposed; reason from current values, metrics and cached data.
