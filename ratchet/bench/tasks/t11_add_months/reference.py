import calendar
import datetime


def add_months(d: datetime.date, months: int) -> datetime.date:
    """Return `d` shifted by `months` calendar months, clamping the day to the month end."""
    index = d.year * 12 + (d.month - 1) + months
    year, month0 = divmod(index, 12)
    if not datetime.MINYEAR <= year <= datetime.MAXYEAR:
        raise ValueError(f"resulting year {year} is out of range")
    month = month0 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return datetime.date(year, month, day)
