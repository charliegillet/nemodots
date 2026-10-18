import re

_ACRONYM_END = re.compile(r"(?<=[A-Z])(?=[A-Z][a-z])")
_LOWER_TO_UPPER = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def to_snake(name: str) -> str:
    """Convert a camelCase / PascalCase identifier to snake_case."""
    s = _ACRONYM_END.sub("_", name)
    s = _LOWER_TO_UPPER.sub("_", s)
    return s.lower()


def to_camel(name: str, upper_first: bool = False) -> str:
    """Convert a snake_case identifier to camelCase (or PascalCase with upper_first)."""
    parts = [p for p in name.split("_") if p]
    if not parts:
        return ""
    first = parts[0].lower()
    if upper_first:
        first = first[:1].upper() + first[1:]
    return first + "".join(p[:1].upper() + p[1:].lower() for p in parts[1:])
