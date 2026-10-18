# Checkout architecture

The checkout service sells a small product catalogue. One API process serves products, per-SKU inventory, order placement, `/health` and `/metrics`. It is backed by PostgreSQL (business data) and Redis (a cache in front of catalogue reads).

## Data and authority

- Business data (products, inventory, orders) lives in PostgreSQL. The authoritative inventory quantity is the database row.
- Redis only holds cache entries. It is never the source of truth; any entry can be dropped and rebuilt.
- Operational configuration lives in a PostgreSQL table of key/value entries. The API re-reads it continuously, so a change takes effect within moments and needs no restart.

## Configuration keys

| Key                        | Controls                                                         |
| -------------------------- | ---------------------------------------------------------------- |
| `cache.namespace`          | which Redis key family the API reads and writes                  |
| `cache.schema_version`     | which cache blob layout version the API expects                  |
| `db.pool_max`              | maximum concurrent PostgreSQL connections the API opens          |
| `db.statement_timeout_ms`  | how long one SQL statement may run before it is cancelled        |
| `routing.inventory_source` | which data source answers inventory reads                        |
| `orders.write_enabled`     | whether order placement is accepted                              |
| `ui.banner_text`           | storefront banner text; cosmetic only, unrelated to reliability  |

Detailed semantics and value domains: runbooks `cache-semantics`, `pool-sizing`, `inventory-routing`.

## Versions and evidence

Every configuration key has a version that increases on each change. The set of keys (the membership) has its own version that changes only when a key is added or removed, never when a value changes. `observe_source` returns a receipt carrying the revision you saw; a later change makes that receipt stale, and work that rests on it must be redone.

## Readable sources

- `checkout.health`: overall status (`ok`, `degraded`, `down`), booleans for postgres, redis, config_parse, writes, cache and pool, and the list of error classes currently reported. Health can say `ok` while customers still see wrong behaviour.
- `checkout.metrics`: error classes seen recently, cache hit ratio and error rate in coarse deciles, and, when cache entries cannot be decoded, the schema version the API expects and the one it found.
- `checkout.orders.recent`: a coarse count bucket and the set of statuses of recent customer orders.
- `checkout.inventory/<sku>`: the database quantity and the quantity the API reports for one SKU, plus a `consistent` flag. SKUs are written `SKU-` followed by four digits; sample more than one.
- `redis.stats`: how many cache keys exist per `namespace:schema` suffix, the namespace the configuration currently selects, and whether Redis is reachable.
- `checkout.config` lists which configuration keys exist; `checkout.config/<key>` returns `{key, value, version}` for one key.
- `checkout.acceptance`: the outcome of the independent acceptance check, if one has run.

A symptom in one source is rarely the whole story. Compare sources before concluding, and say in a finding which receipts support a claim.
