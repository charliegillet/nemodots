# Add months to a date

A billing system schedules the next invoice "N months after" a start date. Months have different
lengths, so the day of month sometimes has to be clamped.

## Function

```python
import datetime

def add_months(d: datetime.date, months: int) -> datetime.date
```

## Rules

- Move `d` forward by `months` calendar months (backward when `months` is negative; `0` returns the
  same date). The year changes as needed (`2023-11-15` plus 2 months is `2024-01-15`).
- Keep the day of month when the target month has that day. Otherwise clamp to the **last day** of
  the target month (`2023-01-31` plus 1 month is `2023-02-28`).
- Always compute from the original date in one step: `add_months(date(2023, 1, 31), 2)` is
  `2023-03-31`, not March 28.
- Leap years follow the Gregorian calendar: divisible by 4, except centuries, except centuries
  divisible by 400 (2024 and 2000 are leap years, 1900 is not).
- Return a `datetime.date`.
- If the resulting year is outside `datetime.MINYEAR..datetime.MAXYEAR` (1..9999), raise `ValueError`.

## Examples

```python
>>> from datetime import date
>>> add_months(date(2024, 1, 15), 1)
datetime.date(2024, 2, 15)
>>> add_months(date(2023, 1, 31), 1)
datetime.date(2023, 2, 28)
>>> add_months(date(2024, 2, 29), 12)
datetime.date(2025, 2, 28)
>>> add_months(date(2024, 2, 10), -3)
datetime.date(2023, 11, 10)
```
