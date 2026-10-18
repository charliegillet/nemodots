# Insertion position in a sorted sequence

A leaderboard keeps scores in a sorted sequence and needs to know where a new score goes. Some boards
are sorted ascending, others descending, and equal scores must be placed consistently.

## Function

```python
def insert_position(a, x, *, side: str = "left", descending: bool = False) -> int
```

## Rules

- `a` is a sequence (a `list`, or any object supporting `len()` and integer indexing `a[i]`) that is
  sorted ascending, or descending when `descending=True`. Elements and `x` are mutually comparable.
- Return the index `i` (`0 <= i <= len(a)`) where `x` can be inserted so that the sequence stays
  sorted in the same direction.
- `side="left"`: if elements equal to `x` exist, return the position **before** all of them.
  `side="right"`: return the position **after** all of them. Any other `side` raises `ValueError`.
- An empty sequence gives `0`.
- Use binary search: the function may read at most `2 * ceil(log2(len(a) + 1)) + 2` elements of `a`
  (sequences may have millions of elements). Do not convert `a` to a list or iterate over it.
- Do not modify `a`.

## Examples

```python
>>> insert_position([1, 2, 2, 2, 3], 2)
1
>>> insert_position([1, 2, 2, 2, 3], 2, side="right")
4
>>> insert_position([9, 7, 5, 3], 6, descending=True)
2
>>> insert_position([5, 4, 4, 4, 1], 4, side="right", descending=True)
4
>>> insert_position([], 10)
0
```
