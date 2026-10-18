# Cron expression matching

A job runner checks once a minute which scheduled jobs are due. Implement the matcher for classic
5-field cron expressions.

## Function

```python
import datetime

def cron_matches(expr: str, dt: datetime.datetime) -> bool
```

## Rules

- `expr` has exactly 5 fields separated by whitespace: minute, hour, day of month, month, day of week.
  Any other number of fields raises `ValueError`.
- Allowed ranges: minute `0-59`, hour `0-23`, day of month `1-31`, month `1-12`, day of week `0-7`
  where **both `0` and `7` mean Sunday** (1 = Monday, ..., 6 = Saturday).
- Each field is a comma-separated list of one or more items. An item is one of:
  - `*` (every value in the range);
  - a number `n`;
  - a range `a-b` (inclusive, requires `a <= b`);
  - a step `*/s` or `a-b/s` (every `s`-th value starting at the start of the range: `*/15` in the
    minute field is 0, 15, 30, 45; `10-30/10` is 10, 20, 30). The step must be at least 1. A step
    after a single number (`5/15`) is not allowed.
- Numbers are plain ASCII digits. Names such as `JAN` or `MON`, empty items (`1,,2`), values outside
  the field's range, a step of 0 and reversed ranges (`5-1`) raise `ValueError`.
- `dt` matches when its minute, hour and month are in their fields and the day matches. Seconds and
  microseconds are ignored.
- Day matching (classic cron rule): a day field is *restricted* unless it is exactly `*`. If both day
  of month and day of week are restricted, the day matches when **either** matches. Otherwise the day
  matches when both match (an unrestricted field always matches).
- Invalid expressions raise `ValueError` even if `dt` would not match anyway.

## Examples

```python
>>> from datetime import datetime
>>> cron_matches("*/15 9-17 * * 1-5", datetime(2026, 10, 19, 9, 30))
True
>>> cron_matches("*/15 9-17 * * 1-5", datetime(2026, 10, 18, 9, 30))
False
>>> cron_matches("0 0 * * 7", datetime(2026, 10, 18, 0, 0))
True
>>> cron_matches("0 0 13 * 5", datetime(2026, 10, 16, 0, 0))
True
```
