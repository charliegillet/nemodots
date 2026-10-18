import re
from decimal import ROUND_HALF_UP, Decimal

_UNITS = {
    "b": 1,
    "kb": 1000, "mb": 1000 ** 2, "gb": 1000 ** 3, "tb": 1000 ** 4, "pb": 1000 ** 5,
    "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4, "pib": 1024 ** 5,
}
_SIZE = re.compile(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)\s*")


def parse_size(text: str) -> int:
    """Parse a human-readable size such as '1.5 GiB' into a number of bytes."""
    m = _SIZE.fullmatch(text)
    if m is None:
        raise ValueError(f"invalid size: {text!r}")
    unit = m.group(2).lower() or "b"
    if unit not in _UNITS:
        raise ValueError(f"unknown unit {m.group(2)!r}")
    value = Decimal(m.group(1)) * _UNITS[unit]
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))
