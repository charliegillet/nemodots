# Format elapsed time

A CI dashboard shows how long each job took in a compact human form such as `"1h 5s"`. Durations come
in as float seconds from a timer.

## Function

```python
def format_elapsed(seconds: float) -> str
```

## Rules

- `seconds` is an `int` or `float`. Negative values, NaN and infinities raise `ValueError` (even
  `-0.4`, although it would round to 0).
- First round to the nearest whole second, with halves rounded **up**: `0.5` -> 1, `1.5` -> 2,
  `2.5` -> 3 (Python's built-in `round()` would give 2 for `2.5`, which is wrong here).
- Split the rounded total into days (`d`, 86400 s), hours (`h`), minutes (`m`) and seconds (`s`).
- Output the non-zero units from largest to smallest as `<value><unit>`, separated by single spaces.
  Zero units are omitted everywhere, including in the middle (`3605` -> `"1h 5s"`).
- If every unit is zero, return `"0s"`.
- Days are the largest unit; there is no weeks unit (`864000` -> `"10d"`).

## Examples

```python
>>> format_elapsed(0)
'0s'
>>> format_elapsed(61)
'1m 1s'
>>> format_elapsed(3605)
'1h 5s'
>>> format_elapsed(90061)
'1d 1h 1m 1s'
>>> format_elapsed(59.5)
'1m'
```
