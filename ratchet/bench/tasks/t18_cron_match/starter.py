import datetime


def cron_matches(expr: str, dt: datetime.datetime) -> bool:
    """Return True if `dt` matches the 5-field cron expression `expr`."""
    raise NotImplementedError
