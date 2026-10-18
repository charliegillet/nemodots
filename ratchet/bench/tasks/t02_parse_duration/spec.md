# Parse a duration

A job scheduler accepts human-written timeouts such as `"1h30m"` or `"2d 4h"` in its config files.
Parse them into a whole number of seconds, rejecting anything ambiguous.

## Function

```python
def parse_duration(text: str) -> int
```

## Rules

- A duration is one or more components. Each component is a non-negative integer written with ASCII
  digits, followed by a unit: `d` (86400 s), `h` (3600 s), `m` (60 s) or `s` (1 s).
- Units are case-insensitive (`"1H"` is one hour).
- Components may appear in any order (`"30m1h"` is valid).
- Whitespace is allowed before and after the whole string, between components, and between a number
  and its unit (`" 1 h  30 m "` is valid).
- Zero is allowed: `"0s"` is `0` and `"0h 5m"` is `300`. Values are not limited (`"90m"` is `5400`).
- Return the total number of seconds as an `int`.
- Raise `ValueError` for:
  - an empty or whitespace-only string;
  - a number without a unit (`"90"`, `"1h 30"`);
  - an unknown unit (`"5w"`, `"10ms"`);
  - a sign (`"-5m"`, `"+5m"`) or a decimal number (`"1.5h"`);
  - the same unit used more than once, in any case (`"1h 2h"`, `"5m 5M"`);
  - any other character (`"1h,30m"`, `"h"`, `"1h30m!"`).

## Examples

```python
>>> parse_duration("1h30m")
5400
>>> parse_duration("30m 1h")
5400
>>> parse_duration(" 2d 3s ")
172803
>>> parse_duration("0s")
0
>>> parse_duration("90")
Traceback (most recent call last):
ValueError: ...
```
