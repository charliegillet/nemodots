def merge_intervals(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping or touching intervals and return them sorted by start."""
    items = []
    for start, end in intervals:
        if start > end:
            raise ValueError(f"interval start {start!r} is after end {end!r}")
        items.append((start, end))
    items.sort()
    merged: list[tuple[float, float]] = []
    for start, end in items:
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged
