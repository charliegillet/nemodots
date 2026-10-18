import re

_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
_COMPONENT = re.compile(r"([0-9]+)[ \t\n\r\f\v]*([A-Za-z]+)")


def parse_duration(text: str) -> int:
    """Parse a duration such as '1h30m' into a whole number of seconds."""
    s = text.strip()
    if not s:
        raise ValueError("empty duration")
    total = 0
    seen: set[str] = set()
    pos = 0
    while pos < len(s):
        m = _COMPONENT.match(s, pos)
        if m is None:
            raise ValueError(f"invalid duration: {text!r}")
        unit = m.group(2).lower()
        if unit not in _UNITS:
            raise ValueError(f"unknown unit {m.group(2)!r} in {text!r}")
        if unit in seen:
            raise ValueError(f"unit {unit!r} repeated in {text!r}")
        seen.add(unit)
        total += int(m.group(1)) * _UNITS[unit]
        pos = m.end()
        while pos < len(s) and s[pos].isspace():
            pos += 1
    return total
