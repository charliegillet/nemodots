def insert_position(a, x, *, side: str = "left", descending: bool = False) -> int:
    """Return the index where `x` keeps the sorted sequence `a` sorted (binary search)."""
    if side not in ("left", "right"):
        raise ValueError(f"side must be 'left' or 'right', not {side!r}")
    lo, hi = 0, len(a)
    while lo < hi:
        mid = (lo + hi) // 2
        value = a[mid]
        if descending:
            go_right = value > x or (side == "right" and value == x)
        else:
            go_right = value < x or (side == "right" and value == x)
        if go_right:
            lo = mid + 1
        else:
            hi = mid
    return lo
