# LRU cache

A web service caches rendered fragments in memory. Implement a small least-recently-used cache class
with a fixed capacity.

## Function

```python
class LRUCache:
    def __init__(self, capacity: int) -> None
    def get(self, key, default=None)
    def put(self, key, value) -> None
    def keys(self) -> list
    def __len__(self) -> int
    def __contains__(self, key) -> bool
```

## Rules

- `capacity` is the maximum number of entries. A negative capacity raises `ValueError`.
- Capacity `0` is allowed: `put` then stores nothing, and the cache is always empty.
- `get(key, default=None)` returns the stored value, or `default` if the key is absent. A successful
  `get` marks the key as most recently used. A miss changes nothing.
- Stored values may be `None`; `get` must return the stored `None`, not `default`, for a present key.
- `put(key, value)` on a key that is already present replaces its value and marks it most recently
  used; it never evicts anything.
- `put` of a new key when the cache is full first evicts the **least recently used** key.
- `key in cache` (`__contains__`) and `len(cache)` do **not** change recency.
- `keys()` returns a new list of the keys from least recently used to most recently used, without
  changing recency.

## Examples

```python
>>> c = LRUCache(2)
>>> c.put("a", 1); c.put("b", 2)
>>> c.get("a")
1
>>> c.put("c", 3)
>>> c.keys()
['a', 'c']
>>> "b" in c
False
>>> c.get("b", "missing")
'missing'
```
