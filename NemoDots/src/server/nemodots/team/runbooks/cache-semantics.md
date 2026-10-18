# Cache namespace and schema semantics

The API caches catalogue reads in Redis under keys shaped like `<namespace>:v<schema>:<item>`. Two configuration keys decide which keys it uses.

## `cache.namespace`

- A short label that selects a key family. Changing it makes the API read a different family; entries in other families are ignored but stay in Redis until flushed.
- Value domain: lowercase letters, digits and hyphens, 1 to 32 characters.
- A namespace whose entries were written under another layout, or that nothing refreshes, serves stale or undecodable data.

## `cache.schema_version`

- The blob layout version the API expects when it decodes a cache entry. If the stored entry was written under a different layout, decoding fails and requests error with `cache_decode_error`.
- Value domain: integer from 1 to 9.
- `checkout.metrics` reports the expected and the found schema when decoding fails. `redis.stats` shows how many keys exist under each `namespace:schema` suffix, which reveals which layout the stored entries really use.

## Remedies

- Pointing `cache.namespace` or `cache.schema_version` at values that match the stored entries restores reads without deleting anything.
- A flush deletes every key of one namespace. It is an external effect: it cannot be undone and a second flush is a second effect. A flush needs fresh `redis.stats` and the current namespace receipt.
- Never flush or change a cache key because it looks suspicious; compare `redis.stats` with the configured namespace and schema first and state in a finding what you compared.
