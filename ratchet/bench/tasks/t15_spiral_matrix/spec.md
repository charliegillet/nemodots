# Spiral order

A puzzle game reveals the tiles of a rectangular board in a clockwise spiral. Return the board's
values in that order.

## Function

```python
def spiral_order(matrix: list[list]) -> list
```

## Rules

- `matrix` is a list of rows; every row must have the same length, otherwise raise `ValueError`.
- Start at the top-left element and walk clockwise: along the top row to the right, down the right
  column, along the bottom row to the left, up the left column, then continue with the next inner
  ring. Every element appears exactly once.
- The matrix does not have to be square (any number of rows and columns, including a single row or
  a single column).
- An empty matrix (`[]`) or a matrix with empty rows (`[[]]`, `[[], []]`) returns `[]`.
- Elements can be any values; return them unchanged. Do not modify `matrix`.

## Examples

```python
>>> spiral_order([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
[1, 2, 3, 6, 9, 8, 7, 4, 5]
>>> spiral_order([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]])
[1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7]
>>> spiral_order([[1], [2], [3]])
[1, 2, 3]
>>> spiral_order([])
[]
```
