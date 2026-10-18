# Cache namespace and schema semantics

The API caches catalogue reads in Redis under keys shaped like `<namespace>:v<schema>:<item>`. Two configuration keys decide which keys it uses.

## `cache.namespace`

- A short label that selects a key family. Changing it makes the API read a different family; entries in other families are ignored but stay in Redis until flushed.
- Value domain: a string pattern, returned as `valueDomain` when you observe `checkout.config/cache.namespace`.
- A namespace whose entries were written under another layout, or that nothing refreshes, serves stale or undecodable data.

## `cache.schema_version`

- The blob layout version the API expects when it decodes a cache entry. If the stored entry was written under a different layout, decoding fails and requests error with `cache_decode_error`.
- Value domain: integer; the bounds are returned as `valueDomain` when you observe `checkout.config/cache.schema_version`.
- `checkout.metrics` reports the expected and the found schema when decoding fails. `redis.stats` shows how many keys exist under each `namespace:schema` suffix, which reveals which layout the stored entries really use.

## Flush semantics

- A flush deletes every key of one namespace. It is an external effect: it cannot be undone and a second flush is a second effect.
- A flush proposal is admitted only on fresh `redis.stats` and the current `cache.namespace` receipt.
- Changing `cache.namespace` or `cache.schema_version` deletes nothing; it only changes which entries the API reads.
