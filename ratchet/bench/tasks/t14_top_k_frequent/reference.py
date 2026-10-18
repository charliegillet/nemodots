def top_k_frequent(items: list, k: int) -> list:
    """Return the k most frequent distinct items (ties by first occurrence)."""
    if k < 0:
        raise ValueError("k must be >= 0")
    counts: dict = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    ordered = sorted(counts, key=lambda item: -counts[item])  # stable: keeps first-occurrence order on ties
    return ordered[:k]
