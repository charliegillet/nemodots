import math
from decimal import ROUND_HALF_UP, Decimal

_UNITS = (("d", 86400), ("h", 3600), ("m", 60), ("s", 1))


def format_elapsed(seconds: float) -> str:
    """Format a duration in seconds as e.g. '1d 2h 3m 4s', omitting zero units."""
    if math.isnan(seconds) or math.isinf(seconds) or seconds < 0:
        raise ValueError(f"invalid duration: {seconds!r}")
    remaining = int(Decimal(seconds).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    parts = []
    for unit, size in _UNITS:
        value, remaining = divmod(remaining, size)
        if value:
            parts.append(f"{value}{unit}")
    return " ".join(parts) or "0s"
