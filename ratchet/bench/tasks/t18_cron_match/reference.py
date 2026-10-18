import datetime
import re

_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
_NUMBER = re.compile(r"[0-9]+")


def _number(text: str) -> int:
    if not _NUMBER.fullmatch(text):
        raise ValueError(f"invalid number {text!r}")
    return int(text)


def _parse_field(text: str, lo: int, hi: int) -> set[int]:
    values: set[int] = set()
    for item in text.split(","):
        base, slash, step_text = item.partition("/")
        step = _number(step_text) if slash else 1
        if step < 1:
            raise ValueError(f"step must be >= 1 in {item!r}")
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a, _, b = base.partition("-")
            start, end = _number(a), _number(b)
            if start > end:
                raise ValueError(f"reversed range {item!r}")
        else:
            if slash:
                raise ValueError(f"step after a single number in {item!r}")
            start = end = _number(base)
        if start < lo or end > hi:
            raise ValueError(f"{item!r} is outside {lo}-{hi}")
        values.update(range(start, end + 1, step))
    return values


def cron_matches(expr: str, dt: datetime.datetime) -> bool:
    """Return True if `dt` matches the 5-field cron expression `expr`."""
    fields = expr.split()
    if len(fields) != 5:
        raise ValueError(f"expected 5 fields, got {len(fields)}")
    minute, hour, dom, month, dow = (
        _parse_field(text, lo, hi) for text, (lo, hi) in zip(fields, _RANGES)
    )
    if 7 in dow:
        dow.add(0)
    if dt.minute not in minute or dt.hour not in hour or dt.month not in month:
        return False
    dom_ok = dt.day in dom
    dow_ok = (dt.weekday() + 1) % 7 in dow
    if fields[2] != "*" and fields[4] != "*":
        return dom_ok or dow_ok
    return dom_ok and dow_ok
