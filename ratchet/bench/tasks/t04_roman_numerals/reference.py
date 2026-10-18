_TABLE = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
    (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
    (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]
_SYMBOLS = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def to_roman(n: int) -> str:
    """Return the canonical Roman numeral for 1 <= n <= 3999."""
    if not 1 <= n <= 3999:
        raise ValueError(f"{n!r} is outside 1..3999")
    parts = []
    for value, symbol in _TABLE:
        count, n = divmod(n, value)
        parts.append(symbol * count)
    return "".join(parts)


def from_roman(s: str) -> int:
    """Parse a canonical Roman numeral (any letter case) into an int."""
    text = s.upper()
    if not text or any(ch not in _SYMBOLS for ch in text):
        raise ValueError(f"invalid Roman numeral: {s!r}")
    total = 0
    for i, ch in enumerate(text):
        value = _SYMBOLS[ch]
        if i + 1 < len(text) and value < _SYMBOLS[text[i + 1]]:
            total -= value
        else:
            total += value
    if not 1 <= total <= 3999 or to_roman(total) != text:
        raise ValueError(f"non-canonical Roman numeral: {s!r}")
    return total
