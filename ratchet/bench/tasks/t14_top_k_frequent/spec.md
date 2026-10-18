# Top-k frequent items

An analytics dashboard shows the most common search terms. The ordering must be stable and
reproducible, so ties are broken in a precisely defined way.

## Function

```python
def top_k_frequent(items: list, k: int) -> list
```

## Rules

- `items` is a list of hashable values (usually strings). Count how many times each distinct value
  occurs.
- Return the `k` distinct values with the highest counts, ordered by count, highest first.
- Ties (equal counts) are broken by **first occurrence** in `items`: the value that appears earlier in
  the input comes first. Do not sort ties alphabetically.
- If `k` is larger than the number of distinct values, return all distinct values (in the same order).
- `k == 0` returns `[]`. A negative `k` raises `ValueError`. An empty `items` returns `[]`.
- Do not modify `items`.

## Examples

```python
>>> top_k_frequent(["a", "b", "a", "c", "b", "a"], 2)
['a', 'b']
>>> top_k_frequent(["pear", "apple", "pear", "apple", "fig"], 2)
['pear', 'apple']
>>> top_k_frequent(["x", "y"], 5)
['x', 'y']
>>> top_k_frequent(["x"], 0)
[]
```
