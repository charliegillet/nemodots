# Cache namespace and schema semantics

How the cache works

- Catalogue entries are written to Redis under a key built from the cache namespace and a schema version.
- On every read the checkout computes the key from the current configuration. When entries found under that key were written with a different schema version than the configuration expects, decoding fails and the request answers with a server error of class `cache_decode_error`. The metrics source then reports the expected schema and the schema found.
- Entries written under another namespace or another schema suffix are simply not read; they are not corrupted.

Symptoms of a cache schema mismatch

- Product reads fail while the database is healthy.
- Health reports a cache problem and the `cache_decode_error` class.
- `redis.stats` shows entries grouped under a schema suffix that differs from the one the configuration now expects.

Ways to restore service (choose from evidence, not from this text)

- Set the schema version setting back to the value that the stored entries carry. The metrics source states the schema found.
- Or flush the cache namespace so that entries of the wrong schema disappear and the cache refills under the current schema. Flushing only removes cached copies; it never touches orders or inventory.
- Do not touch settings unrelated to the symptom.

Value domains

- Schema version: an integer from 1 to 9.
- Namespace: lowercase letters, digits and hyphens, at most 32 characters.

A change always names the key, the new value and the digest of the value you observed. Readings taken before another change to the same key are stale and must be repeated.
