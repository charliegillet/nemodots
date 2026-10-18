# Merge intervals

A calendar service stores busy periods as `(start, end)` pairs and needs to collapse them into the
smallest set of non-overlapping periods before showing free time.

## Function

```python
def merge_intervals(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]
```

## Rules

- Each interval is a pair `(start, end)` of numbers (ints or floats) with `start <= end`. A pair with
  `start > end` raises `ValueError`. Pairs may be given as tuples or as 2-element lists.
- Zero-length intervals such as `(3, 3)` are valid.
- The input may be in any order.
- Two intervals that overlap **or touch** (the next one starts exactly where the previous one ends,
  e.g. `(1, 2)` and `(2, 3)`) are merged into one. An interval fully inside another disappears into it.
- Return a new list of `tuple`s sorted by start, with no two intervals overlapping or touching.
- An empty input returns `[]`.
- Do not modify the input list.

## Examples

```python
>>> merge_intervals([(1, 3), (2, 6), (8, 10), (15, 18)])
[(1, 6), (8, 10), (15, 18)]
>>> merge_intervals([(8, 10), (1, 3), (2, 6)])
[(1, 6), (8, 10)]
>>> merge_intervals([(1, 2), (2, 3)])
[(1, 3)]
>>> merge_intervals([(1, 10), (2, 3)])
[(1, 10)]
>>> merge_intervals([])
[]
```
